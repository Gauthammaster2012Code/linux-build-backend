import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getDistroInfo,
  STATUS_LABELS,
  type ClaimResponse,
  type FinishRequest,
  type OutputResult,
  type OutputType,
  type Verification,
  verificationPassed,
} from "@linxgen/spec";
import type { RunnerApiClient } from "./api";
import type { RunnerEnv, ToolchainLock } from "./config";
import type { Exec } from "./exec";
import { buildManifest, checkRequestedPackages, parseDpkgManifest } from "./manifest";
import { Reporter } from "./reporter";
import { uploadFile, type UploadedFile } from "./upload";
import { artifactFileName, renderWorkspace, writeWorkspace } from "./workspace";

export interface PipelineDeps {
  env: RunnerEnv;
  lock: ToolchainLock;
  api: RunnerApiClient & { claim(attemptId: string, nonce: string, oidcToken: string): Promise<ClaimResponse> };
  exec: Exec;
  getOidcToken: () => Promise<string>;
  upload?: typeof uploadFile;
  /** Prints to the GitHub Actions job log (not forwarded to the backend). */
  console: (line: string) => void;
  /** Registers a value with the Actions log masker. */
  mask: (secret: string) => void;
}

export class StepError extends Error {
  constructor(
    readonly step: string,
    readonly exitCode: number | null,
  ) {
    super(`${step} failed${exitCode === null ? "" : ` with exit code ${exitCode}`}`);
  }
}

class AbortedError extends Error {}

interface OutputState {
  output: OutputType;
  built: boolean;
  verification: Verification;
  installed: Map<string, string>;
  requested: { name: string; version: string }[];
  artifact?: UploadedFile;
  manifest?: UploadedFile;
  error?: string;
  uploadFailed?: boolean;
}

const digestOf = (image: string) => image.slice(image.indexOf("@") + 1);

export interface PipelineResult {
  finished: boolean;
  status: FinishRequest["status"];
  buildStatus?: string;
}

export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { env, api } = deps;
  const upload = deps.upload ?? uploadFile;
  const oidcToken = await deps.getOidcToken();
  deps.mask(oidcToken);
  deps.mask(env.dispatchNonce);
  const claim = await api.claim(env.attemptId, env.dispatchNonce, oidcToken);
  deps.mask(claim.capability);
  const spec = claim.spec;
  const work = path.join(env.workRoot, env.attemptId);
  const out = path.join(work, "out");
  const logFile = path.join(env.workRoot, `build-${env.attemptId}.log`);
  mkdirSync(env.workRoot, { recursive: true });
  writeFileSync(logFile, "");
  deps.console(`claimed attempt ${env.attemptId} for build ${claim.buildId}`);

  const reporter = new Reporter(api, {
    logFile,
    maxLogBytes: claim.limits.maxLogBytes,
    secrets: [claim.capability, env.dispatchNonce, oidcToken],
  });
  const controller = new AbortController();
  let abortReason: "cancelled" | "timed_out" | undefined;
  reporter.onCancel(() => {
    abortReason ??= "cancelled";
    controller.abort();
  });
  // Leave time to upload the log and report the result before the backend deadline.
  const budgetMs = Math.max(60_000, claim.limits.buildTimeoutMinutes * 60_000 - 5 * 60_000);
  const deadline = setTimeout(() => {
    abortReason ??= "timed_out";
    controller.abort();
  }, budgetMs);
  deadline.unref?.();
  reporter.start();

  const ensureRunning = () => {
    if (controller.signal.aborted) throw new AbortedError(abortReason ?? "aborted");
  };

  const run = async (step: string, command: string, args: string[]) => {
    ensureRunning();
    reporter.line(`$ ${step}`);
    const res = await deps.exec(command, args, {
      cwd: work,
      signal: controller.signal,
      onLine: (line) => reporter.line(line),
    });
    if (res.aborted) throw new AbortedError(abortReason ?? "aborted");
    if (res.exitCode !== 0) throw new StepError(step, res.exitCode);
  };
  const script = (rel: string) => path.join(env.builderDir, rel);
  const sudo = (step: string, rel: string, ...args: string[]) => run(step, "sudo", ["-n", "bash", script(rel), ...args]);

  const states = new Map<OutputType, OutputState>(
    spec.outputs.map((o) => [
      o,
      { output: o, built: false, verification: { requestedPackagesPresent: false }, installed: new Map(), requested: [] },
    ]),
  );
  let failure: FinishRequest["failure"];
  let reachedUpload = false;

  try {
    const distro = getDistroInfo(spec.distro);
    await reporter.setStage("preparing");
    reporter.event("info", `${STATUS_LABELS.preparing}: ${distro.label}, ${spec.profile} profile, outputs ${spec.outputs.join(" + ")}`);
    const files = renderWorkspace(spec, { buildId: claim.buildId, attemptId: env.attemptId }, deps.lock);
    writeWorkspace(work, files);
    await sudo("host setup", "host-setup.sh");

    await reporter.setStage("building");
    for (const state of states.values()) {
      ensureRunning();
      reporter.event("info", `Building ${state.output}`, state.output);
      try {
        await sudo(`build ${state.output}`, state.output === "iso" ? "build-iso.sh" : "container/build.sh", work);
        state.built = true;
        state.installed = parseDpkgManifest(readFileSync(path.join(out, `${state.output}-packages.tsv`), "utf8"));
        const check = checkRequestedPackages(spec.packages, state.installed);
        state.requested = check.packages;
        state.verification.requestedPackagesPresent = check.present;
        if (!check.present) state.error = `Requested packages missing from the image: ${check.missing.join(", ")}`;
        reporter.event("info", `Built ${state.output} with ${state.installed.size} installed packages`, state.output);
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        state.error = e instanceof StepError ? `The ${state.output} build failed (exit code ${e.exitCode}).` : String(e);
        reporter.event("error", state.error, state.output);
      }
    }
    if (![...states.values()].some((s) => s.built)) {
      failure = { code: "build_failed", message: [...states.values()].map((s) => s.error).filter(Boolean).join(" ") || "No output was built." };
      throw new StepError("build", null);
    }

    await reporter.setStage("verifying");
    for (const state of states.values()) {
      if (!state.built) continue;
      ensureRunning();
      if (state.output === "iso") {
        const timeout = String(spec.profile === "xfce" ? 900 : 600);
        for (const mode of ["bios", "uefi"] as const) {
          ensureRunning();
          reporter.event("info", `Boot test (${mode.toUpperCase()}) started`, "iso");
          try {
            await run(`boot test ${mode}`, "bash", [
              script("verify/iso-boot.sh"),
              path.join(out, "linxgen.iso"),
              mode,
              spec.profile,
              timeout,
              path.join(out, `serial-${mode}.log`),
            ]);
            state.verification[mode === "bios" ? "biosBoot" : "uefiBoot"] = "passed";
            reporter.event("info", `Boot test (${mode.toUpperCase()}) passed`, "iso");
          } catch (e) {
            if (e instanceof AbortedError) throw e;
            state.verification[mode === "bios" ? "biosBoot" : "uefiBoot"] = "failed";
            state.error ??= `The ${mode.toUpperCase()} boot test failed.`;
            reporter.event("error", `Boot test (${mode.toUpperCase()}) failed`, "iso");
          }
        }
      } else {
        reporter.event("info", "Container smoke test started", "container");
        try {
          await sudo("container smoke test", "verify/container-smoke.sh", work);
          state.verification.containerSmoke = "passed";
          reporter.event("info", "Container smoke test passed", "container");
        } catch (e) {
          if (e instanceof AbortedError) throw e;
          state.verification.containerSmoke = "failed";
          state.error ??= "The container smoke test failed.";
          reporter.event("error", "Container smoke test failed", "container");
        }
      }
    }

    await reporter.setStage("uploading");
    reachedUpload = true;
    for (const state of states.values()) {
      if (!state.built) continue;
      ensureRunning();
      const passed = verificationPassed(state.output, state.verification);
      try {
        if (passed) {
          const file = path.join(out, state.output === "iso" ? "linxgen.iso" : "container.tar.gz");
          reporter.event("info", `Uploading ${state.output} artifact`, state.output);
          state.artifact = await upload(api, file, { kind: state.output, fileName: artifactFileName(spec, state.output) }, {
            signal: controller.signal,
          });
        }
        const image = deps.lock.images[`${spec.distro.family}-${spec.distro.release}`]!;
        const toolchainFile = path.join(out, "iso-toolchain.tsv");
        const manifestDoc = buildManifest({
          output: state.output,
          buildId: claim.buildId,
          attemptId: env.attemptId,
          builderRevision: env.builderRevision,
          distro: spec.distro,
          profile: spec.profile,
          baseImage: image,
          toolchain:
            state.output === "iso" && existsSync(toolchainFile)
              ? Object.fromEntries(parseDpkgManifest(readFileSync(toolchainFile, "utf8")))
              : {},
          requestedPackages: state.requested,
          installed: state.installed,
          ...(state.artifact
            ? { artifact: { fileName: artifactFileName(spec, state.output), sizeBytes: state.artifact.sizeBytes, sha256: state.artifact.sha256 } }
            : {}),
        });
        const manifestPath = path.join(env.workRoot, `${state.output}-manifest.json`);
        writeFileSync(manifestPath, JSON.stringify(manifestDoc, null, 2));
        state.manifest = await upload(api, manifestPath, {
          kind: "manifest",
          fileName: artifactFileName(spec, state.output === "iso" ? "manifest-iso" : "manifest-container"),
        }, { signal: controller.signal });
        if (state.artifact) reporter.event("info", `Uploaded ${state.output} (${state.artifact.sizeBytes} bytes, sha256 ${state.artifact.sha256})`, state.output);
      } catch (e) {
        if (controller.signal.aborted) throw new AbortedError(abortReason ?? "aborted");
        state.error = `Upload failed: ${(e as Error).message}`;
        state.uploadFailed = true;
        reporter.event("error", state.error, state.output);
      }
    }
    failure = overallFailure([...states.values()]);
  } catch (e) {
    if (e instanceof AbortedError || controller.signal.aborted) {
      if (abortReason === "timed_out") failure = { code: "timed_out", message: "The build exceeded its time limit." };
      reporter.event(abortReason === "timed_out" ? "error" : "warning", abortReason === "timed_out" ? "Build timed out" : "Build cancelled");
      await killLeftovers(deps, env.attemptId);
    } else if (!failure) {
      const message = e instanceof StepError ? `Runner ${e.message}.` : `Runner error: ${(e as Error).message}`;
      failure = { code: "build_failed", message: message.slice(0, 4000) };
      reporter.event("error", failure.message);
    }
  } finally {
    clearTimeout(deadline);
  }

  const status: FinishRequest["status"] = abortReason === "cancelled" ? "cancelled" : failure || !reachedUpload ? "failed" : "completed";
  try {
    await reporter.stop();
  } catch (e) {
    deps.console(`could not deliver final log batch: ${(e as Error).message}`);
  }

  let logUploadId: string | undefined;
  try {
    logUploadId = (await upload(api, logFile, { kind: "log", fileName: `build-${env.attemptId}.log` })).uploadId;
  } catch (e) {
    deps.console(`log upload failed: ${(e as Error).message}`);
  }

  const image = deps.lock.images[`${spec.distro.family}-${spec.distro.release}`]!;
  const outputs: OutputResult[] = [...states.values()].map((s) => ({
    output: s.output,
    status: s.artifact && !s.error ? "verified" : "failed",
    ...(s.artifact ? { artifactUploadId: s.artifact.uploadId } : {}),
    ...(s.manifest ? { manifestUploadId: s.manifest.uploadId } : {}),
    verification: s.verification,
    installedPackageCount: s.installed.size,
    requestedPackages: s.requested.slice(0, 200),
    ...(s.output === "container" ? { baseImageDigest: digestOf(image) } : { toolchainImageDigest: digestOf(image) }),
    ...(s.error ? { error: s.error.slice(0, 4000) } : {}),
  }));

  try {
    const res = await api.finish({
      status,
      builderRevision: env.builderRevision,
      outputs,
      ...(logUploadId ? { logUploadId } : {}),
      ...(failure ? { failure } : {}),
    });
    deps.console(`finished: ${status}, build is ${res.buildStatus}`);
    return { finished: true, status, buildStatus: res.buildStatus };
  } catch (e) {
    deps.console(`could not report the result: ${(e as Error).message}`);
    return { finished: false, status };
  }
}

/** With no deliverable output the attempt failed; the code says whether uploading or verification was to blame. */
export function overallFailure(states: Pick<OutputState, "built" | "artifact" | "error" | "uploadFailed">[]): FinishRequest["failure"] {
  if (states.some((s) => s.artifact && !s.error)) return undefined;
  const message = states.map((s) => s.error).filter(Boolean).join(" ").slice(0, 4000) || "No output passed verification.";
  if (states.some((s) => s.built && s.uploadFailed)) return { code: "upload_failed", message };
  return { code: "verification_failed", message };
}

async function killLeftovers(deps: PipelineDeps, attemptId: string) {
  try {
    await deps.exec("sudo", ["-n", "docker", "rm", "-f", `linxgen-iso-${attemptId}`], { onLine: () => undefined });
  } catch {
    // nothing to clean up
  }
}

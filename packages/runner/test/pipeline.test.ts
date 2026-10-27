import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaimResponse, EventsRequest, FinishRequest } from "@linxgen/spec";
import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/exec";
import { overallFailure, runPipeline, type PipelineDeps } from "../src/pipeline";
import type { uploadFile } from "../src/upload";
import { LOCK, SPEC } from "./fixtures";

const INSTALLED = "git\t1:2.43.0\ncurl\t8.5.0\nca-certificates\t20240203\nbash\t5.2\n";

function setup(
  opts: {
    failBoot?: "bios" | "uefi";
    failBuild?: "iso" | "container";
    cancelOnSeq?: number;
    missingCurl?: boolean;
    freshWorkRoot?: boolean;
    failUploadKinds?: string[];
  } = {},
) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "linxgen-pipeline-"));
  // A fresh self-hosted runner may point LINXGEN_WORK_ROOT at a directory that does not exist yet.
  const root = opts.freshWorkRoot ? path.join(tmpRoot, "not", "created") : tmpRoot;
  const env = {
    apiUrl: "https://api.test",
    attemptId: "att1",
    dispatchNonce: "n".repeat(43),
    audience: "linxgen-runner",
    builderRevision: "c".repeat(40),
    oidcRequestUrl: "https://oidc.test/token?x=1",
    oidcRequestToken: "req",
    workRoot: root,
    builderDir: "/builder",
  };
  if (!opts.freshWorkRoot) mkdirSync(root, { recursive: true });
  const events: EventsRequest[] = [];
  const finish = vi.fn(async (_body: FinishRequest) => ({ buildStatus: "succeeded" }));
  const claim: ClaimResponse = {
    capability: "cap-secret",
    capabilityExpiresAt: Date.now() + 1e6,
    buildId: "b1",
    attemptId: "att1",
    spec: SPEC,
    limits: { buildTimeoutMinutes: 120, maxArtifactBytes: 1e10, maxLogBytes: 1e7 },
  };
  const api = {
    claim: vi.fn(async () => claim),
    events: vi.fn(async (b: EventsRequest) => {
      events.push(structuredClone(b));
      return { ok: true, cancelRequested: opts.cancelOnSeq !== undefined && b.seq >= opts.cancelOnSeq };
    }),
    uploadStart: vi.fn(),
    uploadParts: vi.fn(),
    uploadComplete: vi.fn(),
    finish,
  };
  const commands: string[][] = [];
  const out = path.join(root, "att1", "out");
  const exec: Exec = async (command, args, o) => {
    commands.push([command, ...args]);
    const joined = args.join(" ");
    const fail = (code = 1) => ({ exitCode: code, signal: null, aborted: false });
    if (o.signal?.aborted) return { exitCode: null, signal: null, aborted: true };
    if (joined.includes("build-iso.sh")) {
      if (opts.failBuild === "iso") return fail(2);
      writeFileSync(path.join(out, "iso-packages.tsv"), opts.missingCurl ? INSTALLED.replace(/curl.*\n/, "") : INSTALLED);
      writeFileSync(path.join(out, "linxgen.iso"), "iso");
    }
    if (joined.includes("container/build.sh")) {
      if (opts.failBuild === "container") return fail(2);
      writeFileSync(path.join(out, "container-packages.tsv"), INSTALLED);
    }
    if (joined.includes("iso-boot.sh") && opts.failBoot && args.includes(opts.failBoot)) return fail();
    o.onLine(`ran ${path.basename(args.find((a) => a.endsWith(".sh")) ?? command)}`, "stdout");
    return { exitCode: 0, signal: null, aborted: false };
  };
  let n = 0;
  const upload = vi.fn(async (_api, _file: string, meta: { kind: string; fileName: string }) => {
    if (opts.failUploadKinds?.includes(meta.kind)) throw new Error("storage unavailable");
    return { uploadId: `${meta.kind}-${++n}`, sizeBytes: 3, sha256: "d".repeat(64) };
  }) as unknown as typeof uploadFile;
  const deps: PipelineDeps = {
    env,
    lock: LOCK,
    api,
    exec,
    upload,
    getOidcToken: async () => "oidc-token-value",
    console: () => undefined,
    mask: vi.fn(),
  };
  return { deps, events, finish, commands, upload, api };
}

const stagesOf = (events: EventsRequest[]) => [...new Set(events.map((e) => e.stage).filter(Boolean))];

describe("runPipeline", () => {
  it("builds, verifies and uploads every output, then reports success", async () => {
    const t = setup();
    const res = await runPipeline(t.deps);
    expect(res).toMatchObject({ finished: true, status: "completed" });
    expect(stagesOf(t.events)).toEqual(["preparing", "building", "verifying", "uploading"]);
    expect(t.deps.mask).toHaveBeenCalledWith("cap-secret");
    const body = t.finish.mock.calls[0]![0];
    expect(body.status).toBe("completed");
    expect(body.logUploadId).toMatch(/^log-/);
    const iso = body.outputs.find((o) => o.output === "iso")!;
    expect(iso).toMatchObject({
      status: "verified",
      verification: { biosBoot: "passed", uefiBoot: "passed", requestedPackagesPresent: true },
      installedPackageCount: 4,
    });
    expect(iso.artifactUploadId).toMatch(/^iso-/);
    expect(iso.manifestUploadId).toMatch(/^manifest-/);
    const container = body.outputs.find((o) => o.output === "container")!;
    expect(container).toMatchObject({ status: "verified", verification: { containerSmoke: "passed" } });
    expect(container.baseImageDigest).toBe(`sha256:${"b".repeat(64)}`);
    // Scripts run through sudo with an argument vector, never through a shell string.
    expect(t.commands.find((c) => c.join(" ").includes("build-iso.sh"))).toEqual([
      "sudo",
      "-n",
      "bash",
      "/builder/build-iso.sh",
      path.join(t.deps.env.workRoot, "att1"),
    ]);
  });

  it("does not upload an ISO that fails a boot test, but still reports the container", async () => {
    const t = setup({ failBoot: "uefi" });
    await runPipeline(t.deps);
    const body = t.finish.mock.calls[0]![0];
    const iso = body.outputs.find((o) => o.output === "iso")!;
    expect(iso.status).toBe("failed");
    expect(iso.artifactUploadId).toBeUndefined();
    expect(iso.verification).toMatchObject({ biosBoot: "passed", uefiBoot: "failed" });
    expect(body.outputs.find((o) => o.output === "container")!.status).toBe("verified");
    expect(body.status).toBe("completed");
  });

  it("fails an output whose requested packages are missing", async () => {
    const t = setup({ missingCurl: true });
    await runPipeline(t.deps);
    const iso = t.finish.mock.calls[0]![0].outputs.find((o) => o.output === "iso")!;
    expect(iso.status).toBe("failed");
    expect(iso.verification.requestedPackagesPresent).toBe(false);
    expect(iso.error).toContain("curl");
  });

  it("reports build_failed when no output builds", async () => {
    const t = setup({ failBuild: "iso" });
    t.deps.exec = (async (cmd, args, o) =>
      args.join(" ").includes("build") && !args.join(" ").includes("host-setup")
        ? { exitCode: 3, signal: null, aborted: false }
        : { exitCode: 0, signal: null, aborted: Boolean(o.signal?.aborted) }) as Exec;
    await runPipeline(t.deps);
    const body = t.finish.mock.calls[0]![0];
    expect(body.status).toBe("failed");
    expect(body.failure?.code).toBe("build_failed");
    expect(stagesOf(t.events)).toEqual(["preparing", "building"]);
  });

  it("stops and reports cancellation when the backend requests it", async () => {
    const t = setup({ cancelOnSeq: 2 });
    const res = await runPipeline(t.deps);
    expect(res.status).toBe("cancelled");
    const body = t.finish.mock.calls[0]![0];
    expect(body.status).toBe("cancelled");
    expect(body.outputs.every((o) => o.status === "failed")).toBe(true);
    expect(t.commands.some((c) => c.join(" ").includes("iso-boot.sh"))).toBe(false);
  });
});

describe("runPipeline setup and failure codes", () => {
  it("creates a work root that does not exist yet", async () => {
    const t = setup({ freshWorkRoot: true });
    const res = await runPipeline(t.deps);
    expect(res).toMatchObject({ finished: true, status: "completed" });
    expect(t.finish.mock.calls[0]![0].logUploadId).toMatch(/^log-/);
  });

  it("reports upload_failed when every verified output fails to upload", async () => {
    const t = setup({ failUploadKinds: ["iso", "container"] });
    await runPipeline(t.deps);
    const body = t.finish.mock.calls[0]![0];
    expect(body.status).toBe("failed");
    expect(body.failure?.code).toBe("upload_failed");
    expect(body.outputs.every((o) => o.status === "failed" && o.error?.startsWith("Upload failed"))).toBe(true);
  });

  it("keeps a partial result unclassified when one output is deliverable", async () => {
    const t = setup({ failUploadKinds: ["container"] });
    await runPipeline(t.deps);
    const body = t.finish.mock.calls[0]![0];
    expect(body.status).toBe("completed");
    expect(body.failure).toBeUndefined();
  });
});

describe("overallFailure", () => {
  const artifact = { uploadId: "u", sizeBytes: 1, sha256: "a".repeat(64) };
  it("is undefined when any output is deliverable", () => {
    expect(overallFailure([{ built: true, artifact }, { built: true, error: "smoke failed" }])).toBeUndefined();
  });
  it("blames uploads only when a built output failed to upload", () => {
    expect(overallFailure([{ built: true, error: "Upload failed: x", uploadFailed: true }, { built: true, error: "boot failed" }])).toMatchObject({
      code: "upload_failed",
    });
  });
  it("otherwise reports a verification failure", () => {
    expect(overallFailure([{ built: true, error: "boot failed" }, { built: false, error: "build failed" }])).toMatchObject({
      code: "verification_failed",
      message: "boot failed build failed",
    });
  });
});

import { v } from "convex/values";
import {
  isForwardStage,
  isTerminalStatus,
  logLinesByteLength,
  MAX_LOG_BATCH_BYTES,
  MAX_LOG_LINE_CHARS,
  RUNNER_STAGES,
  TERMINAL_ATTEMPT_STATUSES,
  verificationPassed,
  type FailureCode,
  type FinishRequest,
} from "@linxgen/spec";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appendEvent, failBuild, finishAttempt, recordOpsError, transitionBuild } from "./lib/buildOps";
import { TIMING } from "./lib/config";
import { maybeAutoSave } from "./lib/saves";
import { getSettings, retentionMs } from "./lib/settings";
import { fitsBudget, storageUsage } from "./lib/storageBudget";
import { artifactKind } from "./schema";

export const MAX_LOG_BATCHES_PER_ATTEMPT = 300;
const RECLAIM_WINDOW_MS = 5 * 60_000;

type Rejection = { ok: false; status: number; error: string };
const reject = (status: number, error: string): Rejection => ({ ok: false, status, error });

/** Validates a runner capability for an attempt. Capabilities are revoked when the attempt ends or the build changes attempt. */
async function checkCapability(
  ctx: QueryCtx | MutationCtx,
  attemptId: string,
  capabilityHash: string,
  opts: { allowFinished?: boolean } = {},
): Promise<{ ok: true; attempt: Doc<"attempts">; build: Doc<"builds"> } | Rejection> {
  const id = ctx.db.normalizeId("attempts", attemptId);
  if (!id) return reject(401, "invalid_capability");
  const attempt = await ctx.db.get(id);
  if (!attempt || !attempt.capabilityHash || attempt.capabilityHash !== capabilityHash) return reject(401, "invalid_capability");
  if ((attempt.capabilityExpiresAt ?? 0) < Date.now()) return reject(401, "capability_expired");
  const build = await ctx.db.get(attempt.buildId);
  if (!build) return reject(404, "build_not_found");
  if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status) && !opts.allowFinished) return reject(409, "attempt_finished");
  if (build.currentAttemptId !== attempt._id) return reject(409, "stale_attempt");
  return { ok: true, attempt, build };
}

export const claimAttempt = internalMutation({
  args: {
    attemptId: v.string(),
    runId: v.string(),
    runAttempt: v.number(),
    workflowSha: v.string(),
    runnerEnvironment: v.optional(v.string()),
    capabilityHash: v.string(),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("attempts", args.attemptId);
    if (!id) return reject(404, "attempt_not_found");
    const attempt = await ctx.db.get(id);
    if (!attempt) return reject(404, "attempt_not_found");
    const build = await ctx.db.get(attempt.buildId);
    if (!build) return reject(404, "build_not_found");
    const now = Date.now();

    const sameRun = attempt.workflowRunId === args.runId && (attempt.workflowRunAttempt ?? args.runAttempt) === args.runAttempt;
    const isReclaim = attempt.status === "running" && sameRun && now - (attempt.claimedAt ?? 0) < RECLAIM_WINDOW_MS;
    if (!isReclaim) {
      if (!["dispatching", "dispatched", "dispatch_unknown"].includes(attempt.status)) return reject(409, "stale_attempt");
      if (attempt.workflowRunId && attempt.workflowRunId !== args.runId) return reject(409, "run_mismatch");
    }
    if (build.currentAttemptId !== attempt._id || isTerminalStatus(build.status)) return reject(409, "stale_attempt");
    if (build.cancelRequestedAt) return reject(409, "cancelled");
    if (args.runAttempt !== 1) return reject(409, "rerun_not_allowed");
    if (!build.specRevisionId) return reject(409, "no_spec");
    const revision = await ctx.db.get(build.specRevisionId);
    if (!revision) return reject(409, "no_spec");

    const settings = await getSettings(ctx);
    const capabilityExpiresAt = (build.deadlineAt ?? now + settings.buildTimeoutMinutes * 60_000) + TIMING.capabilityGraceMs;
    await ctx.db.patch(attempt._id, {
      status: "running",
      workflowRunId: args.runId,
      workflowRunAttempt: args.runAttempt,
      workflowSha: args.workflowSha,
      runnerEnvironment: args.runnerEnvironment,
      capabilityHash: args.capabilityHash,
      capabilityExpiresAt,
      claimedAt: isReclaim ? attempt.claimedAt : now,
      lastHeartbeatAt: now,
    });
    if (!isReclaim) {
      await appendEvent(ctx, build, {
        level: "info",
        message: `Runner started (GitHub run ${args.runId}, workflow ${args.workflowSha.slice(0, 12)})`,
        attemptId: attempt._id,
      });
    }
    return {
      ok: true as const,
      buildId: build._id as string,
      spec: revision.spec,
      capabilityExpiresAt,
      limits: {
        buildTimeoutMinutes: Math.max(1, Math.floor(((build.deadlineAt ?? now) - now) / 60_000)),
        maxArtifactBytes: settings.maxArtifactBytes,
        maxLogBytes: settings.maxLogBytes,
      },
    };
  },
});

export const recordEvents = internalMutation({
  args: {
    attemptId: v.string(),
    capabilityHash: v.string(),
    seq: v.number(),
    stage: v.optional(v.union(...RUNNER_STAGES.map((s) => v.literal(s)))),
    events: v.array(
      v.object({
        at: v.number(),
        level: v.union(v.literal("info"), v.literal("warning"), v.literal("error")),
        message: v.string(),
        output: v.optional(v.union(v.literal("iso"), v.literal("container"))),
      }),
    ),
    logLines: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const check = await checkCapability(ctx, args.attemptId, args.capabilityHash);
    if (!check.ok) return check;
    if (logLinesByteLength(args.logLines) > MAX_LOG_BATCH_BYTES) return reject(413, "log_batch_too_large");
    const { attempt } = check;
    let build = check.build;
    const now = Date.now();
    const cancelRequested = Boolean(build.cancelRequestedAt);
    if (attempt.status !== "running") return reject(409, "attempt_not_running");
    if (args.seq <= attempt.lastEventSeq) {
      await ctx.db.patch(attempt._id, { lastHeartbeatAt: now });
      return { ok: true as const, duplicate: true, cancelRequested };
    }
    await ctx.db.patch(attempt._id, { lastEventSeq: args.seq, lastHeartbeatAt: now });

    if (args.stage && isForwardStage(build.status, args.stage)) {
      // Runners may skip reporting a stage; walk forward through the defined order so every transition is valid.
      const target = RUNNER_STAGES.indexOf(args.stage);
      let index = RUNNER_STAGES.indexOf(build.status as (typeof RUNNER_STAGES)[number]);
      while (index < target) {
        index++;
        build = await transitionBuild(ctx, build._id, RUNNER_STAGES[index]!);
      }
    }

    for (const e of args.events.slice(0, 50)) {
      await appendEvent(ctx, build, {
        level: e.level,
        message: e.message,
        source: "runner",
        output: e.output,
        attemptId: attempt._id,
        at: Math.min(Math.max(e.at, attempt.claimedAt ?? 0), now),
      });
      build = (await ctx.db.get(build._id))!;
    }

    if (args.logLines.length > 0) {
      await ctx.db.insert("logBatches", {
        buildId: build._id,
        attemptId: attempt._id,
        seq: args.seq,
        at: now,
        lines: args.logLines.slice(0, 500).map((l) => l.slice(0, MAX_LOG_LINE_CHARS)),
      });
      // The retained count lives on the attempt so pruning reads only the batches it deletes.
      const retained = (attempt.logBatchCount ?? 0) + 1;
      const excess = retained - MAX_LOG_BATCHES_PER_ATTEMPT;
      if (excess > 0) {
        const oldest = await ctx.db
          .query("logBatches")
          .withIndex("by_attempt_seq", (q) => q.eq("attemptId", attempt._id))
          .order("asc")
          .take(excess);
        for (const old of oldest) await ctx.db.delete(old._id);
        await ctx.db.patch(attempt._id, { logBatchCount: retained - oldest.length });
      } else {
        await ctx.db.patch(attempt._id, { logBatchCount: retained });
      }
    }
    return { ok: true as const, duplicate: false, cancelRequested };
  },
});

export const capabilityContext = internalQuery({
  args: { attemptId: v.string(), capabilityHash: v.string() },
  handler: async (ctx, { attemptId, capabilityHash }) => {
    const check = await checkCapability(ctx, attemptId, capabilityHash);
    if (!check.ok) return check;
    if (check.attempt.status !== "running") return reject(409, "attempt_not_running");
    const settings = await getSettings(ctx);
    return {
      ok: true as const,
      attemptId: check.attempt._id,
      buildId: check.build._id,
      requestedOutputs: check.build.requestedOutputs,
      maxArtifactBytes: settings.maxArtifactBytes,
      maxLogBytes: settings.maxLogBytes,
      maxStoredBytes: settings.maxStoredBytes,
      storedBytes: (await storageUsage(ctx)).storedBytes,
    };
  },
});

export const findUpload = internalQuery({
  args: { attemptId: v.id("attempts"), kind: artifactKind, fileName: v.string() },
  handler: async (ctx, { attemptId, kind, fileName }) => {
    const rows = await ctx.db
      .query("uploads")
      .withIndex("by_attempt_kind", (q) => q.eq("attemptId", attemptId).eq("kind", kind))
      .collect();
    return rows.find((u) => u.fileName === fileName && u.status !== "aborted") ?? null;
  },
});

export const getUpload = internalQuery({
  args: { uploadId: v.string(), attemptId: v.id("attempts") },
  handler: async (ctx, { uploadId, attemptId }) => {
    const id = ctx.db.normalizeId("uploads", uploadId);
    if (!id) return null;
    const upload = await ctx.db.get(id);
    return upload && upload.attemptId === attemptId ? upload : null;
  },
});

export const recordUploadStart = internalMutation({
  args: {
    attemptId: v.string(),
    capabilityHash: v.string(),
    kind: artifactKind,
    fileName: v.string(),
    sizeBytes: v.number(),
    sha256: v.string(),
    contentType: v.string(),
    storageKey: v.string(),
    storageUploadId: v.string(),
    partSizeBytes: v.number(),
    partCount: v.number(),
  },
  handler: async (ctx, args) => {
    const check = await checkCapability(ctx, args.attemptId, args.capabilityHash);
    if (!check.ok) return check;
    const existing = (
      await ctx.db
        .query("uploads")
        .withIndex("by_attempt_kind", (q) => q.eq("attemptId", check.attempt._id).eq("kind", args.kind))
        .collect()
    ).find((u) => u.fileName === args.fileName && u.status !== "aborted");
    if (existing) return { ok: true as const, uploadId: existing._id, duplicateOf: args.storageUploadId };
    // Checked here, inside the serializable mutation, so concurrent uploads cannot overshoot the budget together.
    const settings = await getSettings(ctx);
    if (!fitsBudget((await storageUsage(ctx)).storedBytes, args.sizeBytes, settings.maxStoredBytes)) return reject(409, "storage_full");
    const { attemptId: _a, capabilityHash: _c, ...rest } = args;
    const uploadId = await ctx.db.insert("uploads", {
      ...rest,
      buildId: check.build._id,
      attemptId: check.attempt._id,
      status: "uploading",
      createdAt: Date.now(),
    });
    return { ok: true as const, uploadId, duplicateOf: undefined };
  },
});

const FORMATS: Record<Doc<"artifacts">["kind"], string> = {
  iso: "ISO 9660 hybrid image (BIOS + UEFI)",
  container: "Docker image archive (gzip, docker load)",
  log: "Build log (text)",
  manifest: "Installed package manifest (JSON)",
};

export const completeUpload = internalMutation({
  args: { attemptId: v.string(), capabilityHash: v.string(), uploadId: v.id("uploads"), actualSizeBytes: v.number() },
  handler: async (ctx, args) => {
    const check = await checkCapability(ctx, args.attemptId, args.capabilityHash);
    if (!check.ok) return check;
    const upload = await ctx.db.get(args.uploadId);
    if (!upload || upload.attemptId !== check.attempt._id) return reject(404, "upload_not_found");
    if (upload.status === "completed" && upload.artifactId) return { ok: true as const, artifactId: upload.artifactId };
    if (upload.status !== "uploading") return reject(409, "upload_not_active");
    if (args.actualSizeBytes !== upload.sizeBytes) {
      await ctx.db.patch(upload._id, { status: "aborted" });
      await recordOpsError(ctx, "storage", `Upload size mismatch for ${upload.fileName}`, { buildId: upload.buildId, attemptId: upload.attemptId });
      return reject(422, "size_mismatch");
    }
    const settings = await getSettings(ctx);
    const now = Date.now();
    const artifactId = await ctx.db.insert("artifacts", {
      buildId: upload.buildId,
      ownerId: check.build.ownerId,
      attemptId: upload.attemptId,
      kind: upload.kind,
      fileName: upload.fileName,
      format: FORMATS[upload.kind],
      contentType: upload.contentType,
      storageKey: upload.storageKey,
      sizeBytes: upload.sizeBytes,
      sha256: upload.sha256,
      // ISOs and containers become downloadable only after the finish report confirms verification.
      verified: false,
      status: "available",
      // Provisional; the finish report restarts the retention period when the build ends.
      expiresAt: now + retentionMs(settings),
      createdAt: now,
    });
    await ctx.db.patch(upload._id, { status: "completed", completedAt: now, artifactId });
    return { ok: true as const, artifactId };
  },
});

const RUNNER_FAILURE_CODES: FailureCode[] = [
  "unsupported_configuration",
  "build_failed",
  "verification_failed",
  "upload_failed",
  "storage_full",
  "timed_out",
];

export const finish = internalMutation({
  args: { attemptId: v.string(), capabilityHash: v.string(), body: v.any() },
  handler: async (ctx, args) => {
    const body = args.body as FinishRequest;
    const check = await checkCapability(ctx, args.attemptId, args.capabilityHash, { allowFinished: true });
    if (!check.ok) return check;
    const { attempt } = check;
    let build = check.build;
    if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) return { ok: true as const, buildStatus: build.status, duplicate: true };
    if (attempt.status !== "running") return reject(409, "attempt_not_running");
    const now = Date.now();

    const uploads = new Map<string, Doc<"uploads">>();
    for (const kind of ["iso", "container", "log", "manifest"] as const) {
      for (const u of await ctx.db
        .query("uploads")
        .withIndex("by_attempt_kind", (q) => q.eq("attemptId", attempt._id).eq("kind", kind))
        .collect()) {
        uploads.set(u._id, u);
      }
    }
    const completedArtifact = (uploadId: string | undefined, kind: Doc<"uploads">["kind"]): Id<"artifacts"> | undefined => {
      if (!uploadId) return undefined;
      const u = uploads.get(uploadId);
      return u && u.kind === kind && u.status === "completed" ? u.artifactId : undefined;
    };

    // Files are kept for the retention period counted from when the build finishes, not from when each upload ended.
    const keepUntil = now + retentionMs(await getSettings(ctx));
    for (const u of uploads.values()) {
      if (u.status === "completed" && u.artifactId) await ctx.db.patch(u.artifactId, { expiresAt: keepUntil });
    }

    const results: Doc<"builds">["outputResults"] = [];
    for (const output of build.requestedOutputs) {
      const r = body.outputs.find((o) => o.output === output);
      if (!r) {
        results.push({ output, status: "failed", error: "The runner reported no result for this output." });
        continue;
      }
      const artifactId = completedArtifact(r.artifactUploadId, output);
      const manifestArtifactId = completedArtifact(r.manifestUploadId, "manifest");
      const passed = verificationPassed(output, r.verification);
      const verified = r.status === "verified" && passed && Boolean(artifactId);
      let error = r.error;
      if (!verified && !error) {
        error = !passed ? "Verification did not pass." : !artifactId ? "The artifact upload did not complete." : "Output failed.";
      }
      if (artifactId) {
        await ctx.db.patch(artifactId, {
          verified,
          verification: r.verification,
          // Unverified images are kept briefly for diagnosis and never offered for download.
          ...(verified ? {} : { expiresAt: now + TIMING.unverifiedArtifactGraceMs }),
        });
      }
      results.push({
        output,
        status: verified ? "verified" : "failed",
        artifactId,
        manifestArtifactId,
        verification: r.verification,
        installedPackageCount: r.installedPackageCount,
        requestedPackages: r.requestedPackages.slice(0, 200),
        baseImageDigest: r.baseImageDigest,
        toolchainImageDigest: r.toolchainImageDigest,
        error: verified ? undefined : error?.slice(0, 2000),
      });
    }

    const allVerified = results.length > 0 && results.every((r) => r.status === "verified");
    const someVerified = results.some((r) => r.status === "verified");
    await ctx.db.patch(attempt._id, {
      builderRevision: body.builderRevision,
      lastHeartbeatAt: now,
    });
    await ctx.db.patch(build._id, { outputResults: results });
    build = (await ctx.db.get(build._id))!;

    const minutes = Math.max(1, Math.round((now - (attempt.claimedAt ?? now)) / 60_000));
    await ctx.db.insert("usageRecords", { ownerId: build.ownerId, buildId: build._id, kind: "build_minutes", minutes, at: now });

    // An explicit failure from the runner (for example a timeout during the final manifest upload) wins over
    // per-output results, even when every image was verified.
    const explicitFailure =
      body.status === "failed" && body.failure && RUNNER_FAILURE_CODES.includes(body.failure.code as FailureCode)
        ? { code: body.failure.code as FailureCode, message: body.failure.message }
        : undefined;
    const failedResults = results.filter((r) => r.status !== "verified");

    if (build.cancelRequestedAt || body.status === "cancelled") {
      await finishAttempt(ctx, attempt._id, "cancelled");
      build = await failBuild(ctx, build._id, "cancelled", "Build cancelled.");
    } else if (explicitFailure) {
      await finishAttempt(ctx, attempt._id, "failed", explicitFailure);
      build = await failBuild(ctx, build._id, explicitFailure.code, explicitFailure.message.slice(0, 2000));
    } else if (allVerified && body.status === "completed") {
      if (build.status !== "uploading") {
        await finishAttempt(ctx, attempt._id, "failed", { code: "internal_error", message: `Finished from ${build.status}` });
        build = await failBuild(ctx, build._id, "internal_error", "The runner finished without completing the upload stage.");
      } else {
        await finishAttempt(ctx, attempt._id, "succeeded");
        build = await transitionBuild(ctx, build._id, "succeeded", {}, {
          message: `All outputs verified and uploaded (${results.map((r) => r.output).join(" + ")}).`,
        });
      }
    } else if (someVerified && failedResults.length > 0) {
      const ok = results.filter((r) => r.status === "verified").map((r) => r.output);
      const message = `Partial result: ${ok.join(", ")} verified; ${failedResults.map((r) => `${r.output} failed (${r.error ?? "unknown error"})`).join("; ")}.`;
      await finishAttempt(ctx, attempt._id, "failed", { code: "partial_outputs", message });
      build = await failBuild(ctx, build._id, "partial_outputs", message);
    } else {
      const code = RUNNER_FAILURE_CODES.includes(body.failure?.code as FailureCode) ? (body.failure!.code as FailureCode) : "build_failed";
      const message = body.failure?.message ?? results.find((r) => r.error)?.error ?? "The runner reported a failure.";
      await finishAttempt(ctx, attempt._id, "failed", { code, message });
      build = await failBuild(ctx, build._id, code, message.slice(0, 2000));
    }
    await maybeAutoSave(ctx, build);
    return { ok: true as const, buildStatus: build.status, duplicate: false };
  },
});

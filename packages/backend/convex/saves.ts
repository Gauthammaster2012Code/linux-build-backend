import { v } from "convex/values";
import {
  ACTIVE_SAVE_STATUSES,
  isTerminalSaveStatus,
  SAVE_FAILURE_MESSAGES,
  SAVE_SPLIT_PART_BYTES,
  GITHUB_ASSET_LIMIT_BYTES,
  TERMINAL_ATTEMPT_STATUSES,
  type SaveFailureCode,
  type SaveFinishRequest,
  type SaveProgressRequest,
} from "@linxgen/spec";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appError, ERR, requireMember, requireOwnedBuild } from "./lib/access";
import { recordOpsError } from "./lib/buildOps";
import { ConfigError, runnerSecret, SAVE_LIMITS, saveDispatchConfig, storageAppConfigured, TIMING } from "./lib/config";
import { saveDispatchNonce } from "./lib/crypto";
import { cancelWorkflowRun, dispatchWorkflow, findRunForAttempt, getWorkflowRun, GitHubError, installationToken, saveRunNameFor } from "./lib/github";
import {
  buildIsSaveable,
  connectionFor,
  enqueueSave,
  failSave,
  finishSave,
  markConnectionBroken,
  pickSavesToStart,
  releaseFor,
} from "./lib/saves";
import { attemptLivenessAt, decideUnclaimed } from "./orchestrator";
import { attemptStatus, saveFailureCode } from "./schema";

const RECLAIM_WINDOW_MS = 5 * 60_000;

type Rejection = { ok: false; status: number; error: string };
const reject = (status: number, error: string): Rejection => ({ ok: false, status, error });

function summarize(s: Doc<"saves">) {
  return {
    saveId: s._id,
    buildId: s.buildId,
    trigger: s.trigger,
    status: s.status,
    statusChangedAt: s.statusChangedAt,
    repoFullName: s.repoFullName,
    releaseUrl: s.releaseUrl,
    assetCount: s.assetCount,
    totalBytes: s.totalBytes,
    progress: s.progress,
    failure: s.failure,
    attemptCount: s.attemptCount,
    cancelRequested: Boolean(s.cancelRequestedAt),
    createdAt: s.createdAt,
    finishedAt: s.finishedAt,
  };
}

async function latestSaves(ctx: QueryCtx, buildId: Id<"builds">, limit: number) {
  return ctx.db
    .query("saves")
    .withIndex("by_build", (q) => q.eq("buildId", buildId))
    .order("desc")
    .take(limit);
}

/** Save state for the build page: whether saving is possible and the most recent saves. */
export const forBuild = query({
  args: { buildId: v.id("builds") },
  handler: async (ctx, { buildId }) => {
    const { profile, build } = await requireOwnedBuild(ctx, buildId);
    const configured = storageAppConfigured();
    const connection = configured ? await connectionFor(ctx, profile._id) : null;
    const saves = await latestSaves(ctx, buildId, 5);
    return {
      configured,
      connection: connection ? { status: connection.status, repoFullName: `${connection.repoOwner}/${connection.repoName}`, autoSave: connection.autoSave } : null,
      saveable: buildIsSaveable(build),
      saves: saves.map(summarize),
    };
  },
});

function throwIfRejected(result: Awaited<ReturnType<typeof enqueueSave>>) {
  if (!result.ok) throw appError(result.code.toUpperCase(), result.message);
  return { saveId: result.saveId, existing: result.existing };
}

export const request = mutation({
  args: { buildId: v.id("builds") },
  handler: async (ctx, { buildId }) => {
    const { build } = await requireOwnedBuild(ctx, buildId);
    return throwIfRejected(await enqueueSave(ctx, build, "manual"));
  },
});

export const retry = mutation({
  args: { saveId: v.id("saves") },
  handler: async (ctx, { saveId }) => {
    const profile = await requireMember(ctx);
    const save = await ctx.db.get(saveId);
    if (!save || save.ownerId !== profile._id) throw appError(ERR.notFound, "Save not found.");
    if (!isTerminalSaveStatus(save.status) || save.status === "succeeded") throw appError("INVALID_STATE", "Only failed or cancelled saves can be retried.");
    const build = await ctx.db.get(save.buildId);
    if (!build) throw appError(ERR.notFound, "Build not found.");
    return throwIfRejected(await enqueueSave(ctx, build, "manual", { retryOfSaveId: save._id }));
  },
});

export const cancel = mutation({
  args: { saveId: v.id("saves") },
  handler: async (ctx, { saveId }) => {
    const profile = await requireMember(ctx);
    const save = await ctx.db.get(saveId);
    if (!save || save.ownerId !== profile._id) throw appError(ERR.notFound, "Save not found.");
    await requestSaveCancel(ctx, save);
  },
});

async function requestSaveCancel(ctx: MutationCtx, save: Doc<"saves">) {
  if (isTerminalSaveStatus(save.status) || save.cancelRequestedAt) return;
  const attempt = save.currentAttemptId ? await ctx.db.get(save.currentAttemptId) : null;
  if (save.status === "queued" || !attempt || attempt.status !== "running") {
    await failSave(ctx, save._id, "cancelled");
    if (attempt) await ctx.scheduler.runAfter(0, internal.saves.cancelRun, { saveAttemptId: attempt._id });
    return;
  }
  // The runner sees the request on its next progress report and stops; the reconciler finalizes it otherwise.
  await ctx.db.patch(save._id, { cancelRequestedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.saves.cancelRun, { saveAttemptId: attempt._id });
}

/** Starts queued saves while the save slots allow. Serializable like the build tick, so limits hold under concurrency. */
export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const active: Doc<"saves">[] = [];
    for (const status of ["dispatched", "running"] as const) {
      active.push(...(await ctx.db.query("saves").withIndex("by_status", (q) => q.eq("status", status)).collect()));
    }
    if (active.length >= SAVE_LIMITS.activeGlobal) return { started: 0 };
    const byOwner = new Map<string, number>();
    for (const s of active) byOwner.set(s.ownerId, (byOwner.get(s.ownerId) ?? 0) + 1);
    const queued = await ctx.db
      .query("saves")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(100);
    const now = Date.now();
    let started = 0;
    for (const save of pickSavesToStart(queued, byOwner, active.length)) {
      const owner = await ctx.db.get(save.ownerId);
      if (!owner || owner.status !== "active") {
        await failSave(ctx, save._id, "cancelled", "Membership is no longer active.");
        continue;
      }
      const number = save.attemptCount + 1;
      const saveAttemptId = await ctx.db.insert("saveAttempts", {
        saveId: save._id,
        ownerId: save.ownerId,
        number,
        status: "dispatching",
        lastProgressSeq: -1,
        createdAt: now,
      });
      await ctx.db.patch(save._id, {
        status: "dispatched",
        statusChangedAt: now,
        currentAttemptId: saveAttemptId,
        attemptCount: number,
        startedAt: save.startedAt ?? now,
      });
      await ctx.scheduler.runAfter(0, internal.saves.dispatchAttempt, { saveAttemptId, tries: 0 });
      started++;
    }
    return { started };
  },
});

export const getAttempt = internalQuery({
  args: { saveAttemptId: v.id("saveAttempts") },
  handler: async (ctx, { saveAttemptId }) => ctx.db.get(saveAttemptId),
});

export const markDispatched = internalMutation({
  args: { saveAttemptId: v.id("saveAttempts"), runId: v.optional(v.string()) },
  handler: async (ctx, { saveAttemptId, runId }) => {
    const attempt = await ctx.db.get(saveAttemptId);
    if (!attempt) return;
    if (attempt.status === "dispatching" || attempt.status === "dispatch_unknown") {
      await ctx.db.patch(saveAttemptId, { status: "dispatched", dispatchedAt: Date.now(), ...(runId ? { workflowRunId: runId } : {}) });
    } else if (runId && !attempt.workflowRunId) {
      await ctx.db.patch(saveAttemptId, { workflowRunId: runId });
    }
  },
});

export const markDispatchUnknown = internalMutation({
  args: { saveAttemptId: v.id("saveAttempts"), message: v.string() },
  handler: async (ctx, { saveAttemptId, message }) => {
    const attempt = await ctx.db.get(saveAttemptId);
    if (!attempt || attempt.status !== "dispatching") return;
    await ctx.db.patch(saveAttemptId, { status: "dispatch_unknown", dispatchedAt: Date.now() });
    await recordOpsError(ctx, "save", `Save dispatch outcome unknown: ${message}`);
  },
});

export const markDispatchFailed = internalMutation({
  args: { saveAttemptId: v.id("saveAttempts"), message: v.string() },
  handler: async (ctx, { saveAttemptId, message }) => {
    const attempt = await ctx.db.get(saveAttemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.includes(attempt.status) || attempt.status === "running") return;
    await ctx.db.insert("opsErrors", { at: Date.now(), area: "save", message: message.slice(0, 2000), saveId: attempt.saveId });
    const save = await ctx.db.get(attempt.saveId);
    if (save && save.currentAttemptId === saveAttemptId) await failSave(ctx, save._id, "dispatch_failed");
  },
});

export const dispatchAttempt = internalAction({
  args: { saveAttemptId: v.id("saveAttempts"), tries: v.number() },
  handler: async (ctx, { saveAttemptId, tries }) => {
    const attempt = await ctx.runQuery(internal.saves.getAttempt, { saveAttemptId });
    if (!attempt || attempt.status !== "dispatching") return;
    let cfg: ReturnType<typeof saveDispatchConfig>;
    let nonce: string;
    let token: string;
    try {
      cfg = saveDispatchConfig();
      nonce = await saveDispatchNonce(runnerSecret(), saveAttemptId);
      token = await installationToken(cfg);
    } catch (e) {
      if (e instanceof GitHubError && e.ambiguous && tries < 3) {
        await ctx.scheduler.runAfter(30_000 * (tries + 1), internal.saves.dispatchAttempt, { saveAttemptId, tries: tries + 1 });
        return;
      }
      const message = e instanceof ConfigError ? `Save dispatch is not configured: ${e.message}` : `GitHub authentication failed: ${(e as Error).message}`;
      await ctx.runMutation(internal.saves.markDispatchFailed, { saveAttemptId, message });
      return;
    }
    try {
      const { runId } = await dispatchWorkflow(cfg, token, { save_attempt_id: saveAttemptId, dispatch_nonce: nonce });
      await ctx.runMutation(internal.saves.markDispatched, { saveAttemptId, runId });
    } catch (e) {
      if (e instanceof GitHubError && e.ambiguous) {
        await ctx.runMutation(internal.saves.markDispatchUnknown, { saveAttemptId, message: e.message });
      } else {
        await ctx.runMutation(internal.saves.markDispatchFailed, { saveAttemptId, message: (e as Error).message });
      }
    }
  },
});

export const cancelRun = internalAction({
  args: { saveAttemptId: v.id("saveAttempts") },
  handler: async (ctx, { saveAttemptId }) => {
    const attempt = await ctx.runQuery(internal.saves.getAttempt, { saveAttemptId });
    if (!attempt) return;
    try {
      const cfg = saveDispatchConfig();
      const token = await installationToken(cfg);
      const runId =
        attempt.workflowRunId ?? (await findRunForAttempt(cfg, token, saveAttemptId, attempt.createdAt, fetch, saveRunNameFor(saveAttemptId)))?.id;
      if (runId) await cancelWorkflowRun(cfg, token, runId);
    } catch (e) {
      await ctx.runMutation(internal.saves.logSaveError, { message: `Cancelling save run failed: ${(e as Error).message}`, saveId: attempt.saveId });
    }
  },
});

export const logSaveError = internalMutation({
  args: { message: v.string(), saveId: v.optional(v.id("saves")) },
  handler: async (ctx, { message, saveId }) => {
    await ctx.db.insert("opsErrors", { at: Date.now(), area: "save", message: message.slice(0, 2000), saveId });
  },
});

/** Validates a save capability. It is revoked when the save attempt ends or the save moves to another attempt. */
async function checkSaveCapability(
  ctx: QueryCtx | MutationCtx,
  saveAttemptId: string,
  capabilityHash: string,
  opts: { allowFinished?: boolean } = {},
): Promise<{ ok: true; attempt: Doc<"saveAttempts">; save: Doc<"saves"> } | Rejection> {
  const id = ctx.db.normalizeId("saveAttempts", saveAttemptId);
  if (!id) return reject(401, "invalid_capability");
  const attempt = await ctx.db.get(id);
  if (!attempt || !attempt.capabilityHash || attempt.capabilityHash !== capabilityHash) return reject(401, "invalid_capability");
  if ((attempt.capabilityExpiresAt ?? 0) < Date.now()) return reject(401, "capability_expired");
  const save = await ctx.db.get(attempt.saveId);
  if (!save) return reject(404, "save_not_found");
  if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status) && !opts.allowFinished) return reject(409, "attempt_finished");
  if (save.currentAttemptId !== attempt._id) return reject(409, "stale_attempt");
  return { ok: true, attempt, save };
}

/** Everything a save runner needs besides tokens and URLs, which the HTTP layer adds. */
async function saveWork(ctx: QueryCtx | MutationCtx, save: Doc<"saves">) {
  const build = await ctx.db.get(save.buildId);
  if (!build) return { ok: false as const, code: "internal_error" as const };
  const connection = await connectionFor(ctx, save.ownerId);
  if (!connection) return { ok: false as const, code: "not_connected" as const };
  if (connection.status !== "connected") return { ok: false as const, code: "github_unauthorized" as const };
  const files: Doc<"artifacts">[] = [];
  for (const id of save.artifactIds) {
    const a = await ctx.db.get(id);
    // Expired files stay readable until cleanup deletes them; an active save holds them for a while longer.
    if (!a || a.status !== "available") return { ok: false as const, code: "storage_expired" as const };
    files.push(a);
  }
  const threshold = splitThreshold();
  return {
    ok: true as const,
    files: files.map((a) => ({ kind: a.kind, fileName: a.fileName, sizeBytes: a.sizeBytes, sha256: a.sha256, storageKey: a.storageKey })),
    connection: { installationId: connection.installationId, repoId: connection.repoId, repoOwner: connection.repoOwner, repoName: connection.repoName },
    release: releaseFor(build, { owner: connection.repoOwner, name: connection.repoName }, files, threshold),
  };
}

/** Files larger than one part are split; each part stays below GitHub's per-asset limit. */
function splitThreshold(): number {
  return Math.min(GITHUB_ASSET_LIMIT_BYTES - 1, SAVE_SPLIT_PART_BYTES);
}

export const claimAttempt = internalMutation({
  args: {
    saveAttemptId: v.string(),
    runId: v.string(),
    runAttempt: v.number(),
    workflowSha: v.string(),
    capabilityHash: v.string(),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("saveAttempts", args.saveAttemptId);
    if (!id) return reject(404, "attempt_not_found");
    const attempt = await ctx.db.get(id);
    if (!attempt) return reject(404, "attempt_not_found");
    const save = await ctx.db.get(attempt.saveId);
    if (!save) return reject(404, "save_not_found");
    const now = Date.now();
    const sameRun = attempt.workflowRunId === args.runId && (attempt.workflowRunAttempt ?? args.runAttempt) === args.runAttempt;
    const isReclaim = attempt.status === "running" && sameRun && now - (attempt.claimedAt ?? 0) < RECLAIM_WINDOW_MS;
    if (!isReclaim) {
      if (!["dispatching", "dispatched", "dispatch_unknown"].includes(attempt.status)) return reject(409, "stale_attempt");
      if (attempt.workflowRunId && attempt.workflowRunId !== args.runId) return reject(409, "run_mismatch");
    }
    if (save.currentAttemptId !== attempt._id || isTerminalSaveStatus(save.status)) return reject(409, "stale_attempt");
    if (save.cancelRequestedAt) return reject(409, "cancelled");
    if (args.runAttempt !== 1) return reject(409, "rerun_not_allowed");

    const work = await saveWork(ctx, save);
    if (!work.ok) {
      await failSave(ctx, save._id, work.code);
      return reject(409, work.code);
    }
    const deadlineAt = isReclaim && attempt.deadlineAt ? attempt.deadlineAt : now + TIMING.saveTimeoutMs;
    const capabilityExpiresAt = deadlineAt + TIMING.capabilityGraceMs;
    await ctx.db.patch(attempt._id, {
      status: "running",
      workflowRunId: args.runId,
      workflowRunAttempt: args.runAttempt,
      workflowSha: args.workflowSha,
      capabilityHash: args.capabilityHash,
      capabilityExpiresAt,
      deadlineAt,
      claimedAt: isReclaim ? attempt.claimedAt : now,
      lastHeartbeatAt: now,
    });
    if (save.status !== "running") await ctx.db.patch(save._id, { status: "running", statusChangedAt: now });
    const { ok: _ok, ...data } = work;
    return { ok: true as const, saveId: save._id, ownerId: save.ownerId, deadlineAt, capabilityExpiresAt, ...data };
  },
});

/** Read-only view for the file and token refresh routes. */
export const capabilityContext = internalQuery({
  args: { saveAttemptId: v.string(), capabilityHash: v.string() },
  handler: async (ctx, { saveAttemptId, capabilityHash }) => {
    const check = await checkSaveCapability(ctx, saveAttemptId, capabilityHash);
    if (!check.ok) return check;
    if (check.attempt.status !== "running") return reject(409, "attempt_not_running");
    if (check.save.cancelRequestedAt) return reject(409, "cancelled");
    const work = await saveWork(ctx, check.save);
    if (!work.ok) return reject(409, work.code);
    const { ok: _ok, ...data } = work;
    return { ok: true as const, saveId: check.save._id, ownerId: check.save.ownerId, ...data };
  },
});

export const recordProgress = internalMutation({
  args: { saveAttemptId: v.string(), capabilityHash: v.string(), body: v.any() },
  handler: async (ctx, args) => {
    const body = args.body as SaveProgressRequest;
    const check = await checkSaveCapability(ctx, args.saveAttemptId, args.capabilityHash);
    if (!check.ok) return check;
    const { attempt, save } = check;
    if (attempt.status !== "running") return reject(409, "attempt_not_running");
    const now = Date.now();
    const cancelRequested = Boolean(save.cancelRequestedAt);
    if (body.seq <= attempt.lastProgressSeq) {
      await ctx.db.patch(attempt._id, { lastHeartbeatAt: now });
      return { ok: true as const, cancelRequested };
    }
    await ctx.db.patch(attempt._id, { lastProgressSeq: body.seq, lastHeartbeatAt: now });
    await ctx.db.patch(save._id, {
      progress: {
        phase: body.phase,
        doneBytes: Math.min(body.doneBytes, body.totalBytes),
        totalBytes: body.totalBytes,
        ...(body.message ? { message: body.message.slice(0, 500) } : {}),
        at: now,
      },
    });
    return { ok: true as const, cancelRequested };
  },
});

/** Records a failure the HTTP layer detected while preparing a runner request (for example a revoked installation). */
export const failAttempt = internalMutation({
  args: { saveAttemptId: v.id("saveAttempts"), code: saveFailureCode, message: v.optional(v.string()), breakConnection: v.optional(v.boolean()) },
  handler: async (ctx, { saveAttemptId, code, message, breakConnection }) => {
    const attempt = await ctx.db.get(saveAttemptId);
    if (!attempt) return;
    const save = await ctx.db.get(attempt.saveId);
    if (!save || save.currentAttemptId !== saveAttemptId) return;
    if (breakConnection) await markConnectionBroken(ctx, save.ownerId, SAVE_FAILURE_MESSAGES[code]);
    await failSave(ctx, save._id, code, message ?? SAVE_FAILURE_MESSAGES[code]);
  },
});

export const finish = internalMutation({
  args: { saveAttemptId: v.string(), capabilityHash: v.string(), body: v.any() },
  handler: async (ctx, args) => {
    const body = args.body as SaveFinishRequest;
    const check = await checkSaveCapability(ctx, args.saveAttemptId, args.capabilityHash, { allowFinished: true });
    if (!check.ok) return check;
    const { attempt, save } = check;
    if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status) || isTerminalSaveStatus(save.status)) {
      return { ok: true as const, saveStatus: save.status, duplicate: true };
    }
    if (attempt.status !== "running") return reject(409, "attempt_not_running");
    const releasePrefix = `https://github.com/${save.repoFullName}/releases/`;
    let updated: Doc<"saves"> | null;
    if (save.cancelRequestedAt || body.status === "cancelled") {
      updated = await failSave(ctx, save._id, "cancelled");
    } else if (body.status === "succeeded") {
      const releaseUrl = body.releaseUrl?.startsWith(releasePrefix) ? body.releaseUrl : undefined;
      updated = await finishSave(ctx, save._id, "succeeded", { releaseUrl, assetCount: body.assetCount });
    } else {
      const code: SaveFailureCode = body.failure?.code ?? "upload_failed";
      if (code === "github_unauthorized" || code === "repo_missing") await markConnectionBroken(ctx, save.ownerId, SAVE_FAILURE_MESSAGES[code]);
      updated = await failSave(ctx, save._id, code, body.failure?.message || SAVE_FAILURE_MESSAGES[code]);
    }
    return { ok: true as const, saveStatus: updated?.status ?? save.status, duplicate: false };
  },
});

/** Puts a save whose runner disappeared back in the queue once, then fails it. */
async function handleLostSaveAttempt(ctx: MutationCtx, saveAttemptId: Id<"saveAttempts">, reason: string) {
  const attempt = await ctx.db.get(saveAttemptId);
  if (!attempt || TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) return;
  await ctx.db.patch(saveAttemptId, { status: "lost", finishedAt: Date.now(), failure: { code: "runner_lost", message: reason } });
  const save = await ctx.db.get(attempt.saveId);
  if (!save || save.currentAttemptId !== saveAttemptId || isTerminalSaveStatus(save.status)) return;
  if (save.cancelRequestedAt) {
    await failSave(ctx, save._id, "cancelled");
    return;
  }
  if (attempt.number < TIMING.maxAttemptsPerSave) {
    const now = Date.now();
    await ctx.db.patch(save._id, { status: "queued", statusChangedAt: now, currentAttemptId: undefined, progress: undefined });
    await ctx.scheduler.runAfter(0, internal.saves.tick, {});
  } else {
    await failSave(ctx, save._id, "runner_lost", `${reason} The save was stopped after ${attempt.number} attempt(s).`);
  }
}

export const markLostIfUnchanged = internalMutation({
  args: { saveAttemptId: v.id("saveAttempts"), observedStatus: attemptStatus, observedLivenessAt: v.number(), reason: v.string() },
  handler: async (ctx, { saveAttemptId, observedStatus, observedLivenessAt, reason }) => {
    const attempt = await ctx.db.get(saveAttemptId);
    if (!attempt || attempt.status !== observedStatus || attemptLivenessAt(attempt) !== observedLivenessAt) return false;
    await handleLostSaveAttempt(ctx, saveAttemptId, reason);
    return true;
  },
});

export const recordGithubCheck = internalMutation({
  args: { saveAttemptId: v.id("saveAttempts"), runId: v.optional(v.string()) },
  handler: async (ctx, { saveAttemptId, runId }) => {
    const attempt = await ctx.db.get(saveAttemptId);
    if (!attempt) return;
    await ctx.db.patch(saveAttemptId, { lastGithubCheckAt: Date.now(), ...(runId && !attempt.workflowRunId ? { workflowRunId: runId } : {}) });
  },
});

export const markTimedOut = internalMutation({
  args: { saveAttemptId: v.id("saveAttempts"), observedDeadlineAt: v.number() },
  handler: async (ctx, { saveAttemptId, observedDeadlineAt }) => {
    const attempt = await ctx.db.get(saveAttemptId);
    if (!attempt || attempt.status !== "running" || attempt.deadlineAt !== observedDeadlineAt || observedDeadlineAt > Date.now()) return false;
    const save = await ctx.db.get(attempt.saveId);
    if (!save || save.currentAttemptId !== saveAttemptId) return false;
    await failSave(ctx, save._id, "timed_out");
    return true;
  },
});

export const finalizeCancel = internalMutation({
  args: { saveId: v.id("saves") },
  handler: async (ctx, { saveId }) => {
    const save = await ctx.db.get(saveId);
    if (!save || isTerminalSaveStatus(save.status) || !save.cancelRequestedAt) return false;
    if (Date.now() - save.cancelRequestedAt < TIMING.cancelGraceMs) return false;
    await failSave(ctx, saveId, "cancelled");
    return true;
  },
});

export const reconcileCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stuckDispatching = (
      await ctx.db
        .query("saveAttempts")
        .withIndex("by_status", (q) => q.eq("status", "dispatching").lt("createdAt", now - TIMING.dispatchStuckMs))
        .take(50)
    ).map((a) => a._id);
    const awaitingClaim: Doc<"saveAttempts">[] = [];
    for (const status of ["dispatched", "dispatch_unknown"] as const) {
      awaitingClaim.push(...(await ctx.db.query("saveAttempts").withIndex("by_status", (q) => q.eq("status", status)).take(50)));
    }
    const running = await ctx.db.query("saveAttempts").withIndex("by_status", (q) => q.eq("status", "running")).take(100);
    const overdue = running.filter((a) => a.deadlineAt !== undefined && a.deadlineAt < now).map((a) => ({ saveAttemptId: a._id, deadlineAt: a.deadlineAt! }));
    const staleRunning = running.filter((a) => (a.deadlineAt ?? Infinity) >= now && attemptLivenessAt(a) < now - TIMING.heartbeatTimeoutMs);
    const stuckCancels: Id<"saves">[] = [];
    for (const status of ACTIVE_SAVE_STATUSES) {
      for (const s of await ctx.db.query("saves").withIndex("by_status", (q) => q.eq("status", status)).take(100)) {
        if (s.cancelRequestedAt && s.cancelRequestedAt < now - TIMING.cancelGraceMs) stuckCancels.push(s._id);
      }
    }
    const due = (a: Doc<"saveAttempts">) => !a.lastGithubCheckAt || a.lastGithubCheckAt < now - 60_000;
    return { now, stuckDispatching, awaitingClaim: awaitingClaim.filter(due), staleRunning: staleRunning.filter(due), overdue, stuckCancels };
  },
});

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const work = await ctx.runQuery(internal.saves.reconcileCandidates, {});
    for (const saveAttemptId of work.stuckDispatching) {
      await ctx.runMutation(internal.saves.markDispatchUnknown, { saveAttemptId, message: "save dispatch action did not complete" });
    }
    let gh: { cfg: ReturnType<typeof saveDispatchConfig>; token: string } | null = null;
    if (work.awaitingClaim.length + work.staleRunning.length + work.overdue.length > 0) {
      try {
        const cfg = saveDispatchConfig();
        gh = { cfg, token: await installationToken(cfg) };
      } catch (e) {
        await ctx.runMutation(internal.saves.logSaveError, { message: `GitHub unavailable for save reconciliation: ${(e as Error).message}` });
      }
    }
    const lookup = async (a: Doc<"saveAttempts">) => {
      if (!gh) return undefined;
      const run = a.workflowRunId
        ? await getWorkflowRun(gh.cfg, gh.token, a.workflowRunId)
        : await findRunForAttempt(gh.cfg, gh.token, a._id, a.createdAt, fetch, saveRunNameFor(a._id));
      await ctx.runMutation(internal.saves.recordGithubCheck, { saveAttemptId: a._id, runId: run?.id });
      return run;
    };
    const markLost = (a: Doc<"saveAttempts">, reason: string) =>
      ctx.runMutation(internal.saves.markLostIfUnchanged, {
        saveAttemptId: a._id,
        observedStatus: a.status,
        observedLivenessAt: attemptLivenessAt(a),
        reason,
      });

    for (const a of work.awaitingClaim) {
      try {
        const run = await lookup(a);
        if (run === undefined) continue;
        const decision = decideUnclaimed(a, run, work.now);
        if (decision === "wait") continue;
        const reason =
          decision === "lost_never_started"
            ? "GitHub never started the save workflow."
            : decision === "lost_exited"
              ? "The save runner exited before starting."
              : "No runner became available for the save in time.";
        const marked = await markLost(a, reason);
        if (marked && decision === "lost_queue_timeout" && run && gh) await cancelWorkflowRun(gh.cfg, gh.token, run.id);
      } catch (e) {
        await ctx.runMutation(internal.saves.logSaveError, { message: (e as Error).message, saveId: a.saveId });
      }
    }
    for (const a of work.staleRunning) {
      try {
        const run = await lookup(a);
        if (run === undefined) continue;
        const veryStale = work.now - attemptLivenessAt(a) > 2 * TIMING.heartbeatTimeoutMs;
        if (run && run.status !== "completed" && !veryStale) continue;
        const marked = await markLost(a, run?.status === "completed" ? "The save runner stopped without reporting a result." : "The save runner stopped responding.");
        if (marked && run && run.status !== "completed" && gh) await cancelWorkflowRun(gh.cfg, gh.token, run.id);
      } catch (e) {
        await ctx.runMutation(internal.saves.logSaveError, { message: (e as Error).message, saveId: a.saveId });
      }
    }
    for (const { saveAttemptId, deadlineAt } of work.overdue) {
      const timedOut = await ctx.runMutation(internal.saves.markTimedOut, { saveAttemptId, observedDeadlineAt: deadlineAt });
      if (timedOut) await ctx.runAction(internal.saves.cancelRun, { saveAttemptId });
    }
    for (const saveId of work.stuckCancels) await ctx.runMutation(internal.saves.finalizeCancel, { saveId });
    await ctx.runMutation(internal.saves.tick, {});
  },
});

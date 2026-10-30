import { v } from "convex/values";
import { ACTIVE_RUNNER_STATUSES, TERMINAL_ATTEMPT_STATUSES, isTerminalStatus } from "@linxgen/spec";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { appendEvent, failBuild, finishAttempt, recordOpsError, transitionBuild } from "./lib/buildOps";
import { ConfigError, githubAppConfig, runnerSecret, TIMING } from "./lib/config";
import { dispatchNonce } from "./lib/crypto";
import {
  cancelWorkflowRun,
  dispatchWorkflow,
  findRunForAttempt,
  getWorkflowRun,
  GitHubError,
  installationToken,
  type WorkflowRunInfo,
} from "./lib/github";
import { pickBuildsToStart } from "./lib/scheduling";
import { getSettings } from "./lib/settings";
import { attemptStatus } from "./schema";

/**
 * Starts queued builds while capacity allows. Convex mutations are serializable, so concurrent ticks cannot
 * both claim the same build or exceed the limits; a conflicting tick is retried against fresh data.
 */
export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const settings = await getSettings(ctx);
    const active: Doc<"builds">[] = [];
    for (const status of ACTIVE_RUNNER_STATUSES) {
      active.push(...(await ctx.db.query("builds").withIndex("by_status", (q) => q.eq("status", status)).collect()));
    }
    if (active.length >= settings.maxActiveBuildsGlobal) return { started: 0 };
    const activeByOwner = new Map<string, number>();
    for (const b of active) activeByOwner.set(b.ownerId, (activeByOwner.get(b.ownerId) ?? 0) + 1);

    const queued = await ctx.db
      .query("builds")
      .withIndex("by_status_queuedAt", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(100);
    const picked = pickBuildsToStart(queued, activeByOwner, active.length, settings);
    const now = Date.now();
    let started = 0;
    for (const build of picked) {
      const owner = await ctx.db.get(build.ownerId);
      if (!owner || owner.status !== "active") {
        await failBuild(ctx, build._id, "cancelled", "Membership is no longer active.");
        continue;
      }
      const number = build.attemptCount + 1;
      const attemptId = await ctx.db.insert("attempts", {
        buildId: build._id,
        ownerId: build.ownerId,
        number,
        status: "dispatching",
        lastEventSeq: -1,
        createdAt: now,
      });
      await transitionBuild(
        ctx,
        build._id,
        "preparing",
        {
          currentAttemptId: attemptId,
          attemptCount: number,
          startedAt: build.startedAt ?? now,
          deadlineAt: now + settings.buildTimeoutMinutes * 60_000,
        },
        { message: number > 1 ? `Requesting a new runner (attempt ${number})` : "Requesting a GitHub Actions runner" },
      );
      await ctx.scheduler.runAfter(0, internal.orchestrator.dispatchAttempt, { attemptId, tries: 0 });
      started++;
    }
    return { started };
  },
});

export const getAttempt = internalQuery({
  args: { attemptId: v.id("attempts") },
  handler: async (ctx, { attemptId }) => ctx.db.get(attemptId),
});

export const markDispatched = internalMutation({
  args: { attemptId: v.id("attempts"), runId: v.optional(v.string()) },
  handler: async (ctx, { attemptId, runId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt) return;
    if (attempt.status === "dispatching" || attempt.status === "dispatch_unknown") {
      await ctx.db.patch(attemptId, { status: "dispatched", dispatchedAt: Date.now(), ...(runId ? { workflowRunId: runId } : {}) });
      const build = await ctx.db.get(attempt.buildId);
      if (build) await appendEvent(ctx, build, { level: "info", message: "Build workflow dispatched; waiting for a runner", attemptId });
    } else if (runId && !attempt.workflowRunId) {
      await ctx.db.patch(attemptId, { workflowRunId: runId });
    }
  },
});

export const markDispatchUnknown = internalMutation({
  args: { attemptId: v.id("attempts"), message: v.string() },
  handler: async (ctx, { attemptId, message }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || attempt.status !== "dispatching") return;
    await ctx.db.patch(attemptId, { status: "dispatch_unknown", dispatchedAt: Date.now() });
    await recordOpsError(ctx, "dispatch", `Dispatch outcome unknown: ${message}`, { buildId: attempt.buildId, attemptId });
    const build = await ctx.db.get(attempt.buildId);
    if (build) {
      await appendEvent(ctx, build, {
        level: "warning",
        message: "Could not confirm the workflow dispatch. Checking GitHub before retrying.",
        attemptId,
      });
    }
  },
});

export const markDispatchFailed = internalMutation({
  args: { attemptId: v.id("attempts"), message: v.string() },
  handler: async (ctx, { attemptId, message }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || TERMINAL_ATTEMPT_STATUSES.includes(attempt.status) || attempt.status === "running") return;
    await finishAttempt(ctx, attemptId, "failed", { code: "dispatch_failed", message });
    await recordOpsError(ctx, "dispatch", message, { buildId: attempt.buildId, attemptId });
    const build = await ctx.db.get(attempt.buildId);
    if (build && build.currentAttemptId === attemptId && !isTerminalStatus(build.status)) {
      await failBuild(ctx, build._id, "dispatch_failed", "The build could not be started on GitHub Actions. An administrator has been notified.");
    }
  },
});

export const dispatchAttempt = internalAction({
  args: { attemptId: v.id("attempts"), tries: v.number() },
  handler: async (ctx, { attemptId, tries }) => {
    const attempt = await ctx.runQuery(internal.orchestrator.getAttempt, { attemptId });
    if (!attempt || attempt.status !== "dispatching") return;
    let cfg: ReturnType<typeof githubAppConfig>;
    let nonce: string;
    let token: string;
    try {
      cfg = githubAppConfig();
      nonce = await dispatchNonce(runnerSecret(), attemptId);
      token = await installationToken(cfg);
    } catch (e) {
      // Nothing was dispatched yet, so retrying is safe.
      if (e instanceof GitHubError && e.ambiguous && tries < 3) {
        await ctx.scheduler.runAfter(30_000 * (tries + 1), internal.orchestrator.dispatchAttempt, { attemptId, tries: tries + 1 });
        return;
      }
      const message = e instanceof ConfigError ? `GitHub dispatch is not configured: ${e.message}` : `GitHub authentication failed: ${(e as Error).message}`;
      await ctx.runMutation(internal.orchestrator.markDispatchFailed, { attemptId, message });
      return;
    }
    try {
      const { runId } = await dispatchWorkflow(cfg, token, { attempt_id: attemptId, dispatch_nonce: nonce });
      await ctx.runMutation(internal.orchestrator.markDispatched, { attemptId, runId });
    } catch (e) {
      if (e instanceof GitHubError && e.ambiguous) {
        // GitHub may have started the run. The reconciler looks it up by name before deciding.
        await ctx.runMutation(internal.orchestrator.markDispatchUnknown, { attemptId, message: e.message });
      } else {
        await ctx.runMutation(internal.orchestrator.markDispatchFailed, { attemptId, message: (e as Error).message });
      }
    }
  },
});

export const cancelRun = internalAction({
  args: { attemptId: v.id("attempts") },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.runQuery(internal.orchestrator.getAttempt, { attemptId });
    if (!attempt) return;
    try {
      const cfg = githubAppConfig();
      const token = await installationToken(cfg);
      let runId = attempt.workflowRunId;
      if (!runId) runId = (await findRunForAttempt(cfg, token, attemptId, attempt.createdAt))?.id;
      if (runId) await cancelWorkflowRun(cfg, token, runId);
    } catch (e) {
      await ctx.runMutation(internal.orchestrator.logOpsError, {
        area: "dispatch",
        message: `Cancelling workflow run failed: ${(e as Error).message}`,
        attemptId,
        buildId: attempt.buildId,
      });
    }
  },
});

export const logOpsError = internalMutation({
  args: {
    area: v.union(v.literal("dispatch"), v.literal("reconcile"), v.literal("cleanup"), v.literal("storage"), v.literal("runner"), v.literal("generation")),
    message: v.string(),
    buildId: v.optional(v.id("builds")),
    attemptId: v.optional(v.id("attempts")),
  },
  handler: async (ctx, { area, message, buildId, attemptId }) => recordOpsError(ctx, area, message, { buildId, attemptId }),
});

/**
 * Handles an attempt whose runner disappeared. The build gets one more attempt if nothing was verified yet;
 * otherwise it fails with an accurate runner-lost error.
 */
export async function handleLostAttempt(ctx: MutationCtx, attemptId: Id<"attempts">, reason: string) {
  const attempt = await ctx.db.get(attemptId);
  if (!attempt || TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) return;
  await finishAttempt(ctx, attemptId, "lost", { code: "runner_lost", message: reason });
  const build = await ctx.db.get(attempt.buildId);
  if (!build || build.currentAttemptId !== attemptId || isTerminalStatus(build.status)) return;
  if (build.cancelRequestedAt) {
    await failBuild(ctx, build._id, "cancelled", "Build cancelled.");
    return;
  }
  const anyVerified = build.outputResults.some((r) => r.status === "verified");
  const canRequeue = attempt.number < TIMING.maxAttemptsPerBuild && !anyVerified && build.status !== "uploading";
  if (canRequeue) {
    await transitionBuild(ctx, build._id, "queued", { currentAttemptId: undefined }, {
      level: "warning",
      message: `${reason} Retrying on a new runner.`,
    });
  } else {
    await failBuild(ctx, build._id, "runner_lost", `${reason} The build was stopped after ${attempt.number} attempt(s).`);
  }
}

/** The latest sign of life for an attempt; reconciliation decisions are bound to the value they observed. */
export function attemptLivenessAt(a: Pick<Doc<"attempts">, "lastHeartbeatAt" | "claimedAt" | "createdAt">): number {
  return a.lastHeartbeatAt ?? a.claimedAt ?? a.createdAt;
}

/**
 * Marks an attempt lost only if it is still in the status and has the liveness timestamp that the reconciler saw
 * before its GitHub lookups. Returns false when a runner claimed or reported in the meantime.
 */
export const markAttemptLostIfUnchanged = internalMutation({
  args: { attemptId: v.id("attempts"), observedStatus: attemptStatus, observedLivenessAt: v.number(), reason: v.string() },
  handler: async (ctx, { attemptId, observedStatus, observedLivenessAt, reason }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || attempt.status !== observedStatus || attemptLivenessAt(attempt) !== observedLivenessAt) return false;
    await handleLostAttempt(ctx, attemptId, reason);
    return true;
  },
});

export const recordGithubCheck = internalMutation({
  args: { attemptId: v.id("attempts"), runId: v.optional(v.string()) },
  handler: async (ctx, { attemptId, runId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt) return;
    await ctx.db.patch(attemptId, {
      lastGithubCheckAt: Date.now(),
      ...(runId && !attempt.workflowRunId ? { workflowRunId: runId } : {}),
    });
  },
});

/**
 * Times out a build if it still runs the observed attempt under the observed deadline. A build that was requeued
 * or moved to a new attempt (with a new deadline) since the reconciler looked is left alone. Returns the attempt
 * whose workflow run should be cancelled, or null if nothing was timed out.
 */
export const markTimedOut = internalMutation({
  args: { buildId: v.id("builds"), observedAttemptId: v.optional(v.id("attempts")), observedDeadlineAt: v.number() },
  handler: async (ctx, { buildId, observedAttemptId, observedDeadlineAt }) => {
    const build = await ctx.db.get(buildId);
    if (!build || isTerminalStatus(build.status)) return { timedOut: false, attemptId: null };
    if (build.currentAttemptId !== observedAttemptId || build.deadlineAt !== observedDeadlineAt || observedDeadlineAt > Date.now()) {
      return { timedOut: false, attemptId: null };
    }
    if (build.currentAttemptId) await finishAttempt(ctx, build.currentAttemptId, "timed_out", { code: "timed_out", message: "Build time limit reached" });
    await failBuild(ctx, buildId, "timed_out", "The build exceeded its time limit and was stopped.");
    return { timedOut: true, attemptId: build.currentAttemptId ?? null };
  },
});

export const finalizeCancel = internalMutation({
  args: { buildId: v.id("builds"), observedAttemptId: v.optional(v.id("attempts")) },
  handler: async (ctx, { buildId, observedAttemptId }) => {
    const build = await ctx.db.get(buildId);
    if (!build || isTerminalStatus(build.status) || !build.cancelRequestedAt) return { finalized: false };
    if (build.currentAttemptId !== observedAttemptId) return { finalized: false };
    if (build.currentAttemptId) await finishAttempt(ctx, build.currentAttemptId, "cancelled");
    await failBuild(ctx, buildId, "cancelled", "Build cancelled.");
    return { finalized: true };
  },
});

export const failStuckGeneration = internalMutation({
  args: { buildId: v.id("builds") },
  handler: async (ctx, { buildId }) => {
    const build = await ctx.db.get(buildId);
    if (!build || (build.status !== "generating" && build.status !== "validating")) return;
    if (Date.now() - build.statusChangedAt < TIMING.generationTimeoutMs) return;
    if (build.generationRequestId) await ctx.db.patch(build.generationRequestId, { status: "failed", completedAt: Date.now() });
    await failBuild(ctx, buildId, "timed_out", "Configuration generation did not finish in time.");
  },
});

export const reconcileCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stuckGenerations: Id<"builds">[] = [];
    for (const status of ["generating", "validating"] as const) {
      const rows = await ctx.db
        .query("builds")
        .withIndex("by_status", (q) => q.eq("status", status).lt("statusChangedAt", now - TIMING.generationTimeoutMs))
        .take(50);
      stuckGenerations.push(...rows.map((b) => b._id));
    }
    const stuckDispatching = (
      await ctx.db
        .query("attempts")
        .withIndex("by_status", (q) => q.eq("status", "dispatching").lt("createdAt", now - TIMING.dispatchStuckMs))
        .take(50)
    ).map((a) => a._id);
    const awaitingClaim: Doc<"attempts">[] = [];
    for (const status of ["dispatched", "dispatch_unknown"] as const) {
      awaitingClaim.push(...(await ctx.db.query("attempts").withIndex("by_status", (q) => q.eq("status", status)).take(50)));
    }
    const running = await ctx.db.query("attempts").withIndex("by_status", (q) => q.eq("status", "running")).take(100);
    const staleRunning = running.filter((a) => attemptLivenessAt(a) < now - TIMING.heartbeatTimeoutMs);

    const overdue: { buildId: Id<"builds">; attemptId?: Id<"attempts">; deadlineAt: number }[] = [];
    const stuckCancels: { buildId: Id<"builds">; attemptId?: Id<"attempts"> }[] = [];
    for (const status of ACTIVE_RUNNER_STATUSES) {
      for (const b of await ctx.db.query("builds").withIndex("by_status", (q) => q.eq("status", status)).take(100)) {
        if (b.deadlineAt && b.deadlineAt < now) overdue.push({ buildId: b._id, attemptId: b.currentAttemptId, deadlineAt: b.deadlineAt });
        else if (b.cancelRequestedAt && b.cancelRequestedAt < now - TIMING.cancelGraceMs) {
          stuckCancels.push({ buildId: b._id, attemptId: b.currentAttemptId });
        }
      }
    }
    const due = (a: Doc<"attempts">) => !a.lastGithubCheckAt || a.lastGithubCheckAt < now - 60_000;
    return {
      now,
      stuckGenerations,
      stuckDispatching,
      awaitingClaim: awaitingClaim.filter(due),
      staleRunning: staleRunning.filter(due),
      overdue,
      stuckCancels,
    };
  },
});

export type ClaimWaitDecision = "wait" | "lost_never_started" | "lost_exited" | "lost_queue_timeout";

/** Decides what to do with a dispatched attempt that no runner has claimed yet. */
export function decideUnclaimed(attempt: Pick<Doc<"attempts">, "status" | "createdAt" | "dispatchedAt">, run: WorkflowRunInfo | null, now: number): ClaimWaitDecision {
  const since = attempt.dispatchedAt ?? attempt.createdAt;
  if (!run) {
    return now - since > TIMING.unknownDispatchGraceMs ? "lost_never_started" : "wait";
  }
  if (run.status === "completed") return "lost_exited";
  return now - since > TIMING.claimTimeoutMs ? "lost_queue_timeout" : "wait";
}

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const work = await ctx.runQuery(internal.orchestrator.reconcileCandidates, {});
    for (const buildId of work.stuckGenerations) await ctx.runMutation(internal.orchestrator.failStuckGeneration, { buildId });
    for (const attemptId of work.stuckDispatching) {
      await ctx.runMutation(internal.orchestrator.markDispatchUnknown, { attemptId, message: "dispatch action did not complete" });
    }

    const needsGithub = work.awaitingClaim.length + work.staleRunning.length + work.overdue.length + work.stuckCancels.length > 0;
    let gh: { cfg: ReturnType<typeof githubAppConfig>; token: string } | null = null;
    if (needsGithub) {
      try {
        const cfg = githubAppConfig();
        gh = { cfg, token: await installationToken(cfg) };
      } catch (e) {
        await ctx.runMutation(internal.orchestrator.logOpsError, { area: "reconcile", message: `GitHub unavailable: ${(e as Error).message}` });
      }
    }
    const lookup = async (a: Doc<"attempts">) => {
      if (!gh) return undefined;
      const run = a.workflowRunId
        ? await getWorkflowRun(gh.cfg, gh.token, a.workflowRunId)
        : await findRunForAttempt(gh.cfg, gh.token, a._id, a.createdAt);
      await ctx.runMutation(internal.orchestrator.recordGithubCheck, { attemptId: a._id, runId: run?.id });
      return run;
    };

    // Each decision is committed only if the attempt is unchanged since the snapshot; the workflow run is
    // cancelled afterwards, so a runner that claimed or reported during the lookup is never cancelled.
    const markLostIfUnchanged = (a: Doc<"attempts">, reason: string) =>
      ctx.runMutation(internal.orchestrator.markAttemptLostIfUnchanged, {
        attemptId: a._id,
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
            ? "GitHub never started the build workflow."
            : decision === "lost_exited"
              ? "The runner exited before starting the build."
              : "No runner became available in time.";
        const marked = await markLostIfUnchanged(a, reason);
        if (marked && decision === "lost_queue_timeout" && run && gh) await cancelWorkflowRun(gh.cfg, gh.token, run.id);
      } catch (e) {
        await ctx.runMutation(internal.orchestrator.logOpsError, { area: "reconcile", message: (e as Error).message, attemptId: a._id });
      }
    }

    for (const a of work.staleRunning) {
      try {
        const run = await lookup(a);
        if (run === undefined) continue;
        const veryStale = work.now - attemptLivenessAt(a) > 2 * TIMING.heartbeatTimeoutMs;
        if (run && run.status !== "completed" && !veryStale) continue;
        const marked = await markLostIfUnchanged(
          a,
          run?.status === "completed" ? "The runner stopped without reporting a result." : "The runner stopped responding.",
        );
        if (marked && run && run.status !== "completed" && gh) await cancelWorkflowRun(gh.cfg, gh.token, run.id);
      } catch (e) {
        await ctx.runMutation(internal.orchestrator.logOpsError, { area: "reconcile", message: (e as Error).message, attemptId: a._id });
      }
    }

    for (const { buildId, attemptId, deadlineAt } of work.overdue) {
      const result = await ctx.runMutation(internal.orchestrator.markTimedOut, {
        buildId,
        observedAttemptId: attemptId,
        observedDeadlineAt: deadlineAt,
      });
      if (result.attemptId) await ctx.runAction(internal.orchestrator.cancelRun, { attemptId: result.attemptId });
    }

    for (const { buildId, attemptId } of work.stuckCancels) {
      const result = await ctx.runMutation(internal.orchestrator.finalizeCancel, { buildId, observedAttemptId: attemptId });
      if (result.finalized && attemptId) await ctx.runAction(internal.orchestrator.cancelRun, { attemptId });
    }

    await ctx.runMutation(internal.orchestrator.tick, {});
  },
});

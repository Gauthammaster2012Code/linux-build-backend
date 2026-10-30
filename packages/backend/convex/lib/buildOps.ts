import {
  ACTIVE_RUNNER_STATUSES,
  BUILD_STATUSES,
  STATUS_LABELS,
  TERMINAL_ATTEMPT_STATUSES,
  canTransition,
  isTerminalStatus,
  type AttemptStatus,
  type BuildStatus,
  type FailureCode,
} from "@linxgen/spec";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReaderCtx } from "./access";

export const MAX_EVENTS_PER_BUILD = 1500;

const UNFINISHED_BUILD_STATUSES = BUILD_STATUSES.filter((s) => !isTerminalStatus(s));

/**
 * Finds an owner's unfinished builds by status, independent of how many newer finished builds exist.
 * Stops early once `limit` builds are found, which is all a quota check needs.
 */
export async function unfinishedBuilds(ctx: ReaderCtx, ownerId: Id<"profiles">, limit = Infinity): Promise<Doc<"builds">[]> {
  const found: Doc<"builds">[] = [];
  for (const status of UNFINISHED_BUILD_STATUSES) {
    if (found.length >= limit) break;
    const q = ctx.db.query("builds").withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId).eq("status", status));
    found.push(...(Number.isFinite(limit) ? await q.take(limit - found.length) : await q.collect()));
  }
  return found;
}

export class InvalidTransitionError extends Error {}

export async function appendEvent(
  ctx: MutationCtx,
  build: Doc<"builds">,
  event: {
    level: "info" | "warning" | "error";
    message: string;
    source?: "system" | "runner";
    stage?: BuildStatus;
    attemptId?: Id<"attempts">;
    output?: "iso" | "container";
    at?: number;
  },
) {
  // Keep event history bounded. Informational runner chatter is dropped first; warnings, errors and system events are kept.
  if (build.eventCount >= MAX_EVENTS_PER_BUILD && event.level === "info" && event.source === "runner") return;
  await ctx.db.insert("buildEvents", {
    buildId: build._id,
    attemptId: event.attemptId,
    at: event.at ?? Date.now(),
    level: event.level,
    source: event.source ?? "system",
    stage: event.stage,
    output: event.output,
    message: event.message.slice(0, 2000),
  });
  const fresh = await ctx.db.get(build._id);
  if (fresh) await ctx.db.patch(build._id, { eventCount: fresh.eventCount + 1 });
}

/** Moves a build to a new status, enforcing the shared lifecycle. */
export async function transitionBuild(
  ctx: MutationCtx,
  buildId: Id<"builds">,
  to: BuildStatus,
  patch: Partial<Doc<"builds">> = {},
  note?: { level?: "info" | "warning" | "error"; message?: string },
): Promise<Doc<"builds">> {
  const build = await ctx.db.get(buildId);
  if (!build) throw new InvalidTransitionError("Build not found");
  if (!canTransition(build.status, to)) {
    throw new InvalidTransitionError(`Invalid build transition ${build.status} -> ${to}`);
  }
  const now = Date.now();
  await ctx.db.patch(buildId, {
    ...patch,
    status: to,
    statusChangedAt: now,
    ...(isTerminalStatus(to) ? { finishedAt: now } : {}),
  });
  const updated = (await ctx.db.get(buildId))!;
  await appendEvent(ctx, updated, {
    level: note?.level ?? (to === "failed" || to === "timed_out" ? "error" : "info"),
    message: note?.message ?? STATUS_LABELS[to],
    stage: to,
  });
  if (isTerminalStatus(to) || ACTIVE_RUNNER_STATUSES.includes(build.status)) {
    // A runner slot may have been freed.
    await ctx.scheduler.runAfter(0, internal.orchestrator.tick, {});
  }
  return (await ctx.db.get(buildId))!;
}

export async function failBuild(
  ctx: MutationCtx,
  buildId: Id<"builds">,
  code: FailureCode,
  message: string,
  extra: Partial<Doc<"builds">> = {},
) {
  const to: BuildStatus = code === "timed_out" ? "timed_out" : code === "cancelled" ? "cancelled" : "failed";
  return transitionBuild(ctx, buildId, to, { ...extra, failure: { code, message } }, { level: "error", message });
}

export async function finishAttempt(
  ctx: MutationCtx,
  attemptId: Id<"attempts">,
  status: AttemptStatus,
  failure?: { code: string; message: string },
) {
  const attempt = await ctx.db.get(attemptId);
  if (!attempt || TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) return;
  await ctx.db.patch(attemptId, { status, finishedAt: Date.now(), ...(failure ? { failure } : {}) });
}

export async function recordOpsError(
  ctx: MutationCtx,
  area: Doc<"opsErrors">["area"],
  message: string,
  refs: { buildId?: Id<"builds">; attemptId?: Id<"attempts"> } = {},
) {
  await ctx.db.insert("opsErrors", { at: Date.now(), area, message: message.slice(0, 2000), ...refs });
}

/**
 * Requests cancellation. Builds that have not reached a runner are cancelled immediately; running builds
 * are cancelled on GitHub and finalized when the runner acknowledges or the reconciler gives up waiting.
 */
export async function requestCancel(ctx: MutationCtx, build: Doc<"builds">, reason: string) {
  if (isTerminalStatus(build.status)) return build;
  if (build.status === "generating" || build.status === "validating" || build.status === "queued") {
    if (build.generationRequestId) {
      const req = await ctx.db.get(build.generationRequestId);
      if (req && (req.status === "pending" || req.status === "running")) await ctx.db.patch(req._id, { status: "cancelled" });
    }
    return failBuild(ctx, build._id, "cancelled", reason);
  }
  if (build.cancelRequestedAt) return build;
  await ctx.db.patch(build._id, { cancelRequestedAt: Date.now() });
  await appendEvent(ctx, build, { level: "warning", message: `Cancellation requested: ${reason}` });
  const attempt = build.currentAttemptId ? await ctx.db.get(build.currentAttemptId) : null;
  if (attempt && attempt.status !== "running" && !TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) {
    // No runner has claimed the attempt; any later claim is rejected as stale.
    await finishAttempt(ctx, attempt._id, "cancelled");
    await ctx.scheduler.runAfter(0, internal.orchestrator.cancelRun, { attemptId: attempt._id });
    return failBuild(ctx, build._id, "cancelled", reason);
  }
  if (attempt) await ctx.scheduler.runAfter(0, internal.orchestrator.cancelRun, { attemptId: attempt._id });
  return (await ctx.db.get(build._id))!;
}

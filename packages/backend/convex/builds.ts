import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { getDistroInfo, MAX_LOG_BATCHES_PER_PAGE, TERMINAL_BUILD_STATUSES, type ResolvedBuildSpec } from "@linxgen/spec";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { appError, requireMember, requireOwnedBuild } from "./lib/access";
import { appendEvent, requestCancel, unfinishedBuilds } from "./lib/buildOps";
import { getSettings } from "./lib/settings";
import { startGeneration } from "./generation";

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

function summarize(b: Doc<"builds">) {
  return {
    buildId: b._id,
    projectId: b.projectId,
    title: b.title,
    status: b.status,
    statusChangedAt: b.statusChangedAt,
    requestedOutputs: b.requestedOutputs,
    outputResults: b.outputResults.map((r) => ({ output: r.output, status: r.status })),
    failure: b.failure,
    cancelRequested: Boolean(b.cancelRequestedAt),
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
    retryOfBuildId: b.retryOfBuildId,
  };
}

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const profile = await requireMember(ctx);
    const page = await ctx.db
      .query("builds")
      .withIndex("by_owner", (q) => q.eq("ownerId", profile._id))
      .order("desc")
      .paginate(paginationOpts);
    return { ...page, page: page.page.map(summarize) };
  },
});

export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const profile = await requireMember(ctx);
    const settings = await getSettings(ctx);
    const recent = await ctx.db
      .query("builds")
      .withIndex("by_owner", (q) => q.eq("ownerId", profile._id))
      .order("desc")
      .take(10);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner_updated", (q) => q.eq("ownerId", profile._id))
      .order("desc")
      .take(12);
    const since = Date.now() - 24 * 60 * 60_000;
    const generations = (
      await ctx.db
        .query("usageRecords")
        .withIndex("by_owner_kind_at", (q) => q.eq("ownerId", profile._id).eq("kind", "ai_generation").gt("at", since))
        .collect()
    ).filter((u) => u.providerSource === "platform").length;
    const buildMinutes = (
      await ctx.db
        .query("usageRecords")
        .withIndex("by_owner_kind_at", (q) => q.eq("ownerId", profile._id).eq("kind", "build_minutes").gt("at", since - 6 * 24 * 60 * 60_000))
        .collect()
    ).reduce((s, u) => s + (u.minutes ?? 0), 0);
    const unfinished = await unfinishedBuilds(ctx, profile._id);
    return {
      recentBuilds: recent.map(summarize),
      projects: projects.map((p) => ({ projectId: p._id, name: p.name, updatedAt: p.updatedAt, latestBuildId: p.latestBuildId })),
      usage: {
        unfinishedBuilds: unfinished.length,
        maxPendingBuilds: settings.maxPendingBuildsPerUser,
        maxActiveBuilds: settings.maxActiveBuildsPerUser,
        platformGenerationsToday: generations,
        platformGenerationsPerDay: settings.platformGenerationsPerDay,
        buildMinutesLast7Days: buildMinutes,
        artifactRetentionDays: settings.artifactRetentionDays,
      },
    };
  },
});

async function artifactSummaries(ctx: QueryCtx, build: Doc<"builds">) {
  const rows = await ctx.db
    .query("artifacts")
    .withIndex("by_build", (q) => q.eq("buildId", build._id))
    .collect();
  return rows
    .filter((a) => a.attemptId === build.currentAttemptId || a.verified)
    .map((a) => ({
      artifactId: a._id,
      kind: a.kind,
      fileName: a.fileName,
      format: a.format,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
      verified: a.verified,
      verification: a.verification,
      status: a.status,
      expiresAt: a.expiresAt,
      downloadable: a.status === "available" && a.expiresAt > Date.now() && (a.verified || a.kind === "log" || a.kind === "manifest"),
    }));
}

export const get = query({
  args: { buildId: v.id("builds") },
  handler: async (ctx, { buildId }) => {
    const { build } = await requireOwnedBuild(ctx, buildId);
    const generation = build.generationRequestId ? await ctx.db.get(build.generationRequestId) : null;
    const revision = build.specRevisionId ? await ctx.db.get(build.specRevisionId) : null;
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_build", (q) => q.eq("buildId", build._id))
      .collect();
    const spec = revision?.spec as ResolvedBuildSpec | undefined;
    return {
      ...summarize(build),
      outputResults: build.outputResults,
      unsupported: build.unsupported,
      deadlineAt: build.deadlineAt,
      startedAt: build.startedAt,
      queuedAt: build.queuedAt,
      prompt: generation?.prompt,
      preferences: generation?.preferences,
      provider: generation ? { source: generation.provider.source, kind: generation.provider.kind, model: generation.provider.model } : null,
      generationAttempts: generation?.attempts.map((a) => ({ attempt: a.attempt, outcome: a.outcome, issues: a.issues })) ?? [],
      spec: spec ?? null,
      specRevision: revision
        ? {
            revision: revision.revision,
            specHash: revision.specHash,
            inferredDefaults: revision.inferredDefaults,
            resolvedPackages: revision.resolvedPackages,
            packageResolution: revision.packageResolution,
            distroLabel: spec ? getDistroInfo(spec.distro).label : undefined,
          }
        : null,
      attempts: attempts.map((a) => ({
        attemptId: a._id,
        number: a.number,
        status: a.status,
        workflowRunId: a.workflowRunId,
        workflowSha: a.workflowSha,
        builderRevision: a.builderRevision,
        runnerEnvironment: a.runnerEnvironment,
        claimedAt: a.claimedAt,
        finishedAt: a.finishedAt,
        failure: a.failure,
      })),
      artifacts: await artifactSummaries(ctx, build),
    };
  },
});

export const events = query({
  args: { buildId: v.id("builds"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { buildId, paginationOpts }) => {
    await requireOwnedBuild(ctx, buildId);
    return ctx.db
      .query("buildEvents")
      .withIndex("by_build_at", (q) => q.eq("buildId", buildId))
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const logs = query({
  args: { buildId: v.id("builds"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { buildId, paginationOpts }) => {
    await requireOwnedBuild(ctx, buildId);
    const page = await ctx.db
      .query("logBatches")
      .withIndex("by_build_at", (q) => q.eq("buildId", buildId))
      .order("desc")
      .paginate({ ...paginationOpts, numItems: Math.min(paginationOpts.numItems, MAX_LOG_BATCHES_PER_PAGE) });
    return { ...page, page: page.page.map((b) => ({ _id: b._id, attemptId: b.attemptId, seq: b.seq, at: b.at, lines: b.lines })) };
  },
});

export const cancel = mutation({
  args: { buildId: v.id("builds") },
  handler: async (ctx, { buildId }) => {
    const { build } = await requireOwnedBuild(ctx, buildId);
    const updated = await requestCancel(ctx, build, "Cancelled by user");
    return { status: updated.status };
  },
});

/** Starts a new build from a finished one. Builds with an accepted spec reuse the same immutable revision without calling the AI again. */
export const retry = mutation({
  args: { buildId: v.id("builds"), clientRequestId: v.string() },
  handler: async (ctx, { buildId, clientRequestId }) => {
    const { profile, build } = await requireOwnedBuild(ctx, buildId);
    if (!CLIENT_REQUEST_ID.test(clientRequestId)) throw appError("INVALID_REQUEST", "Invalid request id.");
    const existing = await ctx.db
      .query("builds")
      .withIndex("by_owner_client", (q) => q.eq("ownerId", profile._id).eq("clientRequestId", clientRequestId))
      .unique();
    if (existing) return { buildId: existing._id };
    if (!TERMINAL_BUILD_STATUSES.includes(build.status)) throw appError("INVALID_STATE", "Only finished builds can be retried.");

    if (!build.specRevisionId) {
      const request = build.generationRequestId ? await ctx.db.get(build.generationRequestId) : null;
      if (!request) throw appError("INVALID_STATE", "The original request is unavailable.");
      const newId = await startGeneration(ctx, profile, {
        prompt: request.prompt,
        clientRequestId,
        preferences: request.preferences,
        projectId: build.projectId,
        retryOfBuildId: build._id,
      });
      return { buildId: newId };
    }

    const settings = await getSettings(ctx);
    if ((await unfinishedBuilds(ctx, profile._id, settings.maxPendingBuildsPerUser)).length >= settings.maxPendingBuildsPerUser) {
      throw appError("QUOTA_EXCEEDED", "Wait for an unfinished build to complete before retrying.");
    }
    const now = Date.now();
    const newId = await ctx.db.insert("builds", {
      ownerId: profile._id,
      projectId: build.projectId,
      generationRequestId: build.generationRequestId,
      specRevisionId: build.specRevisionId,
      retryOfBuildId: build._id,
      clientRequestId,
      title: build.title,
      status: "queued",
      statusChangedAt: now,
      requestedOutputs: build.requestedOutputs,
      outputResults: build.requestedOutputs.map((output) => ({ output, status: "pending" as const })),
      attemptCount: 0,
      eventCount: 0,
      queuedAt: now,
      createdAt: now,
    });
    await ctx.db.patch(build.projectId, { latestBuildId: newId, updatedAt: now });
    const created = (await ctx.db.get(newId))!;
    await appendEvent(ctx, created, { level: "info", message: "Retry queued with the same configuration revision.", stage: "queued" });
    await ctx.scheduler.runAfter(0, internal.orchestrator.tick, {});
    return { buildId: newId };
  },
});

import { v } from "convex/values";
import {
  aiResponseJsonSchema,
  buildPreferencesSchema,
  canonicalJson,
  getDistroInfo,
  PROVIDER_CATALOG,
  resolveSpecDefaults,
  SPEC_LIMITS,
  withResolvedDefaults,
  type BuildSpec,
  type ResolvedBuildSpec,
} from "@linxgen/spec";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, type ActionCtx, type MutationCtx } from "./_generated/server";
import { appError, requireMember } from "./lib/access";
import { appendEvent, failBuild, recordOpsError, transitionBuild, unfinishedBuilds } from "./lib/buildOps";
import { credentialKeyring, packageResolutionMode, platformAi, TIMING } from "./lib/config";
import { decryptSecret, sha256Hex } from "./lib/crypto";
import { runGenerationLoop, type GenerationOutcome } from "./lib/generationLoop";
import { resolvePackagesInArchive, type PackageResolution } from "./lib/packages";
import { chatJson } from "./lib/providers";
import { getSettings } from "./lib/settings";
import { connectionAad } from "./providers";

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_MS = 24 * 60 * 60_000;

function projectNameFromPrompt(prompt: string) {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine || "Untitled system";
}

async function resolveProviderSelection(ctx: MutationCtx, profile: Doc<"profiles">) {
  const selection = profile.aiSelection ?? { source: "platform" as const };
  if (selection.source === "personal") {
    const conn = await ctx.db.get(selection.connectionId);
    if (!conn || conn.ownerId !== profile._id) {
      throw appError("PROVIDER_MISSING", "Your selected AI connection no longer exists. Choose another in Settings.");
    }
    return { source: "personal" as const, connectionId: conn._id, kind: conn.provider, model: conn.model };
  }
  const platform = platformAi();
  return { source: "platform" as const, kind: platform.provider, model: platform.model };
}

async function enforceSubmissionQuotas(ctx: MutationCtx, profile: Doc<"profiles">, providerSource: "platform" | "personal") {
  const settings = await getSettings(ctx);
  const pending = (await unfinishedBuilds(ctx, profile._id, settings.maxPendingBuildsPerUser)).length;
  if (pending >= settings.maxPendingBuildsPerUser) {
    throw appError(
      "QUOTA_EXCEEDED",
      `You already have ${pending} unfinished builds. Wait for one to finish or cancel it before starting another.`,
    );
  }
  if (providerSource === "platform") {
    const used = (
      await ctx.db
        .query("usageRecords")
        .withIndex("by_owner_kind_at", (q) => q.eq("ownerId", profile._id).eq("kind", "ai_generation").gt("at", Date.now() - DAY_MS))
        .collect()
    ).filter((u) => u.providerSource === "platform").length;
    if (used >= settings.platformGenerationsPerDay) {
      throw appError(
        "QUOTA_EXCEEDED",
        "You have used today's platform AI generations. Connect your own provider in Settings or try again tomorrow.",
      );
    }
  }
}

export async function startGeneration(
  ctx: MutationCtx,
  profile: Doc<"profiles">,
  args: { prompt: string; clientRequestId: string; preferences?: unknown; projectId?: Id<"projects">; retryOfBuildId?: Id<"builds"> },
) {
  const provider = await resolveProviderSelection(ctx, profile);
  await enforceSubmissionQuotas(ctx, profile, provider.source);
  const now = Date.now();
  let projectId = args.projectId;
  if (projectId) {
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== profile._id) throw appError("NOT_FOUND", "Project not found.");
  } else {
    projectId = await ctx.db.insert("projects", {
      ownerId: profile._id,
      name: projectNameFromPrompt(args.prompt),
      createdAt: now,
      updatedAt: now,
    });
  }
  const buildId = await ctx.db.insert("builds", {
    ownerId: profile._id,
    projectId,
    clientRequestId: args.clientRequestId,
    retryOfBuildId: args.retryOfBuildId,
    title: projectNameFromPrompt(args.prompt),
    status: "generating",
    statusChangedAt: now,
    requestedOutputs: [],
    outputResults: [],
    attemptCount: 0,
    eventCount: 0,
    createdAt: now,
  });
  const generationRequestId = await ctx.db.insert("generationRequests", {
    ownerId: profile._id,
    projectId,
    buildId,
    clientRequestId: args.clientRequestId,
    prompt: args.prompt,
    preferences: args.preferences,
    provider,
    status: "pending",
    attempts: [],
    createdAt: now,
  });
  await ctx.db.patch(buildId, { generationRequestId });
  await ctx.db.patch(projectId, { latestBuildId: buildId, updatedAt: now });
  await ctx.db.insert("usageRecords", {
    ownerId: profile._id,
    buildId,
    kind: "ai_generation",
    providerSource: provider.source,
    provider: provider.kind,
    model: provider.model,
    modelCalls: 0,
    at: now,
  });
  const build = (await ctx.db.get(buildId))!;
  await appendEvent(ctx, build, {
    level: "info",
    message: `Request received. Generating configuration with ${PROVIDER_CATALOG[provider.kind].label} (${provider.model}${provider.source === "platform" ? ", platform default" : ""}).`,
    stage: "generating",
  });
  await ctx.scheduler.runAfter(0, internal.generation.run, { generationRequestId });
  return buildId;
}

/** Saves the request and starts generation in the background. Repeated submissions with the same clientRequestId return the same build. */
export const submit = mutation({
  args: {
    prompt: v.string(),
    clientRequestId: v.string(),
    preferences: v.optional(v.any()),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const profile = await requireMember(ctx);
    if (!CLIENT_REQUEST_ID.test(args.clientRequestId)) throw appError("INVALID_REQUEST", "Invalid request id.");
    const existing = await ctx.db
      .query("builds")
      .withIndex("by_owner_client", (q) => q.eq("ownerId", profile._id).eq("clientRequestId", args.clientRequestId))
      .unique();
    if (existing) return { buildId: existing._id, deduplicated: true };

    const prompt = args.prompt.trim();
    if (prompt.length < 3) throw appError("INVALID_PROMPT", "Describe the system you want to build.");
    if (prompt.length > SPEC_LIMITS.maxPromptLength) {
      throw appError("INVALID_PROMPT", `Keep the description under ${SPEC_LIMITS.maxPromptLength} characters.`);
    }
    let preferences: unknown = undefined;
    if (args.preferences !== undefined && args.preferences !== null) {
      const parsed = buildPreferencesSchema.safeParse(args.preferences);
      if (!parsed.success) throw appError("INVALID_PREFERENCES", "Advanced defaults are invalid.");
      preferences = Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
    }
    const buildId = await startGeneration(ctx, profile, {
      prompt,
      clientRequestId: args.clientRequestId,
      preferences,
      projectId: args.projectId,
    });
    return { buildId, deduplicated: false };
  },
});

export const loadContext = internalQuery({
  args: { generationRequestId: v.id("generationRequests") },
  handler: async (ctx, { generationRequestId }) => {
    const request = await ctx.db.get(generationRequestId);
    if (!request) return null;
    const build = await ctx.db.get(request.buildId);
    const connection = request.provider.connectionId ? await ctx.db.get(request.provider.connectionId) : null;
    return {
      request,
      buildStatus: build?.status,
      connection: connection && connection.ownerId === request.ownerId ? connection : null,
    };
  },
});

export const claimRequest = internalMutation({
  args: { generationRequestId: v.id("generationRequests") },
  handler: async (ctx, { generationRequestId }) => {
    const request = await ctx.db.get(generationRequestId);
    if (!request || request.status !== "pending") return false;
    const build = await ctx.db.get(request.buildId);
    if (!build || build.status !== "generating") return false;
    await ctx.db.patch(generationRequestId, { status: "running" });
    return true;
  },
});

/** Moves between generating and validating while the loop runs. Returns false if the build was cancelled. */
export const setPhase = internalMutation({
  args: { buildId: v.id("builds"), phase: v.union(v.literal("generating"), v.literal("validating")), attempt: v.number() },
  handler: async (ctx, { buildId, phase, attempt }) => {
    const build = await ctx.db.get(buildId);
    if (!build || (build.status !== "generating" && build.status !== "validating")) return false;
    if (build.status !== phase) {
      await transitionBuild(ctx, buildId, phase, {}, {
        message: phase === "validating" ? "Validating generated configuration" : `Regenerating configuration (attempt ${attempt})`,
      });
    }
    return true;
  },
});

export const getCachedPackages = internalQuery({
  args: { distroKey: v.string(), names: v.array(v.string()) },
  handler: async (ctx, { distroKey, names }) => {
    const now = Date.now();
    const out: { name: string; exists: boolean; version?: string; component?: string }[] = [];
    for (const name of names) {
      const row = await ctx.db
        .query("packageCache")
        .withIndex("by_distro_name", (q) => q.eq("distroKey", distroKey).eq("name", name))
        .unique();
      const ttl = row?.exists ? DAY_MS : 60 * 60_000;
      if (row && now - row.checkedAt < ttl) out.push({ name, exists: row.exists, version: row.version, component: row.component });
    }
    return out;
  },
});

export const storeCachedPackages = internalMutation({
  args: {
    distroKey: v.string(),
    entries: v.array(v.object({ name: v.string(), exists: v.boolean(), version: v.optional(v.string()), component: v.optional(v.string()) })),
  },
  handler: async (ctx, { distroKey, entries }) => {
    const now = Date.now();
    for (const e of entries) {
      const row = await ctx.db
        .query("packageCache")
        .withIndex("by_distro_name", (q) => q.eq("distroKey", distroKey).eq("name", e.name))
        .unique();
      if (row) await ctx.db.patch(row._id, { ...e, checkedAt: now });
      else await ctx.db.insert("packageCache", { distroKey, ...e, checkedAt: now });
    }
  },
});

async function resolveWithCache(ctx: ActionCtx, spec: BuildSpec): Promise<PackageResolution | null> {
  if (packageResolutionMode() === "runner-only") return null;
  const info = getDistroInfo(spec.distro);
  const distroKey = `${info.family}-${info.release}`;
  const cached = await ctx.runQuery(internal.generation.getCachedPackages, { distroKey, names: spec.packages });
  const cachedNames = new Set(cached.map((c) => c.name));
  const toFetch = spec.packages.filter((p) => !cachedNames.has(p));
  const fetched = await resolvePackagesInArchive(spec.distro, toFetch);
  if (toFetch.length > 0) {
    await ctx.runMutation(internal.generation.storeCachedPackages, {
      distroKey,
      entries: [
        ...fetched.found.map((f) => ({ name: f.name, exists: true, version: f.version, component: f.component })),
        ...fetched.missing.map((name) => ({ name, exists: false })),
      ],
    });
  }
  const found = [
    ...cached.filter((c) => c.exists).map((c) => ({ name: c.name, version: c.version ?? "unknown", component: c.component ?? "main" })),
    ...fetched.found,
  ];
  const missing = [...cached.filter((c) => !c.exists).map((c) => c.name), ...fetched.missing];
  return { found, missing };
}

export const run = internalAction({
  args: { generationRequestId: v.id("generationRequests") },
  handler: async (ctx, { generationRequestId }) => {
    const context = await ctx.runQuery(internal.generation.loadContext, { generationRequestId });
    if (!context) return;
    if (!(await ctx.runMutation(internal.generation.claimRequest, { generationRequestId }))) return;
    const { request } = context;

    let apiKey: string | undefined;
    try {
      if (request.provider.source === "platform") {
        apiKey = platformAi().apiKey;
        if (!apiKey) throw new Error("The platform AI provider is not configured.");
      } else {
        const conn = context.connection;
        if (!conn) throw new Error("The selected AI connection was deleted.");
        apiKey = await decryptSecret(conn.encryptedKey, connectionAad(conn.ownerId, conn._id, conn.provider), credentialKeyring());
      }
    } catch (e) {
      await ctx.runMutation(internal.generation.complete, {
        generationRequestId,
        outcome: { kind: "failed", code: "provider_error", message: (e as Error).message, attempts: [] },
      });
      return;
    }

    const jsonSchema = aiResponseJsonSchema();
    let outcome: GenerationOutcome;
    try {
      outcome = await runGenerationLoop({
        prompt: request.prompt,
        preferences: request.preferences,
        maxAttempts: TIMING.maxAiAttempts,
        callModel: (messages) =>
          chatJson({ provider: request.provider.kind, apiKey: apiKey!, model: request.provider.model, messages, jsonSchema }),
        resolvePackages: (spec) => resolveWithCache(ctx, spec),
        shouldContinue: (phase, attempt) => ctx.runMutation(internal.generation.setPhase, { buildId: request.buildId, phase, attempt }),
      });
    } catch (e) {
      console.error("generation loop crashed", e);
      outcome = { kind: "failed", code: "generation_failed", message: "Configuration generation failed unexpectedly.", attempts: [] };
    }

    let specHash: string | undefined;
    let resolved: ResolvedBuildSpec | undefined;
    if (outcome.kind === "accepted") {
      resolved = resolveSpecDefaults(outcome.spec);
      specHash = await sha256Hex(canonicalJson(resolved));
    }
    await ctx.runMutation(internal.generation.complete, {
      generationRequestId,
      outcome: outcome as unknown as Record<string, unknown>,
      resolvedSpec: resolved,
      specHash,
      packageResolution: packageResolutionMode(),
    });
  },
});

export const complete = internalMutation({
  args: {
    generationRequestId: v.id("generationRequests"),
    outcome: v.any(),
    resolvedSpec: v.optional(v.any()),
    specHash: v.optional(v.string()),
    packageResolution: v.optional(v.union(v.literal("archive"), v.literal("runner-only"))),
  },
  handler: async (ctx, args) => {
    const outcome = args.outcome as GenerationOutcome;
    const request = await ctx.db.get(args.generationRequestId);
    if (!request) return;
    const now = Date.now();
    const attempts = outcome.attempts ?? [];
    await ctx.db.patch(request._id, {
      attempts,
      status: outcome.kind === "accepted" ? "completed" : outcome.kind === "cancelled" ? "cancelled" : "failed",
      completedAt: now,
    });
    const usage = await ctx.db
      .query("usageRecords")
      .withIndex("by_owner_kind_at", (q) => q.eq("ownerId", request.ownerId).eq("kind", "ai_generation").eq("at", request.createdAt))
      .first();
    if (usage) {
      await ctx.db.patch(usage._id, {
        modelCalls: attempts.length,
        inputTokens: attempts.reduce((s, a) => s + (a.inputTokens ?? 0), 0),
        outputTokens: attempts.reduce((s, a) => s + (a.outputTokens ?? 0), 0),
      });
    }

    const build = await ctx.db.get(request.buildId);
    if (!build || (build.status !== "generating" && build.status !== "validating")) return;

    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "unsupported") {
      await failBuild(
        ctx,
        build._id,
        "unsupported_configuration",
        "This request needs capabilities that LinxGen does not support yet. Nothing was built.",
        { unsupported: outcome.reasons.slice(0, 20) },
      );
      return;
    }
    if (outcome.kind === "failed") {
      if (outcome.code === "generation_failed") await recordOpsError(ctx, "generation", outcome.message, { buildId: build._id });
      await failBuild(ctx, build._id, outcome.code, outcome.message);
      return;
    }

    const spec = args.resolvedSpec as ResolvedBuildSpec;
    if (!spec || !args.specHash) throw new Error("Accepted outcome without a resolved spec");
    if (build.status === "generating") await transitionBuild(ctx, build._id, "validating");
    const previous = await ctx.db
      .query("specRevisions")
      .withIndex("by_project", (q) => q.eq("projectId", request.projectId))
      .order("desc")
      .first();
    const specRevisionId = await ctx.db.insert("specRevisions", {
      ownerId: request.ownerId,
      projectId: request.projectId,
      buildId: build._id,
      revision: (previous?.revision ?? 0) + 1,
      schemaVersion: spec.schemaVersion,
      spec,
      specHash: args.specHash,
      inferredDefaults: withResolvedDefaults(outcome.inferredDefaults, outcome.spec, spec),
      resolvedPackages: outcome.resolvedPackages,
      packageResolution: args.packageResolution ?? "archive",
      createdAt: now,
    });
    const project = await ctx.db.get(request.projectId);
    if (project) await ctx.db.patch(project._id, { name: spec.name, updatedAt: now });
    const info = getDistroInfo(spec.distro);
    await transitionBuild(
      ctx,
      build._id,
      "queued",
      {
        specRevisionId,
        title: spec.name,
        requestedOutputs: spec.outputs,
        outputResults: spec.outputs.map((output) => ({ output, status: "pending" as const })),
        queuedAt: now,
      },
      {
        message: `Configuration accepted: ${info.label}, ${spec.profile} profile, ${spec.packages.length} packages, outputs ${spec.outputs.join(" + ")}. Queued for build.`,
      },
    );
  },
});

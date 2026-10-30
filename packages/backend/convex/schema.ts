import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { ATTEMPT_STATUSES, BUILD_STATUSES, PROVIDER_KINDS } from "@linxgen/spec";

const literals = <T extends readonly string[]>(values: T) =>
  v.union(...values.map((s) => v.literal(s))) as unknown as ReturnType<typeof v.literal<T[number]>>;

export const buildStatus = literals(BUILD_STATUSES);
export const attemptStatus = literals(ATTEMPT_STATUSES);
export const providerKind = literals(PROVIDER_KINDS);
export const outputType = v.union(v.literal("iso"), v.literal("container"));
export const artifactKind = v.union(v.literal("iso"), v.literal("container"), v.literal("log"), v.literal("manifest"));

export const failure = v.object({
  code: v.string(),
  message: v.string(),
});

export const unsupportedReason = v.object({ requirement: v.string(), reason: v.string() });
export const inferredDefault = v.object({ field: v.string(), value: v.string(), reason: v.string() });

export const verification = v.object({
  biosBoot: v.optional(v.union(v.literal("passed"), v.literal("failed"), v.literal("skipped"))),
  uefiBoot: v.optional(v.union(v.literal("passed"), v.literal("failed"), v.literal("skipped"))),
  containerSmoke: v.optional(v.union(v.literal("passed"), v.literal("failed"), v.literal("skipped"))),
  requestedPackagesPresent: v.boolean(),
  details: v.optional(v.string()),
});

export const outputResult = v.object({
  output: outputType,
  status: v.union(v.literal("pending"), v.literal("verified"), v.literal("failed")),
  artifactId: v.optional(v.id("artifacts")),
  manifestArtifactId: v.optional(v.id("artifacts")),
  verification: v.optional(verification),
  installedPackageCount: v.optional(v.number()),
  requestedPackages: v.optional(v.array(v.object({ name: v.string(), version: v.string() }))),
  baseImageDigest: v.optional(v.string()),
  toolchainImageDigest: v.optional(v.string()),
  error: v.optional(v.string()),
});

export const aiSelection = v.union(
  v.object({ source: v.literal("platform") }),
  v.object({ source: v.literal("personal"), connectionId: v.id("providerConnections") }),
);

export default defineSchema({
  profiles: defineTable({
    authUserId: v.string(),
    email: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
    role: v.union(v.literal("member"), v.literal("admin")),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("revoked")),
    invitationId: v.optional(v.id("invitations")),
    aiSelection: v.optional(aiSelection),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_email", ["email"])
    .index("by_status", ["status"]),

  invitations: defineTable({
    email: v.string(),
    role: v.union(v.literal("member"), v.literal("admin")),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("revoked")),
    /** SHA-256 of the normalized one-time code. Invitations created before codes existed have none and cannot be redeemed. */
    codeHash: v.optional(v.string()),
    invitedBy: v.optional(v.id("profiles")),
    acceptedBy: v.optional(v.id("profiles")),
    acceptedAt: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_status", ["status"])
    .index("by_codeHash", ["codeHash"]),

  authAttempts: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_windowStart", ["windowStart"]),

  projects: defineTable({
    ownerId: v.id("profiles"),
    name: v.string(),
    latestBuildId: v.optional(v.id("builds")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner_updated", ["ownerId", "updatedAt"]),

  generationRequests: defineTable({
    ownerId: v.id("profiles"),
    projectId: v.id("projects"),
    buildId: v.id("builds"),
    clientRequestId: v.string(),
    prompt: v.string(),
    preferences: v.optional(v.any()),
    provider: v.object({
      source: v.union(v.literal("platform"), v.literal("personal")),
      connectionId: v.optional(v.id("providerConnections")),
      kind: providerKind,
      model: v.string(),
    }),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
    attempts: v.array(
      v.object({
        attempt: v.number(),
        outcome: v.string(),
        issues: v.array(v.string()),
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
      }),
    ),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_owner_client", ["ownerId", "clientRequestId"]),

  specRevisions: defineTable({
    ownerId: v.id("profiles"),
    projectId: v.id("projects"),
    buildId: v.id("builds"),
    revision: v.number(),
    schemaVersion: v.number(),
    spec: v.any(),
    specHash: v.string(),
    inferredDefaults: v.array(inferredDefault),
    resolvedPackages: v.array(v.object({ name: v.string(), version: v.string(), component: v.string() })),
    packageResolution: v.union(v.literal("archive"), v.literal("runner-only")),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId", "revision"])
    .index("by_build", ["buildId"]),

  builds: defineTable({
    ownerId: v.id("profiles"),
    projectId: v.id("projects"),
    generationRequestId: v.optional(v.id("generationRequests")),
    specRevisionId: v.optional(v.id("specRevisions")),
    retryOfBuildId: v.optional(v.id("builds")),
    clientRequestId: v.string(),
    title: v.string(),
    status: buildStatus,
    statusChangedAt: v.number(),
    requestedOutputs: v.array(outputType),
    outputResults: v.array(outputResult),
    failure: v.optional(failure),
    unsupported: v.optional(v.array(unsupportedReason)),
    currentAttemptId: v.optional(v.id("attempts")),
    attemptCount: v.number(),
    cancelRequestedAt: v.optional(v.number()),
    queuedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    deadlineAt: v.optional(v.number()),
    eventCount: v.number(),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_owner_client", ["ownerId", "clientRequestId"])
    .index("by_status", ["status", "statusChangedAt"])
    .index("by_status_queuedAt", ["status", "queuedAt"])
    .index("by_project", ["projectId"]),

  attempts: defineTable({
    buildId: v.id("builds"),
    ownerId: v.id("profiles"),
    number: v.number(),
    status: attemptStatus,
    capabilityHash: v.optional(v.string()),
    capabilityExpiresAt: v.optional(v.number()),
    workflowRunId: v.optional(v.string()),
    workflowRunAttempt: v.optional(v.number()),
    workflowSha: v.optional(v.string()),
    runnerEnvironment: v.optional(v.string()),
    builderRevision: v.optional(v.string()),
    lastEventSeq: v.number(),
    logBatchCount: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    lastGithubCheckAt: v.optional(v.number()),
    dispatchedAt: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    failure: v.optional(failure),
    createdAt: v.number(),
  })
    .index("by_build", ["buildId", "number"])
    .index("by_status", ["status", "createdAt"]),

  buildEvents: defineTable({
    buildId: v.id("builds"),
    attemptId: v.optional(v.id("attempts")),
    at: v.number(),
    level: v.union(v.literal("info"), v.literal("warning"), v.literal("error")),
    source: v.union(v.literal("system"), v.literal("runner")),
    stage: v.optional(buildStatus),
    output: v.optional(outputType),
    message: v.string(),
  }).index("by_build_at", ["buildId", "at"]),

  logBatches: defineTable({
    buildId: v.id("builds"),
    attemptId: v.id("attempts"),
    seq: v.number(),
    at: v.number(),
    lines: v.array(v.string()),
  })
    .index("by_attempt_seq", ["attemptId", "seq"])
    .index("by_build_at", ["buildId", "at"]),

  uploads: defineTable({
    buildId: v.id("builds"),
    attemptId: v.id("attempts"),
    kind: artifactKind,
    fileName: v.string(),
    sizeBytes: v.number(),
    sha256: v.string(),
    contentType: v.string(),
    storageKey: v.string(),
    r2UploadId: v.string(),
    partSizeBytes: v.number(),
    partCount: v.number(),
    status: v.union(v.literal("uploading"), v.literal("completed"), v.literal("aborted")),
    artifactId: v.optional(v.id("artifacts")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_attempt_kind", ["attemptId", "kind"])
    .index("by_status_created", ["status", "createdAt"]),

  artifacts: defineTable({
    buildId: v.id("builds"),
    ownerId: v.id("profiles"),
    attemptId: v.id("attempts"),
    kind: artifactKind,
    fileName: v.string(),
    format: v.string(),
    contentType: v.string(),
    storageKey: v.string(),
    sizeBytes: v.number(),
    sha256: v.string(),
    verified: v.boolean(),
    verification: v.optional(verification),
    status: v.union(v.literal("available"), v.literal("expired"), v.literal("deleted")),
    expiresAt: v.number(),
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index("by_build", ["buildId"])
    .index("by_owner", ["ownerId", "createdAt"])
    .index("by_status_expires", ["status", "expiresAt"]),

  providerConnections: defineTable({
    ownerId: v.id("profiles"),
    provider: providerKind,
    label: v.string(),
    model: v.string(),
    encryptedKey: v.object({ keyVersion: v.string(), iv: v.string(), ciphertext: v.string() }),
    keyHint: v.string(),
    status: v.union(v.literal("untested"), v.literal("ok"), v.literal("failed")),
    lastTestedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  usageRecords: defineTable({
    ownerId: v.id("profiles"),
    buildId: v.optional(v.id("builds")),
    kind: v.union(v.literal("ai_generation"), v.literal("build_minutes")),
    providerSource: v.optional(v.union(v.literal("platform"), v.literal("personal"))),
    provider: v.optional(providerKind),
    model: v.optional(v.string()),
    modelCalls: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    minutes: v.optional(v.number()),
    at: v.number(),
  }).index("by_owner_kind_at", ["ownerId", "kind", "at"]),

  settings: defineTable({
    key: v.literal("global"),
    maxActiveBuildsPerUser: v.number(),
    maxActiveBuildsGlobal: v.number(),
    maxPendingBuildsPerUser: v.number(),
    buildTimeoutMinutes: v.number(),
    maxArtifactBytes: v.number(),
    maxLogBytes: v.number(),
    artifactRetentionDays: v.number(),
    platformGenerationsPerDay: v.number(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("profiles")),
  }).index("by_key", ["key"]),

  opsErrors: defineTable({
    at: v.number(),
    area: v.union(
      v.literal("dispatch"),
      v.literal("reconcile"),
      v.literal("cleanup"),
      v.literal("generation"),
      v.literal("runner"),
      v.literal("storage"),
    ),
    message: v.string(),
    buildId: v.optional(v.id("builds")),
    attemptId: v.optional(v.id("attempts")),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_at", ["at"])
    .index("by_resolved_at", ["resolvedAt", "at"]),

  packageCache: defineTable({
    distroKey: v.string(),
    name: v.string(),
    exists: v.boolean(),
    version: v.optional(v.string()),
    component: v.optional(v.string()),
    checkedAt: v.number(),
  }).index("by_distro_name", ["distroKey", "name"]),
});

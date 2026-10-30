/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSpecDefaults, type BuildSpec, type FinishRequest } from "@linxgen/spec";
import betterAuthTest from "@convex-dev/better-auth/test";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { issueInvitation } from "../convex/lib/invites";
import schema from "../convex/schema";
import { modules } from "../convex/test.setup";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

const auth = components.betterAuth;

function newTest(): T {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  return t;
}

/** Creates a Better Auth user with a live session, signs in through ensureProfile and redeems an invite code. */
async function addMember(t: T, n: number, opts: { invite?: boolean; role?: "member" | "admin" } = {}) {
  const email = `user${n}@example.com`;
  const now = Date.now();
  const user = (await t.mutation(auth.adapter.create, {
    input: { model: "user", data: { email, emailVerified: false, name: `User ${n}`, createdAt: now, updatedAt: now } },
  })) as { _id: string };
  const session = (await t.mutation(auth.adapter.create, {
    input: { model: "session", data: { userId: user._id, token: `token-${n}`, expiresAt: now + 1e9, createdAt: now, updatedAt: now } },
  })) as { _id: string };
  const as = t.withIdentity({ subject: user._id, sessionId: session._id });
  let profile = await as.mutation(api.profiles.ensureProfile, {});
  if (opts.invite !== false) {
    const { code } = await t.run((ctx) => issueInvitation(ctx, { email, role: opts.role ?? "member" }));
    const accepted = await as.mutation(api.profiles.acceptInvitation, { code });
    if (!accepted.ok) throw new Error(accepted.message);
    profile = accepted.profile;
  }
  return { as, profile, authUserId: user._id, sessionId: session._id };
}

async function markLost(t: T, attemptId: Id<"attempts">, reason: string) {
  const a = (await t.run((ctx) => ctx.db.get(attemptId)))!;
  return t.mutation(internal.orchestrator.markAttemptLostIfUnchanged, {
    attemptId,
    observedStatus: a.status,
    observedLivenessAt: a.lastHeartbeatAt ?? a.claimedAt ?? a.createdAt,
    reason,
  });
}

async function timeOut(t: T, buildId: Id<"builds">) {
  const build = (await t.run((ctx) => ctx.db.get(buildId)))!;
  vi.setSystemTime(build.deadlineAt! + 1);
  return t.mutation(internal.orchestrator.markTimedOut, {
    buildId,
    observedAttemptId: build.currentAttemptId,
    observedDeadlineAt: build.deadlineAt!,
  });
}

const SPEC: BuildSpec = {
  schemaVersion: 1,
  name: "Dev Box",
  distro: { family: "debian", release: "13" },
  architecture: "x86_64",
  profile: "minimal",
  packages: ["git"],
  outputs: ["iso", "container"],
};

let requestCounter = 0;
async function submitAccepted(t: T, as: ReturnType<T["withIdentity"]>, spec: BuildSpec = SPEC) {
  const { buildId } = await as.mutation(api.generation.submit, { prompt: "a dev box", clientRequestId: `req-${++requestCounter}-abcdef` });
  const build = await t.run((ctx) => ctx.db.get(buildId));
  await t.mutation(internal.generation.complete, {
    generationRequestId: build!.generationRequestId!,
    outcome: { kind: "accepted", spec, inferredDefaults: [], resolvedPackages: [{ name: "git", version: "1", component: "main" }], attempts: [] },
    resolvedSpec: resolveSpecDefaults(spec),
    specHash: "0".repeat(64),
    packageResolution: "archive",
  });
  return buildId;
}

async function startRunning(t: T, buildId: Id<"builds">, cap = "cap-hash-1", runId = "1001") {
  await t.mutation(internal.orchestrator.tick, {});
  const build = await t.run((ctx) => ctx.db.get(buildId));
  const attemptId = build!.currentAttemptId!;
  const claim = await t.mutation(internal.runner.claimAttempt, {
    attemptId,
    runId,
    runAttempt: 1,
    workflowSha: "a".repeat(40),
    capabilityHash: cap,
  });
  expect(claim.ok).toBe(true);
  return attemptId;
}

async function upload(t: T, attemptId: Id<"attempts">, cap: string, kind: "iso" | "container" | "log" | "manifest", size = 100) {
  const start = await t.mutation(internal.runner.recordUploadStart, {
    attemptId,
    capabilityHash: cap,
    kind,
    fileName: `out-${kind}.bin`,
    sizeBytes: size,
    sha256: "f".repeat(64),
    contentType: "application/gzip",
    storageKey: `k/${kind}`,
    storageUploadId: `up-${kind}`,
    partSizeBytes: 64,
    partCount: 2,
  });
  if (!start.ok) throw new Error("upload start failed");
  const done = await t.mutation(internal.runner.completeUpload, { attemptId, capabilityHash: cap, uploadId: start.uploadId, actualSizeBytes: size });
  if (!done.ok) throw new Error("upload complete failed");
  return start.uploadId as string;
}

const passIso = { biosBoot: "passed", uefiBoot: "passed", requestedPackagesPresent: true } as const;
const passContainer = { containerSmoke: "passed", requestedPackagesPresent: true } as const;

function finishBody(outputs: FinishRequest["outputs"], status: FinishRequest["status"] = "completed"): FinishRequest {
  return { status, builderRevision: "abcdef1", outputs };
}

describe("membership", () => {
  it("rejects unauthenticated and uninvited users", async () => {
    const t = newTest();
    await expect(t.mutation(api.generation.submit, { prompt: "x box", clientRequestId: "abcdefgh1" })).rejects.toThrow(/Sign in/);
    const { as, profile } = await addMember(t, 1, { invite: false });
    expect(profile.status).toBe("pending");
    await expect(as.mutation(api.generation.submit, { prompt: "x box", clientRequestId: "abcdefgh1" })).rejects.toThrow(/invite-only/);
  });


  it("blocks revoked members and cancels their unfinished builds", async () => {
    const t = newTest();
    const admin = await addMember(t, 1, { role: "admin" });
    const user = await addMember(t, 2);
    const buildId = await submitAccepted(t, user.as);
    await admin.as.mutation(api.admin.setMembership, { profileId: user.profile.profileId as Id<"profiles">, status: "revoked" });
    expect((await t.run((ctx) => ctx.db.get(buildId)))!.status).toBe("cancelled");
    await expect(user.as.query(api.builds.dashboard, {})).rejects.toThrow(/invite-only/);
  });

  it("caps the build timeout below the workflow job timeout", async () => {
    const t = newTest();
    const admin = await addMember(t, 1, { role: "admin" });
    const settings = {
      maxActiveBuildsPerUser: 1,
      maxActiveBuildsGlobal: 2,
      maxPendingBuildsPerUser: 3,
      buildTimeoutMinutes: 331,
      maxArtifactBytes: 1024,
      maxLogBytes: 1024,
      artifactRetentionHours: 24,
      maxStoredBytes: 4096,
      platformGenerationsPerDay: 20,
    };
    await expect(admin.as.mutation(api.admin.updateSettings, settings)).rejects.toThrow(/cannot exceed 330/);
    await admin.as.mutation(api.admin.updateSettings, { ...settings, buildTimeoutMinutes: 330 });
    expect((await admin.as.query(api.admin.getLimits, {})).buildTimeoutMinutes).toBe(330);
  });

  it("validates file retention in hours and the storage budget", async () => {
    const t = newTest();
    const admin = await addMember(t, 1, { role: "admin" });
    const settings = {
      maxActiveBuildsPerUser: 1,
      maxActiveBuildsGlobal: 2,
      maxPendingBuildsPerUser: 3,
      buildTimeoutMinutes: 120,
      maxArtifactBytes: 1024,
      maxLogBytes: 1024,
      artifactRetentionHours: 24,
      maxStoredBytes: 4096,
      platformGenerationsPerDay: 20,
    };
    for (const hours of [0, 169, 1.5]) {
      await expect(admin.as.mutation(api.admin.updateSettings, { ...settings, artifactRetentionHours: hours })).rejects.toThrow(/between 1 and 168 hours|positive integer/);
    }
    await expect(admin.as.mutation(api.admin.updateSettings, { ...settings, maxStoredBytes: 1000 })).rejects.toThrow(/storage budget/);
    await admin.as.mutation(api.admin.updateSettings, { ...settings, artifactRetentionHours: 168 });
    expect(await admin.as.query(api.admin.getLimits, {})).toMatchObject({ artifactRetentionHours: 168, maxStoredBytes: 4096 });
    const overview = await admin.as.query(api.admin.overview, {});
    expect(overview.storage).toEqual({ storedBytes: 0, maxStoredBytes: 4096, files: 0 });
  });

  it("reads settings saved with day-based retention using the hour default", async () => {
    const t = newTest();
    const admin = await addMember(t, 1, { role: "admin" });
    await t.run((ctx) =>
      ctx.db.insert("settings", {
        key: "global",
        maxActiveBuildsPerUser: 1,
        maxActiveBuildsGlobal: 2,
        maxPendingBuildsPerUser: 3,
        buildTimeoutMinutes: 120,
        maxArtifactBytes: 1024,
        maxLogBytes: 1024,
        artifactRetentionDays: 7,
        platformGenerationsPerDay: 20,
        updatedAt: 0,
      }),
    );
    expect(await admin.as.query(api.admin.getLimits, {})).toMatchObject({ artifactRetentionHours: 24, maxStoredBytes: 9 * 1024 ** 3 });
  });

  it("restricts admin functions", async () => {
    const t = newTest();
    const user = await addMember(t, 1);
    await expect(user.as.mutation(api.admin.createInvitation, { email: "x@example.com", role: "member" })).rejects.toThrow(/owner/);
    await expect(user.as.query(api.admin.overview, {})).rejects.toThrow(/Administrator/);
  });
});

describe("submission", () => {
  it("deduplicates repeated submissions", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const a = await as.mutation(api.generation.submit, { prompt: "a box", clientRequestId: "same-request-1" });
    const b = await as.mutation(api.generation.submit, { prompt: "a box", clientRequestId: "same-request-1" });
    expect(b).toEqual({ buildId: a.buildId, deduplicated: true });
    expect(await t.run((ctx) => ctx.db.query("builds").collect())).toHaveLength(1);
    const build = await as.query(api.builds.get, { buildId: a.buildId });
    expect(build.status).toBe("generating");
  });

  it("enforces the unfinished build quota", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    for (let i = 0; i < 3; i++) await as.mutation(api.generation.submit, { prompt: "a box", clientRequestId: `quota-${i}-xxxxx` });
    await expect(as.mutation(api.generation.submit, { prompt: "a box", clientRequestId: "quota-3-xxxxx" })).rejects.toThrow(/unfinished builds/);
  });

  it("hides other users' builds and artifacts", async () => {
    const t = newTest();
    const owner = await addMember(t, 1);
    const other = await addMember(t, 2);
    const buildId = await submitAccepted(t, owner.as);
    await expect(other.as.query(api.builds.get, { buildId })).rejects.toThrow(/not found/);
    await expect(other.as.mutation(api.builds.cancel, { buildId })).rejects.toThrow(/not found/);
    const attemptId = await startRunning(t, buildId);
    await upload(t, attemptId, "cap-hash-1", "log");
    const artifact = await t.run((ctx) => ctx.db.query("artifacts").first());
    await expect(other.as.query(internal.artifacts.getForDownload, { artifactId: artifact!._id })).rejects.toThrow(/not found/);
    await expect(owner.as.query(internal.artifacts.getForDownload, { artifactId: artifact!._id })).resolves.toMatchObject({ fileName: "out-log.bin" });
  });

  it("records the hostname, timezone and locale filled at final resolution", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const view = await as.query(api.builds.get, { buildId });
    const fields = view.specRevision?.inferredDefaults.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["hostname", "timezone", "locale"]));
    expect(view.specRevision?.inferredDefaults.find((d) => d.field === "hostname")?.value).toBe(view.spec?.hostname);
  });

  it("fails unsupported requests clearly without building", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const { buildId } = await as.mutation(api.generation.submit, { prompt: "arch arm", clientRequestId: "unsupported-1" });
    const build = await t.run((ctx) => ctx.db.get(buildId));
    await t.mutation(internal.generation.complete, {
      generationRequestId: build!.generationRequestId!,
      outcome: { kind: "unsupported", reasons: [{ requirement: "Architecture aarch64", reason: "Only x86_64 is supported." }], attempts: [] },
    });
    const view = await as.query(api.builds.get, { buildId });
    expect(view.status).toBe("failed");
    expect(view.failure?.code).toBe("unsupported_configuration");
    expect(view.unsupported?.[0]?.requirement).toBe("Architecture aarch64");
    expect(await t.run((ctx) => ctx.db.query("attempts").collect())).toHaveLength(0);
  });
});

describe("scheduling and dispatch claims", () => {
  it("starts at most one build per user and two globally", async () => {
    const t = newTest();
    const u1 = await addMember(t, 1);
    const u2 = await addMember(t, 2);
    const u3 = await addMember(t, 3);
    const a = await submitAccepted(t, u1.as);
    const b = await submitAccepted(t, u1.as);
    const c = await submitAccepted(t, u2.as);
    const d = await submitAccepted(t, u3.as);
    await t.mutation(internal.orchestrator.tick, {});
    await t.mutation(internal.orchestrator.tick, {});
    const statuses = await t.run(async (ctx) => Promise.all([a, b, c, d].map(async (id) => (await ctx.db.get(id))!.status)));
    expect(statuses).toEqual(["preparing", "queued", "preparing", "queued"]);
    expect(await t.run((ctx) => ctx.db.query("attempts").collect())).toHaveLength(2);
  });

  it("rejects claims for stale, re-run, mismatched or cancelled attempts", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap-1", "555");
    const claim = (runId: string, runAttempt = 1) =>
      t.mutation(internal.runner.claimAttempt, { attemptId, runId, runAttempt, workflowSha: "a".repeat(40), capabilityHash: "cap-x" });
    expect(await claim("999")).toMatchObject({ ok: false, error: "stale_attempt" });
    expect(await claim("555", 2)).toMatchObject({ ok: false });

    expect(await markLost(t, attemptId, "Runner vanished.")).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(buildId)))!.status).toBe("queued");
    expect(await claim("555")).toMatchObject({ ok: false, error: "stale_attempt" });

    await t.mutation(internal.orchestrator.tick, {});
    const second = (await t.run((ctx) => ctx.db.get(buildId)))!.currentAttemptId!;
    expect(second).not.toBe(attemptId);
    await as.mutation(api.builds.cancel, { buildId });
    // Unclaimed attempts are cancelled immediately and can no longer be claimed.
    expect((await t.run((ctx) => ctx.db.get(buildId)))!.status).toBe("cancelled");
    const late = await t.mutation(internal.runner.claimAttempt, { attemptId: second, runId: "777", runAttempt: 1, workflowSha: "a".repeat(40), capabilityHash: "c" });
    expect(late.ok).toBe(false);
  });

  it("fails after the bounded number of lost runners", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const first = await startRunning(t, buildId, "c1", "1");
    await markLost(t, first, "Runner vanished.");
    const second = await startRunning(t, buildId, "c2", "2");
    await markLost(t, second, "Runner vanished again.");
    const build = await as.query(api.builds.get, { buildId });
    expect(build.status).toBe("failed");
    expect(build.failure?.code).toBe("runner_lost");
  });
});

describe("runner callbacks", () => {
  it("runs the full lifecycle to success and makes verified artifacts downloadable", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    const ev = (seq: number, stage?: "building" | "verifying" | "uploading") =>
      t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq, stage, events: [], logLines: [`line ${seq}`] });
    expect(await ev(0, "building")).toMatchObject({ ok: true, duplicate: false });
    expect(await ev(0, "building")).toMatchObject({ ok: true, duplicate: true });
    expect((await t.run((ctx) => ctx.db.get(buildId)))!.status).toBe("building");
    await ev(1, "uploading");
    expect((await t.run((ctx) => ctx.db.get(buildId)))!.status).toBe("uploading");

    const iso = await upload(t, attemptId, "cap", "iso");
    const ctr = await upload(t, attemptId, "cap", "container");
    const log = await upload(t, attemptId, "cap", "log");
    const req = [{ name: "git", version: "1:2.47" }];
    const result = await t.mutation(internal.runner.finish, {
      attemptId,
      capabilityHash: "cap",
      body: {
        ...finishBody([
          { output: "iso", status: "verified", artifactUploadId: iso, verification: passIso, installedPackageCount: 400, requestedPackages: req },
          { output: "container", status: "verified", artifactUploadId: ctr, verification: passContainer, installedPackageCount: 120, requestedPackages: req },
        ]),
        logUploadId: log,
      },
    });
    expect(result).toMatchObject({ ok: true, buildStatus: "succeeded" });
    const view = await as.query(api.builds.get, { buildId });
    expect(view.artifacts.filter((a) => a.downloadable).map((a) => a.kind).sort()).toEqual(["container", "iso", "log"]);
    const logs = await as.query(api.builds.logs, { buildId, paginationOpts: { numItems: 10, cursor: null } });
    expect(logs.page.flatMap((b) => b.lines)).toContain("line 1");

    // Finished attempts cannot report more events, and repeated finish calls are idempotent.
    expect(await ev(5)).toMatchObject({ ok: false, error: "attempt_finished" });
    const again = await t.mutation(internal.runner.finish, { attemptId, capabilityHash: "cap", body: finishBody([]) });
    expect(again).toMatchObject({ ok: true, duplicate: true });
  });

  it("rejects bad capabilities", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "right");
    const r = await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "wrong", seq: 0, events: [], logLines: [] });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("reports partial results accurately", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, stage: "uploading", events: [], logLines: [] });
    const iso = await upload(t, attemptId, "cap", "iso");
    const ctr = await upload(t, attemptId, "cap", "container");
    const result = await t.mutation(internal.runner.finish, {
      attemptId,
      capabilityHash: "cap",
      body: finishBody([
        { output: "iso", status: "verified", artifactUploadId: iso, verification: passIso, installedPackageCount: 1, requestedPackages: [] },
        {
          output: "container",
          status: "failed",
          artifactUploadId: ctr,
          verification: { containerSmoke: "failed", requestedPackagesPresent: true },
          installedPackageCount: 1,
          requestedPackages: [],
          error: "smoke test failed",
        },
      ]),
    });
    expect(result).toMatchObject({ buildStatus: "failed" });
    const view = await as.query(api.builds.get, { buildId });
    expect(view.failure?.code).toBe("partial_outputs");
    expect(view.outputResults.map((r) => r.status)).toEqual(["verified", "failed"]);
    const byKind = Object.fromEntries(view.artifacts.map((a) => [a.kind, a.downloadable]));
    expect(byKind).toEqual({ iso: true, container: false });
  });

  it("does not trust a verified claim without boot tests or uploads", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as, { ...SPEC, outputs: ["iso"] });
    const attemptId = await startRunning(t, buildId, "cap");
    await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, stage: "uploading", events: [], logLines: [] });
    const result = await t.mutation(internal.runner.finish, {
      attemptId,
      capabilityHash: "cap",
      body: finishBody([
        { output: "iso", status: "verified", verification: { biosBoot: "passed", uefiBoot: "skipped", requestedPackagesPresent: true }, installedPackageCount: 1, requestedPackages: [] },
      ]),
    });
    expect(result).toMatchObject({ buildStatus: "failed" });
  });

  it("rejects success reported before the upload stage", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as, { ...SPEC, outputs: ["container"] });
    const attemptId = await startRunning(t, buildId, "cap");
    const ctr = await upload(t, attemptId, "cap", "container");
    const result = await t.mutation(internal.runner.finish, {
      attemptId,
      capabilityHash: "cap",
      body: finishBody([{ output: "container", status: "verified", artifactUploadId: ctr, verification: passContainer, installedPackageCount: 1, requestedPackages: [] }]),
    });
    expect(result).toMatchObject({ buildStatus: "failed" });
    expect((await as.query(api.builds.get, { buildId })).failure?.code).toBe("internal_error");
  });

  it("propagates cancellation to the runner and finalizes it", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    await as.mutation(api.builds.cancel, { buildId });
    const r = await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, events: [], logLines: [] });
    expect(r).toMatchObject({ ok: true, cancelRequested: true });
    await t.mutation(internal.runner.finish, { attemptId, capabilityHash: "cap", body: finishBody([], "cancelled") });
    expect((await as.query(api.builds.get, { buildId })).status).toBe("cancelled");
  });

  it("times out builds past their deadline", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    await startRunning(t, buildId);
    expect(await timeOut(t, buildId)).toMatchObject({ timedOut: true });
    expect((await as.query(api.builds.get, { buildId })).status).toBe("timed_out");
  });
});

describe("retry", () => {
  it("reuses the immutable spec revision without calling the AI", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    await startRunning(t, buildId);
    expect(await timeOut(t, buildId)).toMatchObject({ timedOut: true });
    const { buildId: retryId } = await as.mutation(api.builds.retry, { buildId, clientRequestId: "retry-abcdef" });
    const [orig, retry] = await t.run(async (ctx) => [await ctx.db.get(buildId), await ctx.db.get(retryId)]);
    expect(retry!.status).toBe("queued");
    expect(retry!.specRevisionId).toBe(orig!.specRevisionId);
    expect(retry!.retryOfBuildId).toBe(buildId);
    const again = await as.mutation(api.builds.retry, { buildId, clientRequestId: "retry-abcdef" });
    expect(again.buildId).toBe(retryId);
  });
});

describe("session validation", () => {
  it("ends access when the Better Auth session behind a still-valid token is deleted", async () => {
    const t = newTest();
    const { as, sessionId } = await addMember(t, 1);
    await expect(as.query(api.builds.dashboard, {})).resolves.toBeDefined();
    await t.mutation(auth.adapter.deleteOne, { input: { model: "session", where: [{ field: "_id", value: sessionId }] } });
    expect(await as.query(api.profiles.viewer, {})).toBeNull();
    await expect(as.query(api.builds.dashboard, {})).rejects.toThrow(/Sign in/);
    await expect(as.mutation(api.generation.submit, { prompt: "x box", clientRequestId: "after-signout" })).rejects.toThrow(/Sign in/);
    await expect(as.mutation(api.profiles.ensureProfile, {})).rejects.toThrow(/session has ended/);
  });

  it("ends access when the session expires", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    vi.setSystemTime(Date.now() + 2e9);
    await expect(as.query(api.builds.dashboard, {})).rejects.toThrow(/Sign in/);
  });
});

describe("unfinished build enumeration", () => {
  it("counts unfinished builds older than the newest 50 for quotas and revocation", async () => {
    const t = newTest();
    const admin = await addMember(t, 1, { role: "admin" });
    const user = await addMember(t, 2);
    const old = await submitAccepted(t, user.as);
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = (await ctx.db.get(old))!;
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("builds", { ...rest, status: "cancelled", currentAttemptId: undefined, clientRequestId: `filler-${i}-abcdef` });
      }
    });
    await user.as.mutation(api.generation.submit, { prompt: "a box", clientRequestId: "after-1-abcdef" });
    await user.as.mutation(api.generation.submit, { prompt: "a box", clientRequestId: "after-2-abcdef" });
    await expect(user.as.mutation(api.generation.submit, { prompt: "a box", clientRequestId: "after-3-abcdef" })).rejects.toThrow(
      /unfinished builds/,
    );

    await admin.as.mutation(api.admin.setMembership, { profileId: user.profile.profileId as Id<"profiles">, status: "revoked" });
    expect((await t.run((ctx) => ctx.db.get(old)))!.status).toBe("cancelled");
  });
});

describe("AI provider selection", () => {
  it("keeps a deleted personal selection visible and never falls back to the platform", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    const ownerId = profile.profileId as Id<"profiles">;
    const connectionId = await t.run((ctx) =>
      ctx.db.insert("providerConnections", {
        ownerId,
        provider: "openai",
        label: "Mine",
        model: "gpt-test",
        keyHint: "…abcd",
        encryptedKey: { keyVersion: "v1", iv: "iv", ciphertext: "ct" },
        status: "ok",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await as.mutation(api.providers.setAiSelection, { source: "personal", connectionId });
    expect(await as.query(api.profiles.viewer, {})).toMatchObject({ aiSelectionMissing: false });
    await as.mutation(api.providers.deleteConnection, { connectionId });
    expect(await as.query(api.profiles.viewer, {})).toMatchObject({ aiSelection: { source: "personal", connectionId }, aiSelectionMissing: true });
    await expect(as.mutation(api.generation.submit, { prompt: "a box", clientRequestId: "missing-provider" })).rejects.toThrow(/no longer exists/);
    expect(await t.run((ctx) => ctx.db.query("builds").collect())).toHaveLength(0);
    await as.mutation(api.providers.setAiSelection, { source: "platform" });
    expect(await as.query(api.profiles.viewer, {})).toMatchObject({ aiSelection: { source: "platform" }, aiSelectionMissing: false });
  });
});

describe("runner log limits", () => {
  it("rejects a log batch over the byte budget without storing it", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    const logLines = Array.from({ length: 100 }, () => "€".repeat(4000));
    const r = await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, events: [], logLines });
    expect(r).toMatchObject({ ok: false, status: 413, error: "log_batch_too_large" });
    expect(await t.run((ctx) => ctx.db.query("logBatches").collect())).toHaveLength(0);
  });

  it("prunes the oldest batches beyond the per-attempt cap", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    for (let seq = 0; seq < 303; seq++) {
      await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq, events: [], logLines: [`line ${seq}`] });
    }
    const batches = await t.run((ctx) => ctx.db.query("logBatches").collect());
    expect(batches).toHaveLength(300);
    expect(Math.min(...batches.map((b) => b.seq))).toBe(3);
    expect((await t.run((ctx) => ctx.db.get(attemptId)))!.logBatchCount).toBe(300);
  });
});

describe("failure classification", () => {
  it("keeps an explicit runner failure even when every image was verified", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, stage: "uploading", events: [], logLines: [] });
    const iso = await upload(t, attemptId, "cap", "iso");
    const ctr = await upload(t, attemptId, "cap", "container");
    const result = await t.mutation(internal.runner.finish, {
      attemptId,
      capabilityHash: "cap",
      body: {
        ...finishBody(
          [
            { output: "iso", status: "verified", artifactUploadId: iso, verification: passIso, installedPackageCount: 1, requestedPackages: [] },
            { output: "container", status: "verified", artifactUploadId: ctr, verification: passContainer, installedPackageCount: 1, requestedPackages: [] },
          ],
          "failed",
        ),
        failure: { code: "timed_out", message: "The build exceeded its time limit." },
      },
    });
    expect(result).toMatchObject({ ok: true });
    const view = await as.query(api.builds.get, { buildId });
    expect(view.status).toBe("timed_out");
    expect(view.failure?.code).toBe("timed_out");
  });

  it("uses the runner's failure code when nothing could be delivered", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as, { ...SPEC, outputs: ["container"] });
    const attemptId = await startRunning(t, buildId, "cap");
    await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, stage: "uploading", events: [], logLines: [] });
    await t.mutation(internal.runner.finish, {
      attemptId,
      capabilityHash: "cap",
      body: {
        ...finishBody(
          [{ output: "container", status: "failed", verification: passContainer, installedPackageCount: 1, requestedPackages: [], error: "Upload failed: x" }],
          "failed",
        ),
        failure: { code: "upload_failed", message: "Upload failed: x" },
      },
    });
    expect((await as.query(api.builds.get, { buildId })).failure?.code).toBe("upload_failed");
  });
});

describe("reconciliation guards", () => {
  it("does not mark an attempt lost after it reported since the reconciler looked", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    const observed = (await t.run((ctx) => ctx.db.get(attemptId)))!;
    vi.advanceTimersByTime(5_000);
    await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, events: [], logLines: [] });
    const marked = await t.mutation(internal.orchestrator.markAttemptLostIfUnchanged, {
      attemptId,
      observedStatus: observed.status,
      observedLivenessAt: observed.lastHeartbeatAt ?? observed.claimedAt ?? observed.createdAt,
      reason: "Runner vanished.",
    });
    expect(marked).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(attemptId)))!.status).toBe("running");
  });

  it("does not mark an attempt lost after it was claimed since the reconciler looked", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    await t.mutation(internal.orchestrator.tick, {});
    const attemptId = (await t.run((ctx) => ctx.db.get(buildId)))!.currentAttemptId!;
    const observed = (await t.run((ctx) => ctx.db.get(attemptId)))!;
    await t.mutation(internal.runner.claimAttempt, { attemptId, runId: "9", runAttempt: 1, workflowSha: "a".repeat(40), capabilityHash: "cap" });
    const marked = await t.mutation(internal.orchestrator.markAttemptLostIfUnchanged, {
      attemptId,
      observedStatus: observed.status,
      observedLivenessAt: observed.lastHeartbeatAt ?? observed.claimedAt ?? observed.createdAt,
      reason: "No runner became available in time.",
    });
    expect(marked).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(attemptId)))!.status).toBe("running");
  });

  it("does not time out a build before its deadline or after it moved to a new attempt", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const first = await startRunning(t, buildId, "c1", "1");
    const before = (await t.run((ctx) => ctx.db.get(buildId)))!;
    expect(
      await t.mutation(internal.orchestrator.markTimedOut, { buildId, observedAttemptId: first, observedDeadlineAt: before.deadlineAt! }),
    ).toEqual({ timedOut: false, attemptId: null });

    await markLost(t, first, "Runner vanished.");
    const second = await startRunning(t, buildId, "c2", "2");
    vi.setSystemTime(before.deadlineAt! + 1);
    expect(
      await t.mutation(internal.orchestrator.markTimedOut, { buildId, observedAttemptId: first, observedDeadlineAt: before.deadlineAt! }),
    ).toEqual({ timedOut: false, attemptId: null });
    const build = (await t.run((ctx) => ctx.db.get(buildId)))!;
    expect(build.currentAttemptId).toBe(second);
    expect(build.status).not.toBe("timed_out");
  });
});

const STORAGE_APP_ENV = {
  STORAGE_GITHUB_APP_ID: "789",
  STORAGE_GITHUB_APP_SLUG: "linxgen-storage",
  STORAGE_GITHUB_APP_CLIENT_ID: "Iv1.clientid",
  STORAGE_GITHUB_APP_CLIENT_SECRET: "client-secret-value",
  STORAGE_GITHUB_APP_PRIVATE_KEY: "",
};

async function withStorageApp() {
  if (!STORAGE_APP_ENV.STORAGE_GITHUB_APP_PRIVATE_KEY) {
    const { generateKeyPairSync } = await import("node:crypto");
    STORAGE_APP_ENV.STORAGE_GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
  }
  Object.assign(process.env, STORAGE_APP_ENV);
}

function withoutStorageApp() {
  for (const k of Object.keys(STORAGE_APP_ENV)) delete process.env[k];
}

async function connectGitHub(t: T, profileId: Id<"profiles">, opts: { autoSave?: boolean } = {}) {
  return t.run((ctx) =>
    ctx.db.insert("githubConnections", {
      profileId,
      githubUserId: 42,
      login: "octo",
      installationId: 3,
      repoId: 7,
      repoOwner: "octo",
      repoName: "storage",
      repoUrl: "https://github.com/octo/storage",
      autoSave: opts.autoSave ?? false,
      status: "connected",
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** Runs a build to success with a verified ISO and container, their manifests and a log. */
async function succeededBuild(t: T, as: ReturnType<T["withIdentity"]>, cap = "cap") {
  const buildId = await submitAccepted(t, as);
  const attemptId = await startRunning(t, buildId, cap, `run-${cap}`);
  await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: cap, seq: 0, stage: "uploading", events: [], logLines: [] });
  const iso = await upload(t, attemptId, cap, "iso");
  const ctr = await upload(t, attemptId, cap, "container");
  const manifest = await upload(t, attemptId, cap, "manifest");
  const log = await upload(t, attemptId, cap, "log");
  const result = await t.mutation(internal.runner.finish, {
    attemptId,
    capabilityHash: cap,
    body: {
      ...finishBody([
        { output: "iso", status: "verified", artifactUploadId: iso, manifestUploadId: manifest, verification: passIso, installedPackageCount: 1, requestedPackages: [] },
        { output: "container", status: "verified", artifactUploadId: ctr, verification: passContainer, installedPackageCount: 1, requestedPackages: [] },
      ]),
      logUploadId: log,
    },
  });
  expect(result).toMatchObject({ buildStatus: "succeeded" });
  return { buildId, attemptId };
}

async function claimSave(t: T, saveId: Id<"saves">, cap = "save-cap", runId = "9001") {
  await t.mutation(internal.saves.tick, {});
  const save = (await t.run((ctx) => ctx.db.get(saveId)))!;
  const saveAttemptId = save.currentAttemptId!;
  const claim = await t.mutation(internal.saves.claimAttempt, {
    saveAttemptId,
    runId,
    runAttempt: 1,
    workflowSha: "b".repeat(40),
    capabilityHash: cap,
  });
  return { saveAttemptId, claim };
}

describe("temporary storage budget and retention", () => {
  it("refuses uploads that would exceed the storage budget", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    await t.run((ctx) =>
      ctx.db.insert("settings", {
        key: "global",
        maxActiveBuildsPerUser: 1,
        maxActiveBuildsGlobal: 2,
        maxPendingBuildsPerUser: 3,
        buildTimeoutMinutes: 120,
        maxArtifactBytes: 100,
        maxLogBytes: 100,
        artifactRetentionHours: 24,
        maxStoredBytes: 150,
        platformGenerationsPerDay: 20,
        updatedAt: 0,
      }),
    );
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    await upload(t, attemptId, "cap", "iso");
    const refused = await t.mutation(internal.runner.recordUploadStart, {
      attemptId,
      capabilityHash: "cap",
      kind: "container",
      fileName: "out-container.bin",
      sizeBytes: 100,
      sha256: "f".repeat(64),
      contentType: "application/gzip",
      storageKey: "k/container",
      storageUploadId: "up-container",
      partSizeBytes: 64,
      partCount: 2,
    });
    expect(refused).toEqual({ ok: false, status: 409, error: "storage_full" });
    const context = await t.query(internal.runner.capabilityContext, { attemptId, capabilityHash: "cap" });
    expect(context).toMatchObject({ ok: true, storedBytes: 100, maxStoredBytes: 150 });

    await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, stage: "uploading", events: [], logLines: [] });
    await t.mutation(internal.runner.finish, {
      attemptId,
      capabilityHash: "cap",
      body: {
        ...finishBody([{ output: "container", status: "failed", verification: passContainer, installedPackageCount: 1, requestedPackages: [], error: "storage full" }], "failed"),
        failure: { code: "storage_full", message: "Temporary storage is full; try again after older builds expire." },
      },
    });
    expect((await as.query(api.builds.get, { buildId })).failure).toEqual({
      code: "storage_full",
      message: "Temporary storage is full; try again after older builds expire.",
    });
  });

  it("keeps files for the retention period counted from when the build finished", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const buildId = await submitAccepted(t, as);
    const attemptId = await startRunning(t, buildId, "cap");
    await t.mutation(internal.runner.recordEvents, { attemptId, capabilityHash: "cap", seq: 0, stage: "uploading", events: [], logLines: [] });
    const iso = await upload(t, attemptId, "cap", "iso");
    const ctr = await upload(t, attemptId, "cap", "container");
    vi.setSystemTime(Date.now() + 90 * 60_000);
    const finishedAt = Date.now();
    await t.mutation(internal.runner.finish, {
      attemptId,
      capabilityHash: "cap",
      body: finishBody([
        { output: "iso", status: "verified", artifactUploadId: iso, verification: passIso, installedPackageCount: 1, requestedPackages: [] },
        { output: "container", status: "verified", artifactUploadId: ctr, verification: passContainer, installedPackageCount: 1, requestedPackages: [] },
      ]),
    });
    const view = await as.query(api.builds.get, { buildId });
    expect(view.artifacts.map((a) => a.expiresAt)).toEqual([finishedAt + 24 * 3600_000, finishedAt + 24 * 3600_000]);
    expect((await as.query(api.builds.dashboard, {})).usage.artifactRetentionHours).toBe(24);
  });

  it("holds expired files while a save is active, for at most six hours", async () => {
    await withStorageApp();
    try {
      const t = newTest();
      const { as, profile } = await addMember(t, 1);
      await connectGitHub(t, profile.profileId as Id<"profiles">);
      const { buildId } = await succeededBuild(t, as);
      await as.mutation(api.saves.request, { buildId });
      const expiresAt = Math.max(...(await as.query(api.builds.get, { buildId })).artifacts.map((a) => a.expiresAt));
      vi.setSystemTime(expiresAt + 1);
      const held = await t.query(internal.maintenance.cleanupCandidates, {});
      // The ISO, container and ISO manifest are part of the save; only the log may go.
      expect(held.held).toBe(3);
      expect(held.expired).toHaveLength(1);
      vi.setSystemTime(expiresAt + 6 * 3600_000 + 1);
      const released = await t.query(internal.maintenance.cleanupCandidates, {});
      expect(released).toMatchObject({ held: 0 });
      expect(released.expired).toHaveLength(4);
    } finally {
      withoutStorageApp();
    }
  });
});

describe("saving builds to GitHub", () => {
  beforeEach(async () => {
    await withStorageApp();
  });
  afterEach(() => {
    withoutStorageApp();
    vi.unstubAllGlobals();
  });

  it("is unavailable when the storage app is not configured", async () => {
    withoutStorageApp();
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const { buildId } = await succeededBuild(t, as);
    expect((await as.query(api.githubStorage.status, {})).configured).toBe(false);
    await expect(as.mutation(api.saves.request, { buildId })).rejects.toThrow(/not set up/);
  });

  it("requires a connection and verified outputs", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    const { buildId } = await succeededBuild(t, as);
    await expect(as.mutation(api.saves.request, { buildId })).rejects.toThrow(/GitHub is not connected/);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const timedOut = await submitAccepted(t, as);
    await startRunning(t, timedOut, "cap2", "run-2");
    await timeOut(t, timedOut);
    await expect(as.mutation(api.saves.request, { buildId: timedOut })).rejects.toThrow(/verified outputs/);
    const other = await addMember(t, 2);
    await expect(other.as.mutation(api.saves.request, { buildId })).rejects.toThrow(/not found/);
  });

  it("runs a save from the queue to a release in the member's repository", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const { buildId } = await succeededBuild(t, as);
    const { saveId } = await as.mutation(api.saves.request, { buildId });
    expect(await as.mutation(api.saves.request, { buildId })).toEqual({ saveId, existing: true });

    const { saveAttemptId, claim } = await claimSave(t, saveId);
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");
    expect(claim.files.map((f) => f.kind)).toEqual(["iso", "manifest", "container"]);
    expect(claim.connection).toEqual({ installationId: 3, repoId: 7, repoOwner: "octo", repoName: "storage" });
    expect(claim.release).toMatchObject({ owner: "octo", repo: "storage", tag: `linxgen-${buildId}` });
    expect(claim.release.body).toContain(claim.release.marker);
    // A second runner for the same attempt is refused.
    const rival = await t.mutation(internal.saves.claimAttempt, { saveAttemptId, runId: "9002", runAttempt: 1, workflowSha: "b".repeat(40), capabilityHash: "x" });
    expect(rival).toMatchObject({ ok: false, error: "stale_attempt" });

    const progress = (seq: number) =>
      t.mutation(internal.saves.recordProgress, {
        saveAttemptId,
        capabilityHash: "save-cap",
        body: { seq, phase: "uploading", doneBytes: 100, totalBytes: 300 },
      });
    expect(await progress(0)).toEqual({ ok: true, cancelRequested: false });
    expect((await as.query(api.saves.forBuild, { buildId })).saves[0]).toMatchObject({
      status: "running",
      progress: { phase: "uploading", doneBytes: 100, totalBytes: 300 },
    });

    const releaseUrl = `https://github.com/octo/storage/releases/tag/linxgen-${buildId}`;
    const done = await t.mutation(internal.saves.finish, {
      saveAttemptId,
      capabilityHash: "save-cap",
      body: { status: "succeeded", releaseUrl, assetCount: 4 },
    });
    expect(done).toMatchObject({ ok: true, saveStatus: "succeeded" });
    const view = await as.query(api.saves.forBuild, { buildId });
    expect(view.saves[0]).toMatchObject({ status: "succeeded", releaseUrl, assetCount: 4 });
    expect(await progress(1)).toMatchObject({ ok: false, error: "attempt_finished" });
  });

  it("ignores release links outside the member's repository", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const { buildId } = await succeededBuild(t, as);
    const { saveId } = await as.mutation(api.saves.request, { buildId });
    const { saveAttemptId } = await claimSave(t, saveId);
    await t.mutation(internal.saves.finish, {
      saveAttemptId,
      capabilityHash: "save-cap",
      body: { status: "succeeded", releaseUrl: "https://evil.example/releases/x", assetCount: 1 },
    });
    const [save] = (await as.query(api.saves.forBuild, { buildId })).saves;
    expect(save?.status).toBe("succeeded");
    expect(save?.releaseUrl).toBeUndefined();
  });

  it("does not accept build capabilities on save routes or save capabilities on build routes", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const { buildId, attemptId } = await succeededBuild(t, as);
    const { saveId } = await as.mutation(api.saves.request, { buildId });
    const { saveAttemptId } = await claimSave(t, saveId, "cap");
    const asSave = await t.mutation(internal.saves.recordProgress, {
      saveAttemptId: attemptId,
      capabilityHash: "cap",
      body: { seq: 0, phase: "downloading", doneBytes: 0, totalBytes: 1 },
    });
    expect(asSave).toMatchObject({ ok: false, status: 401 });
    const asBuild = await t.mutation(internal.runner.recordEvents, { attemptId: saveAttemptId, capabilityHash: "cap", seq: 0, events: [], logLines: [] });
    expect(asBuild).toMatchObject({ ok: false, status: 401 });
  });

  it("runs one save per member at a time", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const first = await succeededBuild(t, as, "c1");
    const second = await succeededBuild(t, as, "c2");
    const a = await as.mutation(api.saves.request, { buildId: first.buildId });
    const b = await as.mutation(api.saves.request, { buildId: second.buildId });
    await t.mutation(internal.saves.tick, {});
    const statuses = await t.run(async (ctx) => [(await ctx.db.get(a.saveId))!.status, (await ctx.db.get(b.saveId))!.status]);
    expect(statuses).toEqual(["dispatched", "queued"]);
  });

  it("retries a lost save runner once, then fails", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const { buildId } = await succeededBuild(t, as);
    const { saveId } = await as.mutation(api.saves.request, { buildId });
    const lose = async (saveAttemptId: Id<"saveAttempts">) => {
      const a = (await t.run((ctx) => ctx.db.get(saveAttemptId)))!;
      return t.mutation(internal.saves.markLostIfUnchanged, {
        saveAttemptId,
        observedStatus: a.status,
        observedLivenessAt: a.lastHeartbeatAt ?? a.claimedAt ?? a.createdAt,
        reason: "The save runner stopped responding.",
      });
    };
    const first = await claimSave(t, saveId, "c1", "1");
    expect(await lose(first.saveAttemptId)).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(saveId)))!.status).toBe("queued");
    const second = await claimSave(t, saveId, "c2", "2");
    expect(second.claim.ok).toBe(true);
    expect(await lose(second.saveAttemptId)).toBe(true);
    expect((await as.query(api.saves.forBuild, { buildId })).saves[0]).toMatchObject({ status: "failed", failure: { code: "runner_lost" } });
    const { saveId: retried } = await as.mutation(api.saves.retry, { saveId });
    expect(retried).not.toBe(saveId);
  });

  it("fails the save and asks to reconnect when GitHub refuses access", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const { buildId } = await succeededBuild(t, as);
    const { saveId } = await as.mutation(api.saves.request, { buildId });
    const { saveAttemptId } = await claimSave(t, saveId);
    await t.mutation(internal.saves.finish, {
      saveAttemptId,
      capabilityHash: "save-cap",
      body: { status: "failed", failure: { code: "github_unauthorized", message: "GitHub returned 401" } },
    });
    expect((await as.query(api.githubStorage.status, {})).connection).toMatchObject({ status: "broken" });
    await expect(as.mutation(api.saves.request, { buildId })).rejects.toThrow(/Reconnect GitHub/);
  });

  it("fails cleanly when the files already left temporary storage", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const { buildId } = await succeededBuild(t, as);
    const { saveId } = await as.mutation(api.saves.request, { buildId });
    const save = (await t.run((ctx) => ctx.db.get(saveId)))!;
    await t.mutation(internal.maintenance.markArtifactExpired, { artifactId: save.artifactIds[0]! });
    const { claim } = await claimSave(t, saveId);
    expect(claim).toMatchObject({ ok: false, error: "storage_expired" });
    expect((await as.query(api.saves.forBuild, { buildId })).saves[0]).toMatchObject({ status: "failed", failure: { code: "storage_expired" } });
  });

  it("saves automatically when the member turned it on", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">, { autoSave: true });
    const { buildId } = await succeededBuild(t, as);
    expect((await as.query(api.saves.forBuild, { buildId })).saves).toMatchObject([{ status: "queued", trigger: "auto" }]);
  });

  it("cancels queued saves and keeps no link after disconnecting", async () => {
    const t = newTest();
    const { as, profile } = await addMember(t, 1);
    await connectGitHub(t, profile.profileId as Id<"profiles">);
    const { buildId } = await succeededBuild(t, as);
    await as.mutation(api.saves.request, { buildId });
    await as.mutation(api.githubStorage.disconnect, {});
    expect((await as.query(api.githubStorage.status, {})).connection).toBeNull();
    expect((await as.query(api.saves.forBuild, { buildId })).saves[0]).toMatchObject({ status: "failed", failure: { code: "not_connected" } });
  });
});

describe("connecting GitHub storage", () => {
  beforeEach(async () => {
    await withStorageApp();
  });
  afterEach(() => {
    withoutStorageApp();
    vi.unstubAllGlobals();
  });

  async function stateFrom(as: ReturnType<T["withIdentity"]>) {
    const started = await as.mutation(api.githubStorage.startConnect, {});
    if (!started.ok) throw new Error(started.message);
    const install = new URL(started.installUrl);
    expect(install.origin + install.pathname).toBe("https://github.com/apps/linxgen-storage/installations/new");
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.searchParams.get("client_id")).toBe("Iv1.clientid");
    expect(authorize.searchParams.get("state")).toBe(install.searchParams.get("state"));
    return install.searchParams.get("state")!;
  }

  it("binds the state to one member, one use and ten minutes", async () => {
    const t = newTest();
    const a = await addMember(t, 1);
    const b = await addMember(t, 2);
    const { sha256Hex } = await import("../convex/lib/crypto");
    const state = await stateFrom(a.as);
    const stateHash = await sha256Hex(state);
    expect(await t.mutation(internal.githubStorage.consumeState, { stateHash, profileId: b.profile.profileId as Id<"profiles"> })).toBe(false);
    expect(await t.mutation(internal.githubStorage.consumeState, { stateHash, profileId: a.profile.profileId as Id<"profiles"> })).toBe(true);
    expect(await t.mutation(internal.githubStorage.consumeState, { stateHash, profileId: a.profile.profileId as Id<"profiles"> })).toBe(false);
    const late = await sha256Hex(await stateFrom(a.as));
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await t.mutation(internal.githubStorage.consumeState, { stateHash: late, profileId: a.profile.profileId as Id<"profiles"> })).toBe(false);
  });

  it("connects with the member's own installation and creates the private repository", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const state = await stateFrom(as);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        calls.push(`${req.method} ${url.host}${url.pathname}`);
        if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
          expect(await req.json()).toMatchObject({ client_id: "Iv1.clientid", client_secret: "client-secret-value", code: "code-123" });
          return Response.json({ access_token: "ghu_usertoken", token_type: "bearer" });
        }
        if (url.pathname === "/user") return Response.json({ id: 42, login: "octo", type: "User" });
        if (url.pathname === "/user/installations") {
          return Response.json({
            installations: [{ id: 3, app_id: 789, target_type: "User", account: { id: 42, login: "octo" }, repository_selection: "all", suspended_at: null }],
          });
        }
        if (url.pathname === "/repos/octo/storage" && req.method === "GET") return Response.json({ message: "Not Found" }, { status: 404 });
        if (url.pathname === "/user/repos") {
          return Response.json(
            { id: 7, name: "storage", full_name: "octo/storage", html_url: "https://github.com/octo/storage", private: true, topics: [], owner: { login: "octo", id: 42 } },
            { status: 201 },
          );
        }
        if (url.pathname === "/repos/octo/storage/topics") return Response.json({ names: ["linxgen-storage"] });
        if (url.pathname === "/app/installations/3/access_tokens") return Response.json({ token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 });
        throw new Error(`unexpected ${req.method} ${req.url}`);
      }),
    );
    const result = await as.action(api.githubStorage.completeConnect, { code: "code-123", state });
    expect(result).toMatchObject({ ok: true, login: "octo", repoFullName: "octo/storage", created: true });
    expect(calls).toContain("POST api.github.com/user/repos");
    const status = await as.query(api.githubStorage.status, {});
    expect(status.connection).toMatchObject({ login: "octo", repoFullName: "octo/storage", status: "connected", autoSave: false });
    expect(JSON.stringify(status)).not.toMatch(/ghu_|ghs_|installation/i);
    const reused = await as.action(api.githubStorage.completeConnect, { code: "code-123", state });
    expect(reused).toMatchObject({ ok: false, code: "invalid_state" });
    await as.mutation(api.githubStorage.setAutoSave, { enabled: true });
    expect((await as.query(api.githubStorage.status, {})).connection?.autoSave).toBe(true);
  });

  it("refuses when the app is only installed on an organization", async () => {
    const t = newTest();
    const { as } = await addMember(t, 1);
    const state = await stateFrom(as);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL((input instanceof Request ? input : new Request(input, init)).url);
        if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "ghu_usertoken" });
        if (url.pathname === "/user") return Response.json({ id: 42, login: "octo", type: "User" });
        if (url.pathname === "/user/installations") {
          return Response.json({
            installations: [{ id: 5, app_id: 789, target_type: "Organization", account: { id: 77, login: "org" }, repository_selection: "all", suspended_at: null }],
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    expect(await as.action(api.githubStorage.completeConnect, { code: "code-123", state })).toMatchObject({ ok: false, code: "not_installed" });
    expect((await as.query(api.githubStorage.status, {})).connection).toBeNull();
  });
});

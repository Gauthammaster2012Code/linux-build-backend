/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSpecDefaults, type BuildSpec, type FinishRequest } from "@linxgen/spec";
import betterAuthTest from "@convex-dev/better-auth/test";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { syncProfile } from "../convex/profiles";
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

/** Creates a Better Auth user with a live session, then signs in through the real ensureProfile path. */
async function addMember(t: T, n: number, opts: { invite?: boolean; verified?: boolean; role?: "member" | "admin" } = {}) {
  const email = `user${n}@example.com`;
  const now = Date.now();
  if (opts.invite !== false) {
    await t.run((ctx) =>
      ctx.db.insert("invitations", { email, role: opts.role ?? "member", status: "pending", createdAt: now, expiresAt: now + 1e9 }),
    );
  }
  const user = (await t.mutation(auth.adapter.create, {
    input: { model: "user", data: { email, emailVerified: opts.verified ?? true, name: `User ${n}`, createdAt: now, updatedAt: now } },
  })) as { _id: string };
  const session = (await t.mutation(auth.adapter.create, {
    input: { model: "session", data: { userId: user._id, token: `token-${n}`, expiresAt: now + 1e9, createdAt: now, updatedAt: now } },
  })) as { _id: string };
  const as = t.withIdentity({ subject: user._id, sessionId: session._id });
  const profile = await as.mutation(api.profiles.ensureProfile, {});
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

async function upload(t: T, attemptId: Id<"attempts">, cap: string, kind: "iso" | "container" | "log", size = 100) {
  const start = await t.mutation(internal.runner.recordUploadStart, {
    attemptId,
    capabilityHash: cap,
    kind,
    fileName: `out-${kind}.bin`,
    sizeBytes: size,
    sha256: "f".repeat(64),
    contentType: "application/gzip",
    storageKey: `k/${kind}`,
    r2UploadId: `r2-${kind}`,
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

  it("requires a verified email to accept an invitation", async () => {
    const t = newTest();
    const { profile, authUserId } = await addMember(t, 1, { verified: false });
    expect(profile.status).toBe("pending");
    const again = await t.run((ctx) => syncProfile(ctx, { authUserId, email: "user1@example.com", emailVerified: true, name: "U" }));
    expect(again.status).toBe("active");
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
      artifactRetentionDays: 7,
      platformGenerationsPerDay: 20,
    };
    await expect(admin.as.mutation(api.admin.updateSettings, settings)).rejects.toThrow(/cannot exceed 330/);
    await admin.as.mutation(api.admin.updateSettings, { ...settings, buildTimeoutMinutes: 330 });
    expect((await admin.as.query(api.admin.getLimits, {})).buildTimeoutMinutes).toBe(330);
  });

  it("restricts admin functions", async () => {
    const t = newTest();
    const user = await addMember(t, 1);
    await expect(user.as.mutation(api.admin.createInvitation, { email: "x@example.com", role: "member" })).rejects.toThrow(/Administrator/);
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

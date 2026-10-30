/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import betterAuthTest from "@convex-dev/better-auth/test";
import { api, components, internal } from "../convex/_generated/api";
import { ATTEMPT_LIMITS } from "../convex/lib/attempts";
import { generateInviteCode, hashInviteCode, issueInvitation, normalizeInviteCode } from "../convex/lib/invites";
import schema from "../convex/schema";
import { modules } from "../convex/test.setup";

type T = ReturnType<typeof convexTest>;

const SITE = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const saved = { SITE_URL: process.env.SITE_URL, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET };

beforeAll(() => {
  process.env.SITE_URL = SITE;
  process.env.BETTER_AUTH_SECRET = "test-secret-".padEnd(48, "x");
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function newTest(): T {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  return t;
}

let ipCounter = 0;
/** Each call gets its own client IP unless one is given, so Better Auth's per-IP limits only trip where a test wants them to. */
async function post(t: T, path: string, body: unknown, ip = `10.0.0.${++ipCounter % 250}`) {
  const res = await t.fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE, "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { code?: string; message?: string; user?: { id: string }; token?: string } | null;
  return { status: res.status, body: json };
}

function signUp(t: T, email: string, inviteCode?: string, ip?: string) {
  return post(t, "/sign-up/email", { name: "New Person", email, password: PASSWORD, ...(inviteCode !== undefined ? { inviteCode } : {}) }, ip);
}

async function findUser(t: T, email: string) {
  return t.query(components.betterAuth.adapter.findOne, { model: "user", where: [{ field: "email", value: email }] });
}

function invite(t: T, email: string, role: "member" | "admin" = "member") {
  return t.run((ctx) => issueInvitation(ctx, { email, role }));
}

/** Signs in through the identity that a sign-up response's session token belongs to. */
async function asSessionOf(t: T, token: string) {
  const session = (await t.query(components.betterAuth.adapter.findOne, {
    model: "session",
    where: [{ field: "token", value: token }],
  })) as { _id: string; userId: string };
  return t.withIdentity({ subject: session.userId, sessionId: session._id });
}

/** A Better Auth user and session created directly, without going through sign-up. */
async function existingUser(t: T, email: string, emailVerified: boolean) {
  const now = Date.now();
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { email, emailVerified, name: "Existing", createdAt: now, updatedAt: now } },
  })) as { _id: string };
  const session = (await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "session", data: { userId: user._id, token: `tok-${email}`, expiresAt: now + 1e9, createdAt: now, updatedAt: now } },
  })) as { _id: string };
  return t.withIdentity({ subject: user._id, sessionId: session._id });
}

describe("invite codes", () => {
  it("are high-entropy, grouped and tolerant of formatting", async () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(generateInviteCode()).not.toBe(code);
    expect(normalizeInviteCode(` ${code.toLowerCase().replace(/-/g, " ")} `)).toBe(code.replace(/-/g, ""));
    expect(normalizeInviteCode("too-short")).toBeNull();
    expect(await hashInviteCode(normalizeInviteCode(code)!)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("are stored only as a hash and returned once", async () => {
    const t = newTest();
    const issued = await invite(t, "a@example.com");
    const stored = await t.run((ctx) => ctx.db.query("invitations").collect());
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain(issued.code);
    expect(raw).not.toContain(issued.code.replace(/-/g, ""));
    expect(stored[0]!.codeHash).toBe(await hashInviteCode(normalizeInviteCode(issued.code)!));
    expect(stored[0]!.expiresAt - stored[0]!.createdAt).toBe(14 * 24 * 60 * 60_000);
  });

  it("are created by admins only, and listing never exposes codes or hashes", async () => {
    const t = newTest();
    const admin = await existingUser(t, "admin@example.com", false);
    await admin.mutation(api.profiles.ensureProfile, {});
    const { code } = await t.mutation(internal.admin.bootstrapAdmin, { email: "admin@example.com" });
    expect((await admin.mutation(api.profiles.acceptInvitation, { code })).ok).toBe(true);
    const created = await admin.mutation(api.admin.createInvitation, { email: " New@Example.com ", role: "member" });
    expect(created).toMatchObject({ email: "new@example.com", role: "member" });
    expect(normalizeInviteCode(created.code)).not.toBeNull();
    const listed = JSON.stringify(await admin.query(api.admin.listInvitations, {}));
    expect(listed).not.toContain("codeHash");
    expect(listed).not.toContain(created.code);
  });
});

describe("sign-up gating", () => {
  it("rejects sign-up without an invite code", async () => {
    const t = newTest();
    await invite(t, "new@example.com");
    const res = await signUp(t, "new@example.com");
    expect(res).toMatchObject({ status: 403, body: { code: "INVITE_CODE_REQUIRED" } });
    expect(await findUser(t, "new@example.com")).toBeNull();
  });

  it("rejects a wrong code, a code for another email, and a malformed code", async () => {
    const t = newTest();
    await invite(t, "new@example.com");
    const other = await invite(t, "other@example.com");
    expect(await signUp(t, "new@example.com", generateInviteCode())).toMatchObject({ status: 403, body: { code: "INVITE_CODE_INVALID" } });
    expect(await signUp(t, "new@example.com", other.code)).toMatchObject({ status: 403, body: { code: "INVITE_CODE_INVALID" } });
    expect(await signUp(t, "new@example.com", "not-a-code")).toMatchObject({ status: 403, body: { code: "INVITE_CODE_INVALID" } });
    expect(await findUser(t, "new@example.com")).toBeNull();
  });

  it("rejects expired and revoked codes", async () => {
    const t = newTest();
    const expired = await invite(t, "late@example.com");
    await t.run((ctx) => ctx.db.patch(expired.invitationId, { expiresAt: Date.now() - 1 }));
    expect(await signUp(t, "late@example.com", expired.code)).toMatchObject({ status: 403, body: { code: "INVITE_CODE_EXPIRED" } });

    const replaced = await invite(t, "new@example.com");
    await invite(t, "new@example.com");
    expect((await t.run((ctx) => ctx.db.get(replaced.invitationId)))!.status).toBe("revoked");
    expect(await signUp(t, "new@example.com", replaced.code)).toMatchObject({ status: 403, body: { code: "INVITE_CODE_INVALID" } });

    const revoked = await invite(t, "gone@example.com");
    await t.run((ctx) => ctx.db.patch(revoked.invitationId, { status: "revoked" }));
    expect(await signUp(t, "gone@example.com", revoked.code)).toMatchObject({ status: 403, body: { code: "INVITE_CODE_INVALID" } });
    expect(await findUser(t, "late@example.com")).toBeNull();
    expect(await findUser(t, "gone@example.com")).toBeNull();
  });

  it("accepts the right code, activates the invitation's role and consumes the code", async () => {
    const t = newTest();
    const { code, invitationId } = await invite(t, "boss@example.com", "admin");
    const res = await signUp(t, "Boss@Example.com", code.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.body?.token).toBeTruthy();
    const as = await asSessionOf(t, res.body!.token!);

    expect(await as.mutation(api.profiles.ensureProfile, {})).toMatchObject({ status: "pending" });
    const accepted = await as.mutation(api.profiles.acceptInvitation, { code });
    expect(accepted).toMatchObject({ ok: true, profile: { status: "active", role: "admin", email: "boss@example.com" } });
    expect(await t.run((ctx) => ctx.db.get(invitationId))).toMatchObject({ status: "accepted" });

    // The code is spent: it cannot create another account or activate anyone else.
    expect(await signUp(t, "boss@example.com", code)).toMatchObject({ status: 403, body: { code: "INVITE_CODE_INVALID" } });
    const other = await existingUser(t, "boss2@example.com", true);
    expect(await other.mutation(api.profiles.acceptInvitation, { code })).toMatchObject({ ok: false, code: "INVITE_CODE_INVALID" });
  });

  it("enforces the password length", async () => {
    const t = newTest();
    const { code } = await invite(t, "new@example.com");
    const res = await post(t, "/sign-up/email", { name: "N", email: "new@example.com", password: "short", inviteCode: code });
    expect(res).toMatchObject({ status: 400, body: { code: "PASSWORD_TOO_SHORT" } });
  });
});

describe("activation", () => {
  it("never activates a profile on sign-in alone, even with a verified email and a pending invitation", async () => {
    const t = newTest();
    await invite(t, "v@example.com");
    const as = await existingUser(t, "v@example.com", true);
    expect(await as.mutation(api.profiles.ensureProfile, {})).toMatchObject({ status: "pending" });
    expect(await as.query(api.profiles.viewer, {})).toMatchObject({ status: "pending" });
  });

  it("lets a pending user redeem a code later and rejects codes for other emails", async () => {
    const t = newTest();
    const as = await existingUser(t, "p@example.com", false);
    await as.mutation(api.profiles.ensureProfile, {});
    const theirs = await invite(t, "p@example.com");
    const someoneElses = await invite(t, "q@example.com");
    expect(await as.mutation(api.profiles.acceptInvitation, { code: someoneElses.code })).toMatchObject({ ok: false, code: "INVITE_CODE_INVALID" });
    expect(await as.mutation(api.profiles.acceptInvitation, { code: theirs.code })).toMatchObject({ ok: true, profile: { status: "active", role: "member" } });
  });

  it("limits invite code redemption attempts per user", async () => {
    const t = newTest();
    const as = await existingUser(t, "p@example.com", false);
    const { code } = await invite(t, "p@example.com");
    for (let i = 0; i < ATTEMPT_LIMITS.inviteRedemption.max; i++) {
      expect(await as.mutation(api.profiles.acceptInvitation, { code: generateInviteCode() })).toMatchObject({ ok: false, code: "INVITE_CODE_INVALID" });
    }
    // Even the right code is refused once the limit is reached.
    expect(await as.mutation(api.profiles.acceptInvitation, { code })).toMatchObject({ ok: false, code: "TOO_MANY_ATTEMPTS" });
    expect(await as.query(api.profiles.viewer, {})).toMatchObject({ status: "pending" });

    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("authAttempts").collect()) {
        await ctx.db.patch(row._id, { windowStart: Date.now() - ATTEMPT_LIMITS.inviteRedemption.windowMs });
      }
    });
    expect(await as.mutation(api.profiles.acceptInvitation, { code })).toMatchObject({ ok: true });
  });

  it("does not let a revoked member back in with a new code", async () => {
    const t = newTest();
    const as = await existingUser(t, "r@example.com", false);
    const profile = await as.mutation(api.profiles.ensureProfile, {});
    await t.run((ctx) => ctx.db.patch(profile.profileId, { status: "revoked" }));
    const { code } = await invite(t, "r@example.com");
    expect(await as.mutation(api.profiles.acceptInvitation, { code })).toMatchObject({ ok: false, code: "MEMBERSHIP_REVOKED" });
  });
});

describe("bootstrapAdmin", () => {
  it("returns a code and does not activate an existing profile", async () => {
    const t = newTest();
    const as = await existingUser(t, "first@example.com", true);
    await as.mutation(api.profiles.ensureProfile, {});
    const result = await t.mutation(internal.admin.bootstrapAdmin, { email: "First@Example.com" });
    expect(result).toMatchObject({ email: "first@example.com", role: "admin" });
    expect(normalizeInviteCode(result.code)).not.toBeNull();
    expect(await as.query(api.profiles.viewer, {})).toMatchObject({ status: "pending", role: "member" });
    expect(await as.mutation(api.profiles.acceptInvitation, { code: result.code })).toMatchObject({ ok: true, profile: { role: "admin", status: "active" } });
  });

  it("rejects an invalid email", async () => {
    const t = newTest();
    await expect(t.mutation(internal.admin.bootstrapAdmin, { email: "nope" })).rejects.toThrow(/valid email/);
  });
});

describe("sign-in", () => {
  async function account(t: T, email: string) {
    const { code } = await invite(t, email);
    const res = await signUp(t, email, code);
    expect(res.status).toBe(200);
  }

  it("signs in with the right password and rejects a wrong one", async () => {
    const t = newTest();
    await account(t, "s@example.com");
    expect((await post(t, "/sign-in/email", { email: "s@example.com", password: PASSWORD })).status).toBe(200);
    expect(await post(t, "/sign-in/email", { email: "s@example.com", password: "wrong password!!" })).toMatchObject({
      status: 401,
      body: { code: "INVALID_EMAIL_OR_PASSWORD" },
    });
  });

  it("rate limits sign-in per IP through the database", async () => {
    const t = newTest();
    await account(t, "s@example.com");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post(t, "/sign-in/email", { email: `x${i}@example.com`, password: "wrong password!!" }, "10.9.9.9")).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    const rows = await t.query(components.betterAuth.adapter.findMany, {
      model: "rateLimit",
      where: [{ field: "key", value: "10.9.9.9|/sign-in/email" }],
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(rows.page).toHaveLength(1);
  });

  it("limits sign-in attempts per email across IPs", async () => {
    const t = newTest();
    await account(t, "s@example.com");
    for (let i = 0; i < ATTEMPT_LIMITS.signIn.max; i++) {
      expect(await t.mutation(internal.authGate.consumeSignInAttempt, { email: "S@example.com" })).toMatchObject({ allowed: true });
    }
    const res = await post(t, "/sign-in/email", { email: "s@example.com", password: PASSWORD });
    expect(res).toMatchObject({ status: 429, body: { code: "TOO_MANY_ATTEMPTS" } });
  });

  it("has no password reset, verification email or social sign-in routes", async () => {
    const t = newTest();
    await account(t, "s@example.com");
    for (const path of ["/request-password-reset", "/send-verification-email", "/sign-in/social", "/change-email"]) {
      expect((await post(t, path, { email: "s@example.com", provider: "github", newEmail: "n@example.com" })).status).toBe(404);
    }
  });
});

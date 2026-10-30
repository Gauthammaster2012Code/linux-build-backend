import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { ATTEMPT_LIMITS, consumeAttempt } from "./lib/attempts";
import { sha256Hex } from "./lib/crypto";
import { checkInviteCode, normalizeEmail } from "./lib/invites";

/** Called by the Better Auth sign-up hook before an account is created. */
export const checkSignUpInvite = internalQuery({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, { email, code }) => {
    const result = await checkInviteCode(ctx, code, email);
    return result.ok ? { ok: true as const } : { ok: false as const, reason: result.reason };
  },
});

/** Called by the Better Auth sign-in hook. Counts every attempt for the email, successful or not. */
export const consumeSignInAttempt = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const key = `signin:${await sha256Hex(normalizeEmail(email))}`;
    const result = await consumeAttempt(ctx, key, ATTEMPT_LIMITS.signIn);
    return result.allowed
      ? { allowed: true as const, retryAfterSeconds: 0 }
      : { allowed: false as const, retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000) };
  },
});

/** Deletes attempt counters whose window ended long ago. */
export const pruneAttempts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const stale = await ctx.db
      .query("authAttempts")
      .withIndex("by_windowStart", (q) => q.lt("windowStart", cutoff))
      .take(500);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length };
  },
});

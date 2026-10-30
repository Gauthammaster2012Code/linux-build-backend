import type { MutationCtx } from "../_generated/server";

export const ATTEMPT_LIMITS = {
  /** Invite-code redemptions per profile. */
  inviteRedemption: { max: 5, windowMs: 15 * 60_000 },
  /** Password sign-ins per email address, on top of Better Auth's per-IP limit. */
  signIn: { max: 10, windowMs: 15 * 60_000 },
} as const;

export type AttemptResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Fixed-window counter. Callers must not throw after a denied or allowed attempt in the same mutation, or the
 * increment is rolled back with the rest of the transaction.
 */
export async function consumeAttempt(
  ctx: MutationCtx,
  key: string,
  limit: { max: number; windowMs: number },
  now = Date.now(),
): Promise<AttemptResult> {
  const row = await ctx.db
    .query("authAttempts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (!row) {
    await ctx.db.insert("authAttempts", { key, windowStart: now, count: 1 });
    return { allowed: true };
  }
  if (now - row.windowStart >= limit.windowMs) {
    await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  if (row.count >= limit.max) return { allowed: false, retryAfterMs: row.windowStart + limit.windowMs - now };
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return { allowed: true };
}

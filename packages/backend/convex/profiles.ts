import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { appError, ERR, getSessionUserId } from "./lib/access";
import { ATTEMPT_LIMITS, consumeAttempt } from "./lib/attempts";
import { checkInviteCode, normalizeEmail } from "./lib/invites";

export interface AuthUserSnapshot {
  authUserId: string;
  email: string;
  name: string;
  image?: string;
}

/**
 * Creates or refreshes the app profile for a signed-in Better Auth user. New profiles start pending; only
 * acceptInvitation activates them.
 */
export async function syncProfile(ctx: MutationCtx, user: AuthUserSnapshot): Promise<Doc<"profiles">> {
  const email = normalizeEmail(user.email);
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", user.authUserId))
    .unique();

  if (!profile) {
    const id = await ctx.db.insert("profiles", {
      authUserId: user.authUserId,
      email,
      name: user.name || email,
      image: user.image,
      role: "member",
      status: "pending",
      createdAt: Date.now(),
    });
    return (await ctx.db.get(id))!;
  }
  if (profile.email !== email || profile.name !== user.name || profile.image !== user.image) {
    await ctx.db.patch(profile._id, { email, name: user.name || email, image: user.image });
    return (await ctx.db.get(profile._id))!;
  }
  return profile;
}

async function publicProfile(ctx: QueryCtx, p: Doc<"profiles">) {
  const selection = p.aiSelection ?? { source: "platform" as const };
  // A deleted personal connection stays selected until the member explicitly chooses a replacement.
  const connection = selection.source === "personal" ? await ctx.db.get(selection.connectionId) : null;
  return {
    profileId: p._id,
    email: p.email,
    name: p.name,
    image: p.image,
    role: p.role,
    status: p.status,
    aiSelection: selection,
    aiSelectionMissing: selection.source === "personal" && (!connection || connection.ownerId !== p._id),
  };
}

async function signedInProfile(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw appError(ERR.unauthenticated, "Sign in to continue.");
  const authUser = await authComponent.safeGetAuthUser(ctx);
  if (!authUser) throw appError(ERR.unauthenticated, "Your session has ended. Sign in again.");
  return syncProfile(ctx, {
    authUserId: identity.subject,
    email: authUser.email,
    name: authUser.name,
    image: authUser.image ?? undefined,
  });
}

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getSessionUserId(ctx);
    if (!authUserId) return null;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
      .unique();
    if (!profile) return { status: "unregistered" as const };
    return publicProfile(ctx, profile);
  },
});

/** Called by the client after sign-in. Safe to call repeatedly. Never activates membership. */
export const ensureProfile = mutation({
  args: {},
  handler: async (ctx) => publicProfile(ctx, await signedInProfile(ctx)),
});

/**
 * Redeems a one-time invite code for the signed-in user. The code must belong to a pending, unexpired invitation for
 * the user's email. Failures are returned rather than thrown so the attempt counter is not rolled back.
 */
export const acceptInvitation = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const profile = await signedInProfile(ctx);
    if (profile.status === "active") return { ok: true as const, profile: await publicProfile(ctx, profile) };
    if (profile.status === "revoked") {
      return { ok: false as const, code: "MEMBERSHIP_REVOKED", message: "Your membership has been revoked. Contact an administrator." };
    }
    const limit = await consumeAttempt(ctx, `redeem:${profile._id}`, ATTEMPT_LIMITS.inviteRedemption);
    if (!limit.allowed) {
      const minutes = Math.max(1, Math.ceil(limit.retryAfterMs / 60_000));
      return {
        ok: false as const,
        code: "TOO_MANY_ATTEMPTS",
        message: `Too many invite code attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      };
    }
    const check = await checkInviteCode(ctx, code, profile.email);
    if (!check.ok) {
      return check.reason === "expired"
        ? { ok: false as const, code: "INVITE_CODE_EXPIRED", message: "This invite code has expired. Ask an administrator for a new one." }
        : { ok: false as const, code: "INVITE_CODE_INVALID", message: "This invite code is not valid for your email address." };
    }
    const now = Date.now();
    await ctx.db.patch(check.invitationId, { status: "accepted", acceptedBy: profile._id, acceptedAt: now });
    await ctx.db.patch(profile._id, { status: "active", role: check.role, invitationId: check.invitationId });
    return { ok: true as const, profile: await publicProfile(ctx, (await ctx.db.get(profile._id))!) };
  },
});

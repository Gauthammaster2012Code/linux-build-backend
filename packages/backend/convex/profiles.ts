import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { appError, ERR, getSessionUserId } from "./lib/access";

export interface AuthUserSnapshot {
  authUserId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string;
}

/**
 * Creates or refreshes the app profile for a signed-in Better Auth user and activates membership
 * when a pending invitation matches a verified email address.
 */
export async function syncProfile(ctx: MutationCtx, user: AuthUserSnapshot): Promise<Doc<"profiles">> {
  const email = user.email.trim().toLowerCase();
  const now = Date.now();
  let profile = await ctx.db
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
      createdAt: now,
    });
    profile = (await ctx.db.get(id))!;
  } else if (profile.email !== email || profile.name !== user.name || profile.image !== user.image) {
    await ctx.db.patch(profile._id, { email, name: user.name || email, image: user.image });
    profile = (await ctx.db.get(profile._id))!;
  }

  if (profile.status === "pending" && user.emailVerified) {
    const invitation = (
      await ctx.db
        .query("invitations")
        .withIndex("by_email", (q) => q.eq("email", email))
        .collect()
    ).find((i) => i.status === "pending" && i.expiresAt > now);
    if (invitation) {
      await ctx.db.patch(invitation._id, { status: "accepted", acceptedBy: profile._id });
      await ctx.db.patch(profile._id, { status: "active", role: invitation.role, invitationId: invitation._id });
      profile = (await ctx.db.get(profile._id))!;
    }
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

/** Called by the client after sign-in. Safe to call repeatedly. */
export const ensureProfile = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError(ERR.unauthenticated, "Sign in to continue.");
    const authUser = await authComponent.safeGetAuthUser(ctx);
    if (!authUser) throw appError(ERR.unauthenticated, "Your session has ended. Sign in again.");
    const profile = await syncProfile(ctx, {
      authUserId: identity.subject,
      email: authUser.email,
      emailVerified: authUser.emailVerified,
      name: authUser.name,
      image: authUser.image ?? undefined,
    });
    return publicProfile(ctx, profile);
  },
});

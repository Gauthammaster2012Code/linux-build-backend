import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";

export type ReaderCtx = QueryCtx | MutationCtx;

export const ERR = {
  unauthenticated: "UNAUTHENTICATED",
  notMember: "NOT_A_MEMBER",
  forbidden: "FORBIDDEN",
  notFound: "NOT_FOUND",
} as const;

export function appError(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

/**
 * Returns the Better Auth user id behind the request, or null. A Convex JWT stays valid until it expires, so the
 * Better Auth session it names must also still exist and be unexpired; signing out or revoking a session ends access.
 */
export async function getSessionUserId(ctx: ReaderCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const user = await authComponent.safeGetAuthUser(ctx);
  return user ? identity.subject : null;
}

export async function requireMember(ctx: ReaderCtx): Promise<Doc<"profiles">> {
  const authUserId = await getSessionUserId(ctx);
  if (!authUserId) throw appError(ERR.unauthenticated, "Sign in to continue.");
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
    .unique();
  if (!profile || profile.status !== "active") {
    throw appError(ERR.notMember, "LinxGen is invite-only. Ask an administrator for an invitation.");
  }
  return profile;
}

export async function requireAdmin(ctx: ReaderCtx): Promise<Doc<"profiles">> {
  const profile = await requireMember(ctx);
  if (profile.role !== "admin") throw appError(ERR.forbidden, "Administrator access is required.");
  return profile;
}

/** Returns the build only if the viewer owns it. Other users' builds look like missing builds. */
export async function requireOwnedBuild(ctx: ReaderCtx, buildId: Id<"builds">) {
  const profile = await requireMember(ctx);
  const build = await ctx.db.get(buildId);
  if (!build || build.ownerId !== profile._id) throw appError(ERR.notFound, "Build not found.");
  return { profile, build };
}

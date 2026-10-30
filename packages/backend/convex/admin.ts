import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { ACTIVE_RUNNER_STATUSES, MAX_ARTIFACT_RETENTION_HOURS, MIN_ARTIFACT_RETENTION_HOURS, validRetentionHours } from "@linxgen/spec";
import { internalMutation, mutation, query } from "./_generated/server";
import { appError, ERR, isOwnerEmail, requireAdmin, requireMember, requireOwner } from "./lib/access";
import { requestCancel, unfinishedBuilds } from "./lib/buildOps";
import { DEFAULT_SETTINGS, MAX_BUILD_TIMEOUT_MINUTES } from "./lib/config";
import { EMAIL_PATTERN, issueInvitation, normalizeEmail } from "./lib/invites";
import { getSettings, getSettingsDoc } from "./lib/settings";
import { storageUsage } from "./lib/storageBudget";

function validEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalized) || normalized.length > 254) throw appError("INVALID_EMAIL", "Enter a valid email address.");
  return normalized;
}

export const listMembers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const profiles = await ctx.db.query("profiles").order("desc").take(500);
    return profiles.map((p) => ({
      profileId: p._id,
      email: p.email,
      name: p.name,
      role: p.role,
      isOwner: isOwnerEmail(p.email),
      status: p.status,
      createdAt: p.createdAt,
      revokedAt: p.revokedAt,
    }));
  },
});

export const listInvitations = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    const invitations = await ctx.db.query("invitations").order("desc").take(500);
    return invitations.map((i) => ({
      invitationId: i._id,
      email: i.email,
      role: i.role,
      status: i.status,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
    }));
  },
});

export const createInvitation = mutation({
  args: { email: v.string(), role: v.union(v.literal("member"), v.literal("admin")) },
  /** Returns the one-time code. Only its hash is stored, so it cannot be shown again. */
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    return issueInvitation(ctx, { email: validEmail(args.email), role: args.role, invitedBy: owner._id });
  },
});

export const revokeInvitation = mutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, { invitationId }) => {
    await requireOwner(ctx);
    const inv = await ctx.db.get(invitationId);
    if (!inv) throw appError(ERR.notFound, "Invitation not found.");
    if (inv.status === "pending") await ctx.db.patch(invitationId, { status: "revoked" });
  },
});

export const setMembership = mutation({
  args: { profileId: v.id("profiles"), status: v.union(v.literal("active"), v.literal("revoked")) },
  handler: async (ctx, { profileId, status }) => {
    const admin = await requireAdmin(ctx);
    if (profileId === admin._id && status === "revoked") throw appError(ERR.forbidden, "You cannot revoke your own membership.");
    const profile = await ctx.db.get(profileId);
    if (!profile) throw appError(ERR.notFound, "Member not found.");
    if (isOwnerEmail(profile.email)) throw appError(ERR.forbidden, "The owner's membership cannot be changed.");
    if (status === "active" && profile.status === "pending") {
      throw appError(ERR.forbidden, "Pending users join through an invitation.");
    }
    await ctx.db.patch(profileId, { status, revokedAt: status === "revoked" ? Date.now() : undefined });
    if (status === "revoked") {
      for (const b of await unfinishedBuilds(ctx, profileId)) await requestCancel(ctx, b, "Membership revoked");
    }
  },
});

export const setRole = mutation({
  args: { profileId: v.id("profiles"), role: v.union(v.literal("member"), v.literal("admin")) },
  handler: async (ctx, { profileId, role }) => {
    const admin = await requireAdmin(ctx);
    if (profileId === admin._id && role !== "admin") throw appError(ERR.forbidden, "You cannot remove your own admin role.");
    const profile = await ctx.db.get(profileId);
    if (!profile) throw appError(ERR.notFound, "Member not found.");
    if (isOwnerEmail(profile.email) && role !== "admin") throw appError(ERR.forbidden, "The owner's admin role cannot be removed.");
    await ctx.db.patch(profileId, { role });
  },
});

export const getLimits = query({
  args: {},
  handler: async (ctx) => {
    await requireMember(ctx);
    return getSettings(ctx);
  },
});

const settingsArgs = {
  maxActiveBuildsPerUser: v.number(),
  maxActiveBuildsGlobal: v.number(),
  maxPendingBuildsPerUser: v.number(),
  buildTimeoutMinutes: v.number(),
  maxArtifactBytes: v.number(),
  maxLogBytes: v.number(),
  artifactRetentionHours: v.number(),
  maxStoredBytes: v.number(),
  platformGenerationsPerDay: v.number(),
};

export const updateSettings = mutation({
  args: settingsArgs,
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    for (const [k, value] of Object.entries(args)) {
      if (!Number.isInteger(value) || value < (k === "platformGenerationsPerDay" ? 0 : 1)) {
        throw appError("INVALID_SETTING", `${k} must be a positive integer.`);
      }
    }
    if (args.buildTimeoutMinutes > MAX_BUILD_TIMEOUT_MINUTES) {
      throw appError(
        "INVALID_SETTING",
        `The build timeout cannot exceed ${MAX_BUILD_TIMEOUT_MINUTES} minutes; the build workflow allows 360 minutes including setup and reporting.`,
      );
    }
    if (!validRetentionHours(args.artifactRetentionHours)) {
      throw appError(
        "INVALID_SETTING",
        `File retention must be between ${MIN_ARTIFACT_RETENTION_HOURS} and ${MAX_ARTIFACT_RETENTION_HOURS} hours.`,
      );
    }
    if (args.maxStoredBytes < args.maxArtifactBytes) {
      throw appError("INVALID_SETTING", "The storage budget must be at least the maximum artifact size, or no image could be uploaded.");
    }
    const existing = await getSettingsDoc(ctx);
    const doc = { ...args, artifactRetentionDays: undefined, updatedAt: Date.now(), updatedBy: admin._id };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("settings", { key: "global", ...doc });
  },
});

export const listOpsErrors = query({
  args: { paginationOpts: paginationOptsValidator, includeResolved: v.optional(v.boolean()) },
  handler: async (ctx, { paginationOpts, includeResolved }) => {
    await requireAdmin(ctx);
    if (includeResolved) return ctx.db.query("opsErrors").withIndex("by_at").order("desc").paginate(paginationOpts);
    return ctx.db
      .query("opsErrors")
      .withIndex("by_resolved_at", (q) => q.eq("resolvedAt", undefined))
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const resolveOpsError = mutation({
  args: { opsErrorId: v.id("opsErrors") },
  handler: async (ctx, { opsErrorId }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(opsErrorId, { resolvedAt: Date.now() });
  },
});

export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const settings = await getSettings(ctx);
    let active = 0;
    for (const s of ACTIVE_RUNNER_STATUSES) {
      active += (await ctx.db.query("builds").withIndex("by_status", (q) => q.eq("status", s)).take(100)).length;
    }
    const queued = (await ctx.db.query("builds").withIndex("by_status", (q) => q.eq("status", "queued")).take(200)).length;
    const unresolvedErrors = (
      await ctx.db
        .query("opsErrors")
        .withIndex("by_resolved_at", (q) => q.eq("resolvedAt", undefined))
        .take(200)
    ).length;
    const storage = await storageUsage(ctx);
    let activeSaves = 0;
    for (const s of ["queued", "dispatched", "running"] as const) {
      activeSaves += (await ctx.db.query("saves").withIndex("by_status", (q) => q.eq("status", s)).take(200)).length;
    }
    return {
      active,
      queued,
      unresolvedErrors,
      settings,
      defaults: DEFAULT_SETTINGS,
      storage: { storedBytes: storage.storedBytes, maxStoredBytes: settings.maxStoredBytes, files: storage.files },
      activeSaves,
    };
  },
});

/**
 * Creates an admin invitation and returns its one-time code. It never activates an existing account: the person signs
 * up (or, if already signed up, enters the code) to become an administrator. Use it for the owner (OWNER_EMAIL), who
 * then issues every other code from the web app. Run from the CLI:
 *   npx convex run admin:bootstrapAdmin '{"email":"you@example.com"}'
 */
export const bootstrapAdmin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => issueInvitation(ctx, { email: validEmail(email), role: "admin" }),
});

import { v } from "convex/values";
import { ACTIVE_SAVE_STATUSES, TERMINAL_ATTEMPT_STATUSES } from "@linxgen/spec";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { recordOpsError } from "./lib/buildOps";
import { ConfigError, storageConfig, TIMING } from "./lib/config";
import { ObjectStorage } from "./lib/objectStorage";
import { saveHoldDeadline } from "./lib/saves";

/** An unfinished save of the artifact's build keeps the file past its expiry, for at most TIMING.saveHoldMaxMs. */
async function heldBySave(ctx: QueryCtx, a: Doc<"artifacts">, now: number): Promise<boolean> {
  if (saveHoldDeadline(a.expiresAt) <= now) return false;
  const saves = await ctx.db
    .query("saves")
    .withIndex("by_build", (q) => q.eq("buildId", a.buildId))
    .order("desc")
    .take(20);
  return saves.some((s) => ACTIVE_SAVE_STATUSES.includes(s.status) && s.artifactIds.includes(a._id));
}

export const cleanupCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("artifacts")
      .withIndex("by_status_expires", (q) => q.eq("status", "available").lt("expiresAt", now))
      .take(100);
    const expired: { artifactId: Id<"artifacts">; storageKey: string }[] = [];
    let held = 0;
    for (const a of due) {
      if (await heldBySave(ctx, a, now)) held++;
      else expired.push({ artifactId: a._id, storageKey: a.storageKey });
    }
    const open = await ctx.db.query("uploads").withIndex("by_status_created", (q) => q.eq("status", "uploading")).take(200);
    const stale: { uploadId: Id<"uploads">; storageKey: string; storageUploadId?: string }[] = [];
    for (const u of open) {
      const attempt = await ctx.db.get(u.attemptId);
      const attemptOver = !attempt || TERMINAL_ATTEMPT_STATUSES.includes(attempt.status);
      if (attemptOver || now - u.createdAt > TIMING.incompleteUploadMaxAgeMs) {
        stale.push({ uploadId: u._id, storageKey: u.storageKey, storageUploadId: u.storageUploadId });
      }
    }
    return { expired, stale, held };
  },
});

export const markArtifactExpired = internalMutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, { artifactId }) => {
    const a = await ctx.db.get(artifactId);
    if (a && a.status === "available") await ctx.db.patch(artifactId, { status: "expired", deletedAt: Date.now() });
  },
});

export const markUploadAborted = internalMutation({
  args: { uploadId: v.id("uploads") },
  handler: async (ctx, { uploadId }) => {
    const u = await ctx.db.get(uploadId);
    if (u && u.status === "uploading") await ctx.db.patch(uploadId, { status: "aborted" });
  },
});

export const logCleanupError = internalMutation({
  args: { message: v.string() },
  handler: async (ctx, { message }) => recordOpsError(ctx, "cleanup", message),
});

/**
 * Deletes expired files (every stored version, so B2 stops billing for them) and abandoned uploads (open, or
 * completed in storage but never recorded). Build and artifact records stay for history.
 */
export const cleanup = internalAction({
  args: {},
  handler: async (ctx): Promise<{ expired: number; aborted: number; held: number }> => {
    const work = await ctx.runQuery(internal.maintenance.cleanupCandidates, {});
    if (work.expired.length === 0 && work.stale.length === 0) return { expired: 0, aborted: 0, held: work.held };
    let storage: ObjectStorage;
    try {
      storage = new ObjectStorage(storageConfig());
    } catch (e) {
      if (e instanceof ConfigError) {
        await ctx.runMutation(internal.maintenance.logCleanupError, { message: `Storage not configured: ${e.message}` });
        return { expired: 0, aborted: 0, held: work.held };
      }
      throw e;
    }
    let expired = 0;
    let aborted = 0;
    for (const a of work.expired) {
      try {
        await storage.deleteObject(a.storageKey);
        await ctx.runMutation(internal.maintenance.markArtifactExpired, { artifactId: a.artifactId });
        expired++;
      } catch (e) {
        await ctx.runMutation(internal.maintenance.logCleanupError, { message: `Delete failed for ${a.storageKey}: ${(e as Error).message}` });
      }
    }
    for (const u of work.stale) {
      try {
        if (u.storageUploadId) await storage.abortMultipartUpload(u.storageKey, u.storageUploadId);
        // The multipart upload may have been completed in storage without being recorded; no artifact references that object.
        await storage.deleteObject(u.storageKey);
        await ctx.runMutation(internal.maintenance.markUploadAborted, { uploadId: u.uploadId });
        aborted++;
      } catch (e) {
        await ctx.runMutation(internal.maintenance.logCleanupError, { message: `Abort failed for ${u.storageKey}: ${(e as Error).message}` });
      }
    }
    return { expired, aborted, held: work.held };
  },
});

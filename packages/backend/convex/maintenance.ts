import { v } from "convex/values";
import { TERMINAL_ATTEMPT_STATUSES } from "@linxgen/spec";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { recordOpsError } from "./lib/buildOps";
import { ConfigError, r2Config, TIMING } from "./lib/config";
import { R2Storage } from "./lib/r2";

export const cleanupCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("artifacts")
      .withIndex("by_status_expires", (q) => q.eq("status", "available").lt("expiresAt", now))
      .take(100);
    const open = await ctx.db.query("uploads").withIndex("by_status_created", (q) => q.eq("status", "uploading")).take(200);
    const stale: { uploadId: Id<"uploads">; storageKey: string; r2UploadId: string }[] = [];
    for (const u of open) {
      const attempt = await ctx.db.get(u.attemptId);
      const attemptOver = !attempt || TERMINAL_ATTEMPT_STATUSES.includes(attempt.status);
      if (attemptOver || now - u.createdAt > TIMING.incompleteUploadMaxAgeMs) {
        stale.push({ uploadId: u._id, storageKey: u.storageKey, r2UploadId: u.r2UploadId });
      }
    }
    return {
      expired: expired.map((a) => ({ artifactId: a._id, storageKey: a.storageKey })),
      stale,
    };
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

/** Deletes expired files and abandoned uploads (open or completed but unrecorded). Build and artifact records stay for history. */
export const cleanup = internalAction({
  args: {},
  handler: async (ctx) => {
    const work = await ctx.runQuery(internal.maintenance.cleanupCandidates, {});
    if (work.expired.length === 0 && work.stale.length === 0) return { expired: 0, aborted: 0 };
    let storage: R2Storage;
    try {
      storage = new R2Storage(r2Config());
    } catch (e) {
      if (e instanceof ConfigError) {
        await ctx.runMutation(internal.maintenance.logCleanupError, { message: `Storage not configured: ${e.message}` });
        return { expired: 0, aborted: 0 };
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
        await storage.abortMultipartUpload(u.storageKey, u.r2UploadId);
        // The multipart upload may have been completed in R2 without being recorded; no artifact references that object.
        await storage.deleteObject(u.storageKey);
        await ctx.runMutation(internal.maintenance.markUploadAborted, { uploadId: u.uploadId });
        aborted++;
      } catch (e) {
        await ctx.runMutation(internal.maintenance.logCleanupError, { message: `Abort failed for ${u.storageKey}: ${(e as Error).message}` });
      }
    }
    return { expired, aborted };
  },
});

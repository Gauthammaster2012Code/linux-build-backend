import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery, query } from "./_generated/server";
import { appError, ERR, requireMember } from "./lib/access";
import { r2Config, TIMING } from "./lib/config";
import { R2Storage } from "./lib/r2";

export const library = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const profile = await requireMember(ctx);
    const page = await ctx.db
      .query("artifacts")
      .withIndex("by_owner", (q) => q.eq("ownerId", profile._id))
      .order("desc")
      .paginate(paginationOpts);
    const now = Date.now();
    const rows = [];
    for (const a of page.page) {
      if (!a.verified || (a.kind !== "iso" && a.kind !== "container")) continue;
      const build = await ctx.db.get(a.buildId);
      rows.push({
        artifactId: a._id,
        buildId: a.buildId,
        buildTitle: build?.title ?? "Build",
        kind: a.kind,
        fileName: a.fileName,
        format: a.format,
        sizeBytes: a.sizeBytes,
        sha256: a.sha256,
        verification: a.verification,
        status: a.status === "available" && a.expiresAt <= now ? ("expired" as const) : a.status,
        expiresAt: a.expiresAt,
        createdAt: a.createdAt,
      });
    }
    return { ...page, page: rows };
  },
});

export const getForDownload = internalQuery({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, { artifactId }) => {
    const profile = await requireMember(ctx);
    const a = await ctx.db.get(artifactId);
    if (!a || a.ownerId !== profile._id) throw appError(ERR.notFound, "Artifact not found.");
    if (a.status !== "available" || a.expiresAt <= Date.now()) throw appError("EXPIRED", "This artifact has expired.");
    if ((a.kind === "iso" || a.kind === "container") && !a.verified) {
      throw appError("UNVERIFIED", "This artifact did not pass verification and cannot be downloaded.");
    }
    return { storageKey: a.storageKey, fileName: a.fileName };
  },
});

/** Returns a short-lived signed URL after the ownership check. File bytes go directly from R2 to the browser. */
export const downloadUrl = action({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, { artifactId }): Promise<{ url: string; expiresAt: number }> => {
    const a = await ctx.runQuery(internal.artifacts.getForDownload, { artifactId });
    const storage = new R2Storage(r2Config());
    const url = await storage.presignDownload(a.storageKey, a.fileName, TIMING.presignedDownloadSeconds);
    return { url, expiresAt: Date.now() + TIMING.presignedDownloadSeconds * 1000 };
  },
});

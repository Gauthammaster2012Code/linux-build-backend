import type { Doc } from "../_generated/dataModel";
import type { ReaderCtx } from "./access";
import { DEFAULT_SETTINGS, type OperatingSettings } from "./config";

export async function getSettingsDoc(ctx: ReaderCtx): Promise<Doc<"settings"> | null> {
  return ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
}

export async function getSettings(ctx: ReaderCtx): Promise<OperatingSettings> {
  const doc = await getSettingsDoc(ctx);
  if (!doc) return { ...DEFAULT_SETTINGS };
  return {
    maxActiveBuildsPerUser: doc.maxActiveBuildsPerUser,
    maxActiveBuildsGlobal: doc.maxActiveBuildsGlobal,
    maxPendingBuildsPerUser: doc.maxPendingBuildsPerUser,
    buildTimeoutMinutes: doc.buildTimeoutMinutes,
    maxArtifactBytes: doc.maxArtifactBytes,
    maxLogBytes: doc.maxLogBytes,
    artifactRetentionDays: doc.artifactRetentionDays,
    platformGenerationsPerDay: doc.platformGenerationsPerDay,
  };
}

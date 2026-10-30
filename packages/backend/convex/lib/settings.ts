import type { Doc } from "../_generated/dataModel";
import type { ReaderCtx } from "./access";
import { DEFAULT_SETTINGS, type OperatingSettings } from "./config";

export async function getSettingsDoc(ctx: ReaderCtx): Promise<Doc<"settings"> | null> {
  return ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
}

/**
 * Rows saved while retention was set in days are read with the new default rather than converted: a week of
 * retention would far exceed the temporary-storage budget the hour-based setting was introduced for.
 */
function retentionHoursOf(doc: Doc<"settings">): number {
  return doc.artifactRetentionHours ?? DEFAULT_SETTINGS.artifactRetentionHours;
}

export function retentionMs(settings: Pick<OperatingSettings, "artifactRetentionHours">): number {
  return settings.artifactRetentionHours * 60 * 60_000;
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
    artifactRetentionHours: retentionHoursOf(doc),
    maxStoredBytes: doc.maxStoredBytes ?? DEFAULT_SETTINGS.maxStoredBytes,
    platformGenerationsPerDay: doc.platformGenerationsPerDay,
  };
}

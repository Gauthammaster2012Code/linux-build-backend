import type { ReaderCtx } from "./access";

/**
 * Bytes held in temporary storage: every artifact whose file has not been deleted yet (expired files count until the
 * cleanup job removes them) plus the declared size of uploads in progress, which reserve their space up front.
 */
export async function storageUsage(ctx: ReaderCtx): Promise<{ storedBytes: number; files: number }> {
  let storedBytes = 0;
  let files = 0;
  const available = await ctx.db
    .query("artifacts")
    .withIndex("by_status_expires", (q) => q.eq("status", "available"))
    .collect();
  for (const a of available) {
    storedBytes += a.sizeBytes;
    files++;
  }
  const open = await ctx.db
    .query("uploads")
    .withIndex("by_status_created", (q) => q.eq("status", "uploading"))
    .collect();
  for (const u of open) {
    storedBytes += u.sizeBytes;
    files++;
  }
  return { storedBytes, files };
}

/** True when an upload of `sizeBytes` fits in the budget next to what is already stored or reserved. */
export function fitsBudget(storedBytes: number, sizeBytes: number, maxStoredBytes: number): boolean {
  return storedBytes + sizeBytes <= maxStoredBytes;
}

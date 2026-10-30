/** Bounds for the admin-editable operating settings, shared by the backend validation and the admin form. */

export const GIB = 1024 * 1024 * 1024;

export const DEFAULT_ARTIFACT_RETENTION_HOURS = 24;
export const MIN_ARTIFACT_RETENTION_HOURS = 1;
export const MAX_ARTIFACT_RETENTION_HOURS = 168;

/** Backblaze B2's free plan includes 10 GB of storage; the default keeps a margin below it. */
export const DEFAULT_MAX_STORED_BYTES = 9 * GIB;

export function validRetentionHours(hours: number): boolean {
  return Number.isInteger(hours) && hours >= MIN_ARTIFACT_RETENTION_HOURS && hours <= MAX_ARTIFACT_RETENTION_HOURS;
}

/** Reported to the member when an upload would push temporary storage over the configured budget. */
export const STORAGE_FULL_MESSAGE = "Temporary storage is full; try again after older builds expire.";

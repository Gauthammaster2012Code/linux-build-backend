import { z } from "zod";
import { SHA256_PATTERN } from "./runner-protocol";

/**
 * Saving a finished build's files to the member's own GitHub account. A save runs in its own GitHub Actions
 * workflow (`linxgen-save.yml`), downloads the files from temporary storage and uploads them as release assets to the
 * member's private storage repository. All routes live under /runner/save on the Convex site URL.
 */
export const SAVE_PROTOCOL_VERSION = 1 as const;

export const SAVE_STATUSES = ["queued", "dispatched", "running", "succeeded", "failed", "cancelled"] as const;
export type SaveStatus = (typeof SAVE_STATUSES)[number];
export const ACTIVE_SAVE_STATUSES: readonly SaveStatus[] = ["queued", "dispatched", "running"];
export const TERMINAL_SAVE_STATUSES: readonly SaveStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminalSaveStatus(status: SaveStatus): boolean {
  return TERMINAL_SAVE_STATUSES.includes(status);
}

export const SAVE_FAILURE_CODES = [
  "storage_expired",
  "github_unauthorized",
  "repo_missing",
  "download_failed",
  "checksum_mismatch",
  "upload_failed",
  "not_connected",
  "dispatch_failed",
  "runner_lost",
  "timed_out",
  "cancelled",
  "internal_error",
] as const;
export type SaveFailureCode = (typeof SAVE_FAILURE_CODES)[number];

/** Codes a save runner may report itself. The others are decided by the backend. */
export const SAVE_RUNNER_FAILURE_CODES = [
  "storage_expired",
  "github_unauthorized",
  "repo_missing",
  "download_failed",
  "checksum_mismatch",
  "upload_failed",
  "timed_out",
  "internal_error",
] as const satisfies readonly SaveFailureCode[];

export const SAVE_FAILURE_MESSAGES: Record<SaveFailureCode, string> = {
  storage_expired: "The build files are no longer in temporary storage, so they cannot be saved.",
  github_unauthorized: "LinxGen could not access your GitHub storage. Reconnect GitHub in Settings.",
  repo_missing: "Your storage repository is missing or no longer accessible. Reconnect GitHub in Settings.",
  download_failed: "The files could not be read from temporary storage.",
  checksum_mismatch: "A file did not match its recorded checksum, so it was not saved.",
  upload_failed: "Uploading to GitHub failed.",
  not_connected: "GitHub is not connected. Connect it in Settings.",
  dispatch_failed: "The save job could not be started on GitHub Actions.",
  runner_lost: "The save job stopped unexpectedly.",
  timed_out: "The save job took too long and was stopped.",
  cancelled: "The save was cancelled.",
  internal_error: "The save failed because of an internal error.",
};

/** GitHub refuses release assets of 2 GiB or more, so larger files are uploaded in parts below that size. */
export const GITHUB_ASSET_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
export const SAVE_SPLIT_PART_BYTES = Math.floor(1.9 * 1024 * 1024 * 1024);
export const SAVE_CHECKSUM_FILE = "SHA256SUMS";
/** Topic that marks a repository as created (or adopted) by LinxGen for build storage. */
export const STORAGE_REPO_TOPIC = "linxgen-storage";
export const STORAGE_REPO_DESCRIPTION = "LinxGen build storage";

/** Name of part `index` (0-based) of a split file: `<file>.part01`, `<file>.part02`, … */
export function splitPartName(fileName: string, index: number): string {
  return `${fileName}.part${String(index + 1).padStart(2, "0")}`;
}

export function splitPartCount(sizeBytes: number, partBytes = SAVE_SPLIT_PART_BYTES): number {
  return Math.max(1, Math.ceil(sizeBytes / partBytes));
}

const attemptIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/);

export const saveClaimRequestSchema = z
  .object({
    protocolVersion: z.literal(SAVE_PROTOCOL_VERSION),
    saveAttemptId: attemptIdSchema,
    dispatchNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  })
  .strict();
export type SaveClaimRequest = z.infer<typeof saveClaimRequestSchema>;

export const saveFileSchema = z.object({
  kind: z.enum(["iso", "container", "manifest", "log"]),
  fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(SHA256_PATTERN),
  url: z.string().url(),
});
export type SaveFile = z.infer<typeof saveFileSchema>;

export const saveReleaseSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  tag: z.string().regex(/^linxgen-[A-Za-z0-9-]{4,64}$/),
  name: z.string().min(1).max(200),
  body: z.string().max(20_000),
  /** Text the release body must contain before an existing release with the same tag is reused. */
  marker: z.string().min(8).max(200),
});
export type SaveRelease = z.infer<typeof saveReleaseSchema>;

export const repoTokenSchema = z.object({ token: z.string().min(20), expiresAt: z.number() });
export type RepoToken = z.infer<typeof repoTokenSchema>;

export const saveClaimResponseSchema = z.object({
  capability: z.string(),
  capabilityExpiresAt: z.number(),
  saveAttemptId: z.string(),
  deadlineAt: z.number(),
  files: z.array(saveFileSchema).min(1).max(20),
  release: saveReleaseSchema,
  github: repoTokenSchema,
});
export type SaveClaimResponse = z.infer<typeof saveClaimResponseSchema>;

export const saveFilesResponseSchema = z.object({ files: z.array(saveFileSchema).min(1).max(20) });

export const SAVE_PHASES = ["downloading", "uploading", "publishing"] as const;
export type SavePhase = (typeof SAVE_PHASES)[number];

export const saveProgressRequestSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    phase: z.enum(SAVE_PHASES),
    doneBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    message: z.string().max(500).optional(),
  })
  .strict();
export type SaveProgressRequest = z.infer<typeof saveProgressRequestSchema>;
export const saveProgressResponseSchema = z.object({ ok: z.boolean(), cancelRequested: z.boolean() });

export const saveFinishRequestSchema = z
  .object({
    status: z.enum(["succeeded", "failed", "cancelled"]),
    releaseUrl: z.string().url().max(500).optional(),
    assetCount: z.number().int().nonnegative().max(1000).optional(),
    failure: z.object({ code: z.enum(SAVE_RUNNER_FAILURE_CODES), message: z.string().max(2000) }).strict().optional(),
  })
  .strict();
export type SaveFinishRequest = z.infer<typeof saveFinishRequestSchema>;
export const saveFinishResponseSchema = z.object({ saveStatus: z.string() });

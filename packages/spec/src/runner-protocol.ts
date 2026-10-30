import { z } from "zod";
import { RUNNER_STAGES } from "./lifecycle";
import { OUTPUTS, PACKAGE_NAME_PATTERN, resolvedBuildSpecSchema } from "./spec";

/**
 * HTTP contract between the GitHub Actions runner and the Convex backend.
 * All routes live under /runner on the Convex site URL.
 */
export const RUNNER_PROTOCOL_VERSION = 1 as const;

export const ARTIFACT_KINDS = ["iso", "container", "log", "manifest"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const claimRequestSchema = z
  .object({
    protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
    attemptId: z.string().min(1).max(64),
    dispatchNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  })
  .strict();
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const runnerLimitsSchema = z.object({
  buildTimeoutMinutes: z.number().int().positive(),
  maxArtifactBytes: z.number().int().positive(),
  maxLogBytes: z.number().int().positive(),
});
export type RunnerLimits = z.infer<typeof runnerLimitsSchema>;

export const claimResponseSchema = z.object({
  capability: z.string(),
  capabilityExpiresAt: z.number(),
  buildId: z.string(),
  attemptId: z.string(),
  spec: resolvedBuildSpecSchema,
  limits: runnerLimitsSchema,
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const runnerEventSchema = z
  .object({
    at: z.number().int(),
    level: z.enum(["info", "warning", "error"]),
    message: z.string().max(2000),
    output: z.enum(OUTPUTS).optional(),
  })
  .strict();
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

export const MAX_LOG_LINE_CHARS = 4000;
export const MAX_LOG_LINES_PER_BATCH = 500;
/**
 * UTF-8 budget for the log lines of one events batch. The backend stores a batch as one document (Convex caps
 * documents at 1 MiB) and serves pages of up to MAX_LOG_BATCHES_PER_PAGE batches within the 16 MiB read limit.
 */
export const MAX_LOG_BATCH_BYTES = 256 * 1024;
export const MAX_LOG_BATCHES_PER_PAGE = 32;

/** UTF-8 encoded length without allocating, so it works the same in Node and the Convex runtime. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function logLinesByteLength(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) total += utf8ByteLength(line);
  return total;
}

export const eventsRequestSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    stage: z.enum(RUNNER_STAGES).optional(),
    events: z.array(runnerEventSchema).max(50),
    logLines: z
      .array(z.string().max(MAX_LOG_LINE_CHARS))
      .max(MAX_LOG_LINES_PER_BATCH)
      .refine((lines) => logLinesByteLength(lines) <= MAX_LOG_BATCH_BYTES, {
        message: `log lines exceed ${MAX_LOG_BATCH_BYTES} bytes`,
      }),
  })
  .strict();
export type EventsRequest = z.infer<typeof eventsRequestSchema>;

export const eventsResponseSchema = z.object({ ok: z.boolean(), cancelRequested: z.boolean(), duplicate: z.boolean().optional() });
export type EventsResponse = z.infer<typeof eventsResponseSchema>;

export const uploadStartRequestSchema = z
  .object({
    kind: z.enum(ARTIFACT_KINDS),
    fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(SHA256_PATTERN),
    contentType: z.enum(["application/x-iso9660-image", "application/gzip", "text/plain", "application/json"]),
  })
  .strict();
export type UploadStartRequest = z.infer<typeof uploadStartRequestSchema>;

export const uploadStartResponseSchema = z.object({
  uploadId: z.string(),
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive(),
});
export type UploadStartResponse = z.infer<typeof uploadStartResponseSchema>;

export const uploadPartsRequestSchema = z
  .object({
    uploadId: z.string(),
    partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(50),
  })
  .strict();
export const uploadPartsResponseSchema = z.object({
  urls: z.array(z.object({ partNumber: z.number().int(), url: z.string().url() })),
  expiresAt: z.number(),
});
export type UploadPartsResponse = z.infer<typeof uploadPartsResponseSchema>;

export const uploadCompleteRequestSchema = z
  .object({
    uploadId: z.string(),
    parts: z
      .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }).strict())
      .min(1)
      .max(10_000),
  })
  .strict();
export const uploadCompleteResponseSchema = z.object({ artifactId: z.string() });

export const packageVersionSchema = z.object({
  name: z.string().regex(PACKAGE_NAME_PATTERN),
  version: z.string().max(200),
});

export const verificationSchema = z
  .object({
    biosBoot: z.enum(["passed", "failed", "skipped"]).optional(),
    uefiBoot: z.enum(["passed", "failed", "skipped"]).optional(),
    containerSmoke: z.enum(["passed", "failed", "skipped"]).optional(),
    requestedPackagesPresent: z.boolean(),
    details: z.string().max(4000).optional(),
  })
  .strict();
export type Verification = z.infer<typeof verificationSchema>;

/** An output may be offered for download only when every check for its type passed. */
export function verificationPassed(output: (typeof OUTPUTS)[number], v: Verification): boolean {
  if (!v.requestedPackagesPresent) return false;
  if (output === "iso") return v.biosBoot === "passed" && v.uefiBoot === "passed";
  return v.containerSmoke === "passed";
}

export const outputResultSchema = z
  .object({
    output: z.enum(OUTPUTS),
    status: z.enum(["verified", "failed"]),
    artifactUploadId: z.string().optional(),
    manifestUploadId: z.string().optional(),
    verification: verificationSchema,
    installedPackageCount: z.number().int().nonnegative(),
    requestedPackages: z.array(packageVersionSchema).max(200),
    baseImageDigest: z.string().regex(DIGEST_PATTERN).optional(),
    toolchainImageDigest: z.string().regex(DIGEST_PATTERN).optional(),
    error: z.string().max(4000).optional(),
  })
  .strict();
export type OutputResult = z.infer<typeof outputResultSchema>;

export const finishRequestSchema = z
  .object({
    status: z.enum(["completed", "failed", "cancelled"]),
    builderRevision: z.string().regex(/^[a-f0-9]{7,64}$/),
    outputs: z.array(outputResultSchema).max(2),
    logUploadId: z.string().optional(),
    failure: z.object({ code: z.string().max(64), message: z.string().max(4000) }).strict().optional(),
  })
  .strict();
export type FinishRequest = z.infer<typeof finishRequestSchema>;

export const finishResponseSchema = z.object({ buildStatus: z.string() });

/**
 * Part size for multipart uploads. S3-compatible storage (Backblaze B2 included) needs every part except the last to be
 * at least 5 MB and at most 5 GiB, with at most 10,000 parts, so one upload can hold up to 640 GiB.
 */
export const UPLOAD_PART_SIZE_BYTES = 64 * 1024 * 1024;
export const MAX_UPLOAD_PARTS = 10_000;
export const MAX_UPLOAD_BYTES = UPLOAD_PART_SIZE_BYTES * MAX_UPLOAD_PARTS;

export function partCountFor(sizeBytes: number, partSize = UPLOAD_PART_SIZE_BYTES): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

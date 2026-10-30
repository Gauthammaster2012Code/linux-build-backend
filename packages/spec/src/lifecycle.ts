export const BUILD_STATUSES = [
  "generating",
  "validating",
  "queued",
  "preparing",
  "building",
  "verifying",
  "uploading",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

export const TERMINAL_BUILD_STATUSES: readonly BuildStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];
export const ACTIVE_RUNNER_STATUSES: readonly BuildStatus[] = ["preparing", "building", "verifying", "uploading"];

/** Stages a runner may report, in order. */
export const RUNNER_STAGES = ["preparing", "building", "verifying", "uploading"] as const;
export type RunnerStage = (typeof RUNNER_STAGES)[number];

const FAILURES: BuildStatus[] = ["failed", "cancelled", "timed_out"];

const TRANSITIONS: Record<BuildStatus, readonly BuildStatus[]> = {
  generating: ["validating", ...FAILURES],
  validating: ["generating", "queued", ...FAILURES],
  // Runner loss before any output is verified may put a build back in the queue for a new attempt.
  queued: ["preparing", ...FAILURES],
  preparing: ["queued", "building", ...FAILURES],
  building: ["queued", "verifying", ...FAILURES],
  verifying: ["queued", "uploading", ...FAILURES],
  uploading: ["succeeded", ...FAILURES],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function isTerminalStatus(status: BuildStatus): boolean {
  return TERMINAL_BUILD_STATUSES.includes(status);
}

export function canTransition(from: BuildStatus, to: BuildStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Runner stage reports only move forward; repeated or older stage reports are ignored. */
export function isForwardStage(current: BuildStatus, next: RunnerStage): boolean {
  if (current === "queued") return next === "preparing";
  const ci = RUNNER_STAGES.indexOf(current as RunnerStage);
  const ni = RUNNER_STAGES.indexOf(next);
  return ci >= 0 && ni > ci;
}

export const ATTEMPT_STATUSES = [
  "dispatching",
  "dispatched",
  "dispatch_unknown",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
  "timed_out",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const TERMINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = ["succeeded", "failed", "cancelled", "lost", "timed_out"];

export const FAILURE_CODES = [
  "unsupported_configuration",
  "generation_failed",
  "provider_error",
  "quota_exceeded",
  "dispatch_failed",
  "runner_lost",
  "build_failed",
  "verification_failed",
  "upload_failed",
  "storage_full",
  "partial_outputs",
  "timed_out",
  "cancelled",
  "internal_error",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const STATUS_LABELS: Record<BuildStatus, string> = {
  generating: "Generating configuration",
  validating: "Validating configuration",
  queued: "Queued",
  preparing: "Preparing runner",
  building: "Building",
  verifying: "Verifying outputs",
  uploading: "Uploading artifacts",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};

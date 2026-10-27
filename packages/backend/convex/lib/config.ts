/** Centralized environment access. Secrets stay in the Convex deployment environment and never reach clients or runners. */

export class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

export const DEFAULT_SETTINGS = {
  maxActiveBuildsPerUser: 1,
  maxActiveBuildsGlobal: 2,
  maxPendingBuildsPerUser: 3,
  buildTimeoutMinutes: 120,
  maxArtifactBytes: 6 * 1024 * 1024 * 1024,
  maxLogBytes: 200 * 1024 * 1024,
  artifactRetentionDays: 7,
  platformGenerationsPerDay: 20,
} as const;
export type OperatingSettings = { -readonly [K in keyof typeof DEFAULT_SETTINGS]: number };

/**
 * Upper bound for the build timeout setting. The build workflow's job timeout is 360 minutes (the GitHub-hosted
 * maximum); the remaining 30 minutes cover checkout, runner setup, and final log upload and reporting.
 */
export const MAX_BUILD_TIMEOUT_MINUTES = 330;

export const TIMING = {
  generationTimeoutMs: 10 * 60_000,
  dispatchStuckMs: 5 * 60_000,
  claimTimeoutMs: int("RUNNER_CLAIM_TIMEOUT_MINUTES", 30) * 60_000,
  unknownDispatchGraceMs: 10 * 60_000,
  heartbeatTimeoutMs: int("RUNNER_HEARTBEAT_TIMEOUT_MINUTES", 10) * 60_000,
  cancelGraceMs: 10 * 60_000,
  capabilityGraceMs: 15 * 60_000,
  presignedUploadSeconds: 15 * 60,
  presignedDownloadSeconds: 10 * 60,
  maxAttemptsPerBuild: 2,
  maxAiAttempts: 3,
  unverifiedArtifactGraceMs: 60 * 60_000,
  incompleteUploadMaxAgeMs: 24 * 60 * 60_000,
};

export function githubAppConfig() {
  const repository = required("GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new ConfigError("GITHUB_REPOSITORY must be owner/name");
  return {
    appId: required("GITHUB_APP_ID"),
    installationId: required("GITHUB_APP_INSTALLATION_ID"),
    privateKey: required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    repository,
    workflowFile: optional("GITHUB_WORKFLOW_FILE") ?? "linxgen-build.yml",
    workflowRef: optional("GITHUB_WORKFLOW_REF") ?? "main",
  };
}

export function runnerTrustConfig() {
  const repository = required("GITHUB_REPOSITORY");
  const workflowFile = optional("GITHUB_WORKFLOW_FILE") ?? "linxgen-build.yml";
  const workflowRef = optional("GITHUB_WORKFLOW_REF") ?? "main";
  const gitRef = workflowRef.startsWith("refs/") ? workflowRef : `refs/heads/${workflowRef}`;
  return {
    issuer: "https://token.actions.githubusercontent.com",
    audience: optional("RUNNER_OIDC_AUDIENCE") ?? "linxgen-runner",
    repository,
    repositoryId: optional("GITHUB_REPOSITORY_ID"),
    workflowRef: `${repository}/.github/workflows/${workflowFile}@${gitRef}`,
    allowedWorkflowShas: (optional("GITHUB_WORKFLOW_SHA_ALLOWLIST") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function runnerSecret(): string {
  const secret = required("RUNNER_CAPABILITY_SECRET");
  if (secret.length < 32) throw new ConfigError("RUNNER_CAPABILITY_SECRET must be at least 32 characters");
  return secret;
}

export function r2Config() {
  return {
    accountId: required("R2_ACCOUNT_ID"),
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    bucket: required("R2_BUCKET"),
  };
}

export function credentialKeyring(): { current: string; keys: Record<string, string> } {
  const raw = required("CREDENTIAL_ENCRYPTION_KEYS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("CREDENTIAL_ENCRYPTION_KEYS must be JSON");
  }
  const ring = parsed as { current?: unknown; keys?: unknown };
  if (typeof ring.current !== "string" || !ring.keys || typeof ring.keys !== "object") {
    throw new ConfigError('CREDENTIAL_ENCRYPTION_KEYS must look like {"current":"v1","keys":{"v1":"<base64 32 bytes>"}}');
  }
  const keys = ring.keys as Record<string, string>;
  if (!keys[ring.current]) throw new ConfigError("Current credential key version is missing from keys");
  return { current: ring.current, keys };
}

export function platformAi() {
  return {
    provider: "ollama" as const,
    apiKey: optional("PLATFORM_OLLAMA_API_KEY"),
    model: optional("PLATFORM_OLLAMA_MODEL") ?? "gpt-oss:120b",
  };
}

export function packageResolutionMode(): "archive" | "runner-only" {
  return optional("PACKAGE_RESOLUTION_MODE") === "runner-only" ? "runner-only" : "archive";
}

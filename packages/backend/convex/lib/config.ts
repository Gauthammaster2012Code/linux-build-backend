import { DEFAULT_ARTIFACT_RETENTION_HOURS, DEFAULT_MAX_STORED_BYTES } from "@linxgen/spec";

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

/** The email of the one account allowed to issue invite codes in the web app. */
export function ownerEmail(): string | undefined {
  return optional("OWNER_EMAIL");
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
  artifactRetentionHours: DEFAULT_ARTIFACT_RETENTION_HOURS,
  maxStoredBytes: DEFAULT_MAX_STORED_BYTES,
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
  /** An active save keeps its files past their expiry for at most this long. */
  saveHoldMaxMs: 6 * 60 * 60_000,
  /** Save jobs end this long after dispatch; the save workflow's job timeout is 120 minutes. */
  saveTimeoutMs: 110 * 60_000,
  /** Presigned GET URLs handed to a save runner. Downloads that start before expiry may run longer. */
  presignedSaveDownloadSeconds: 60 * 60,
  maxAttemptsPerSave: 2,
  connectStateTtlMs: 10 * 60_000,
};

export const SAVE_LIMITS = {
  activePerMember: 1,
  activeGlobal: 2,
  queuedPerMember: 5,
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

export function saveWorkflowFile(): string {
  return optional("GITHUB_SAVE_WORKFLOW_FILE") ?? "linxgen-save.yml";
}

/** The build-dispatch app settings, pointed at the save workflow in the same repository. */
export function saveDispatchConfig() {
  return { ...githubAppConfig(), workflowFile: saveWorkflowFile() };
}

/**
 * OIDC trust for runners. Build and save runners are told apart by the workflow file in the token's
 * `workflow_ref`, so a token from one workflow is never accepted by the other's claim route.
 */
export function runnerTrustConfig(kind: "build" | "save" = "build") {
  const repository = required("GITHUB_REPOSITORY");
  const workflowFile = kind === "save" ? saveWorkflowFile() : (optional("GITHUB_WORKFLOW_FILE") ?? "linxgen-build.yml");
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

/** Backblaze B2 S3 endpoints look like https://s3.<region>.backblazeb2.com; the signing region is part of the host. */
export function deriveB2Region(host: string): string | undefined {
  return host.toLowerCase().match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/)?.[1];
}

export function parseStorageEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("STORAGE_S3_ENDPOINT must be a URL such as https://s3.us-west-004.backblazeb2.com");
  }
  if (url.protocol !== "https:") throw new ConfigError("STORAGE_S3_ENDPOINT must use https");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.username || url.password) {
    throw new ConfigError("STORAGE_S3_ENDPOINT must be an origin without a path, for example https://s3.us-west-004.backblazeb2.com");
  }
  return url;
}

/** S3-compatible temporary storage (Backblaze B2). */
export function storageConfig() {
  const endpoint = parseStorageEndpoint(required("STORAGE_S3_ENDPOINT"));
  const explicitRegion = optional("STORAGE_S3_REGION");
  const region = explicitRegion ?? deriveB2Region(endpoint.hostname);
  if (!region) throw new ConfigError("STORAGE_S3_REGION is required when STORAGE_S3_ENDPOINT is not s3.<region>.backblazeb2.com");
  if (!/^[a-z0-9-]{2,40}$/.test(region)) throw new ConfigError("STORAGE_S3_REGION must look like us-west-004");
  return {
    endpoint: endpoint.origin,
    region,
    accessKeyId: required("STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: required("STORAGE_SECRET_ACCESS_KEY"),
    bucket: required("STORAGE_BUCKET"),
  };
}

export const STORAGE_APP_VARS = [
  "STORAGE_GITHUB_APP_ID",
  "STORAGE_GITHUB_APP_SLUG",
  "STORAGE_GITHUB_APP_CLIENT_ID",
  "STORAGE_GITHUB_APP_CLIENT_SECRET",
  "STORAGE_GITHUB_APP_PRIVATE_KEY",
] as const;

export const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function storageRepoName(): string {
  const name = optional("STORAGE_REPO_NAME") ?? "storage";
  if (!REPO_NAME_PATTERN.test(name) || name === "." || name === "..") throw new ConfigError("STORAGE_REPO_NAME is not a valid repository name");
  return name;
}

/** True when every variable of the "LinxGen Storage" GitHub App is set. Saving to GitHub is optional. */
export function storageAppConfigured(): boolean {
  return STORAGE_APP_VARS.every((name) => Boolean(optional(name)));
}

/** Values the browser may see to start the install or authorization flow. */
export function storageAppPublicConfig() {
  const slug = required("STORAGE_GITHUB_APP_SLUG");
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new ConfigError("STORAGE_GITHUB_APP_SLUG must be the app's URL name");
  return { slug, clientId: required("STORAGE_GITHUB_APP_CLIENT_ID"), siteUrl: optional("SITE_URL") };
}

/** The separate "LinxGen Storage" GitHub App that members install on their personal account. */
export function storageAppConfig() {
  const appId = required("STORAGE_GITHUB_APP_ID");
  if (!/^\d{1,20}$/.test(appId)) throw new ConfigError("STORAGE_GITHUB_APP_ID must be a number");
  return {
    ...storageAppPublicConfig(),
    appId,
    clientSecret: required("STORAGE_GITHUB_APP_CLIENT_SECRET"),
    privateKey: required("STORAGE_GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    repoName: storageRepoName(),
  };
}
export type StorageAppConfig = ReturnType<typeof storageAppConfig>;

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

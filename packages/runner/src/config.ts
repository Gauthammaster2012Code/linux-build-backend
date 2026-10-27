import { readFileSync } from "node:fs";
import path from "node:path";

export interface RunnerEnv {
  apiUrl: string;
  attemptId: string;
  dispatchNonce: string;
  audience: string;
  builderRevision: string;
  oidcRequestUrl: string;
  oidcRequestToken: string;
  workRoot: string;
  builderDir: string;
}

export interface ToolchainLock {
  images: Record<string, string>;
  mirrors: { debian: string; debianSecurity: string; ubuntu: string; ubuntuSecurity: string };
}

export class ConfigurationError extends Error {}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigurationError(`${name} is not set`);
  return value;
}

export function readRunnerEnv(env: NodeJS.ProcessEnv = process.env): RunnerEnv {
  const apiUrl = need(env, "LINXGEN_API_URL").replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(apiUrl)) throw new ConfigurationError("LINXGEN_API_URL must be an https origin");
  const attemptId = need(env, "LINXGEN_ATTEMPT_ID");
  if (!/^[A-Za-z0-9]{1,64}$/.test(attemptId)) throw new ConfigurationError("LINXGEN_ATTEMPT_ID is malformed");
  const builderRevision = need(env, "GITHUB_SHA");
  if (!/^[a-f0-9]{40}$/.test(builderRevision)) throw new ConfigurationError("GITHUB_SHA is malformed");
  const workspace = need(env, "GITHUB_WORKSPACE");
  return {
    apiUrl,
    attemptId,
    dispatchNonce: need(env, "LINXGEN_DISPATCH_NONCE"),
    audience: env.LINXGEN_OIDC_AUDIENCE || "linxgen-runner",
    builderRevision,
    oidcRequestUrl: need(env, "ACTIONS_ID_TOKEN_REQUEST_URL"),
    oidcRequestToken: need(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    workRoot: path.join(env.LINXGEN_WORK_ROOT || need(env, "RUNNER_TEMP"), "linxgen"),
    builderDir: path.join(workspace, "builder"),
  };
}

export function readToolchainLock(builderDir: string): ToolchainLock {
  const lock = JSON.parse(readFileSync(path.join(builderDir, "toolchain.lock.json"), "utf8")) as ToolchainLock;
  for (const [key, image] of Object.entries(lock.images)) {
    if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new ConfigurationError(`toolchain image ${key} is not pinned by digest`);
  }
  return lock;
}

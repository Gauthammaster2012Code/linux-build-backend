import { SignJWT, importPKCS8 } from "jose";
import { base64ToBytes, bytesToBase64 } from "./crypto";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** True when we cannot tell whether GitHub acted on the request (network failure, timeout, 5xx). */
    readonly ambiguous: boolean,
  ) {
    super(message);
  }
}

function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** GitHub App keys are PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto only imports PKCS#8, so wrap the key. */
export function pkcs1ToPkcs8Pem(pem: string): string {
  if (pem.includes("BEGIN PRIVATE KEY")) return pem;
  const b64 = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const pkcs1 = base64ToBytes(b64);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const octet = concat(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const body = concat(version, algorithm, octet);
  const der = concat(Uint8Array.of(0x30), derLength(body.length), body);
  const lines = bytesToBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

export async function createAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const key = await importPKCS8(pkcs1ToPkcs8Pem(privateKeyPem), "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(appId)
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + 9 * 60)
    .sign(key);
}

type FetchLike = typeof fetch;

async function gh(fetchImpl: FetchLike, token: string, method: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "linxgen-v2",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new GitHubError(`GitHub request failed: ${(e as Error).name}`, null, true);
  }
  return res;
}

async function errorFrom(res: Response, what: string): Promise<GitHubError> {
  let detail = "";
  try {
    detail = ((await res.json()) as { message?: string }).message ?? "";
  } catch {
    // ignore body parse failures
  }
  return new GitHubError(`${what} failed with ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`, res.status, res.status >= 500);
}

export interface GitHubAppSettings {
  appId: string;
  installationId: string;
  privateKey: string;
  repository: string;
  workflowFile: string;
  workflowRef: string;
}

/** Installation token restricted to the build repository and the actions permission. */
export async function installationToken(cfg: GitHubAppSettings, fetchImpl: FetchLike = fetch): Promise<string> {
  const jwt = await createAppJwt(cfg.appId, cfg.privateKey);
  const repoName = cfg.repository.split("/")[1];
  const res = await gh(fetchImpl, jwt, "POST", `/app/installations/${cfg.installationId}/access_tokens`, {
    repositories: [repoName],
    permissions: { actions: "write" },
  });
  if (!res.ok) throw await errorFrom(res, "Installation token request");
  return ((await res.json()) as { token: string }).token;
}

export function runNameFor(attemptId: string) {
  return `LinxGen attempt ${attemptId}`;
}

export async function dispatchWorkflow(
  cfg: GitHubAppSettings,
  token: string,
  inputs: { attempt_id: string; dispatch_nonce: string },
  fetchImpl: FetchLike = fetch,
): Promise<{ runId?: string }> {
  const path = `/repos/${cfg.repository}/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/dispatches`;
  let res = await gh(fetchImpl, token, "POST", path, { ref: cfg.workflowRef, inputs, return_run_details: true });
  if (res.status === 422) {
    const text = await res.clone().text();
    if (text.includes("return_run_details")) {
      res = await gh(fetchImpl, token, "POST", path, { ref: cfg.workflowRef, inputs });
    }
  }
  if (res.status === 204) return {};
  if (res.status === 200) {
    const body = (await res.json().catch(() => ({}))) as { workflow_run_id?: number };
    return body.workflow_run_id ? { runId: String(body.workflow_run_id) } : {};
  }
  throw await errorFrom(res, "Workflow dispatch");
}

export interface WorkflowRunInfo {
  id: string;
  status: string;
  conclusion: string | null;
  displayTitle: string;
  runAttempt: number;
}

function toRunInfo(r: { id: number; status: string; conclusion: string | null; display_title: string; run_attempt: number }): WorkflowRunInfo {
  return { id: String(r.id), status: r.status, conclusion: r.conclusion, displayTitle: r.display_title, runAttempt: r.run_attempt };
}

export async function getWorkflowRun(cfg: GitHubAppSettings, token: string, runId: string, fetchImpl: FetchLike = fetch) {
  const res = await gh(fetchImpl, token, "GET", `/repos/${cfg.repository}/actions/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await errorFrom(res, "Get workflow run");
  return toRunInfo(await res.json());
}

export async function findRunForAttempt(
  cfg: GitHubAppSettings,
  token: string,
  attemptId: string,
  createdAfterMs: number,
  fetchImpl: FetchLike = fetch,
): Promise<WorkflowRunInfo | null> {
  const since = new Date(createdAfterMs - 5 * 60_000).toISOString();
  const path =
    `/repos/${cfg.repository}/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/runs` +
    `?event=workflow_dispatch&per_page=100&created=${encodeURIComponent(`>=${since}`)}`;
  const res = await gh(fetchImpl, token, "GET", path);
  if (!res.ok) throw await errorFrom(res, "List workflow runs");
  const body = (await res.json()) as { workflow_runs: Parameters<typeof toRunInfo>[0][] };
  const match = body.workflow_runs.find((r) => r.display_title === runNameFor(attemptId));
  return match ? toRunInfo(match) : null;
}

export async function cancelWorkflowRun(cfg: GitHubAppSettings, token: string, runId: string, fetchImpl: FetchLike = fetch) {
  const res = await gh(fetchImpl, token, "POST", `/repos/${cfg.repository}/actions/runs/${encodeURIComponent(runId)}/cancel`);
  // 409 means the run already finished.
  if (res.ok || res.status === 409) return;
  throw await errorFrom(res, "Cancel workflow run");
}

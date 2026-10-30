import { STORAGE_REPO_DESCRIPTION, STORAGE_REPO_TOPIC } from "@linxgen/spec";
import type { StorageAppConfig } from "./config";
import { createAppJwt, errorFrom, gh, GitHubError, type FetchLike } from "./github";

/**
 * GitHub calls for the "LinxGen Storage" app. User access tokens come from the OAuth code exchange, are used only
 * while connecting (to identify the member and create the repository) and are never stored.
 */

export interface GitHubUser {
  id: number;
  login: string;
  type: string;
}

export interface StorageInstallation {
  id: number;
  repositorySelection: "all" | "selected";
  suspended: boolean;
}

export interface StorageRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  private: boolean;
  archived: boolean;
  topics: string[];
  ownerId: number;
}

export async function exchangeOAuthCode(
  cfg: Pick<StorageAppConfig, "clientId" | "clientSecret">,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "linxgen-v2" },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new GitHubError(`GitHub authorization request failed: ${(e as Error).name}`, null, true);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    // GitHub answers 200 with an error code (for example bad_verification_code) when the code is invalid or used.
    throw new GitHubError(`GitHub authorization failed: ${body.error ?? res.status}`, res.ok ? 400 : res.status, res.status >= 500);
  }
  return body.access_token;
}

export async function getAuthenticatedUser(token: string, fetchImpl: FetchLike = fetch): Promise<GitHubUser> {
  const res = await gh(fetchImpl, token, "GET", "/user");
  if (!res.ok) throw await errorFrom(res, "Get user");
  const body = (await res.json()) as { id: number; login: string; type: string };
  return { id: body.id, login: body.login, type: body.type };
}

/**
 * The storage app's installation on the user's own account, found through the user's token. The installation_id
 * query parameter of the setup redirect is never trusted: anyone can edit it.
 */
export async function findUserInstallation(
  token: string,
  appId: string,
  user: GitHubUser,
  fetchImpl: FetchLike = fetch,
): Promise<StorageInstallation | null> {
  for (let page = 1; page <= 5; page++) {
    const res = await gh(fetchImpl, token, "GET", `/user/installations?per_page=100&page=${page}`);
    if (!res.ok) throw await errorFrom(res, "List installations");
    const body = (await res.json()) as {
      installations: {
        id: number;
        app_id: number;
        target_type: string;
        account: { id: number; login: string } | null;
        repository_selection: "all" | "selected";
        suspended_at: string | null;
      }[];
    };
    const match = body.installations.find(
      (i) => String(i.app_id) === appId && i.target_type === "User" && i.account?.id === user.id,
    );
    if (match) return { id: match.id, repositorySelection: match.repository_selection, suspended: Boolean(match.suspended_at) };
    if (body.installations.length < 100) break;
  }
  return null;
}

function toRepo(r: {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  archived?: boolean;
  topics?: string[];
  owner: { login: string; id: number };
}): StorageRepo {
  return {
    id: r.id,
    owner: r.owner.login,
    ownerId: r.owner.id,
    name: r.name,
    fullName: r.full_name,
    htmlUrl: r.html_url,
    private: r.private,
    archived: Boolean(r.archived),
    topics: r.topics ?? [],
  };
}

export async function getRepo(token: string, owner: string, name: string, fetchImpl: FetchLike = fetch): Promise<StorageRepo | null> {
  const res = await gh(fetchImpl, token, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await errorFrom(res, "Get repository");
  return toRepo(await res.json());
}

export type EnsureRepoResult =
  | { ok: true; repo: StorageRepo; created: boolean }
  | { ok: false; code: "repo_name_taken" | "repo_public" | "repo_archived" | "needs_all_repositories"; message: string };

/**
 * Finds or creates the member's private storage repository. An existing repository is adopted only if it carries the
 * LinxGen topic; any other repository with the same name is left untouched.
 */
export async function ensureStorageRepo(
  token: string,
  user: GitHubUser,
  repoName: string,
  installation: StorageInstallation,
  fetchImpl: FetchLike = fetch,
): Promise<EnsureRepoResult> {
  const existing = await getRepo(token, user.login, repoName, fetchImpl);
  if (existing) {
    if (existing.ownerId !== user.id || !existing.topics.includes(STORAGE_REPO_TOPIC)) {
      return {
        ok: false,
        code: "repo_name_taken",
        message: `You already have a repository named ${repoName} that LinxGen did not create, so LinxGen will not use it. Rename it, or add the topic "${STORAGE_REPO_TOPIC}" if it is meant for LinxGen builds.`,
      };
    }
    if (!existing.private) {
      return { ok: false, code: "repo_public", message: `${existing.fullName} is public. Make it private before saving builds to it.` };
    }
    if (existing.archived) return { ok: false, code: "repo_archived", message: `${existing.fullName} is archived. Unarchive it first.` };
    return { ok: true, repo: existing, created: false };
  }
  if (installation.repositorySelection !== "all") {
    return {
      ok: false,
      code: "needs_all_repositories",
      message: `LinxGen Storage can only reach the repositories you selected, so it cannot create ${user.login}/${repoName}. Give it access to all repositories, or create a private repository named ${repoName} with the topic "${STORAGE_REPO_TOPIC}" and add it to the app.`,
    };
  }
  const res = await gh(fetchImpl, token, "POST", "/user/repos", {
    name: repoName,
    description: STORAGE_REPO_DESCRIPTION,
    private: true,
    auto_init: true,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  });
  if (!res.ok) throw await errorFrom(res, "Create storage repository");
  const repo = toRepo(await res.json());
  const topics = await gh(fetchImpl, token, "PUT", `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/topics`, {
    names: [STORAGE_REPO_TOPIC],
  });
  if (!topics.ok) throw await errorFrom(topics, "Set repository topics");
  return { ok: true, repo: { ...repo, topics: [STORAGE_REPO_TOPIC] }, created: true };
}

/** One-hour installation token that can write contents of the storage repository and nothing else. */
export async function storageRepoToken(
  cfg: Pick<StorageAppConfig, "appId" | "privateKey">,
  installationId: number,
  repoId: number,
  fetchImpl: FetchLike = fetch,
): Promise<{ token: string; expiresAt: number }> {
  const jwt = await createAppJwt(cfg.appId, cfg.privateKey);
  const res = await gh(fetchImpl, jwt, "POST", `/app/installations/${installationId}/access_tokens`, {
    repository_ids: [repoId],
    permissions: { contents: "write", metadata: "read" },
  });
  if (!res.ok) throw await errorFrom(res, "Storage installation token request");
  const body = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = Date.parse(body.expires_at);
  return { token: body.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 55 * 60_000 };
}

/** The app itself, as GitHub describes it to the app's own JWT. Used by the setup check. */
export async function getStorageApp(cfg: Pick<StorageAppConfig, "appId" | "privateKey">, fetchImpl: FetchLike = fetch) {
  const jwt = await createAppJwt(cfg.appId, cfg.privateKey);
  const res = await gh(fetchImpl, jwt, "GET", "/app");
  if (!res.ok) throw await errorFrom(res, "Get storage app");
  const body = (await res.json()) as { slug: string; permissions?: Record<string, string> };
  return { slug: body.slug, permissions: body.permissions ?? {} };
}

/** Classifies a failed storage-token request: the installation is gone or suspended, or the repository is out of reach. */
export function storageTokenFailure(e: unknown): "github_unauthorized" | "repo_missing" | null {
  if (!(e instanceof GitHubError) || e.ambiguous) return null;
  if (e.status === 422) return "repo_missing";
  if (e.status === 401 || e.status === 403 || e.status === 404) return "github_unauthorized";
  return null;
}

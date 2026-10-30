import { describe, expect, it, vi } from "vitest";
import { STORAGE_REPO_TOPIC } from "@linxgen/spec";
import { GitHubError } from "../convex/lib/github";
import { ensureStorageRepo, findUserInstallation, storageRepoToken, storageTokenFailure } from "../convex/lib/githubStorage";

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

function fakeGitHub(handler: Handler) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    calls.push({ method: req.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : undefined, auth: req.headers.get("authorization") });
    return handler(req, url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const user = { id: 42, login: "octo", type: "User" };
const repoJson = (over: Record<string, unknown> = {}) => ({
  id: 7,
  name: "storage",
  full_name: "octo/storage",
  html_url: "https://github.com/octo/storage",
  private: true,
  archived: false,
  topics: [STORAGE_REPO_TOPIC],
  owner: { login: "octo", id: 42 },
  ...over,
});

describe("storage app installation lookup", () => {
  it("matches only this app on the user's own account", async () => {
    const { fetchImpl } = fakeGitHub(() =>
      Response.json({
        installations: [
          { id: 1, app_id: 999, target_type: "User", account: { id: 42, login: "octo" }, repository_selection: "all", suspended_at: null },
          { id: 2, app_id: 555, target_type: "Organization", account: { id: 77, login: "org" }, repository_selection: "all", suspended_at: null },
          { id: 3, app_id: 555, target_type: "User", account: { id: 42, login: "octo" }, repository_selection: "selected", suspended_at: null },
        ],
      }),
    );
    expect(await findUserInstallation("ghu_x", "555", user, fetchImpl)).toEqual({ id: 3, repositorySelection: "selected", suspended: false });
    expect(await findUserInstallation("ghu_x", "1234", user, fetchImpl)).toBeNull();
  });
});

describe("storage repository", () => {
  const all = { id: 3, repositorySelection: "all" as const, suspended: false };

  it("adopts an existing private repository that carries the LinxGen topic", async () => {
    const { fetchImpl, calls } = fakeGitHub(() => Response.json(repoJson()));
    const r = await ensureStorageRepo("ghu_x", user, "storage", all, fetchImpl);
    expect(r).toMatchObject({ ok: true, created: false, repo: { id: 7, fullName: "octo/storage" } });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("never touches a same-named repository LinxGen did not create", async () => {
    const { fetchImpl, calls } = fakeGitHub(() => Response.json(repoJson({ topics: ["dotfiles"] })));
    expect(await ensureStorageRepo("ghu_x", user, "storage", all, fetchImpl)).toMatchObject({ ok: false, code: "repo_name_taken" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses a public storage repository", async () => {
    const { fetchImpl } = fakeGitHub(() => Response.json(repoJson({ private: false })));
    expect(await ensureStorageRepo("ghu_x", user, "storage", all, fetchImpl)).toMatchObject({ ok: false, code: "repo_public" });
  });

  it("creates a private, initialized repository and marks it with the topic", async () => {
    const { fetchImpl, calls } = fakeGitHub((req, url) => {
      if (req.method === "GET") return Response.json({ message: "Not Found" }, { status: 404 });
      if (url.pathname === "/user/repos") return Response.json(repoJson({ topics: [] }), { status: 201 });
      return Response.json({ names: [STORAGE_REPO_TOPIC] });
    });
    const r = await ensureStorageRepo("ghu_x", user, "storage", all, fetchImpl);
    expect(r).toMatchObject({ ok: true, created: true });
    const create = calls.find((c) => c.path === "/user/repos")!;
    expect(create.body).toMatchObject({ name: "storage", private: true, auto_init: true });
    const topics = calls.find((c) => c.path === "/repos/octo/storage/topics")!;
    expect(topics).toMatchObject({ method: "PUT", body: { names: [STORAGE_REPO_TOPIC] } });
  });

  it("does not try to create a repository the installation could not reach", async () => {
    const { fetchImpl, calls } = fakeGitHub(() => Response.json({ message: "Not Found" }, { status: 404 }));
    const r = await ensureStorageRepo("ghu_x", user, "storage", { ...all, repositorySelection: "selected" }, fetchImpl);
    expect(r).toMatchObject({ ok: false, code: "needs_all_repositories" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("storage repository tokens", () => {
  it("requests a token limited to the repository and contents write", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const { fetchImpl, calls } = fakeGitHub(() => Response.json({ token: "ghs_repo", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 }));
    const t = await storageRepoToken({ appId: "555", privateKey }, 3, 7, fetchImpl);
    expect(t).toEqual({ token: "ghs_repo", expiresAt: Date.parse("2030-01-01T00:00:00Z") });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/app/installations/3/access_tokens",
      body: { repository_ids: [7], permissions: { contents: "write", metadata: "read" } },
    });
  });

  it("classifies refused token requests", () => {
    expect(storageTokenFailure(new GitHubError("x", 404, false))).toBe("github_unauthorized");
    expect(storageTokenFailure(new GitHubError("x", 403, false))).toBe("github_unauthorized");
    expect(storageTokenFailure(new GitHubError("x", 422, false))).toBe("repo_missing");
    expect(storageTokenFailure(new GitHubError("x", 502, true))).toBeNull();
    expect(storageTokenFailure(new Error("x"))).toBeNull();
  });
});

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { backoffMs, sleep, type FetchLike } from "./http";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

type Body = NonNullable<RequestInit["body"]>;
type RawRelease = { id: number; html_url: string; body?: string | null };

/** A GitHub response the save cannot continue past. `status` is null for network failures. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface Release {
  id: number;
  htmlUrl: string;
  body: string;
}

export interface Asset {
  id: number;
  name: string;
  size: number;
  state: string;
}

/** Supplies the repository token, refreshing it before it expires or after GitHub rejects it. */
export interface TokenSource {
  get(): Promise<string>;
  refresh(): Promise<string>;
}

/**
 * Release calls against the member's storage repository with a token that can only write that repository's contents.
 * Error messages carry status codes and GitHub's message text, never the token or the repository name.
 */
export class ReleaseClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly tokens: TokenSource,
    private readonly owner: string,
    private readonly repo: string,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  private async send(
    what: string,
    url: string,
    init: { method: string; json?: unknown; body?: () => Body; headers?: Record<string, string>; timeoutMs?: number; noRetry?: boolean },
    accept: number[] = [],
  ): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.get();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: init.method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "linxgen-save",
            ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
          body: init.json !== undefined ? JSON.stringify(init.json) : init.body?.(),
          signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
          ...(init.body ? { duplex: "half" } : {}),
        } as RequestInit);
      } catch (e) {
        if (attempt < 3 && !init.noRetry) {
          await this.wait(backoffMs(attempt));
          continue;
        }
        throw new GitHubApiError(`${what} failed: ${(e as Error).name}`, null);
      }
      if (res.ok || accept.includes(res.status)) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.tokens.refresh();
        continue;
      }
      if ((res.status >= 500 || res.status === 429) && attempt < 3 && !init.noRetry) {
        await res.body?.cancel();
        await this.wait(backoffMs(attempt, 2000));
        continue;
      }
      let detail = "";
      try {
        detail = String(((await res.json()) as { message?: unknown }).message ?? "").slice(0, 200);
      } catch {
        // non-JSON error body
      }
      throw new GitHubApiError(`${what} failed with ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
  }

  async findReleaseByTag(tag: string): Promise<Release | null> {
    const res = await this.send("Find release", `${API}${this.repoPath}/releases/tags/${encodeURIComponent(tag)}`, { method: "GET" }, [404]);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    return toRelease((await res.json()) as RawRelease);
  }

  async createRelease(input: { tag: string; name: string; body: string }): Promise<Release> {
    const res = await this.send("Create release", `${API}${this.repoPath}/releases`, {
      method: "POST",
      json: { tag_name: input.tag, name: input.name, body: input.body, draft: false, prerelease: false, make_latest: "false" },
    });
    return toRelease((await res.json()) as RawRelease);
  }

  async updateRelease(id: number, body: string): Promise<Release> {
    const res = await this.send("Update release", `${API}${this.repoPath}/releases/${id}`, { method: "PATCH", json: { body } });
    return toRelease((await res.json()) as RawRelease);
  }

  async listAssets(releaseId: number): Promise<Asset[]> {
    const out: Asset[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.send("List release assets", `${API}${this.repoPath}/releases/${releaseId}/assets?per_page=100&page=${page}`, {
        method: "GET",
      });
      const items = (await res.json()) as { id: number; name: string; size: number; state: string }[];
      out.push(...items.map((a) => ({ id: a.id, name: a.name, size: a.size, state: a.state })));
      if (items.length < 100) break;
    }
    return out;
  }

  async deleteAsset(assetId: number): Promise<void> {
    const res = await this.send("Delete release asset", `${API}${this.repoPath}/releases/assets/${assetId}`, { method: "DELETE" }, [404]);
    await res.body?.cancel();
  }

  /** Streams bytes [start, start + size) of a local file as one release asset. */
  async uploadAsset(releaseId: number, name: string, file: string, start: number, size: number): Promise<Asset> {
    const url = new URL(`${UPLOADS}${this.repoPath}/releases/${releaseId}/assets`);
    url.searchParams.set("name", name);
    const res = await this.send("Upload release asset", url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) },
      body: () =>
        size === 0
          ? new Uint8Array()
          : (Readable.toWeb(createReadStream(file, { start, end: start + size - 1, highWaterMark: 4 * 1024 * 1024 })) as unknown as Body),
      timeoutMs: 60 * 60_000,
      // A failed upload can leave a partial asset under the same name; the caller removes it before trying again.
      noRetry: true,
    });
    const asset = (await res.json()) as { id: number; name: string; size: number; state: string };
    return { id: asset.id, name: asset.name, size: asset.size, state: asset.state };
  }
}

function toRelease(r: RawRelease): Release {
  return { id: r.id, htmlUrl: r.html_url, body: r.body ?? "" };
}

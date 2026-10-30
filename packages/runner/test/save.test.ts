import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SaveClaimResponse, SaveFinishRequest, SaveProgressRequest } from "@linxgen/spec";
import { describe, expect, it, vi } from "vitest";
import { isSaveMode, readSaveEnv } from "../src/config";
import { ApiError } from "../src/http";
import { checksumFile, planAssets, runSave } from "../src/save";
import type { SaveApiClient } from "../src/saveApi";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const TOKEN = "ghs_installationtokenvalue0001";
const TOKEN2 = "ghs_installationtokenvalue0002";
const MARKER = "<!-- linxgen-build:b1 -->";

interface FakeAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  data: Buffer;
}
interface FakeRelease {
  id: number;
  tag: string;
  name: string;
  body: string;
  assets: FakeAsset[];
}

interface Options {
  contents?: Record<string, string>;
  /** Recorded hashes that differ from the stored bytes. */
  wrongSha?: string[];
  /** Status codes the first download requests get, in order, before storage answers normally. */
  downloadFailures?: number[];
  /** Status codes every download gets after the URL refresh. */
  downloadAfterRefresh?: number;
  existingRelease?: Omit<FakeRelease, "id">;
  /** GitHub answers 401 to the first N API calls made with the first token. */
  unauthorizedCalls?: number;
  rejectEveryToken?: boolean;
  /** Upload attempts (by asset name) that fail with this status the first time. */
  failUploadOnce?: Record<string, number>;
  cancelOnProgress?: boolean;
}

function setup(opts: Options = {}) {
  const contents = opts.contents ?? { "box.iso": "i".repeat(25), "box.iso.packages.txt": "pkgs\n" };
  const files = Object.entries(contents).map(([fileName, body]) => ({
    kind: fileName.endsWith(".iso") ? ("iso" as const) : ("manifest" as const),
    fileName,
    sizeBytes: Buffer.byteLength(body),
    sha256: opts.wrongSha?.includes(fileName) ? "0".repeat(64) : sha(body),
    url: `https://storage.test/bucket/${fileName}?X-Amz-Signature=old`,
  }));
  const claim: SaveClaimResponse = {
    capability: "save-capability-secret",
    capabilityExpiresAt: Date.now() + 3_600_000,
    saveAttemptId: "sat1",
    deadlineAt: Date.now() + 3_600_000,
    files,
    release: { owner: "octo-member", repo: "linxgen-builds", tag: "linxgen-b1b1", name: "Box (b1)", body: `Box build\n\n${MARKER}`, marker: MARKER },
    github: { token: TOKEN, expiresAt: Date.now() + 3_600_000 },
  };
  const progress: SaveProgressRequest[] = [];
  const finish = vi.fn(async (_body: SaveFinishRequest) => ({ saveStatus: "succeeded" }));
  const api: SaveApiClient = {
    claim: vi.fn(async () => claim),
    files: vi.fn(async () => ({ files: files.map((f) => ({ ...f, url: f.url.replace("old", "new") })) })),
    token: vi.fn(async () => ({ token: TOKEN2, expiresAt: Date.now() + 3_600_000 })),
    progress: vi.fn(async (b: SaveProgressRequest) => {
      progress.push(b);
      return { ok: true, cancelRequested: Boolean(opts.cancelOnProgress) };
    }),
    finish,
  };

  const releases: FakeRelease[] = [];
  let nextId = 100;
  if (opts.existingRelease) releases.push({ id: nextId++, ...opts.existingRelease });
  const downloadFailures = [...(opts.downloadFailures ?? [])];
  const failUploadOnce = { ...opts.failUploadOnce };
  let unauthorized = opts.unauthorizedCalls ?? 0;
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const releaseJson = (r: FakeRelease) => ({ id: r.id, html_url: `https://github.com/octo-member/linxgen-builds/releases/tag/${r.tag}`, body: r.body });
  const assetJson = (a: FakeAsset) => ({ id: a.id, name: a.name, size: a.size, state: a.state });

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === "storage.test") {
      const fail = downloadFailures.shift();
      if (fail) return new Response("denied", { status: fail });
      if (url.searchParams.get("X-Amz-Signature") === "new" && opts.downloadAfterRefresh) return new Response("gone", { status: opts.downloadAfterRefresh });
      const name = url.pathname.split("/").at(-1)!;
      return new Response(contents[name]);
    }
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (opts.rejectEveryToken || (auth === `Bearer ${TOKEN}` && unauthorized > 0)) {
      unauthorized--;
      return json({ message: "Bad credentials" }, 401);
    }
    const p = url.pathname.replace("/repos/octo-member/linxgen-builds", "");
    let m: RegExpMatchArray | null;
    if (url.host === "uploads.github.com" && (m = p.match(/^\/releases\/(\d+)\/assets$/))) {
      const rel = releases.find((r) => r.id === Number(m![1]))!;
      const name = url.searchParams.get("name")!;
      const data = Buffer.from(await new Response(init!.body as ConstructorParameters<typeof Response>[0]).arrayBuffer());
      if (failUploadOnce[name]) {
        const status = failUploadOnce[name];
        delete failUploadOnce[name];
        // GitHub can keep a partial asset behind after a failed upload.
        rel.assets.push({ id: nextId++, name, size: 1, state: "starter", data: data.subarray(0, 1) });
        return json({ message: "upload broke" }, status);
      }
      if (rel.assets.some((a) => a.name === name)) return json({ message: "already_exists" }, 422);
      const asset = { id: nextId++, name, size: data.length, state: "uploaded", data };
      rel.assets.push(asset);
      return json(assetJson(asset), 201);
    }
    if (method === "GET" && (m = p.match(/^\/releases\/tags\/(.+)$/))) {
      const rel = releases.find((r) => r.tag === decodeURIComponent(m![1]!));
      return rel ? json(releaseJson(rel)) : json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && p === "/releases") {
      const body = JSON.parse(String(init!.body)) as { tag_name: string; name: string; body: string };
      const rel = { id: nextId++, tag: body.tag_name, name: body.name, body: body.body, assets: [] };
      releases.push(rel);
      return json(releaseJson(rel), 201);
    }
    if (method === "PATCH" && (m = p.match(/^\/releases\/(\d+)$/))) {
      const rel = releases.find((r) => r.id === Number(m![1]))!;
      rel.body = (JSON.parse(String(init!.body)) as { body: string }).body;
      return json(releaseJson(rel));
    }
    if (method === "GET" && (m = p.match(/^\/releases\/(\d+)\/assets$/))) {
      const rel = releases.find((r) => r.id === Number(m![1]))!;
      return json(rel.assets.map(assetJson));
    }
    if (method === "DELETE" && (m = p.match(/^\/releases\/assets\/(\d+)$/))) {
      for (const rel of releases) rel.assets = rel.assets.filter((a) => a.id !== Number(m![1]));
      return new Response(null, { status: 204 });
    }
    return json({ message: `unexpected ${method} ${p}` }, 500);
  }) as unknown as typeof fetch;

  const lines: string[] = [];
  const masked: string[] = [];
  const workRoot = mkdtempSync(path.join(tmpdir(), "linxgen-save-"));
  const deps = {
    env: {
      apiUrl: "https://api.test",
      saveAttemptId: "sat1",
      dispatchNonce: "n".repeat(43),
      audience: "linxgen-runner",
      oidcRequestUrl: "https://oidc.test/token",
      oidcRequestToken: "req",
      workRoot,
    },
    api,
    getOidcToken: async () => "oidc-token-value",
    console: (l: string) => lines.push(l),
    mask: (s: string) => masked.push(s),
    fetchImpl,
    splitBytes: 10,
    wait: async () => undefined,
  };
  return { deps, api, claim, finish, progress, releases, calls, lines, masked, contents };
}

const finished = (t: ReturnType<typeof setup>) => t.finish.mock.calls[0]![0];

describe("planAssets", () => {
  it("keeps small files whole and splits large ones into numbered parts", () => {
    const items = planAssets(
      [
        { fileName: "a.iso", sizeBytes: 25 },
        { fileName: "b.txt", sizeBytes: 10 },
      ],
      "/w",
      10,
    );
    expect(items).toEqual([
      { name: "a.iso.part01", file: "/w/a.iso", start: 0, size: 10 },
      { name: "a.iso.part02", file: "/w/a.iso", start: 10, size: 10 },
      { name: "a.iso.part03", file: "/w/a.iso", start: 20, size: 5 },
      { name: "b.txt", file: "/w/b.txt", start: 0, size: 10 },
    ]);
  });

  it("lists checksums in sha256sum format for the original files", () => {
    expect(checksumFile([{ fileName: "a.iso", sha256: "ab".repeat(32) }])).toBe(`${"ab".repeat(32)}  a.iso\n`);
  });
});

describe("readSaveEnv", () => {
  const base = {
    LINXGEN_API_URL: "https://x.convex.site/",
    LINXGEN_SAVE_ATTEMPT_ID: "abc123",
    LINXGEN_DISPATCH_NONCE: "n".repeat(43),
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
    RUNNER_TEMP: "/tmp/r",
  };
  it("selects save mode only for the save workflow", () => {
    expect(isSaveMode(base)).toBe(true);
    expect(isSaveMode({ LINXGEN_ATTEMPT_ID: "a" })).toBe(false);
  });
  it("reads and validates the save environment", () => {
    expect(readSaveEnv(base)).toMatchObject({ apiUrl: "https://x.convex.site", saveAttemptId: "abc123", workRoot: "/tmp/r/linxgen-save" });
    expect(() => readSaveEnv({ ...base, LINXGEN_SAVE_ATTEMPT_ID: "../x" })).toThrow(/malformed/);
    expect(() => readSaveEnv({ ...base, LINXGEN_API_URL: "http://x" })).toThrow(/https/);
  });
});

describe("runSave", () => {
  it("uploads split parts and SHA256SUMS to a new release, then publishes it", async () => {
    const t = setup();
    const res = await runSave(t.deps);
    expect(res).toMatchObject({ finished: true, status: "succeeded" });
    const body = finished(t);
    expect(body).toMatchObject({ status: "succeeded", assetCount: 5, releaseUrl: "https://github.com/octo-member/linxgen-builds/releases/tag/linxgen-b1b1" });
    const rel = t.releases[0]!;
    expect(rel.body).toBe(t.claim.release.body);
    expect(rel.assets.map((a) => a.name)).toEqual(["box.iso.part01", "box.iso.part02", "box.iso.part03", "box.iso.packages.txt", "SHA256SUMS"]);
    const joined = Buffer.concat(rel.assets.filter((a) => a.name.startsWith("box.iso.part")).map((a) => a.data)).toString();
    expect(joined).toBe(t.contents["box.iso"]);
    const sums = rel.assets.find((a) => a.name === "SHA256SUMS")!.data.toString();
    expect(sums).toBe(`${sha(t.contents["box.iso"]!)}  box.iso\n${sha(t.contents["box.iso.packages.txt"]!)}  box.iso.packages.txt\n`);
    expect(new Set(t.progress.map((p) => p.phase))).toEqual(new Set(["downloading", "uploading", "publishing"]));
    expect(t.progress.map((p) => p.seq)).toEqual(t.progress.map((_, i) => i));
    // The work directory is removed afterwards.
    expect(existsSync(path.join(t.deps.env.workRoot, "sat1"))).toBe(false);
  });

  it("masks secrets and keeps tokens and the repository out of the job log", async () => {
    const t = setup({ unauthorizedCalls: 1 });
    await runSave(t.deps);
    expect(t.masked).toEqual(expect.arrayContaining(["oidc-token-value", "n".repeat(43), "save-capability-secret", TOKEN, TOKEN2, "octo-member/linxgen-builds", "octo-member"]));
    const log = t.lines.join("\n");
    for (const secret of [TOKEN, TOKEN2, "save-capability-secret", "octo-member", "X-Amz-Signature", "oidc-token-value"]) expect(log).not.toContain(secret);
  });

  it("refreshes the repository token once when GitHub rejects it", async () => {
    const t = setup({ unauthorizedCalls: 1 });
    await runSave(t.deps);
    expect(t.api.token).toHaveBeenCalledTimes(1);
    expect(finished(t).status).toBe("succeeded");
  });

  it("reports github_unauthorized when a fresh token is also rejected", async () => {
    const t = setup({ rejectEveryToken: true });
    await runSave(t.deps);
    expect(finished(t)).toMatchObject({ status: "failed", failure: { code: "github_unauthorized" } });
  });

  it("refuses files whose bytes do not match the recorded SHA-256", async () => {
    const t = setup({ wrongSha: ["box.iso.packages.txt"] });
    await runSave(t.deps);
    expect(finished(t)).toMatchObject({ status: "failed", failure: { code: "checksum_mismatch" } });
    expect(t.calls.some((c) => c.includes("github.com"))).toBe(false);
  });

  it("requests fresh download URLs when storage refuses an expired one", async () => {
    const t = setup({ downloadFailures: [403] });
    await runSave(t.deps);
    expect(t.api.files).toHaveBeenCalledTimes(1);
    expect(finished(t).status).toBe("succeeded");
  });

  it("reports storage_expired when the object is gone", async () => {
    const t = setup({ downloadFailures: [404], downloadAfterRefresh: 404 });
    await runSave(t.deps);
    expect(finished(t)).toMatchObject({ status: "failed", failure: { code: "storage_expired" } });
  });

  it("reuses its own release, skips finished assets and replaces partial ones", async () => {
    const parts = setup().contents["box.iso"]!;
    const t = setup({
      existingRelease: {
        tag: "linxgen-b1b1",
        name: "Box (b1)",
        body: `Box build\n\n${MARKER}\n\n_Upload in progress._`,
        assets: [
          { id: 1, name: "box.iso.part01", size: 10, state: "uploaded", data: Buffer.from(parts.slice(0, 10)) },
          { id: 2, name: "box.iso.part02", size: 3, state: "starter", data: Buffer.from("iii") },
        ],
      },
    });
    await runSave(t.deps);
    expect(finished(t).status).toBe("succeeded");
    expect(t.releases).toHaveLength(1);
    expect(t.calls.filter((c) => c.startsWith("POST api.github.com"))).toHaveLength(0);
    const uploads = t.calls.filter((c) => c.startsWith("POST uploads.github.com"));
    expect(uploads).toHaveLength(4);
    expect(t.calls).toContain("DELETE api.github.com/repos/octo-member/linxgen-builds/releases/assets/2");
    const rel = t.releases[0]!;
    expect(rel.assets.find((a) => a.name === "box.iso.part02")).toMatchObject({ size: 10, state: "uploaded" });
    expect(rel.body).toBe(t.claim.release.body);
  });

  it("will not touch a release with the same tag that LinxGen did not create", async () => {
    const t = setup({ existingRelease: { tag: "linxgen-b1b1", name: "Mine", body: "my own notes", assets: [] } });
    await runSave(t.deps);
    expect(finished(t)).toMatchObject({ status: "failed", failure: { code: "upload_failed" } });
    expect(finished(t).failure!.message).toContain("was not made by LinxGen");
    expect(t.calls.some((c) => c.startsWith("POST uploads.github.com") || c.startsWith("PATCH"))).toBe(false);
    expect(t.releases[0]!.body).toBe("my own notes");
  });

  it("removes the partial asset a failed upload left behind and tries again", async () => {
    const t = setup({ failUploadOnce: { "box.iso.packages.txt": 502 } });
    await runSave(t.deps);
    expect(finished(t).status).toBe("succeeded");
    const asset = t.releases[0]!.assets.filter((a) => a.name === "box.iso.packages.txt");
    expect(asset).toHaveLength(1);
    expect(asset[0]).toMatchObject({ size: 5, state: "uploaded" });
  });

  it("stops and reports cancellation when the backend asks", async () => {
    const t = setup({ cancelOnProgress: true });
    const res = await runSave(t.deps);
    expect(res.status).toBe("cancelled");
    expect(finished(t)).toEqual({ status: "cancelled" });
  });

  it("stops when the backend refuses progress because the save moved on", async () => {
    const t = setup();
    t.api.progress = vi.fn(async () => {
      throw new ApiError(409, "save_not_running", false);
    });
    const res = await runSave(t.deps);
    expect(res.status).toBe("cancelled");
  });

  it("reports that the result could not be delivered", async () => {
    const t = setup();
    t.finish.mockRejectedValue(new ApiError(503, "unavailable", true));
    const res = await runSave(t.deps);
    expect(res).toEqual({ finished: false, status: "succeeded" });
  });
});

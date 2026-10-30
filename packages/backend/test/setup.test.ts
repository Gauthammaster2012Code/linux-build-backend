/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { verifySetup } from "../convex/lib/setupChecks";
import { bytesToBase64 } from "../convex/lib/crypto";
import schema from "../convex/schema";
import { modules } from "../convex/test.setup";

const VARS = [
  "SITE_URL",
  "BETTER_AUTH_SECRET",
  "CREDENTIAL_ENCRYPTION_KEYS",
  "RUNNER_CAPABILITY_SECRET",
  "GITHUB_REPOSITORY",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WORKFLOW_FILE",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_CLIENT_ID",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "STORAGE_S3_ENDPOINT",
  "STORAGE_S3_REGION",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_BUCKET",
  "STORAGE_GITHUB_APP_ID",
  "STORAGE_GITHUB_APP_SLUG",
  "STORAGE_GITHUB_APP_CLIENT_ID",
  "STORAGE_GITHUB_APP_CLIENT_SECRET",
  "STORAGE_GITHUB_APP_PRIVATE_KEY",
  "PLATFORM_OLLAMA_API_KEY",
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const byName = (checks: { name: string; ok: boolean; detail: string }[]) => Object.fromEntries(checks.map((c) => [c.name, c]));

describe("setup:verify", () => {
  it("reports missing and malformed variables without leaking values", async () => {
    process.env.BETTER_AUTH_SECRET = "sentinel-short-secret";
    process.env.RUNNER_CAPABILITY_SECRET = "sentinel-runner";
    process.env.CREDENTIAL_ENCRYPTION_KEYS = '{"current":"v1","keys":{"v1":"c2VudGluZWwta2V5"}}';
    process.env.STORAGE_SECRET_ACCESS_KEY = "sentinel-b2-secret-value";
    process.env.GITHUB_CLIENT_ID = "sentinel-client-id";
    process.env.R2_BUCKET = "sentinel-old-bucket";
    process.env.STORAGE_GITHUB_APP_CLIENT_SECRET = "sentinel-storage-client-secret";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const t = convexTest(schema, modules);
    const report = await t.action(internal.setup.verify, {});
    const checks = byName(report.checks);
    expect(report.ok).toBe(false);
    expect(checks["env:SITE_URL"]).toMatchObject({ ok: false, detail: "Missing." });
    expect(checks["env:GITHUB_APP_PRIVATE_KEY"]).toMatchObject({ ok: false, detail: "Missing." });
    expect(checks["env:STORAGE_BUCKET"]).toMatchObject({ ok: false, detail: "Missing." });
    expect(checks["env:STORAGE_SECRET_ACCESS_KEY"]).toMatchObject({ ok: true });
    expect(checks["env:R2_BUCKET"]).toMatchObject({ ok: true, detail: expect.stringMatching(/Backblaze B2/) });
    expect(checks["github-storage:app"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^Partly configured; missing STORAGE_GITHUB_APP_ID/) });
    expect(checks["env:BETTER_AUTH_SECRET"]).toMatchObject({ ok: false, detail: expect.stringMatching(/shorter than 32/) });
    expect(checks["env:RUNNER_CAPABILITY_SECRET"]).toMatchObject({ ok: false });
    expect(checks["env:CREDENTIAL_ENCRYPTION_KEYS"]).toMatchObject({ ok: false, detail: expect.stringMatching(/v1/) });
    expect(checks["env:GITHUB_CLIENT_ID"]).toMatchObject({ ok: true, detail: expect.stringMatching(/No longer used/) });
    expect(checks["github:app"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^Skipped/) });
    expect(checks["storage:bucket"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^Skipped/) });
    expect(checks["ollama:platform"]).toMatchObject({ ok: true, detail: expect.stringMatching(/not set \(optional\)/) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/sentinel|c2VudGluZWwta2V5/);
  });

  it("checks GitHub, B2 and Ollama with authenticated requests", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    Object.assign(process.env, {
      SITE_URL: "https://linxgen.example.com",
      BETTER_AUTH_SECRET: "a".repeat(40),
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ current: "v1", keys: { v1: bytesToBase64(new Uint8Array(32)) } }),
      RUNNER_CAPABILITY_SECRET: "r".repeat(40),
      GITHUB_REPOSITORY: "acme/builds",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      STORAGE_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
      STORAGE_ACCESS_KEY_ID: "AKIDSENTINEL",
      STORAGE_SECRET_ACCESS_KEY: "sentinel-b2-secret-value",
      STORAGE_BUCKET: "linxgen-temp",
      PLATFORM_OLLAMA_API_KEY: "sentinel-ollama-key",
    });
    const seen: string[] = [];
    const versions = new Map<string, string[]>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.host}${url.pathname}`);
        if (url.host === "api.github.com") {
          expect(req.headers.get("authorization")).toMatch(/^Bearer /);
          if (url.pathname === "/app/installations/456/access_tokens") return Response.json({ token: "ghs_sentinel" }, { status: 201 });
          if (url.pathname === "/repos/acme/builds") return Response.json({ full_name: "acme/builds", default_branch: "main" });
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        if (url.host === "s3.us-west-004.backblazeb2.com") {
          expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDSENTINEL\/\d{8}\/us-west-004\/s3\//);
          if (req.method === "GET" && url.searchParams.has("versions")) {
            expect(url.pathname).toBe("/linxgen-temp");
            const key = url.searchParams.get("prefix")!;
            const body = (versions.get(key) ?? []).map((v) => `<Version><Key>${key}</Key><VersionId>${v}</VersionId></Version>`).join("");
            return new Response(`<ListVersionsResult>${body}</ListVersionsResult>`);
          }
          expect(url.pathname).toMatch(/^\/linxgen-temp\/_linxgen-probe\//);
          const key = url.pathname.slice("/linxgen-temp/".length);
          if (req.method === "PUT") versions.set(key, ["v1"]);
          if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "2" } });
          if (req.method === "DELETE") {
            versions.set(key, (versions.get(key) ?? []).filter((v) => v !== url.searchParams.get("versionId")));
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 200 });
        }
        if (url.host === "ollama.com") return new Response("unauthorized", { status: 401 });
        throw new Error(`unexpected ${req.url}`);
      }),
    );

    const report = await verifySetup();
    const checks = byName(report.checks);
    expect(checks["github:app"]).toMatchObject({ ok: true });
    expect(checks["github:repository"]).toMatchObject({ ok: true, detail: expect.stringMatching(/default branch main/) });
    expect(checks["github:workflow"]).toMatchObject({ ok: false, detail: expect.stringMatching(/linxgen-build\.yml is not on main yet/) });
    expect(checks["storage:bucket"]).toMatchObject({ ok: true, detail: expect.stringMatching(/permanently deleted/) });
    expect(checks["github-storage:app"]).toMatchObject({ ok: true, detail: expect.stringMatching(/optional/) });
    expect(checks["ollama:platform"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^Unauthorized/) });
    expect(report.checks.filter((c) => c.name.startsWith("env:")).every((c) => c.ok)).toBe(true);
    expect(report.ok).toBe(false);
    for (const method of ["PUT", "HEAD", "GET", "DELETE"]) expect(seen.some((s) => s.startsWith(`${method} s3.us-west-004.backblazeb2.com`))).toBe(true);
    expect([...versions.values()].flat()).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/sentinel|ghs_|AKID|PRIVATE KEY/);
  });

  it("checks the storage app's permissions and the save workflow", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    Object.assign(process.env, {
      GITHUB_REPOSITORY: "acme/builds",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      STORAGE_GITHUB_APP_ID: "789",
      STORAGE_GITHUB_APP_SLUG: "linxgen-storage",
      STORAGE_GITHUB_APP_CLIENT_ID: "Iv1.sentinel",
      STORAGE_GITHUB_APP_CLIENT_SECRET: "sentinel-storage-secret",
      STORAGE_GITHUB_APP_PRIVATE_KEY: privateKey,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        if (url.host !== "api.github.com") return new Response(null, { status: 403 });
        if (url.pathname === "/app") return Response.json({ slug: "linxgen-storage", permissions: { administration: "write", contents: "read", metadata: "read", issues: "write" } });
        if (url.pathname === "/app/installations/456/access_tokens") return Response.json({ token: "ghs_sentinel" }, { status: 201 });
        if (url.pathname === "/repos/acme/builds/actions/workflows/linxgen-save.yml") return Response.json({ state: "active", path: ".github/workflows/linxgen-save.yml" });
        return Response.json({ message: "Not Found" }, { status: 404 });
      }),
    );
    const checks = byName((await verifySetup()).checks);
    expect(checks["github-storage:app"]).toMatchObject({ ok: false, detail: expect.stringMatching(/Contents must be Read and write.*issues/) });
    expect(checks["github:save-workflow"]).toMatchObject({ ok: true });
    expect(JSON.stringify(checks)).not.toMatch(/sentinel|ghs_|PRIVATE KEY/);
  });
});

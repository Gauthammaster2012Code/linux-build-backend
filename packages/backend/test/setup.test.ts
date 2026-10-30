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
    process.env.R2_SECRET_ACCESS_KEY = "sentinel-r2-secret-value";
    process.env.GITHUB_CLIENT_ID = "sentinel-client-id";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const t = convexTest(schema, modules);
    const report = await t.action(internal.setup.verify, {});
    const checks = byName(report.checks);
    expect(report.ok).toBe(false);
    expect(checks["env:SITE_URL"]).toMatchObject({ ok: false, detail: "Missing." });
    expect(checks["env:GITHUB_APP_PRIVATE_KEY"]).toMatchObject({ ok: false, detail: "Missing." });
    expect(checks["env:R2_BUCKET"]).toMatchObject({ ok: false, detail: "Missing." });
    expect(checks["env:R2_SECRET_ACCESS_KEY"]).toMatchObject({ ok: true });
    expect(checks["env:BETTER_AUTH_SECRET"]).toMatchObject({ ok: false, detail: expect.stringMatching(/shorter than 32/) });
    expect(checks["env:RUNNER_CAPABILITY_SECRET"]).toMatchObject({ ok: false });
    expect(checks["env:CREDENTIAL_ENCRYPTION_KEYS"]).toMatchObject({ ok: false, detail: expect.stringMatching(/v1/) });
    expect(checks["env:GITHUB_CLIENT_ID"]).toMatchObject({ ok: true, detail: expect.stringMatching(/No longer used/) });
    expect(checks["github:app"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^Skipped/) });
    expect(checks["r2:bucket"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^Skipped/) });
    expect(checks["ollama:platform"]).toMatchObject({ ok: true, detail: expect.stringMatching(/not set \(optional\)/) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/sentinel|c2VudGluZWwta2V5/);
  });

  it("checks GitHub, R2 and Ollama with authenticated requests", async () => {
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
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "AKIDSENTINEL",
      R2_SECRET_ACCESS_KEY: "sentinel-r2-secret-value",
      R2_BUCKET: "linxgen",
      PLATFORM_OLLAMA_API_KEY: "sentinel-ollama-key",
    });
    const seen: string[] = [];
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
        if (url.host === "acct.r2.cloudflarestorage.com") {
          expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
          expect(url.pathname).toMatch(/^\/linxgen\/_linxgen-probe\//);
          if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "2" } });
          return new Response(null, { status: req.method === "DELETE" ? 204 : 200 });
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
    expect(checks["r2:bucket"]).toMatchObject({ ok: true });
    expect(checks["ollama:platform"]).toMatchObject({ ok: false, detail: expect.stringMatching(/^Unauthorized/) });
    expect(report.checks.filter((c) => c.name.startsWith("env:")).every((c) => c.ok)).toBe(true);
    expect(report.ok).toBe(false);
    for (const method of ["PUT", "HEAD", "DELETE"]) expect(seen.some((s) => s.startsWith(`${method} acct.r2.cloudflarestorage.com`))).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/sentinel|ghs_|AKID|PRIVATE KEY/);
  });
});

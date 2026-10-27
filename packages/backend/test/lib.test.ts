import { describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, jwtVerify, importSPKI, exportSPKI } from "jose";
import { decryptSecret, encryptSecret, dispatchNonce, parseCapabilityToken, capabilityToken, bytesToBase64 } from "../convex/lib/crypto";
import { checkRunnerClaims, verifyRunnerOidcToken, type RunnerTrust } from "../convex/lib/oidc";
import { pkcs1ToPkcs8Pem, createAppJwt } from "../convex/lib/github";
import { completeOrRecoverUpload, R2Storage, StorageError, storageKeyFor } from "../convex/lib/r2";
import { chatJson, ProviderError } from "../convex/lib/providers";
import { parseMadison, pickLaunchpadEntry } from "../convex/lib/packages";
import { pickBuildsToStart } from "../convex/lib/scheduling";
import { decideUnclaimed } from "../convex/orchestrator";
import { TIMING } from "../convex/lib/config";

const keyB64 = () => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

describe("credential encryption", () => {
  it("round-trips and binds to associated data", async () => {
    const ring = { current: "v1", keys: { v1: keyB64() } };
    const enc = await encryptSecret("sk-secret-value", "owner-a", ring);
    expect(enc.ciphertext).not.toContain("sk-secret");
    expect(await decryptSecret(enc, "owner-a", ring)).toBe("sk-secret-value");
    await expect(decryptSecret(enc, "owner-b", ring)).rejects.toThrow();
  });

  it("decrypts old versions after rotation", async () => {
    const v1 = keyB64();
    const old = await encryptSecret("k", "aad", { current: "v1", keys: { v1 } });
    const rotated = { current: "v2", keys: { v1, v2: keyB64() } };
    expect(await decryptSecret(old, "aad", rotated)).toBe("k");
    expect((await encryptSecret("k", "aad", rotated)).keyVersion).toBe("v2");
  });

  it("derives stable dispatch nonces and parses capabilities", async () => {
    expect(await dispatchNonce("s".repeat(32), "a1")).toBe(await dispatchNonce("s".repeat(32), "a1"));
    expect(await dispatchNonce("s".repeat(32), "a1")).not.toBe(await dispatchNonce("s".repeat(32), "a2"));
    const cap = capabilityToken("k57abc");
    expect(parseCapabilityToken(cap)).toEqual({ attemptId: "k57abc" });
    expect(parseCapabilityToken("nope")).toBeNull();
  });
});

describe("runner OIDC", () => {
  const trust: RunnerTrust = {
    issuer: "https://token.actions.githubusercontent.com",
    audience: "linxgen-runner",
    repository: "acme/linxgen-v2",
    workflowRef: "acme/linxgen-v2/.github/workflows/linxgen-build.yml@refs/heads/main",
    allowedWorkflowShas: [],
  };
  const claims = {
    repository: "acme/linxgen-v2",
    event_name: "workflow_dispatch",
    workflow_ref: trust.workflowRef,
    job_workflow_ref: trust.workflowRef,
    workflow_sha: "a".repeat(40),
    run_id: "123",
    run_attempt: "1",
    runner_environment: "github-hosted",
  };

  it("accepts the trusted workflow", () => {
    expect(checkRunnerClaims(claims, trust)).toMatchObject({ runId: "123", runAttempt: 1 });
  });

  it.each([
    ["other repository", { repository: "evil/fork" }],
    ["pull_request event", { event_name: "pull_request" }],
    ["other workflow", { workflow_ref: "acme/linxgen-v2/.github/workflows/other.yml@refs/heads/main" }],
    ["other branch", { workflow_ref: "acme/linxgen-v2/.github/workflows/linxgen-build.yml@refs/heads/dev" }],
    ["missing sha", { workflow_sha: undefined }],
    ["missing run", { run_id: undefined }],
  ])("rejects %s", (_l, patch) => {
    expect(() => checkRunnerClaims({ ...claims, ...patch }, trust)).toThrow();
  });

  it("enforces the workflow revision allowlist", () => {
    expect(() => checkRunnerClaims(claims, { ...trust, allowedWorkflowShas: ["b".repeat(40)] })).toThrow();
  });

  it("verifies signature, issuer and audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "k1" }] });
    const sign = (aud: string, iss = trust.issuer) =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    await expect(verifyRunnerOidcToken(await sign("linxgen-runner"), trust, jwks)).resolves.toMatchObject({ runId: "123" });
    await expect(verifyRunnerOidcToken(await sign("other"), trust, jwks)).rejects.toThrow();
    await expect(verifyRunnerOidcToken(await sign("linxgen-runner", "https://evil"), trust, jwks)).rejects.toThrow();
  });
});

describe("GitHub App JWT", () => {
  it("wraps PKCS#1 keys and signs a verifiable JWT", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(pkcs1ToPkcs8Pem(privateKey)).toContain("BEGIN PRIVATE KEY");
    const jwt = await createAppJwt("12345", privateKey);
    const { payload } = await jwtVerify(jwt, await importSPKI(publicKey, "RS256"));
    expect(payload.iss).toBe("12345");
    void exportSPKI;
  });
});

describe("R2 presigning", () => {
  it("produces scoped part and download URLs", async () => {
    const s = new R2Storage({ accountId: "acct", accessKeyId: "AKID", secretAccessKey: "secret", bucket: "artifacts" });
    const key = storageKeyFor("b1", "a1", "iso", "x.iso");
    const part = new URL(await s.presignUploadPart(key, "up-1", 3, 900));
    expect(part.host).toBe("acct.r2.cloudflarestorage.com");
    expect(part.pathname).toBe("/artifacts/builds/b1/a1/iso/x.iso");
    expect(part.searchParams.get("partNumber")).toBe("3");
    expect(part.searchParams.get("uploadId")).toBe("up-1");
    expect(part.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(part.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(part.toString()).not.toContain("secret");
    const dl = new URL(await s.presignDownload(key, "x.iso", 600));
    expect(dl.searchParams.get("response-content-disposition")).toBe('attachment; filename="x.iso"');
  });
});

describe("AI providers", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  it("parses Ollama responses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ message: { content: '{"spec":{}}' }, prompt_eval_count: 10, eval_count: 5 }));
    const r = await chatJson({ provider: "ollama", apiKey: "k".repeat(20), model: "m", messages, jsonSchema: {}, fetchImpl });
    expect(r).toEqual({ text: '{"spec":{}}', inputTokens: 10, outputTokens: 5 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ollama.com/api/chat");
    expect(JSON.parse(init.body as string).format).toEqual({});
  });

  it("parses OpenAI-compatible responses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    const r = await chatJson({ provider: "openrouter", apiKey: "k".repeat(20), model: "m", messages, jsonSchema: {}, fetchImpl });
    expect(r.outputTokens).toBe(2);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("maps errors without echoing provider bodies", async () => {
    const key = "sk-live-very-secret-key";
    const fetchImpl = vi.fn(async () => new Response(`Incorrect API key provided: ${key}`, { status: 401 }));
    const err = await chatJson({ provider: "openai", apiKey: key, model: "m", messages, jsonSchema: {}, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(key);
    const e5 = await chatJson({ provider: "openai", apiKey: key, model: "m", messages, jsonSchema: {}, fetchImpl: async () => new Response("", { status: 503 }) }).catch((e) => e);
    expect(e5.retryable).toBe(true);
  });
});

describe("package archive parsing", () => {
  it("parses madison output for the requested suite only", () => {
    const text = [
      "       git | 1:2.39.5-0+deb12u2 | bookworm         | source, amd64, arm64",
      "       git | 1:2.47.2-0.2       | trixie           | source, amd64, arm64",
      "  git-doc  | 1:2.47.2-0.2       | trixie           | all",
      "  srconly  | 1.0                | trixie           | source",
      "  nonfree  | 1.0                | trixie/non-free  | amd64",
    ].join("\n");
    const m = parseMadison(text, "trixie");
    expect(m.get("git")?.version).toBe("1:2.47.2-0.2");
    expect(m.has("git-doc")).toBe(true);
    expect(m.has("srconly")).toBe(false);
    expect(m.has("nonfree")).toBe(false);
  });

  it("only accepts Ubuntu main/universe in supported pockets", () => {
    expect(pickLaunchpadEntry("x", [{ binary_package_name: "x", component_name: "multiverse", pocket: "Release", status: "Published" }])).toBeNull();
    expect(pickLaunchpadEntry("x", [{ binary_package_name: "x", component_name: "universe", pocket: "Proposed", status: "Published" }])).toBeNull();
    expect(
      pickLaunchpadEntry("x", [{ binary_package_name: "x", binary_package_version: "1.2", component_name: "universe", pocket: "Updates", status: "Published" }]),
    ).toEqual({ name: "x", version: "1.2", component: "universe" });
  });
});

describe("scheduling", () => {
  const b = (id: string, owner: string, queuedAt: number) => ({ _id: id, ownerId: owner, queuedAt });
  it("respects per-user and global limits in FIFO order", () => {
    const picked = pickBuildsToStart([b("3", "u2", 3), b("1", "u1", 1), b("2", "u1", 2), b("4", "u3", 4)], new Map(), 0, {
      maxActiveBuildsGlobal: 2,
      maxActiveBuildsPerUser: 1,
    });
    expect(picked.map((x) => x._id)).toEqual(["1", "3"]);
  });
  it("counts already active builds", () => {
    const picked = pickBuildsToStart([b("1", "u1", 1), b("2", "u2", 2)], new Map([["u1", 1]]), 1, {
      maxActiveBuildsGlobal: 2,
      maxActiveBuildsPerUser: 1,
    });
    expect(picked.map((x) => x._id)).toEqual(["2"]);
  });
});

describe("unclaimed attempt decisions", () => {
  const now = 1_000_000_000;
  const attempt = (age: number) => ({ status: "dispatched" as const, createdAt: now - age, dispatchedAt: now - age });
  it("waits for queued runs and recent unknown dispatches", () => {
    expect(decideUnclaimed(attempt(60_000), null, now)).toBe("wait");
    expect(decideUnclaimed(attempt(60_000), { id: "1", status: "queued", conclusion: null, displayTitle: "", runAttempt: 1 }, now)).toBe("wait");
  });
  it("detects runs that never started, exited, or waited too long", () => {
    expect(decideUnclaimed(attempt(TIMING.unknownDispatchGraceMs + 1), null, now)).toBe("lost_never_started");
    expect(decideUnclaimed(attempt(1000), { id: "1", status: "completed", conclusion: "failure", displayTitle: "", runAttempt: 1 }, now)).toBe("lost_exited");
    expect(decideUnclaimed(attempt(TIMING.claimTimeoutMs + 1), { id: "1", status: "queued", conclusion: null, displayTitle: "", runAttempt: 1 }, now)).toBe("lost_queue_timeout");
  });
});

describe("multipart completion recovery", () => {
  const upload = { storageKey: "builds/b/a/iso/x.iso", r2UploadId: "r2-1", sizeBytes: 100 };
  const parts = [{ partNumber: 1, etag: '"e1"' }];

  it("completes and reports the stored size", async () => {
    const storage = { completeMultipartUpload: vi.fn(async () => undefined), headObject: vi.fn(async () => ({ sizeBytes: 100 })) };
    await expect(completeOrRecoverUpload(storage, upload, parts)).resolves.toEqual({ sizeBytes: 100 });
  });

  it("accepts an object a previous, unrecorded completion already assembled", async () => {
    const storage = {
      completeMultipartUpload: vi.fn(async () => {
        throw new StorageError("NoSuchUpload");
      }),
      headObject: vi.fn(async () => ({ sizeBytes: 100 })),
    };
    await expect(completeOrRecoverUpload(storage, upload, parts)).resolves.toEqual({ sizeBytes: 100 });
  });

  it("still fails when no object of the expected size exists", async () => {
    const failing = async () => {
      throw new StorageError("NoSuchUpload");
    };
    await expect(completeOrRecoverUpload({ completeMultipartUpload: failing, headObject: async () => null }, upload, parts)).rejects.toThrow(
      "NoSuchUpload",
    );
    await expect(
      completeOrRecoverUpload({ completeMultipartUpload: failing, headObject: async () => ({ sizeBytes: 99 }) }, upload, parts),
    ).rejects.toThrow("NoSuchUpload");
  });
});

import { describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, jwtVerify, importSPKI, exportSPKI } from "jose";
import { decryptSecret, encryptSecret, dispatchNonce, parseCapabilityToken, capabilityToken, bytesToBase64, saveDispatchNonce } from "../convex/lib/crypto";
import { checkRunnerClaims, verifyRunnerOidcToken, type RunnerTrust } from "../convex/lib/oidc";
import { pkcs1ToPkcs8Pem, createAppJwt } from "../convex/lib/github";
import { completeOrRecoverUpload, ObjectStorage, StorageError, storageKeyFor } from "../convex/lib/objectStorage";
import { chatJson, ProviderError } from "../convex/lib/providers";
import { parseMadison, pickLaunchpadEntry } from "../convex/lib/packages";
import { pickBuildsToStart } from "../convex/lib/scheduling";
import { decideUnclaimed } from "../convex/orchestrator";
import { ConfigError, deriveB2Region, runnerTrustConfig, storageConfig, TIMING } from "../convex/lib/config";
import { pickSavesToStart, releaseFor } from "../convex/lib/saves";
import { fitsBudget } from "../convex/lib/storageBudget";

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

  it("keeps save dispatch nonces distinct from build nonces", async () => {
    const secret = "s".repeat(32);
    expect(await saveDispatchNonce(secret, "a1")).toBe(await saveDispatchNonce(secret, "a1"));
    expect(await saveDispatchNonce(secret, "a1")).not.toBe(await dispatchNonce(secret, "a1"));
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

  it("keeps build and save workflow tokens apart", () => {
    const env = { GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY };
    process.env.GITHUB_REPOSITORY = "acme/linxgen-v2";
    try {
      const build = runnerTrustConfig("build");
      const save = runnerTrustConfig("save");
      expect(build.workflowRef).toBe(trust.workflowRef);
      expect(save.workflowRef).toBe("acme/linxgen-v2/.github/workflows/linxgen-save.yml@refs/heads/main");
      const saveClaims = { ...claims, workflow_ref: save.workflowRef, job_workflow_ref: save.workflowRef };
      expect(() => checkRunnerClaims(saveClaims, build)).toThrow(/Untrusted workflow/);
      expect(() => checkRunnerClaims(claims, save)).toThrow(/Untrusted workflow/);
      expect(checkRunnerClaims(saveClaims, save)).toMatchObject({ runId: "123" });
    } finally {
      if (env.GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = env.GITHUB_REPOSITORY;
    }
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

const B2 = { endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-004", accessKeyId: "AKID", secretAccessKey: "secret", bucket: "artifacts" };

describe("B2 object storage", () => {
  it("produces path-style part and download URLs signed for the bucket's region", async () => {
    const s = new ObjectStorage(B2);
    const key = storageKeyFor("b1", "a1", "iso", "x.iso");
    const part = new URL(await s.presignUploadPart(key, "up-1", 3, 900));
    expect(part.host).toBe("s3.us-west-004.backblazeb2.com");
    expect(part.pathname).toBe("/artifacts/builds/b1/a1/iso/x.iso");
    expect(part.searchParams.get("partNumber")).toBe("3");
    expect(part.searchParams.get("uploadId")).toBe("up-1");
    expect(part.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(part.searchParams.get("X-Amz-Credential")).toMatch(/^AKID\/\d{8}\/us-west-004\/s3\/aws4_request$/);
    expect(part.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(part.toString()).not.toContain("secret");
    const dl = new URL(await s.presignDownload(key, "x.iso", 600));
    expect(dl.searchParams.get("response-content-disposition")).toBe('attachment; filename="x.iso"');
  });

  it("creates multipart uploads with a download name and completes them with namespaced XML", async () => {
    const seen: Request[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push(req.clone());
      if (req.method === "POST" && new URL(req.url).searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>4_z&amp;x</UploadId></InitiateMultipartUploadResult>");
      }
      return new Response("<CompleteMultipartUploadResult/>");
    }) as unknown as typeof fetch;
    const s = new ObjectStorage(B2, fetchImpl);
    expect(await s.createMultipartUpload("k/x.iso", "application/x-iso9660-image", "x.iso")).toBe("4_z&x");
    expect(seen[0]!.headers.get("content-disposition")).toBe('attachment; filename="x.iso"');
    expect(seen[0]!.headers.get("authorization")).toMatch(/Credential=AKID\/\d{8}\/us-west-004\/s3\/aws4_request/);
    await s.completeMultipartUpload("k/x.iso", "4_z&x", [
      { partNumber: 2, etag: "e2" },
      { partNumber: 1, etag: '"e1"' },
    ]);
    const xml = await seen[1]!.text();
    expect(xml).toContain('xmlns="http://s3.amazonaws.com/doc/2006-03-01/"');
    expect(xml.indexOf("<PartNumber>1</PartNumber>")).toBeLessThan(xml.indexOf("<PartNumber>2</PartNumber>"));
    expect(xml).toContain('<ETag>"e1"</ETag>');
    expect(xml).toContain('<ETag>"e2"</ETag>');
  });

  it("deletes every stored version so the bytes are not kept as hidden versions", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.method === "GET") {
        return new Response(
          "<ListVersionsResult>" +
            "<Version><Key>k/x.iso</Key><VersionId>v1</VersionId></Version>" +
            "<DeleteMarker><Key>k/x.iso</Key><VersionId>v2</VersionId></DeleteMarker>" +
            "<Version><Key>k/x.iso.extra</Key><VersionId>other</VersionId></Version>" +
            "</ListVersionsResult>",
        );
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await new ObjectStorage(B2, fetchImpl).deleteObject("k/x.iso");
    expect(calls[0]).toMatch(/^GET \/artifacts\?versions=&prefix=k%2Fx\.iso/);
    expect(calls.slice(1)).toEqual(["DELETE /artifacts/k/x.iso?versionId=v1", "DELETE /artifacts/k/x.iso?versionId=v2"]);
  });

  it("derives the region from B2 endpoints and validates the endpoint", () => {
    expect(deriveB2Region("s3.eu-central-003.backblazeb2.com")).toBe("eu-central-003");
    expect(deriveB2Region("example.com")).toBeUndefined();
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { STORAGE_ACCESS_KEY_ID: "k", STORAGE_SECRET_ACCESS_KEY: "s", STORAGE_BUCKET: "b" });
      process.env.STORAGE_S3_ENDPOINT = "https://s3.us-west-004.backblazeb2.com";
      delete process.env.STORAGE_S3_REGION;
      expect(storageConfig()).toMatchObject({ endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-004" });
      process.env.STORAGE_S3_ENDPOINT = "http://s3.us-west-004.backblazeb2.com";
      expect(() => storageConfig()).toThrow(ConfigError);
      process.env.STORAGE_S3_ENDPOINT = "https://s3.us-west-004.backblazeb2.com/bucket";
      expect(() => storageConfig()).toThrow(/without a path/);
      process.env.STORAGE_S3_ENDPOINT = "https://storage.example.com";
      expect(() => storageConfig()).toThrow(/STORAGE_S3_REGION/);
      process.env.STORAGE_S3_REGION = "us-east-1";
      expect(storageConfig().region).toBe("us-east-1");
    } finally {
      for (const k of ["STORAGE_S3_ENDPOINT", "STORAGE_S3_REGION", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY", "STORAGE_BUCKET"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("enforces the storage budget", () => {
    expect(fitsBudget(8, 2, 10)).toBe(true);
    expect(fitsBudget(9, 2, 10)).toBe(false);
  });
});

describe("save scheduling and release text", () => {
  const s = (id: string, ownerId: string, queuedAt: number) => ({ id, ownerId, queuedAt });
  it("starts one save per member and two overall", () => {
    const picked = pickSavesToStart([s("1", "u1", 1), s("2", "u1", 2), s("3", "u2", 3), s("4", "u3", 4)], new Map(), 0);
    expect(picked.map((x) => x.id)).toEqual(["1", "3"]);
    expect(pickSavesToStart([s("1", "u1", 1), s("3", "u2", 3)], new Map([["u1", 1]]), 1).map((x) => x.id)).toEqual(["3"]);
  });

  it("marks the release and explains split files", () => {
    const build = { _id: "b123", title: "Dev | <Box>", finishedAt: Date.UTC(2025, 0, 2), createdAt: 0 };
    const files = [
      { fileName: "dev.iso", sizeBytes: 3 * 1024 ** 3, sha256: "a".repeat(64) },
      { fileName: "dev.json", sizeBytes: 10, sha256: "b".repeat(64) },
    ];
    const r = releaseFor(build as never, { owner: "octo", name: "storage" }, files, 1024 ** 3);
    expect(r.tag).toBe("linxgen-b123");
    expect(r.body.startsWith(r.marker)).toBe(true);
    expect(r.name).not.toMatch(/[|<>]/);
    expect(r.body).toContain("cat dev.iso.part* > dev.iso");
    expect(r.body).not.toContain("cat dev.json");
    expect(r.body).toContain("a".repeat(64));
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
  const upload = { storageKey: "builds/b/a/iso/x.iso", storageUploadId: "up-1", sizeBytes: 100 };
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

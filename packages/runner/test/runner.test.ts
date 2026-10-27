import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { eventsRequestSchema, logLinesByteLength, MAX_LOG_BATCH_BYTES, MAX_LOG_LINE_CHARS, type EventsRequest } from "@linxgen/spec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RunnerApiClient } from "../src/api";
import { execCommand } from "../src/exec";
import { ApiError, requestJson } from "../src/http";
import { checkRequestedPackages, parseDpkgManifest } from "../src/manifest";
import { HEARTBEAT_INTERVAL_MS, LOG_TRUNCATED_NOTICE, Reporter } from "../src/reporter";
import { uploadFile } from "../src/upload";
import { artifactFileName, renderWorkspace } from "../src/workspace";
import { LOCK, SPEC } from "./fixtures";


const tmp = () => mkdtempSync(path.join(tmpdir(), "linxgen-runner-"));

describe("workspace", () => {
  it("renders build settings and package lists", () => {
    const files = renderWorkspace(SPEC, { buildId: "b1", attemptId: "a1" }, LOCK);
    expect(files.buildEnv).toContain("DISTRO_FAMILY=ubuntu\n");
    expect(files.buildEnv).toContain("HOSTNAME=dev-box\n");
    expect(files.buildEnv).toContain("APT_RECOMMENDS=true\n");
    expect(files.buildEnv).toContain(`BASE_IMAGE=${LOCK.images["ubuntu-24.04"]}\n`);
    expect(files.lists.iso).toContain("casper");
    expect(files.lists.iso).toContain("xubuntu-core");
    expect(files.lists.container).not.toContain("casper");
    expect(files.lists.container.filter((p) => p === "ca-certificates")).toHaveLength(1);
    expect(files.lists.requested).toEqual(["git", "curl", "ca-certificates"]);
  });

  it("names artifacts within the upload file-name rules", () => {
    expect(artifactFileName(SPEC, "iso")).toBe("dev-box-ubuntu24.04-amd64.iso");
    expect(artifactFileName(SPEC, "manifest-container")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  });

  it("refuses unpinned images", () => {
    expect(() => renderWorkspace(SPEC, { buildId: "b", attemptId: "a" }, { ...LOCK, images: {} })).toThrow(/pinned image/);
  });
});

describe("manifest", () => {
  it("parses dpkg output and reports missing packages", () => {
    const installed = parseDpkgManifest("git\t1:2.43.0-1\ncurl\t8.5.0-2\nbad line\n\n");
    expect(installed.size).toBe(2);
    const check = checkRequestedPackages(["git", "vim"], installed);
    expect(check.present).toBe(false);
    expect(check.missing).toEqual(["vim"]);
    expect(check.packages).toEqual([{ name: "git", version: "1:2.43.0-1" }]);
  });
});

describe("execCommand", () => {
  it("passes arguments literally without a shell", async () => {
    const lines: string[] = [];
    const hostile = "$(echo pwned); rm -rf / `id` && echo nope";
    const res = await execCommand(process.execPath, ["-e", "console.log(process.argv[1])", hostile], {
      onLine: (l) => lines.push(l),
    });
    expect(res.exitCode).toBe(0);
    expect(lines).toEqual([hostile]);
  });

  it("kills the process group on abort", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      onLine: () => undefined,
      signal: controller.signal,
      killGraceMs: 500,
    });
    setTimeout(() => controller.abort(), 100);
    const res = await promise;
    expect(res.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("requestJson", () => {
  const schema = z.object({ ok: z.boolean() });
  const noWait = async () => undefined;

  it("retries transient failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(requestJson(fetchImpl, "https://x.test/a", { body: {}, schema }, noWait)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries when the response body cannot be read", async () => {
    const broken = { ok: true, status: 200, text: () => Promise.reject(new TypeError("terminated")) } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(requestJson(fetchImpl, "https://x.test/a", { body: {}, schema }, noWait)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a successful response that is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(requestJson(fetchImpl, "https://x.test/a", { body: {}, schema }, noWait)).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry client errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: "stale_attempt" }, { status: 409 }));
    await expect(requestJson(fetchImpl, "https://x.test/a", { body: {}, schema }, noWait)).rejects.toMatchObject({
      status: 409,
      code: "stale_attempt",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function fakeEventsApi(responses: (() => Promise<{ ok: boolean; cancelRequested: boolean }>)[]) {
  const sent: EventsRequest[] = [];
  const api = {
    events: vi.fn(async (body: EventsRequest) => {
      sent.push(structuredClone(body));
      const next = responses.shift();
      return next ? next() : { ok: true, cancelRequested: false };
    }),
  } as unknown as RunnerApiClient;
  return { api, sent };
}

describe("Reporter", () => {
  it("keeps the sequence number when a batch is retried", async () => {
    const { api, sent } = fakeEventsApi([() => Promise.reject(new ApiError(503, "x", true))]);
    const reporter = new Reporter(api, { logFile: path.join(tmp(), "log"), maxLogBytes: 1e6, wait: async () => undefined });
    reporter.line("hello");
    await reporter.setStage("preparing");
    expect(sent.map((b) => b.seq)).toEqual([1, 1]);
    expect(sent[1]).toMatchObject({ stage: "preparing", logLines: ["hello"] });
    reporter.line("next");
    await reporter.stop();
    expect(sent.at(-1)).toMatchObject({ seq: 2, logLines: ["next"] });
  });

  it("sends a stage change even when no lines are buffered", async () => {
    const { api, sent } = fakeEventsApi([]);
    const reporter = new Reporter(api, { logFile: path.join(tmp(), "log"), maxLogBytes: 1e6 });
    await reporter.setStage("building");
    expect(sent).toEqual([{ seq: 1, stage: "building", events: [], logLines: [] }]);
  });

  it("signals cancellation and redacts secrets", async () => {
    const { api, sent } = fakeEventsApi([async () => ({ ok: true, cancelRequested: true })]);
    const dir = tmp();
    const reporter = new Reporter(api, { logFile: path.join(dir, "log"), maxLogBytes: 1e6, secrets: ["s3cret-token"] });
    const onCancel = vi.fn();
    reporter.onCancel(onCancel);
    reporter.line("token=s3cret-token");
    await reporter.stop();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(sent[0]!.logLines).toEqual(["token=***"]);
    expect(readFileSync(path.join(dir, "log"), "utf8")).not.toContain("s3cret");
  });

  it("treats a refused attempt as cancellation", async () => {
    const { api } = fakeEventsApi([() => Promise.reject(new ApiError(409, "attempt_not_running", false))]);
    const reporter = new Reporter(api, { logFile: path.join(tmp(), "log"), maxLogBytes: 1e6 });
    reporter.line("x");
    await expect(reporter.stop()).rejects.toBeInstanceOf(ApiError);
    expect(reporter.cancelRequested).toBe(true);
  });

  it("bounds the local log file, including the truncation notice", async () => {
    const { api } = fakeEventsApi([]);
    const dir = tmp();
    const reporter = new Reporter(api, { logFile: path.join(dir, "log"), maxLogBytes: 100 });
    for (let i = 0; i < 50; i++) reporter.line(`line ${i}`);
    await reporter.stop();
    const log = readFileSync(path.join(dir, "log"));
    expect(log.byteLength).toBeLessThanOrEqual(100);
    expect(log.toString("utf8")).toContain(LOG_TRUNCATED_NOTICE);
  });

  it("sends later lines after a flush that found nothing to send", async () => {
    const { api, sent } = fakeEventsApi([]);
    const reporter = new Reporter(api, { logFile: path.join(tmp(), "log"), maxLogBytes: 1e6 });
    await reporter.flush();
    expect(sent).toHaveLength(0);
    reporter.line("after idle");
    await reporter.flush();
    expect(sent).toEqual([{ seq: 1, events: [], logLines: ["after idle"] }]);
  });

  it("keeps every batch within the byte budget the backend accepts", async () => {
    const { api, sent } = fakeEventsApi([]);
    const reporter = new Reporter(api, { logFile: path.join(tmp(), "log"), maxLogBytes: 1e9 });
    const line = "€".repeat(MAX_LOG_LINE_CHARS);
    for (let i = 0; i < 400; i++) reporter.line(line);
    await reporter.stop();
    expect(sent.flatMap((b) => b.logLines)).toHaveLength(400);
    for (const batch of sent) {
      expect(logLinesByteLength(batch.logLines)).toBeLessThanOrEqual(MAX_LOG_BATCH_BYTES);
      expect(eventsRequestSchema.safeParse(batch).success).toBe(true);
    }
  });

  it("drops a batch the backend rejects as invalid so later stages are not blocked", async () => {
    const { api, sent } = fakeEventsApi([() => Promise.reject(new ApiError(400, "invalid_request", false))]);
    const reporter = new Reporter(api, { logFile: path.join(tmp(), "log"), maxLogBytes: 1e6 });
    reporter.line("bad");
    await expect(reporter.stop()).rejects.toBeInstanceOf(ApiError);
    await reporter.setStage("building");
    expect(sent.map((b) => b.seq)).toEqual([1, 2]);
    expect(sent[1]).toMatchObject({ stage: "building", logLines: [] });
    expect(reporter.cancelRequested).toBe(false);
  });

  describe("heartbeat", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends an empty batch during quiet steps and picks up cancellation from it", async () => {
      vi.useFakeTimers();
      const { api, sent } = fakeEventsApi([async () => ({ ok: true, cancelRequested: true })]);
      const reporter = new Reporter(api, { logFile: path.join(tmp(), "log"), maxLogBytes: 1e6 });
      const onCancel = vi.fn();
      reporter.onCancel(onCancel);
      reporter.start();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 10_000);
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent).toEqual([{ seq: 1, events: [], logLines: [] }]);
      expect(onCancel).toHaveBeenCalledOnce();
      await reporter.stop();
    });

    it("does not send heartbeats while regular batches keep the attempt alive", async () => {
      vi.useFakeTimers();
      const { api, sent } = fakeEventsApi([]);
      const reporter = new Reporter(api, { logFile: path.join(tmp(), "log"), maxLogBytes: 1e6 });
      reporter.start();
      for (let i = 0; i < 30; i++) {
        reporter.line(`tick ${i}`);
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(sent.every((b) => b.logLines.length > 0)).toBe(true);
      await reporter.stop();
    });
  });
});

describe("uploadFile", () => {
  it("uploads parts through presigned URLs and completes with ordered ETags", async () => {
    const dir = tmp();
    const file = path.join(dir, "artifact.bin");
    const data = Buffer.from("x".repeat(25));
    writeFileSync(file, data);
    const complete = vi.fn(async () => ({ artifactId: "art1" }));
    const api = {
      uploadStart: vi.fn(async () => ({ uploadId: "up1", partSizeBytes: 10, partCount: 3 })),
      uploadParts: vi.fn(async (_id: string, nums: number[]) => ({
        urls: nums.map((n) => ({ partNumber: n, url: `https://r2.test/part/${n}` })),
        expiresAt: 0,
      })),
      uploadComplete: complete,
    } as unknown as RunnerApiClient;
    const bodies = new Map<string, number>();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      bodies.set(String(url), (init!.body as Uint8Array).byteLength);
      return new Response(null, { status: 200, headers: { ETag: `"etag-${String(url).at(-1)}"` } });
    }) as unknown as typeof fetch;

    const res = await uploadFile(api, file, { kind: "iso", fileName: "a.iso" }, { fetchImpl });
    expect(res.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(api.uploadStart).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: 25, contentType: "application/x-iso9660-image" }));
    expect([...bodies.values()].sort()).toEqual([10, 10, 5]);
    expect(complete).toHaveBeenCalledWith("up1", [
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 3, etag: '"etag-3"' },
    ]);
  });

  it("stops sibling part uploads and lets them settle before failing", async () => {
    const dir = tmp();
    const file = path.join(dir, "artifact.bin");
    writeFileSync(file, Buffer.from("y".repeat(50)));
    const api = {
      uploadStart: vi.fn(async () => ({ uploadId: "up1", partSizeBytes: 10, partCount: 5 })),
      uploadParts: vi.fn(async (_id: string, nums: number[]) => ({
        urls: nums.map((n) => ({ partNumber: n, url: `https://r2.test/part/${n}` })),
        expiresAt: 0,
      })),
      uploadComplete: vi.fn(),
    } as unknown as RunnerApiClient;
    let inFlight = 0;
    const started: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      started.push(String(url));
      if (String(url).endsWith("/1")) return new Response(null, { status: 400 });
      inFlight++;
      try {
        // Siblings hang until the shared abort reaches them.
        await new Promise<void>((_resolve, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => setTimeout(() => reject(signal.reason), 20), { once: true });
        });
        return new Response(null, { status: 200, headers: { ETag: '"e"' } });
      } finally {
        inFlight--;
      }
    }) as unknown as typeof fetch;

    await expect(uploadFile(api, file, { kind: "iso", fileName: "a.iso" }, { fetchImpl, wait: async () => undefined })).rejects.toThrow(
      /part upload failed with 400/,
    );
    expect(inFlight).toBe(0);
    const callsAtFailure = started.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toHaveLength(callsAtFailure);
    expect(started.some((u) => u.endsWith("/5"))).toBe(false);
    expect(api.uploadComplete).not.toHaveBeenCalled();
  });
});

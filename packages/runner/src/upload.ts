import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ArtifactKind, UploadStartRequest } from "@linxgen/spec";
import type { RunnerApiClient } from "./api";
import { backoffMs, sleep, type FetchLike } from "./http";

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export const CONTENT_TYPES: Record<ArtifactKind, UploadStartRequest["contentType"]> = {
  iso: "application/x-iso9660-image",
  container: "application/gzip",
  log: "text/plain",
  manifest: "application/json",
};

export interface UploadedFile {
  uploadId: string;
  sizeBytes: number;
  sha256: string;
}

export interface UploadOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
}

const URL_BATCH = 50;
const CONCURRENCY = 4;
const PART_TIMEOUT_MS = 15 * 60_000;

async function putPart(
  fetchImpl: FetchLike,
  url: string,
  body: Buffer,
  signal: AbortSignal,
  wait: (ms: number) => Promise<void>,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await wait(backoffMs(attempt - 1));
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "PUT",
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        headers: { "Content-Length": String(body.byteLength) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(PART_TIMEOUT_MS)]),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      lastError = e;
      continue;
    }
    if (res.ok) {
      const etag = res.headers.get("etag");
      if (!etag) throw new Error("storage response had no ETag");
      return etag;
    }
    lastError = new Error(`part upload failed with ${res.status}`);
    if (res.status < 500 && res.status !== 429 && res.status !== 403) throw lastError;
  }
  throw lastError instanceof Error ? lastError : new Error("part upload failed");
}

/**
 * Uploads a file through backend-issued multipart URLs. Part URLs are requested in batches and
 * re-requested on failure so expired signatures do not fail long uploads.
 */
export async function uploadFile(
  api: RunnerApiClient,
  file: string,
  meta: { kind: ArtifactKind; fileName: string },
  opts: UploadOptions = {},
): Promise<UploadedFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wait = opts.wait ?? sleep;
  const { size } = await stat(file);
  const sha256 = await sha256File(file);
  const started = await api.uploadStart({
    kind: meta.kind,
    fileName: meta.fileName,
    sizeBytes: size,
    sha256,
    contentType: CONTENT_TYPES[meta.kind],
  });
  const { uploadId, partSizeBytes, partCount } = started;
  const etags = new Map<number, string>();
  // One failed part stops its siblings; all of them settle before the shared file handle is closed.
  const workersAbort = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, workersAbort.signal]) : workersAbort.signal;
  const handle = await open(file, "r");
  try {
    for (let first = 1; first <= partCount; first += URL_BATCH) {
      signal.throwIfAborted();
      const numbers = Array.from({ length: Math.min(URL_BATCH, partCount - first + 1) }, (_, i) => first + i);
      let urls = new Map((await api.uploadParts(uploadId, numbers)).urls.map((u) => [u.partNumber, u.url]));
      const queue = [...numbers];
      let firstError: unknown;
      const worker = async () => {
        try {
          for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
            signal.throwIfAborted();
            const offset = (n - 1) * partSizeBytes;
            const length = Math.min(partSizeBytes, size - offset);
            const buf = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buf, 0, length, offset);
            if (bytesRead !== length) throw new Error(`short read on part ${n}`);
            let url = urls.get(n);
            if (!url) throw new Error(`no upload URL for part ${n}`);
            try {
              etags.set(n, await putPart(fetchImpl, url, buf, signal, wait));
            } catch (e) {
              if (signal.aborted) throw e;
              // Signatures may have expired; fetch fresh URLs once for this part.
              urls = new Map([...urls, ...(await api.uploadParts(uploadId, [n])).urls.map((u) => [u.partNumber, u.url] as const)]);
              url = urls.get(n);
              if (!url) throw new Error(`no upload URL for part ${n}`);
              etags.set(n, await putPart(fetchImpl, url, buf, signal, wait));
            }
          }
        } catch (e) {
          if (firstError === undefined && !workersAbort.signal.aborted) {
            firstError = e;
            workersAbort.abort(e);
          }
          throw e;
        }
      };
      const results = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, numbers.length) }, worker));
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (rejected) throw firstError ?? rejected.reason;
    }
  } finally {
    await handle.close();
  }
  const parts = [...etags.entries()].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag }));
  await api.uploadComplete(uploadId, parts);
  return { uploadId, sizeBytes: size, sha256 };
}

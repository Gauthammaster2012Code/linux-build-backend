import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  SAVE_CHECKSUM_FILE,
  SAVE_FAILURE_MESSAGES,
  SAVE_RUNNER_FAILURE_CODES,
  SAVE_SPLIT_PART_BYTES,
  splitPartCount,
  splitPartName,
  type RepoToken,
  type SaveFile,
  type SaveFinishRequest,
  type SavePhase,
} from "@linxgen/spec";
import type { SaveEnv } from "./config";
import { GitHubApiError, ReleaseClient, type TokenSource } from "./githubRelease";
import { ApiError, backoffMs, sleep, type FetchLike } from "./http";
import type { SaveApiClient } from "./saveApi";

type RunnerFailureCode = (typeof SAVE_RUNNER_FAILURE_CODES)[number];

export class SaveFailure extends Error {
  constructor(
    readonly code: RunnerFailureCode,
    message: string = SAVE_FAILURE_MESSAGES[code],
  ) {
    super(message);
  }
}

class StopRequested extends Error {}

export interface SaveDeps {
  env: SaveEnv;
  api: SaveApiClient;
  getOidcToken: () => Promise<string>;
  /** Prints to the GitHub Actions job log. Never pass tokens, URLs or repository names. */
  console: (line: string) => void;
  /** Registers a value with the Actions log masker. */
  mask: (secret: string) => void;
  fetchImpl?: FetchLike;
  /** Files larger than this are uploaded in parts of this size. Defaults to SAVE_SPLIT_PART_BYTES. */
  splitBytes?: number;
  wait?: (ms: number) => Promise<void>;
  progressIntervalMs?: number;
}

export interface SaveResult {
  finished: boolean;
  status: SaveFinishRequest["status"];
  saveStatus?: string;
}

export interface UploadItem {
  name: string;
  file: string;
  start: number;
  size: number;
}

/** Release assets for the downloaded files: whole files, or `.partNN` slices for files above the split size. */
export function planAssets(files: Pick<SaveFile, "fileName" | "sizeBytes">[], dir: string, splitBytes: number): UploadItem[] {
  const items: UploadItem[] = [];
  for (const f of files) {
    const file = path.join(dir, f.fileName);
    if (f.sizeBytes <= splitBytes) {
      items.push({ name: f.fileName, file, start: 0, size: f.sizeBytes });
      continue;
    }
    const count = splitPartCount(f.sizeBytes, splitBytes);
    for (let i = 0; i < count; i++) {
      const start = i * splitBytes;
      items.push({ name: splitPartName(f.fileName, i), file, start, size: Math.min(splitBytes, f.sizeBytes - start) });
    }
  }
  return items;
}

export function checksumFile(files: Pick<SaveFile, "fileName" | "sha256">[]): string {
  return files.map((f) => `${f.sha256}  ${f.fileName}`).join("\n") + "\n";
}

const REFRESH_MARGIN_MS = 10 * 60_000;

class RepoTokens implements TokenSource {
  constructor(
    private current: RepoToken,
    private readonly api: SaveApiClient,
    private readonly mask: (secret: string) => void,
  ) {}

  async get() {
    if (this.current.expiresAt - Date.now() < REFRESH_MARGIN_MS) await this.refresh();
    return this.current.token;
  }

  async refresh() {
    try {
      this.current = await this.api.token();
    } catch (e) {
      throw backendFailure(e);
    }
    this.mask(this.current.token);
    return this.current.token;
  }
}

/** Reports progress in sequenced calls that double as heartbeats and carry cancellation back. */
class SaveProgress {
  private seq = 0;
  private phase: SavePhase = "downloading";
  private done = 0;
  private total = 0;
  private message: string | undefined;
  private lastSentAt = 0;
  private sending: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly api: SaveApiClient,
    private readonly intervalMs: number,
    private readonly onStop: () => void,
  ) {}

  start() {
    this.timer = setInterval(() => void this.send(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    return this.sending ?? Promise.resolve();
  }

  update(phase: SavePhase, done: number, total: number, message?: string) {
    const changed = phase !== this.phase || message !== this.message;
    this.phase = phase;
    this.done = done;
    this.total = total;
    this.message = message;
    if (changed || Date.now() - this.lastSentAt >= this.intervalMs) void this.send();
  }

  send(): Promise<void> {
    if (this.sending) return this.sending;
    const body = {
      seq: this.seq++,
      phase: this.phase,
      doneBytes: this.done,
      totalBytes: this.total,
      ...(this.message ? { message: this.message } : {}),
    };
    this.lastSentAt = Date.now();
    this.sending = this.api
      .progress(body)
      .then((res) => {
        if (res.cancelRequested) this.onStop();
      })
      .catch((e: unknown) => {
        // The backend refuses progress once the save was cancelled, failed or handed to another attempt.
        if (e instanceof ApiError && !e.retryable && (e.status === 409 || e.status === 401)) this.onStop();
      })
      .finally(() => {
        this.sending = undefined;
      });
    return this.sending;
  }
}

function backendFailure(e: unknown): Error {
  if (e instanceof ApiError && (SAVE_RUNNER_FAILURE_CODES as readonly string[]).includes(e.code)) {
    return new SaveFailure(e.code as RunnerFailureCode);
  }
  if (e instanceof ApiError && e.status === 409) return new StopRequested(e.code);
  return e instanceof Error ? e : new Error(String(e));
}

function classify(e: unknown): { code: RunnerFailureCode; message: string } {
  if (e instanceof SaveFailure) return { code: e.code, message: e.message };
  if (e instanceof GitHubApiError) {
    if (e.status === 401 || e.status === 403) return { code: "github_unauthorized", message: `${SAVE_FAILURE_MESSAGES.github_unauthorized} (${e.message})` };
    if (e.status === 404) return { code: "repo_missing", message: `${SAVE_FAILURE_MESSAGES.repo_missing} (${e.message})` };
    return { code: "upload_failed", message: `${SAVE_FAILURE_MESSAGES.upload_failed} ${e.message}` };
  }
  return { code: "internal_error", message: `Save runner error: ${(e as Error).message ?? String(e)}`.slice(0, 2000) };
}

/** Copies a finished build's files from temporary storage to a release in the member's storage repository. */
export async function runSave(deps: SaveDeps): Promise<SaveResult> {
  const { env, api } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const wait = deps.wait ?? sleep;
  const splitBytes = deps.splitBytes ?? SAVE_SPLIT_PART_BYTES;

  const oidcToken = await deps.getOidcToken();
  deps.mask(oidcToken);
  deps.mask(env.dispatchNonce);
  const claim = await api.claim(env.saveAttemptId, env.dispatchNonce, oidcToken);
  deps.mask(claim.capability);
  deps.mask(claim.github.token);
  deps.mask(`${claim.release.owner}/${claim.release.repo}`);
  deps.mask(claim.release.owner);
  deps.console(`claimed save ${env.saveAttemptId}: ${claim.files.length} file(s)`);

  const work = path.join(env.workRoot, env.saveAttemptId);
  mkdirSync(work, { recursive: true });
  const controller = new AbortController();
  let stopReason: "cancelled" | "timed_out" | undefined;
  const stop = (reason: "cancelled" | "timed_out") => {
    stopReason ??= reason;
    controller.abort();
  };
  const progress = new SaveProgress(api, deps.progressIntervalMs ?? 30_000, () => stop("cancelled"));
  progress.start();
  // Leave time to report the result before the backend deadline.
  const deadline = setTimeout(() => stop("timed_out"), Math.max(60_000, claim.deadlineAt - Date.now() - 3 * 60_000));
  deadline.unref?.();
  const ensureRunning = () => {
    if (controller.signal.aborted) throw new StopRequested(stopReason ?? "stopped");
  };

  let files = claim.files;
  const urlFor = (name: string) => files.find((f) => f.fileName === name)?.url;
  const refreshUrls = async () => {
    try {
      files = (await api.files()).files;
    } catch (e) {
      throw backendFailure(e);
    }
  };

  let status: SaveFinishRequest["status"] = "failed";
  let failure: SaveFinishRequest["failure"];
  let releaseUrl: string | undefined;
  let assetCount: number | undefined;
  try {
    const totalDownload = claim.files.reduce((s, f) => s + f.sizeBytes, 0);
    let downloaded = 0;
    progress.update("downloading", 0, totalDownload);
    for (const [i, f] of claim.files.entries()) {
      ensureRunning();
      deps.console(`downloading file ${i + 1}/${claim.files.length}: ${f.fileName} (${f.sizeBytes} bytes)`);
      await download(f, path.join(work, f.fileName), {
        fetchImpl,
        signal: controller.signal,
        wait,
        urlFor,
        refreshUrls,
        onBytes: (n) => progress.update("downloading", (downloaded += n), totalDownload),
      });
    }
    writeFileSync(path.join(work, SAVE_CHECKSUM_FILE), checksumFile(claim.files));

    ensureRunning();
    const tokens = new RepoTokens(claim.github, api, deps.mask);
    const gh = new ReleaseClient(fetchImpl, tokens, claim.release.owner, claim.release.repo, wait);
    let release = await gh.findReleaseByTag(claim.release.tag);
    if (release && !release.body.includes(claim.release.marker)) {
      throw new SaveFailure("upload_failed", `A release tagged ${claim.release.tag} already exists in the storage repository and was not made by LinxGen. Delete it to save this build.`);
    }
    if (release) {
      deps.console("reusing the existing release for this build");
    } else {
      try {
        release = await gh.createRelease({
          tag: claim.release.tag,
          name: claim.release.name,
          body: `${claim.release.body}\n\n_Upload in progress._`,
        });
      } catch (e) {
        // Another attempt may have created it in the meantime.
        if (!(e instanceof GitHubApiError) || e.status !== 422) throw e;
        release = await gh.findReleaseByTag(claim.release.tag);
        if (!release || !release.body.includes(claim.release.marker)) throw e;
      }
    }

    const checksumPath = path.join(work, SAVE_CHECKSUM_FILE);
    const items = [
      ...planAssets(claim.files, work, splitBytes),
      { name: SAVE_CHECKSUM_FILE, file: checksumPath, start: 0, size: (await stat(checksumPath)).size },
    ];
    const totalUpload = items.reduce((s, it) => s + it.size, 0);
    let uploaded = 0;
    let existing = await gh.listAssets(release.id);
    progress.update("uploading", 0, totalUpload);
    for (const [i, item] of items.entries()) {
      ensureRunning();
      const prior = existing.find((a) => a.name === item.name);
      if (prior && prior.state === "uploaded" && prior.size === item.size) {
        deps.console(`asset ${i + 1}/${items.length} already uploaded: ${item.name}`);
        progress.update("uploading", (uploaded += item.size), totalUpload);
        continue;
      }
      deps.console(`uploading asset ${i + 1}/${items.length}: ${item.name} (${item.size} bytes)`);
      for (let attempt = 0; ; attempt++) {
        ensureRunning();
        if (prior || attempt > 0) {
          existing = await gh.listAssets(release.id);
          const stale = existing.find((a) => a.name === item.name);
          if (stale) await gh.deleteAsset(stale.id);
        }
        try {
          const asset = await gh.uploadAsset(release.id, item.name, item.file, item.start, item.size);
          if (asset.size !== item.size) throw new GitHubApiError(`uploaded asset has ${asset.size} bytes, expected ${item.size}`, 500);
          break;
        } catch (e) {
          const status = e instanceof GitHubApiError ? e.status : null;
          const transient = status === null || status >= 500 || status === 422;
          if (!transient || attempt >= 2) throw e;
          deps.console(`asset upload failed (${(e as Error).message}); retrying`);
          await wait(backoffMs(attempt, 5000));
        }
      }
      progress.update("uploading", (uploaded += item.size), totalUpload);
    }

    ensureRunning();
    progress.update("publishing", totalUpload, totalUpload);
    const published = await gh.updateRelease(release.id, claim.release.body);
    releaseUrl = published.htmlUrl;
    assetCount = items.length;
    status = "succeeded";
    deps.console(`saved ${items.length} asset(s)`);
  } catch (e) {
    if (e instanceof StopRequested || controller.signal.aborted) {
      if (stopReason === "timed_out") {
        failure = { code: "timed_out", message: SAVE_FAILURE_MESSAGES.timed_out };
      } else {
        status = "cancelled";
      }
      deps.console(stopReason === "timed_out" ? "save timed out" : "save stopped");
    } else {
      failure = classify(e);
      deps.console(`save failed: ${failure.code}`);
    }
  } finally {
    clearTimeout(deadline);
    await progress.stop();
    rmSync(work, { recursive: true, force: true });
  }

  try {
    const res = await api.finish({
      status,
      ...(releaseUrl ? { releaseUrl } : {}),
      ...(assetCount !== undefined ? { assetCount } : {}),
      ...(failure ? { failure } : {}),
    });
    deps.console(`finished: ${status}, save is ${res.saveStatus}`);
    return { finished: true, status, saveStatus: res.saveStatus };
  } catch (e) {
    deps.console(`could not report the result: ${(e as Error).message}`);
    return { finished: false, status };
  }
}

interface DownloadOptions {
  fetchImpl: FetchLike;
  signal: AbortSignal;
  wait: (ms: number) => Promise<void>;
  urlFor: (fileName: string) => string | undefined;
  refreshUrls: () => Promise<void>;
  onBytes: (n: number) => void;
}

/**
 * Downloads a file and checks its size and SHA-256 against what the backend recorded at upload time. Expired or
 * refused URLs are re-requested; a missing object means cleanup already removed it.
 */
export async function download(file: Pick<SaveFile, "fileName" | "sizeBytes" | "sha256">, dest: string, opts: DownloadOptions): Promise<void> {
  let refreshed = false;
  let lastError: Error = new SaveFailure("download_failed");
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await opts.wait(backoffMs(attempt - 1, 2000));
    opts.signal.throwIfAborted();
    const url = opts.urlFor(file.fileName);
    if (!url) throw new SaveFailure("storage_expired");
    let res: Response;
    try {
      res = await opts.fetchImpl(url, { signal: AbortSignal.any([opts.signal, AbortSignal.timeout(60 * 60_000)]) });
    } catch (e) {
      if (opts.signal.aborted) throw e;
      lastError = new SaveFailure("download_failed", `${SAVE_FAILURE_MESSAGES.download_failed} (${(e as Error).name})`);
      continue;
    }
    if (res.status === 403 || res.status === 400 || res.status === 404) {
      await res.body?.cancel();
      if (!refreshed) {
        refreshed = true;
        await opts.refreshUrls();
        attempt--;
        continue;
      }
      throw new SaveFailure(res.status === 404 ? "storage_expired" : "download_failed");
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      lastError = new SaveFailure("download_failed", `${SAVE_FAILURE_MESSAGES.download_failed} (HTTP ${res.status})`);
      continue;
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        bytes += chunk.length;
        opts.onBytes(chunk.length);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), meter, createWriteStream(dest));
    } catch (e) {
      if (opts.signal.aborted) throw e;
      opts.onBytes(-bytes);
      lastError = new SaveFailure("download_failed", `${SAVE_FAILURE_MESSAGES.download_failed} (${(e as Error).name})`);
      continue;
    }
    if (bytes !== file.sizeBytes) {
      opts.onBytes(-bytes);
      lastError = new SaveFailure("download_failed", `${SAVE_FAILURE_MESSAGES.download_failed} (got ${bytes} of ${file.sizeBytes} bytes)`);
      continue;
    }
    if (hash.digest("hex") !== file.sha256) throw new SaveFailure("checksum_mismatch", `${file.fileName} did not match its recorded SHA-256, so it was not saved.`);
    return;
  }
  throw lastError;
}

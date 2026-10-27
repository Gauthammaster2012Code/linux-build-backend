import { appendFileSync } from "node:fs";
import {
  MAX_LOG_BATCH_BYTES,
  MAX_LOG_LINE_CHARS,
  MAX_LOG_LINES_PER_BATCH,
  utf8ByteLength,
  type EventsRequest,
  type OutputType,
  type RunnerEvent,
  type RunnerStage,
} from "@linxgen/spec";
import type { RunnerApiClient } from "./api";
import { ApiError, backoffMs, sleep } from "./http";

const MAX_BUFFERED_LINES = 20_000;
const MAX_EVENTS_PER_BATCH = 50;
const FLUSH_INTERVAL_MS = 3000;
/** Quiet steps (boot tests, uploads) still refresh the backend heartbeat and pick up cancellation at this interval. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const LOG_TRUNCATED_NOTICE = "[linxgen] log truncated: size limit reached";

export interface ReporterOptions {
  logFile: string;
  maxLogBytes: number;
  /** Values that must never appear in logs, such as the capability token. */
  secrets?: string[];
  wait?: (ms: number) => Promise<void>;
}

/**
 * Streams stage changes, events and log lines to the backend in sequenced batches. A batch keeps its
 * sequence number until the backend acknowledges it, so retries are deduplicated server-side.
 */
export class Reporter {
  private seq = 0;
  private stage: RunnerStage | undefined;
  private stageDirty = false;
  private lines: string[] = [];
  private events: RunnerEvent[] = [];
  private pending: EventsRequest | undefined;
  private droppedLines = 0;
  private logBytes = 0;
  private logTruncated = false;
  private lastSentAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private cancelled = false;
  private cancelListeners: (() => void)[] = [];

  constructor(
    private readonly api: RunnerApiClient,
    private readonly opts: ReporterOptions,
  ) {}

  get cancelRequested() {
    return this.cancelled;
  }

  onCancel(listener: () => void) {
    this.cancelListeners.push(listener);
    if (this.cancelled) listener();
  }

  start() {
    this.lastSentAt = Date.now();
    this.timer = setInterval(() => void this.flush({ heartbeat: true }).catch(() => undefined), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flushAll();
  }

  private wait(ms: number) {
    return (this.opts.wait ?? sleep)(ms);
  }

  private redact(text: string): string {
    let out = text;
    for (const s of this.opts.secrets ?? []) if (s) out = out.split(s).join("***");
    return out;
  }

  line(raw: string) {
    const text = this.redact(raw).slice(0, MAX_LOG_LINE_CHARS);
    this.writeLocal(text);
    if (this.lines.length >= MAX_BUFFERED_LINES) {
      this.lines.shift();
      this.droppedLines++;
    }
    this.lines.push(text);
    if (this.lines.length >= MAX_LOG_LINES_PER_BATCH) void this.flush().catch(() => undefined);
  }

  event(level: RunnerEvent["level"], message: string, output?: OutputType) {
    const text = this.redact(message).slice(0, 2000);
    this.writeLocal(`[${level}] ${text}`);
    this.events.push({ at: Date.now(), level, message: text, ...(output ? { output } : {}) });
  }

  /** Moves the build to a new stage and waits until the backend has recorded it. */
  async setStage(stage: RunnerStage) {
    this.stage = stage;
    this.stageDirty = true;
    this.writeLocal(`==> stage: ${stage}`);
    await this.flushAll();
  }

  /** Appends to the local log, keeping the file (including the truncation notice) within maxLogBytes. */
  private writeLocal(text: string) {
    if (this.logTruncated) return;
    const entry = `${text}\n`;
    const bytes = Buffer.byteLength(entry);
    const notice = `${LOG_TRUNCATED_NOTICE}\n`;
    const noticeBytes = Buffer.byteLength(notice);
    if (this.logBytes + bytes + noticeBytes > this.opts.maxLogBytes) {
      this.logTruncated = true;
      if (this.logBytes + noticeBytes <= this.opts.maxLogBytes) {
        appendFileSync(this.opts.logFile, notice);
        this.logBytes += noticeBytes;
      }
      return;
    }
    this.logBytes += bytes;
    appendFileSync(this.opts.logFile, entry);
  }

  private nextBatch(heartbeat: boolean): EventsRequest | undefined {
    const hasContent = this.lines.length > 0 || this.events.length > 0 || this.stageDirty || this.droppedLines > 0;
    if (!hasContent && !(heartbeat && Date.now() - this.lastSentAt >= HEARTBEAT_INTERVAL_MS)) return undefined;
    this.stageDirty = false;
    const logLines: string[] = [];
    let bytes = 0;
    if (this.droppedLines > 0) {
      const notice = `[linxgen] ${this.droppedLines} log lines were dropped while the backend was unreachable`;
      logLines.push(notice);
      bytes += utf8ByteLength(notice);
      this.droppedLines = 0;
    }
    let take = 0;
    while (take < this.lines.length && logLines.length + take < MAX_LOG_LINES_PER_BATCH) {
      const size = utf8ByteLength(this.lines[take]!);
      if (bytes + size > MAX_LOG_BATCH_BYTES) break;
      bytes += size;
      take++;
    }
    logLines.push(...this.lines.splice(0, take));
    return {
      seq: ++this.seq,
      ...(this.stage ? { stage: this.stage } : {}),
      events: this.events.splice(0, MAX_EVENTS_PER_BATCH),
      logLines,
    };
  }

  /**
   * Sends at most one batch. Concurrent callers share the in-flight send. Timer-driven calls also send an
   * empty batch as a heartbeat when nothing was acknowledged for a while.
   */
  flush(opts: { heartbeat?: boolean } = {}): Promise<void> {
    if (this.flushing) return this.flushing;
    this.pending ??= this.nextBatch(Boolean(opts.heartbeat));
    if (!this.pending) return Promise.resolve();
    const sending = this.send(this.pending).finally(() => {
      if (this.flushing === sending) this.flushing = undefined;
    });
    this.flushing = sending;
    return sending;
  }

  private async send(batch: EventsRequest) {
    try {
      const res = await this.api.events(batch);
      this.pending = undefined;
      this.lastSentAt = Date.now();
      if (res.cancelRequested) this.markCancelled();
    } catch (e) {
      if (e instanceof ApiError && !e.retryable) {
        // The backend refuses events once the attempt is no longer running (cancelled, superseded or timed out).
        if (e.status === 409 || e.status === 401) this.markCancelled();
        // A rejected batch would be rejected again; drop it so later stages and logs are not blocked behind it.
        else this.pending = undefined;
      }
      throw e;
    }
  }

  private hasWork() {
    return Boolean(this.pending) || this.stageDirty || this.lines.length > 0 || this.events.length > 0 || this.droppedLines > 0;
  }

  /** Drains everything buffered, retrying transient failures a few times before giving up. */
  private async flushAll() {
    let failures = 0;
    while (this.hasWork() || this.flushing) {
      try {
        await this.flush();
      } catch (e) {
        if (e instanceof ApiError && !e.retryable) throw e;
        if (++failures >= 5) throw e;
        await this.wait(backoffMs(failures));
      }
    }
  }

  private markCancelled() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const l of this.cancelListeners) l();
  }
}

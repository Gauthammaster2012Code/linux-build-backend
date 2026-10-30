import {
  ACTIVE_SAVE_STATUSES,
  SAVE_CHECKSUM_FILE,
  SAVE_FAILURE_MESSAGES,
  splitPartName,
  STORAGE_REPO_TOPIC,
  TERMINAL_ATTEMPT_STATUSES,
  type SaveFailureCode,
  type SaveRelease,
  type SaveStatus,
} from "@linxgen/spec";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReaderCtx } from "./access";
import { appendEvent } from "./buildOps";
import { SAVE_LIMITS, storageAppConfigured, TIMING } from "./config";

export const RELEASE_TAG_PREFIX = "linxgen-";

export function releaseTagFor(buildId: string): string {
  return `${RELEASE_TAG_PREFIX}${buildId}`;
}

/** Hidden line in the release body. An existing release with the save's tag is reused only if its body contains it. */
export function releaseMarkerFor(buildId: string): string {
  return `<!-- linxgen-build:${buildId} -->`;
}

export async function connectionFor(ctx: ReaderCtx, profileId: Id<"profiles">): Promise<Doc<"githubConnections"> | null> {
  return ctx.db
    .query("githubConnections")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .unique();
}

/** Whether a build may be saved at all: it succeeded, or it ended with at least one verified output. */
export function buildIsSaveable(build: Pick<Doc<"builds">, "status" | "failure" | "outputResults">): boolean {
  if (build.status === "succeeded") return true;
  return build.status === "failed" && build.failure?.code === "partial_outputs" && build.outputResults.some((r) => r.status === "verified");
}

/**
 * The files a save copies: each verified image and its package manifest, in a stable order. Files whose bytes are no
 * longer in temporary storage are left out; the caller decides whether what remains is enough.
 */
export async function saveableArtifacts(ctx: ReaderCtx, build: Doc<"builds">, now = Date.now()): Promise<Doc<"artifacts">[]> {
  const ids: Id<"artifacts">[] = [];
  for (const output of ["iso", "container"] as const) {
    const r = build.outputResults.find((o) => o.output === output);
    if (!r || r.status !== "verified" || !r.artifactId) continue;
    ids.push(r.artifactId);
    if (r.manifestArtifactId) ids.push(r.manifestArtifactId);
  }
  const out: Doc<"artifacts">[] = [];
  for (const id of ids) {
    const a = await ctx.db.get(id);
    if (!a || a.ownerId !== build.ownerId || a.status !== "available" || a.expiresAt <= now) continue;
    if ((a.kind === "iso" || a.kind === "container") && !a.verified) continue;
    out.push(a);
  }
  return out;
}

export type EnqueueResult =
  | { ok: true; saveId: Id<"saves">; existing: boolean }
  | { ok: false; code: SaveFailureCode | "not_configured" | "not_saveable" | "too_many_saves"; message: string };

const isActive = (s: SaveStatus) => ACTIVE_SAVE_STATUSES.includes(s);

/** Queues a save of a finished build. Idempotent: an unfinished save of the same build is returned instead. */
export async function enqueueSave(
  ctx: MutationCtx,
  build: Doc<"builds">,
  trigger: Doc<"saves">["trigger"],
  opts: { retryOfSaveId?: Id<"saves"> } = {},
): Promise<EnqueueResult> {
  if (!storageAppConfigured()) return { ok: false, code: "not_configured", message: "Saving to GitHub is not set up on this LinxGen instance." };
  if (!buildIsSaveable(build)) return { ok: false, code: "not_saveable", message: "Only builds with verified outputs can be saved." };
  const connection = await connectionFor(ctx, build.ownerId);
  if (!connection) return { ok: false, code: "not_connected", message: SAVE_FAILURE_MESSAGES.not_connected };
  if (connection.status !== "connected") return { ok: false, code: "github_unauthorized", message: SAVE_FAILURE_MESSAGES.github_unauthorized };

  const previous = await ctx.db
    .query("saves")
    .withIndex("by_build", (q) => q.eq("buildId", build._id))
    .order("desc")
    .take(20);
  const active = previous.find((s) => isActive(s.status));
  if (active) return { ok: true, saveId: active._id, existing: true };

  let ownerActive = 0;
  for (const status of ACTIVE_SAVE_STATUSES) {
    ownerActive += (
      await ctx.db
        .query("saves")
        .withIndex("by_owner_status", (q) => q.eq("ownerId", build.ownerId).eq("status", status))
        .take(SAVE_LIMITS.queuedPerMember)
    ).length;
  }
  if (ownerActive >= SAVE_LIMITS.queuedPerMember) {
    return { ok: false, code: "too_many_saves", message: `You already have ${ownerActive} saves waiting. Try again when one finishes.` };
  }

  const now = Date.now();
  const files = await saveableArtifacts(ctx, build, now);
  if (!files.some((a) => a.kind === "iso" || a.kind === "container")) {
    return { ok: false, code: "storage_expired", message: SAVE_FAILURE_MESSAGES.storage_expired };
  }
  const saveId = await ctx.db.insert("saves", {
    ownerId: build.ownerId,
    buildId: build._id,
    trigger,
    status: "queued",
    statusChangedAt: now,
    artifactIds: files.map((a) => a._id),
    totalBytes: files.reduce((s, a) => s + a.sizeBytes, 0),
    repoFullName: `${connection.repoOwner}/${connection.repoName}`,
    releaseTag: releaseTagFor(build._id),
    attemptCount: 0,
    retryOfSaveId: opts.retryOfSaveId,
    queuedAt: now,
    createdAt: now,
  });
  await appendEvent(ctx, build, {
    level: "info",
    message: `${trigger === "auto" ? "Automatic save" : "Save"} to GitHub queued (${connection.repoOwner}/${connection.repoName}).`,
  });
  await ctx.scheduler.runAfter(0, internal.saves.tick, {});
  return { ok: true, saveId, existing: false };
}

/** Called when a build finishes. Members who turned on automatic saving get every saveable build copied. */
export async function maybeAutoSave(ctx: MutationCtx, build: Doc<"builds">) {
  if (!buildIsSaveable(build) || !storageAppConfigured()) return;
  const connection = await connectionFor(ctx, build.ownerId);
  if (!connection || !connection.autoSave) return;
  const result = await enqueueSave(ctx, build, "auto");
  if (!result.ok) await appendEvent(ctx, build, { level: "warning", message: `Automatic save to GitHub skipped: ${result.message}` });
}

export async function markConnectionBroken(ctx: MutationCtx, profileId: Id<"profiles">, reason: string) {
  const connection = await connectionFor(ctx, profileId);
  if (connection && connection.status !== "broken") {
    await ctx.db.patch(connection._id, { status: "broken", brokenReason: reason.slice(0, 300), updatedAt: Date.now() });
  }
}

/** Ends a save. Safe to call on a finished save, which is left unchanged. */
export async function finishSave(
  ctx: MutationCtx,
  saveId: Id<"saves">,
  status: "succeeded" | "failed" | "cancelled",
  extra: { failure?: { code: SaveFailureCode; message: string }; releaseUrl?: string; assetCount?: number } = {},
): Promise<Doc<"saves"> | null> {
  const save = await ctx.db.get(saveId);
  if (!save || !isActive(save.status)) return save;
  const now = Date.now();
  if (save.currentAttemptId) {
    const attempt = await ctx.db.get(save.currentAttemptId);
    if (attempt && !TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) {
      await ctx.db.patch(attempt._id, {
        status: status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : extra.failure?.code === "timed_out" ? "timed_out" : "failed",
        finishedAt: now,
        ...(extra.failure ? { failure: extra.failure } : {}),
      });
    }
  }
  await ctx.db.patch(saveId, {
    status,
    statusChangedAt: now,
    finishedAt: now,
    ...(extra.failure ? { failure: extra.failure } : {}),
    ...(extra.releaseUrl ? { releaseUrl: extra.releaseUrl } : {}),
    ...(extra.assetCount !== undefined ? { assetCount: extra.assetCount } : {}),
  });
  const build = await ctx.db.get(save.buildId);
  if (build) {
    await appendEvent(ctx, build, {
      level: status === "succeeded" ? "info" : status === "cancelled" ? "warning" : "error",
      message:
        status === "succeeded"
          ? `Saved to GitHub: ${extra.releaseUrl ?? save.repoFullName}`
          : status === "cancelled"
            ? "Save to GitHub cancelled."
            : `Save to GitHub failed: ${extra.failure?.message ?? "unknown error"}`,
    });
  }
  // A save slot may have been freed.
  await ctx.scheduler.runAfter(0, internal.saves.tick, {});
  return ctx.db.get(saveId);
}

export function failSave(ctx: MutationCtx, saveId: Id<"saves">, code: SaveFailureCode, message: string = SAVE_FAILURE_MESSAGES[code]) {
  return finishSave(ctx, saveId, code === "cancelled" ? "cancelled" : "failed", { failure: { code, message: message.slice(0, 2000) } });
}

/** Picks queued saves to start, oldest first, within the global and per-member limits. */
export function pickSavesToStart<T extends { ownerId: string; queuedAt: number; cancelRequestedAt?: number }>(
  queued: readonly T[],
  activeByOwner: ReadonlyMap<string, number>,
  activeTotal: number,
  limits: { activeGlobal: number; activePerMember: number } = SAVE_LIMITS,
): T[] {
  let free = limits.activeGlobal - activeTotal;
  const counts = new Map(activeByOwner);
  const picked: T[] = [];
  for (const save of [...queued].sort((a, b) => a.queuedAt - b.queuedAt)) {
    if (free <= 0) break;
    if (save.cancelRequestedAt) continue;
    const owned = counts.get(save.ownerId) ?? 0;
    if (owned >= limits.activePerMember) continue;
    picked.push(save);
    counts.set(save.ownerId, owned + 1);
    free--;
  }
  return picked;
}

function cell(text: string): string {
  return text.replace(/[|<>`\r\n]/g, " ").trim();
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/** Release metadata for a save. The member's repository is private; the body still escapes table syntax. */
export function releaseFor(
  build: Pick<Doc<"builds">, "_id" | "title" | "finishedAt" | "createdAt">,
  repo: { owner: string; name: string },
  files: Pick<Doc<"artifacts">, "fileName" | "sizeBytes" | "sha256">[],
  splitThreshold: number,
): SaveRelease {
  const marker = releaseMarkerFor(build._id);
  const finished = new Date(build.finishedAt ?? build.createdAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  const title = cell(build.title).slice(0, 150) || "LinxGen build";
  const rows = files.map((f) => `| \`${cell(f.fileName)}\` | ${formatBytes(f.sizeBytes)} | \`${f.sha256}\` |`);
  const split = files.filter((f) => f.sizeBytes > splitThreshold);
  const body = [
    marker,
    `LinxGen build **${title}**, finished ${finished}. Build id \`${build._id}\`.`,
    "",
    "| File | Size | SHA-256 |",
    "| --- | --- | --- |",
    ...rows,
    "",
    `\`${SAVE_CHECKSUM_FILE}\` lists the checksum of every file.`,
    ...(split.length > 0
      ? [
          "",
          "GitHub limits release files to 2 GiB, so these files are stored in parts:",
          ...split.map((f) => `- \`${cell(f.fileName)}\`: \`${splitPartName(cell(f.fileName), 0)}\`, \`${splitPartName(cell(f.fileName), 1)}\`, …`),
          "",
          "Join the parts and check the result:",
          "",
          "```sh",
          ...split.map((f) => `cat ${cell(f.fileName)}.part* > ${cell(f.fileName)}`),
          `sha256sum --ignore-missing -c ${SAVE_CHECKSUM_FILE}`,
          "```",
        ]
      : []),
    "",
    `Saved by LinxGen into the \`${STORAGE_REPO_TOPIC}\` repository ${repo.owner}/${repo.name}.`,
  ].join("\n");
  return { owner: repo.owner, repo: repo.name, tag: releaseTagFor(build._id), name: title, body, marker };
}

export const saveHoldDeadline = (expiresAt: number) => expiresAt + TIMING.saveHoldMaxMs;

import { httpRouter } from "convex/server";
import {
  claimRequestSchema,
  saveClaimRequestSchema,
  saveFinishRequestSchema,
  saveProgressRequestSchema,
  SAVE_PROTOCOL_VERSION,
  eventsRequestSchema,
  finishRequestSchema,
  partCountFor,
  UPLOAD_PART_SIZE_BYTES,
  uploadCompleteRequestSchema,
  uploadPartsRequestSchema,
  uploadStartRequestSchema,
} from "@linxgen/spec";
import type { z } from "zod";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import type { Id } from "./_generated/dataModel";
import { ConfigError, runnerSecret, runnerTrustConfig, storageAppConfig, storageConfig, TIMING } from "./lib/config";
import { capabilityToken, constantTimeEqual, dispatchNonce, parseCapabilityToken, saveDispatchNonce, sha256Hex } from "./lib/crypto";
import { GitHubError } from "./lib/github";
import { storageRepoToken, storageTokenFailure } from "./lib/githubStorage";
import { completeOrRecoverUpload, ObjectStorage, StorageError, storageKeyFor } from "./lib/objectStorage";
import { RunnerAuthError, verifyRunnerOidcToken } from "./lib/oidc";
import { fitsBudget } from "./lib/storageBudget";

const http = httpRouter();
authComponent.registerRoutes(http, createAuth);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function readBody<T extends z.ZodType>(req: Request, schema: T, maxBytes: number): Promise<z.infer<T>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "body_too_large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "body_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "invalid_body");
  return parsed.data;
}

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/);
  if (!m?.[1]) throw new HttpError(401, "missing_credentials");
  return m[1];
}

async function capability(req: Request) {
  const token = bearer(req);
  const parsed = parseCapabilityToken(token);
  if (!parsed) throw new HttpError(401, "invalid_capability");
  return { attemptId: parsed.attemptId, capabilityHash: await sha256Hex(token) };
}

type Result = { ok: true } | { ok: false; status: number; error: string };
function unwrap<T extends Result>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new HttpError((r as { status: number }).status, (r as { error: string }).error);
  return r as Extract<T, { ok: true }>;
}

function route(handler: (ctx: ActionCtx, req: Request) => Promise<Response>) {
  return httpAction(async (ctx, req) => {
    try {
      return await handler(ctx, req);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.code });
      if (e instanceof RunnerAuthError) return json(401, { error: "unauthorized" });
      if (e instanceof ConfigError) {
        console.error("runner endpoint misconfigured", e.message);
        return json(503, { error: "not_configured" });
      }
      if (e instanceof StorageError) {
        console.error("storage error", e.message);
        return json(502, { error: "storage_error" });
      }
      if (e instanceof GitHubError) {
        console.error("GitHub error", e.message);
        return json(502, { error: "github_error" });
      }
      console.error("runner endpoint failed", e);
      return json(500, { error: "internal_error" });
    }
  });
}

http.route({
  path: "/runner/claim",
  method: "POST",
  handler: route(async (ctx, req) => {
    const token = bearer(req);
    const body = await readBody(req, claimRequestSchema, 16 * 1024);
    const identity = await verifyRunnerOidcToken(token, runnerTrustConfig("build"));
    const expected = await dispatchNonce(runnerSecret(), body.attemptId);
    if (!constantTimeEqual(expected, body.dispatchNonce)) throw new HttpError(401, "unauthorized");
    const cap = capabilityToken(body.attemptId);
    const result = unwrap(
      await ctx.runMutation(internal.runner.claimAttempt, {
        attemptId: body.attemptId,
        runId: identity.runId,
        runAttempt: identity.runAttempt,
        workflowSha: identity.workflowSha,
        runnerEnvironment: identity.runnerEnvironment,
        capabilityHash: await sha256Hex(cap),
      }),
    );
    return json(200, {
      capability: cap,
      capabilityExpiresAt: result.capabilityExpiresAt,
      buildId: result.buildId,
      attemptId: body.attemptId,
      spec: result.spec,
      limits: result.limits,
    });
  }),
});

http.route({
  path: "/runner/events",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await capability(req);
    const body = await readBody(req, eventsRequestSchema, 3 * 1024 * 1024);
    const result = unwrap(await ctx.runMutation(internal.runner.recordEvents, { ...cap, ...body }));
    return json(200, { ok: true, cancelRequested: result.cancelRequested, duplicate: result.duplicate });
  }),
});

http.route({
  path: "/runner/uploads/start",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await capability(req);
    const body = await readBody(req, uploadStartRequestSchema, 16 * 1024);
    const context = unwrap(await ctx.runQuery(internal.runner.capabilityContext, cap));
    if ((body.kind === "iso" || body.kind === "container") && !context.requestedOutputs.includes(body.kind)) {
      throw new HttpError(422, "output_not_requested");
    }
    const limit = body.kind === "log" || body.kind === "manifest" ? context.maxLogBytes : context.maxArtifactBytes;
    if (body.sizeBytes > limit) throw new HttpError(413, "artifact_too_large");

    const existing = await ctx.runQuery(internal.runner.findUpload, { attemptId: context.attemptId, kind: body.kind, fileName: body.fileName });
    if (existing) {
      if (existing.sha256 !== body.sha256 || existing.sizeBytes !== body.sizeBytes) throw new HttpError(409, "upload_conflict");
      return json(200, { uploadId: existing._id, partSizeBytes: existing.partSizeBytes, partCount: existing.partCount });
    }
    // Cheap early refusal; recordUploadStart repeats the check atomically.
    if (!fitsBudget(context.storedBytes, body.sizeBytes, context.maxStoredBytes)) throw new HttpError(409, "storage_full");
    const storage = new ObjectStorage(storageConfig());
    const storageKey = storageKeyFor(context.buildId, context.attemptId, body.kind, body.fileName);
    const storageUploadId = await storage.createMultipartUpload(storageKey, body.contentType, body.fileName);
    const partCount = partCountFor(body.sizeBytes);
    const recordedResult = await ctx.runMutation(internal.runner.recordUploadStart, {
      ...cap,
      ...body,
      storageKey,
      storageUploadId,
      partSizeBytes: UPLOAD_PART_SIZE_BYTES,
      partCount,
    });
    if (!recordedResult.ok) {
      await storage.abortMultipartUpload(storageKey, storageUploadId);
      throw new HttpError(recordedResult.status, recordedResult.error);
    }
    const recorded = recordedResult;
    if (recorded.duplicateOf) await storage.abortMultipartUpload(storageKey, recorded.duplicateOf);
    return json(200, { uploadId: recorded.uploadId, partSizeBytes: UPLOAD_PART_SIZE_BYTES, partCount });
  }),
});

http.route({
  path: "/runner/uploads/parts",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await capability(req);
    const body = await readBody(req, uploadPartsRequestSchema, 16 * 1024);
    const context = unwrap(await ctx.runQuery(internal.runner.capabilityContext, cap));
    const upload = await ctx.runQuery(internal.runner.getUpload, { uploadId: body.uploadId, attemptId: context.attemptId });
    if (!upload || upload.status !== "uploading") throw new HttpError(404, "upload_not_found");
    if (body.partNumbers.some((n) => n > upload.partCount)) throw new HttpError(422, "invalid_part");
    const uploadId = upload.storageUploadId;
    if (!uploadId) throw new HttpError(409, "upload_not_active");
    const storage = new ObjectStorage(storageConfig());
    const urls = await Promise.all(
      body.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.presignUploadPart(upload.storageKey, uploadId, partNumber, TIMING.presignedUploadSeconds),
      })),
    );
    return json(200, { urls, expiresAt: Date.now() + TIMING.presignedUploadSeconds * 1000 });
  }),
});

http.route({
  path: "/runner/uploads/complete",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await capability(req);
    const body = await readBody(req, uploadCompleteRequestSchema, 1024 * 1024);
    const context = unwrap(await ctx.runQuery(internal.runner.capabilityContext, cap));
    const upload = await ctx.runQuery(internal.runner.getUpload, { uploadId: body.uploadId, attemptId: context.attemptId });
    if (!upload) throw new HttpError(404, "upload_not_found");
    if (upload.status === "completed" && upload.artifactId) return json(200, { artifactId: upload.artifactId });
    if (upload.status !== "uploading") throw new HttpError(409, "upload_not_active");
    if (body.parts.length !== upload.partCount) throw new HttpError(422, "missing_parts");
    if (!upload.storageUploadId) throw new HttpError(409, "upload_not_active");
    const storage = new ObjectStorage(storageConfig());
    const head = await completeOrRecoverUpload(storage, { ...upload, storageUploadId: upload.storageUploadId }, body.parts);
    const result = await ctx.runMutation(internal.runner.completeUpload, {
      ...cap,
      uploadId: upload._id,
      actualSizeBytes: head?.sizeBytes ?? -1,
    });
    if (!result.ok) {
      if (result.error === "size_mismatch") await storage.deleteObject(upload.storageKey);
      throw new HttpError(result.status, result.error);
    }
    return json(200, { artifactId: result.artifactId });
  }),
});

http.route({
  path: "/runner/finish",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await capability(req);
    const body = await readBody(req, finishRequestSchema, 512 * 1024);
    const result = unwrap(await ctx.runMutation(internal.runner.finish, { ...cap, body }));
    return json(200, { buildStatus: result.buildStatus });
  }),
});

/* ---------- Save runner routes (linxgen-save.yml) ---------- */

async function saveCapability(req: Request) {
  const token = bearer(req);
  const parsed = parseCapabilityToken(token);
  if (!parsed) throw new HttpError(401, "invalid_capability");
  return { saveAttemptId: parsed.attemptId, capabilityHash: await sha256Hex(token) };
}

type SaveFileRef = { kind: "iso" | "container" | "log" | "manifest"; fileName: string; sizeBytes: number; sha256: string; storageKey: string };

async function presignSaveFiles(files: SaveFileRef[]) {
  const storage = new ObjectStorage(storageConfig());
  return Promise.all(
    files.map(async ({ storageKey, ...f }) => ({
      ...f,
      url: await storage.presignDownload(storageKey, f.fileName, TIMING.presignedSaveDownloadSeconds),
    })),
  );
}

/**
 * Mints the storage repository token. A refused request means the member uninstalled or suspended the app or removed
 * the repository from it: the save fails and the connection is marked broken so the member is asked to reconnect.
 */
async function repoTokenOrFail(
  ctx: ActionCtx,
  saveAttemptId: string,
  connection: { installationId: number; repoId: number },
): Promise<{ token: string; expiresAt: number }> {
  try {
    return await storageRepoToken(storageAppConfig(), connection.installationId, connection.repoId);
  } catch (e) {
    const code = storageTokenFailure(e);
    if (!code) throw e;
    await ctx.runMutation(internal.saves.failAttempt, { saveAttemptId: saveAttemptId as Id<"saveAttempts">, code, breakConnection: true });
    throw new HttpError(409, code);
  }
}

http.route({
  path: "/runner/save/claim",
  method: "POST",
  handler: route(async (ctx, req) => {
    const token = bearer(req);
    const body = await readBody(req, saveClaimRequestSchema, 16 * 1024);
    // Only tokens from the save workflow are accepted here; build workflow tokens fail the workflow_ref check.
    const identity = await verifyRunnerOidcToken(token, runnerTrustConfig("save"));
    const expected = await saveDispatchNonce(runnerSecret(), body.saveAttemptId);
    if (!constantTimeEqual(expected, body.dispatchNonce)) throw new HttpError(401, "unauthorized");
    const cap = capabilityToken(body.saveAttemptId);
    const result = unwrap(
      await ctx.runMutation(internal.saves.claimAttempt, {
        saveAttemptId: body.saveAttemptId,
        runId: identity.runId,
        runAttempt: identity.runAttempt,
        workflowSha: identity.workflowSha,
        capabilityHash: await sha256Hex(cap),
      }),
    );
    const github = await repoTokenOrFail(ctx, body.saveAttemptId, result.connection);
    return json(200, {
      protocolVersion: SAVE_PROTOCOL_VERSION,
      capability: cap,
      capabilityExpiresAt: result.capabilityExpiresAt,
      saveAttemptId: body.saveAttemptId,
      deadlineAt: result.deadlineAt,
      files: await presignSaveFiles(result.files),
      release: result.release,
      github,
    });
  }),
});

/** Fresh download URLs; the ones from the claim expire after an hour. */
http.route({
  path: "/runner/save/files",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await saveCapability(req);
    const context = unwrap(await ctx.runQuery(internal.saves.capabilityContext, cap));
    return json(200, { files: await presignSaveFiles(context.files) });
  }),
});

/** A fresh repository token; installation tokens expire after an hour. */
http.route({
  path: "/runner/save/token",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await saveCapability(req);
    const context = unwrap(await ctx.runQuery(internal.saves.capabilityContext, cap));
    return json(200, await repoTokenOrFail(ctx, cap.saveAttemptId, context.connection));
  }),
});

http.route({
  path: "/runner/save/progress",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await saveCapability(req);
    const body = await readBody(req, saveProgressRequestSchema, 16 * 1024);
    const result = unwrap(await ctx.runMutation(internal.saves.recordProgress, { ...cap, body }));
    return json(200, { ok: true, cancelRequested: result.cancelRequested });
  }),
});

http.route({
  path: "/runner/save/finish",
  method: "POST",
  handler: route(async (ctx, req) => {
    const cap = await saveCapability(req);
    const body = await readBody(req, saveFinishRequestSchema, 64 * 1024);
    const result = unwrap(await ctx.runMutation(internal.saves.finish, { ...cap, body }));
    return json(200, { saveStatus: result.saveStatus });
  }),
});

export default http;

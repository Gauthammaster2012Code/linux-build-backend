import { v } from "convex/values";
import { PROVIDER_CATALOG } from "@linxgen/spec";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { appError, ERR, requireMember } from "./lib/access";
import { credentialKeyring, platformAi } from "./lib/config";
import { decryptSecret, encryptSecret } from "./lib/crypto";
import {
  API_KEY_PATTERN,
  MODEL_PATTERN,
  ProviderError,
  keyHint,
  testProviderConnection,
  type ProviderKind,
} from "./lib/providers";
import { providerKind } from "./schema";

/** Associated data binding a ciphertext to its owner, row and provider. */
export function connectionAad(ownerId: Id<"profiles">, connectionId: Id<"providerConnections"> | "new", provider: ProviderKind) {
  return `linxgen:provider:v1:${ownerId}:${connectionId}:${provider}`;
}

export const platformInfo = query({
  args: {},
  handler: async (ctx) => {
    await requireMember(ctx);
    const p = platformAi();
    return { provider: p.provider, label: PROVIDER_CATALOG[p.provider].label, model: p.model, configured: Boolean(p.apiKey) };
  },
});

export const listConnections = query({
  args: {},
  handler: async (ctx) => {
    const profile = await requireMember(ctx);
    const rows = await ctx.db
      .query("providerConnections")
      .withIndex("by_owner", (q) => q.eq("ownerId", profile._id))
      .collect();
    return rows.map((c) => ({
      connectionId: c._id,
      provider: c.provider,
      providerLabel: PROVIDER_CATALOG[c.provider].label,
      label: c.label,
      model: c.model,
      keyHint: c.keyHint,
      status: c.status,
      lastTestedAt: c.lastTestedAt,
      lastError: c.lastError,
      updatedAt: c.updatedAt,
    }));
  },
});

export const viewerForAction = internalQuery({
  args: {},
  handler: async (ctx) => {
    const p = await requireMember(ctx);
    return { profileId: p._id };
  },
});

export const createPlaceholder = internalMutation({
  args: { ownerId: v.id("profiles"), provider: providerKind, label: v.string(), model: v.string(), keyHint: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    return ctx.db.insert("providerConnections", {
      ...args,
      encryptedKey: { keyVersion: "pending", iv: "", ciphertext: "" },
      status: "untested",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const storeConnection = internalMutation({
  args: {
    ownerId: v.id("profiles"),
    connectionId: v.id("providerConnections"),
    label: v.string(),
    model: v.string(),
    keyHint: v.optional(v.string()),
    encryptedKey: v.optional(v.object({ keyVersion: v.string(), iv: v.string(), ciphertext: v.string() })),
  },
  handler: async (ctx, args) => {
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.ownerId !== args.ownerId) throw appError(ERR.notFound, "Connection not found.");
    await ctx.db.patch(args.connectionId, {
      label: args.label,
      model: args.model,
      ...(args.encryptedKey ? { encryptedKey: args.encryptedKey, keyHint: args.keyHint ?? conn.keyHint } : {}),
      status: "untested",
      lastError: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const deletePlaceholder = internalMutation({
  args: { connectionId: v.id("providerConnections") },
  handler: async (ctx, { connectionId }) => {
    const c = await ctx.db.get(connectionId);
    if (c && c.encryptedKey.keyVersion === "pending") await ctx.db.delete(connectionId);
  },
});

function validateConnectionInput(args: { label: string; model: string; apiKey?: string }) {
  const label = args.label.trim();
  if (label.length < 1 || label.length > 60) throw appError("INVALID_CONNECTION", "Name must be 1-60 characters.");
  const model = args.model.trim();
  if (!MODEL_PATTERN.test(model)) throw appError("INVALID_CONNECTION", "Enter a valid model identifier.");
  const apiKey = args.apiKey?.trim();
  if (apiKey !== undefined && !API_KEY_PATTERN.test(apiKey)) throw appError("INVALID_CONNECTION", "The API key format is invalid.");
  return { label, model, apiKey };
}

/** Creates a connection or replaces its settings or key. The key is encrypted here and never returned. */
export const saveConnection = action({
  args: {
    connectionId: v.optional(v.id("providerConnections")),
    provider: providerKind,
    label: v.string(),
    model: v.string(),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ connectionId: Id<"providerConnections"> }> => {
    const { profileId } = await ctx.runQuery(internal.providers.viewerForAction, {});
    const input = validateConnectionInput(args);
    const keyring = credentialKeyring();
    let connectionId = args.connectionId;
    let createdPlaceholder = false;
    if (!connectionId) {
      if (!input.apiKey) throw appError("INVALID_CONNECTION", "An API key is required.");
      connectionId = await ctx.runMutation(internal.providers.createPlaceholder, {
        ownerId: profileId,
        provider: args.provider,
        label: input.label,
        model: input.model,
        keyHint: keyHint(input.apiKey),
      });
      createdPlaceholder = true;
    } else {
      const existing = await ctx.runQuery(internal.providers.getOwnedConnection, { ownerId: profileId, connectionId });
      if (!existing) throw appError(ERR.notFound, "Connection not found.");
      if (existing.provider !== args.provider) throw appError("INVALID_CONNECTION", "Provider cannot be changed; create a new connection.");
    }
    try {
      const encryptedKey = input.apiKey
        ? await encryptSecret(input.apiKey, connectionAad(profileId, connectionId, args.provider), keyring)
        : undefined;
      await ctx.runMutation(internal.providers.storeConnection, {
        ownerId: profileId,
        connectionId,
        label: input.label,
        model: input.model,
        encryptedKey,
        keyHint: input.apiKey ? keyHint(input.apiKey) : undefined,
      });
    } catch (e) {
      if (createdPlaceholder) await ctx.runMutation(internal.providers.deletePlaceholder, { connectionId });
      throw e;
    }
    return { connectionId };
  },
});

export const getOwnedConnection = internalQuery({
  args: { ownerId: v.id("profiles"), connectionId: v.id("providerConnections") },
  handler: async (ctx, { ownerId, connectionId }) => {
    const c = await ctx.db.get(connectionId);
    return c && c.ownerId === ownerId ? c : null;
  },
});

export const setConnectionStatus = internalMutation({
  args: { connectionId: v.id("providerConnections"), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { connectionId, ok, error }) => {
    await ctx.db.patch(connectionId, { status: ok ? "ok" : "failed", lastError: error, lastTestedAt: Date.now() });
  },
});

export const testConnection = action({
  args: { connectionId: v.id("providerConnections") },
  handler: async (ctx, { connectionId }): Promise<{ ok: boolean; error?: string }> => {
    const { profileId } = await ctx.runQuery(internal.providers.viewerForAction, {});
    const conn = await ctx.runQuery(internal.providers.getOwnedConnection, { ownerId: profileId, connectionId });
    if (!conn) throw appError(ERR.notFound, "Connection not found.");
    try {
      const apiKey = await decryptSecret(conn.encryptedKey, connectionAad(profileId, connectionId, conn.provider), credentialKeyring());
      await testProviderConnection({ provider: conn.provider, apiKey, model: conn.model });
      await ctx.runMutation(internal.providers.setConnectionStatus, { connectionId, ok: true });
      return { ok: true };
    } catch (e) {
      const error = e instanceof ProviderError ? e.message : "The connection test failed.";
      await ctx.runMutation(internal.providers.setConnectionStatus, { connectionId, ok: false, error });
      return { ok: false, error };
    }
  },
});

export const deleteConnection = mutation({
  args: { connectionId: v.id("providerConnections") },
  handler: async (ctx, { connectionId }) => {
    const profile = await requireMember(ctx);
    const conn = await ctx.db.get(connectionId);
    if (!conn || conn.ownerId !== profile._id) throw appError(ERR.notFound, "Connection not found.");
    // A selection pointing at this connection is kept on purpose: new builds then fail with PROVIDER_MISSING
    // until the member picks a replacement, instead of silently moving to another provider.
    await ctx.db.delete(connectionId);
  },
});

export const setAiSelection = mutation({
  args: { source: v.union(v.literal("platform"), v.literal("personal")), connectionId: v.optional(v.id("providerConnections")) },
  handler: async (ctx, { source, connectionId }) => {
    const profile = await requireMember(ctx);
    if (source === "platform") {
      await ctx.db.patch(profile._id, { aiSelection: { source: "platform" } });
      return;
    }
    if (!connectionId) throw appError("INVALID_SELECTION", "Choose a connection.");
    const conn = await ctx.db.get(connectionId);
    if (!conn || conn.ownerId !== profile._id) throw appError(ERR.notFound, "Connection not found.");
    await ctx.db.patch(profile._id, { aiSelection: { source: "personal", connectionId } });
  },
});

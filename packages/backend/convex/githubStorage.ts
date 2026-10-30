import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { appError, requireMember } from "./lib/access";
import { consumeAttempt } from "./lib/attempts";
import { ConfigError, storageAppConfig, storageAppConfigured, storageAppPublicConfig, storageRepoName, TIMING } from "./lib/config";
import { randomToken, sha256Hex } from "./lib/crypto";
import { GitHubError } from "./lib/github";
import {
  ensureStorageRepo,
  exchangeOAuthCode,
  findUserInstallation,
  getAuthenticatedUser,
  storageRepoToken,
  storageTokenFailure,
} from "./lib/githubStorage";
import { connectionFor, failSave } from "./lib/saves";

const CONNECT_LIMIT = { max: 20, windowMs: 15 * 60_000 };

function publicConnection(c: NonNullable<Awaited<ReturnType<typeof connectionFor>>>) {
  return {
    login: c.login,
    repoFullName: `${c.repoOwner}/${c.repoName}`,
    repoUrl: c.repoUrl,
    autoSave: c.autoSave,
    status: c.status,
    brokenReason: c.brokenReason,
    connectedAt: c.connectedAt,
  };
}

/** What the settings page shows. Never includes tokens or installation ids. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const profile = await requireMember(ctx);
    const configured = storageAppConfigured();
    const connection = await connectionFor(ctx, profile._id);
    let repoName: string | null = null;
    try {
      repoName = configured ? storageRepoName() : null;
    } catch {
      repoName = null;
    }
    return { configured, repoName, connection: connection ? publicConnection(connection) : null };
  },
});

/**
 * Starts connecting GitHub. Returns the app's install page (which also asks for authorization when the app requests
 * OAuth during installation) and the plain authorization page for members who already installed the app. Both carry
 * a one-time `state` bound to this member that expires after ten minutes.
 */
export const startConnect = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireMember(ctx);
    if (!storageAppConfigured()) throw appError("NOT_CONFIGURED", "Saving to GitHub is not set up on this LinxGen instance.");
    const limit = await consumeAttempt(ctx, `github-connect:${profile._id}`, CONNECT_LIMIT);
    if (!limit.allowed) {
      return { ok: false as const, message: "Too many connection attempts. Try again in a few minutes." };
    }
    let app: ReturnType<typeof storageAppPublicConfig>;
    try {
      app = storageAppPublicConfig();
    } catch (e) {
      if (e instanceof ConfigError) return { ok: false as const, message: "Saving to GitHub is misconfigured. Ask an administrator." };
      throw e;
    }
    const state = randomToken(32);
    const now = Date.now();
    await ctx.db.insert("githubConnectStates", {
      stateHash: await sha256Hex(state),
      profileId: profile._id,
      createdAt: now,
      expiresAt: now + TIMING.connectStateTtlMs,
    });
    const installUrl = new URL(`https://github.com/apps/${app.slug}/installations/new`);
    installUrl.searchParams.set("state", state);
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", app.clientId);
    authorizeUrl.searchParams.set("state", state);
    return { ok: true as const, installUrl: installUrl.toString(), authorizeUrl: authorizeUrl.toString(), expiresAt: now + TIMING.connectStateTtlMs };
  },
});

export const viewerProfileId = internalQuery({
  args: {},
  handler: async (ctx) => (await requireMember(ctx))._id,
});

/** Marks a state used. Returns false for unknown, expired, reused, or other members' states. */
export const consumeState = internalMutation({
  args: { stateHash: v.string(), profileId: v.id("profiles") },
  handler: async (ctx, { stateHash, profileId }) => {
    const row = await ctx.db
      .query("githubConnectStates")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", stateHash))
      .unique();
    if (!row || row.profileId !== profileId || row.usedAt || row.expiresAt < Date.now()) return false;
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    return true;
  },
});

export const saveConnection = internalMutation({
  args: {
    profileId: v.id("profiles"),
    githubUserId: v.number(),
    login: v.string(),
    installationId: v.number(),
    repoId: v.number(),
    repoOwner: v.string(),
    repoName: v.string(),
    repoUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile || profile.status !== "active") return;
    const existing = await connectionFor(ctx, args.profileId);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, status: "connected", brokenReason: undefined, updatedAt: now });
    } else {
      await ctx.db.insert("githubConnections", { ...args, autoSave: false, status: "connected", connectedAt: now, updatedAt: now });
    }
  },
});

type ConnectResult =
  | { ok: true; login: string; repoFullName: string; repoUrl: string; created: boolean }
  | { ok: false; code: string; message: string };

/**
 * Finishes connecting after GitHub redirects back with `code` and `state`. The member, their installation of the
 * storage app and the repository are all looked up with the member's own token; nothing from the redirect except
 * the code and the state is used.
 */
export const completeConnect = action({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, { code, state }): Promise<ConnectResult> => {
    const profileId = await ctx.runQuery(internal.githubStorage.viewerProfileId, {});
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(state) || !/^[A-Za-z0-9_-]{4,100}$/.test(code)) {
      return { ok: false, code: "invalid_request", message: "The GitHub response was malformed. Start again from Settings." };
    }
    const fresh = await ctx.runMutation(internal.githubStorage.consumeState, { stateHash: await sha256Hex(state), profileId });
    if (!fresh) {
      return { ok: false, code: "invalid_state", message: "This connection link expired or was already used. Start again from Settings." };
    }
    let cfg: ReturnType<typeof storageAppConfig>;
    try {
      cfg = storageAppConfig();
    } catch {
      return { ok: false, code: "not_configured", message: "Saving to GitHub is not set up on this LinxGen instance." };
    }
    try {
      const token = await exchangeOAuthCode(cfg, code);
      const user = await getAuthenticatedUser(token);
      if (user.type !== "User") return { ok: false, code: "not_a_user", message: "Connect a personal GitHub account, not an organization." };
      const installation = await findUserInstallation(token, cfg.appId, user);
      if (!installation) {
        return {
          ok: false,
          code: "not_installed",
          message: `LinxGen Storage is not installed on your personal account ${user.login}. Install it on your own account, not an organization.`,
        };
      }
      if (installation.suspended) {
        return { ok: false, code: "suspended", message: "LinxGen Storage is suspended on your account. Unsuspend it in GitHub settings." };
      }
      const ensured = await ensureStorageRepo(token, user, cfg.repoName, installation);
      if (!ensured.ok) return { ok: false, code: ensured.code, message: ensured.message };
      try {
        await storageRepoToken(cfg, installation.id, ensured.repo.id);
      } catch (e) {
        if (storageTokenFailure(e) === "repo_missing") {
          return {
            ok: false,
            code: "repo_not_in_installation",
            message: `LinxGen Storage cannot reach ${ensured.repo.fullName}. Add the repository to the app in your GitHub settings, then connect again.`,
          };
        }
        throw e;
      }
      await ctx.runMutation(internal.githubStorage.saveConnection, {
        profileId,
        githubUserId: user.id,
        login: user.login,
        installationId: installation.id,
        repoId: ensured.repo.id,
        repoOwner: ensured.repo.owner,
        repoName: ensured.repo.name,
        repoUrl: ensured.repo.htmlUrl,
      });
      return { ok: true, login: user.login, repoFullName: ensured.repo.fullName, repoUrl: ensured.repo.htmlUrl, created: ensured.created };
    } catch (e) {
      if (e instanceof GitHubError) {
        console.error("GitHub storage connect failed", e.message);
        return { ok: false, code: "github_error", message: "GitHub did not accept the request. Start again from Settings." };
      }
      throw e;
    }
  },
});

/** Removes the link in LinxGen. The app stays installed on GitHub until the member uninstalls it there; the repository is kept. */
export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireMember(ctx);
    const connection = await connectionFor(ctx, profile._id);
    if (!connection) return { ok: true };
    await ctx.db.delete(connection._id);
    const queued = await ctx.db
      .query("saves")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", profile._id).eq("status", "queued"))
      .collect();
    for (const s of queued) await failSave(ctx, s._id, "not_connected");
    return { ok: true };
  },
});

export const setAutoSave = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const profile = await requireMember(ctx);
    const connection = await connectionFor(ctx, profile._id);
    if (!connection) throw appError("NOT_CONNECTED", "Connect GitHub first.");
    await ctx.db.patch(connection._id, { autoSave: enabled, updatedAt: Date.now() });
  },
});

export const pruneConnectStates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("githubConnectStates")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now() - 60 * 60_000))
      .take(200);
    for (const row of old) await ctx.db.delete(row._id);
    return old.length;
  },
});

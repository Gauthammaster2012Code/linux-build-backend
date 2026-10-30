import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { APIError, createAuthMiddleware, getIp } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import type { GenericActionCtx } from "convex/server";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

export const authComponent = createClient<DataModel>(components.betterAuth);

export const PASSWORD_LENGTH = { min: 12, max: 128 } as const;

/** Error codes the web app maps to messages. */
export const AUTH_ERROR = {
  inviteRequired: "INVITE_CODE_REQUIRED",
  inviteInvalid: "INVITE_CODE_INVALID",
  inviteExpired: "INVITE_CODE_EXPIRED",
  tooManyAttempts: "TOO_MANY_ATTEMPTS",
  signUpOnly: "SIGN_UP_REQUIRES_INVITE",
} as const;

/**
 * Better Auth routes that would send email, sign in through a third party or change the email an invitation was
 * bound to. No email sender or social provider is configured, so these are switched off outright.
 */
const DISABLED_PATHS = [
  "/sign-in/social",
  "/link-social",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/verify-email",
  "/change-email",
  "/delete-user",
];

type Runner = Pick<GenericActionCtx<DataModel>, "runQuery" | "runMutation">;

/** Auth routes run in HTTP actions. createAuth is also called with an empty placeholder when routes are registered. */
function runner(ctx: GenericCtx<DataModel>): Runner {
  if (!("runMutation" in ctx) || typeof ctx.runMutation !== "function") {
    throw new APIError("INTERNAL_SERVER_ERROR", { message: "Authentication is not available here." });
  }
  return ctx as Runner;
}

function bodyString(body: unknown, key: string): string {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

/**
 * Per-IP limits. If Better Auth cannot resolve a single trusted client IP, every request shares one bucket per path,
 * so that case gets a looser limit; the per-email sign-in limit still applies.
 */
function perIp(window: number, max: number, sharedMax: number) {
  return (request: Request) => (getIp(request, {}) ? { window, max } : { window, max: sharedMax });
}

/** Email and password only. Sign-up needs an invite code; membership is activated separately by profiles.acceptInvitation. */
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = process.env.SITE_URL ?? "";
  return betterAuth({
    baseURL: siteUrl,
    trustedOrigins: siteUrl ? [siteUrl] : [],
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      minPasswordLength: PASSWORD_LENGTH.min,
      maxPasswordLength: PASSWORD_LENGTH.max,
    },
    disabledPaths: DISABLED_PATHS,
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": perIp(60, 5, 60),
        "/sign-up/email": perIp(60 * 60, 5, 30),
        "/change-password": perIp(60, 5, 30),
        // Session reads and token refreshes are frequent and need a session; limiting them would cost a database
        // write per request.
        "/**": false,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (c) => {
        if (c.path === "/sign-up/email") {
          const code = bodyString(c.body, "inviteCode");
          if (!code.trim()) {
            throw new APIError("FORBIDDEN", { code: AUTH_ERROR.inviteRequired, message: "An invite code is required to create an account." });
          }
          const result = await runner(ctx).runQuery(internal.authGate.checkSignUpInvite, {
            email: bodyString(c.body, "email").slice(0, 320),
            code,
          });
          if (!result.ok) {
            throw new APIError(
              "FORBIDDEN",
              result.reason === "expired"
                ? { code: AUTH_ERROR.inviteExpired, message: "This invite code has expired. Ask an administrator for a new one." }
                : { code: AUTH_ERROR.inviteInvalid, message: "This invite code is not valid for this email address." },
            );
          }
        }
        if (c.path === "/sign-in/email") {
          const email = bodyString(c.body, "email").slice(0, 320);
          if (!email) return;
          const result = await runner(ctx).runMutation(internal.authGate.consumeSignInAttempt, { email });
          if (!result.allowed) {
            throw new APIError(
              "TOO_MANY_REQUESTS",
              { code: AUTH_ERROR.tooManyAttempts, message: "Too many sign-in attempts for this account. Try again later." },
              { "X-Retry-After": String(result.retryAfterSeconds) },
            );
          }
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // The sign-up hook above is the only gate for invite codes, so no other route may create users.
          before: async (_user, c) => {
            if (c?.path !== "/sign-up/email") {
              throw new APIError("FORBIDDEN", { code: AUTH_ERROR.signUpOnly, message: "Accounts can only be created with an invite code." });
            }
          },
        },
      },
    },
    plugins: [convex({ authConfig })],
  });
};

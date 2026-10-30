import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "./crypto";

export const INVITATION_TTL_MS = 14 * 24 * 60 * 60_000;

/** Crockford base32: no I, L, O or U, so codes survive being read aloud or retyped. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_SYMBOLS = 28; // 140 bits
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{28}$/;

export function generateInviteCode(): string {
  const bytes = new Uint8Array(CODE_SYMBOLS);
  crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so masking to 5 bits keeps every symbol uniformly likely.
  const symbols = Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
  return symbols.match(/.{4}/g)!.join("-");
}

/** Accepts codes with any case, spaces or dashes, and the usual Crockford look-alikes. Returns null for malformed input. */
export function normalizeInviteCode(input: string): string | null {
  if (input.length > 64) return null;
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return CODE_PATTERN.test(s) ? s : null;
}

export function hashInviteCode(normalized: string): Promise<string> {
  return sha256Hex(`linxgen-invite:v1:${normalized}`);
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type InviteCheck =
  | { ok: true; invitationId: Id<"invitations">; role: "member" | "admin" }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * Looks up an invitation by code and checks that it is pending, unexpired and issued to this email. Only the hash is
 * stored, so the lookup itself never compares plaintext codes. Expiry is only revealed to someone holding the code for
 * the matching email.
 */
export async function checkInviteCode(
  ctx: Pick<QueryCtx, "db">,
  code: string,
  email: string,
  now = Date.now(),
): Promise<InviteCheck> {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return { ok: false, reason: "invalid" };
  const codeHash = await hashInviteCode(normalized);
  const invitation = await ctx.db
    .query("invitations")
    .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
    .unique();
  if (!invitation || invitation.email !== normalizeEmail(email) || invitation.status !== "pending") {
    return { ok: false, reason: "invalid" };
  }
  if (invitation.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, invitationId: invitation._id, role: invitation.role };
}

/** Creates a pending invitation with a fresh one-time code and revokes older pending invitations for the email. */
export async function issueInvitation(
  ctx: MutationCtx,
  args: { email: string; role: "member" | "admin"; invitedBy?: Id<"profiles"> },
) {
  const email = normalizeEmail(args.email);
  const now = Date.now();
  const existing = await ctx.db
    .query("invitations")
    .withIndex("by_email", (q) => q.eq("email", email))
    .collect();
  for (const inv of existing) if (inv.status === "pending") await ctx.db.patch(inv._id, { status: "revoked" });
  const code = generateInviteCode();
  const expiresAt = now + INVITATION_TTL_MS;
  const invitationId = await ctx.db.insert("invitations", {
    email,
    role: args.role,
    status: "pending",
    codeHash: await hashInviteCode(normalizeInviteCode(code)!),
    invitedBy: args.invitedBy,
    createdAt: now,
    expiresAt,
  });
  return { invitationId, email, role: args.role, code, expiresAt };
}

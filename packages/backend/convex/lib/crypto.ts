/** WebCrypto helpers. Usable from queries, mutations, actions and HTTP actions. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface EncryptedSecret {
  keyVersion: string;
  iv: string;
  ciphertext: string;
}

async function importAesKey(b64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(b64);
  if (raw.length !== 32) throw new Error("Credential encryption keys must be 32 bytes (base64 encoded)");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM with associated data, so a ciphertext copied to another owner's row fails to decrypt. */
export async function encryptSecret(
  plaintext: string,
  associatedData: string,
  keyring: { current: string; keys: Record<string, string> },
): Promise<EncryptedSecret> {
  const keyB64 = keyring.keys[keyring.current];
  if (!keyB64) throw new Error("Current encryption key missing");
  const key = await importAesKey(keyB64);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(associatedData) },
    key,
    encoder.encode(plaintext),
  );
  return { keyVersion: keyring.current, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ct)) };
}

export async function decryptSecret(
  secret: EncryptedSecret,
  associatedData: string,
  keyring: { current: string; keys: Record<string, string> },
): Promise<string> {
  const keyB64 = keyring.keys[secret.keyVersion];
  if (!keyB64) throw new Error(`Encryption key version ${secret.keyVersion} is not configured`);
  const key = await importAesKey(keyB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(secret.iv), additionalData: encoder.encode(associatedData) },
    key,
    base64ToBytes(secret.ciphertext),
  );
  return decoder.decode(pt);
}

/** Derives the per-attempt dispatch nonce so it never needs to be stored or passed through scheduler arguments. */
export function dispatchNonce(secret: string, attemptId: string): Promise<string> {
  return hmacSha256Base64Url(secret, `dispatch:v1:${attemptId}`);
}

/** Nonce for a save attempt. The distinct prefix keeps it from ever matching a build attempt's nonce. */
export function saveDispatchNonce(secret: string, saveAttemptId: string): Promise<string> {
  return hmacSha256Base64Url(secret, `save-dispatch:v1:${saveAttemptId}`);
}

export function capabilityToken(attemptId: string): string {
  return `${attemptId}.${randomToken(32)}`;
}

export function parseCapabilityToken(token: string): { attemptId: string } | null {
  const m = token.match(/^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/);
  return m?.[1] ? { attemptId: m[1] } : null;
}

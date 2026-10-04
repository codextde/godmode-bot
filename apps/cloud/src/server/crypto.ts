/** Tokens, ids, hashing and encryption of secrets at rest. */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "./config";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** No 0/O, 1/I/L: read aloud and typed without mistakes. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function pick(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** `usr_4fK9…`: a prefix and 16 base62 characters (95 bits). */
export function newId(prefix: string): string {
  return `${prefix}_${pick(BASE62, 16)}`;
}

/** A bearer secret: `bytes` random bytes, base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** "KQZM-7HPD": shown on the computer and in the browser while linking. */
export function newUserCode(): string {
  return `${pick(CODE_ALPHABET, 4)}-${pick(CODE_ALPHABET, 4)}`;
}

/** "KQZM-7HPD-3XWA": printed to the server log while nobody has claimed a fresh instance. */
export function newSetupCode(): string {
  return `${pick(CODE_ALPHABET, 4)}-${pick(CODE_ALPHABET, 4)}-${pick(CODE_ALPHABET, 4)}`;
}

/** Eight digits for signing in on the browser that asked for the e-mail. */
export function newLoginCode(): string {
  return String(randomInt(100_000_000)).padStart(8, "0");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

const hmacKeys = new Map<string, Buffer>();

/**
 * HMAC-SHA256 with a key derived for `purpose`. For low-entropy values (sign-in codes) whose plain hash a database
 * reader could reverse by trying every value.
 */
export function keyedHash(purpose: string, value: string): string {
  let k = hmacKeys.get(purpose);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", config().appSecret, "godmode-cloud", `hmac:${purpose}`, 32));
    hmacKeys.set(purpose, k);
  }
  return createHmac("sha256", k).update(value).digest("hex");
}

let key: Buffer | null = null;

function secretKey(): Buffer {
  key ??= Buffer.from(hkdfSync("sha256", config().appSecret, "godmode-cloud", "secrets-v1", 32));
  return key;
}

const PREFIX = "v1";

/** AES-256-GCM. The result is `v1.<iv>.<ciphertext>.<tag>`, each part base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), data.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/** Null when the value was not written by `encryptSecret` with this instance's key. */
export function decryptSecret(sealed: string): string | null {
  const [prefix, iv, data, tag] = sealed.split(".");
  if (prefix !== PREFIX || !iv || data === undefined || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** For tests. */
export function resetCrypto(): void {
  key = null;
  hmacKeys.clear();
}

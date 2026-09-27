import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

/**
 * Envelope encryption primitives.
 *
 *  passphrase --scrypt--> KEK (key-encryption key)
 *  KEK --AES-256-GCM--> wraps a random 256-bit DEK (data-encryption key)
 *  DEK --AES-256-GCM (+AAD)--> every secret field
 *
 * The DEK never touches disk unencrypted, except when the user opts into
 * "remember this device" in which case it is stored in the OS keychain.
 */

export interface KdfParams {
  algo: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string; // base64
}

export const DEFAULT_KDF: Omit<KdfParams, "salt"> = { algo: "scrypt", N: 1 << 17, r: 8, p: 1 };

export function deriveKey(passphrase: string, params: KdfParams): Buffer {
  const maxmem = 256 * params.N * params.r + 16 * 1024 * 1024;
  return scryptSync(passphrase.normalize("NFKC"), Buffer.from(params.salt, "base64"), 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

export function newKdfParams(): KdfParams {
  return { ...DEFAULT_KDF, salt: randomBytes(16).toString("base64") };
}

export function randomKey(): Buffer {
  return randomBytes(32);
}

const VERSION = "v1";

/** Encrypt UTF-8 text. Output: `v1.<iv>.<ciphertext+tag>` (base64url). */
export function encrypt(key: Buffer, plaintext: string, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("base64url")}.${Buffer.concat([ct, tag]).toString("base64url")}`;
}

export function decrypt(key: Buffer, payload: string, aad = ""): string {
  return decryptBytes(key, payload, aad).toString("utf8");
}

export function encryptBytes(key: Buffer, data: Uint8Array, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("base64url")}.${Buffer.concat([ct, tag]).toString("base64url")}`;
}

export function decryptBytes(key: Buffer, payload: string, aad = ""): Buffer {
  const [version, ivB64, dataB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !dataB64) throw new Error("Unsupported ciphertext format");
  const iv = Buffer.from(ivB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");
  if (data.length < 16) throw new Error("Ciphertext too short");
  const ct = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Binary container for backups: magic | kdf json len (u32 BE) | kdf json | iv | ct | tag.
 *  - v1 (`GMBK1`): AAD = magic only (read-only support for old backups).
 *  - v2 (`GMBK2`): AAD = everything before the IV, so the KDF header is authenticated too.
 */
const MAGIC_V1 = Buffer.from("GMBK1\n", "utf8");
const MAGIC_V2 = Buffer.from("GMBK2\n", "utf8");
const MAX_KDF_HEADER_BYTES = 4096;

/** Upper bounds for scrypt parameters read from untrusted input (backup headers, restored vault metadata). */
export const KDF_LIMITS = { maxN: 1 << 20, maxR: 16, maxP: 4, minSaltBytes: 16, maxSaltBytes: 64 } as const;

/**
 * Validate KDF parameters that came from outside (a backup file). Rejects anything that would make scrypt
 * allocate absurd amounts of memory / CPU, and malformed salts.
 */
export function assertSafeKdf(value: unknown): KdfParams {
  const kdf = value as Partial<KdfParams> | null;
  const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
  if (!kdf || typeof kdf !== "object" || kdf.algo !== "scrypt") throw new Error("Unsupported key derivation");
  const { N, r, p, salt } = kdf;
  if (!isInt(N) || N < 2 || N > KDF_LIMITS.maxN || (N & (N - 1)) !== 0) throw new Error("Unsupported key derivation parameters");
  if (!isInt(r) || r < 1 || r > KDF_LIMITS.maxR) throw new Error("Unsupported key derivation parameters");
  if (!isInt(p) || p < 1 || p > KDF_LIMITS.maxP) throw new Error("Unsupported key derivation parameters");
  if (typeof salt !== "string" || salt.length > 128) throw new Error("Unsupported key derivation parameters");
  const saltBytes = Buffer.from(salt, "base64").length;
  if (saltBytes < KDF_LIMITS.minSaltBytes || saltBytes > KDF_LIMITS.maxSaltBytes) throw new Error("Unsupported key derivation parameters");
  return { algo: "scrypt", N, r, p, salt };
}

export function sealWithPassphrase(passphrase: string, data: Uint8Array): Uint8Array {
  const kdf = { ...DEFAULT_KDF, N: 1 << 16, salt: randomBytes(16).toString("base64") } satisfies KdfParams;
  const key = deriveKey(passphrase, kdf);
  const header = Buffer.from(JSON.stringify(kdf), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  const prefix = Buffer.concat([MAGIC_V2, len, header]);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(prefix);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([prefix, iv, ct, tag]);
}

export function openWithPassphrase(passphrase: string, sealed: Uint8Array): Uint8Array {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const magic = buf.subarray(0, MAGIC_V1.length);
  const v2 = magic.equals(MAGIC_V2);
  if (!v2 && !magic.equals(MAGIC_V1)) throw new Error("Not a Godmode backup file");
  let offset = MAGIC_V1.length;
  if (buf.length < offset + 4) throw new Error("Corrupted backup file");
  const len = buf.readUInt32BE(offset);
  offset += 4;
  // The header is read before anything is authenticated: bound its size and the KDF cost it may ask for.
  if (len === 0 || len > MAX_KDF_HEADER_BYTES || buf.length < offset + len + 12 + 16) throw new Error("Corrupted backup file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.subarray(offset, offset + len).toString("utf8"));
  } catch {
    throw new Error("Corrupted backup file");
  }
  const kdf = assertSafeKdf(parsed);
  offset += len;
  const aad = v2 ? buf.subarray(0, offset) : MAGIC_V1;
  const iv = buf.subarray(offset, offset + 12);
  offset += 12;
  const ct = buf.subarray(offset, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const key = deriveKey(passphrase, kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("Wrong backup passphrase or corrupted file");
  }
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Password hashing for dashboard login (scrypt, self-describing). */
export function hashPassword(password: string): string {
  const params = { ...DEFAULT_KDF, N: 1 << 15, salt: randomBytes(16).toString("base64") } satisfies KdfParams;
  const hash = deriveKey(password, params).toString("base64");
  return `scrypt$${params.N}$${params.r}$${params.p}$${params.salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, N, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !N || !r || !p || !salt || !hash) return false;
  const derived = deriveKey(password, { algo: "scrypt", N: Number(N), r: Number(r), p: Number(p), salt }).toString("base64");
  return safeEqual(derived, hash);
}

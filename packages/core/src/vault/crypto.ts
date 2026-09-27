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

/** Binary container for backups: magic | kdf json len | kdf json | iv | ct | tag */
const MAGIC = Buffer.from("GMBK1\n", "utf8");

export function sealWithPassphrase(passphrase: string, data: Uint8Array): Uint8Array {
  const kdf = { ...DEFAULT_KDF, N: 1 << 16, salt: randomBytes(16).toString("base64") } satisfies KdfParams;
  const key = deriveKey(passphrase, kdf);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from(JSON.stringify(kdf), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, len, header, iv, ct, tag]);
}

export function openWithPassphrase(passphrase: string, sealed: Uint8Array): Uint8Array {
  const buf = Buffer.from(sealed);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a Godmode backup file");
  let offset = MAGIC.length;
  const len = buf.readUInt32BE(offset);
  offset += 4;
  const kdf = JSON.parse(buf.subarray(offset, offset + len).toString("utf8")) as KdfParams;
  offset += len;
  const iv = buf.subarray(offset, offset + 12);
  offset += 12;
  const ct = buf.subarray(offset, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const key = deriveKey(passphrase, kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(MAGIC);
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

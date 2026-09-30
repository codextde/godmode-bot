/**
 * SSH keys: private keys (OpenSSH, PEM, PuTTY) as saved for a server, fingerprints as OpenSSH prints them, new Ed25519
 * key pairs, and the private keys in ~/.ssh of the computer running Godmode.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { utils, type ParsedKey } from "ssh2";
import type { SshGeneratedKey, SshKeyInfo, SshLocalKey } from "@godmode/shared";

const MAX_KEY_BYTES = 64 * 1024;
const PRIVATE_KEY = /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|^PuTTY-User-Key-File-\d+:/m;
const PUBLIC_KEY_LINE = /^(?:ssh-[\w.@-]+|ecdsa-sha2-[\w.@-]+|sk-[\w.@-]+)\s+AAAA[\w+/=]+/;

/** A private key that can't be used, in words for the human. */
export class SshKeyError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "passphrase_required" | "bad_passphrase",
  ) {
    super(message);
  }
}

/** OpenSSH's fingerprint of a public key blob: "SHA256:" and the unpadded base64 of its SHA-256. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The key type a public key blob starts with, e.g. "ssh-ed25519". */
export function blobType(blob: Buffer): string {
  if (blob.length < 4) return "unknown";
  const len = blob.readUInt32BE(0);
  return len > 0 && len < 64 && blob.length >= 4 + len ? blob.subarray(4, 4 + len).toString("latin1") : "unknown";
}

function infoOf(key: ParsedKey, encrypted: boolean): SshKeyInfo {
  const blob = key.getPublicSSH();
  return {
    type: key.type,
    fingerprint: fingerprintOf(blob),
    publicKey: `${key.type} ${blob.toString("base64")}${key.comment ? ` ${key.comment}` : ""}`,
    encrypted,
  };
}

function firstKey(parsed: ParsedKey | ParsedKey[] | Error): ParsedKey | Error {
  return Array.isArray(parsed) ? (parsed[0] ?? new Error("no key found")) : parsed;
}

/** Parse a private key (with its passphrase when it has one); throws SshKeyError with a message for the human. */
export function parsePrivateKey(text: string, passphrase?: string | null): { key: ParsedKey; info: SshKeyInfo } {
  const trimmed = text.trim();
  if (!trimmed) throw new SshKeyError("The private key is empty.", "invalid");
  if (Buffer.byteLength(trimmed) > MAX_KEY_BYTES) throw new SshKeyError("That is too long for a private key.", "invalid");
  if (PUBLIC_KEY_LINE.test(trimmed)) {
    throw new SshKeyError("That's a public key. Use the private key — the file without .pub, e.g. ~/.ssh/id_ed25519.", "invalid");
  }
  const plain = firstKey(utils.parseKey(trimmed) as ParsedKey | ParsedKey[] | Error);
  if (!(plain instanceof Error)) {
    if (!plain.isPrivateKey()) throw new SshKeyError("That's a public key. Use the private key — the file without .pub.", "invalid");
    return { key: plain, info: infoOf(plain, false) };
  }
  if (!/passphrase|encrypted/i.test(plain.message)) {
    throw new SshKeyError(`This isn't a private key Godmode can read (OpenSSH, PEM or PuTTY): ${plain.message}`, "invalid");
  }
  if (!passphrase) throw new SshKeyError("This key is protected with a passphrase — enter it as well.", "passphrase_required");
  const unlocked = firstKey(utils.parseKey(trimmed, passphrase) as ParsedKey | ParsedKey[] | Error);
  if (unlocked instanceof Error || !unlocked.isPrivateKey()) throw new SshKeyError("The passphrase doesn't unlock this key.", "bad_passphrase");
  return { key: unlocked, info: infoOf(unlocked, true) };
}

/**
 * ssh2's generateKeyPairSync for Ed25519, minus its bug: it strips leading zero bytes off the public key, so the 1 key
 * in 256 whose public key starts with one can't be read back. Such a pair is drawn again.
 */
export function generateEd25519(opts: Parameters<typeof utils.generateKeyPairSync<"ed25519">>[1] = {}): utils.KeyPairReturn {
  for (;;) {
    const pair = utils.generateKeyPairSync("ed25519", opts);
    if (!(utils.parseKey(pair.public) instanceof Error)) return pair;
  }
}

/** A new Ed25519 key pair in OpenSSH format. */
export function generateKeyPair(comment = "godmode"): SshGeneratedKey {
  const pair = generateEd25519({ comment });
  const { info } = parsePrivateKey(pair.private);
  return { privateKey: pair.private, publicKey: pair.public.trim(), type: info.type, fingerprint: info.fingerprint };
}

/** Public key blob stored in the clear inside an OpenSSH private key (also when the key itself is encrypted). */
function openSshPublicBlob(text: string): Buffer | null {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (!m?.[1]) return null;
  try {
    const data = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
    const magic = "openssh-key-v1\0";
    if (data.subarray(0, magic.length).toString("latin1") !== magic) return null;
    let off = magic.length;
    const str = () => {
      const len = data.readUInt32BE(off);
      off += 4;
      const s = data.subarray(off, off + len);
      off += len;
      return s;
    };
    str(); // cipher
    str(); // kdf
    str(); // kdf options
    const count = data.readUInt32BE(off);
    off += 4;
    return count > 0 ? str() : null;
  } catch {
    return null;
  }
}

/** Where Godmode looks for the human's own keys. */
export function sshDir(): string {
  return join(process.env.HOME || homedir(), ".ssh");
}

const NOT_KEYS = /^(?:known_hosts|authorized_keys|config|environment|allowed_signers)(?:[._-].*)?$|\.(?:pub|old|bak|sock|txt|md)$/i;

/** Private keys in ~/.ssh on this computer (for importing into a server; nothing is copied until the human picks one). */
export function listLocalKeys(): SshLocalKey[] {
  const dir = sshDir();
  if (!existsSync(dir)) return [];
  const keys: SshLocalKey[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries.sort()) {
    if (name.startsWith(".") || NOT_KEYS.test(name)) continue;
    const path = join(dir, name);
    let text: string;
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > MAX_KEY_BYTES) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!PRIVATE_KEY.test(text)) continue;
    let type = "";
    let fingerprint = "";
    let comment = "";
    let encrypted = false;
    try {
      const { info, key } = parsePrivateKey(text);
      ({ type, fingerprint } = info);
      comment = key.comment;
    } catch (err) {
      if (!(err instanceof SshKeyError) || err.code !== "passphrase_required") continue;
      encrypted = true;
      const pubLine = existsSync(`${path}.pub`) ? readFileSync(`${path}.pub`, "utf8").trim() : "";
      const [pubType, pubData, ...rest] = pubLine.split(/\s+/);
      const blob = pubData ? Buffer.from(pubData, "base64") : openSshPublicBlob(text);
      if (blob?.length) {
        type = pubType || blobType(blob);
        fingerprint = fingerprintOf(blob);
      }
      comment = rest.join(" ");
    }
    keys.push({ path, name, type: type || "unknown", fingerprint, encrypted, comment });
  }
  return keys;
}

/** The contents of a key listed by `listLocalKeys` (anything else is refused). */
export function readLocalKey(path: string): string {
  const key = listLocalKeys().find((k) => k.path === path);
  if (!key) throw new SshKeyError("That key isn't in ~/.ssh on this computer (anymore).", "invalid");
  const real = realpathSync(path);
  if (!existsSync(real)) throw new SshKeyError("That key isn't in ~/.ssh on this computer (anymore).", "invalid");
  return readFileSync(real, "utf8");
}

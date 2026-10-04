/**
 * This installation's link key: the static X25519 key pair a runner is recognised by and a controller proves itself
 * with. It lives in `<dataDir>/link-key`, readable by its owner only, and is created the first time it is needed. The
 * private half never leaves this file.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { canonicalKey, controllerLookupId, fingerprint, generateKeyPair, isKeyPair, type LinkIdentity } from "./crypto";

export { controllerLookupId, fingerprint };
export type { LinkIdentity };

export const LINK_KEY_FILE = "link-key";

/** The link key of the installation in `dataDir` (default: this one's data dir); created on first use. */
export function loadIdentity(dataDir: string = config().dataDir): LinkIdentity {
  const file = join(dataDir, LINK_KEY_FILE);
  return readIdentity(file) ?? createIdentity(dataDir, file);
}

function readIdentity(file: string): LinkIdentity | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* reported below */
  }
  const { publicKey, privateKey } = (parsed && typeof parsed === "object" ? parsed : {}) as Partial<LinkIdentity>;
  // A key that can't be read is never replaced on its own: a new one would silently undo every pairing.
  if (typeof publicKey !== "string" || typeof privateKey !== "string" || !isKeyPair({ publicKey, privateKey })) {
    throw new Error(`The link key in ${file} is damaged. Delete the file and pair this computer again.`);
  }
  ownerOnly(file);
  return { publicKey: canonicalKey(publicKey), privateKey: canonicalKey(privateKey) };
}

/**
 * Writes a new key beside the final name and hard-links it into place. On a fresh install the CLI and the server ask
 * for the key at the same moment: the link fails for whoever comes second, who then reads the winner's key, and nobody
 * ever sees a half-written file or ends up with a key that differs from the one on disk.
 */
function createIdentity(dataDir: string, file: string): LinkIdentity {
  const identity = generateKeyPair();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const draft = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(draft, JSON.stringify(identity) + "\n", { mode: 0o600, flag: "wx" });
    ownerOnly(draft);
    try {
      linkSync(draft, file);
    } catch (err) {
      const existing = (err as NodeJS.ErrnoException).code === "EEXIST" ? readIdentity(file) : null;
      if (existing) return existing;
      throw err;
    }
  } finally {
    rmSync(draft, { force: true });
  }
  return identity;
}

function ownerOnly(file: string): void {
  try {
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

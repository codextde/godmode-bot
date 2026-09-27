/**
 * Optional browser-use Cloud sync via browser-use's `profile-use` CLI
 * (https://github.com/browser-use/profile-use-releases): uploads a local Chrome profile's cookies to a
 * browser-use Cloud profile. Needs a browser-use API key (vault app secret `browser_use_api_key`).
 *
 * Godmode downloads a pinned release binary into `<dataDir>/bin` and checks its SHA-256 before installing it.
 * Binaries are only ever run from there, PATH or ~/.local/bin — never from temp dirs (world-writable, plantable).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ProfileUseStatus, ProfileUseSyncInput, ProfileUseSyncResult } from "@godmode/shared";
import { config } from "../config";
import { getMeta, setMeta } from "../db";
import { logger } from "../log";
import { HttpError, badRequest, which } from "../util";
import { getAppSecret, hasAppSecret } from "../vault/vault";
import { runCommand, stripAnsi } from "../services/doctor";
import { browserSources, listLocalChromeProfiles } from "./importer";

const log = logger("profile-use");

const RELEASES_REPO = "browser-use/profile-use-releases";
/** Pinned release and the SHA-256 of each of its binaries (GitHub's published asset digests). Bump together. */
const PINNED_RELEASE = "v1.0.5";
const PINNED_SHA256: Record<string, string> = {
  "profile-use-darwin-amd64": "8b00783d2f986f0ff8c4fafb4070977c2bd4f38b939748c492956c493519d432",
  "profile-use-darwin-arm64": "be1f4182dab453019424a98ee704ffb3b721bdf03d33cba498aca1dae84e11e4",
  "profile-use-linux-amd64": "c28eef6cc99d3e70d543a681cc313552e3ebec33d6b5d25527bd7b26e9163965",
  "profile-use-linux-arm64": "fe29533562c00f556b38d2fb033432427de092e73dc81d52c04ca22d5c7004b3",
  "profile-use-windows-amd64.exe": "9fe2dbd688c53c974d9c56a824a442d2b84d6986038744d13001f45ae6ab9999",
  "profile-use-windows-arm64.exe": "94140d7a7123369421de5d99cd79afa766f4ad8738cb85d77863306b0f3d1807",
};
const SYNC_TIMEOUT_MS = 5 * 60_000;
const API_KEY_SECRET = "browser_use_api_key";
const LAST_SYNC_META = "profile_use.last_sync_at";

const binaryName = () => (process.platform === "win32" ? "profile-use.exe" : "profile-use");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function managedBinaryPath(): string {
  return join(config().dataDir, "bin", binaryName());
}

/** Path to a profile-use binary: Godmode's own copy, PATH or ~/.local/bin (never temp or installer work dirs). */
export function resolveProfileUse(): string | null {
  const candidates = [
    (() => {
      try {
        return managedBinaryPath();
      } catch {
        return null;
      }
    })(),
    which("profile-use"),
    join(homedir(), ".local", "bin", binaryName()),
  ];
  for (const c of candidates) if (c && isFile(c)) return c;
  return null;
}

function hasApiKey(): boolean {
  if (process.env.BROWSER_USE_API_KEY) return true;
  try {
    return hasAppSecret(API_KEY_SECRET);
  } catch {
    return false;
  }
}

export function profileUseStatus(): ProfileUseStatus {
  const path = resolveProfileUse();
  const keySet = hasApiKey();
  let lastSyncAt: string | null = null;
  try {
    lastSyncAt = getMeta(LAST_SYNC_META);
  } catch {
    /* database not open */
  }
  const detail = !path
    ? "profile-use is not installed. Install it here, or put the profile-use binary on your PATH or in ~/.local/bin."
    : !keySet
      ? "Add your browser-use API key (Settings → Integrations) to sync profiles to browser-use Cloud."
      : "Ready to sync local browser profiles to browser-use Cloud.";
  return { installed: !!path, path, hasApiKey: keySet, lastSyncAt, detail };
}

function releaseAsset(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch) throw badRequest(`profile-use has no release for ${process.platform}/${process.arch}`);
  return `profile-use-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

/** Download the pinned profile-use release binary into `<dataDir>/bin`, verifying its SHA-256 first. */
export async function installProfileUse(): Promise<ProfileUseStatus> {
  const asset = releaseAsset();
  const expected = PINNED_SHA256[asset];
  if (!expected) throw badRequest(`profile-use has no pinned release for ${process.platform}/${process.arch}`);
  const url = `https://github.com/${RELEASES_REPO}/releases/download/${PINNED_RELEASE}/${asset}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "godmode-bot" } });
  if (!res.ok) throw new HttpError(502, `Downloading profile-use failed (HTTP ${res.status})`, "upstream_error");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new HttpError(502, `The downloaded profile-use binary failed its SHA-256 check (got ${actual.slice(0, 12)}…); not installed.`, "upstream_error");
  }

  const target = managedBinaryPath();
  mkdirSync(join(config().dataDir, "bin"), { recursive: true, mode: 0o700 });
  const tmp = `${target}.download`;
  writeFileSync(tmp, bytes, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  if (process.platform === "darwin") await runCommand(["/usr/bin/xattr", "-d", "com.apple.quarantine", target], { timeoutMs: 10_000 });
  log.info(`installed profile-use ${PINNED_RELEASE} at ${target}`);
  return profileUseStatus();
}

const DOMAIN_RE = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i;

/** `profile-use sync …` with the API key from the vault; output is returned with the key redacted. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Browser + profile filters for a local profile folder (`LocalChromeProfile.path`). */
async function filtersForPath(sourcePath: string): Promise<{ browser: string; profiles: string[] }> {
  const path = resolve(sourcePath);
  const listed = (await listLocalChromeProfiles()).find((p) => resolve(p.path) === path);
  const root = dirname(path);
  const browser = listed?.browser ?? browserSources().find((s) => resolve(s.root) === root)?.browser;
  if (!browser) throw badRequest(`${sourcePath} is not a known local browser profile`);
  // profile-use matches profiles by name; pass the folder name and the display name (the filter is repeatable).
  const profiles = [...new Set([basename(path), listed?.name].filter((v): v is string => !!v))];
  return { browser, profiles };
}

/** `profile-use sync …` with the API key from the vault; output is returned with the key redacted. */
export async function syncWithProfileUse(input: ProfileUseSyncInput): Promise<ProfileUseSyncResult> {
  const bin = resolveProfileUse();
  if (!bin || !existsSync(bin)) throw badRequest("profile-use is not installed");
  const apiKey = process.env.BROWSER_USE_API_KEY || getAppSecret(API_KEY_SECRET);
  if (!apiKey) throw badRequest("Add your browser-use API key in Settings → Integrations first");

  let browser = input.browser;
  let profiles = input.profile ? [input.profile] : [];
  if (input.sourcePath) ({ browser, profiles } = await filtersForPath(input.sourcePath));

  const args = ["sync"];
  if (browser) args.push("--browser", browser);
  for (const p of profiles) args.push("--profile", p);
  // Without a profile filter profile-use would ask interactively which profile to sync.
  if (!profiles.length) args.push("--all");
  for (const d of input.domains ?? []) {
    if (!DOMAIN_RE.test(d.trim())) throw badRequest(`Invalid domain: ${d}`);
    args.push("--domain", d.trim());
  }
  if (input.cloudProfileId) args.push("--cloud-profile-id", input.cloudProfileId);

  const res = await runCommand([bin, ...args], {
    timeoutMs: SYNC_TIMEOUT_MS,
    env: { ...process.env, BROWSER_USE_API_KEY: apiKey, NO_COLOR: "1", TERM: "dumb" },
    maxOutput: 50_000,
  });
  let output = stripAnsi(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`).trim();
  output = output.split(apiKey).join("••••••••");
  const cloudProfileId = output.match(UUID_RE)?.[0] ?? input.cloudProfileId ?? null;
  if (res.timedOut) return { ok: false, output: `${output}\n\nprofile-use timed out after 5 minutes.`.trim(), cloudProfileId };
  const ok = res.code === 0;
  if (ok) {
    try {
      setMeta(LAST_SYNC_META, new Date().toISOString());
    } catch {
      /* database not open */
    }
    log.info(`profile-use sync finished${browser ? ` (${browser})` : ""}`);
  }
  return { ok, output: output || (ok ? "Done." : `profile-use exited with code ${res.code}`), cloudProfileId };
}

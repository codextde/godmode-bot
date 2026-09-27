/**
 * Optional browser-use Cloud sync via browser-use's `profile-use` CLI
 * (https://github.com/browser-use/profile-use-releases): uploads a local Chrome profile's cookies to a
 * browser-use Cloud profile. Needs a browser-use API key (vault app secret `browser_use_api_key`).
 *
 * The official installer (`curl -fsSL https://browser-use.com/profile.sh | sh`) runs the binary once from a
 * temp dir and deletes it, so Godmode can also download the release binary into `<dataDir>/bin`.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileUseStatus, ProfileUseSyncInput, ProfileUseSyncResult } from "@godmode/shared";
import { config } from "../config";
import { logger } from "../log";
import { HttpError, badRequest, which } from "../util";
import { getAppSecret, hasAppSecret } from "../vault/vault";
import { runCommand, stripAnsi } from "../services/doctor";

const log = logger("profile-use");

const RELEASES_REPO = "browser-use/profile-use-releases";
const SYNC_TIMEOUT_MS = 5 * 60_000;
const API_KEY_SECRET = "browser_use_api_key";

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

/** Path to a profile-use binary: Godmode's own copy, PATH, ~/.local/bin, or the official installer's work dir. */
export function resolveProfileUse(): string | null {
  const home = homedir();
  const candidates = [
    (() => {
      try {
        return managedBinaryPath();
      } catch {
        return null;
      }
    })(),
    which("profile-use"),
    join(home, ".local", "bin", binaryName()),
    join(home, ".cache", "profile-use-installer", binaryName()),
    join(process.env.TMPDIR || tmpdir(), binaryName()),
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
  return { installed: !!path, path, hasApiKey: hasApiKey() };
}

function releaseAsset(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch) throw badRequest(`profile-use has no release for ${process.platform}/${process.arch}`);
  return `profile-use-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

/** Download the latest profile-use release binary into `<dataDir>/bin`. */
export async function installProfileUse(): Promise<ProfileUseStatus> {
  const asset = releaseAsset();
  const latest = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "godmode-bot" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!latest.ok) throw new HttpError(502, `Could not look up the latest profile-use release (HTTP ${latest.status})`, "upstream_error");
  const release = (await latest.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
  const url = release.assets?.find((a) => a.name === asset)?.browser_download_url;
  if (!url) throw new HttpError(502, `The latest profile-use release has no ${asset} binary`, "upstream_error");

  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "godmode-bot" } });
  if (!res.ok) throw new HttpError(502, `Downloading profile-use failed (HTTP ${res.status})`, "upstream_error");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 100_000) throw new HttpError(502, "Downloaded profile-use binary looks truncated", "upstream_error");

  const target = managedBinaryPath();
  mkdirSync(join(config().dataDir, "bin"), { recursive: true, mode: 0o700 });
  const tmp = `${target}.download`;
  writeFileSync(tmp, bytes, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  if (process.platform === "darwin") await runCommand(["/usr/bin/xattr", "-d", "com.apple.quarantine", target], { timeoutMs: 10_000 });
  log.info(`installed profile-use ${release.tag_name ?? ""} at ${target}`);
  return profileUseStatus();
}

const DOMAIN_RE = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i;

/** `profile-use sync …` with the API key from the vault; output is returned with the key redacted. */
export async function syncWithProfileUse(input: ProfileUseSyncInput): Promise<ProfileUseSyncResult> {
  const bin = resolveProfileUse();
  if (!bin || !existsSync(bin)) throw badRequest("profile-use is not installed");
  const apiKey = process.env.BROWSER_USE_API_KEY || getAppSecret(API_KEY_SECRET);
  if (!apiKey) throw badRequest("Add your browser-use API key in Settings → Integrations first");

  const args = ["sync"];
  if (input.browser) args.push("--browser", input.browser);
  if (input.profile) args.push("--profile", input.profile);
  // Without a profile filter profile-use would ask interactively which profile to sync.
  else args.push("--all");
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
  if (res.timedOut) return { ok: false, output: `${output}\n\nprofile-use timed out after 5 minutes.`.trim() };
  return { ok: res.code === 0, output: output || (res.code === 0 ? "Done." : `profile-use exited with code ${res.code}`) };
}

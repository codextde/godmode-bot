import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { logger } from "../log";

const log = logger("hex");

export const HEX_VERSION = "3.1.1";
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

interface Download {
  file: string;
  sha256: string;
  bytes: number;
}

const DOWNLOADS: Record<string, Download> = {
  "darwin-arm64": { file: `hex-${HEX_VERSION}-macos-arm64.zip`, sha256: "f07aeaa418521ef0253641dee24b95c884180bf41899bc1c5686f530f3668496", bytes: 26502891 },
  "linux-x64": { file: `hex-${HEX_VERSION}-linux-x64`, sha256: "913fc3523c25194b24721fe1d6a59a28b9b0136ef0cdf9d55eed7f21b19201d2", bytes: 69129928 },
  "linux-arm64": { file: `hex-${HEX_VERSION}-linux-arm64`, sha256: "f5b2c2e867348c4075f787a79f4673abd1b0c31e4c54cca867e53c795135dc7c", bytes: 61295344 },
  "win32-x64": { file: `hex-${HEX_VERSION}-windows-x64.exe`, sha256: "c5c0a6d2e60bd64a3968219d313330d33d469e3751a8b68c4ac0bd524eed71b5", bytes: 67126200 },
  "win32-arm64": { file: `hex-${HEX_VERSION}-windows-arm64.exe`, sha256: "ca209c5e742a31622a6ad114f7741af25a403489efde8187b23b3b079ccfd06f", bytes: 50403768 },
};

function download(): Download | null {
  return DOWNLOADS[`${process.platform}-${process.arch}`] ?? null;
}

export function hexHome(): string {
  return join(config().dataDir, "hex");
}

function programIn(home: string): string {
  if (process.platform === "darwin") return join(home, "Hex.app", "Contents", "MacOS", "hex");
  return join(home, process.platform === "win32" ? "hex.exe" : "hex");
}

export function managedHex(): string | null {
  const path = programIn(hexHome());
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

export function canInstallHex(): boolean {
  return download() !== null;
}

export function hexDownloadBytes(): number | null {
  return download()?.bytes ?? null;
}

let installing: Promise<string> | null = null;

export function installHex(onProgress: (downloadedBytes: number, totalBytes: number) => void = () => {}): Promise<string> {
  installing ??= doInstall(onProgress).finally(() => {
    installing = null;
  });
  return installing;
}

async function doInstall(onProgress: (downloadedBytes: number, totalBytes: number) => void): Promise<string> {
  const dl = download();
  if (!dl) throw new Error(`Godmode can't install Hex on ${process.platform} ${process.arch}. Install Hex 3 from anoma.ly/hex.`);
  const home = hexHome();
  const staging = join(home, `.install-${process.pid}`);
  const url = `https://github.com/anomalyco/hex/releases/download/v${HEX_VERSION}/${dl.file}`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    log.info(`downloading Hex ${HEX_VERSION}`, { url });
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`Downloading Hex failed: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || dl.bytes;
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let received = 0;
    onProgress(0, total);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      chunks.push(chunk);
      received += chunk.byteLength;
      onProgress(received, total);
    }
    const digest = hash.digest("hex");
    if (digest !== dl.sha256) throw new Error(`The Hex download didn't match its checksum (got ${digest}); Godmode didn't install it.`);
    const file = join(staging, dl.file);
    writeFileSync(file, Buffer.concat(chunks));

    if (process.platform === "darwin") {
      const unzip = Bun.spawnSync(["/usr/bin/ditto", "-x", "-k", file, staging], { stdout: "pipe", stderr: "pipe" });
      if (unzip.exitCode !== 0) throw new Error(`Could not unpack Hex: ${unzip.stderr.toString().trim()}`);
      if (!existsSync(programIn(staging))) throw new Error("The Hex download did not contain Hex.app");
      rmSync(join(home, "Hex.app"), { recursive: true, force: true });
      renameSync(join(staging, "Hex.app"), join(home, "Hex.app"));
    } else {
      chmodSync(file, 0o755);
      const target = programIn(home);
      rmSync(target, { force: true });
      renameSync(file, target);
    }
    const path = managedHex();
    if (!path) throw new Error("Hex was installed but can't be run");
    log.info(`installed Hex ${HEX_VERSION}`, { path });
    return path;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

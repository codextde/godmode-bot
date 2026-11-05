import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { logger } from "../log";

const log = logger("hex");

export const HEX_VERSION = "3.3.0";
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

interface Download {
  file: string;
  sha256: string;
  bytes: number;
}

const DOWNLOADS: Record<string, Download> = {
  "darwin-arm64": { file: `hex-${HEX_VERSION}-macos-arm64.zip`, sha256: "1c28d6a1e790323ef199b481bc9231e6ad8e70a1785be84913e0a7bf0a6ebb39", bytes: 27081045 },
  "linux-x64": { file: `hex-${HEX_VERSION}-linux-x64`, sha256: "e8c7b3a2ebeb1d7da5d6276d5f25145891d52178e3636347cb3ac331f7662622", bytes: 72583368 },
  "linux-arm64": { file: `hex-${HEX_VERSION}-linux-arm64`, sha256: "a8a28cb8bc922f8e11fd5996e090d88aa143a2c3a65b07f1962435d0b15a24d1", bytes: 63788856 },
  "win32-x64": { file: `hex-${HEX_VERSION}-windows-x64.exe`, sha256: "8eb6dfb49d59d30d7834fdbe52e4ac598a650989c2611590585fb4210d4fd1b2", bytes: 70988216 },
  "win32-arm64": { file: `hex-${HEX_VERSION}-windows-arm64.exe`, sha256: "33bf443b322552379eee83e397a383d83ef249c8270cd21658a28ee8a2759fb8", bytes: 53326776 },
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

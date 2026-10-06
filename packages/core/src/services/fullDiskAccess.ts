/**
 * Full Disk Access can't be queried, only tried: open something macOS keeps behind it. Not every Mac has every such
 * place (a fresh account has no per-user privacy database, no Mail, no Safari data), so several are tried.
 */
import { closeSync, openSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProtectedPath {
  path: string;
  dir: boolean;
}

export function protectedPaths(home = homedir()): ProtectedPath[] {
  const lib = join(home, "Library");
  return [
    { path: join(lib, "Application Support", "com.apple.TCC", "TCC.db"), dir: false },
    { path: "/Library/Application Support/com.apple.TCC/TCC.db", dir: false },
    { path: join(lib, "Safari"), dir: true },
    { path: join(lib, "Mail"), dir: true },
    { path: join(lib, "Messages"), dir: true },
  ];
}

/** true = one of them opened; false = every one that exists was refused; null = none of them exist (or something else went wrong). */
export function probeFullDiskAccess(candidates = protectedPaths()): boolean | null {
  let denied = false;
  for (const { path, dir } of candidates) {
    try {
      if (dir) readdirSync(path);
      else closeSync(openSync(path, "r"));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") denied = true;
    }
  }
  return denied ? false : null;
}

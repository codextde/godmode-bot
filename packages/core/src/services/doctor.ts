/**
 * CONTRACT (owner: platform agent). Dependency detection + one-click install (claude CLI, uv/uvx, Chrome, git).
 */
import type { DependencyId, DoctorReport } from "@godmode/shared";

export async function runDoctor(_refresh = false): Promise<DoctorReport> {
  return { ok: false, platform: process.platform, arch: process.arch, checkedAt: new Date().toISOString(), dependencies: [] };
}
export async function installDependency(_id: DependencyId): Promise<{ ok: boolean; output: string }> {
  throw new Error("not implemented");
}
/** Absolute path to the claude CLI (settings.runner.claudePath or auto-detected), or null. */
export function resolveClaudeBinary(): string | null {
  throw new Error("not implemented");
}
/** Absolute path to uvx (for browser-use), or null. */
export function resolveUvx(): string | null {
  throw new Error("not implemented");
}
/** Absolute path to a Chromium-family browser executable, or null. */
export function resolveChrome(): string | null {
  throw new Error("not implemented");
}

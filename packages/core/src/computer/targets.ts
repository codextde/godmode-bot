/** Validation of shared computer targets coming from the API or the database. */
import type { AgentComputerConfig, ComputerTarget } from "@godmode/shared";

function str(v: unknown, max = 500): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? v : null;
}

/** A well-formed target or null (unknown kinds, missing ids and oversized strings are rejected). */
export function parseComputerTarget(v: unknown): ComputerTarget | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case "desktop":
      return { kind: "desktop" };
    case "display": {
      const displayId = str(o.displayId, 200);
      if (!displayId) return null;
      const name = str(o.name, 200);
      return { kind: "display", displayId, ...(name ? { name } : {}) };
    }
    case "window": {
      const windowId = int(o.windowId);
      const pid = int(o.pid);
      if (windowId === null || pid === null || pid === 0) return null;
      return {
        kind: "window",
        windowId,
        pid,
        app: str(o.app, 200) ?? "",
        title: str(o.title, 500) ?? "",
        bundleId: str(o.bundleId, 300),
      };
    }
    case "tab": {
      const profileId = str(o.profileId, 100);
      const targetId = str(o.targetId, 200);
      if (!profileId || !targetId) return null;
      return { kind: "tab", profileId, targetId, title: str(o.title, 500) ?? "", url: str(o.url, 4096) ?? "" };
    }
    default:
      return null;
  }
}

export const DEFAULT_AGENT_COMPUTER: AgentComputerConfig = { enabled: false, target: null };

/** Agent-level access (routines, delegated tasks) is for the whole desktop or one display — windows come and go. */
export function normalizeAgentComputer(v: unknown): AgentComputerConfig {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const target = parseComputerTarget(o.target);
  return {
    enabled: o.enabled === true,
    target: target && (target.kind === "desktop" || target.kind === "display") ? target : null,
  };
}

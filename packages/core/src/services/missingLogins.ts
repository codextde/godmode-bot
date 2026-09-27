/**
 * CONTRACT (owner: agents agent). Missing / broken login reports raised by agents.
 */
import type { MissingLogin, MissingLoginKind, MissingLoginPatch } from "@godmode/shared";

export function reportMissingLogin(_input: {
  agentId: string | null;
  runId: string | null;
  workspaceId: string | null;
  kind: MissingLoginKind;
  service: string;
  url?: string;
  reason?: string;
}): MissingLogin {
  throw new Error("not implemented");
}
export function listMissingLogins(_opts: { status?: string } = {}): MissingLogin[] {
  throw new Error("not implemented");
}
export function updateMissingLogin(_id: string, _patch: MissingLoginPatch): MissingLogin {
  throw new Error("not implemented");
}

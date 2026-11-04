/**
 * Claude accounts on the computers of a device group (owner: remote). Every computer has the accounts and their tokens,
 * but a refresh spends the refresh token: two computers refreshing with the same one sign each other out. So a secondary
 * asks its primary, and the primary first takes what the others refreshed while it was away.
 */
import { asPeer } from "./replica";
import { pullFrom } from "./replicaSync";
import { groupRole, isPrimary, primaryRunnerId } from "./group";
import { link, listRunners } from "./runners";

const ASK_TIMEOUT_MS = 40_000;
const PULL_WAIT_MS = 5_000;

function online(id: string): boolean {
  try {
    return link(id).state.state === "online";
  } catch {
    return false;
  }
}

export function primaryConnected(): boolean {
  const primary = primaryRunnerId();
  return !!primary && online(primary);
}

/** The account's tokens from the primary as JSON, null when it is signed out there, undefined when there is no answer. */
export async function tokensFromPrimary(id: string, aheadMs: number): Promise<string | null | undefined> {
  const primary = primaryRunnerId();
  if (!primary || !online(primary)) return undefined;
  try {
    const res = await link(primary).json<{ tokens?: string | null }>("POST", `/api/link/claude-accounts/${encodeURIComponent(id)}/tokens`, { aheadMs }, { timeoutMs: ASK_TIMEOUT_MS });
    return res?.tokens;
  } catch {
    return undefined;
  }
}

/** Writes what the primary answered as the primary's: it isn't sent back there. */
export function keepPrimaryTokens(write: () => void): void {
  const primary = primaryRunnerId();
  if (primary) asPeer(primary, null, write);
  else write();
}

/** On the primary, before a refresh: a secondary may hold newer tokens. False when a pull didn't finish in time. */
export async function pullFromSecondaries(): Promise<boolean> {
  if (!isPrimary()) return true;
  const peers = listRunners().filter((r) => r.kind === "device" && online(r.id));
  const pulled = Promise.all(peers.map((r) => pullFrom(r.id).then((res) => res !== null))).then((all) => all.every(Boolean));
  return Promise.race([pulled.catch(() => false), new Promise<boolean>((done) => setTimeout(() => done(false), PULL_WAIT_MS))]);
}

/** A computer of the group can't be reached right now. */
export function computerAway(): boolean {
  return !!groupRole() && listRunners().some((r) => r.kind === "device" && !online(r.id));
}

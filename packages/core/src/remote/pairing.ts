/**
 * Pairing codes: how two computers of a device group pair (remote/devices.ts).
 *
 * A computer makes a one-time pairing code (`gmr1.…`, inside a device invite `gmd1.…`): its name, where it listens,
 * its static link key and a secret. Whoever holds the code can pair once within ten minutes; the secret is the
 * handshake's pre-shared key (channel.ts), so the code itself never has to travel over the network.
 */
import { networkInterfaces, hostname as osHostname } from "node:os";
import { RUNNER_DEFAULT_PORT, encodeRunnerCode, type RunnerPairingCode, type RunnerNetwork, type TailscaleStatus } from "@godmode/shared";
import { deleteMeta, getMeta, setMeta } from "../db";
import { isTailscaleIp, tailscaleStatus } from "../mobile/tailscale";
import { computerName } from "../mobile/devices";
import { newId, randomToken } from "../util";
import { safeEqual } from "../vault/crypto";
import { loadIdentity } from "./identity";

/** How long a pairing code can be used. */
export const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_META = "link.pairing";

/* ------------------------------------------------------------------ */
/* Where a computer can be reached                                     */
/* ------------------------------------------------------------------ */

/**
 * This computer's addresses, best first: LAN (IPv4, not link-local), the Tailscale address, `<name>.local`. A runner
 * that moves between networks is still found by its other addresses.
 */
export async function localAddresses(): Promise<string[]> {
  const lan: string[] = [];
  const tailnet: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== "IPv4" || a.address.startsWith("169.254.")) continue;
      (isTailscaleIp(a.address) ? tailnet : lan).push(a.address);
    }
  }
  try {
    const ts = await tailscaleStatus();
    if (ts.running && ts.ip && !tailnet.includes(ts.ip)) tailnet.push(ts.ip);
  } catch {
    /* no Tailscale */
  }
  const host = osHostname().replace(/\.local$/i, "");
  const mdns = /^[A-Za-z0-9-]{1,63}$/.test(host) ? [`${host}.local`] : [];
  return [...new Set([...lan, ...tailnet, ...mdns])];
}

interface OfferAddress {
  network: RunnerNetwork;
  address: string;
  detail: string | null;
}

const NETWORK_ORDER: Record<RunnerNetwork, number> = { lan: 0, vm: 1, tailscale: 2 };

/** Where a runner can download this Godmode from while it is updated (runnerUpdates.ts): local network first, then VM bridges, then Tailscale. */
export function offerAddresses(ts: TailscaleStatus, interfaces = networkInterfaces()): OfferAddress[] {
  const out: OfferAddress[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== "IPv4" || a.address.startsWith("169.254.") || out.some((o) => o.address === a.address)) continue;
      if (isTailscaleIp(a.address)) out.push({ network: "tailscale", address: a.address, detail: a.address === ts.ip ? ts.dnsName : null });
      else out.push({ network: /^(bridge|vmnet|vboxnet|vnic)/.test(name) ? "vm" : "lan", address: a.address, detail: name });
    }
  }
  if (ts.running && ts.ip && !out.some((o) => o.address === ts.ip)) out.push({ network: "tailscale", address: ts.ip, detail: ts.dnsName });
  return out.sort((a, b) => NETWORK_ORDER[a.network] - NETWORK_ORDER[b.network]);
}

/* ------------------------------------------------------------------ */
/* Pairing codes                                                        */
/* ------------------------------------------------------------------ */

interface StoredPairing {
  id: string;
  secret: string;
  /** Unix ms. */
  exp: number;
}

function storedPairing(): StoredPairing | null {
  const raw = getMeta(PAIRING_META);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as StoredPairing;
    return typeof p.id === "string" && typeof p.secret === "string" && typeof p.exp === "number" ? p : null;
  } catch {
    return null;
  }
}

/** The port the runner's link listener is on (or will be): what the listener wrote back, else the default. */
export function linkPort(): number {
  const port = Number(getMeta("link.port"));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : RUNNER_DEFAULT_PORT;
}

/**
 * A new pairing code for this runner; it replaces the previous one. It is kept in the database, not in memory: the
 * CLI makes it and the serving process checks it.
 */
export async function createRunnerCode(): Promise<{ code: string; payload: RunnerPairingCode }> {
  const identity = loadIdentity();
  const pairing: StoredPairing = { id: newId("rpr"), secret: randomToken(32), exp: Date.now() + PAIRING_TTL_MS };
  setMeta(PAIRING_META, JSON.stringify(pairing));
  const payload: RunnerPairingCode = {
    v: 1,
    name: computerName(),
    hostname: osHostname(),
    addresses: await localAddresses(),
    port: linkPort(),
    key: identity.publicKey,
    id: pairing.id,
    secret: pairing.secret,
    exp: Math.floor(pairing.exp / 1000),
  };
  return { code: encodeRunnerCode(payload), payload };
}

/** The secret of the pairing with this id while it can be used (the link handshake's `lookupPairing`). */
export function lookupPairing(id: string): string | null {
  const p = storedPairing();
  if (!p || p.exp <= Date.now()) return null;
  return safeEqual(p.id, id) ? p.secret : null;
}

/** A code pairs once: the handshake that used it drops it. */
export function consumePairing(): void {
  deleteMeta(PAIRING_META);
}

export function hasPairingCode(): boolean {
  const p = storedPairing();
  return !!p && p.exp > Date.now();
}

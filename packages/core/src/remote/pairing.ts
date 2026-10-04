/**
 * Pairing a runner with a Godmode (the controller).
 *
 * The runner makes a one-time pairing code (`gmr1.…`): its name, where it listens, its static link key and a secret.
 * Whoever holds the code can pair once within ten minutes; the secret is the handshake's pre-shared key (channel.ts),
 * so the code itself never has to travel over the network.
 *
 * The code reaches the controller one of two ways:
 *  - the human pastes it (Runners → Add runner → Enter code), or
 *  - the controller made an offer (`gmo1.…`) that is part of the install command the human runs on the runner. The
 *    runner then posts its code to the controller's temporary pairing listener, sealed with a key derived from the
 *    offer's token. The token only ever exists in the command line, so a code sent to the listener by anyone who didn't
 *    see the command can't be opened, and nobody on the network can read the code on its way.
 *
 * The pairing listener also serves this program's own executable, so the install command can fetch the runner from
 * the controller instead of the website; the command pins its SHA-256.
 */
import { createHash, hkdfSync } from "node:crypto";
import { networkInterfaces, hostname as osHostname } from "node:os";
import type { Server } from "bun";
import {
  RUNNER_DEFAULT_PORT,
  encodeRunnerCode,
  encodeRunnerOffer,
  parseRunnerCode,
  type RunnerPairingCode,
  type RunnerPairingOffer,
  type RunnerPairingOfferPayload,
} from "@godmode/shared";
import { deleteMeta, getMeta, setMeta } from "../db";
import { logger } from "../log";
import { isTailscaleIp, tailscaleStatus } from "../mobile/tailscale";
import { computerName } from "../mobile/devices";
import { HttpError, newId, randomToken } from "../util";
import { decryptBytes, encryptBytes, safeEqual } from "../vault/crypto";
import { fromBase64url } from "./crypto";
import { loadIdentity } from "./identity";

const log = logger("pairing");

/** How long a pairing code and a pairing offer can be used. */
export const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_META = "link.pairing";
const DELIVER_TIMEOUT_MS = 3_000;
const MAX_PAIR_BODY = 16 * 1024;
const MAX_PAIR_ATTEMPTS = 20;
const SEAL_SALT = Buffer.from("godmode pairing offer", "utf8");
const SEAL_INFO = Buffer.from("godmode runner code", "utf8");

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

/* ------------------------------------------------------------------ */
/* Runner: pairing codes                                               */
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

/** The key a runner seals its code with for the controller that made the offer. */
function sealKey(token: string): Buffer {
  return Buffer.from(hkdfSync("sha256", fromBase64url(token), SEAL_SALT, SEAL_INFO, 32));
}

/**
 * Send the code to the controller that made the offer (the install command carried it). True once one of the
 * controller's addresses took it; false when none could be reached — then the human pastes the code instead.
 */
export async function deliverCode(offer: RunnerPairingOfferPayload, code: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  if (offer.exp * 1000 <= Date.now()) return { ok: false, error: "The pairing offer has expired. Show a new one in Godmode." };
  let sealed: string;
  try {
    sealed = encryptBytes(sealKey(offer.token), Buffer.from(code, "utf8"), offer.id);
  } catch {
    return { ok: false, error: "That pairing offer is damaged. Copy the install command again." };
  }
  const urls = offer.urls.filter((u) => /^https?:\/\/[^/]+$/i.test(u));
  // Which of the controller's addresses this computer can reach: an address of another network would otherwise hold
  // the code until the long timeout below.
  const reachable = await Promise.all(
    urls.map((url) =>
      fetch(`${url}/`, { signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS) })
        .then(() => url)
        .catch(() => null),
    ),
  );
  const targets = reachable.filter((u): u is string => !!u);
  if (!targets.length) return { ok: false, error: "Godmode can't be reached from here." };
  let lastError = "Godmode couldn't be reached.";
  for (const url of targets) {
    try {
      // Godmode connects back to this runner before it answers, so this takes as long as that handshake.
      const res = await fetch(`${url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer: offer.id, sealed }),
        signal: AbortSignal.timeout(60_000),
      });
      const answer = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string; error?: string };
      if (res.ok && answer.ok) return { ok: true, name: typeof answer.name === "string" ? answer.name : offer.name };
      lastError = typeof answer.error === "string" ? answer.error : `Godmode answered ${res.status}.`;
      // The controller got the code and said no: another address won't say otherwise.
      if (res.status !== 404) return { ok: false, error: lastError };
    } catch (err) {
      lastError = err instanceof Error && err.name === "TimeoutError" ? `${url} didn't answer.` : `${url} can't be reached.`;
    }
  }
  return { ok: false, error: lastError };
}

/* ------------------------------------------------------------------ */
/* Controller: pairing offers                                          */
/* ------------------------------------------------------------------ */

/** The program serves its own executable only when it is one compiled file (`bun build --compile`). */
export function isCompiledBinary(): boolean {
  return Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
}

let executableHash: Promise<string> | null = null;

function hashExecutable(): Promise<string> {
  executableHash ??= (async () => {
    const hash = createHash("sha256");
    const reader = Bun.file(process.execPath).stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return hash.digest("hex");
  })().catch((err) => {
    executableHash = null;
    throw err;
  });
  return executableHash;
}

interface Offer {
  id: string;
  token: string;
  expiresAt: number;
  attempts: number;
  server: Server<undefined>;
  timer: ReturnType<typeof setTimeout>;
  /** Pairs with the code; resolves with the runner's name. */
  onCode: (code: string) => Promise<{ name: string }>;
  busy: boolean;
}

let offer: Offer | null = null;

/** Stop the pairing listener and forget the offer. `graceful`: let the answer that is on its way leave first. */
export function cancelOffer(graceful = false): void {
  if (!offer) return;
  const { server, timer } = offer;
  clearTimeout(timer);
  offer = null;
  if (graceful) setTimeout(() => server.stop(true), 1_000).unref?.();
  else server.stop(true);
}

export function hasOffer(): boolean {
  return !!offer && offer.expiresAt > Date.now();
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function handlePair(current: Offer, req: Request): Promise<Response> {
  if (current.attempts >= MAX_PAIR_ATTEMPTS) return json(429, { error: "Too many attempts. Show a new install command in Godmode." });
  current.attempts++;
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_PAIR_BODY) return json(413, { error: "Too large" });
  let body: { offer?: unknown; sealed?: unknown };
  try {
    const text = await req.text();
    if (text.length > MAX_PAIR_BODY) return json(413, { error: "Too large" });
    body = JSON.parse(text) as typeof body;
  } catch {
    return json(400, { error: "Not a pairing request" });
  }
  if (typeof body.offer !== "string" || typeof body.sealed !== "string" || !safeEqual(body.offer, current.id)) {
    return json(401, { error: "This pairing offer isn't valid. Show a new install command in Godmode." });
  }
  let code: string;
  try {
    code = decryptBytes(sealKey(current.token), body.sealed, current.id).toString("utf8");
  } catch {
    return json(401, { error: "This pairing offer isn't valid. Show a new install command in Godmode." });
  }
  if (!parseRunnerCode(code)) return json(400, { error: "That isn't a runner's pairing code." });
  if (current.busy) return json(409, { error: "Already pairing." });
  current.busy = true;
  try {
    const { name } = await current.onCode(code);
    if (offer === current) cancelOffer(true);
    return json(200, { ok: true, name });
  } catch (err) {
    current.busy = false;
    const message = err instanceof Error ? err.message : String(err);
    log.warn("pairing with a delivered code failed", { error: message });
    return json(502, { error: message });
  }
}

function serveExecutable(): Response {
  if (!isCompiledBinary()) return json(404, { error: "Not available" });
  return new Response(Bun.file(process.execPath), {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "content-disposition": 'attachment; filename="godmode"' },
  });
}

/**
 * A new pairing offer (replaces the previous one) and the temporary listener the runner reaches it on. `onCode`
 * pairs with the code the runner sends.
 */
export async function createOffer(onCode: (code: string) => Promise<{ name: string }>): Promise<RunnerPairingOffer> {
  cancelOffer();
  const id = newId("rpo");
  const token = randomToken(32);
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  const state = { current: null as Offer | null };
  let server: Server<undefined>;
  try {
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      idleTimeout: 60,
      maxRequestBodySize: MAX_PAIR_BODY,
      fetch: (req) => {
        const current = state.current;
        if (!current || current !== offer || current.expiresAt <= Date.now()) return json(404, { error: "No pairing in progress" });
        const path = new URL(req.url).pathname;
        if (req.method === "POST" && path === "/pair") return handlePair(current, req);
        if (req.method === "GET" && path === "/godmode") return serveExecutable();
        return json(404, { error: "Not found" });
      },
    });
  } catch (err) {
    throw new HttpError(500, `Couldn't wait for the runner: ${err instanceof Error ? err.message : String(err)}`, "pairing_listener");
  }
  const port = server.port!;
  const timer = setTimeout(() => {
    if (offer?.id === id) cancelOffer();
  }, PAIRING_TTL_MS);
  timer.unref?.();
  offer = { id, token, expiresAt, attempts: 0, server, timer, onCode, busy: false };
  state.current = offer;

  const addresses = (await localAddresses()).filter((a) => !a.endsWith(".local"));
  const remote = addresses.map((a) => `http://${a}:${port}`);
  // Last: a runner on this same computer (trying it out) reaches the offer on loopback.
  const urls = [...remote, `http://127.0.0.1:${port}`];
  const payload: RunnerPairingOfferPayload = { v: 1, id, token, urls, name: computerName(), exp: Math.floor(expiresAt / 1000) };
  const pair = encodeRunnerOffer(payload);

  let command: string | null = null;
  if (isCompiledBinary() && remote.length) {
    try {
      const sha = await hashExecutable();
      const bin = "~/.local/bin";
      command = [
        `mkdir -p ${bin}`,
        `curl -fsS ${remote[0]}/godmode -o ${bin}/godmode.new`,
        `[ "$(shasum -a 256 ${bin}/godmode.new | cut -d' ' -f1)" = "${sha}" ]`,
        `chmod 755 ${bin}/godmode.new`,
        `mv -f ${bin}/godmode.new ${bin}/godmode`,
        `${bin}/godmode runner install --pair ${pair}`,
      ].join(" && ");
    } catch (err) {
      log.warn("couldn't hash this program for the install command", err);
    }
  }
  const websiteCommand = `curl -fsSL https://godmode.codext.de/runner.sh | GODMODE_LICENSE=GM-XXXXX-XXXXX-XXXXX-XXXXX GODMODE_PAIR=${pair} sh`;
  return { offerId: id, command, websiteCommand, urls, expiresAt: new Date(expiresAt).toISOString() };
}

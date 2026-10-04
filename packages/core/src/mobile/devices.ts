import { hostname } from "node:os";
import {
  MOBILE_TOKEN_PREFIX,
  encodePairingLink,
  type MobileDevice,
  type MobileInstance,
  type MobilePairInput,
  type MobilePairingOffer,
  type MobilePairResult,
  type MobilePlatform,
} from "@godmode/shared";
import { config } from "../config";
import { all, get, getMeta, insert, run, setMeta } from "../db";
import { bus } from "../events/bus";
import { audit } from "../services/audit";
import { notify } from "../services/notifications";
import { getSettings } from "../services/settings";
import { sha256 } from "../vault/crypto";
import { HttpError, newId, notFound, now, randomToken } from "../util";

export const PAIRING_TTL_MS = 5 * 60_000;
const SEEN_WRITE_MS = 60_000;

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  model: string | null;
  app_version: string | null;
  last_seen_at: string | null;
  last_address: string | null;
  created_at: string;
}

let offer: { hash: string; expiresAt: number } | null = null;
const lastSeenWrites = new Map<string, number>();
let onlineCheck: (deviceId: string) => boolean = () => false;
let onRevoked: (deviceId: string) => void = () => {};

/** The WebSocket hub reports which phones are connected and closes a removed phone's sockets. */
export function setDeviceSocketHooks(hooks: { online: (deviceId: string) => boolean; revoked: (deviceId: string) => void }) {
  onlineCheck = hooks.online;
  onRevoked = hooks.revoked;
}

function toDevice(row: DeviceRow): MobileDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform === "android" ? "android" : "ios",
    model: row.model,
    appVersion: row.app_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastAddress: row.last_address,
    online: onlineCheck(row.id),
  };
}

export function instanceInfo(): MobileInstance {
  let id = getMeta("mobile.instance_id");
  if (!id) {
    id = newId("gm");
    setMeta("mobile.instance_id", id);
  }
  const cfg = config();
  return { id, name: computerName(), version: cfg.version, platform: cfg.platform };
}

let name: string | null = null;

/** "Daniel's MacBook Pro" rather than the host name "Daniels-MacBook-Pro.local" where the system knows it. */
export function computerName(): string {
  if (name) return name;
  if (process.platform === "darwin") {
    const proc = Bun.spawnSync(["/usr/sbin/scutil", "--get", "ComputerName"], { stdout: "pipe", stderr: "ignore" });
    name = proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
  }
  name ||= hostname().replace(/\.local$/i, "") || "Godmode";
  return name;
}

export function listDevices(): MobileDevice[] {
  return all<DeviceRow>("SELECT * FROM mobile_devices ORDER BY created_at DESC").map(toDevice);
}

export function getDevice(id: string): MobileDevice {
  const row = get<DeviceRow>("SELECT * FROM mobile_devices WHERE id = ?", id);
  if (!row) throw notFound("Phone");
  return toDevice(row);
}

/** A new one-time pairing code (replaces the previous one). */
export function createPairingOffer(urls: string[]): MobilePairingOffer {
  const code = randomToken(32);
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  offer = { hash: sha256(code), expiresAt };
  const instance = instanceInfo();
  const link = encodePairingLink({ v: 1, id: instance.id, name: instance.name, urls, code, exp: Math.floor(expiresAt / 1000) });
  return { link, expiresAt: new Date(expiresAt).toISOString(), urls };
}

export function cancelPairingOffer() {
  offer = null;
}

export function hasPairingOffer(): boolean {
  return !!offer && offer.expiresAt > Date.now();
}

/** The phone presents the scanned code; a valid one is used up and the phone gets its device token. */
export function claimPairing(input: MobilePairInput, address: string): MobilePairResult {
  const current = getSettings().mobile.enabled ? offer : null;
  if (!current || current.expiresAt <= Date.now() || current.hash !== sha256(input.code)) {
    throw new HttpError(401, "This pairing code is invalid or has expired. Show a new QR code on your computer.", "pairing_invalid");
  }
  offer = null;
  const token = MOBILE_TOKEN_PREFIX + randomToken(32);
  const id = newId("dev");
  const ts = now();
  insert("mobile_devices", {
    id,
    name: input.name.trim().slice(0, 80) || "Phone",
    platform: input.platform satisfies MobilePlatform,
    model: input.model?.trim().slice(0, 80) || null,
    app_version: input.appVersion?.trim().slice(0, 40) || null,
    token_hash: sha256(token),
    last_seen_at: ts,
    last_address: address,
    created_at: ts,
  });
  const device = getDevice(id);
  audit("user", "mobile.pair", id, { name: device.name, platform: device.platform, model: device.model, ip: address });
  notify("success", `${device.name} is connected`, "It can now control Godmode. Remove it anytime in Settings → Phone.", "/settings/phone");
  bus.emit({ type: "mobile.paired", device });
  bus.changed("mobile");
  return { token, device, instance: instanceInfo() };
}

/** The phone behind a device token, or null. Remembers when (and from where) it was last seen. */
export function authenticateDevice(token: string, address?: string): MobileDevice | null {
  if (!token.startsWith(MOBILE_TOKEN_PREFIX)) return null;
  const row = get<DeviceRow>("SELECT * FROM mobile_devices WHERE token_hash = ?", sha256(token));
  if (!row) return null;
  const t = Date.now();
  if (t - (lastSeenWrites.get(row.id) ?? 0) >= SEEN_WRITE_MS) {
    lastSeenWrites.set(row.id, t);
    const ts = now();
    run("UPDATE mobile_devices SET last_seen_at = ?, last_address = COALESCE(?, last_address) WHERE id = ?", ts, address ?? null, row.id);
    row.last_seen_at = ts;
    if (address) row.last_address = address;
  }
  return toDevice(row);
}

export function renameDevice(id: string, name: string): MobileDevice {
  getDevice(id);
  run("UPDATE mobile_devices SET name = ? WHERE id = ?", name.trim().slice(0, 80), id);
  bus.changed("mobile");
  return getDevice(id);
}

export function revokeDevice(id: string, actor = "user") {
  const device = getDevice(id);
  run("DELETE FROM mobile_devices WHERE id = ?", id);
  lastSeenWrites.delete(id);
  onRevoked(id);
  audit(actor, "mobile.revoke", id, { name: device.name });
  bus.changed("mobile");
}

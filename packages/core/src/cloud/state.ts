/**
 * What this computer remembers about its Godmode Cloud link. The non-secret part lives in meta keys `cloud.*` (readable
 * while the vault is locked, kept out of backups). The link secret lives in `<dataDir>/cloud-link` (mode 0600): never in
 * Settings, which paired phones can read, and not in the vault, because the link must come up while the vault is locked.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD_SECRET_PREFIX, cloudGatewayUrl, type CloudAccount, type CloudPlanSummary } from "@godmode/shared";
import { config } from "../config";
import { deleteMeta, getMeta, setMeta } from "../db";
import { getSettings } from "../services/settings";
import { parseJson } from "../util";

export interface CloudLinkRecord {
  /** The cloud's origin, e.g. "https://cloud.example.com". */
  url: string;
  deviceId: string;
  account: CloudAccount;
  linkedAt: string;
  /** The cloud no longer knows this computer (it closed the link with BadCredential). */
  revoked: boolean;
  /** The plan the cloud reported last. */
  plan: CloudPlanSummary | null;
}

const KEY = {
  url: "cloud.url",
  deviceId: "cloud.device_id",
  account: "cloud.account",
  linkedAt: "cloud.linked_at",
  revoked: "cloud.revoked",
  plan: "cloud.plan",
};

export function loadLink(): CloudLinkRecord | null {
  const url = getMeta(KEY.url);
  const deviceId = getMeta(KEY.deviceId);
  if (!url || !deviceId) return null;
  return {
    url,
    deviceId,
    account: parseJson<CloudAccount>(getMeta(KEY.account), { email: "", name: null }),
    linkedAt: getMeta(KEY.linkedAt) ?? "",
    revoked: getMeta(KEY.revoked) === "1",
    plan: parseJson<CloudPlanSummary | null>(getMeta(KEY.plan), null),
  };
}

export function saveLink(link: { url: string; deviceId: string; account: CloudAccount; linkedAt: string }) {
  setMeta(KEY.url, link.url);
  setMeta(KEY.deviceId, link.deviceId);
  setMeta(KEY.account, JSON.stringify(link.account));
  setMeta(KEY.linkedAt, link.linkedAt);
  deleteMeta(KEY.revoked);
  deleteMeta(KEY.plan);
}

export function setLinkAccount(account: CloudAccount) {
  setMeta(KEY.account, JSON.stringify(account));
}

export function setLinkPlan(plan: CloudPlanSummary) {
  setMeta(KEY.plan, JSON.stringify(plan));
}

export function setLinkRevoked() {
  setMeta(KEY.revoked, "1");
}

export function clearLink() {
  for (const key of Object.values(KEY)) deleteMeta(key);
}

function secretFile(): string {
  return join(config().dataDir, "cloud-link");
}

export function readLinkSecret(): string | null {
  const file = secretFile();
  if (!existsSync(file)) return null;
  const secret = readFileSync(file, "utf8").trim();
  return secret.startsWith(CLOUD_SECRET_PREFIX) ? secret : null;
}

export function writeLinkSecret(secret: string) {
  const file = secretFile();
  writeFileSync(file, secret, { mode: 0o600 });
  try {
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

export function deleteLinkSecret() {
  rmSync(secretFile(), { force: true });
}

let online = false;

/** The link client reports whether the cloud link is up (after Welcome) or down. */
export function setCloudOnline(value: boolean) {
  online = value;
}

export function isCloudOnline(): boolean {
  return online;
}

/**
 * This computer's phone gateway address while it is linked, the link is on, phone access is allowed and the cloud
 * speaks https (phones only send their key over https or to Tailscale addresses).
 */
export function phoneGatewayUrl(): string | null {
  const link = loadLink();
  if (!link || link.revoked) return null;
  const { enabled, phoneAccess } = getSettings().cloud;
  if (!enabled || !phoneAccess || !link.url.startsWith("https://")) return null;
  return cloudGatewayUrl(link.url, link.deviceId);
}

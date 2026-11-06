import type {
  CloudBilling,
  CloudSettings,
  CloudStatus,
  ConnectorCreated,
  ConnectorInput,
  DeviceGroup,
  DeviceGroupPatch,
  DeviceInvite,
  HandoffInput,
  HandoffResult,
  RemoteRunner,
  RetireRunnerResult,
} from "@godmode/shared";
import { request } from "./api";

/**
 * Device groups, the cloud link and connected apps, changed from a full-access phone the way the desktop app changes
 * them. A limited phone gets 403 `device_forbidden` for all of these.
 */
export const linkingApi = {
  devices: {
    update: (input: DeviceGroupPatch) => request<DeviceGroup>("PATCH", "/api/devices", input),
    invite: () => request<DeviceInvite>("POST", "/api/devices/invite", {}),
    /** Pairing with the primary and copying its setup takes a while. */
    join: (code: string) => request<DeviceGroup>("POST", "/api/devices/join", { code }, 150_000),
    leave: () => request<DeviceGroup>("POST", "/api/devices/leave", {}, 60_000),
    remove: (id: string) => request<DeviceGroup>("DELETE", `/api/devices/${encodeURIComponent(id)}`, undefined, 60_000),
    handoff: (input: HandoffInput) => request<HandoffResult>("POST", "/api/devices/handoff", input, 120_000),
    retireRunner: (runnerId: string) => request<RetireRunnerResult>("POST", "/api/devices/retire-runner", { runnerId }, 60_000),
  },

  runners: {
    list: () => request<RemoteRunner[]>("GET", "/api/runners"),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/api/runners/${encodeURIComponent(id)}`, undefined, 30_000),
  },

  cloud: {
    update: (input: Partial<CloudSettings>) => request<CloudStatus>("PUT", "/api/cloud", input),
    /** Starts linking: the answer carries the code and the page to approve it on. */
    link: (url: string) => request<CloudStatus>("POST", "/api/cloud/link", { url }, 30_000),
    /** Cancels a pending link, or unlinks. */
    unlink: () => request<CloudStatus>("DELETE", "/api/cloud/link", undefined, 30_000),
    cancel: () => request<CloudBilling>("POST", "/api/cloud/billing/cancel", {}, 30_000),
    resume: () => request<CloudBilling>("POST", "/api/cloud/billing/resume", {}, 30_000),
  },

  connectors: {
    /** The key is in this answer and nowhere else. */
    create: (input: ConnectorInput) => request<ConnectorCreated>("POST", "/api/connectors", input, 60_000),
  },
};

export const lk = {
  runners: ["runners"],
} as const;

/** "cloud.example.com/devices" → "https://cloud.example.com": a missing scheme becomes https, any path is dropped. */
export function normalizeCloudUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The approval page opens only on the cloud this computer is linking to, never wherever an answer points. */
export function approvalUrl(status: CloudStatus): string | null {
  if (!status.pending || !status.url) return null;
  try {
    return new URL(status.pending.verifyUrl).origin === new URL(status.url).origin ? status.pending.verifyUrl : null;
  } catch {
    return null;
  }
}

/** Linked to an account, whether the link is up right now or not. */
export function isLinked(status: CloudStatus): boolean {
  return status.state !== "unlinked" && status.state !== "linking" && status.state !== "revoked";
}

/** "4:59" */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

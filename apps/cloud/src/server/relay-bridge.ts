/**
 * The relay hub as Next code sees it. The hub itself lives in the custom server (server/relay/hub.ts), which is a
 * separate bundle in the same process; it registers itself here through `shared()`, so pages, actions and services
 * can ask who is online or end a computer's link without importing the server.
 */
import type { CloudNotice } from "@godmode/shared";
import { shared } from "./shared";

export interface RelayLinkInfo {
  deviceId: string;
  userId: string;
  connectedAt: string;
  ip: string | null;
  version: string;
  streams: number;
  sockets: number;
  bytesIn: number;
  bytesOut: number;
}

export interface RelayHubApi {
  isOnline(deviceId: string): boolean;
  info(deviceId: string): RelayLinkInfo | null;
  online(): RelayLinkInfo[];
  disconnect(deviceId: string, code: number, reason: string): void;
  notify(deviceId: string, notice: CloudNotice): void;
  notifyUser(userId: string, notice: CloudNotice): void;
  stats(): { links: number; streams: number; sockets: number; bytesIn: number; bytesOut: number; startedAt: string };
}

const startedAt = new Date().toISOString();

// Used when the custom server is not running (next dev without server/main.ts, tests, builds): nothing is online.
const offlineHub: RelayHubApi = {
  isOnline: () => false,
  info: () => null,
  online: () => [],
  disconnect: () => {},
  notify: () => {},
  notifyUser: () => {},
  stats: () => ({ links: 0, streams: 0, sockets: 0, bytesIn: 0, bytesOut: 0, startedAt }),
};

const slot = () => shared<{ hub: RelayHubApi | null }>("relayHub", () => ({ hub: null }));

export function relayHub(): RelayHubApi {
  return slot().hub ?? offlineHub;
}

/** Called by the custom server once its hub exists; `null` unregisters it (shutdown, tests). */
export function registerRelayHub(hub: RelayHubApi | null): void {
  slot().hub = hub;
}

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { CLOUD_GATEWAY_PREFIX, isPhoneUrlAllowed, type MobileInstance } from "@godmode/shared";
import { baseUrl, withDefaults, withGroup, type Computers } from "./peers";

/**
 * A pairing with a Godmode computer, which the other computers of its device group take too. Kept in the Keychain /
 * Android Keystore, never backed up to other devices.
 */
export interface Connection extends Computers {
  token: string;
  deviceId: string;
  deviceName: string;
  pairedAt: string;
}

const CONNECTION_KEY = "godmode.connection";
const APP_LOCK_KEY = "godmode.appLock";
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

interface SessionState {
  ready: boolean;
  connection: Connection | null;
  appLock: boolean;
  /** Why the last connection ended, shown on the welcome screen. */
  endedBecause: "removed" | null;
  load: () => Promise<void>;
  connect: (connection: Connection) => Promise<void>;
  /** The address and computer that answered. */
  setActive: (url: string, instanceId: string) => void;
  /** Keep the addresses current: the computer lists them again, e.g. with its Godmode Cloud gateway once linked. */
  setUrls: (urls: string[]) => void;
  /** Keep the computer's name and version current (they can change after pairing). */
  setInstance: (instance: MobileInstance) => void;
  /** Keep the device group current, as a computer of it lists it (`GET /api/mobile/me`). */
  setGroup: (group: unknown) => void;
  disconnect: (reason?: "removed") => Promise<void>;
  setAppLock: (on: boolean) => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  ready: false,
  connection: null,
  appLock: false,
  endedBecause: null,

  load: async () => {
    const [raw, lock] = await Promise.all([
      SecureStore.getItemAsync(CONNECTION_KEY, STORE_OPTIONS).catch(() => null),
      SecureStore.getItemAsync(APP_LOCK_KEY, STORE_OPTIONS).catch(() => null),
    ]);
    let connection: Connection | null = null;
    try {
      connection = raw ? withDefaults(JSON.parse(raw) as Connection) : null;
    } catch {
      connection = null;
    }
    set({ ready: true, connection, appLock: lock === "1" });
  },

  connect: async (connection) => {
    await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection), STORE_OPTIONS);
    set({ connection, endedBecause: null });
  },

  setActive: (url, instanceId) => {
    const current = get().connection;
    if (!current || (current.activeUrl === url && current.activeInstanceId === instanceId)) return;
    const connection = { ...current, activeUrl: url, activeInstanceId: instanceId };
    set({ connection });
    void SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection), STORE_OPTIONS);
  },

  setUrls: (urls) => {
    const current = get().connection;
    const next = [...new Set(urls.filter((u) => typeof u === "string" && isPhoneUrlAllowed(u)).map(baseUrl))];
    // An empty list never strands the phone; the address that worked last stays first either way.
    if (!current || !next.length || JSON.stringify(current.urls) === JSON.stringify(next)) return;
    const connection = { ...current, urls: next };
    set({ connection });
    void SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection), STORE_OPTIONS);
  },

  setInstance: (instance) => {
    const current = get().connection;
    if (!current || JSON.stringify(current.instance) === JSON.stringify(instance)) return;
    const connection = { ...current, instance };
    set({ connection });
    void SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection), STORE_OPTIONS);
  },

  setGroup: (group) => {
    const current = get().connection;
    if (!current) return;
    const connection = withGroup(current, group, isPhoneUrlAllowed);
    if (JSON.stringify(connection) === JSON.stringify(current)) return;
    set({ connection });
    void SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection), STORE_OPTIONS);
  },

  disconnect: async (reason) => {
    await SecureStore.deleteItemAsync(CONNECTION_KEY, STORE_OPTIONS).catch(() => undefined);
    set({ connection: null, endedBecause: reason ?? null });
  },

  setAppLock: async (on) => {
    await SecureStore.setItemAsync(APP_LOCK_KEY, on ? "1" : "0", STORE_OPTIONS);
    set({ appLock: on });
  },
}));

const GATEWAY_PATH = new RegExp(`^https://[^?#]+${CLOUD_GATEWAY_PREFIX}/[^/?#]+$`, "i");

/** A Godmode Cloud gateway address (`https://<cloud>/gw/<id>`) rather than a Tailscale one. */
export function isGatewayUrl(url: string | undefined): boolean {
  return !!url && GATEWAY_PATH.test(baseUrl(url));
}

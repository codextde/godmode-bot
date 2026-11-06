import { File, Paths } from "expo-file-system";
import { Alert } from "react-native";
import type { AuditEntry, BackupImportResult, LicenseState, MobileDevice, MobilePairingOffer, MobileStatus, Settings, VaultStatus } from "@godmode/shared";
import { ApiError, errorText, reachableBase, request, type SettingsPatch } from "./api";
import { t } from "./i18n";
import { isCancelled, withGrant } from "./secrets";
import { useSession } from "./session";
import { patchSettings } from "./setup";

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/**
 * Any setting, the way the desktop app changes it: full-access phones only (the computer refuses the rest for a limited
 * phone). Shows at once and goes back when the computer refuses it.
 */
export function patchAnySettings(patch: DeepPartial<Settings>, opts?: { quiet?: boolean }): Promise<boolean> {
  return patchSettings(patch as SettingsPatch, opts);
}

/** A change only the vault password allows: asks for it when the computer wants it; quiet when the human closes that. */
export async function withVaultGrant(title: string, call: (grant: string | undefined) => Promise<unknown>): Promise<boolean> {
  try {
    await withGrant(call);
    return true;
  } catch (err) {
    if (isCancelled(err)) return false;
    const refused = err instanceof ApiError && err.code === "device_forbidden";
    Alert.alert(refused ? t("components:fullAccess.title") : title, refused ? undefined : errorText(err));
    return false;
  }
}

const LONG_MS = 30 * 60_000;
const grantHeader = (grant?: string) => (grant ? { "x-godmode-grant": grant } : undefined);

/** What a full-access phone manages like the desktop app: paired phones, backups, security. */
export const adminApi = {
  phones: {
    status: (refresh = false) => request<MobileStatus>("GET", `/api/mobile${refresh ? "?refresh=1" : ""}`),
    update: (input: { enabled?: boolean; port?: number }) => request<MobileStatus>("PUT", "/api/mobile", input),
    pairing: () => request<MobilePairingOffer>("POST", "/api/mobile/pairing", {}),
    cancelPairing: () => request<{ ok: true }>("DELETE", "/api/mobile/pairing"),
    rename: (id: string, name: string) => request<MobileDevice>("PATCH", `/api/mobile/devices/${encodeURIComponent(id)}`, { name }),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/api/mobile/devices/${encodeURIComponent(id)}`),
  },

  backup: {
    /** Restores a backup file from the phone (multipart, like the desktop). Replaces everything on the computer. */
    restore: (file: { uri: string; name: string; mime: string }, passphrase: string) => {
      const form = new FormData();
      // expo/fetch (the global fetch) takes parts that read their own bytes.
      form.append("file", { name: file.name, type: file.mime, bytes: () => new File(file.uri).bytes() } as unknown as Blob);
      form.append("passphrase", passphrase);
      return request<BackupImportResult>("POST", "/api/backup/import", form, LONG_MS);
    },
  },

  license: {
    set: (key: string) => request<LicenseState>("PUT", "/api/license", { key }, 30_000),
    remove: () => request<LicenseState>("DELETE", "/api/license"),
    refresh: () => request<LicenseState>("POST", "/api/license/refresh", {}, 30_000),
  },

  security: {
    audit: (action?: string) => request<AuditEntry[]>("GET", `/api/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ""}`),
    changePassphrase: (current: string, next: string) => request<{ ok: true }>("POST", "/api/vault/passphrase", { current, next }, 60_000),
    setDashboardPassword: (password: string) => request<{ ok: true }>("POST", "/api/auth/password", { password }),
    remember: (remember: boolean, grant?: string) => request<VaultStatus>("POST", "/api/vault/remember", { remember }, 0, grantHeader(grant)),
    settings: (patch: DeepPartial<Settings>, grant?: string) => request<Settings>("PUT", "/api/settings", patch, 0, grantHeader(grant)),
    agentAccess: (id: string, secretAccess: "fill" | "reveal", grant?: string) =>
      request<unknown>("PATCH", `/api/agents/${encodeURIComponent(id)}`, { permissions: { secretAccess } }, 0, grantHeader(grant)),
  },
};

export const ak = {
  phones: ["mobile-status"],
  audit: (action: string) => ["audit", action],
} as const;

/**
 * An encrypted backup of the computer, saved in the phone's cache under the name the computer gives it. The download
 * goes to whichever of the computer's addresses answers, with this phone's key.
 */
export async function exportBackup(input: { passphrase: string; includeAgentRepos: boolean; includeBrowserProfiles: boolean }): Promise<File> {
  const connection = useSession.getState().connection;
  if (!connection) throw new ApiError(401, t("system:api.notPaired"), "not_paired");
  const found = await reachableBase(connection);
  if (!found || found instanceof ApiError) throw found ?? new ApiError(0, t("system:api.offline"), "offline");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LONG_MS);
  try {
    const res = await fetch(`${found.base}/api/backup/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", accept: "application/octet-stream" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      throw new ApiError(res.status, body?.error ?? t("system:api.requestFailed", { status: res.status }), body?.code);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `godmode-backup-${new Date().toISOString().slice(0, 10)}.godmode-backup`;
    const file = new File(Paths.cache, name.replace(/[^\w.-]/g, "_"));
    if (file.exists) file.delete();
    file.create();
    await file.write(new Uint8Array(await res.arrayBuffer()));
    return file;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, t("system:api.noAnswer"), "timeout");
  } finally {
    clearTimeout(timer);
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

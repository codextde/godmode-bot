import { useQuery } from "@tanstack/react-query";
import type { Mod, ModCatalogEntry, ModCheck, ModInput, ModInstallInput, ModPatch, ModTemplate } from "@godmode/shared";
import { MAX_MOD_BYTES, MAX_MOD_FILE_BYTES } from "@godmode/shared";
import { ApiError, reachableBase, request } from "./api";
import { t } from "./i18n";
import { ik } from "./integrations";
import { queryClient } from "./query";
import { useSession } from "./session";

/**
 * Plugins as the desktop's Settings → Plugins manages them (full-access phones): install from GitHub or the featured
 * list, add from Godmode's gallery, who runs them, their options, a fresh check, and the code of the small ones.
 */
export const pluginsAdmin = {
  get: (id: string) => request<Mod>("GET", `/api/mods/${encodeURIComponent(id)}`),
  catalog: () => request<ModCatalogEntry[]>("GET", "/api/mods/catalog"),
  templates: () => request<ModTemplate[]>("GET", "/api/mods/templates"),
  create: (input: ModInput) => request<Mod>("POST", "/api/mods", input, 60_000),
  update: (id: string, patch: ModPatch) => request<Mod>("PATCH", `/api/mods/${encodeURIComponent(id)}`, patch, 60_000),
  /** A plugin folder on the computer, stays off until switched on. */
  importFolder: (path: string) => request<Mod>("POST", "/api/mods/import", { path }, 120_000),
  /** Claude Code's validator over the saved files again. */
  check: (id: string) => request<Mod>("POST", `/api/mods/${encodeURIComponent(id)}/check`, {}, 90_000),
  /** Checks files that aren't saved; `check` is null when Claude Code isn't installed. */
  checkFiles: (files: Record<string, string>) => request<{ check: ModCheck | null }>("POST", "/api/mods/check", { files }, 90_000),
  install,
};

export const pk = {
  catalog: ["plugins", "catalog"],
  templates: ["plugins", "templates"],
};

export const usePluginCatalog = () => useQuery({ queryKey: pk.catalog, queryFn: pluginsAdmin.catalog, staleTime: 10 * 60_000 });
export const usePluginTemplates = () => useQuery({ queryKey: pk.templates, queryFn: pluginsAdmin.templates, staleTime: 10 * 60_000 });

/** The answer put into the cached list right away; the list is asked again after. */
export function putPlugin(mod: Mod) {
  queryClient.setQueryData<Mod[]>(ik.plugins, (old) => (old ? (old.some((m) => m.id === mod.id) ? old.map((m) => (m.id === mod.id ? mod : m)) : [...old, mod]) : old));
  void queryClient.invalidateQueries({ queryKey: ik.plugins });
}

/** A repository with several plugins: the ones to pick from. */
export class PickPlugin extends Error {
  constructor(public plugins: { name: string; description: string }[]) {
    super("pick_plugin");
  }
}

const INSTALL_MS = 5 * 60_000;

/**
 * Downloads, checks and adds a plugin from a git repository. Called directly (not through `request`) so a 409 that
 * lists the repository's plugins arrives with them (`PickPlugin`).
 */
async function install(input: ModInstallInput): Promise<Mod> {
  const connection = useSession.getState().connection;
  if (!connection) throw new ApiError(401, t("system:api.notPaired"), "not_paired");
  const found = await reachableBase(connection);
  if (!found || found instanceof ApiError) throw found ?? new ApiError(0, t("system:api.offline"), "offline");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSTALL_MS);
  try {
    const res = await fetch(`${found.base}/api/mods/install`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as (Mod & { error?: string; code?: string; details?: { plugins?: unknown } }) | null;
    if (res.ok && body) return body;
    if (res.status === 409 && body?.code === "pick_plugin" && Array.isArray(body.details?.plugins)) throw new PickPlugin(body.details.plugins as PickPlugin["plugins"]);
    throw new ApiError(res.status, body?.error ?? t("system:api.requestFailed", { status: res.status }), body?.code);
  } catch (err) {
    if (err instanceof ApiError || err instanceof PickPlugin) throw err;
    throw new ApiError(0, t("system:api.noAnswer"), "timeout");
  } finally {
    clearTimeout(timer);
  }
}

/** Why the files can't be saved as a plugin (too large), or null. */
export function tooLarge(files: Record<string, string>): string | null {
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    const bytes = utf8Length(content);
    if (bytes > MAX_MOD_FILE_BYTES) return t("tools:pluginAdmin.code.fileTooLarge", { path, kb: MAX_MOD_FILE_BYTES / 1000 });
    total += bytes;
  }
  return total > MAX_MOD_BYTES ? t("tools:pluginAdmin.code.filesTooLarge", { kb: MAX_MOD_BYTES / 1000 }) : null;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

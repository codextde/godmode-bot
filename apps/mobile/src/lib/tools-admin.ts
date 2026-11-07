import type { ApiTool, ApiToolAuth, ApiToolInput, ApiToolTestResult, McpServer, McpServerInput, McpTransport, Mod } from "@godmode/shared";
import { SECRET_MASK } from "@godmode/shared";
import { ApiError, errorText, request } from "./api";
import { ik } from "./integrations";
import { queryClient } from "./query";

/**
 * MCP servers and API tools as the desktop app edits them (full-access phones only). Secret values (env, headers, the
 * API key) are write-only: the computer never sends them back, and an untouched stored one is kept.
 */
export interface McpTestResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}

export const toolsAdmin = {
  mcp: {
    create: (input: McpServerInput) => request<McpServer>("POST", "/api/mcp-servers", input),
    update: (id: string, input: Partial<McpServerInput>) => request<McpServer>("PATCH", `/api/mcp-servers/${id}`, input),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/api/mcp-servers/${id}`),
    /** Starts the server once and lists its tools; a slow `npx` download takes a while. */
    test: (id: string) => request<McpTestResult>("POST", `/api/mcp-servers/${id}/test`, {}, 60_000),
  },
  apiTools: {
    create: (input: ApiToolInput) => request<ApiTool>("POST", "/api/api-tools", input),
    /** Sending the saved key somewhere new needs a grant. */
    update: (id: string, input: Partial<ApiToolInput>, grant?: string) => request<ApiTool>("PATCH", `/api/api-tools/${id}`, input, 0, grant ? { "x-godmode-grant": grant } : undefined),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/api/api-tools/${id}`),
    test: (id: string) => request<ApiToolTestResult>("POST", `/api/api-tools/${id}/test`, {}, 45_000),
  },
  plugins: {
    /** Switching on sends the digest of the code that was listed, so the OK is for that code. */
    setEnabled: (mod: Mod, enabled: boolean) => request<Mod>("PATCH", `/api/mods/${mod.id}`, enabled ? { enabled, digest: mod.digest } : { enabled }, 60_000),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/api/mods/${id}`),
    checkUpdates: () => request<Mod[]>("POST", "/api/mods/updates", {}, 120_000),
    update: (id: string) => request<Mod>("POST", `/api/mods/${id}/update`, {}, 180_000),
  },
};

export function refreshTools() {
  void queryClient.invalidateQueries({ queryKey: ik.mcpServers });
  void queryClient.invalidateQueries({ queryKey: ik.apiTools });
}

/** The saved key would reach a new address or the runs' environment: the computer wants the vault passphrase. */
export const needsGrant = (err: unknown) => err instanceof ApiError && err.code === "grant_required";

export const TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"];
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_KEY_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
export const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD)$/i;

/** Shell-like split: whitespace and new lines separate arguments, quotes group, a backslash escapes. */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function formatArgs(args: string[]): string {
  return args.map((a) => (a === "" || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)).join(" ");
}

export interface SecretRow {
  uid: string;
  key: string;
  value: string;
  /** Saved on the computer; its value is unknown here. */
  stored: boolean;
  /** A stored value being replaced by `value`. */
  replacing?: boolean;
}

let seq = 0;
const uid = () => `row-${++seq}`;

export const rowsFromKeys = (keys: string[]): SecretRow[] => keys.map((key) => ({ uid: uid(), key, value: "", stored: true }));
export const newRow = (key = ""): SecretRow => ({ uid: uid(), key, value: "", stored: false });

/** What the computer gets: a stored value nobody replaced goes back as the mask, so it is kept. */
export function rowsToRecord(rows: SecretRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.stored && !r.replacing ? SECRET_MASK : r.value;
  }
  return out;
}

export type RowsProblem = { kind: "needsName" } | { kind: "invalid"; key: string } | { kind: "duplicate"; key: string };

export function rowsProblem(rows: SecretRow[], pattern: RegExp): RowsProblem | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) {
      if (r.value) return { kind: "needsName" };
      continue;
    }
    if (!pattern.test(k)) return { kind: "invalid", key: k };
    if (seen.has(k.toLowerCase())) return { kind: "duplicate", key: k };
    seen.add(k.toLowerCase());
  }
  return null;
}

export const BEARER: ApiToolAuth = { in: "header", name: "Authorization", prefix: "Bearer " };

export type KeyMode = "bearer" | "header" | "query";

export function keyModeOf(auth: ApiToolAuth): KeyMode {
  if (auth.in === "query") return "query";
  return auth.name.toLowerCase() === "authorization" && auth.prefix === BEARER.prefix ? "bearer" : "header";
}

/** GEMINI_API_KEY for "Gemini". */
export function suggestEnvVar(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!base) return "API_KEY";
  const safe = /^[0-9]/.test(base) ? `_${base}` : base;
  return /(_KEY|_TOKEN)$/.test(safe) ? safe : `${safe}_API_KEY`;
}

export function hostOf(url: string): string {
  try {
    return url.trim() ? new URL(url.trim()).host : "";
  } catch {
    return "";
  }
}

/** The list's switch: shows at once, goes back when the computer refuses it. */
export async function setEnabled(kind: "mcp" | "api", id: string, enabled: boolean): Promise<string | null> {
  const key = kind === "mcp" ? ik.mcpServers : ik.apiTools;
  queryClient.setQueryData<{ id: string; enabled: boolean }[]>(key, (list) => list?.map((x) => (x.id === id ? { ...x, enabled } : x)));
  try {
    if (kind === "mcp") await toolsAdmin.mcp.update(id, { enabled });
    else await toolsAdmin.apiTools.update(id, { enabled });
    return null;
  } catch (err) {
    return errorText(err);
  } finally {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

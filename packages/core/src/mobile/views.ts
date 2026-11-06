/**
 * What a paired phone sees of answers that carry more than it shows: no commands, arguments, URLs with keys, plugin code,
 * webhook paths, admin commands or paths of this computer. Applied to every answer a phone gets, also to one another
 * computer of the group gave, so a route that starts returning more later still doesn't hand it to a phone.
 */
import type { Context } from "hono";
import type {
  AgentFileEntry,
  AgentFileSearchHit,
  ApiTool,
  ComposioConnection,
  Credential,
  MacPasswordStatus,
  McpServer,
  MessagingConnection,
  Mod,
  PaymentCard,
  SshKeysOverview,
} from "@godmode/shared";

const ID = "[^/]+";

/** Files that usually hold keys or passwords: a phone neither lists nor opens them, also inside an agent's folder. */
const SECRET_FILE =
  /^(\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|\.dockercfg|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|mobileprovision)|credentials(\.json)?|secrets?(\.(json|ya?ml|toml|env|txt))?|service-account.*\.json)$/i;

/** Compared as macOS compares names: "id_r\u017fa" and "server.\u212aey" are id_rsa and server.key on its disk. */
export function isSecretFileName(name: string): boolean {
  return SECRET_FILE.test(name.normalize("NFKC"));
}

/** Top-level folders of an agent's repository that Godmode writes for itself: raw run logs, transcripts and its state. */
const MACHINE_FOLDERS = new Set(["runs", "conversations", "state"]);

export function isMachineFolder(name: string): boolean {
  return MACHINE_FOLDERS.has(name.normalize("NFKC").toLowerCase());
}

/**
 * Why a phone may not open this path of an agent's folder (null = it may). The core resolves paths inside the folder
 * anyway (agents/repo.ts); this refuses everything that even tries to leave it, before any file is touched.
 */
export function phoneFilePathRefusal(rel: string): string | null {
  const outside = "Only files in the agent's folder open on the phone.";
  // The core trims the path it opens: a path with spaces around it would be checked as one name and opened as another.
  if (rel !== rel.trim() || rel.length > 1024 || /[\u0000-\u001f\u007f\\:]/.test(rel) || rel.startsWith("/") || rel.startsWith("~") || /^[a-zA-Z]:/.test(rel)) return outside;
  const parts = rel.split("/");
  if (parts.some((p) => p.trim() === ".." || p.normalize("NFKC").toLowerCase() === ".git" || /~\d/.test(p))) return outside;
  if (parts.some(isSecretFileName) || isMachineFolder(parts.find((p) => p && p !== ".") ?? "")) return "Open this file in Godmode on your computer.";
  return null;
}

/** Scheme and host only: paths and query strings of integrations often carry keys. */
function originOf(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.protocol}//${u.host}` : "";
  } catch {
    return "";
  }
}

/** A login's address without the query string or fragment (sign-in links can carry a token). */
function pageOf(url: string): string {
  const origin = originOf(url);
  if (!origin) return "";
  try {
    return origin + new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return origin;
  }
}

const list =
  <T>(view: (item: T) => unknown) =>
  (body: unknown): unknown =>
    Array.isArray(body) ? (body as T[]).map(view) : body;

const visibleFile = (path: string) => {
  const parts = path.split("/");
  return !isMachineFolder(parts[0] ?? "") && !parts.some((p) => isSecretFileName(p) || p.toLowerCase() === ".git");
};

export const phoneCredential = (c: Credential): Credential => ({ ...c, url: pageOf(c.url), password: undefined, notes: undefined });

export const phoneMacPassword = (s: MacPasswordStatus): MacPasswordStatus => ({ ...s, recent: [] });

/** Name, brand, the last four digits, limits and what was spent: never the expiry, holder or billing address. */
export const phoneCard = (c: PaymentCard): PaymentCard => ({ ...c, expMonth: 0, expYear: 0, holderName: "", billingCountry: "" });

export const phoneMcpServer = (s: McpServer): McpServer => ({
  ...s,
  command: "",
  args: [],
  url: originOf(s.url),
  envKeys: [],
  headerKeys: [],
  composio: s.composio ? { toolkits: s.composio.toolkits, userId: "" } : null,
});

export const phoneApiTool = (t: ApiTool): ApiTool => ({
  ...t,
  docs: "",
  docsUrl: "",
  baseUrl: originOf(t.baseUrl),
  auth: { in: t.auth.in, name: "", prefix: "" },
  testPath: "",
  envVar: null,
});

export const phoneComposioConnection = (c: ComposioConnection): ComposioConnection => ({ ...c, connectedAccountId: "", userId: "" });

/** What a plugin is and whether it runs; never its code, option values or where its repository is cloned from. */
export const phoneMod = (m: Mod): Mod => ({
  ...m,
  files: {},
  digest: "",
  options: [],
  values: {},
  secretKeys: [],
  check: m.check ? { ...m.check, hooks: [], calls: [] } : null,
  source: m.source ? { ...m.source, url: "", path: "", npm: null, checkError: null } : null,
});

/** Teams delivers to a secret path; the bot's settings stay on the computer. */
export const phoneMessaging = (c: MessagingConnection): MessagingConnection => ({ ...c, endpointPath: null, config: {} });

export const phoneSshKeys = (o: SshKeysOverview): SshKeysOverview => ({ ...o, dir: "", keys: o.keys.map((k) => ({ ...k, path: null })) });

type View = (body: unknown) => unknown;

const VIEWS: [method: string, path: RegExp, view: View][] = [
  ["GET", /^\/api\/credentials$/, list(phoneCredential)],
  ["GET", /^\/api\/vault\/mac-password$/, (b) => phoneMacPassword(b as MacPasswordStatus)],
  ["GET", /^\/api\/cards$/, list(phoneCard)],
  ["GET", /^\/api\/ssh\/key-manager$/, (b) => phoneSshKeys(b as SshKeysOverview)],
  ["GET", /^\/api\/mcp-servers$/, list(phoneMcpServer)],
  ["GET", /^\/api\/api-tools$/, list(phoneApiTool)],
  ["GET", /^\/api\/composio\/connections$/, list(phoneComposioConnection)],
  ["GET", /^\/api\/mods$/, list(phoneMod)],
  ["PATCH", new RegExp(`^/api/mods/${ID}$`), (b) => phoneMod(b as Mod)],
  ["GET", /^\/api\/messaging$/, list(phoneMessaging)],
  ["GET", new RegExp(`^/api/agents/${ID}/files$`), (b) => (Array.isArray(b) ? (b as AgentFileEntry[]).filter((e) => visibleFile(e.path)) : b)],
  ["GET", new RegExp(`^/api/agents/${ID}/files/search$`), (b) => (Array.isArray(b) ? (b as AgentFileSearchHit[]).filter((e) => visibleFile(e.path)) : b)],
];

export function deviceView(method: string, path: string): View | null {
  return VIEWS.find(([m, re]) => m === method && re.test(path))?.[2] ?? null;
}

/** Rewrites a JSON answer to a phone through its view (when the route has one). */
export async function applyDeviceView(c: Context): Promise<void> {
  const view = deviceView(c.req.method, c.req.path);
  const res = c.res;
  if (!view || !res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return;
  const body = view(await res.json());
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  // Unset first: Hono would copy the old answer's headers (its length among them) onto the new one.
  c.res = undefined as never;
  c.res = new Response(JSON.stringify(body), { status: res.status, headers });
}

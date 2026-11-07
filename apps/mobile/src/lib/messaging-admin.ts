import { File, Paths } from "expo-file-system";
import { useQuery } from "@tanstack/react-query";
import type {
  MessagingChat,
  MessagingConnection,
  MessagingConnectionInput,
  MessagingConnectionPatch,
  MessagingCredentials,
  MessagingProvider,
  MessagingUser,
  MessagingUserStatus,
  MessagingVerifyResult,
} from "@godmode/shared";
import { slackManifest } from "@godmode/shared";
import { ApiError, reachableBase, request } from "./api";
import { t } from "./i18n";
import { ik } from "./integrations";
import { queryClient } from "./query";
import { withConfirmedGrant } from "./secrets";
import { useSession } from "./session";

/**
 * Messaging bots as the desktop app manages them (full-access phones only): connect, edit, people, disconnect. Tokens
 * are write-only: the computer seals them in the vault and never sends them back.
 */
const grantHeader = (grant?: string) => (grant ? { "x-godmode-grant": grant } : undefined);
const enc = encodeURIComponent;

export const messagingAdmin = {
  verify: (credentials: MessagingCredentials) => request<MessagingVerifyResult>("POST", "/api/messaging/verify", { credentials }, 30_000),
  create: (input: MessagingConnectionInput, grant?: string) => request<MessagingConnection>("POST", "/api/messaging", input, 30_000, grantHeader(grant)),
  update: (id: string, patch: MessagingConnectionPatch, grant?: string) => request<MessagingConnection>("PATCH", `/api/messaging/${enc(id)}`, patch, 30_000, grantHeader(grant)),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/messaging/${enc(id)}`),
  users: (id: string) => request<MessagingUser[]>("GET", `/api/messaging/${enc(id)}/users`),
  setUser: (id: string, userId: string, status: MessagingUserStatus) => request<MessagingUser>("PATCH", `/api/messaging/${enc(id)}/users/${enc(userId)}`, { status }),
  setOwner: (id: string, userId: string, isOwner: boolean) => request<MessagingUser>("PATCH", `/api/messaging/${enc(id)}/users/${enc(userId)}`, { isOwner }),
  removeUser: (id: string, userId: string) => request<{ ok: true }>("DELETE", `/api/messaging/${enc(id)}/users/${enc(userId)}`),
  chats: (id: string) => request<MessagingChat[]>("GET", `/api/messaging/${enc(id)}/chats`),
};

/** Under ["messaging"], so the computer's change events refresh them with the list. */
export const mk = {
  users: (id: string) => ["messaging", id, "users"],
  chats: (id: string) => ["messaging", id, "chats"],
} as const;

export const useBotUsers = (id: string | undefined, enabled = true) => useQuery({ queryKey: mk.users(id ?? ""), queryFn: () => messagingAdmin.users(id!), enabled: enabled && !!id });
export const useBotChats = (id: string | undefined, enabled = true) => useQuery({ queryKey: mk.chats(id ?? ""), queryFn: () => messagingAdmin.chats(id!), enabled: enabled && !!id });

export const refreshMessaging = () => void queryClient.invalidateQueries({ queryKey: ik.messaging });

/** Opening a bot to anyone (or giving an open bot more agents) takes Face ID and the vault password, like the desktop's grant. */
export const createBot = (input: MessagingConnectionInput) => withConfirmedGrant(t("messaging:grantReason"), (grant) => messagingAdmin.create(input, grant));
export const updateBot = (id: string, patch: MessagingConnectionPatch) => withConfirmedGrant(t("messaging:grantReason"), (grant) => messagingAdmin.update(id, patch, grant));

export interface CredentialFields {
  botToken: string;
  appToken: string;
  appId: string;
  tenantId: string;
  appPassword: string;
}

export const EMPTY_FIELDS: CredentialFields = { botToken: "", appToken: "", appId: "", tenantId: "", appPassword: "" };

/** The credentials the fields make, or null while one is missing. */
export function credentialsOf(provider: MessagingProvider, f: CredentialFields): MessagingCredentials | null {
  if (provider === "telegram") return f.botToken.trim() ? { provider, botToken: f.botToken.trim() } : null;
  if (provider === "slack") return f.botToken.trim() && f.appToken.trim() ? { provider, botToken: f.botToken.trim(), appToken: f.appToken.trim() } : null;
  return f.appId.trim() && f.tenantId.trim() && f.appPassword ? { provider, appId: f.appId.trim(), tenantId: f.tenantId.trim(), appPassword: f.appPassword } : null;
}

/** Where the bot is made: BotFather, Slack's app page with Godmode's manifest, the Azure portal. */
export function setupUrl(provider: MessagingProvider): string {
  if (provider === "telegram") return "https://t.me/BotFather";
  if (provider === "slack") return `https://api.slack.com/apps?new_app=1&manifest_json=${enc(JSON.stringify(slackManifest("Godmode")))}`;
  return "https://portal.azure.com/#create/Microsoft.AzureBot";
}

/** "@godmode_bot", "Acme workspace": how the bot is known on its platform. */
export function botHandle(c: MessagingConnection): string | null {
  if (c.bot.username && c.provider === "telegram") return `@${c.bot.username}`;
  return c.bot.team || null;
}

/** The address Azure delivers Teams messages to (null until the public address is set). */
export function teamsEndpoint(c: MessagingConnection): string | null {
  if (!c.config.publicUrl || !c.endpointPath) return null;
  return `${c.config.publicUrl}${c.endpointPath}`;
}

/** The Teams app package for upload in Teams, saved in the phone's cache to share. */
export async function downloadTeamsApp(c: MessagingConnection): Promise<File> {
  const connection = useSession.getState().connection;
  if (!connection) throw new ApiError(401, t("system:api.notPaired"), "not_paired");
  const found = await reachableBase(connection);
  if (!found || found instanceof ApiError) throw found ?? new ApiError(0, t("system:api.offline"), "offline");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${found.base}/api/messaging/${enc(c.id)}/teams-app`, { headers: { authorization: `Bearer ${connection.token}` }, signal: controller.signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      throw new ApiError(res.status, body?.error ?? t("system:api.requestFailed", { status: res.status }), body?.code);
    }
    const name = `${c.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "godmode"}-teams-app.zip`;
    const file = new File(Paths.cache, name);
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

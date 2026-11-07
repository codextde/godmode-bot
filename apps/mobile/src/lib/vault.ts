import { useQuery } from "@tanstack/react-query";
import type {
  ApiTool,
  ApiToolInput,
  ApiToolTestResult,
  CardPurchase,
  CardPurchasePatch,
  Credential,
  CredentialInput,
  MacPasswordStatus,
  MissingLogin,
  MissingLoginTotpChoices,
  MissingLoginTotpLinkInput,
  MissingLoginTotpLinkResult,
  Passkey,
  PasswordImportPreview,
  PasswordImportResult,
  PaymentCard,
  PaymentCardInput,
  PaymentCardSecrets,
  SshKeyGenerateInput,
  SshKeyImportInput,
  SshKeyInstallResult,
  SshKeyChange,
  SshKeyPatch,
  SshKeysOverview,
  SshManagedKey,
  TotpAutoLinkResult,
  TotpAutoLinkSuggestion,
  TotpCode,
  TotpEntry,
  TotpImportResult,
  TotpInput,
  VaultStatus,
} from "@godmode/shared";
import { cardExpired } from "@godmode/shared";
import type { IconName } from "@/components/icon";
import { ApiError, request } from "./api";
import { qk, queryClient } from "./query";

/**
 * The vault as the phone sees it: lists without a password, 2FA code or seed, card number or private key (the computer
 * leaves them out for phones). A limited phone can only lock it; a phone with full access does what the desktop app does
 * (`full` below), and every reveal asks for Face ID first and a grant from the vault password (lib/secrets.ts).
 */
const get = <T>(path: string) => request<T>("GET", path);

export const vaultApi = {
  status: () => get<VaultStatus>("/api/vault/status"),
  lock: () => request<VaultStatus>("POST", "/api/vault/lock", {}),
  logins: () => get<Credential[]>("/api/credentials"),
  totp: () => get<TotpEntry[]>("/api/totp"),
  passkeys: () => get<Passkey[]>("/api/passkeys"),
  cards: () => get<PaymentCard[]>("/api/cards"),
  purchases: (cardId?: string) => get<CardPurchase[]>(`/api/card-purchases?limit=200${cardId ? `&cardId=${encodeURIComponent(cardId)}` : ""}`),
  macPassword: () => get<MacPasswordStatus>("/api/vault/mac-password"),
  sshKeys: () => get<SshKeysOverview>("/api/ssh/key-manager"),
};

const grantHeader = (grant?: string) => (grant ? { "x-godmode-grant": grant } : undefined);
const id = encodeURIComponent;

/** What a phone with full access may do too. Revealed values are never kept in the query cache. */
export const fullVaultApi = {
  unlock: (passphrase: string) => request<VaultStatus>("POST", "/api/vault/unlock", { passphrase }),
  grant: (passphrase: string) => request<{ grant: string; expiresAt: string }>("POST", "/api/vault/grant", { passphrase }),
  revealLogin: (loginId: string, grant?: string) => request<{ password: string | null; notes: string | null }>("POST", `/api/credentials/${id(loginId)}/reveal`, {}, 0, grantHeader(grant)),
  createLogin: (input: CredentialInput) => request<Credential>("POST", "/api/credentials", input),
  updateLogin: (loginId: string, input: Partial<CredentialInput>) => request<Credential>("PATCH", `/api/credentials/${id(loginId)}`, input),
  deleteLogin: (loginId: string) => request<{ ok: true }>("DELETE", `/api/credentials/${id(loginId)}`),
  totpCodes: (ids?: string[]) => get<TotpCode[]>(`/api/totp/codes${ids?.length ? `?ids=${ids.map(id).join(",")}` : ""}`),
  createTotp: (input: TotpInput) => request<TotpEntry>("POST", "/api/totp", input),
  importTotp: (uris: string[], workspaceId: string | null) => request<TotpImportResult>("POST", "/api/totp/import", { uris, workspaceId }),
  updateTotp: (totpId: string, input: Partial<TotpInput>) => request<TotpEntry>("PATCH", `/api/totp/${id(totpId)}`, input),
  deleteTotp: (totpId: string) => request<{ ok: true }>("DELETE", `/api/totp/${id(totpId)}`),
  /** Logins and 2FA codes that belong together by service and account, like the desktop's suggestions. */
  autolinkSuggestions: () => get<TotpAutoLinkSuggestion[]>("/api/totp/autolink"),
  autolink: (pairs: { credentialId: string; totpId: string }[]) => request<TotpAutoLinkResult>("POST", "/api/totp/autolink", { pairs }),
  deletePasskey: (passkeyId: string) => request<{ ok: true }>("DELETE", `/api/passkeys/${id(passkeyId)}`),
  revealCard: (cardId: string, grant?: string) => request<PaymentCardSecrets>("POST", `/api/cards/${id(cardId)}/reveal`, {}, 0, grantHeader(grant)),
  createCard: (input: PaymentCardInput) => request<PaymentCard>("POST", "/api/cards", input),
  /** Loosening a card (higher limits, fewer approvals, unfreezing) needs a grant. */
  updateCard: (cardId: string, input: Partial<PaymentCardInput>, grant?: string) => request<PaymentCard>("PATCH", `/api/cards/${id(cardId)}`, input, 0, grantHeader(grant)),
  deleteCard: (cardId: string) => request<{ ok: true }>("DELETE", `/api/cards/${id(cardId)}`),
  /** Paid, not charged, or a subscription ended or active again. Not charged and ended free room under the limits: a grant. */
  updatePurchase: (purchaseId: string, patch: CardPurchasePatch, grant?: string) =>
    request<CardPurchase>("PATCH", `/api/card-purchases/${id(purchaseId)}`, patch, 0, grantHeader(grant)),
  /** A login an agent reported missing is saved: the report is resolved with it. */
  resolveMissingLogin: (missingId: string, credentialId: string) => request<MissingLogin>("PATCH", `/api/missing-logins/${id(missingId)}`, { status: "resolved", credentialId }),
  /** The site's logins and the 2FA codes that most likely belong to a missing-2FA report. */
  totpChoices: (missingId: string) => get<MissingLoginTotpChoices>(`/api/missing-logins/${id(missingId)}/totp-choices`),
  /** Links a saved 2FA code to the site's login and resolves the report. */
  linkMissingTotp: (missingId: string, input: MissingLoginTotpLinkInput) =>
    request<MissingLoginTotpLinkResult>("POST", `/api/missing-logins/${id(missingId)}/link-totp`, input),
  secrets: () => get<AppSecret[]>("/api/vault/secrets"),
  setSecret: (key: string, value: string) => request<{ ok: true }>("PUT", `/api/vault/secrets/${id(key)}`, { value }),
  deleteSecret: (key: string) => request<{ ok: true }>("DELETE", `/api/vault/secrets/${id(key)}`),
  /** Composio's key is checked with Composio when it is saved, like on the desktop. */
  setComposioKey: (apiKey: string | null) => request<unknown>("PUT", "/api/composio/key", { apiKey }, 20_000),
  saveMacPassword: (password: string) => request<MacPasswordStatus>("PUT", "/api/vault/mac-password", { password }),
  removeMacPassword: () => request<MacPasswordStatus>("DELETE", "/api/vault/mac-password"),
  apiTools: () => get<ApiTool[]>("/api/api-tools?workspaceId=all"),
  /** A new key never needs a grant; moving a saved one elsewhere does (not offered here). */
  updateApiTool: (toolId: string, input: Partial<ApiToolInput>) => request<ApiTool>("PATCH", `/api/api-tools/${id(toolId)}`, input),
  testApiTool: (toolId: string) => request<ApiToolTestResult>("POST", `/api/api-tools/${id(toolId)}/test`, {}, 30_000),
  deleteApiTool: (toolId: string) => request<{ ok: true }>("DELETE", `/api/api-tools/${id(toolId)}`),
  generateSshKey: (input: SshKeyGenerateInput) => request<SshManagedKey>("POST", "/api/ssh/key-manager", input, 30_000),
  updateSshKey: (name: string, input: SshKeyPatch) => request<SshKeyChange>("PATCH", `/api/ssh/key-manager/${id(name)}`, input),
  deleteSshKey: (name: string) => request<{ ok: true }>("DELETE", `/api/ssh/key-manager/${id(name)}`),
  setSshKeyLoaded: (name: string, loaded: boolean, passphrase?: string) => request<SshManagedKey>("POST", `/api/ssh/key-manager/${id(name)}/agent`, { loaded, passphrase }),
  /** A private key (OpenSSH or PEM) or a public key line, saved in ~/.ssh of the computer. */
  importSshKey: (input: SshKeyImportInput) => request<SshManagedKey>("POST", "/api/ssh/key-manager/import", input),
  /** Adds the public key to a saved server's authorized_keys. */
  installSshKey: (name: string, serverId: string) => request<SshKeyInstallResult>("POST", `/api/ssh/key-manager/${id(name)}/install`, { serverId }, 90_000),
  /** Compares a password manager's export with the saved logins (a grant: it would tell whether a password matches). */
  previewPasswordImport: (file: PickedFile, workspaceId: string | null, grant?: string) =>
    request<PasswordImportPreview>("POST", "/api/credentials/import/preview", exportForm(file, workspaceId), IMPORT_MS, grantHeader(grant)),
  importPasswords: (file: PickedFile, workspaceId: string | null, ids: number[], grant?: string) => {
    const form = exportForm(file, workspaceId);
    form.append("ids", JSON.stringify(ids));
    return request<PasswordImportResult>("POST", "/api/credentials/import", form, IMPORT_MS, grantHeader(grant));
  },
};

/** A file picked on the phone, held in memory only (lib/picked-file.ts). */
export interface PickedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

const IMPORT_MS = 5 * 60_000;

function exportForm(file: PickedFile, workspaceId: string | null): FormData {
  const form = new FormData();
  // expo/fetch (the global fetch) takes parts that hand over their own bytes.
  form.append("file", { name: file.name, type: file.mime, bytes: () => Promise.resolve(file.bytes) } as unknown as Blob);
  form.append("workspaceId", workspaceId ?? "");
  return form;
}

/** The app-level keys the desktop app lists, by name; others show by their key. */
export const APP_SECRETS: Record<string, { name: string; icon: IconName }> = {
  anthropic_api_key: { name: "Anthropic", icon: "brain" },
  zai_api_key: { name: "Z.ai", icon: "sparkles" },
  openai_api_key: { name: "OpenAI", icon: "mic" },
  elevenlabs_api_key: { name: "ElevenLabs", icon: "waveform" },
  browser_use_api_key: { name: "browser-use Cloud", icon: "globe" },
  twocaptcha_api_key: { name: "2Captcha", icon: "puzzle" },
  capsolver_api_key: { name: "CapSolver", icon: "puzzle" },
  anticaptcha_api_key: { name: "Anti-Captcha", icon: "puzzle" },
  composio_api_key: { name: "Composio", icon: "layers" },
  composio_user_api_key: { name: "Composio user", icon: "layers" },
};

export const secretLabel = (key: string) => APP_SECRETS[key]?.name ?? key;

/** An app-level key in the vault (Anthropic, OpenAI, …): only whether it is set, never its value. */
export interface AppSecret {
  key: string;
  set: boolean;
  updatedAt: string | null;
}

export const vk = {
  all: ["vault"],
  status: ["vault", "status"],
  logins: ["vault", "logins"],
  totp: ["vault", "totp"],
  passkeys: ["vault", "passkeys"],
  cards: ["vault", "cards"],
  purchases: (cardId?: string) => ["vault", "purchases", cardId ?? "all"],
  macPassword: ["vault", "mac-password"],
  sshKeys: ["vault", "ssh-keys"],
  secrets: ["vault", "secrets"],
  apiTools: ["vault", "api-tools"],
  autolink: ["vault", "totp-autolink"],
  totpChoices: (missingId: string) => ["vault", "totp-choices", missingId],
} as const;

/** An older Godmode on the computer doesn't let phones read this yet. */
export function isOutdated(err: unknown): boolean {
  return err instanceof ApiError && err.code === "device_forbidden";
}

export const useVaultStatus = () => useQuery({ queryKey: vk.status, queryFn: vaultApi.status });
export const useLogins = () => useQuery({ queryKey: vk.logins, queryFn: vaultApi.logins });
export const useTotp = () => useQuery({ queryKey: vk.totp, queryFn: vaultApi.totp });
export const usePasskeys = () => useQuery({ queryKey: vk.passkeys, queryFn: vaultApi.passkeys });
export const useCards = () => useQuery({ queryKey: vk.cards, queryFn: vaultApi.cards });
export const usePurchases = (cardId?: string) => useQuery({ queryKey: vk.purchases(cardId), queryFn: () => vaultApi.purchases(cardId) });
export const useMacPassword = () => useQuery({ queryKey: vk.macPassword, queryFn: vaultApi.macPassword });
export const useSshKeys = () => useQuery({ queryKey: vk.sshKeys, queryFn: vaultApi.sshKeys, retry: false });
export const useAppSecrets = (enabled = true) => useQuery({ queryKey: vk.secrets, queryFn: fullVaultApi.secrets, enabled });
export const useVaultApiTools = (enabled = true) => useQuery({ queryKey: vk.apiTools, queryFn: fullVaultApi.apiTools, enabled });

/** Lists that show a login, a 2FA entry or their link changed on the computer: fetch them again. */
export function refreshVault() {
  void queryClient.invalidateQueries({ queryKey: vk.all });
  void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
}

/** The vault is locked: logins, codes and cards can't be read or changed until it is unlocked. */
export function isVaultLocked(err: unknown): boolean {
  return err instanceof ApiError && err.status === 423;
}

/** "all", "global" or a workspace's id: the desktop's scope filter on vault lists. */
export type VaultScope = string;

/** Exact, like the computer's own filter: a workspace shows what is saved in it, not the global entries. */
export const inScope = (item: { workspaceId: string | null }, scope: VaultScope) => scope === "all" || (scope === "global" ? !item.workspaceId : item.workspaceId === scope);

/** A limited phone isn't told a card's expiry: it gets 0, which isn't an expired card. */
export const isCardExpired = (card: Pick<PaymentCard, "expMonth" | "expYear">) => card.expYear > 0 && cardExpired(card);

/** "github.com" from what someone typed as a website: "https://www.github.com/login" or "github.com". */
export function domainFromUrl(input: string): string {
  const s = input.trim();
  if (!s) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** "github.com/login" → "https://github.com/login"; "" stays "". */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

/** The site a 2FA entry's service most likely is: "GitHub" → "github.com", "accounts.google.com" stays. */
export function issuerDomain(issuer: string): string {
  const s = issuer.trim().toLowerCase();
  if (!s) return "";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return s.replace(/^www\./, "");
  const slug = s.replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
  return slug ? `${slug}.com` : "";
}

/** "github.com" for a login: its first domain, else its address' host. */
export function loginHost(c: Pick<Credential, "domains" | "url">): string {
  if (c.domains[0]) return c.domains[0];
  try {
    return new URL(c.url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** "github.com", not "github" or a whole address: what a login's list of sites takes. */
export const isDomain = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);

/** A login's domains plus what was typed or pasted (several at once, by comma or space), skipping what isn't a site. */
export function withDomains(domains: string[], typed: string): string[] {
  const next = [...domains];
  for (const part of typed.split(/[,\s]+/)) {
    const d = domainFromUrl(part);
    if (d && isDomain(d) && !next.includes(d)) next.push(d);
  }
  return next;
}

/** "app.example.co.uk" → "example.co.uk". */
export function rootDomain(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length <= 2) return domain;
  const sld = parts[parts.length - 2]!;
  if (sld.length <= 3 && parts[parts.length - 1]!.length === 2) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

const PRETTY: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  paypal: "PayPal",
  openai: "OpenAI",
  hubspot: "HubSpot",
  wordpress: "WordPress",
  icloud: "iCloud",
};

/** A login's name from its site, like the desktop: "github.com" → "GitHub", "stripe.com" → "Stripe". */
export function prettyName(domain: string): string {
  if (!domain) return "";
  const label = rootDomain(domain).split(".")[0] ?? "";
  return PRETTY[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

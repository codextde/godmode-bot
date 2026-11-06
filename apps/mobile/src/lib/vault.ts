import { useQuery } from "@tanstack/react-query";
import type { CardPurchase, Credential, MacPasswordStatus, Passkey, PaymentCard, SshKeysOverview, TotpEntry, VaultStatus } from "@godmode/shared";
import { ApiError, request } from "./api";

/**
 * The vault as the phone sees it: lists without a password, 2FA code or seed, card number or private key (the computer
 * leaves them out for phones). Locking is the only change; unlocking and everything else stays on the computer.
 */
const get = <T>(path: string) => request<T>("GET", path);

export const vaultApi = {
  status: () => get<VaultStatus>("/api/vault/status"),
  lock: () => request<VaultStatus>("POST", "/api/vault/lock", {}),
  logins: () => get<Credential[]>("/api/credentials"),
  totp: () => get<TotpEntry[]>("/api/totp"),
  passkeys: () => get<Passkey[]>("/api/passkeys"),
  cards: () => get<PaymentCard[]>("/api/cards"),
  purchases: (cardId?: string) => get<CardPurchase[]>(`/api/card-purchases?limit=100${cardId ? `&cardId=${encodeURIComponent(cardId)}` : ""}`),
  macPassword: () => get<MacPasswordStatus>("/api/vault/mac-password"),
  sshKeys: () => get<SshKeysOverview>("/api/ssh/key-manager"),
};

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

/** "github.com" for a login: its first domain, else its address' host. */
export function loginHost(c: Pick<Credential, "domains" | "url">): string {
  if (c.domains[0]) return c.domains[0];
  try {
    return new URL(c.url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

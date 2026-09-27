import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRequestError, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** 423 = the vault got locked (auto-lock or locked elsewhere). */
export function isVaultLocked(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 423;
}

/**
 * Standard error toast for vault/access screens. On 423 it refreshes bootstrap so the app
 * swaps to the unlock screen instead of showing a confusing error.
 */
export function toastApiError(err: unknown, title: string, qc?: QueryClient) {
  if (isVaultLocked(err)) {
    toast.warning("Vault is locked", { description: "Unlock the vault to continue." });
    void qc?.invalidateQueries({ queryKey: qk.bootstrap });
    void qc?.invalidateQueries({ queryKey: qk.vaultStatus });
    return;
  }
  toast.error(title, { description: errorMessage(err) });
}

/** "https://app.github.com/login" → "app.github.com"; tolerates bare domains. */
export function domainFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  const raw = url.trim();
  if (!raw) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].replace(/^www\./, "").toLowerCase();
  }
}

/** Registrable-ish root: "accounts.google.com" → "google.com" (good enough for UI grouping). */
export function rootDomain(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length <= 2) return domain;
  const sld = parts[parts.length - 2];
  // co.uk, com.au, …
  if (sld.length <= 3 && parts[parts.length - 1].length === 2) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

export function normalizeUrl(url: string): string {
  const raw = url.trim();
  if (!raw) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** Local / private-network hosts have no public icon — never send them to a third-party icon service. */
export function isPrivateHost(domain: string): boolean {
  const h = domain.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".lan") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) ||
    h === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(h)
  );
}

export function faviconUrl(domain: string, size = 64): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

/** Stable pleasant hue from a string (for initial avatars). */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

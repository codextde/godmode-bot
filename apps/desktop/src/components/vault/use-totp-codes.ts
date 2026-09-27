import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TotpCode } from "@godmode/shared";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { toastApiError } from "./vault-utils";

export interface LiveCode extends TotpCode {
  /** Epoch ms at which this code stops being valid */
  expiresAt: number;
}

/**
 * Current TOTP codes. Instead of polling every second, the codes are refetched right after the
 * earliest period boundary; countdowns are derived locally from `expiresAt` (see useNow).
 */
export function useTotpCodes(enabled = true) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: qk.totpCodes,
    queryFn: () => api.totp.codes(),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const { data, dataUpdatedAt, refetch, error } = query;

  const codes = useMemo(() => {
    const map = new Map<string, LiveCode>();
    for (const c of data ?? []) map.set(c.id, { ...c, expiresAt: dataUpdatedAt + c.remaining * 1000 });
    return map;
  }, [data, dataUpdatedAt]);

  useEffect(() => {
    if (!enabled || codes.size === 0) return;
    let earliest = Infinity;
    for (const c of codes.values()) earliest = Math.min(earliest, c.expiresAt);
    const delay = Math.max(0, earliest - Date.now()) + 200;
    const id = setTimeout(() => void refetch(), Math.min(delay, 60_000));
    return () => clearTimeout(id);
  }, [codes, enabled, refetch]);

  // Refresh after the tab was hidden (timers are throttled in background tabs).
  useEffect(() => {
    if (!enabled) return;
    const onVis = () => !document.hidden && void refetch();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled, refetch]);

  const reported = useRef<unknown>(null);
  useEffect(() => {
    if (error && reported.current !== error) {
      reported.current = error;
      toastApiError(error, "Could not load 2FA codes", qc);
    }
  }, [error, qc]);

  return { ...query, codes };
}

/** "123456" → "123 456", "12345678" → "1234 5678" */
export function formatCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  if (code.length === 7) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}

/** Best-effort site domain for a 2FA issuer ("GitHub" → "github.com", "accounts.google.com" stays). */
export function issuerDomain(issuer: string): string {
  const s = issuer.trim().toLowerCase();
  if (!s) return "";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return s.replace(/^www\./, "");
  const slug = s.replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
  return slug ? `${slug}.com` : "";
}

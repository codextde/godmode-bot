import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ClaudeAccount } from "@godmode/shared";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export function useClaudeAccounts() {
  return useQuery({ queryKey: qk.claudeAccounts, queryFn: api.claudeAccounts.list, refetchInterval: 60_000, refetchOnWindowFocus: true });
}

export function useAccountName() {
  const { t } = useTranslation("settings");
  return (account: ClaudeAccount): string => account.email ?? (account.system ? t("accounts.thisComputer") : t("accounts.unknown"));
}

export function planLabel(plan: string | null): string | null {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function initials(a: ClaudeAccount): string {
  const source = a.name || a.email || "C";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "C") + (a.name && parts[1] ? parts[1][0] : "")).toUpperCase();
}

type Health = "ok" | "limited" | "signedOut" | "unknown";

export function healthOf(a: ClaudeAccount): Health {
  if (a.needsSignIn) return "signedOut";
  if (a.limitedUntil) return "limited";
  if (a.usage?.state === "ok") return "ok";
  return "unknown";
}

const DOT: Record<Health, string> = {
  ok: "bg-success",
  limited: "bg-warning",
  signedOut: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

export function AccountAvatar({ account, className }: { account: ClaudeAccount; className?: string }) {
  return (
    <span className={cn("relative grid size-9 shrink-0 place-items-center rounded-full border bg-paper-2 text-[13px] font-medium tracking-tight", className)}>
      {initials(account)}
      <span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-card", DOT[healthOf(account)])} aria-hidden />
    </span>
  );
}

export function PlanTag({ plan }: { plan: string | null }) {
  const label = planLabel(plan);
  if (!label) return null;
  return <span className="rounded-[5px] border px-1.5 py-px text-[11px] leading-4 font-medium text-muted-foreground">{label}</span>;
}

export function DefaultTag({ className }: { className?: string }) {
  const { t } = useTranslation("settings");
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-[5px] bg-brand/10 px-1.5 py-px text-[11px] leading-4 font-medium text-brand", className)}>
      <Star className="size-2.5 fill-current" aria-hidden />
      {t("accounts.default")}
    </span>
  );
}

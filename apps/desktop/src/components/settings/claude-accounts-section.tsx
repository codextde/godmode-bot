import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, LogIn, MoreHorizontal, Plus, RefreshCw, Star, Trash2, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ClaudeAccount, ClaudeAccountLogin, ClaudeAccountsState, ClaudeUsageWindow, Settings } from "@godmode/shared";
import { AccountAvatar, DefaultTag, healthOf, PlanTag, useAccountName, useClaudeAccounts } from "@/components/claude-accounts/shared";
import { useResetLabel } from "@/components/layout/usage-ring";
import { ClaudeSignInSteps, type SignInFlow } from "@/components/onboarding/claude-sign-in";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { writeClipboard } from "@/components/vault/clipboard";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { intlLocale } from "@/i18n";
import { Callout, NumberField, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

function tone(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 75) return "bg-warning";
  return "bg-foreground/70";
}

function Meter({ label, window }: { label: string; window: ClaudeUsageWindow | null }) {
  const resetLabel = useResetLabel();
  const percent = Math.round(window?.percent ?? 0);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="grid grid-cols-[3.25rem_1fr_2.25rem] items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="h-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", window ? tone(percent) : "")}
              style={{ width: `${window ? Math.max(2, percent) : 0}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{window ? `${percent}%` : "–"}</span>
        </div>
      </TooltipTrigger>
      {window && <TooltipContent>{resetLabel(window.resetsAt)}</TooltipContent>}
    </Tooltip>
  );
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(intlLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/* ------------------------------------------------------------------ */
/* Signing an account in                                                */
/* ------------------------------------------------------------------ */

function useAccountLogin(login: ClaudeAccountLogin | undefined) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const set = (next: ClaudeAccountLogin) => qc.setQueryData<ClaudeAccountsState>(qk.claudeAccounts, (old) => (old ? { ...old, login: next } : old));
  const start = useMutation({
    mutationFn: (accountId: string | null) => api.claudeAccounts.startLogin(accountId),
    onSuccess: set,
    onError: (e) => toast.error(t("accounts.startFailed"), { description: errorMessage(e) }),
  });
  const cancel = useMutation({ mutationFn: api.claudeAccounts.cancelLogin, onSuccess: set });
  const submit = useMutation({
    mutationFn: (code: string) => api.claudeAccounts.submitCode(code),
    onError: (e) => toast.error(t("accounts.codeFailed"), { description: errorMessage(e) }),
  });
  const state = login?.state ?? "idle";
  const url = state === "waiting" ? (login?.url ?? null) : null;
  const [copied, setCopied] = useState<{ url: string; ok: boolean } | null>(null);
  const copy = async () => {
    if (!url) return;
    const ok = await writeClipboard(url).then(
      () => true,
      () => false,
    );
    setCopied({ url, ok });
    if (ok) toast.success(t("accounts.linkCopied"));
  };

  const prev = useRef(state);
  useEffect(() => {
    if (prev.current === "waiting" && state === "done") toast.success(t("accounts.added", { email: login?.message ?? "" }));
    if (prev.current === "waiting" && state === "failed") {
      toast.error(t("accounts.signInFailed"), { description: login?.message ?? undefined });
    }
    prev.current = state;
  }, [state, login?.message, t]);

  const flow: SignInFlow = {
    link: { url, copied: copied?.url === url ? copied.ok : null, copy },
    submit: { mutate: (code, options) => submit.mutate(code, { onSuccess: options?.onSuccess }), isPending: submit.isPending },
    cancel: { mutate: () => cancel.mutate(), isPending: cancel.isPending },
  };
  return { state, accountId: login?.accountId ?? null, start, flow };
}

/* ------------------------------------------------------------------ */
/* The section                                                          */
/* ------------------------------------------------------------------ */

function AccountRow({
  account,
  busy,
  onDefault,
  onReauth,
  onRemove,
}: {
  account: ClaudeAccount;
  busy: boolean;
  onDefault: () => void;
  onReauth: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("settings");
  const health = healthOf(account);
  const accountName = useAccountName();
  const subtitle = account.system ? t("accounts.systemLogin") : account.organization || account.name || t("accounts.addedHere");
  return (
    <div className="group flex flex-wrap items-center gap-x-4 gap-y-3 py-3.5 @xl:flex-nowrap">
      <div className="flex min-w-0 flex-1 basis-60 items-center gap-3">
        <AccountAvatar account={account} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{accountName(account)}</span>
            <PlanTag plan={account.plan} />
            {account.isDefault && <DefaultTag />}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {health === "signedOut" ? (
              <span className="text-destructive">{t("accounts.signedOut")}</span>
            ) : health === "limited" ? (
              <span className="text-warning">{t("accounts.limitedUntil", { time: timeOf(account.limitedUntil!) })}</span>
            ) : (
              subtitle
            )}
          </p>
        </div>
      </div>

      <div className="w-full space-y-1.5 @xl:w-48">
        {!(account.usage?.state === "ok" && !account.usage.fiveHour) && <Meter label={t("accounts.session")} window={account.usage?.fiveHour ?? null} />}
        <Meter label={t("accounts.week")} window={account.usage?.week ?? null} />
      </div>

      <div className="ml-auto flex items-center justify-end gap-1 @xl:w-44">
        {health === "signedOut" && !account.system ? (
          <Button size="sm" variant="outline" onClick={onReauth} disabled={busy}>
            <LogIn /> {t("accounts.signInAgain")}
          </Button>
        ) : (
          !account.isDefault && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground opacity-100 transition-opacity @xl:opacity-0 @xl:group-focus-within:opacity-100 @xl:group-hover:opacity-100"
              onClick={onDefault}
              disabled={busy}
            >
              <Star /> {t("accounts.makeDefault")}
            </Button>
          )
        )}
        {account.system ? (
          <span className="size-8 shrink-0" aria-hidden />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label={t("accounts.more")}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {!account.isDefault && (
                <DropdownMenuItem onSelect={onDefault}>
                  <Star /> {t("accounts.makeDefault")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onReauth} disabled={busy}>
                <LogIn /> {t("accounts.signInAgain")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2 /> {t("accounts.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

export function ClaudeAccountsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const { patch } = useSettingsPatch();
  const { data, isPending } = useClaudeAccounts();
  const login = useAccountLogin(data?.login);
  const [removing, setRemoving] = useState<ClaudeAccount | null>(null);
  const accounts = data?.accounts ?? [];
  const extra = accounts.filter((a) => !a.system).length;
  const r = settings.runner;
  const signingIn = login.state === "waiting";

  const setList = (list: ClaudeAccount[]) => qc.setQueryData<ClaudeAccountsState>(qk.claudeAccounts, (old) => (old ? { ...old, accounts: list } : old));
  const makeDefault = useMutation({
    mutationFn: api.claudeAccounts.setDefault,
    onSuccess: setList,
    onError: (e) => toast.error(t("accounts.defaultFailed"), { description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: api.claudeAccounts.remove,
    onSuccess: (list) => {
      setList(list);
      toast.success(t("accounts.removed"));
    },
    onError: (e) => toast.error(t("accounts.removeFailed"), { description: errorMessage(e) }),
  });
  const refresh = useMutation({
    mutationFn: api.claudeAccounts.refresh,
    onSuccess: (s) => qc.setQueryData(qk.claudeAccounts, s),
  });

  return (
    <div className="space-y-5">
      <SectionHeading title={t("accounts.title")} description={t("accounts.description")} />

      {data?.locked && extra > 0 && (
        <Callout tone="warning" title={t("accounts.lockedTitle")}>
          {t("accounts.lockedBody")}
        </Callout>
      )}

      <SettingsGroup
        title={t("accounts.listTitle")}
        icon={<UsersRound />}
        description={t("accounts.listDescription")}
        actions={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label={t("accounts.refresh")} onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                  <RefreshCw className={cn(refresh.isPending && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("accounts.refresh")}</TooltipContent>
            </Tooltip>
            <Button size="sm" onClick={() => login.start.mutate(null)} disabled={signingIn || login.start.isPending || data?.locked}>
              {login.start.isPending ? <Spinner /> : <Plus />} {t("accounts.add")}
            </Button>
          </>
        }
      >
        {isPending && (
          <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <Spinner className="size-3.5" /> {t("common:status.loading")}
          </div>
        )}
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            busy={signingIn}
            onDefault={() => makeDefault.mutate(a.id)}
            onReauth={() => login.start.mutate(a.id)}
            onRemove={() => setRemoving(a)}
          />
        ))}
        {signingIn && (
          <div className="py-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {login.accountId ? t("accounts.signingInAgain", { email: accounts.find((a) => a.id === login.accountId)?.email ?? "" }) : t("accounts.adding")}
            </p>
            <ClaudeSignInSteps login={login.flow} />
          </div>
        )}
        {!isPending && extra === 0 && !signingIn && (
          <div className="py-4">
            <button
              type="button"
              onClick={() => login.start.mutate(null)}
              disabled={data?.locked}
              className="flex w-full items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-left transition-colors hover:border-foreground/25 hover:bg-paper-2 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">
                <Plus className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t("accounts.emptyTitle")}</span>
                <span className="block text-xs text-muted-foreground">{t("accounts.emptyBody")}</span>
              </span>
            </button>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("accounts.switchTitle")} icon={<ArrowLeftRight />} description={t("accounts.switchDescription")}>
        <SettingRow label={t("accounts.autoSwitch")} htmlFor="account-auto-switch" description={t("accounts.autoSwitchDescription")}>
          <Switch id="account-auto-switch" checked={r.accountAutoSwitch ?? true} onCheckedChange={(accountAutoSwitch) => patch({ runner: { accountAutoSwitch } })} />
        </SettingRow>
        <SettingRow label={t("accounts.threshold")} htmlFor="account-threshold" description={t("accounts.thresholdDescription")} disabled={!(r.accountAutoSwitch ?? true)}>
          <NumberField
            id="account-threshold"
            value={r.accountSwitchPercent ?? 90}
            min={50}
            max={100}
            suffix="%"
            className="w-28"
            disabled={!(r.accountAutoSwitch ?? true)}
            onCommit={(v) => v !== null && patch({ runner: { accountSwitchPercent: v } })}
          />
        </SettingRow>
      </SettingsGroup>
      <p className="px-1 text-xs text-muted-foreground">{t("accounts.perWorkspaceDescription")}</p>

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("accounts.removeTitle", { email: removing?.email ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("accounts.removeBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (removing) remove.mutate(removing.id);
                setRemoving(null);
              }}
            >
              {t("accounts.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

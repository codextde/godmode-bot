import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Fingerprint, Globe, Lock, Search, SearchX, Settings2, Trash2, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { Passkey } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, PageBody, ScopeBadge, StatusDot } from "@/components/common";
import { PasswordsHeader } from "@/components/vault/passwords-header";
import { ConfirmDeleteDialog } from "@/components/vault/confirm-dialog";
import { Favicon } from "@/components/vault/favicon";
import { ScopeFilterSelect } from "@/components/vault/workspace-select";
import { isVaultLocked, toastApiError } from "@/components/vault/vault-utils";
import { useLocale } from "@/i18n/language";
import { api, errorMessage } from "@/lib/api";
import { useAllAgents, useSettings, useVaultStatus } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "sonner";

const GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 @3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto]";

export default function PasskeysPage() {
  const { t } = useTranslation(["vault", "common"]);
  const qc = useQueryClient();
  const sidebarScope = useUi((s) => s.workspace);
  const [scope, setScope] = useState(sidebarScope);
  useEffect(() => setScope(sidebarScope), [sidebarScope]);
  const [search, setSearch] = useState("");
  const { data: settings } = useSettings();
  const { data: vaultStatus } = useVaultStatus();
  const enabled = !!settings && settings.browser.enabled && settings.browser.passkeys;
  const vaultLocked = vaultStatus?.unlocked === false;

  const list = useQuery({ queryKey: qk.passkeyList(scope), queryFn: () => api.passkeys.list({ workspaceId: scope }) });
  const agents = useAllAgents();
  const agentName = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a.name])), [agents.data]);
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const profileName = useMemo(() => new Map((profiles.data ?? []).map((p) => [p.id, p.name])), [profiles.data]);

  const passkeys = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (list.data ?? []).filter((p) => !s || [p.rpId, p.userName, p.userDisplayName].some((v) => v.toLowerCase().includes(s)));
  }, [list.data, search]);
  const hasEntries = (list.data?.length ?? 0) > 0;

  const [toDelete, setToDelete] = useState<Passkey | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.passkeys.delete(id),
    onSuccess: (_r, id) => {
      qc.setQueriesData<Passkey[]>({ queryKey: qk.passkeys }, (old) => (Array.isArray(old) ? old.filter((p) => p.id !== id) : old));
      void qc.invalidateQueries({ queryKey: qk.passkeys });
      toast.success(t("passkeysPage.deleted"));
      setToDelete(null);
    },
    onError: (e) => toastApiError(e, t("passkeysPage.deleteFailed"), qc),
  });

  return (
    <div className="relative">
      <PasswordsHeader
        actions={
          settings && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/settings/browser">
                    <StatusDot status={enabled && !vaultLocked ? "ok" : enabled ? "warn" : "idle"} className="size-1.5" />
                    {!enabled ? t("common:status.off") : vaultLocked ? t("passkeysPage.paused") : t("passkeysPage.on")}
                    <Settings2 className="text-muted-foreground" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {!enabled ? t("passkeysPage.offHint") : vaultLocked ? t("passkeysPage.pausedHint") : t("passkeysPage.onHint")}
              </TooltipContent>
            </Tooltip>
          )
        }
      />
      <PageBody className="space-y-4">
        {(hasEntries || list.isLoading) && (
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="h-9 max-w-md min-w-56 flex-1">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("passkeysPage.searchPlaceholder")} aria-label={t("passkeysPage.searchLabel")} />
              {search && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label={t("passwordImport.clearSearch")} onClick={() => setSearch("")}>
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            <ScopeFilterSelect value={scope} onChange={setScope} />
            {list.data && (
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {t("passkeysPage.count", { count: passkeys.length })}
              </span>
            )}
          </div>
        )}

        {list.isLoading ? (
          <div className="overflow-hidden rounded-xl border bg-card shadow-card">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={cn("flex items-center gap-3 px-4 py-3", i > 0 && "border-t")}>
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : list.isError && !list.data ? (
          <EmptyState
            icon={<Lock />}
            title={isVaultLocked(list.error) ? t("cardsPage.lockedTitle") : t("passkeysPage.loadFailed")}
            description={isVaultLocked(list.error) ? t("passkeysPage.lockedDescription") : errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                {t("common:actions.tryAgain")}
              </Button>
            }
          />
        ) : !hasEntries ? (
          <EmptyState
            icon={<Fingerprint />}
            title={scope === "all" ? t("passkeysPage.emptyTitle") : t("passkeysPage.emptyScopeTitle")}
            description={t("passkeysPage.emptyDescription")}
            action={
              <Button variant="outline" asChild>
                <Link to="/browser">
                  <Globe /> {t("passkeysPage.openBrowser")}
                </Link>
              </Button>
            }
          />
        ) : passkeys.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title={t("nothingMatchesQuery", { query: search.trim() })}
            description={t("passkeysPage.noMatchDescription")}
            action={
              <Button variant="outline" onClick={() => setSearch("")}>
                {t("passwordImport.clearSearch")}
              </Button>
            }
          />
        ) : (
          <div className="@container animate-in overflow-hidden rounded-xl border bg-card shadow-card fade-in-0">
            <div className={cn(GRID, "eyebrow hidden border-b bg-paper-2 px-4 py-2 @3xl:grid")}>
              <span className="pl-12">{t("passkeysPage.columns.site")}</span>
              <span>{t("totpForm.account")}</span>
              <span>{t("totpEdit.lastUsed")}</span>
              <span>{t("passkeysPage.columns.scope")}</span>
              <span className="w-8" />
            </div>
            <ul>
              {passkeys.map((p, i) => (
                <PasskeyRow
                  key={p.id}
                  passkey={p}
                  createdBy={p.createdByAgentId ? agentName.get(p.createdByAgentId) : undefined}
                  profile={p.profileId ? profileName.get(p.profileId) : undefined}
                  first={i === 0}
                  onDelete={() => setToDelete(p)}
                />
              ))}
            </ul>
          </div>
        )}
      </PageBody>

      <ConfirmDeleteDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={toDelete?.rpId ? t("passkeysPage.deleteTitle", { site: toDelete.rpId }) : t("passkeysPage.deleteTitleGeneric")}
        description={
          <Trans
            t={t}
            i18nKey={toDelete?.userName ? "passkeysPage.deleteDescriptionUser" : "passkeysPage.deleteDescription"}
            values={{ site: toDelete?.rpId, user: toDelete?.userName }}
            components={{ strong: <strong className="text-foreground" /> }}
          />
        }
        pending={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

function PasskeyRow({
  passkey: p,
  createdBy,
  profile,
  first,
  onDelete,
}: {
  passkey: Passkey;
  createdBy?: string;
  profile?: string;
  first: boolean;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["vault", "common"]);
  const { dateLocale } = useLocale();
  const lastUsed = p.lastUsedAt ? formatDistanceToNow(new Date(p.lastUsedAt), { addSuffix: true, locale: dateLocale }) : null;
  const created = formatDistanceToNow(new Date(p.createdAt), { addSuffix: true, locale: dateLocale });
  return (
    <li className={cn(GRID, "group px-4 py-3 transition-colors hover:bg-muted/40", !first && "border-t")}>
      <div className="flex min-w-0 items-center gap-3">
        <Favicon domain={p.rpId} name={p.rpId} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{p.rpId}</div>
          <div className="truncate text-xs text-muted-foreground">
            {createdBy ? t("passkeysPage.createdBy", { when: created, agent: createdBy }) : t("passkeysPage.created", { when: created })}
            {profile ? ` · ${t("passkeysPage.profile", { name: profile })}` : ""}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground @3xl:hidden">{p.userName || p.userDisplayName || t("passkeysPage.unnamed")}</div>
        </div>
      </div>
      <div className="hidden min-w-0 @3xl:block">
        <div className="truncate text-sm">{p.userName || p.userDisplayName || <span className="text-muted-foreground italic">{t("passkeysPage.unnamed")}</span>}</div>
        {p.userDisplayName && p.userDisplayName !== p.userName && <div className="truncate text-xs text-muted-foreground">{p.userDisplayName}</div>}
      </div>
      <div className="hidden text-sm text-muted-foreground @3xl:block">{lastUsed ?? t("common:words.never")}</div>
      <div className="hidden @3xl:block">
        <ScopeBadge workspaceId={p.workspaceId} />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground opacity-60 group-hover:opacity-100 hover:text-destructive" aria-label={t("passkeysPage.deleteFor", { site: p.rpId })} onClick={onDelete}>
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("passkeysPage.delete")}</TooltipContent>
      </Tooltip>
    </li>
  );
}

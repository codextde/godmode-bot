import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { Eye, EyeOff, Keyboard, Lock, ScanQrCode, Search, SearchX, ShieldCheck, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { TotpEntry } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, PageBody } from "@/components/common";
import { PasswordsHeader } from "@/components/vault/passwords-header";
import { TotpCard, TotpCardSkeleton } from "@/components/vault/totp-card";
import { TotpEditDialog } from "@/components/vault/totp-edit-dialog";
import { TotpImportDialog } from "@/components/vault/totp-import-dialog";
import { TotpAutoLinkPanel } from "@/components/vault/totp-autolink-panel";
import { ConfirmDeleteDialog } from "@/components/vault/confirm-dialog";
import { ScopeFilterSelect } from "@/components/vault/workspace-select";
import { useTotpCodes } from "@/components/vault/use-totp-codes";
import { useNow } from "@/components/vault/use-now";
import { isVaultLocked, toastApiError } from "@/components/vault/vault-utils";
import { t as tg } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";
import { toast } from "sonner";

const HIDE_KEY = "godmode-hide-2fa-codes";

function loadHide(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export default function TotpPage() {
  const { t } = useTranslation(["vault", "common"]);
  const qc = useQueryClient();
  const sidebarScope = useUi((s) => s.workspace);
  const [scope, setScope] = useState(sidebarScope);
  useEffect(() => setScope(sidebarScope), [sidebarScope]);
  const [search, setSearch] = useState("");
  const [hideCodes, setHideCodes] = useState(loadHide);

  const list = useQuery({ queryKey: qk.totpList(scope), queryFn: () => api.totp.list({ workspaceId: scope }) });
  const hasEntries = (list.data?.length ?? 0) > 0;
  const { codes } = useTotpCodes(hasEntries);
  const now = useNow(250);
  const creds = useQuery({ queryKey: qk.credentialList("all", ""), queryFn: () => api.credentials.list({ workspaceId: "all" }), enabled: hasEntries });
  const credById = useMemo(() => new Map((creds.data ?? []).map((c) => [c.id, c])), [creds.data]);

  useEffect(() => {
    if (list.error && isVaultLocked(list.error)) toastApiError(list.error, tg("vault:passwordImport.vaultLocked"), qc);
  }, [list.error, qc]);

  const entries = useMemo(() => {
    const s = search.trim().toLowerCase();
    return [...(list.data ?? [])]
      .filter((t) => !s || t.issuer.toLowerCase().includes(s) || t.accountName.toLowerCase().includes(s))
      .sort((a, b) => a.issuer.localeCompare(b.issuer, undefined, { sensitivity: "base" }) || a.accountName.localeCompare(b.accountName));
  }, [list.data, search]);

  // Import dialog (?import=1)
  const [params, setParams] = useSearchParams();
  const [importState, setImportState] = useState<{ open: boolean; tab: "images" | "camera" | "manual" }>({ open: false, tab: "images" });
  useEffect(() => {
    if (params.get("import") === "1") setImportState({ open: true, tab: "images" });
  }, [params]);
  const setImportOpen = (open: boolean) => {
    setImportState((s) => ({ ...s, open }));
    if (!open && params.has("import")) {
      const next = new URLSearchParams(params);
      next.delete("import");
      setParams(next, { replace: true });
    }
  };

  const [editing, setEditing] = useState<{ entry: TotpEntry; focusLink: boolean } | null>(null);
  const [toDelete, setToDelete] = useState<TotpEntry | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.totp.delete(id),
    onSuccess: (_r, id) => {
      qc.setQueriesData<TotpEntry[]>({ queryKey: qk.totp }, (old) => (Array.isArray(old) ? old.filter((t) => t.id !== id) : old));
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.credentials });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      toast.success(t("totpPage.deleted"));
      setToDelete(null);
    },
    onError: (e) => toastApiError(e, t("totpPage.deleteFailed"), qc),
  });

  const toggleHide = () => {
    setHideCodes((h) => {
      try {
        localStorage.setItem(HIDE_KEY, h ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !h;
    });
  };

  const defaultWorkspaceId = scope !== "all" && scope !== "global" ? scope : null;
  const openImport = (tab: "images" | "camera" | "manual" = "images") => setImportState({ open: true, tab });

  return (
    <div className="relative">
      <PasswordsHeader
        actions={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" onClick={toggleHide} aria-pressed={hideCodes} aria-label={hideCodes ? t("totpPage.showCodes") : t("totpPage.hideCodes")}>
                  {hideCodes ? <EyeOff className="text-brand-strong" /> : <Eye />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{hideCodes ? t("totpPage.codesHidden") : t("totpPage.hideCodesHint")}</TooltipContent>
            </Tooltip>
            <Button onClick={() => openImport("images")}>
              <ScanQrCode /> {t("totpPage.importCodes")}
            </Button>
          </>
        }
      />
      <PageBody className="space-y-4">
        {(hasEntries || list.isLoading) && (
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="h-9 max-w-md min-w-56 flex-1">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("totpPage.searchPlaceholder")} aria-label={t("totpPage.searchLabel")} />
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
                {t("totpPage.count", { count: entries.length })}
              </span>
            )}
          </div>
        )}

        {hasEntries && creds.data && <TotpAutoLinkPanel entries={list.data ?? []} credById={credById} />}

        {list.isLoading ? (
          <div className="@container">
            <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <TotpCardSkeleton key={i} />
              ))}
            </div>
          </div>
        ) : list.isError && !list.data ? (
          <EmptyState
            icon={<Lock />}
            title={isVaultLocked(list.error) ? t("cardsPage.lockedTitle") : t("totpPage.loadFailed")}
            description={isVaultLocked(list.error) ? t("totpPage.lockedDescription") : errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                {t("common:actions.tryAgain")}
              </Button>
            }
          />
        ) : !hasEntries ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={scope === "all" ? t("totpPage.emptyTitle") : t("totpPage.emptyScopeTitle")}
            description={t("totpPage.emptyDescription")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => openImport("images")}>
                  <ScanQrCode /> {t("totpPage.importScreenshots")}
                </Button>
                <Button variant="outline" onClick={() => openImport("manual")}>
                  <Keyboard /> {t("totpPage.enterKey")}
                </Button>
              </div>
            }
          />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title={t("nothingMatchesQuery", { query: search.trim() })}
            description={t("totpPage.noMatchDescription")}
            action={
              <Button variant="outline" onClick={() => setSearch("")}>
                {t("passwordImport.clearSearch")}
              </Button>
            }
          />
        ) : (
          <div className="@container">
            <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
              <AnimatePresence initial={false}>
                {entries.map((entry, i) => (
                  <TotpCard
                    key={entry.id}
                    entry={entry}
                    code={codes.get(entry.id)}
                    now={now}
                    credential={entry.credentialId ? credById.get(entry.credentialId) : undefined}
                    hideCodes={hideCodes}
                    index={i}
                    onEdit={(focusLink) => setEditing({ entry, focusLink: !!focusLink })}
                    onDelete={() => setToDelete(entry)}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </PageBody>

      <TotpImportDialog open={importState.open} onOpenChange={setImportOpen} defaultWorkspaceId={defaultWorkspaceId} initialTab={importState.tab} />
      <TotpEditDialog entry={editing?.entry ?? null} focusLink={editing?.focusLink} onOpenChange={(o) => !o && setEditing(null)} />
      <ConfirmDeleteDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={toDelete?.issuer ? t("totpPage.deleteTitle", { name: toDelete.issuer }) : t("totpPage.deleteTitleGeneric")}
        description={
          <Trans
            t={t}
            i18nKey="totpPage.deleteDescription"
            values={{ name: toDelete?.accountName || toDelete?.issuer }}
            components={{ strong: <strong className="text-foreground" /> }}
          />
        }
        pending={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

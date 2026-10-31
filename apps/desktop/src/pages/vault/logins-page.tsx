import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Bot, FileKey, KeyRound, Lock, Plus, ScrollText, Search, SearchX, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { Credential, TotpEntry } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { EmptyState, Kbd, PageBody } from "@/components/common";
import { usePageScroll } from "@/components/layout/page-scroll";
import { CredentialDialog, type CredentialPrefill } from "@/components/vault/credential-dialog";
import { CREDENTIAL_GRID, CredentialRow } from "@/components/vault/credential-row";
import { ConfirmDeleteDialog } from "@/components/vault/confirm-dialog";
import { PasswordImportDialog } from "@/components/vault/password-import-dialog";
import { PasswordsHeader } from "@/components/vault/passwords-header";
import { ScopeFilterSelect } from "@/components/vault/workspace-select";
import { useDebouncedValue } from "@/components/vault/use-debounced-value";
import { isVaultLocked, toastApiError } from "@/components/vault/vault-utils";
import { t as tg } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const PREFILL_PARAMS = ["new", "domain", "service", "missingLoginId"];
const byName = new Intl.Collator(undefined, { sensitivity: "base" });

export default function LoginsPage() {
  const { t } = useTranslation(["vault", "common"]);
  const qc = useQueryClient();
  const sidebarScope = useUi((s) => s.workspace);
  const [scope, setScope] = useState(sidebarScope);
  useEffect(() => setScope(sidebarScope), [sidebarScope]);

  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim(), 250);
  const searchRef = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: qk.credentialList(scope, q),
    queryFn: () => api.credentials.list({ workspaceId: scope, search: q || undefined }),
    placeholderData: keepPreviousData,
  });
  const totps = useQuery({ queryKey: qk.totpList("all"), queryFn: () => api.totp.list({ workspaceId: "all" }) });
  const totpById = useMemo(() => new Map((totps.data ?? []).map((t) => [t.id, t])), [totps.data]);

  useEffect(() => {
    if (list.error && isVaultLocked(list.error)) toastApiError(list.error, tg("vault:passwordImport.vaultLocked"), qc);
  }, [list.error, qc]);

  const credentials = useMemo(() => [...(list.data ?? [])].sort((a, b) => byName.compare(a.name, b.name)), [list.data]);

  // Dialog state (+ deep links: ?new=1, ?domain=&service=&missingLoginId=)
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<{ open: boolean; credential: Credential | null; prefill?: CredentialPrefill }>({ open: false, credential: null });
  useEffect(() => {
    const domain = params.get("domain") ?? undefined;
    const service = params.get("service") ?? undefined;
    const missingLoginId = params.get("missingLoginId") ?? undefined;
    if (params.get("new") === "1" || domain || service || missingLoginId) {
      setDialog({ open: true, credential: null, prefill: { domain, service, missingLoginId } });
    }
  }, [params]);

  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    if (params.get("import") === "1") setImportOpen(true);
  }, [params]);
  const changeImportOpen = (open: boolean) => {
    setImportOpen(open);
    if (!open && params.has("import")) {
      const next = new URLSearchParams(params);
      next.delete("import");
      setParams(next, { replace: true });
    }
  };

  const closeDialog = (open: boolean) => {
    if (open) return;
    setDialog((d) => ({ ...d, open: false }));
    if (PREFILL_PARAMS.some((p) => params.has(p))) {
      const next = new URLSearchParams(params);
      for (const p of PREFILL_PARAMS) next.delete(p);
      setParams(next, { replace: true });
    }
  };

  const [toDelete, setToDelete] = useState<Credential | null>(null);
  const openEdit = useCallback((credential: Credential) => setDialog({ open: true, credential }), []);
  const del = useMutation({
    mutationFn: (id: string) => api.credentials.delete(id),
    onSuccess: (_r, id) => {
      qc.setQueriesData<Credential[]>({ queryKey: qk.credentials }, (old) => (Array.isArray(old) ? old.filter((c) => c.id !== id) : old));
      void qc.invalidateQueries({ queryKey: qk.credentials });
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      toast.success(t("loginsPage.deleted"));
      setToDelete(null);
    },
    onError: (e) => toastApiError(e, t("loginsPage.deleteFailed"), qc),
  });

  // "/" focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const defaultWorkspaceId = scope !== "all" && scope !== "global" ? scope : null;
  const openCreate = () => setDialog({ open: true, credential: null });
  const isFiltered = !!q || scope !== "all";

  return (
    <div className="relative">
      <PasswordsHeader
        actions={
          <>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <FileKey /> {t("totpImport.import")}
            </Button>
            <Button onClick={openCreate}>
              <Plus /> {t("credential.addTitle")}
            </Button>
          </>
        }
      />
      <PageBody className="space-y-4">
        <TrustStrip />

        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="h-9 max-w-md min-w-56 flex-1">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("loginsPage.searchPlaceholder")} aria-label={t("loginsPage.searchLabel")} />
            <InputGroupAddon align="inline-end">
              {search ? (
                <InputGroupButton size="icon-xs" aria-label={t("passwordImport.clearSearch")} onClick={() => setSearch("")}>
                  <X />
                </InputGroupButton>
              ) : (
                <Kbd>/</Kbd>
              )}
            </InputGroupAddon>
          </InputGroup>
          <ScopeFilterSelect value={scope} onChange={setScope} />
          {list.data && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {t("loginsPage.count", { count: credentials.length })}
            </span>
          )}
        </div>

        {list.isLoading ? (
          <ListSkeleton />
        ) : list.isError && !list.data ? (
          <EmptyState
            icon={<Lock />}
            title={isVaultLocked(list.error) ? t("cardsPage.lockedTitle") : t("loginsPage.loadFailed")}
            description={isVaultLocked(list.error) ? t("loginsPage.lockedDescription") : errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                {t("common:actions.tryAgain")}
              </Button>
            }
          />
        ) : credentials.length === 0 ? (
          isFiltered ? (
            <EmptyState
              icon={<SearchX />}
              title={q ? t("loginsPage.noMatch", { query: q }) : t("loginsPage.emptyScopeTitle")}
              description={q ? t("loginsPage.noMatchDescription") : t("loginsPage.emptyScopeDescription")}
              action={
                <div className="flex gap-2">
                  {q && (
                    <Button variant="outline" onClick={() => setSearch("")}>
                      {t("passwordImport.clearSearch")}
                    </Button>
                  )}
                  <Button onClick={openCreate}>
                    <Plus /> {t("credential.addTitle")}
                  </Button>
                </div>
              }
            />
          ) : (
            <EmptyState
              icon={<KeyRound />}
              title={t("loginsPage.emptyTitle")}
              description={t("loginsPage.emptyDescription")}
              action={
                <div className="flex flex-col items-center gap-3">
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setImportOpen(true)}>
                      <FileKey /> {t("loginsPage.importFrom")}
                    </Button>
                    <Button variant="outline" onClick={openCreate}>
                      <Plus /> {t("loginsPage.addFirst")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <Trans
                      t={t}
                      i18nKey="loginsPage.missingHint"
                      components={{ link: <Link to="/inbox" className="text-foreground underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground" /> }}
                    />
                  </p>
                </div>
              }
            />
          )
        ) : (
          <div className={cn("@container full-motion:animate-in overflow-hidden rounded-xl border bg-card shadow-card transition-opacity full-motion:fade-in-0", list.isFetching && list.isPlaceholderData && "opacity-70")}>
            <div className={cn(CREDENTIAL_GRID, "eyebrow hidden border-b bg-paper-2 px-4 py-2 @3xl:grid")}>
              <span className="pl-12">{t("passwordImport.columns.login")}</span>
              <span>{t("passwordImport.columns.username")}</span>
              <span>{t("credential.password")}</span>
              <span>{t("passkeysPage.columns.scope")}</span>
              <span className="w-8" />
            </div>
            <CredentialList credentials={credentials} totpById={totpById} onEdit={openEdit} onDelete={setToDelete} />
          </div>
        )}
      </PageBody>

      <PasswordImportDialog open={importOpen} onOpenChange={changeImportOpen} defaultWorkspaceId={defaultWorkspaceId} />
      <CredentialDialog open={dialog.open} onOpenChange={closeDialog} credential={dialog.credential} prefill={dialog.prefill} defaultWorkspaceId={defaultWorkspaceId} />

      <ConfirmDeleteDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={t("deleteTitle", { name: toDelete?.name })}
        description={t("loginsPage.deleteDescription")}
        pending={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

function CredentialList({
  credentials,
  totpById,
  onEdit,
  onDelete,
}: {
  credentials: Credential[];
  totpById: Map<string, TotpEntry>;
  onEdit: (credential: Credential) => void;
  onDelete: (credential: Credential) => void;
}) {
  const scrollEl = usePageScroll();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!scrollEl || !list) return;
    const measure = () => setScrollMargin(list.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scrollEl.firstElementChild ?? scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]);

  // Keep the row holding focus mounted while it is scrolled out of view.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIndex = useMemo(() => (focusedId ? credentials.findIndex((c) => c.id === focusedId) : -1), [credentials, focusedId]);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      return focusedIndex < 0 || indexes.includes(focusedIndex) ? indexes : [...indexes, focusedIndex].sort((a, b) => a - b);
    },
    [focusedIndex],
  );
  const getItemKey = useCallback((i: number) => credentials[i].id, [credentials]);

  const virtualizer = useVirtualizer({
    count: credentials.length,
    getScrollElement: () => scrollEl,
    getItemKey,
    rangeExtractor,
    estimateSize: () => 68,
    overscan: 8,
    scrollMargin,
  });

  return (
    <div
      ref={listRef}
      role="list"
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
      onFocus={(e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
        setFocusedId(row ? (credentials[Number(row.dataset.index)]?.id ?? null) : null);
      }}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocusedId(null)}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const c = credentials[item.index];
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            role="listitem"
            aria-posinset={item.index + 1}
            aria-setsize={credentials.length}
            data-index={item.index}
            className={cn("absolute inset-x-0 top-0", item.index > 0 && "border-t")}
            style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            <CredentialRow credential={c} totp={c.totpId ? totpById.get(c.totpId) : undefined} onEdit={onEdit} onDelete={onDelete} />
          </div>
        );
      })}
    </div>
  );
}

function TrustStrip() {
  const { t } = useTranslation("vault");
  const items = [
    { icon: <Lock />, title: t("cardsPage.trust.encryptedTitle"), text: t("cardsPage.trust.encryptedText") },
    { icon: <Bot />, title: t("loginsPage.trust.hiddenTitle"), text: t("loginsPage.trust.hiddenText") },
    { icon: <ScrollText />, title: t("loginsPage.trust.auditedTitle"), text: t("loginsPage.trust.auditedText") },
  ];
  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border shadow-card @3xl:grid-cols-3">
      {items.map((it) => (
        <div key={it.title} className="flex items-start gap-3 bg-card px-4 py-3">
          <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-brand-soft text-brand-strong [&_svg]:size-4">{it.icon}</div>
          <div className="min-w-0">
            <p className="text-xs font-medium">{it.title}</p>
            <p className="text-[11px] leading-snug text-muted-foreground">{it.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b px-4 py-3 last:border-0">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="hidden h-3.5 w-32 @3xl:block" />
          <Skeleton className="hidden h-3.5 w-24 @3xl:block" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      ))}
    </div>
  );
}

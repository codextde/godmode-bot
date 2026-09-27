import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, FileKey, KeyRound, Lock, Plus, ScrollText, Search, SearchX, X } from "lucide-react";
import type { Credential, TotpEntry } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { EmptyState, Kbd, PageBody, PageHeader } from "@/components/common";
import { usePageScroll } from "@/components/layout/page-scroll";
import { CredentialDialog, type CredentialPrefill } from "@/components/vault/credential-dialog";
import { CREDENTIAL_GRID, CredentialRow } from "@/components/vault/credential-row";
import { ConfirmDeleteDialog } from "@/components/vault/confirm-dialog";
import { PasswordImportDialog } from "@/components/vault/password-import-dialog";
import { ScopeFilterSelect } from "@/components/vault/workspace-select";
import { useDebouncedValue } from "@/components/vault/use-debounced-value";
import { isVaultLocked, toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const PREFILL_PARAMS = ["new", "domain", "service", "missingLoginId"];
const byName = new Intl.Collator(undefined, { sensitivity: "base" });

export default function LoginsPage() {
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
    if (list.error && isVaultLocked(list.error)) toastApiError(list.error, "Vault locked", qc);
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
      toast.success("Login deleted");
      setToDelete(null);
    },
    onError: (e) => toastApiError(e, "Could not delete login", qc),
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
      <PageHeader
        icon={<KeyRound />}
        title="Logins"
        description="Website logins your agents can use — encrypted in your local vault."
        actions={
          <>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <FileKey /> Import
            </Button>
            <Button onClick={openCreate}>
              <Plus /> Add login
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
            <InputGroupInput ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search logins, usernames, domains…" aria-label="Search logins" />
            <InputGroupAddon align="inline-end">
              {search ? (
                <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch("")}>
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
              {credentials.length} {credentials.length === 1 ? "login" : "logins"}
            </span>
          )}
        </div>

        {list.isLoading ? (
          <ListSkeleton />
        ) : list.isError && !list.data ? (
          <EmptyState
            icon={<Lock />}
            title={isVaultLocked(list.error) ? "The vault is locked" : "Couldn't load logins"}
            description={isVaultLocked(list.error) ? "Unlock the vault to see your logins." : errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                Try again
              </Button>
            }
          />
        ) : credentials.length === 0 ? (
          isFiltered ? (
            <EmptyState
              icon={<SearchX />}
              title={q ? `No logins match “${q}”` : "No logins in this scope"}
              description={q ? "Try another name, username or domain." : "Logins saved as Global are available everywhere — switch the scope filter to see them."}
              action={
                <div className="flex gap-2">
                  {q && (
                    <Button variant="outline" onClick={() => setSearch("")}>
                      Clear search
                    </Button>
                  )}
                  <Button onClick={openCreate}>
                    <Plus /> Add login
                  </Button>
                </div>
              }
            />
          ) : (
            <EmptyState
              icon={<KeyRound />}
              title="Your vault is ready for logins"
              description="Add the website logins your agents need. They're encrypted on this device and typed into the browser for the agent — the AI never sees them."
              action={
                <div className="flex flex-col items-center gap-3">
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setImportOpen(true)}>
                      <FileKey /> Import from Chrome or 1Password
                    </Button>
                    <Button variant="outline" onClick={openCreate}>
                      <Plus /> Add a login
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    When an agent hits a login it doesn't have, it lands in your{" "}
                    <Link to="/inbox" className="text-foreground underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground">
                      Inbox
                    </Link>
                    .
                  </p>
                </div>
              }
            />
          )
        ) : (
          <div className={cn("@container animate-in overflow-hidden rounded-xl border bg-card shadow-card transition-opacity fade-in-0", list.isFetching && list.isPlaceholderData && "opacity-70")}>
            <div className={cn(CREDENTIAL_GRID, "eyebrow hidden border-b bg-paper-2 px-4 py-2 @3xl:grid")}>
              <span className="pl-12">Login</span>
              <span>Username</span>
              <span>Password</span>
              <span>Scope</span>
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
        title={`Delete “${toDelete?.name}”?`}
        description="The login is removed from the vault. Agents that rely on it will report a missing login in your Inbox the next time they need it."
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

  const virtualizer = useVirtualizer({
    count: credentials.length,
    getScrollElement: () => scrollEl,
    getItemKey: (i) => credentials[i].id,
    estimateSize: () => 68,
    overscan: 8,
    scrollMargin,
  });

  return (
    <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const c = credentials[item.index];
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
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
  const items = [
    { icon: <Lock />, title: "Encrypted on this device", text: "AES-256-GCM, unlocked by your vault passphrase." },
    { icon: <Bot />, title: "Agents never see passwords", text: "Godmode types them into the browser for the agent." },
    { icon: <ScrollText />, title: "Every use is audited", text: "See who used what in Settings → Security." },
  ];
  return (
    <div className="grid gap-px overflow-hidden rounded-xl border bg-border shadow-card sm:grid-cols-3">
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
          <Skeleton className="hidden h-3.5 w-32 md:block" />
          <Skeleton className="hidden h-3.5 w-24 md:block" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      ))}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { Eye, EyeOff, Keyboard, Lock, ScanQrCode, Search, SearchX, ShieldCheck, X } from "lucide-react";
import type { TotpEntry } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { TotpCard, TotpCardSkeleton } from "@/components/vault/totp-card";
import { TotpEditDialog } from "@/components/vault/totp-edit-dialog";
import { TotpImportDialog } from "@/components/vault/totp-import-dialog";
import { ConfirmDeleteDialog } from "@/components/vault/confirm-dialog";
import { ScopeFilterSelect } from "@/components/vault/workspace-select";
import { useTotpCodes } from "@/components/vault/use-totp-codes";
import { useNow } from "@/components/vault/use-now";
import { isVaultLocked, toastApiError } from "@/components/vault/vault-utils";
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
    if (list.error && isVaultLocked(list.error)) toastApiError(list.error, "Vault locked", qc);
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
      toast.success("2FA code deleted");
      setToDelete(null);
    },
    onError: (e) => toastApiError(e, "Could not delete 2FA code", qc),
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
      <PageHeader
        icon={<ShieldCheck />}
        title="2FA Codes"
        description="Authenticator codes your agents type in during sign-in — so two-factor never needs you."
        actions={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" onClick={toggleHide} aria-pressed={hideCodes} aria-label={hideCodes ? "Show codes" : "Hide codes"}>
                  {hideCodes ? <EyeOff className="text-brand-strong" /> : <Eye />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{hideCodes ? "Codes hidden — hover a card to peek" : "Hide codes (privacy mode)"}</TooltipContent>
            </Tooltip>
            <Button onClick={() => openImport("images")}>
              <ScanQrCode /> Import codes
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
              <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search services or accounts…" aria-label="Search 2FA codes" />
              {search && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch("")}>
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            <ScopeFilterSelect value={scope} onChange={setScope} />
            {list.data && (
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {entries.length} {entries.length === 1 ? "code" : "codes"}
              </span>
            )}
          </div>
        )}

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
            title={isVaultLocked(list.error) ? "The vault is locked" : "Couldn't load 2FA codes"}
            description={isVaultLocked(list.error) ? "Unlock the vault to see your codes." : errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                Try again
              </Button>
            }
          />
        ) : !hasEntries ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={scope === "all" ? "No 2FA codes yet" : "No 2FA codes in this scope"}
            description="Import your authenticator codes so agents can finish two-factor sign-ins without pinging you. Moving from Google Authenticator takes about a minute."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => openImport("images")}>
                  <ScanQrCode /> Import from screenshots
                </Button>
                <Button variant="outline" onClick={() => openImport("manual")}>
                  <Keyboard /> Enter a setup key
                </Button>
              </div>
            }
          />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title={`Nothing matches “${search.trim()}”`}
            description="Try another service or account name."
            action={
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            }
          />
        ) : (
          <div className="@container">
            <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
              <AnimatePresence initial={false}>
                {entries.map((t, i) => (
                  <TotpCard
                    key={t.id}
                    entry={t}
                    code={codes.get(t.id)}
                    now={now}
                    credential={t.credentialId ? credById.get(t.credentialId) : undefined}
                    hideCodes={hideCodes}
                    index={i}
                    onEdit={(focusLink) => setEditing({ entry: t, focusLink: !!focusLink })}
                    onDelete={() => setToDelete(t)}
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
        title={`Delete 2FA for ${toDelete?.issuer ?? "this account"}?`}
        description={
          <>
            Agents won't be able to complete two-factor sign-in for{" "}
            <strong className="text-foreground">{toDelete?.accountName || toDelete?.issuer}</strong> anymore. To add it back you'll need the QR code from the
            service or your authenticator app. Make sure you still have another way to sign in.
          </>
        }
        pending={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

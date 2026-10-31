import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Fingerprint, Globe, Lock, Search, SearchX, Settings2, Trash2, X } from "lucide-react";
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
import { api, errorMessage } from "@/lib/api";
import { useAllAgents, useSettings, useVaultStatus } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "sonner";

const GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 @3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto]";

export default function PasskeysPage() {
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
      toast.success("Passkey deleted");
      setToDelete(null);
    },
    onError: (e) => toastApiError(e, "Could not delete passkey", qc),
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
                    {!enabled ? "Off" : vaultLocked ? "Paused, vault locked" : "On in the browser"}
                    <Settings2 className="text-muted-foreground" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {!enabled ? "Chrome's own passkey dialogs are used instead" : vaultLocked ? "Unlock the vault to use passkeys in the browser" : "Each browser profile signs in with its own passkeys"}
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
              <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sites or accounts…" aria-label="Search passkeys" />
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
                {passkeys.length} {passkeys.length === 1 ? "passkey" : "passkeys"}
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
            title={isVaultLocked(list.error) ? "The vault is locked" : "Couldn't load passkeys"}
            description={isVaultLocked(list.error) ? "Unlock the vault to see your passkeys." : errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                Try again
              </Button>
            }
          />
        ) : !hasEntries ? (
          <EmptyState
            icon={<Fingerprint />}
            title={scope === "all" ? "No passkeys yet" : "No passkeys in this scope"}
            description="When a site in Godmode's browser offers to create a passkey — for an agent, or for you in the live view — it's saved here, sealed in the vault. From then on agents sign in with it by themselves."
            action={
              <Button variant="outline" asChild>
                <Link to="/browser">
                  <Globe /> Open the browser
                </Link>
              </Button>
            }
          />
        ) : passkeys.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title={`Nothing matches “${search.trim()}”`}
            description="Try another site or account name."
            action={
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            }
          />
        ) : (
          <div className="@container overflow-hidden rounded-xl border bg-card shadow-card">
            <div className={cn(GRID, "eyebrow hidden border-b bg-paper-2 px-4 py-2 @3xl:grid")}>
              <span className="pl-12">Site</span>
              <span>Account</span>
              <span>Last used</span>
              <span>Scope</span>
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
        title={`Delete the passkey for ${toDelete?.rpId ?? "this site"}?`}
        description={
          <>
            Agents won't be able to sign in to <strong className="text-foreground">{toDelete?.rpId}</strong>
            {toDelete?.userName ? (
              <>
                {" "}
                as <strong className="text-foreground">{toDelete.userName}</strong>
              </>
            ) : null}{" "}
            with it anymore. The site still lists it until you remove it there too. Make sure the account has another way to sign in.
          </>
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
  const lastUsed = p.lastUsedAt ? formatDistanceToNow(new Date(p.lastUsedAt), { addSuffix: true }) : null;
  const created = formatDistanceToNow(new Date(p.createdAt), { addSuffix: true });
  return (
    <li className={cn(GRID, "group px-4 py-3 transition-colors hover:bg-muted/40", !first && "border-t")}>
      <div className="flex min-w-0 items-center gap-3">
        <Favicon domain={p.rpId} name={p.rpId} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{p.rpId}</div>
          <div className="truncate text-xs text-muted-foreground">
            Created {created}
            {createdBy ? ` by ${createdBy}` : ""}
            {profile ? ` · ${profile} profile` : ""}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground @3xl:hidden">{p.userName || p.userDisplayName || "Unnamed account"}</div>
        </div>
      </div>
      <div className="hidden min-w-0 @3xl:block">
        <div className="truncate text-sm">{p.userName || p.userDisplayName || <span className="text-muted-foreground italic">Unnamed account</span>}</div>
        {p.userDisplayName && p.userDisplayName !== p.userName && <div className="truncate text-xs text-muted-foreground">{p.userDisplayName}</div>}
      </div>
      <div className="hidden text-sm text-muted-foreground @3xl:block">{lastUsed ?? "Never"}</div>
      <div className="hidden @3xl:block">
        <ScopeBadge workspaceId={p.workspaceId} />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground opacity-60 group-hover:opacity-100 hover:text-destructive" aria-label={`Delete passkey for ${p.rpId}`} onClick={onDelete}>
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete passkey</TooltipContent>
      </Tooltip>
    </li>
  );
}

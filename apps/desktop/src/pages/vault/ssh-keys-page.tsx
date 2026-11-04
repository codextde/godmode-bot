import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Key, Plus, RefreshCw, Search, SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SshKeysOverview, SshManagedKey, SshServer } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PageBody, StatusDot } from "@/components/common";
import { ConfirmDeleteDialog } from "@/components/vault/confirm-dialog";
import { PasswordsHeader } from "@/components/vault/passwords-header";
import { EditKeyDialog, GenerateKeyDialog, ImportKeyDialog, PassphraseDialog } from "@/components/vault/ssh-key-dialogs";
import { SshKeyRow, type SshKeyActions } from "@/components/vault/ssh-key-row";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { useSettings, useSshServers } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { toast } from "sonner";

const NO_SERVERS: SshServer[] = [];

export default function SshKeysPage() {
  const { t } = useTranslation(["vault", "common"]);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: qk.sshKeys, queryFn: api.sshKeys.list, refetchOnWindowFocus: true });
  const { data: settings } = useSettings();
  const sshOn = !!settings?.ssh.enabled;
  const serverList = useSshServers();
  const servers = sshOn ? (serverList.data ?? NO_SERVERS) : NO_SERVERS;

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<SshManagedKey | null>(null);
  const [deleting, setDeleting] = useState<SshManagedKey | null>(null);
  const [unlocking, setUnlocking] = useState<SshManagedKey | null>(null);

  const keys = useMemo(() => list.data?.keys ?? [], [list.data]);
  const taken = useMemo(() => keys.map((k) => k.name), [keys]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q ? keys.filter((k) => [k.name, k.comment, k.fingerprint ?? "", ...k.hosts].some((v) => v.toLowerCase().includes(q))) : keys;
    return [...hits].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }, [keys, query]);

  const refresh = () => void qc.invalidateQueries({ queryKey: qk.sshKeys });
  const patchCache = (name: string, patch: Partial<SshManagedKey>) =>
    qc.setQueryData<SshKeysOverview>(qk.sshKeys, (old) => (old ? { ...old, keys: old.keys.map((k) => (k.name === name ? { ...k, ...patch } : k)) } : old));

  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: SshManagedKey; enabled: boolean }) => api.sshKeys.update(key.name, { enabled }),
    onMutate: ({ key, enabled }) => patchCache(key.name, { enabled }),
    onSettled: refresh,
    onError: (e) => toastApiError(e, t("sshKeys.changeFailed"), qc),
  });
  const fix = useMutation({
    mutationFn: (key: SshManagedKey) => api.sshKeys.update(key.name, { fixPermissions: true }),
    onSuccess: refresh,
    onError: (e) => toastApiError(e, t("sshKeys.changeFailed"), qc),
  });
  const load = useMutation({
    mutationFn: ({ key, loaded }: { key: SshManagedKey; loaded: boolean }) => api.sshKeys.setLoaded(key.name, loaded),
    onMutate: ({ key, loaded }) => {
      if (!(loaded && key.encrypted)) patchCache(key.name, { inAgent: loaded });
    },
    onError: (e, { key }) => {
      if (e instanceof ApiRequestError && e.code === "ssh_key_passphrase_required") setUnlocking(key);
      else toastApiError(e, t("sshKeys.changeFailed"), qc);
    },
    onSettled: refresh,
  });
  const install = useMutation({
    mutationFn: ({ key, server }: { key: SshManagedKey; server: SshServer }) => api.sshKeys.install(key.name, server.id),
    onSuccess: (out, { key }) => toast.success(out.alreadyThere ? t("sshKeys.alreadyOnServer", { name: key.name, server: out.server }) : t("sshKeys.addedToServer", { name: key.name, server: out.server })),
    onError: (e) => toast.error(t("sshKeys.addToServerFailed"), { description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: (key: SshManagedKey) => api.sshKeys.delete(key.name),
    onSuccess: (_r, key) => {
      refresh();
      setDeleting(null);
      if (openKey === key.name) setOpenKey(null);
      toast.success(t("sshKeys.deleted", { name: key.name }));
    },
    onError: (e) => toastApiError(e, t("sshKeys.deleteFailed"), qc),
  });

  const actions: SshKeyActions = useMemo(
    () => ({
      toggle: (key, enabled) => toggle.mutate({ key, enabled }),
      setLoaded: (key, loaded) => load.mutate({ key, loaded }),
      fixPermissions: (key) => fix.mutate(key),
      install: (key, server) => {
        const pending = toast.loading(t("sshKeys.addingToServer", { server: server.name }));
        install.mutate({ key, server }, { onSettled: () => toast.dismiss(pending) });
      },
      edit: setEditing,
      remove: setDeleting,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const created = (key: SshManagedKey) => {
    setOpenKey(key.name);
    setQuery("");
  };
  const agent = list.data?.agent;
  const place = list.data?.dir.replace(/^\/(?:Users|home)\/[^/]+/, "~") ?? "";

  return (
    <div className="relative">
      <PasswordsHeader
        actions={
          <>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp /> {t("sshKeys.import")}
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("sshKeys.newKey")}
            </Button>
          </>
        }
      />
      <PageBody className="space-y-3">
        {list.isLoading ? (
          <div className="overflow-hidden rounded-xl border bg-card shadow-card">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b px-4 py-3.5 last:border-b-0">
                <Skeleton className="h-7 w-10 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-5 w-8 rounded-full" />
              </div>
            ))}
          </div>
        ) : list.isError ? (
          <EmptyState
            icon={<Key />}
            title={t("sshKeys.loadError")}
            description={errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                <RefreshCw /> {t("common:actions.tryAgain")}
              </Button>
            }
          />
        ) : keys.length === 0 ? (
          <EmptyState
            icon={<Key />}
            title={t("sshKeys.emptyTitle")}
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus /> {t("sshKeys.newKey")}
              </Button>
            }
          />
        ) : (
          <>
            {keys.length > 6 && (
              <InputGroup className="h-9 max-w-xs">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("sshKeys.search")} aria-label={t("sshKeys.search")} spellCheck={false} />
              </InputGroup>
            )}
            {shown.length === 0 ? (
              <EmptyState icon={<SearchX />} title={t("nothingMatchesQuery", { query: query.trim() })} />
            ) : (
              <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
                {shown.map((key) => (
                  <SshKeyRow key={key.name} sshKey={key} open={openKey === key.name} onOpenChange={setOpenKey} agentAvailable={!!agent?.available} servers={servers} actions={actions} />
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
              <span className="font-mono">{place}</span>
              <span className="flex items-center gap-1.5">
                <StatusDot status={agent?.available ? "ok" : "idle"} />
                {agent?.available ? t("sshKeys.agentLoaded", { count: agent.loaded }) : t("sshKeys.agentOff")}
              </span>
            </div>
          </>
        )}
      </PageBody>

      <GenerateKeyDialog open={creating} onOpenChange={setCreating} taken={taken} onDone={created} />
      <ImportKeyDialog open={importing} onOpenChange={setImporting} taken={taken} onDone={created} />
      <EditKeyDialog
        sshKey={editing}
        taken={taken}
        onClose={() => setEditing(null)}
        onDone={({ key, configHosts }) => {
          setOpenKey(key.name);
          toast.success(t("sshKeys.saved"), configHosts.length ? { description: t("sshKeys.configUpdated", { hosts: configHosts.join(", ") }) } : undefined);
        }}
      />
      <PassphraseDialog sshKey={unlocking} onClose={() => setUnlocking(null)} />
      <ConfirmDeleteDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t("sshKeys.deleteTitle", { name: deleting?.name ?? "" })}
        description={deleting && deleting.hosts.length + deleting.servers.length > 0 ? t("sshKeys.deleteBodyUsed", { used: [...deleting.hosts, ...deleting.servers.map((s) => s.name)].join(", ") }) : t("sshKeys.deleteBody")}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

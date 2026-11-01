import { useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { Trans, useTranslation } from "react-i18next";
import {
  Copy,
  EllipsisVertical,
  ExternalLink,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { parseGitUrl, type WorkspaceSource, type WorkspaceSourceInput } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RUNNER_STATE_LABEL, RunnerStateDot } from "@/components/runners/runner-parts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FolderPickerDialog, folderName, useShortPath } from "@/components/chat/folder-picker";
import { copyText } from "@/components/chat/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { dateLocale, t as translate } from "@/i18n";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { isMac, openExternal } from "@/lib/desktop";
import { useBootstrap, useRunners, useSshServers, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export function toSourceInput(s: WorkspaceSource): WorkspaceSourceInput {
  if (s.kind === "remote") return { kind: "remote", serverId: s.serverId ?? "", path: s.path };
  return s.kind === "folder" ? { kind: "folder", path: s.path } : { kind: "git", url: s.url ?? "", branch: s.branch };
}

function sameSource(a: WorkspaceSourceInput, b: WorkspaceSource): boolean {
  if (a.kind === "remote") return b.kind === "remote" && b.serverId === a.serverId && b.path === a.path;
  if (a.kind === "folder") return b.kind === "folder" && b.path === a.path;
  return b.kind === "git" && b.url === a.url && (b.branch ?? null) === (a.branch ?? null);
}

function keyOf(s: WorkspaceSourceInput): string {
  if (s.kind === "remote") return `remote:${s.serverId}:${s.path}`;
  return s.kind === "folder" ? `folder:${s.path}` : `git:${s.url}#${s.branch ?? ""}`;
}

function remoteName(path: string): string {
  return path === "~" ? "~" : (path.split("/").filter(Boolean).pop() ?? path);
}

/** "github.com/owner/repo" for display. */
export function displayUrl(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/i, "");
}

function webUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url.replace(/\.git$/i, "") : null;
}

async function revealInFileManager(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch {
    toast.error(isMac ? translate("workspaces:sources.openFinderFailed") : translate("workspaces:sources.openFileManagerFailed"));
  }
}

/**
 * Folders and repositories of a workspace, edited as part of the workspace form: changes apply when it is saved.
 * Live state (clone progress, commit, errors) comes from the saved workspace.
 */
export function WorkspaceSourcesField({
  workspaceId,
  projectId = null,
  value,
  onChange,
}: {
  workspaceId: string | null;
  /** The sources are a project's (of `workspaceId`); null = the workspace's own. */
  projectId?: string | null;
  value: WorkspaceSourceInput[];
  onChange: (next: WorkspaceSourceInput[]) => void;
}) {
  const { t } = useTranslation("workspaces");
  const { data: workspaces } = useWorkspaces();
  const workspace = workspaceId ? workspaces?.find((w) => w.id === workspaceId) : undefined;
  const saved = (projectId ? workspace?.projects.find((p) => p.id === projectId)?.sources : workspace?.sources) ?? [];
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<"git" | "remote" | null>(null);
  const { data: boot } = useBootstrap();
  const sshOn = !!boot?.settings.ssh.enabled;

  const add = (source: WorkspaceSourceInput) => {
    if (value.some((s) => keyOf(s) === keyOf(source))) {
      toast.info(source.kind === "git" ? t("sources.repoAttached") : t("sources.folderAttached"));
      return;
    }
    onChange([...value, source]);
  };
  const remove = (source: WorkspaceSourceInput) => onChange(value.filter((s) => keyOf(s) !== keyOf(source)));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          <AnimatePresence initial={false}>
            {value.map((source) => (
              <motion.li
                key={keyOf(source)}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <SourceRow workspaceId={workspaceId} projectId={projectId} source={source} live={saved.find((s) => sameSource(source, s))} onRemove={() => remove(source)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <AnimatePresence initial={false}>
        {adding && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>
            {adding === "git" ? (
              <AddRepository
                onAdd={(s) => {
                  add(s);
                  setAdding(null);
                }}
                onCancel={() => setAdding(null)}
              />
            ) : (
              <AddRemoteFolder
                onAdd={(s) => {
                  add(s);
                  setAdding(null);
                }}
                onCancel={() => setAdding(null)}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {value.length === 0 && !adding ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-5 text-center">
          <div className="flex -space-x-1.5">
            <span className="grid size-8 place-items-center rounded-lg border bg-card text-muted-foreground shadow-xs">
              <Folder className="size-4" />
            </span>
            <span className="grid size-8 place-items-center rounded-lg border bg-card text-muted-foreground shadow-xs">
              <FolderGit2 className="size-4" />
            </span>
          </div>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            {t("sources.emptyHint")}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
              <FolderOpen /> {t("sources.addFolder")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding("git")}>
              <FolderGit2 /> {t("sources.addRepository")}
            </Button>
            {sshOn && (
              <Button type="button" variant="outline" size="sm" onClick={() => setAdding("remote")}>
                <Server /> {t("sources.addRemote")}
              </Button>
            )}
          </div>
        </div>
      ) : (
        !adding && (
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPicking(true)}>
              <Plus /> {t("sources.folder")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setAdding("git")}>
              <Plus /> {t("sources.repository")}
            </Button>
            {sshOn && (
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setAdding("remote")}>
                <Plus /> {t("sources.remote")}
              </Button>
            )}
          </div>
        )
      )}

      <FolderPickerDialog
        open={picking}
        onOpenChange={setPicking}
        value={null}
        onPick={(path) => add({ kind: "folder", path })}
        title={t("sources.pickerTitle")}
        description={t("sources.pickerDescription")}
      />
    </div>
  );
}

function SourceRow({
  workspaceId,
  projectId,
  source,
  live,
  onRemove,
}: {
  workspaceId: string | null;
  projectId: string | null;
  source: WorkspaceSourceInput;
  live: WorkspaceSource | undefined;
  onRemove: () => void;
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  const qc = useQueryClient();
  const short = useShortPath();
  const git = source.kind === "git";
  const remote = source.kind === "remote";
  const name =
    source.kind === "git"
      ? (live?.name ?? ("error" in parseGitUrl(source.url) ? source.url : (parseGitUrl(source.url) as { name: string }).name))
      : source.kind === "remote"
        ? remoteName(source.path)
        : folderName(source.path);
  const sync = useMutation({
    mutationFn: () => (projectId ? api.projects.syncSource(projectId, live!.id) : api.workspaces.syncSource(workspaceId!, live!.id)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.workspaces }),
    onError: (e) => toastApiError(e, t("sources.updateFailed"), qc),
  });
  const busy = live?.status === "cloning" || live?.status === "syncing" || sync.isPending;
  const path = live?.path || (source.kind !== "git" ? source.path : "");
  const web = source.kind === "git" ? webUrl(source.url) : null;
  const serverName = live?.serverName ?? null;
  const { data: runners = [] } = useRunners();
  const runner = remote && live ? runners.find((r) => r.kind === "ssh" && r.sshServerId === live.serverId) : undefined;
  const stop = useMutation({
    mutationFn: () => api.runners.remove(runner!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.runners });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      toast.success(t("sources.remoteStopped", { name: serverName ?? name }), { description: t("sources.remoteStoppedDescription") });
    },
    onError: (e) => toastApiError(e, t("sources.remoteStopFailed"), qc),
  });

  return (
    <div className="group flex items-start gap-3 px-3 py-2.5">
      <div
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border",
          git ? "bg-brand-soft text-brand-strong border-brand/15" : "bg-paper-2 text-muted-foreground",
        )}
      >
        {git ? <FolderGit2 className="size-4" /> : remote ? <Server className="size-4" /> : <Folder className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {source.kind === "git" && source.branch && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-paper-2 px-1.5 py-px font-mono text-[11px] text-muted-foreground">
              <GitBranch className="size-3" />
              {source.branch}
            </span>
          )}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground" title={source.kind === "git" ? source.url : source.path}>
          {source.kind === "git" ? displayUrl(source.url) : source.kind === "remote" ? `${serverName ?? t("sources.remoteServer")}:${source.path}` : short(source.path)}
        </p>
        <SourceStatus source={source} live={live} pending={sync.isPending} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {git && live && live.status !== "cloning" && live.status !== "syncing" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={live.status === "ready" ? t("sources.updateNamed", { name }) : t("sources.cloneNamed", { name })}
                disabled={busy}
                onClick={() => sync.mutate()}
                className="text-muted-foreground"
              >
                <RefreshCw className={cn(sync.isPending && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{live.status === "ready" ? t("sources.pull") : t("sources.cloneNow")}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("sources.moreFor", { name })} className="text-muted-foreground">
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {path && (
              <DropdownMenuItem onClick={() => void copyText(path).then((ok) => ok && toast.success(t("sources.pathCopied")))}>
                <Copy /> {t("sources.copyPath")}
              </DropdownMenuItem>
            )}
            {path && isTauri && !remote && (live?.status === "ready" || (!git && live?.status !== "missing")) && (
              <DropdownMenuItem onClick={() => void revealInFileManager(path)}>
                <FolderSearch /> {isMac ? t("sources.showInFinder") : t("sources.showInFolder")}
              </DropdownMenuItem>
            )}
            {web && (
              <DropdownMenuItem onClick={() => void openExternal(web)}>
                <ExternalLink /> {t("sources.openRepoPage")}
              </DropdownMenuItem>
            )}
            {runner && (
              <DropdownMenuItem disabled={stop.isPending} onClick={() => stop.mutate()}>
                <Server /> {t("sources.remoteStop")}
              </DropdownMenuItem>
            )}
            {(path || web || runner) && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              {git ? <Trash2 /> : <X />} {t("sources.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function RemoteStatus({ live }: { live: WorkspaceSource }) {
  const { t } = useTranslation("workspaces");
  const { data: runners = [] } = useRunners();
  const runner = runners.find((r) => r.kind === "ssh" && r.sshServerId === live.serverId);
  if (!runner) return <p className="mt-1 text-[11px] text-muted-foreground">{t("sources.remoteNotStarted")}</p>;
  return (
    <>
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <RunnerStateDot state={runner.state} />
        <span>{t("sources.remoteRunner", { state: RUNNER_STATE_LABEL[runner.state] })}</span>
        {runner.version && (
          <>
            <span className="opacity-40">·</span>
            <span className="font-mono">{runner.version}</span>
          </>
        )}
      </p>
      {runner.state !== "online" && runner.error && (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-warning">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          <span className="line-clamp-3">{runner.error}</span>
        </p>
      )}
    </>
  );
}

function SourceStatus({ source, live, pending }: { source: WorkspaceSourceInput; live: WorkspaceSource | undefined; pending: boolean }) {
  const { t } = useTranslation("workspaces");
  if (live?.kind === "remote" && live.status === "ready") return <RemoteStatus live={live} />;
  if (!live) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground">
        {source.kind === "git" ? t("sources.clonesOnSave") : source.kind === "remote" ? t("sources.remoteOnSave") : t("sources.attachedOnSave")}
      </p>
    );
  }
  if (live.status === "cloning" || live.status === "syncing" || pending) {
    const cloning = live.status === "cloning" || (pending && live.status !== "ready");
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {cloning ? t("sources.cloning") : t("sources.pulling")}
      </p>
    );
  }
  if (live.status === "error" || live.status === "missing") {
    const text =
      live.kind !== "git"
        ? (live.error ?? t("sources.folderNotFound"))
        : live.status === "missing"
          ? t("sources.notCloned")
          : live.error;
    return (
      <p className={cn("mt-1 flex items-start gap-1.5 text-[11px] leading-snug", live.status === "error" ? "text-destructive" : "text-warning")}>
        <TriangleAlert className="mt-px size-3 shrink-0" />
        <span className="line-clamp-3">{text}</span>
      </p>
    );
  }
  if (live.kind === "folder") return null;
  const synced = live.syncedAt ? new Date(live.syncedAt) : null;
  const warning = live.error ?? live.note;
  return (
    <>
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        <span className="font-mono">{live.headBranch ?? t("sources.detached")}</span>
        {live.commit && (
          <>
            <span className="opacity-40">·</span>
            <span className="font-mono">{live.commit}</span>
          </>
        )}
        {synced && !Number.isNaN(synced.getTime()) && (
          <>
            <span className="opacity-40">·</span>
            <span>{t("sources.checked", { when: formatDistanceToNowStrict(synced, { addSuffix: true, locale: dateLocale() }) })}</span>
          </>
        )}
      </p>
      {warning && (
        <p className={cn("mt-1 flex items-start gap-1.5 text-[11px] leading-snug", live.error ? "text-warning" : "text-muted-foreground")}>
          <TriangleAlert className="mt-px size-3 shrink-0" />
          <span className="line-clamp-3">{live.error ? t("sources.pullFailed", { error: live.error }) : live.note}</span>
        </p>
      )}
    </>
  );
}

function AddRepository({ onAdd, onCancel }: { onAdd: (source: WorkspaceSourceInput) => void; onCancel: () => void }) {
  const { t } = useTranslation(["workspaces", "common"]);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A branch taken from a pasted `…/tree/<branch>` link follows the URL until it is edited by hand.
  const autoBranch = useRef("");
  const parsed = url.trim() ? parseGitUrl(url) : null;
  const preview = parsed && !("error" in parsed) ? parsed : null;

  const submit = () => {
    const result = parseGitUrl(url);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onAdd({ kind: "git", url: result.url, branch: branch.trim() || result.branch || null });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div data-escape-local className="rounded-xl border bg-paper-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <FolderGit2 className="size-4 text-brand-strong" /> {t("sources.addGitTitle")}
        </p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("common:actions.cancel")} onClick={onCancel} className="text-muted-foreground">
          <X />
        </Button>
      </div>
      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
        <Input
          autoFocus
          aria-label={t("sources.repoUrl")}
          aria-invalid={!!error}
          placeholder="https://github.com/owner/repo"
          value={url}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
            if (branch && branch !== autoBranch.current) return;
            const p = parseGitUrl(e.target.value);
            autoBranch.current = "error" in p ? "" : (p.branch ?? "");
            setBranch(autoBranch.current);
          }}
          onKeyDown={onKeyDown}
          className="font-mono text-[13px] sm:flex-1"
        />
        <div className="relative sm:w-36">
          <GitBranch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t("sources.branchLabel")}
            placeholder={t("sources.branchPlaceholder")}
            value={branch}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={onKeyDown}
            className="pl-8 font-mono text-[13px]"
          />
        </div>
        <Button type="button" onClick={submit} disabled={!url.trim()}>
          {t("common:actions.add")}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : preview ? (
        <p className="mt-2 truncate text-xs text-muted-foreground">
          {branch.trim() || preview.branch ? (
            <Trans
              t={t}
              i18nKey="sources.clonesFromBranch"
              values={{ name: preview.name, url: displayUrl(preview.url), branch: branch.trim() || preview.branch }}
              components={{ b: <span className="font-medium text-foreground" />, mono: <span className="font-mono" /> }}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="sources.clonesFrom"
              values={{ name: preview.name, url: displayUrl(preview.url) }}
              components={{ b: <span className="font-medium text-foreground" />, mono: <span className="font-mono" /> }}
            />
          )}
        </p>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          <Trans t={t} i18nKey="sources.privateHint" components={{ mono: <span className="font-mono" /> }} />
        </p>
      )}
    </div>
  );
}

function AddRemoteFolder({ onAdd, onCancel }: { onAdd: (source: WorkspaceSourceInput) => void; onCancel: () => void }) {
  const { t } = useTranslation(["workspaces", "common"]);
  const { data: servers = [], isLoading } = useSshServers();
  const [serverId, setServerId] = useState("");
  const [path, setPath] = useState("");
  const chosen = serverId || (servers.length === 1 ? servers[0]!.id : "");
  const trimmed = path.trim();
  const valid = !!chosen && (trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/")) && !trimmed.split("/").includes("..");

  const submit = () => {
    if (valid) onAdd({ kind: "remote", serverId: chosen, path: trimmed });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div data-escape-local className="rounded-xl border bg-paper-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Server className="size-4 text-brand-strong" /> {t("sources.addRemoteTitle")}
        </p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("common:actions.cancel")} onClick={onCancel} className="text-muted-foreground">
          <X />
        </Button>
      </div>
      {!isLoading && servers.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("sources.remoteNoServers")}</p>
      ) : (
        <>
          <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
            <Select value={chosen} onValueChange={setServerId}>
              <SelectTrigger aria-label={t("sources.remoteServer")} className="sm:w-44">
                <SelectValue placeholder={t("sources.remoteServerPlaceholder")} />
              </SelectTrigger>
              <SelectContent position="popper">
                {servers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} <span className="font-mono text-xs text-muted-foreground">{s.username}@{s.host}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              autoFocus
              aria-label={t("sources.remotePath")}
              placeholder="~/code/my-project"
              value={path}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={onKeyDown}
              className="font-mono text-[13px] sm:flex-1"
            />
            <Button type="button" onClick={submit} disabled={!valid}>
              {t("common:actions.add")}
            </Button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("sources.remoteHint")}</p>
        </>
      )}
    </div>
  );
}

/** One line for the workspace card: what is attached, and whether something needs attention. */
export function SourcesSummary({ sources }: { sources: WorkspaceSource[] }) {
  const busy = sources.some((s) => s.status === "cloning" || s.status === "syncing");
  const problem = sources.find((s) => s.status === "error" || !!s.error || (s.status === "missing" && s.kind === "folder"));
  const names = sources.map((s) => s.name);
  const label = names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
  const icon = busy ? (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  ) : problem ? (
    <TriangleAlert className="size-3.5 shrink-0 text-warning" />
  ) : sources.some((s) => s.kind === "git") ? (
    <FolderGit2 className="size-3.5 shrink-0 text-brand-strong" />
  ) : (
    <Folder className="size-3.5 shrink-0 text-brand-strong" />
  );
  return (
    <>
      {icon}
      <span className="truncate">{label}</span>
    </>
  );
}

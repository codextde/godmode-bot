import { useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
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
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { parseGitUrl, type WorkspaceSource, type WorkspaceSourceInput } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FolderPickerDialog, folderName, useShortPath } from "@/components/chat/folder-picker";
import { copyText } from "@/components/chat/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { isMac, openExternal } from "@/lib/desktop";
import { useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export function toSourceInput(s: WorkspaceSource): WorkspaceSourceInput {
  return s.kind === "folder" ? { kind: "folder", path: s.path } : { kind: "git", url: s.url ?? "", branch: s.branch };
}

function sameSource(a: WorkspaceSourceInput, b: WorkspaceSource): boolean {
  if (a.kind === "folder") return b.kind === "folder" && b.path === a.path;
  return b.kind === "git" && b.url === a.url && (b.branch ?? null) === (a.branch ?? null);
}

function keyOf(s: WorkspaceSourceInput): string {
  return s.kind === "folder" ? `folder:${s.path}` : `git:${s.url}#${s.branch ?? ""}`;
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
    toast.error(`Couldn't open ${isMac ? "Finder" : "the file manager"}`);
  }
}

/**
 * Folders and repositories of a workspace, edited as part of the workspace form: changes apply when it is saved.
 * Live state (clone progress, commit, errors) comes from the saved workspace.
 */
export function WorkspaceSourcesField({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string | null;
  value: WorkspaceSourceInput[];
  onChange: (next: WorkspaceSourceInput[]) => void;
}) {
  const { data: workspaces } = useWorkspaces();
  const saved = workspaceId ? (workspaces?.find((w) => w.id === workspaceId)?.sources ?? []) : [];
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);

  const add = (source: WorkspaceSourceInput) => {
    if (value.some((s) => keyOf(s) === keyOf(source))) {
      toast.info(source.kind === "folder" ? "That folder is already attached" : "That repository is already attached");
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
                <SourceRow workspaceId={workspaceId} source={source} live={saved.find((s) => sameSource(source, s))} onRemove={() => remove(source)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <AnimatePresence initial={false}>
        {adding && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>
            <AddRepository
              onAdd={(s) => {
                add(s);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
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
            Give every agent here the files it needs — a project folder on this computer, or a git repository Godmode clones for them.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
              <FolderOpen /> Add folder
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
              <FolderGit2 /> Add repository
            </Button>
          </div>
        </div>
      ) : (
        !adding && (
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPicking(true)}>
              <Plus /> Folder
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setAdding(true)}>
              <Plus /> Repository
            </Button>
          </div>
        )
      )}

      <FolderPickerDialog
        open={picking}
        onOpenChange={setPicking}
        value={null}
        onPick={(path) => add({ kind: "folder", path })}
        title="Add a folder to the workspace"
        description="Every agent in this workspace can read and edit the files in it. Their chats keep working in their own folder."
      />
    </div>
  );
}

function SourceRow({
  workspaceId,
  source,
  live,
  onRemove,
}: {
  workspaceId: string | null;
  source: WorkspaceSourceInput;
  live: WorkspaceSource | undefined;
  onRemove: () => void;
}) {
  const qc = useQueryClient();
  const short = useShortPath();
  const git = source.kind === "git";
  const name = git ? (live?.name ?? ("error" in parseGitUrl(source.url) ? source.url : (parseGitUrl(source.url) as { name: string }).name)) : folderName(source.path);
  const sync = useMutation({
    mutationFn: () => api.workspaces.syncSource(workspaceId!, live!.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.workspaces }),
    onError: (e) => toastApiError(e, "Couldn't update the repository", qc),
  });
  const busy = live?.status === "cloning" || live?.status === "syncing" || sync.isPending;
  const path = live?.path || (source.kind === "folder" ? source.path : "");
  const web = git ? webUrl(source.url) : null;

  return (
    <div className="group flex items-start gap-3 px-3 py-2.5">
      <div
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border",
          git ? "bg-brand-soft text-brand-strong border-brand/15" : "bg-paper-2 text-muted-foreground",
        )}
      >
        {git ? <FolderGit2 className="size-4" /> : <Folder className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {git && source.branch && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-paper-2 px-1.5 py-px font-mono text-[11px] text-muted-foreground">
              <GitBranch className="size-3" />
              {source.branch}
            </span>
          )}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground" title={git ? source.url : source.path}>
          {git ? displayUrl(source.url) : short(source.path)}
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
                aria-label={live.status === "ready" ? `Update ${name}` : `Clone ${name}`}
                disabled={busy}
                onClick={() => sync.mutate()}
                className="text-muted-foreground"
              >
                <RefreshCw className={cn(sync.isPending && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{live.status === "ready" ? "Pull the latest changes" : "Clone now"}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${name}`} className="text-muted-foreground">
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {path && (
              <DropdownMenuItem onClick={() => void copyText(path).then((ok) => ok && toast.success("Path copied"))}>
                <Copy /> Copy path
              </DropdownMenuItem>
            )}
            {path && isTauri && (live?.status === "ready" || (!git && live?.status !== "missing")) && (
              <DropdownMenuItem onClick={() => void revealInFileManager(path)}>
                <FolderSearch /> {isMac ? "Show in Finder" : "Show in folder"}
              </DropdownMenuItem>
            )}
            {web && (
              <DropdownMenuItem onClick={() => void openExternal(web)}>
                <ExternalLink /> Open repository page
              </DropdownMenuItem>
            )}
            {(path || web) && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              {git ? <Trash2 /> : <X />} Remove from workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function SourceStatus({ source, live, pending }: { source: WorkspaceSourceInput; live: WorkspaceSource | undefined; pending: boolean }) {
  if (!live) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground">
        {source.kind === "git" ? "Godmode clones it when you save." : "Attached when you save."}
      </p>
    );
  }
  if (live.status === "cloning" || live.status === "syncing" || pending) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {live.status === "cloning" ? "Cloning…" : "Pulling the latest changes…"}
      </p>
    );
  }
  if (live.status === "error" || live.status === "missing") {
    const text =
      live.kind === "folder"
        ? (live.error ?? "Folder not found")
        : live.status === "missing"
          ? "Not cloned yet — it's cloned before the next run."
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
  return (
    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-success" />
      <span className="font-mono">{live.headBranch ?? "detached"}</span>
      {live.commit && (
        <>
          <span className="opacity-40">·</span>
          <span className="font-mono">{live.commit}</span>
        </>
      )}
      {synced && !Number.isNaN(synced.getTime()) && (
        <>
          <span className="opacity-40">·</span>
          <span>updated {formatDistanceToNowStrict(synced, { addSuffix: true })}</span>
        </>
      )}
    </p>
  );
}

function AddRepository({ onAdd, onCancel }: { onAdd: (source: WorkspaceSourceInput) => void; onCancel: () => void }) {
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
    <div className="rounded-xl border bg-paper-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <FolderGit2 className="size-4 text-brand-strong" /> Add a git repository
        </p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel" onClick={onCancel} className="text-muted-foreground">
          <X />
        </Button>
      </div>
      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
        <Input
          autoFocus
          aria-label="Repository URL"
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
            aria-label="Branch (optional)"
            placeholder="default branch"
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
          Add
        </Button>
      </div>
      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : preview ? (
        <p className="mt-2 truncate text-xs text-muted-foreground">
          Clones <span className="font-medium text-foreground">{preview.name}</span> from <span className="font-mono">{displayUrl(preview.url)}</span>
          {(branch.trim() || preview.branch) && (
            <>
              {" "}
              on <span className="font-mono">{branch.trim() || preview.branch}</span>
            </>
          )}
        </p>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Private repositories use this computer's git sign-in — an SSH key for <span className="font-mono">git@</span> URLs, or a credential helper such
          as <span className="font-mono">gh auth login</span>.
        </p>
      )}
    </div>
  );
}

/** One line for the workspace card: what is attached, and whether something needs attention. */
export function SourcesSummary({ sources }: { sources: WorkspaceSource[] }) {
  const busy = sources.some((s) => s.status === "cloning" || s.status === "syncing");
  const problem = sources.find((s) => s.status === "error" || (s.status === "missing" && s.kind === "folder"));
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

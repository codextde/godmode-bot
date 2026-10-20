import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { ArrowDownWideNarrow, ChevronRight, Copy, Folder, FolderInput, FolderOpen, FolderPlus, Lock, MoreHorizontal, PencilLine, Plus, Search, SquarePen, Trash2, X } from "lucide-react";
import type { Agent, AgentFileEntry, AgentFileSize } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { fileIcon, nameOf, parentOf } from "./file-editor";
import { placeable, plural, REVEAL_LABEL } from "./use-files";

type Sort = "name" | "size" | "modified";

const FIXED = new Set(["CLAUDE.md", "MEMORY.md", ".gitignore", "workspace", "memory", "workspace/tmp", "workspace/uploads", "conversations", "runs", "state"]);
const ROOT_ORDER = ["workspace", "memory", "MEMORY.md", "CLAUDE.md"];

/** Godmode's own files: they stay (the core refuses too; see agents/files.ts lockReason). */
export function isLocked(path: string) {
  return FIXED.has(path) || /^(conversations|runs|state)\//.test(path) || /^(memory|workspace|conversations|runs|state)\/\.gitkeep$/.test(path);
}

const FOLDER_NOTES: Record<string, string> = {
  "workspace/tmp": "Scratch — goes by itself",
  "workspace/uploads": "Your attachments",
  conversations: "Chat transcripts",
  runs: "Run logs",
  state: "Settings snapshot",
  memory: "Notes the agent reads",
  workspace: "What the agent makes",
};

export interface BrowseActions {
  onDelete: (paths: string[]) => void;
  onMove: (paths: string[]) => void;
  onRename: (path: string) => void;
  onNew: (kind: "note" | "folder", dir: string) => void;
  onReveal: (path: string) => void;
}

export function Breadcrumbs({ agent, dir, onDir }: { agent: Agent; dir: string; onDir: (dir: string) => void }) {
  const parts = dir ? dir.split("/") : [];
  return (
    <nav aria-label="Folder" className="flex min-w-0 items-center gap-0.5 overflow-hidden text-[13px]">
      <button type="button" onClick={() => onDir("")} className={cn("shrink-0 rounded px-1.5 py-0.5 hover:bg-accent", !parts.length && "font-medium")}>
        {agent.name}
      </button>
      {parts.map((p, i) => {
        const to = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={to} className={cn("flex min-w-0 items-center gap-0.5", last ? "shrink" : "shrink-[2]")}>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
            <button type="button" onClick={() => onDir(to)} title={to} className={cn("truncate rounded px-1.5 py-0.5 hover:bg-accent", last && "font-medium")}>
              {p}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function sortEntries(entries: AgentFileEntry[], sizes: Map<string, AgentFileSize>, sort: Sort, root: boolean) {
  const bytes = (e: AgentFileEntry) => sizes.get(e.path)?.bytes ?? e.size;
  const changed = (e: AgentFileEntry) => Date.parse(sizes.get(e.path)?.modifiedAt ?? e.modifiedAt) || 0;
  return [...entries].sort((a, b) => {
    if (root) {
      const pa = ROOT_ORDER.indexOf(a.path);
      const pb = ROOT_ORDER.indexOf(b.path);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    }
    if (sort === "size") return bytes(b) - bytes(a);
    if (sort === "modified") return changed(b) - changed(a);
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return nameOf(a.path).localeCompare(nameOf(b.path), undefined, { numeric: true, sensitivity: "base" });
  });
}

export function BrowsePane({
  agent,
  dir,
  onDir,
  selected,
  onSelect,
  actions,
  frozen,
}: {
  agent: Agent;
  dir: string;
  onDir: (dir: string) => void;
  selected: string | null;
  onSelect: (entry: { path: string; size: number }) => void;
  actions: BrowseActions;
  /** Moves and deletes wait (the agent dreams). */
  frozen: boolean;
}) {
  const [sort, setSort] = useState<Sort>("name");
  const [filter, setFilter] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const listing = useQuery({ queryKey: qk.agentFiles(agent.id, dir), queryFn: () => api.agents.files(agent.id, dir), placeholderData: keepPreviousData });
  const sizesQ = useQuery({ queryKey: qk.agentFileSizes(agent.id, dir), queryFn: () => api.agents.fileSizes(agent.id, dir), staleTime: 30_000 });
  const sizes = useMemo(() => new Map((sizesQ.data ?? []).map((s) => [s.path, s])), [sizesQ.data]);
  const needle = filter.trim().toLowerCase();
  const search = useDebounced(needle, 250);
  const found = useQuery({
    queryKey: qk.agentFileSearch(agent.id, search),
    queryFn: () => api.agents.searchFiles(agent.id, search),
    enabled: search.length >= 2,
    staleTime: 15_000,
  });

  useEffect(() => {
    setChecked(new Set());
    setFilter("");
  }, [dir, agent.id]);

  const entries = useMemo(() => {
    const visible = (listing.data ?? []).filter((e) => nameOf(e.path) !== ".gitkeep" && parentOf(e.path) === dir);
    const shown = needle ? visible.filter((e) => nameOf(e.path).toLowerCase().includes(needle)) : visible;
    return sortEntries(shown, sizes, sort, !dir);
  }, [listing.data, dir, needle, sizes, sort]);
  const largest = Math.max(1, ...entries.map((e) => sizes.get(e.path)?.bytes ?? e.size));
  const total = (sizesQ.data ?? []).reduce((n, s) => n + s.bytes, 0);
  const pickable = entries.filter((e) => !isLocked(e.path));
  const checkedList = [...checked].filter((p) => entries.some((e) => e.path === p));
  const checkedBytes = checkedList.reduce((n, p) => n + (sizes.get(p)?.bytes ?? 0), 0);
  const canCreate = placeable(dir);
  const otherHits = (found.data ?? []).filter((h) => parentOf(h.path) !== dir || h.line !== null);

  const toggle = (path: string, on: boolean) =>
    setChecked((s) => {
      const next = new Set(s);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && checkedList.length && !frozen) {
        e.preventDefault();
        actions.onDelete(checkedList);
      }
      if (e.key === "Escape" && checkedList.length) setChecked(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checkedList, actions, frozen]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Breadcrumbs agent={agent} dir={dir} onDir={onDir} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Sort">
                <ArrowDownWideNarrow />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
                <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="size">Size</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="modified">Last changed</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {canCreate && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                  <Plus /> New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => actions.onNew("note", dir)}>
                  <SquarePen /> Note
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => actions.onNew("folder", dir)}>
                  <FolderPlus /> Folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter, or search every file and note" className="h-8 pl-8 text-[13px]" aria-label="Filter and search" />
          {filter && (
            <button type="button" aria-label="Clear" onClick={() => setFilter("")} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {checkedList.length > 0 && (
        <div className="flex items-center gap-2 border-b bg-secondary/60 px-3 py-1.5 text-xs">
          <span className="font-medium">{plural(checkedList.length, "item")} selected</span>
          {checkedBytes > 0 && <span className="text-muted-foreground tabular-nums">{formatBytes(checkedBytes)}</span>}
          <span className="ml-auto flex gap-1">
            <Button size="xs" variant="ghost" disabled={frozen} onClick={() => actions.onMove(checkedList)}>
              <FolderInput /> Move
            </Button>
            <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" disabled={frozen} onClick={() => actions.onDelete(checkedList)}>
              <Trash2 /> Delete
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Clear selection" onClick={() => setChecked(new Set())}>
              <X />
            </Button>
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {pickable.length > 1 && (
          <div className="flex items-center gap-2.5 px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            <Checkbox
              aria-label="Select all"
              checked={checkedList.length === pickable.length ? true : checkedList.length ? "indeterminate" : false}
              onCheckedChange={(v) => setChecked(v === true ? new Set(pickable.map((e) => e.path)) : new Set())}
            />
            <span className="flex-1">Name</span>
            <span className="w-20 text-right">Size</span>
            <span className="hidden w-20 text-right @5xl:block">Changed</span>
            <span className="w-6" />
          </div>
        )}
        {listing.isLoading ? (
          <div className="space-y-1.5 p-3">
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : listing.isError ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(listing.error)}</p>
        ) : !entries.length ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{needle ? "Nothing here matches." : "This folder is empty."}</p>
        ) : (
          <ul className="px-1.5 pb-2" role="list">
            {entries.map((e) => {
              const isDir = e.type === "dir";
              const size = sizes.get(e.path);
              const bytes = size?.bytes ?? (isDir ? null : e.size);
              const locked = isLocked(e.path);
              const active = selected === e.path;
              const on = checked.has(e.path);
              const modified = size?.modifiedAt ?? e.modifiedAt;
              return (
                <li
                  key={e.path}
                  className={cn(
                    "group/row relative flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-[13px] transition-colors hover:bg-accent/50",
                    active && "bg-secondary",
                    on && "bg-primary/[0.05]",
                  )}
                >
                  <span className="grid w-4 place-items-center">
                    {locked ? (
                      <Lock className="size-3 text-muted-foreground/50" aria-label="Kept by Godmode" />
                    ) : (
                      <Checkbox aria-label={`Select ${nameOf(e.path)}`} checked={on} onCheckedChange={(v) => toggle(e.path, v === true)} className={cn(!on && !checkedList.length && "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100")} />
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => (isDir ? onDir(e.path) : onSelect({ path: e.path, size: e.size }))}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:underline"
                  >
                    {isDir ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <span className="shrink-0">{fileIcon(e.path)}</span>}
                    <span className={cn("truncate", active && "font-medium")}>{nameOf(e.path)}</span>
                    {FOLDER_NOTES[e.path] && <span className="hidden shrink-0 truncate text-xs text-muted-foreground @4xl:inline">· {FOLDER_NOTES[e.path]}</span>}
                  </button>
                  <span className="w-20 shrink-0 text-right">
                    {bytes === null ? (
                      <Skeleton className="ml-auto h-3 w-12" />
                    ) : (
                      <span className="block">
                        <span className="text-xs text-muted-foreground tabular-nums" title={size?.files ? plural(size.files, "file") : undefined}>
                          {size?.partial ? "≥ " : ""}
                          {formatBytes(bytes)}
                        </span>
                        <span className="mt-1 ml-auto block h-[3px] w-14 overflow-hidden rounded-full bg-foreground/[0.06]">
                          <span className="block h-full rounded-full bg-foreground/30" style={{ width: `${Math.max(2, (bytes / largest) * 100)}%` }} />
                        </span>
                      </span>
                    )}
                  </span>
                  <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums @5xl:block" title={modified ? new Date(modified).toLocaleString() : undefined}>
                    {modified ? formatDistanceToNowStrict(new Date(modified)) : ""}
                  </span>
                  <RowMenu path={e.path} isDir={isDir} locked={locked} frozen={frozen} actions={actions} onOpen={() => (isDir ? onDir(e.path) : onSelect({ path: e.path, size: e.size }))} />
                </li>
              );
            })}
          </ul>
        )}

        {search.length >= 2 && (
          <section className="border-t px-1.5 pt-2 pb-3" aria-label="Search results">
            <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">In all files</p>
            {found.isLoading ? (
              <Skeleton className="mx-2 h-8" />
            ) : !otherHits.length ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">No other file or note mentions “{search}”.</p>
            ) : (
              <ul>
                {otherHits.map((h) => (
                  <li key={`${h.path}:${h.line}`}>
                    <button
                      type="button"
                      onClick={() => {
                        if (h.type === "dir") return onDir(h.path);
                        onDir(parentOf(h.path));
                        onSelect({ path: h.path, size: 0 });
                      }}
                      className="w-full rounded-md px-2 py-1.5 text-left transition hover:bg-accent/50"
                    >
                      <span className="flex items-center gap-2 text-[13px]">
                        {h.type === "dir" ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : fileIcon(h.path)}
                        <span className="truncate font-mono text-xs">{h.path}</span>
                        {h.line !== null && <span className="shrink-0 text-[11px] text-muted-foreground">line {h.line}</span>}
                      </span>
                      {h.snippet && <span className="mt-0.5 line-clamp-2 block pl-6 text-xs text-muted-foreground">{h.snippet}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>{needle ? `${entries.length} of ${plural(listing.data?.length ?? 0, "item")}` : plural(entries.length, "item")}</span>
        {total > 0 && !needle && <span className="tabular-nums">· {formatBytes(total)}</span>}
        {sizesQ.isFetching && <span className="ml-auto">counting…</span>}
      </div>
    </div>
  );
}

function RowMenu({ path, isDir, locked, frozen, actions, onOpen }: { path: string; isDir: boolean; locked: boolean; frozen: boolean; actions: BrowseActions; onOpen: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${nameOf(path)}`} className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onOpen}>{isDir ? <FolderOpen /> : <SquarePen />} Open</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onReveal(path)}>
          <Copy /> {REVEAL_LABEL}
        </DropdownMenuItem>
        {!locked && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={frozen} onSelect={() => actions.onRename(path)}>
              <PencilLine /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem disabled={frozen} onSelect={() => actions.onMove([path])}>
              <FolderInput /> Move to…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={frozen} onSelect={() => actions.onDelete([path])}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

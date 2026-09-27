import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import {
  Brain,
  ChevronRight,
  Eye,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Lock,
  PencilLine,
  RotateCcw,
  Save,
} from "lucide-react";
import type { Agent, AgentFileEntry } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { isMac, modKey } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/common";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PINNED = ["MEMORY.md", "CLAUDE.md"];
const HIDDEN = new Set([".git"]);
const MAX_EDITABLE = 512 * 1024;

/** Why a file can't be edited here (null = editable). */
function readOnlyReason(path: string, size: number): string | null {
  if (path === "CLAUDE.md") return "Generated from the agent's settings — edit the instructions in Settings instead.";
  if (path.startsWith("state/")) return "Snapshot written by Godmode — changes would be overwritten.";
  if (path.startsWith("runs/")) return "Raw run log — read-only.";
  if (path.startsWith("conversations/")) return "Conversation transcript — read-only.";
  if (size > MAX_EDITABLE) return "This file is too large to edit here.";
  return null;
}

function parentOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function nameOf(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Normalise listing entries to repo-relative paths directly inside `dir`. */
function childrenOf(entries: AgentFileEntry[], dir: string): AgentFileEntry[] {
  const seen = new Set<string>();
  const out: AgentFileEntry[] = [];
  for (const e of entries) {
    let p = e.path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
    if (dir && !p.startsWith(`${dir}/`)) p = `${dir}/${p}`;
    if (parentOf(p) !== dir) continue;
    if (HIDDEN.has(nameOf(p)) || seen.has(p)) continue;
    seen.add(p);
    out.push({ ...e, path: p });
  }
  return out.sort((a, b) => {
    if (!dir) {
      const pa = PINNED.indexOf(a.path);
      const pb = PINNED.indexOf(b.path);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    }
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function fileIcon(path: string) {
  if (path === "MEMORY.md") return <Brain className="size-4 text-glow-a" />;
  if (path === "CLAUDE.md") return <Lock className="size-4 text-muted-foreground" />;
  if (/\.(json|jsonl)$/.test(path)) return <FileJson className="size-4 text-muted-foreground" />;
  if (/\.(ts|tsx|js|py|sh|yaml|yml|toml)$/.test(path)) return <FileCode2 className="size-4 text-muted-foreground" />;
  return <FileText className="size-4 text-muted-foreground" />;
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function MemoryTab({ agent }: { agent: Agent }) {
  const [selected, setSelected] = useState<{ path: string; size: number } | null>({ path: "MEMORY.md", size: 0 });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["memory"]));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<{ path: string; size: number } | null>(null);

  const select = (entry: { path: string; size: number }) => {
    if (entry.path === selected?.path) return;
    if (dirty) setPending(entry);
    else setSelected(entry);
  };
  const toggleDir = (path: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="grid min-h-[32rem] gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="glass flex max-h-[70vh] min-h-0 flex-col rounded-2xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Files</h2>
            <p className="text-xs text-muted-foreground">Agent repository</p>
          </div>
        </div>
        <nav aria-label="Agent files" className="min-h-0 flex-1 overflow-y-auto p-2">
          <Tree agentId={agent.id} dir="" depth={0} expanded={expanded} onToggle={toggleDir} selected={selected?.path ?? null} onSelect={select} />
        </nav>
      </aside>

      <section className="glass flex min-h-0 min-w-0 flex-col rounded-2xl">
        {selected ? (
          <FileEditor key={selected.path} agentId={agent.id} path={selected.path} size={selected.size} onDirtyChange={setDirty} />
        ) : (
          <div className="grid flex-1 place-items-center p-10 text-sm text-muted-foreground">Select a file to view it.</div>
        )}
      </section>

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>Your edits to {selected?.path} haven't been saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDirty(false);
                setSelected(pending);
                setPending(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Tree({
  agentId,
  dir,
  depth,
  expanded,
  onToggle,
  selected,
  onSelect,
}: {
  agentId: string;
  dir: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (entry: { path: string; size: number }) => void;
}) {
  const q = useQuery({ queryKey: qk.agentFiles(agentId, dir), queryFn: () => api.agents.files(agentId, dir) });
  const entries = useMemo(() => childrenOf(q.data ?? [], dir), [q.data, dir]);
  const pad = { paddingLeft: `${depth * 14 + 8}px` };

  if (q.isLoading) {
    return (
      <div className="space-y-1.5 py-1" style={pad}>
        {Array.from({ length: depth ? 2 : 5 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-4/5" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <p className="px-2 py-1 text-xs text-destructive" style={pad}>
        {errorMessage(q.error)}
      </p>
    );
  }
  if (!entries.length) {
    return (
      <p className="py-1 text-xs text-muted-foreground" style={pad}>
        Empty
      </p>
    );
  }

  return (
    <ul role={depth ? "group" : "tree"} className="space-y-px">
      {entries.map((e) => {
        const isDir = e.type === "dir";
        const open = isDir && expanded.has(e.path);
        const active = selected === e.path;
        return (
          <li key={e.path} role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={active}>
            <button
              type="button"
              onClick={() => (isDir ? onToggle(e.path) : onSelect({ path: e.path, size: e.size }))}
              style={pad}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[13px] transition hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                active && "bg-primary/10 font-medium text-foreground",
              )}
            >
              {isDir ? (
                <>
                  <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                  {open ? <FolderOpen className="size-4 shrink-0 text-primary/80" /> : <Folder className="size-4 shrink-0 text-primary/80" />}
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0" />
                  <span className="shrink-0">{fileIcon(e.path)}</span>
                </>
              )}
              <span className="truncate">{nameOf(e.path)}</span>
            </button>
            {open && (
              <Tree agentId={agentId} dir={e.path} depth={depth + 1} expanded={expanded} onToggle={onToggle} selected={selected} onSelect={onSelect} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FileEditor({
  agentId,
  path,
  size,
  onDirtyChange,
}: {
  agentId: string;
  path: string;
  size: number;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const file = useQuery({ queryKey: qk.agentFile(agentId, path), queryFn: () => api.agents.readFile(agentId, path) });
  const original = file.data?.content ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? original;
  const dirty = draft !== null && draft !== original;
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const readOnly = readOnlyReason(path, Math.max(size, original.length));
  const [view, setView] = useState<"edit" | "preview">(isMarkdown && readOnly ? "preview" : "edit");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = useMutation({
    mutationFn: (content: string) => api.agents.writeFile(agentId, path, content),
    onSuccess: (_, content) => {
      qc.setQueryData(qk.agentFile(agentId, path), { path, content });
      qc.invalidateQueries({ queryKey: qk.agentCommits(agentId) });
      qc.invalidateQueries({ queryKey: qk.agentFiles(agentId, parentOf(path)) });
      setDraft(null);
      toast.success(`Saved ${nameOf(path)}`);
    },
    onError: (err) => toast.error(`Couldn't save ${nameOf(path)}`, { description: errorMessage(err) }),
  });

  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => {
    if (dirty && !readOnly && !save.isPending) save.mutate(value);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lines = value ? value.split("\n").length : 0;
  const missing = file.isError && (file.error as { status?: number }).status === 404;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="shrink-0">{fileIcon(path)}</span>
        <span className="min-w-0 truncate font-mono text-[13px]">{path}</span>
        {dirty && <span className="size-2 shrink-0 rounded-full bg-warning" aria-label="Unsaved changes" title="Unsaved changes" />}
        <div className="ml-auto flex items-center gap-2">
          {isMarkdown && (
            <ToggleGroup type="single" size="sm" variant="outline" value={view} onValueChange={(v) => v && setView(v as "edit" | "preview")} aria-label="View mode">
              <ToggleGroupItem value="edit" aria-label={readOnly ? "Source" : "Edit"} className="gap-1 px-2 text-xs">
                <PencilLine className="size-3.5" /> {readOnly ? "Source" : "Edit"}
              </ToggleGroupItem>
              <ToggleGroupItem value="preview" aria-label="Preview" className="gap-1 px-2 text-xs">
                <Eye className="size-3.5" /> Preview
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          {!readOnly && (
            <>
              <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(null)}>
                <RotateCcw /> Revert
              </Button>
              <Button size="sm" disabled={!dirty || save.isPending} onClick={() => saveRef.current()}>
                {save.isPending ? <Spinner /> : <Save />} Save
                <Kbd>{modKey}S</Kbd>
              </Button>
            </>
          )}
        </div>
      </div>

      {readOnly && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0" />
          <span>{readOnly}</span>
          {path === "CLAUDE.md" && (
            <Link to={`/agents/${agentId}/settings`} className="ml-auto shrink-0 font-medium text-primary hover:underline">
              Open settings
            </Link>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {file.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-4" style={{ width: `${40 + ((i * 37) % 55)}%` }} />
            ))}
          </div>
        ) : file.isError && !missing ? (
          <div className="p-6 text-sm text-muted-foreground">Couldn't open this file: {errorMessage(file.error)}</div>
        ) : view === "preview" && isMarkdown ? (
          <div className="max-h-[70vh] overflow-y-auto p-5">
            {value.trim() ? <Markdown>{value}</Markdown> : <p className="text-sm text-muted-foreground italic">Empty file.</p>}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Tab inserts two spaces instead of leaving the editor
              if (e.key === "Tab" && !e.shiftKey && !readOnly) {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: s, selectionEnd: end } = el;
                const next = `${value.slice(0, s)}  ${value.slice(end)}`;
                setDraft(next);
                requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
              }
            }}
            readOnly={!!readOnly}
            spellCheck={isMarkdown}
            aria-label={`Contents of ${path}`}
            placeholder={missing ? "This file doesn't exist yet — start typing to create it." : undefined}
            className="block h-[60vh] w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
          />
        )}
      </div>

      <div className="flex items-center gap-3 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{lines.toLocaleString()} lines</span>
        <span className="tabular-nums">{formatSize(new Blob([value]).size)}</span>
        {path === "MEMORY.md" && <span>The agent maintains this file itself — edits guide what it remembers.</span>}
        {file.dataUpdatedAt > 0 && !dirty && (
          <span className="ml-auto">loaded {formatDistanceToNowStrict(file.dataUpdatedAt, { addSuffix: true })}</span>
        )}
        {dirty && <span className="ml-auto text-warning">Unsaved changes</span>}
      </div>
    </>
  );
}

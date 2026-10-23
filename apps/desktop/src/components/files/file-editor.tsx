import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { Brain, Columns2, Eye, FileArchive, FileAudio, FileCode2, FileImage, FileJson, FileSpreadsheet, FileText, FileVideo, Lock, Moon, PencilLine, RotateCcw, Save } from "lucide-react";
import { formatBytes } from "@godmode/shared";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { isMac, modKey } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/common";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BrokenLinks, brokenMemoryLinks, MemoryBudget, memorySections, SectionMenu, type MemorySection } from "@/components/agents/detail/memory-editor-parts";

const MAX_EDITABLE = 512 * 1024;

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
export const NOTE_FILE = /\.(md|markdown)$/i;

export function parentOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function nameOf(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Why a file can't be edited here (null = editable). */
export function readOnlyReason(path: string, size: number): string | null {
  if (path === "CLAUDE.md") return "Generated from the agent's settings — edit the instructions in Settings instead.";
  if (path.startsWith("state/")) return "Snapshot written by Godmode — changes would be overwritten.";
  if (path.startsWith("runs/")) return "Raw run log — read-only.";
  if (path.startsWith("conversations/")) return "Conversation transcript — read-only.";
  if (size > MAX_EDITABLE) return "This file is too large to edit here.";
  return null;
}

/** MEMORY.md and memory/** — a running dream owns these (the core refuses edits meanwhile). */
export function isMemoryPath(path: string) {
  return path === "MEMORY.md" || path.startsWith("memory/");
}

export function fileIcon(path: string, className = "size-4 text-muted-foreground") {
  if (path === "MEMORY.md") return <Brain className={cn(className, "text-foreground")} />;
  if (path === "CLAUDE.md") return <Lock className={className} />;
  if (IMAGE_FILE.test(path)) return <FileImage className={className} />;
  if (/\.(json|jsonl)$/i.test(path)) return <FileJson className={className} />;
  if (/\.(csv|tsv|xlsx?|numbers)$/i.test(path)) return <FileSpreadsheet className={className} />;
  if (/\.(zip|tar|gz|tgz|7z|rar|dmg|apk|aab|ipa)$/i.test(path)) return <FileArchive className={className} />;
  if (/\.(mp4|mov|webm|mkv)$/i.test(path)) return <FileVideo className={className} />;
  if (/\.(mp3|wav|m4a|ogg|aac)$/i.test(path)) return <FileAudio className={className} />;
  if (/\.(ts|tsx|js|mjs|cjs|py|sh|yaml|yml|toml|html|css|swift|kt|go|rs)$/i.test(path)) return <FileCode2 className={className} />;
  return <FileText className={className} />;
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** A file of the repository a clicked link points at (MEMORY.md, memory/…, workspace/…), or null for any other link. */
export function repoLinkTarget(href: string | null): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return null;
  const path = decodePath(href.replace(/^\.\//, "").split(/[#?]/)[0]!);
  if (path.includes("..")) return null;
  return path === "MEMORY.md" || path.startsWith("memory/") || path.startsWith("workspace/") ? path : null;
}

/** The file changed on the server since the draft started — saving would overwrite someone else's edit. */
class StaleDraftError extends Error {}

type View = "edit" | "split" | "preview";

export function FileEditor({
  agentId,
  agentName,
  path,
  size,
  dreaming,
  onDirtyChange,
  onOpenFile,
  onSaved,
  fill = false,
  defaultView,
  actions,
}: {
  agentId: string;
  agentName: string;
  path: string;
  size: number;
  /** A dream of the agent is running: memory files are locked until it ends. */
  dreaming: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** A link in the preview points at another file in the repository. */
  onOpenFile: (path: string) => void;
  onSaved?: (path: string) => void;
  /** Grow with the pane instead of a fixed height. */
  fill?: boolean;
  defaultView?: View;
  /** More buttons for the file (rename, move, delete), at the end of the bar. */
  actions?: ReactNode;
}) {
  const qc = useQueryClient();
  const file = useQuery({ queryKey: qk.agentFile(agentId, path), queryFn: () => api.agents.readFile(agentId, path), retry: false });
  const original = file.data?.content ?? "";
  /** The edit and the file content it started from, so a rewrite underneath (e.g. by a dream) isn't silently overwritten. */
  const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
  const value = draft?.text ?? original;
  const dirty = draft !== null && draft.text !== original;
  const conflict = dirty && draft.base !== original;
  const isMarkdown = NOTE_FILE.test(path);
  const fixedReason = readOnlyReason(path, Math.max(size, original.length));
  const dreamLock = dreaming && isMemoryPath(path);
  const readOnly = fixedReason ?? (dreamLock ? `${agentName} is dreaming — editing is paused until the dream ends.` : null);
  const [view, setView] = useState<View>(isMarkdown ? (fixedReason ? "preview" : (defaultView ?? "edit")) : "edit");
  const edit = (text: string) => setDraft((d) => ({ text, base: d && d.text !== original ? d.base : original }));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const isMemory = path === "MEMORY.md";
  const memory = useQuery({ queryKey: qk.agentMemory(agentId), queryFn: () => api.agents.memory(agentId), enabled: isMemory });
  const sections = useMemo(() => (isMarkdown ? memorySections(value) : []), [isMarkdown, value]);
  const broken = useMemo(() => (isMemory && memory.data ? brokenMemoryLinks(value, memory.data.topics) : []), [isMemory, memory.data, value]);
  const showSource = view !== "preview" || !isMarkdown;
  const showPreview = isMarkdown && view !== "edit";

  const jumpTo = (section: MemorySection) => {
    if (view === "preview") {
      const headings = previewRef.current?.querySelectorAll("h1, h2, h3");
      headings?.[sections.indexOf(section)]?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    const offset = value.split("\n").slice(0, section.line).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(offset, offset);
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 21;
    el.scrollTop = Math.max(0, section.line * lineHeight - 12);
  };

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = useMutation({
    mutationFn: async ({ content, base }: { content: string; base: string | null }) => {
      // Not every writer announces itself (a chat run may rewrite MEMORY.md): check the file is still what the draft started from.
      if (base !== null) {
        const fresh = await api.agents.readFile(agentId, path).catch((err) => {
          if (err instanceof ApiRequestError && err.status === 404) return { path, content: "" };
          throw err;
        });
        if (fresh.content !== base) {
          qc.setQueryData(qk.agentFile(agentId, path), fresh);
          throw new StaleDraftError();
        }
      }
      await api.agents.writeFile(agentId, path, content);
      return content;
    },
    onSuccess: (content) => {
      qc.setQueryData(qk.agentFile(agentId, path), { path, content });
      qc.invalidateQueries({ queryKey: qk.agentCommits(agentId) });
      qc.invalidateQueries({ queryKey: qk.agentFiles(agentId, parentOf(path)) });
      if (isMemory) {
        qc.invalidateQueries({ queryKey: qk.agentDreams(agentId) });
        qc.invalidateQueries({ queryKey: qk.agentMemory(agentId) });
      }
      setDraft(null);
      onSaved?.(path);
      toast.success(`Saved ${nameOf(path)}`);
    },
    onError: (err) => {
      if (err instanceof StaleDraftError) warnConflict();
      else toast.error(`Couldn't save ${nameOf(path)}`, { description: errorMessage(err) });
    },
  });
  const warnConflict = () =>
    toast.warning(`${nameOf(path)} changed while you were editing`, { description: "Reload it, or overwrite it with your version." });

  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => {
    if (!dirty || readOnly || save.isPending || !draft) return;
    if (conflict) warnConflict();
    else save.mutate({ content: value, base: draft.base });
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
  const words = useMemo(() => (isMarkdown ? (value.match(/\S+/g)?.length ?? 0) : 0), [isMarkdown, value]);
  const status = file.isError ? (file.error as { status?: number }).status : undefined;
  const missing = status === 404;
  const unreadable = status === 415 || status === 413;
  const height = fill ? "h-full min-h-[18rem]" : "h-[60vh]";

  const preview = (
    <div
      ref={previewRef}
      className={cn("overflow-y-auto p-5", fill ? "h-full" : "max-h-[70vh]")}
      onClickCapture={(e) => {
        const target = repoLinkTarget((e.target as HTMLElement).closest("a")?.getAttribute("href") ?? null);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        onOpenFile(target);
      }}
    >
      {value.trim() ? <Markdown>{value}</Markdown> : <p className="text-sm text-muted-foreground italic">Empty file.</p>}
    </div>
  );

  const source = (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => edit(e.target.value)}
      onKeyDown={(e) => {
        // Tab inserts two spaces instead of leaving the editor
        if (e.key === "Tab" && !e.shiftKey && !readOnly) {
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: s, selectionEnd: end } = el;
          edit(`${value.slice(0, s)}  ${value.slice(end)}`);
          requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
        }
      }}
      readOnly={!!readOnly}
      spellCheck={isMarkdown}
      aria-label={`Contents of ${path}`}
      placeholder={missing ? "This file doesn't exist yet — start typing to create it." : undefined}
      className={cn("block w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/70", height)}
    />
  );

  return (
    <div className={cn("flex min-h-0 flex-col", fill && "h-full")}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="shrink-0">{fileIcon(path)}</span>
        <span className="min-w-0 truncate font-mono text-[13px]" title={path}>
          {path}
        </span>
        {dirty && <span className="size-2 shrink-0 rounded-full bg-warning" aria-label="Unsaved changes" title="Unsaved changes" />}
        <div className="ml-auto flex items-center gap-2">
          <SectionMenu sections={sections} onPick={jumpTo} />
          {isMarkdown && !unreadable && (
            <ToggleGroup type="single" size="sm" variant="outline" value={view} onValueChange={(v) => v && setView(v as View)} aria-label="View mode">
              <ToggleGroupItem value="edit" aria-label={readOnly ? "Source" : "Edit"} className="gap-1 px-2 text-xs">
                <PencilLine className="size-3.5" /> {readOnly ? "Source" : "Edit"}
              </ToggleGroupItem>
              <ToggleGroupItem value="split" aria-label="Side by side" title="Side by side" className="gap-1 px-2 text-xs">
                <Columns2 className="size-3.5" /> Split
              </ToggleGroupItem>
              <ToggleGroupItem value="preview" aria-label="Preview" className="gap-1 px-2 text-xs">
                <Eye className="size-3.5" /> Preview
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          {!fixedReason && !unreadable && (
            <>
              <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(null)}>
                <RotateCcw /> Revert
              </Button>
              <Button size="sm" disabled={!dirty || !!readOnly || conflict || save.isPending} onClick={() => saveRef.current()}>
                {save.isPending ? <Spinner /> : <Save />} Save
                <Kbd>{modKey}S</Kbd>
              </Button>
            </>
          )}
          {actions}
        </div>
      </div>

      {readOnly && !unreadable && (
        <div className={cn("flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground", fixedReason ? "bg-paper-2" : "bg-dream-soft")} role={fixedReason ? undefined : "status"}>
          {fixedReason ? <Lock className="size-3.5 shrink-0" /> : <Moon className="size-3.5 shrink-0 text-dream" aria-hidden />}
          <span>{readOnly}</span>
          {path === "CLAUDE.md" && (
            <Link to={`/agents/${agentId}/settings`} className="ml-auto shrink-0 font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground">
              Open settings
            </Link>
          )}
        </div>
      )}

      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/25 bg-warning/[0.07] px-4 py-2 text-xs">
          <span className="min-w-0 flex-1 basis-64 text-muted-foreground">
            <span className="font-medium text-foreground">{nameOf(path)} changed while you were editing</span> — {agentName} may have rewritten it. Reload to
            see the new version (your edits are discarded), or overwrite it with yours.
          </span>
          <span className="flex shrink-0 gap-1.5">
            <Button variant="outline" size="xs" onClick={() => setDraft(null)}>
              <RotateCcw /> Reload
            </Button>
            <Button size="xs" disabled={!!readOnly || save.isPending} onClick={() => save.mutate({ content: value, base: null })}>
              {save.isPending ? <Spinner /> : <Save />} Overwrite
            </Button>
          </span>
        </div>
      )}

      <div className={cn("relative min-h-0", fill && "flex-1")}>
        {file.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-4" style={{ width: `${40 + ((i * 37) % 55)}%` }} />
            ))}
          </div>
        ) : unreadable ? (
          <div className="grid h-full min-h-[14rem] place-items-center p-8 text-center">
            <div>
              <div className="mx-auto mb-3 grid size-11 place-items-center rounded-lg border bg-card shadow-card">{fileIcon(path, "size-5 text-muted-foreground")}</div>
              <p className="text-sm font-medium">{status === 413 ? "Too large to open here" : "Not a text file"}</p>
              <p className="mt-1 text-xs text-muted-foreground">{size ? `${formatBytes(size)} · ` : ""}Move, rename or delete it from the list.</p>
            </div>
          </div>
        ) : file.isError && !missing ? (
          <div className="p-6 text-sm text-muted-foreground">Couldn't open this file: {errorMessage(file.error)}</div>
        ) : showSource && showPreview ? (
          <div className={cn("grid grid-cols-2 divide-x", fill ? "h-full" : "")}>
            {source}
            {preview}
          </div>
        ) : showPreview ? (
          preview
        ) : (
          source
        )}
      </div>

      {!unreadable && (
        <div className="flex items-center gap-3 overflow-hidden border-t px-4 py-2 text-[11px] whitespace-nowrap text-muted-foreground">
          <span className="tabular-nums">{lines.toLocaleString()} lines</span>
          {isMarkdown && <span className="tabular-nums">{words.toLocaleString()} words</span>}
          <span className="tabular-nums">{formatBytes(new Blob([value]).size)}</span>
          {isMemory && memory.data && <MemoryBudget chars={value.length} memory={memory.data} />}
          {isMemory && <BrokenLinks paths={broken} />}
          {file.dataUpdatedAt > 0 && !dirty && <span className="ml-auto">loaded {formatDistanceToNowStrict(file.dataUpdatedAt, { addSuffix: true })}</span>}
          {dirty && <span className="ml-auto text-warning">Unsaved changes</span>}
        </div>
      )}
    </div>
  );
}

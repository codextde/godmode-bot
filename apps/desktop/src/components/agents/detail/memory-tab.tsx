import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, Folder, FolderOpen, FolderSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent, AgentFileEntry } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { FileEditor, fileIcon, nameOf, parentOf } from "@/components/files/file-editor";
import { DreamsPanel, useDreamingNow } from "./dreams-panel";

const PINNED = ["MEMORY.md", "CLAUDE.md"];
const HIDDEN = new Set([".git"]);

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

export function MemoryTab({ agent }: { agent: Agent }) {
  const { t } = useTranslation("agents");
  const [selected, setSelected] = useState<{ path: string; size: number } | null>({ path: "MEMORY.md", size: 0 });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["memory"]));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<{ path: string; size: number } | null>(null);
  const dreaming = useDreamingNow(agent.id);

  const select = (entry: { path: string; size: number }) => {
    if (entry.path === selected?.path) return;
    if (dirty) setPending(entry);
    else setSelected(entry);
  };
  const openFile = (path: string) => {
    const dirs = path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    setExpanded((s) => new Set([...s, ...dirs]));
    select({ path, size: 0 });
  };
  const toggleDir = (path: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="space-y-4">
      <DreamsPanel agent={agent} />
      <div className="grid min-h-[32rem] grid-cols-1 gap-4 @3xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="flex max-h-[70vh] min-h-0 flex-col rounded-xl border bg-card shadow-card">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-medium tracking-[-0.01em]">{t("memoryTab.files")}</h2>
              <p className="text-xs text-muted-foreground">{t("memoryTab.repository")}</p>
            </div>
            <Button asChild variant="ghost" size="xs" title={t("memoryTab.tidyUpHint")}>
              <Link
                to={`/files/${agent.id}`}
                onClick={(e) => {
                  if (!dirty) return;
                  e.preventDefault();
                  toast.warning(t("memoryTab.saveFirst"), {
                    description: selected?.path ? t("memoryTab.unsavedChanges", { path: selected.path }) : t("memoryTab.unsavedChangesFile"),
                  });
                }}
              >
                <FolderSearch /> {t("memoryTab.tidyUp")}
              </Link>
            </Button>
          </div>
          <nav aria-label={t("memoryTab.filesLabel")} className="min-h-0 flex-1 overflow-y-auto p-2">
            <Tree agentId={agent.id} dir="" depth={0} expanded={expanded} onToggle={toggleDir} selected={selected?.path ?? null} onSelect={select} />
          </nav>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col rounded-xl border bg-card shadow-card">
          {selected ? (
            <FileEditor
              key={selected.path}
              agentId={agent.id}
              agentName={agent.name}
              path={selected.path}
              size={selected.size}
              dreaming={dreaming}
              onDirtyChange={setDirty}
              onOpenFile={openFile}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-10 text-sm text-muted-foreground">{t("memoryTab.selectFile")}</div>
          )}
        </section>

        <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("memoryTab.discardTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("memoryTab.discardDescription", { path: selected?.path })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("memoryTab.keepEditing")}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setDirty(false);
                  setSelected(pending);
                  setPending(null);
                }}
              >
                {t("memoryTab.discard")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
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
  const { t } = useTranslation("agents");
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
        {t("memoryTab.empty")}
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
                "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] transition hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                active && "bg-secondary font-medium text-foreground",
              )}
            >
              {isDir ? (
                <>
                  <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                  {open ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
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

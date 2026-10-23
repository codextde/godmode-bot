import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { ArrowDownWideNarrow, Brain, Search, Unplug, X } from "lucide-react";
import type { Agent, AgentNote } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { parentOf } from "./file-editor";
import { plural } from "./use-files";

type Sort = "folder" | "modified" | "size";

export function NotesPane({ agent, selected, onSelect }: { agent: Agent; selected: string | null; onSelect: (note: AgentNote) => void }) {
  const notes = useQuery({ queryKey: qk.agentNotes(agent.id), queryFn: () => api.agents.notes(agent.id), staleTime: 30_000 });
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("folder");
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  const needle = filter.trim().toLowerCase();
  const all = notes.data ?? [];
  const unlinked = all.filter((n) => n.path.startsWith("memory/") && !n.linked).length;

  const groups = useMemo(() => {
    let list = all.filter((n) => !needle || n.title.toLowerCase().includes(needle) || n.path.toLowerCase().includes(needle));
    if (onlyUnlinked) list = list.filter((n) => n.path.startsWith("memory/") && !n.linked);
    if (sort === "modified") list = [...list].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    if (sort === "size") list = [...list].sort((a, b) => b.bytes - a.bytes);
    if (sort !== "folder") return [{ title: null as string | null, notes: list }];
    const by = new Map<string, AgentNote[]>();
    for (const n of list) {
      const key = n.path === "MEMORY.md" ? "" : parentOf(n.path);
      by.set(key, [...(by.get(key) ?? []), n]);
    }
    return [...by.entries()].map(([title, notes]) => ({ title: title || "Memory", notes }));
  }, [all, needle, sort, onlyUnlinked]);
  const shown = groups.reduce((n, g) => n + g.notes.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter notes" className="h-8 pl-8 text-[13px]" aria-label="Filter notes" />
          {filter && (
            <button type="button" aria-label="Clear" onClick={() => setFilter("")} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Sort notes">
              <ArrowDownWideNarrow />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
              <DropdownMenuRadioItem value="folder">Folder</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="modified">Last changed</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="size">Size</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {unlinked > 0 && (
        <button
          type="button"
          onClick={() => setOnlyUnlinked((v) => !v)}
          aria-pressed={onlyUnlinked}
          className={cn("flex items-center gap-2 border-b px-4 py-2 text-left text-xs transition hover:bg-accent/40", onlyUnlinked ? "bg-warning/[0.08]" : "bg-warning/[0.04]")}
        >
          <Unplug className="size-3.5 shrink-0 text-warning" />
          <span className="flex-1">
            <span className="font-medium">{plural(unlinked, "memory note")}</span> without a link from MEMORY.md
          </span>
          <span className="text-muted-foreground">{onlyUnlinked ? "Show all" : "Show only these"}</span>
        </button>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {notes.isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : notes.isError ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(notes.error)}</p>
        ) : !shown ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{needle ? "No note matches." : "No notes yet."}</p>
        ) : (
          groups.map((g) => (
            <section key={g.title ?? "all"} className="px-1.5 pt-2 pb-1">
              {g.title && <p className="truncate px-2 pb-1 font-mono text-[11px] text-muted-foreground">{g.title === "Memory" ? "Memory" : `${g.title}/`}</p>}
              <ul>
                {g.notes.map((n) => (
                  <li key={n.path}>
                    <button
                      type="button"
                      onClick={() => onSelect(n)}
                      className={cn("flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition hover:bg-accent/50", selected === n.path && "bg-secondary")}
                    >
                      {n.path === "MEMORY.md" ? <Brain className="mt-0.5 size-4 shrink-0" /> : <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", n.path.startsWith("memory/") && !n.linked ? "bg-warning" : "bg-foreground/20")} />}
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate text-[13px]", selected === n.path && "font-medium")}>{n.title}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{sort === "folder" ? n.path.slice(n.path.lastIndexOf("/") + 1) : n.path}</span>
                      </span>
                      <span className="shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                        <span className="block">{formatBytes(n.bytes)}</span>
                        <span className="block">{formatDistanceToNowStrict(new Date(n.modifiedAt))}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        {plural(all.length, "note")} · {formatBytes(all.reduce((n, x) => n + x.bytes, 0))}
      </div>
    </div>
  );
}

import { createContext, useContext, useEffect, useRef } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { create } from "zustand";
import type { MessageBlock } from "@godmode/shared";
import { AppWindow, ArrowUpRight, Loader2, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useArtifact, useChatArtifacts } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { ArtifactView, ago } from "./artifact-view";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;

/** Which artifact each chat shows beside it (not kept across restarts), and whether wide. */
interface PanelState {
  open: Record<string, string | null>;
  wide: boolean;
  show: (conversationId: string, artifactId: string) => void;
  hide: (conversationId: string) => void;
  setWide: (v: boolean) => void;
}

export const useArtifactPanel = create<PanelState>()((set) => ({
  open: {},
  wide: false,
  show: (conversationId, artifactId) => set((s) => ({ open: { ...s.open, [conversationId]: artifactId } })),
  hide: (conversationId) => set((s) => ({ open: { ...s.open, [conversationId]: null } })),
  setWide: (wide) => set({ wide }),
}));

/** Lets cards in a chat open the chat's side panel. Without it (a run log) a card links to the artifact's page. */
const ArtifactScope = createContext<{ conversationId: string; openId: string | null } | null>(null);
export const ArtifactScopeProvider = ArtifactScope.Provider;

/** The artifact a card's tool call made or changed. */
export function artifactIdOf(block: ToolUseBlock): string | null {
  const input = (block.input ?? {}) as { id?: unknown };
  if (typeof input.id === "string" && input.id.startsWith("art_")) return input.id;
  return /\(id (art_[A-Za-z0-9_-]+)/.exec(block.result ?? "")?.[1] ?? null;
}

export function ArtifactCard({ block, streaming }: { block: ToolUseBlock; streaming: boolean }) {
  const scope = useContext(ArtifactScope);
  const show = useArtifactPanel((s) => s.show);
  const id = artifactIdOf(block);
  const { data: artifact } = useArtifact(id);
  const input = (block.input ?? {}) as { title?: string; note?: string; html?: string; edits?: unknown[]; data?: unknown };
  const creating = block.name.endsWith("artifact_create");
  const pending = !block.result && streaming;
  const failed = !!block.isError;
  const title = artifact?.title ?? input.title ?? "Artifact";
  const what = creating
    ? "Built it"
    : input.html || input.edits
      ? input.note || "Changed the code"
      : input.data !== undefined
        ? "Updated the data"
        : "Updated it";
  const open = scope && id ? () => show(scope.conversationId, id) : null;
  const isOpen = !!scope && scope.openId === id;

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card p-2.5 pr-3 shadow-card transition",
        failed && "border-destructive/30",
        open && !failed && "cursor-pointer hover:border-foreground/15",
        isOpen && "border-brand/40 ring-2 ring-brand/15",
      )}
      onClick={open && !failed ? open : undefined}
    >
      <span className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border bg-gradient-to-br from-brand-soft to-transparent text-brand-strong">
        {pending ? <Loader2 className="size-[18px] animate-spin" /> : <AppWindow className="size-[18px]" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.01em]">{title}</p>
        <p className={cn("truncate text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
          {failed
            ? truncate(block.result ?? "It didn't work", 140)
            : pending
              ? creating
                ? "Building…"
                : "Changing it…"
              : `${what}${artifact ? ` · v${artifact.version} · ${ago(artifact.updatedAt)}` : ""}`}
        </p>
      </div>
      {!failed && id && !pending && (
        open ? (
          <Button
            size="sm"
            variant={isOpen ? "secondary" : "outline"}
            className="shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
          >
            <PanelRightOpen /> {isOpen ? "Showing" : "Open"}
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link to={`/artifacts/${id}`}>
              Open <ArrowUpRight />
            </Link>
          </Button>
        )
      )}
    </div>
  );
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The artifact beside a chat. */
export function ArtifactPanel({ id, onHide }: { id: string; onHide: () => void }) {
  const wide = useArtifactPanel((s) => s.wide);
  const setWide = useArtifactPanel((s) => s.setWide);
  const width = wide ? "min(72vw, 1100px)" : "min(48vw, 720px)";
  return (
    <motion.aside
      aria-label="Artifact"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 36 }}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="h-full" style={{ width }}>
        <ArtifactView id={id} variant="panel" onClose={onHide} expanded={wide} onExpand={setWide} />
      </div>
    </motion.aside>
  );
}

/**
 * Opens the panel by itself when the agent builds or changes an artifact in this chat while the human watches. The
 * first list only sets the baseline: opening an old chat shows nothing until something changes.
 */
export function useAutoOpenArtifacts(conversationId: string, enabled: boolean) {
  const { data } = useChatArtifacts(conversationId);
  const show = useArtifactPanel((s) => s.show);
  const seen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    seen.current = null;
  }, [conversationId]);
  useEffect(() => {
    if (!data) return;
    const before = seen.current;
    seen.current = new Map(data.map((a) => [a.id, `${a.version}`]));
    if (!before || !enabled) return;
    const changed = data.find((a) => before.get(a.id) !== `${a.version}`);
    if (changed) show(conversationId, changed.id);
  }, [data, enabled, conversationId, show]);
  return data ?? [];
}

export function ArtifactToggle({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Show the artifact" onClick={onClick} className="gap-1.5 px-2 text-muted-foreground">
          <AppWindow />
          {count > 1 && <span className="text-xs tabular-nums">{count}</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{count > 1 ? `Show the artifacts (${count})` : "Show the artifact"}</TooltipContent>
    </Tooltip>
  );
}

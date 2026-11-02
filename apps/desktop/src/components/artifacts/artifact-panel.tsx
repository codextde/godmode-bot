import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { ArtifactSummary, MessageBlock } from "@godmode/shared";
import { AppWindow, ArrowUpRight, Loader2, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useArtifact, useChatArtifacts } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { PANEL, useReduceAnimations } from "@/lib/motion";
import { artifactFrameFiles } from "./artifact-frame";
import { ArtifactView, ago } from "./artifact-view";
import { LivePreview, hasLivePreview, type LiveInput } from "./live-preview";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;

/** Which artifact each chat shows beside it (not kept across restarts). */
interface PanelState {
  open: Record<string, string | null>;
  show: (conversationId: string, artifactId: string) => void;
  hide: (conversationId: string) => void;
}

export const useArtifactPanel = create<PanelState>()((set) => ({
  open: {},
  show: (conversationId, artifactId) => set((s) => ({ open: { ...s.open, [conversationId]: artifactId } })),
  hide: (conversationId) => set((s) => ({ open: { ...s.open, [conversationId]: null } })),
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
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["artifacts", "common"]);
  const scope = useContext(ArtifactScope);
  const show = useArtifactPanel((s) => s.show);
  const id = artifactIdOf(block);
  const { data: artifact } = useArtifact(id);
  const input = (block.input ?? {}) as {
    title?: string;
    note?: string;
    html?: string;
    spec?: unknown;
    htmlPath?: string;
    edits?: unknown[];
    data?: unknown;
    dataPath?: string;
    files?: unknown[];
  };
  const creating = block.name.endsWith("artifact_create");
  const pending = !block.result && streaming;
  const failed = !!block.isError;
  const title = artifact?.title ?? input.title ?? t("card.artifact");
  const what = creating
    ? t("card.built")
    : input.html || input.spec || input.htmlPath || input.edits
      ? input.note || t("card.changedCode")
      : input.data !== undefined || input.dataPath
        ? t("card.updatedData")
        : input.files?.length
          ? t("card.addedFiles", { count: input.files.length })
          : t("card.updated");
  const open = scope && id ? () => show(scope.conversationId, id) : null;
  const isOpen = !!scope && scope.openId === id;
  const live = pending && !failed && hasLivePreview(input as LiveInput);

  const card = (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
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
            ? truncate(block.result ?? t("card.failed"), 140)
            : pending
              ? creating
                ? t("card.building")
                : t("card.changing")
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
            <PanelRightOpen /> {isOpen ? t("card.showing") : t("common:actions.open")}
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link to={`/artifacts/${id}`}>
              {t("common:actions.open")} <ArrowUpRight />
            </Link>
          </Button>
        )
      )}
    </motion.div>
  );

  return (
    <div className="space-y-2">
      {card}
      <AnimatePresence initial={false}>
        {live && (
          <motion.div
            key="live"
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: reduce ? 0 : 0.2 }}
          >
            <LivePreview input={input as LiveInput} title={title} files={artifactFrameFiles(artifact)} className="h-[360px]" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The artifact beside a chat. */
const PANEL_MIN = 360;
const CHAT_MIN = 420;
const panelMax = () => Math.max(PANEL_MIN, window.innerWidth - CHAT_MIN);
const panelDefault = () => Math.min(Math.round(window.innerWidth * 0.48), 720);
const clampPanel = (width: number) => Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, width)));

export function ArtifactPanel({ id, onHide, siblings, onSwitch }: { id: string; onHide: () => void; siblings?: ArtifactSummary[]; onSwitch?: (id: string) => void }) {
  const { t } = useTranslation("artifacts");
  const stored = useUi((s) => s.artifactPanelWidth);
  const setStored = useUi((s) => s.setArtifactPanelWidth);
  const [resizing, setResizing] = useState(false);
  const [, rerender] = useState(0);
  useEffect(() => {
    const onResize = () => rerender((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const width = clampPanel(stored ?? panelDefault());

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let dragged = false;
    const move = (ev: globalThis.PointerEvent) => {
      const dx = startX - ev.clientX;
      if (!dragged && Math.abs(dx) < 3) return;
      if (!dragged) {
        dragged = true;
        setResizing(true);
      }
      setStored(clampPanel(startWidth + dx));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 96 : 32;
    if (e.key === "ArrowLeft") setStored(clampPanel(width + step));
    else if (e.key === "ArrowRight") setStored(clampPanel(width - step));
    else return;
    e.preventDefault();
  };

  return (
    <motion.aside
      aria-label={t("card.artifact")}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={resizing ? { duration: 0 } : PANEL}
      className={cn("relative h-full shrink-0 border-l bg-paper-2", resizing && "select-none")}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("view.resize")}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={panelMax()}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setStored(null)}
        className={cn(
          "absolute inset-y-0 -left-2 z-20 w-4 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:transition-colors hover:after:bg-border focus-visible:after:bg-ring",
          resizing && "after:bg-border",
        )}
      />
      <div className={cn("h-full overflow-hidden", resizing && "pointer-events-none")}>
        <div className="h-full" style={{ width }}>
          <ArtifactView id={id} variant="panel" onClose={onHide} siblings={siblings} onSwitch={onSwitch} />
        </div>
      </div>
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
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

export function ArtifactToggle({ artifacts, onPick }: { artifacts: ArtifactSummary[]; onPick: (id: string) => void }) {
  const { t } = useTranslation("artifacts");
  if (artifacts.length > 1) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={t("toggle.showMany", { count: artifacts.length })} className="gap-1.5 px-2 text-muted-foreground">
            <AppWindow />
            <span className="text-xs tabular-nums">{artifacts.length}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
          {artifacts.map((a) => (
            <DropdownMenuItem key={a.id} onSelect={() => onPick(a.id)}>
              <AppWindow /> <span className="truncate">{a.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("toggle.showOne")} onClick={() => artifacts[0] && onPick(artifacts[0].id)} className="gap-1.5 px-2 text-muted-foreground">
          <AppWindow />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("toggle.showOne")}</TooltipContent>
    </Tooltip>
  );
}

import { useContext, useEffect, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import type { Agent, CharacterMood, MessageBlock } from "@godmode/shared";
import { BABY_FACE_SCALE, babyCharacter, defaultCharacter, readableModelId, reportPreview, shortenPaths } from "@godmode/shared";
import { ArrowUpRight, ChevronRight, PanelRightOpen } from "lucide-react";
import { SidePanelScope, useChatSidePanel } from "@/components/side-panel/store";
import { Character } from "@/components/character";
import { formatDuration, formatElapsed, formatTokens, useModelLabel } from "@/components/runs/run-status";
import { ThinkingState } from "@/components/aicss/ThinkingState";
import { useNow } from "@/components/vault/use-now";
import { useEasyMode } from "@/lib/mode";
import { EASE_OUT, useReduceAnimations } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { Collapse, MessageBlocks } from "./message-blocks";
import { describeTool, describeToolEasy, type ToolContext } from "./tool-meta";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;

export type SubagentEntry = { block: ToolUseBlock; children: MessageBlock[] };

export type ParentAgent = Pick<Agent, "id" | "name" | "color" | "character">;

export const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

export type Phase = "running" | "done" | "failed" | "stopped";

const MOOD: Record<Phase, CharacterMood> = { running: "working", done: "happy", failed: "error", stopped: "sleeping" };

export function subagentState(block: ToolUseBlock, streaming: boolean) {
  const task = block.task;
  const background = task?.background ?? block.result?.startsWith("Async agent launched") ?? false;
  const status = task ? (task.status === "running" && !streaming ? "stopped" : task.status) : null;
  const running = status ? status === "running" : !background && streaming && block.result === undefined && !block.isError;
  const failed = status === "failed" || !!block.isError;
  const result = background ? task?.summary : block.result;
  const phase: Phase = running ? "running" : failed ? "failed" : status === "stopped" ? "stopped" : "done";
  return { task, background, status, running, failed, result, phase };
}

function useSubagentSide(id: string) {
  const scope = useContext(SidePanelScope);
  const show = useChatSidePanel((s) => s.show);
  const hide = useChatSidePanel((s) => s.hide);
  if (!scope) return null;
  const active = scope.current?.kind === "subagent" && scope.current.id === id;
  return { active, toggle: () => (active ? hide(scope.conversationId) : show(scope.conversationId, { kind: "subagent", id })) };
}

export function subagentAnchor(id: string) {
  return `subagent-${id}`;
}

export function runningBackgroundSubagents(blocks: MessageBlock[]): ToolUseBlock[] {
  return blocks
    .filter((b): b is ToolUseBlock => b.type === "tool_use" && !b.parentToolUseId && SUBAGENT_TOOLS.has(b.name))
    .filter((b) => {
      const s = subagentState(b, true);
      return s.background && s.running;
    });
}

export function SubagentAvatar({ agent, phase, size, seed, className }: { agent?: ParentAgent; phase: Phase; size: number; seed: string; className?: string }) {
  const base = agent?.id ?? agent?.name ?? "agent";
  const character = useMemo(() => babyCharacter(agent?.character ?? defaultCharacter(base)), [agent?.character, base]);
  return <Character character={character} color={agent?.color ?? "violet"} mood={MOOD[phase]} size={size} faceScale={BABY_FACE_SCALE} phaseSeed={seed} className={className} />;
}

export function useSubagentView(block: ToolUseBlock, childBlocks: MessageBlock[], streaming: boolean, ctx: ToolContext) {
  const { t } = useTranslation(["chat", "common"]);
  const easy = useEasyMode();
  const modelLabel = useModelLabel();
  const meta = (easy ? describeToolEasy : describeTool)(block.name, block.input, ctx);
  const state = subagentState(block, streaming);
  const { task, phase, result } = state;
  const input = (block.input ?? {}) as { model?: unknown };
  const model = task?.model ?? (typeof input.model === "string" ? input.model : undefined);
  const steps = Math.max(childBlocks.filter((b) => b.type === "tool_use").length, task?.toolUses ?? 0);
  const preview = result ? reportPreview(result) : "";
  const status =
    phase === "running"
      ? shortenPaths(task?.activity ?? "") || t("blocks.starting")
      : phase === "failed"
        ? preview || t("common:status.failed")
        : phase === "stopped"
          ? t("blocks.stopped")
          : preview;
  const stats = [
    steps > 0 && t("blocks.steps", { count: steps }),
    !easy && !!task?.totalTokens && t("blocks.tokens", { tokens: formatTokens(task.totalTokens) }),
    !easy && !!model && readableModelId(modelLabel(model)),
  ].filter((s): s is string => !!s);
  return { ...state, meta, status, stats, type: easy ? undefined : meta.detail };
}

export function SubagentBody({ childBlocks, running, background, result, agent }: { childBlocks: MessageBlock[]; running: boolean; background: boolean; result?: string; agent?: ParentAgent }) {
  const { t } = useTranslation("chat");
  return (
    <div className="space-y-3">
      {childBlocks.length > 0 ? (
        <div className="border-l border-border pl-3">
          <MessageBlocks blocks={childBlocks} streaming={running} agent={agent} compact />
        </div>
      ) : running ? (
        <ThinkingState />
      ) : null}
      {result && (
        <div className="rounded-lg border bg-paper-2 p-3">
          <div className="mb-1.5 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{background ? t("blocks.subagent.report") : t("blocks.detail.result")}</div>
          <Markdown className="text-[0.85rem]">{result}</Markdown>
        </div>
      )}
    </div>
  );
}

export function TypeChip({ type }: { type?: string }) {
  if (!type) return null;
  return <span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">{type}</span>;
}

export function Timer({ since, durationMs, running }: { since?: number; durationMs?: number; running: boolean }) {
  if (running && since) return <Elapsed since={since} />;
  if (!running && durationMs) return <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{formatDuration(durationMs)}</span>;
  return null;
}

function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{formatElapsed(now - since)}</span>;
}

export function SubagentCard({ block, ctx, childBlocks, streaming, agent }: { block: ToolUseBlock; ctx: ToolContext; childBlocks: MessageBlock[]; streaming: boolean; agent?: ParentAgent }) {
  const { t } = useTranslation("chat");
  const easy = useEasyMode();
  const view = useSubagentView(block, childBlocks, streaming, ctx);
  const { task, background, running, failed, phase } = view;
  const side = useSubagentSide(block.id);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = !side && (open ?? (running && !background));
  const kind = easy
    ? background
      ? t("blocks.subagent.helperBackground")
      : t("blocks.subagent.helper")
    : background
      ? t("blocks.subagent.backgroundSubagent")
      : t("blocks.subagent.subagent");
  const waiting = running && background && streaming;

  return (
    <div id={subagentAnchor(block.id)} className={cn("scroll-mt-24 rounded-xl border bg-card shadow-card", failed && "border-destructive/30", running && "full-motion:glow-border")}>
      <button
        type="button"
        onClick={() => (side ? side.toggle() : setOpen(!expanded))}
        aria-expanded={side ? undefined : expanded}
        aria-current={side?.active ? "true" : undefined}
        title={side ? t("blocks.subagent.openSide") : undefined}
        className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-accent/40", side?.active && "bg-accent/50")}
      >
        <SubagentAvatar agent={agent} phase={phase} size={30} seed={block.id} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-sm font-medium", running && "text-shimmer")}>{view.meta.title}</span>
            <TypeChip type={view.type} />
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {kind}
            {view.status && <span className={cn(failed && "text-destructive", running && "text-foreground/80")}> · {view.status}</span>}
            {view.stats.length > 0 && <span className="tabular-nums"> · {view.stats.join(" · ")}</span>}
            {waiting && <span> · {t("blocks.background.continuesWhen")}</span>}
          </span>
        </span>
        <Timer since={task?.startedAt} durationMs={task?.durationMs} running={running} />
        {side ? (
          <PanelRightOpen className={cn("size-4 shrink-0 text-muted-foreground", side.active && "text-foreground")} />
        ) : (
          <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        )}
      </button>
      <Collapse open={expanded}>
        <div className="border-t px-3.5 py-3">
          <SubagentBody childBlocks={childBlocks} running={running} background={background} result={view.result} agent={agent} />
        </div>
      </Collapse>
    </div>
  );
}

function SubagentRow({ entry, ctx, streaming, agent }: { entry: SubagentEntry; ctx: ToolContext; streaming: boolean; agent?: ParentAgent }) {
  const { block, children } = entry;
  const view = useSubagentView(block, children, streaming, ctx);
  const { task, background, running, failed, phase } = view;
  const { t } = useTranslation("chat");
  const side = useSubagentSide(block.id);
  const [state, setOpen] = useState(false);
  const open = !side && state;

  return (
    <li id={subagentAnchor(block.id)} className="scroll-mt-24">
      <button
        type="button"
        onClick={() => (side ? side.toggle() : setOpen(!open))}
        aria-expanded={side ? undefined : open}
        aria-current={side?.active ? "true" : undefined}
        title={side ? t("blocks.subagent.openSide") : undefined}
        className={cn("group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-accent/50", side?.active && "bg-accent/50")}
      >
        <SubagentAvatar agent={agent} phase={phase} size={22} seed={block.id} />
        <span className={cn("min-w-0 shrink truncate font-medium", running && "text-shimmer")}>{view.meta.title}</span>
        <TypeChip type={view.type} />
        <span className={cn("min-w-0 flex-1 truncate text-muted-foreground", failed && "text-destructive", phase === "done" && "text-foreground/70")}>{view.status}</span>
        {view.stats.length > 0 && <span className="hidden shrink-0 text-[11px] text-muted-foreground tabular-nums @lg:inline">{view.stats.join(" · ")}</span>}
        <Timer since={task?.startedAt} durationMs={task?.durationMs} running={running} />
        {side ? (
          <PanelRightOpen className={cn("size-3.5 shrink-0 text-muted-foreground", side.active && "text-foreground")} />
        ) : (
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        )}
      </button>
      <Collapse open={open}>
        <div className="py-2 pr-2 pl-10">
          <SubagentBody childBlocks={children} running={running} background={background} result={view.result} agent={agent} />
        </div>
      </Collapse>
    </li>
  );
}

function AvatarStack({ blocks, agent, size, streaming }: { blocks: ToolUseBlock[]; agent?: ParentAgent; size: number; streaming: boolean }) {
  const shown = blocks.slice(0, 4);
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((b, i) => (
        <span key={b.id} className={cn("rounded-full bg-card ring-2 ring-card", i > 0 && "-ml-2")} style={{ zIndex: shown.length - i }}>
          <SubagentAvatar agent={agent} phase={subagentState(b, streaming).phase} size={size} seed={b.id} />
        </span>
      ))}
    </span>
  );
}

export function SubagentGroup({ entries, ctx, streaming, agent }: { entries: SubagentEntry[]; ctx: ToolContext; streaming: boolean; agent?: ParentAgent }) {
  const { t } = useTranslation("chat");
  const easy = useEasyMode();
  const states = entries.map((e) => subagentState(e.block, streaming));
  const count = (phase: Phase) => states.filter((s) => s.phase === phase).length;
  const working = count("running");
  const finished = entries.length - working;
  const anyFailed = count("failed") > 0;
  const startedAt = states.reduce<number | undefined>((min, s) => (s.task?.startedAt && (!min || s.task.startedAt < min) ? s.task.startedAt : min), undefined);
  const waiting = streaming && states.some((s) => s.running && s.background);
  const summary = (["running", "done", "failed", "stopped"] as const)
    .map((phase) => [phase, count(phase)] as const)
    .filter(([, n]) => n > 0)
    .map(([phase, n]) => t(`blocks.subagents.${phase}`, { count: n }));

  return (
    <div className={cn("rounded-xl border bg-card shadow-card", working > 0 && "full-motion:glow-border", anyFailed && working === 0 && "border-destructive/30")}>
      <div className="flex items-center gap-3 px-3 pt-2.5 pb-1.5">
        <AvatarStack blocks={entries.map((e) => e.block)} agent={agent} size={26} streaming={streaming} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{easy ? t("blocks.subagents.helpers", { count: entries.length }) : t("blocks.subagents.subagents", { count: entries.length })}</span>
          <span className="block truncate text-xs text-muted-foreground tabular-nums">
            {summary.join(" · ")}
            {waiting && <span> · {t("blocks.background.continuesWhen")}</span>}
          </span>
        </span>
        {working > 0 && startedAt && <Elapsed since={startedAt} />}
      </div>
      {working > 0 && (
        <div className="mx-3 h-0.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={entries.length} aria-valuenow={finished}>
          <motion.div className="h-full rounded-full bg-foreground/50" initial={false} animate={{ width: `${(finished / entries.length) * 100}%` }} transition={{ duration: 0.3, ease: EASE_OUT }} />
        </div>
      )}
      <ul className="space-y-0.5 px-1.5 pt-1.5 pb-1.5">
        {entries.map((e) => (
          <SubagentRow key={e.block.id} entry={e} ctx={ctx} streaming={streaming} agent={agent} />
        ))}
      </ul>
    </div>
  );
}

function useAllOffscreen(ids: string[], root: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    const container = root.current;
    const watched = key ? key.split(",") : [];
    if (!container || watched.length === 0) return;
    const seen = new Set<string>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          const id = r.target.id.slice(subagentAnchor("").length);
          if (r.isIntersecting) seen.add(id);
          else seen.delete(id);
        }
        setVisible({ key, ids: new Set(seen) });
      },
      { root: container },
    );
    for (const id of watched) {
      const el = document.getElementById(subagentAnchor(id));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key, root]);
  return ids.length > 0 && visible?.key === key && !ids.some((id) => visible.ids.has(id));
}

export function BackgroundSubagentsPill({ blocks, agent, scrollRef }: { blocks: MessageBlock[]; agent?: ParentAgent; scrollRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation("chat");
  const reduce = useReduceAnimations();
  const easy = useEasyMode();
  const working = useMemo(() => runningBackgroundSubagents(blocks), [blocks]);
  const offscreen = useAllOffscreen(
    working.map((b) => b.id),
    scrollRef,
  );
  const startedAt = working.reduce<number | undefined>((min, b) => (b.task?.startedAt && (!min || b.task.startedAt < min) ? b.task.startedAt : min), undefined);
  const count = working.length;

  return (
    <AnimatePresence>
      {offscreen && (
        <motion.button
          type="button"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
          transition={reduce ? { duration: 0.15, ease: "easeOut" } : { duration: 0.2, ease: EASE_OUT }}
          onClick={() => document.getElementById(subagentAnchor(working[0]!.id))?.scrollIntoView({ behavior: "smooth", block: "start" })}
          aria-live="polite"
          className="group absolute right-4 bottom-3 z-10 flex items-center gap-2 rounded-full glass py-1 pr-3 pl-1.5 text-xs font-medium transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <AvatarStack blocks={working} agent={agent} size={20} streaming />
          <span>{easy ? t("blocks.background.helpersCount", { count }) : t("blocks.background.subagentsCount", { count })}</span>
          {startedAt && <Elapsed since={startedAt} />}
          <ArrowUpRight aria-hidden className="size-3.5 text-muted-foreground transition group-hover:text-foreground" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

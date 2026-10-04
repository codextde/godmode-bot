import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import type { Agent, Credential, MessageBlock, ToolTaskAgent } from "@godmode/shared";
import { WORKFLOW_TOOL } from "@godmode/shared";
import { ArrowUpRight, Brain, CheckCircle2, ChevronRight, Circle, CircleDot, CornerDownRight, Info, Loader2, Lock, ShieldAlert, Square, SquareSlash, TriangleAlert, Workflow, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/common";
import { ThinkingState } from "@/components/aicss/ThinkingState";
import { ThinkingReasoning } from "@/components/aicss/ThinkingReasoning";
import { FileDiff, diffLines, type DiffRow } from "@/components/aicss/FileDiff";
import { DrawCheck } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { formatDuration, formatTokens } from "@/components/runs/run-status";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useLive } from "@/stores/live";
import { Markdown } from "./markdown";
import { UserBubble } from "./user-bubble";
import { CopyButton } from "./copy-button";
import { Lightbox } from "./lightbox";
import { PauseMarker } from "./pause";
import { QuestionCard, viewOfBlock } from "./question-card";
import { describeTool, formatToolInput, hostOf, todoItems, type ToolContext, type ToolKind, type ToolMeta } from "./tool-meta";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;
type ThinkingBlock = Extract<MessageBlock, { type: "thinking" }>;
type UserMessageBlock = Extract<MessageBlock, { type: "user_message" }>;
type PauseBlock = Extract<MessageBlock, { type: "pause" }>;
type QuestionBlock = Extract<MessageBlock, { type: "question" }>;

type Step = { type: "tool"; block: ToolUseBlock } | { type: "thought"; block: ThinkingBlock; key: string };

type Item =
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "error"; key: string; text: string }
  | { kind: "notice"; key: string; level: "info" | "warning" | "success"; text: string }
  | { kind: "command"; key: string; name: string; args: string; output: string }
  | { kind: "user-message"; key: string; block: UserMessageBlock }
  | { kind: "pause"; key: string; block: PauseBlock }
  | { kind: "question"; key: string; block: QuestionBlock }
  | { kind: "tools"; key: string; steps: Step[] }
  | { kind: "missing-login"; key: string; block: ToolUseBlock }
  | { kind: "delegate"; key: string; block: ToolUseBlock }
  | { kind: "workflow"; key: string; block: ToolUseBlock }
  | { kind: "subagent"; key: string; block: ToolUseBlock; children: MessageBlock[] };

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

function parentOf(b: MessageBlock): string | null {
  return "parentToolUseId" in b ? (b.parentToolUseId ?? null) : null;
}

const ASK_TOOLS = new Set(["ask_human", "request_approval"]);

function bareName(name: string): string {
  return name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
}

function isStandaloneTool(name: string): "missing-login" | "delegate" | "workflow" | "subagent" | null {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  if (bare === "report_missing_login") return "missing-login";
  if (bare === "agent_delegate") return "delegate";
  if (name === WORKFLOW_TOOL) return "workflow";
  if (SUBAGENT_TOOLS.has(name)) return "subagent";
  return null;
}

/** Split a flat block list into renderable items: prose, grouped tool timelines and special cards. */
function buildItems(blocks: MessageBlock[]): Item[] {
  // Nest subagent output under its Task tool_use
  const subagentIds = new Set(blocks.filter((b): b is ToolUseBlock => b.type === "tool_use" && SUBAGENT_TOOLS.has(b.name)).map((b) => b.id));
  const children = new Map<string, MessageBlock[]>();
  const top: MessageBlock[] = [];
  for (const b of blocks) {
    const p = parentOf(b);
    if (p && subagentIds.has(p)) {
      const list = children.get(p) ?? [];
      list.push(b);
      children.set(p, list);
    } else top.push(b);
  }

  const items: Item[] = [];
  let group: Extract<Item, { kind: "tools" }> | null = null;
  top.forEach((b, i) => {
    const key = `${b.type}-${i}`;
    if (b.type === "tool_use") {
      // The question card is the record of an ask; the call itself only shows when it failed.
      if (ASK_TOOLS.has(bareName(b.name)) && !b.isError) return;
      const standalone = isStandaloneTool(b.name);
      if (standalone) {
        group = null;
        if (standalone === "subagent") items.push({ kind: "subagent", key: b.id || key, block: b, children: children.get(b.id) ?? [] });
        else items.push({ kind: standalone, key: b.id || key, block: b });
        return;
      }
      if (!group) {
        group = { kind: "tools", key: `tools-${b.id || i}`, steps: [] };
        items.push(group);
      }
      group.steps.push({ type: "tool", block: b });
      return;
    }
    if (b.type === "thinking") {
      if (group) {
        group.steps.push({ type: "thought", block: b, key });
        return;
      }
      items.push({ kind: "thinking", key, text: b.text });
      return;
    }
    group = null;
    if (b.type === "text") {
      if (b.text.trim()) items.push({ kind: "text", key, text: b.text });
    } else if (b.type === "error") items.push({ kind: "error", key, text: b.text });
    else if (b.type === "notice") items.push({ kind: "notice", key, level: b.level, text: b.text });
    else if (b.type === "command") items.push({ kind: "command", key, name: b.name, args: b.args, output: b.output });
    else if (b.type === "user_message") items.push({ kind: "user-message", key: b.id, block: b });
    // A run that stands still for a question: the card says so.
    else if (b.type === "pause" && b.reason !== "question") items.push({ kind: "pause", key, block: b });
    else if (b.type === "question") items.push({ kind: "question", key: b.id, block: b });
  });
  return items;
}

function useToolContext(blocks: MessageBlock[]): ToolContext {
  const { data: agents = [] } = useAllAgents();
  const needsCredentials = useMemo(
    () => blocks.some((b) => b.type === "tool_use" && /vault_(fill|get)_(login|totp)/.test(b.name)),
    [blocks],
  );
  const { data: credentials = [] } = useQuery({
    queryKey: [...qk.credentials, "lookup"],
    queryFn: () => api.credentials.list({ workspaceId: "all" }),
    enabled: needsCredentials,
    staleTime: 60_000,
  });
  return useMemo(
    () => ({
      agentName: (id: string) => agents.find((a) => a.id === id)?.name,
      credentialLabel: (id: string) => {
        const c: Credential | undefined = credentials.find((x) => x.id === id);
        if (!c) return undefined;
        return c.domains[0] || hostOf(c.url) || c.name;
      },
    }),
    [agents, credentials],
  );
}

/** Renders an assistant turn from its structured blocks. */
export function MessageBlocks({
  blocks,
  streaming = false,
  compact = false,
  runId,
}: {
  blocks: MessageBlock[];
  streaming?: boolean;
  compact?: boolean;
  /** The run that wrote these blocks: handoff cards find the runs it handed over through it. */
  runId?: string;
}) {
  const items = useMemo(() => buildItems(blocks), [blocks]);
  const ctx = useToolContext(blocks);
  const lastBlock = blocks[blocks.length - 1];

  return (
    <div className={cn("flex min-w-0 flex-col", compact ? "gap-2" : "gap-3")}>
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        const active = streaming && isLast;
        switch (item.kind) {
          case "text":
            return (
              <div key={item.key} className="min-w-0">
                <Markdown className={cn(compact && "text-[0.85rem]", active && lastBlock?.type === "text" && "gm-streaming")}>{item.text}</Markdown>
              </div>
            );
          case "thinking":
            return <ThinkingItem key={item.key} text={item.text} active={active} />;
          case "error":
            return (
              <div key={item.key} role="alert" className="flex gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3.5 py-3 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 break-words whitespace-pre-wrap">{item.text}</div>
              </div>
            );
          case "notice":
            return <NoticeItem key={item.key} level={item.level} text={item.text} />;
          case "command":
            return <CommandOutput key={item.key} name={item.name} args={item.args} output={item.output} />;
          case "user-message":
            return <PickedUpMessage key={item.key} block={item.block} />;
          case "pause":
            return <PauseMarker key={item.key} block={item.block} />;
          case "question":
            return <QuestionCard key={item.key} question={viewOfBlock(item.block)} streaming={streaming && item.block.status === "open"} />;
          case "tools":
            return <ToolGroup key={item.key} steps={item.steps} ctx={ctx} streaming={active} />;
          case "missing-login":
            return <MissingLoginCard key={item.key} block={item.block} />;
          case "delegate":
            return <DelegateCard key={item.key} block={item.block} streaming={streaming} parentRunId={runId} />;
          case "workflow":
            return <WorkflowCard key={item.key} block={item.block} streaming={streaming} />;
          case "subagent":
            return <SubagentCard key={item.key} block={item.block} ctx={ctx} childBlocks={item.children} streaming={streaming && !item.block.result} />;
        }
      })}
      {streaming && items.length === 0 && (
        <div className="py-1">
          <ThinkingState />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Thinking & notices                                                   */
/* ------------------------------------------------------------------ */

function ThinkingItem({ text, active }: { text: string; active: boolean }) {
  if (active && !text.trim()) return <ThinkingState />;
  return <ThinkingReasoning text={text} active={active} />;
}

/** A message the human sent while the agent worked, where the agent picked it up. */
function PickedUpMessage({ block }: { block: UserMessageBlock }) {
  const sent = new Date(block.sentAt);
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }} className="flex flex-col items-end py-1">
      <UserBubble content={block.text} attachments={block.attachments} />
      <span className="mt-1 inline-flex items-center gap-1 pr-1 text-[11px] text-muted-foreground">
        <CornerDownRight className="size-3" aria-hidden />
        Picked up mid-task
        {!Number.isNaN(sent.getTime()) && (
          <time dateTime={block.sentAt} className="tabular-nums">
            · sent {format(sent, "p")}
          </time>
        )}
      </span>
    </motion.div>
  );
}

function NoticeItem({ level, text }: { level: "info" | "warning" | "success"; text: string }) {
  const meta = {
    info: { icon: Info, cls: "border-border bg-card text-muted-foreground" },
    warning: { icon: TriangleAlert, cls: "border-warning/30 bg-warning/[0.07] text-warning" },
    success: { icon: CheckCircle2, cls: "border-success/25 bg-success/[0.07] text-success" },
  }[level];
  const Icon = meta.icon;
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]", meta.cls)}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

const MARKDOWN_HINT = /^\s{0,3}(#{1,6}\s|[-*]\s|\|)|\*\*|`/m;
const PREFORMATTED = /\n[ \t]{2,}\S/;

/** Output of a slash command Claude Code ran locally — markdown when it is markdown, aligned text stays monospace. */
function CommandOutput({ name, args, output }: { name: string; args: string; output: string }) {
  const long = output.length > 1200 || output.split("\n").length > 24;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card" data-command={name}>
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <SquareSlash className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono font-medium">/{name}</span>
        {args && <span className="min-w-0 truncate font-mono text-muted-foreground">{args}</span>}
        <span className="ml-auto shrink-0 text-muted-foreground">Claude Code</span>
      </div>
      <div className={cn("relative px-3.5 py-3", long && !expanded && "max-h-80 overflow-hidden")}>
        {!output ? (
          <p className="text-sm text-muted-foreground">Done.</p>
        ) : MARKDOWN_HINT.test(output) ? (
          <Markdown className="text-[0.9rem]">{output}</Markdown>
        ) : PREFORMATTED.test(output) ? (
          <pre className="font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">{output}</pre>
        ) : (
          <p className="text-[0.9rem] leading-relaxed break-words whitespace-pre-wrap">{output}</p>
        )}
        {long && !expanded && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 border-t py-1.5 text-xs text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
        >
          {expanded ? "Show less" : "Show all"}
          <ChevronRight className={cn("size-3 transition-transform", expanded ? "-rotate-90" : "rotate-90")} />
        </button>
      )}
    </div>
  );
}

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Tool timeline                                                        */
/* ------------------------------------------------------------------ */

/** Monochrome by default; the brand green is reserved for vault steps (secrets handled safely). */
const KIND_TONE: Partial<Record<ToolKind, string>> = {
  vault: "text-brand-strong bg-brand-soft border-brand/25",
};

function toneFor(kind: ToolKind) {
  return KIND_TONE[kind] ?? "text-foreground/70 bg-card border-border";
}

const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

type FileEditInput = { file_path?: string; notebook_path?: string; old_string?: string; new_string?: string; content?: string; edits?: { old_string?: string; new_string?: string }[] };

/** Diff rows for file-editing tools (Edit / MultiEdit / Write), or null for anything else. */
function fileEditOf(block: ToolUseBlock): { file: string; rows: DiffRow[] } | null {
  const input = (block.input ?? {}) as FileEditInput;
  const file = input.file_path ?? input.notebook_path ?? "";
  if (block.name === "Edit" && typeof input.new_string === "string") return { file, rows: diffLines(input.old_string ?? "", input.new_string) };
  if (block.name === "Write" && typeof input.content === "string") return { file, rows: diffLines("", input.content) };
  if (block.name === "MultiEdit" && Array.isArray(input.edits)) {
    const rows: DiffRow[] = [];
    input.edits.forEach((e, i) => {
      if (i > 0) rows.push({ old: null, cur: null, type: "fold", text: "⋯" });
      rows.push(...diffLines(e.old_string ?? "", e.new_string ?? ""));
    });
    return { file, rows };
  }
  return null;
}

function imageSrc(image: string): string {
  if (image.startsWith("data:")) return image;
  const mime = image.startsWith("/9j/") ? "image/jpeg" : image.startsWith("R0lG") ? "image/gif" : image.startsWith("UklG") ? "image/webp" : "image/png";
  return `data:${mime};base64,${image}`;
}

function stepRunning(block: ToolUseBlock, streaming: boolean) {
  return streaming && block.result === undefined && !block.isError;
}

function ToolGroup({ steps, ctx, streaming }: { steps: Step[]; ctx: ToolContext; streaming: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const tools = steps.filter((s): s is Extract<Step, { type: "tool" }> => s.type === "tool");
  const metas = tools.map((s) => describeTool(s.block.name, s.block.input, ctx));
  const runningIdx = streaming ? tools.findIndex((s) => stepRunning(s.block, true)) : -1;
  const failed = tools.filter((s) => s.block.isError).length;
  const images = tools.filter((s) => s.block.image).map((s) => s.block.image!);
  const expanded = manual ?? streaming;
  const single = tools.length === 1 && steps.length === 1;

  if (tools.length === 0) {
    // Only thoughts — render them plainly
    return (
      <div className="space-y-2">
        {steps.map((s) => s.type === "thought" && <ThinkingItem key={s.key} text={s.block.text} active={streaming} />)}
      </div>
    );
  }

  const current = runningIdx >= 0 ? metas[runningIdx] : metas[metas.length - 1];
  const uniqueIcons = Array.from(new Map(metas.map((m) => [m.icon, m])).values()).slice(-3);

  if (single) {
    return <ToolStep block={tools[0].block} meta={metas[0]} running={runningIdx === 0} standalone />;
  }

  return (
    <div className={cn("rounded-xl border bg-card shadow-card", runningIdx >= 0 && "glow-border")}>
      <button
        type="button"
        onClick={() => setManual(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-accent/40"
      >
        <span className="flex -space-x-1.5">
          {uniqueIcons.map((m, i) => {
            const Icon = m.icon;
            return (
              <span key={i} className={cn("grid size-6 place-items-center rounded-full border ring-2 ring-card", toneFor(m.kind))}>
                <Icon className="size-3" />
              </span>
            );
          })}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm">
            {runningIdx >= 0 ? (
              <span className="text-shimmer truncate font-medium">{current.title}…</span>
            ) : (
              <span className="truncate font-medium">{current.title}</span>
            )}
          </span>
          <span className="block text-xs text-muted-foreground">
            {tools.length} steps
            {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
          </span>
        </span>
        {!expanded && images.length > 0 && (
          <span className="hidden gap-1 @lg:flex">
            {images.slice(-3).map((img, i) => (
              <img key={i} src={imageSrc(img)} alt="" className="h-8 w-12 rounded-md border object-cover object-top" />
            ))}
          </span>
        )}
        {runningIdx >= 0 && <Orb variant="S3" size={16} label={current.title} />}
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
      </button>
      <Collapse open={expanded}>
        <ol className="space-y-0.5 px-3 pt-1 pb-3">
          {steps.map((s, i) => {
            const last = i === steps.length - 1;
            if (s.type === "thought") {
              if (!s.block.text.trim()) return null;
              return <ThoughtStep key={s.key} text={s.block.text} last={last} />;
            }
            const toolIdx = tools.findIndex((t) => t.block === s.block);
            return (
              <ToolStep
                key={s.block.id || i}
                block={s.block}
                meta={metas[toolIdx]}
                running={toolIdx === runningIdx}
                last={last}
                incomplete={!streaming && s.block.result === undefined && !s.block.isError}
              />
            );
          })}
        </ol>
      </Collapse>
    </div>
  );
}

function ThoughtStep({ text, last }: { text: string; last: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="relative pl-9">
      {!last && <span aria-hidden className="absolute top-7 bottom-0 left-[13px] w-px bg-border" />}
      <span className="absolute top-1 left-0 grid size-[27px] place-items-center rounded-full border bg-card text-muted-foreground">
        <Brain className="size-3.5" />
      </span>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full py-1.5 text-left">
        <p className={cn("text-[13px] leading-relaxed text-muted-foreground italic", !open && "line-clamp-2")}>{text.trim()}</p>
      </button>
    </li>
  );
}

function ToolStep({
  block,
  meta,
  running,
  last = true,
  standalone = false,
  incomplete = false,
}: {
  block: ToolUseBlock;
  meta: ToolMeta;
  running: boolean;
  last?: boolean;
  standalone?: boolean;
  incomplete?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = meta.icon;
  const failed = !!block.isError;
  const iconEl = (
    <span
      className={cn(
        "grid size-[27px] shrink-0 place-items-center rounded-full border",
        failed ? "border-destructive/30 bg-destructive/10 text-destructive" : toneFor(meta.kind),
      )}
    >
      {running ? <Orb variant="B2" size={15} label={meta.title} /> : <Icon className="size-3.5" />}
    </span>
  );
  // Keyed by content: streaming deltas re-create `block` on every token, but the edit itself rarely changes.
  const editKey = FILE_EDIT_TOOLS.has(block.name) ? JSON.stringify(block.input) : "";
  const edit = useMemo(() => (editKey ? fileEditOf(block) : null), [editKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      className={cn("group flex w-full items-center gap-2.5 text-left", standalone ? "px-3 py-2.5" : "py-1.5")}
    >
      {standalone && iconEl}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", failed && "text-destructive", running && "text-shimmer font-medium")}>
          {meta.title}
          {running && "…"}
        </span>
        {meta.detail && <span className="block truncate text-xs text-muted-foreground">{meta.detail}</span>}
      </span>
      {meta.kind === "vault" && !failed && (
        <span className="hidden shrink-0 items-center gap-1 rounded-[5px] border border-brand/25 bg-brand-soft px-1.5 py-0.5 text-[10.5px] font-medium text-brand-strong @lg:inline-flex">
          <Lock className="size-3" /> Secret hidden
        </span>
      )}
      {edit && !running && !failed && <DiffStat rows={edit.rows} />}
      {failed && <span className="shrink-0 text-[11px] font-medium text-destructive">Failed</span>}
      {incomplete && <span className="shrink-0 text-[11px] text-muted-foreground">No result</span>}
      <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground opacity-60 transition group-hover:opacity-100", open && "rotate-90")} />
    </button>
  );

  const body = (
    <>
      {block.image && <Screenshot image={block.image} alt={meta.title} />}
      <Collapse open={open}>
        <ToolDetails block={block} edit={edit} />
      </Collapse>
    </>
  );

  if (standalone) {
    return (
      <div className={cn("rounded-xl border bg-card shadow-card transition", failed && "border-destructive/30", running && "glow-border")}>
        {header}
        <div className={cn((block.image || open) && "px-3 pb-3")}>{body}</div>
      </div>
    );
  }

  return (
    <li className="relative pl-9">
      {!last && <span aria-hidden className="absolute top-8 bottom-0 left-[13px] w-px bg-border" />}
      <span className="absolute top-1 left-0">{iconEl}</span>
      {header}
      {body}
    </li>
  );
}

function Screenshot({ image, alt }: { image: string; alt: string }) {
  const [zoom, setZoom] = useState(false);
  const src = imageSrc(image);
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        className="mt-1 mb-1.5 block overflow-hidden rounded-lg border bg-muted/30 shadow-card transition hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label="Enlarge screenshot"
      >
        <img src={src} alt={alt} loading="lazy" className="max-h-56 w-auto max-w-full object-contain object-top" />
      </button>
      <Lightbox src={src} alt={alt} open={zoom} onOpenChange={setZoom} />
    </>
  );
}

const RESULT_PREVIEW = 1800;

function DiffStat({ rows }: { rows: DiffRow[] }) {
  const added = rows.filter((r) => r.type === "add").length;
  const removed = rows.filter((r) => r.type === "del").length;
  return (
    <span className="hidden shrink-0 items-center gap-1.5 font-mono text-[11px] @lg:inline-flex">
      <span className="text-success">+{added}</span>
      <span className="text-destructive">-{removed}</span>
    </span>
  );
}

function ToolDetails({ block, edit, inputLabel = "Input" }: { block: ToolUseBlock; edit?: { file: string; rows: DiffRow[] } | null; inputLabel?: string }) {
  const [full, setFull] = useState(false);
  if (edit) {
    return (
      <div className="mt-1 mb-2 space-y-2">
        <FileDiff file={edit.file || "file"} rows={edit.rows} />
        {block.isError && block.result && <DetailPanel label="Error" text={block.result} error />}
      </div>
    );
  }
  const todos = todoItems(block.input);
  const input = formatToolInput(block.input);
  const result = block.result ?? "";
  const shown = full || result.length <= RESULT_PREVIEW ? result : `${result.slice(0, RESULT_PREVIEW)}…`;

  return (
    <div className="mt-1 mb-2 space-y-2">
      {todos ? (
        <ul className="space-y-1.5 rounded-lg border bg-card p-3">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              {t.status === "completed" ? (
                <span className="mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full bg-brand text-white dark:text-black">
                  <DrawCheck className="size-2.5" />
                </span>
              ) : t.status === "in_progress" ? (
                <CircleDot className="mt-0.5 size-3.5 shrink-0 animate-pulse text-foreground" />
              ) : (
                <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className={cn(t.status === "completed" && "text-muted-foreground line-through")}>{t.content}</span>
            </li>
          ))}
        </ul>
      ) : (
        input &&
        input !== "{}" && (
          <DetailPanel label={inputLabel} text={input} />
        )
      )}
      {block.result !== undefined && (
        <DetailPanel
          label={block.isError ? "Error" : "Result"}
          text={shown || "(empty)"}
          copyText={result}
          error={block.isError}
          footer={
            result.length > RESULT_PREVIEW && (
              <Button variant="ghost" size="xs" onClick={() => setFull((f) => !f)} className="text-muted-foreground">
                {full ? "Show less" : `Show all (${Math.round(result.length / 1000)}k chars)`}
              </Button>
            )
          }
        />
      )}
    </div>
  );
}

function DetailPanel({ label, text, copyText, error, footer }: { label: string; text: string; copyText?: string; error?: boolean; footer?: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-paper-2", error && "border-destructive/30 bg-destructive/5")}>
      <div className="flex h-7 items-center justify-between border-b pr-1 pl-3">
        <span className={cn("text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase", error && "text-destructive")}>{label}</span>
        <CopyButton text={copyText ?? text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre className={cn("max-h-72 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap", error && "text-destructive")}>{text}</pre>
      {footer && <div className="border-t px-1 py-0.5">{footer}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Special cards                                                        */
/* ------------------------------------------------------------------ */

const MISSING_KIND_LABEL: Record<string, string> = {
  missing_credential: "No saved login",
  invalid_credential: "Saved login didn't work",
  missing_totp: "2FA code needed",
  missing_account: "No account yet",
  other: "Login needed",
};

function MissingLoginCard({ block }: { block: ToolUseBlock }) {
  const input = (block.input ?? {}) as { service?: string; url?: string; kind?: string; reason?: string };
  const domain = hostOf(input.url) || (input.service ?? "");
  const service = input.service || domain || "a website";
  const kind = input.kind ?? "missing_credential";
  const addLogin = `/vault/logins?new=1${domain ? `&domain=${encodeURIComponent(domain)}` : ""}`;
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-xl border border-warning/30 bg-card p-4 shadow-card"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-warning" />
      <div className="relative flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning/12 text-warning">
          <ShieldAlert className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm font-medium">I need a login for {service}</h4>
            <span className="rounded-[5px] bg-warning/12 px-1.5 py-0.5 text-[10.5px] font-medium text-warning">
              {MISSING_KIND_LABEL[kind] ?? MISSING_KIND_LABEL.other}
            </span>
          </div>
          {input.reason && <p className="mt-1 text-[13px] text-muted-foreground">{input.reason}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {kind === "missing_totp" ? (
              <Button asChild size="sm">
                <Link to="/vault/2fa?import=1">Add 2FA code</Link>
              </Button>
            ) : (
              <Button asChild size="sm">
                <Link to={addLogin}>Add login</Link>
              </Button>
            )}
            <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
              <Link to="/inbox">
                Open inbox <ArrowUpRight />
              </Link>
            </Button>
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground">Once it's saved, just ask me to try again.</p>
        </div>
      </div>
    </motion.div>
  );
}

function useAgentById(id: string | undefined): Agent | undefined {
  const { data: agents = [] } = useAllAgents();
  return id ? agents.find((a) => a.id === id) : undefined;
}

/**
 * The run a handoff started: one of the runs the parent handed over to that agent. The id in the card's result decides
 * (only this parent's own runs are candidates, so nothing an agent writes can point it elsewhere); before the result is
 * there, the newest run with that task — the one being handed over right now.
 */
function useHandedOverRun(parentRunId: string | undefined, agentId: string | undefined, task: string | undefined, result: string, refused: boolean) {
  const children = useQuery({
    queryKey: qk.runChildren(parentRunId ?? ""),
    queryFn: () => api.runs.list({ parentRunId, limit: 100 }),
    enabled: !!parentRunId && !!agentId && !refused,
    staleTime: 5_000,
  });
  const mine = (children.data ?? []).filter((r) => r.agentId === agentId);
  const wanted = task?.trim();
  const named = result ? mine.find((r) => result.includes(`(run ${r.id},`)) : undefined;
  const run =
    named ??
    (result ? undefined : wanted ? mine.find((r) => r.prompt.trimEnd().endsWith(wanted)) : undefined) ??
    (mine.length === 1 ? mine[0] : undefined);
  const live = useLive((s) => (run ? s.runs[run.id] : undefined));
  return { run, live, loading: children.isLoading };
}

function DelegateCard({ block, streaming, parentRunId }: { block: ToolUseBlock; streaming: boolean; parentRunId?: string }) {
  const input = (block.input ?? {}) as { agentId?: string; task?: string; wait?: boolean };
  const agent = useAgentById(input.agentId);
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const running = stepRunning(block, streaming);
  const result = block.result ?? "";
  // A refused handoff (not a peer, switched off, too deep…) never started a run.
  const refused = !!block.isError && !/\(run run_/.test(result);
  const { run: child, live } = useHandedOverRun(parentRunId, input.agentId, input.task, result, refused);
  const status = live?.status ?? child?.status;
  const working = status === "running" || status === "queued";
  const stop = useMutation({
    mutationFn: () => api.runs.cancel(child!.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.runs }),
    onError: (err) => toast.error("Couldn't stop it", { description: errorMessage(err) }),
  });
  const name = agent?.name ?? "the agent";
  const state =
    refused
      ? { text: "couldn't hand over", tone: "text-destructive" }
      : status === "running"
        ? { text: live?.activity && live.activity !== "Starting…" ? live.activity : "working on it…", tone: "text-shimmer" }
        : status === "queued"
          ? { text: "queued", tone: "text-muted-foreground" }
          : status === "paused"
            ? { text: "paused — open its chat to see why", tone: "text-warning" }
            : status === "succeeded"
              ? { text: "done", tone: "text-success", check: true }
              : status === "failed"
                ? { text: "failed", tone: "text-destructive" }
                : status === "cancelled"
                  ? { text: "stopped", tone: "text-muted-foreground" }
                  : running
                    ? { text: "handing over…", tone: "text-shimmer" }
                    : block.isError
                      ? { text: "failed", tone: "text-destructive" }
                      : block.result !== undefined
                        ? { text: input.wait === false ? "handed over" : "done", tone: "text-success", check: true }
                        : null;
  return (
    <div className={cn("rounded-xl border bg-card shadow-card", (running || status === "running") && "glow-border", (block.isError || status === "failed") && "border-destructive/30")}>
      <div className="flex items-start gap-3 p-3.5">
        {agent ? (
          <AgentAvatar agent={agent} size="md" />
        ) : (
          <span className="grid size-8 place-items-center rounded-lg border bg-secondary text-foreground/70">
            <Brain className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span className="text-muted-foreground">Handed to</span>
            {agent ? (
              <Link to={`/agents/${agent.id}`} className="font-semibold hover:underline">
                {agent.name}
              </Link>
            ) : (
              <span className="font-semibold">another agent</span>
            )}
            {agent?.role && <span className="text-xs text-muted-foreground">· {agent.role}</span>}
            {state && (
              <span className={cn("inline-flex min-w-0 items-center gap-1 text-xs font-medium", state.tone)} aria-live="polite">
                {state.check && <DrawCheck className="size-3.5" />}
                <span className="truncate">{state.text}</span>
              </span>
            )}
          </div>
          {input.task && <p className="mt-1 line-clamp-3 text-[13px] text-muted-foreground">{input.task}</p>}
          {child && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button asChild size="xs" variant="outline">
                <Link to={`/chat/${child.conversationId}`}>
                  <ArrowUpRight /> Open chat
                </Link>
              </Button>
              {working && (
                <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={stop.isPending} onClick={() => stop.mutate()} aria-label={`Stop ${name}'s part`}>
                  {stop.isPending ? <Loader2 className="animate-spin" /> : <Square className="size-2.5 fill-current" />} Stop
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {result && (
        <div className="border-t">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            {block.isError ? "Error details" : `${agent?.name ?? "Agent"}'s result`}
          </button>
          <Collapse open={open}>
            <div className="px-3.5 pb-3.5">
              {block.isError ? (
                <pre className="font-mono text-xs whitespace-pre-wrap text-destructive">{result}</pre>
              ) : (
                <Markdown className="text-[0.875rem]">{result}</Markdown>
              )}
            </div>
          </Collapse>
        </div>
      )}
    </div>
  );
}

function SubagentCard({ block, ctx, childBlocks, streaming }: { block: ToolUseBlock; ctx: ToolContext; childBlocks: MessageBlock[]; streaming: boolean }) {
  const meta = describeTool(block.name, block.input, ctx);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? streaming;
  const running = stepRunning(block, streaming);
  const Icon = meta.icon;
  const steps = childBlocks.filter((b) => b.type === "tool_use").length;
  return (
    <div className={cn("rounded-xl border bg-card shadow-card", running && "glow-border")}>
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-accent/40"
      >
        <span className={cn("grid size-[27px] place-items-center rounded-full border", toneFor("subagent"))}>
          {running ? <Orb variant="B5" size={15} label={meta.title} /> : <Icon className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-medium", running && "text-shimmer")}>{meta.title}</span>
          <span className="block text-xs text-muted-foreground">
            Subagent{meta.detail ? ` · ${meta.detail}` : ""}
            {steps > 0 && ` · ${steps} steps`}
          </span>
        </span>
        <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-90")} />
      </button>
      <Collapse open={expanded}>
        <div className="space-y-3 border-t px-3.5 py-3">
          {childBlocks.length > 0 ? (
            <div className="border-l border-border pl-3">
              <MessageBlocks blocks={childBlocks} streaming={running} compact />
            </div>
          ) : running ? (
            <ThinkingState />
          ) : null}
          {block.result && (
            <div className="rounded-lg border bg-paper-2 p-3">
              <div className="mb-1.5 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">Result</div>
              <Markdown className="text-[0.85rem]">{block.result}</Markdown>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

const AGENT_STATE_LABEL: Record<ToolTaskAgent["state"], string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed" };

/** Agents of a workflow by phase, phases in the order their first agent was queued. */
function agentPhases(agents: ToolTaskAgent[]): { phase: string; agents: ToolTaskAgent[] }[] {
  const phases = new Map<string, ToolTaskAgent[]>();
  for (const a of agents) phases.set(a.phase, [...(phases.get(a.phase) ?? []), a]);
  return Array.from(phases, ([phase, list]) => ({ phase, agents: list }));
}

function WorkflowAgent({ agent, live }: { agent: ToolTaskAgent; live: boolean }) {
  // An agent still queued or running when its workflow ended never finished.
  const running = live && agent.state === "running";
  const label = live || agent.state === "done" || agent.state === "failed" ? AGENT_STATE_LABEL[agent.state] : "Not finished";
  return (
    <li className="flex items-center gap-2 text-[13px]">
      {agent.state === "done" ? (
        <span aria-hidden className="grid size-3.5 shrink-0 place-items-center rounded-full bg-brand text-white dark:text-black">
          <DrawCheck className="size-2.5" />
        </span>
      ) : agent.state === "failed" ? (
        <XCircle aria-hidden className="size-3.5 shrink-0 text-destructive" />
      ) : running ? (
        <CircleDot aria-hidden className="size-3.5 shrink-0 animate-pulse text-foreground" />
      ) : (
        <Circle aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className={cn("min-w-0 flex-1 truncate", agent.state === "done" && "text-muted-foreground", agent.state === "failed" && "text-destructive")}>
        {agent.label}
        <span className="sr-only"> — {label}</span>
      </span>
      {running && agent.lastTool ? (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{agent.lastTool}</span>
      ) : (
        !!agent.tokens && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatTokens(agent.tokens)} tokens</span>
      )}
    </li>
  );
}

/** A Claude Code workflow: the agents it runs, by phase, kept up to date while it works. */
function WorkflowCard({ block, streaming }: { block: ToolUseBlock; streaming: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [details, setDetails] = useState(false);
  const task = block.task;
  const input = (block.input ?? {}) as { name?: unknown; script?: unknown };
  const name = task?.description || (typeof input.name === "string" ? input.name : "");
  const title = name || "Workflow";
  // A workflow still running on a turn that has ended was cut off with its run.
  const status = task ? (task.status === "running" && !streaming ? "stopped" : task.status) : null;
  const running = status ? status === "running" : stepRunning(block, streaming);
  const failed = status === "failed" || !!block.isError;
  const expanded = open ?? running;
  const agents = task?.agents ?? [];
  const phases = agentPhases(agents);
  const done = agents.filter((a) => a.state === "done").length;
  const state = failed
    ? "Failed"
    : status === "running"
      ? task?.activity || "Running…"
      : status === "completed"
        ? "Completed"
        : status === "stopped"
          ? "Stopped"
          : running
            ? "Starting…"
            : block.result === undefined
              ? "No result"
              : "";
  const stats = [
    agents.length > 0 && `${done}/${agents.length} agents`,
    !!task?.totalTokens && `${formatTokens(task.totalTokens)} tokens`,
    !!task?.durationMs && formatDuration(task.durationMs),
  ].filter(Boolean);
  const script = typeof input.script === "string" ? input.script : "";

  return (
    <div className={cn("rounded-xl border bg-card shadow-card", failed && "border-destructive/30", running && "glow-border")}>
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        disabled={agents.length === 0}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition enabled:hover:bg-accent/40"
      >
        <span
          className={cn(
            "grid size-[27px] shrink-0 place-items-center rounded-full border",
            failed ? "border-destructive/30 bg-destructive/10 text-destructive" : toneFor("subagent"),
          )}
        >
          {running ? <Orb variant="B5" size={15} label={title} /> : <Workflow className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-medium", running && "text-shimmer")}>{title}</span>
          {(name || state) && (
            <span className="block truncate text-xs text-muted-foreground">
              {name && "Workflow"}
              {name && state && " · "}
              {state && <span className={cn(failed && "text-destructive")}>{state}</span>}
            </span>
          )}
        </span>
        {agents.length > 0 && <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />}
      </button>
      {block.isError && block.result && (
        <p className="line-clamp-4 px-3 pb-2.5 font-mono text-xs break-words whitespace-pre-wrap text-destructive">{block.result}</p>
      )}
      <Collapse open={expanded && agents.length > 0}>
        <div className="max-h-64 space-y-2.5 overflow-y-auto border-t px-3.5 py-3">
          {phases.map(({ phase, agents: list }) => (
            <div key={phase}>
              {phase && <div className="mb-1.5 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{phase}</div>}
              <ul className="space-y-1.5">
                {list.map((a, i) => (
                  <WorkflowAgent key={i} agent={a} live={status === "running"} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Collapse>
      <div className="border-t">
        <div className="flex items-center gap-3 pr-3.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => setDetails((d) => !d)}
            aria-expanded={details}
            className="flex flex-1 items-center gap-1.5 py-2 pl-3.5 text-left font-medium transition hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", details && "rotate-90")} />
            Details
          </button>
          {stats.length > 0 && <span className="min-w-0 truncate tabular-nums">{stats.join(" · ")}</span>}
        </div>
        <Collapse open={details}>
          <div className="px-3 pb-1">
            <ToolDetails block={script ? { ...block, input: script } : block} inputLabel={script ? "Script" : undefined} />
          </div>
        </Collapse>
      </div>
    </div>
  );
}

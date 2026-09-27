import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import type { Agent, Credential, MessageBlock } from "@godmode/shared";
import {
  ArrowUpRight,
  Brain,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  Info,
  Loader2,
  Lock,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AgentAvatar } from "@/components/common";
import { ThinkingState } from "@/components/aicss/ThinkingState";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { CopyButton } from "./copy-button";
import { describeTool, formatToolInput, hostOf, todoItems, type ToolContext, type ToolKind, type ToolMeta } from "./tool-meta";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;
type ThinkingBlock = Extract<MessageBlock, { type: "thinking" }>;

type Step = { type: "tool"; block: ToolUseBlock } | { type: "thought"; block: ThinkingBlock; key: string };

type Item =
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "error"; key: string; text: string }
  | { kind: "notice"; key: string; level: "info" | "warning" | "success"; text: string }
  | { kind: "tools"; key: string; steps: Step[] }
  | { kind: "missing-login"; key: string; block: ToolUseBlock }
  | { kind: "delegate"; key: string; block: ToolUseBlock }
  | { kind: "subagent"; key: string; block: ToolUseBlock; children: MessageBlock[] };

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

function parentOf(b: MessageBlock): string | null {
  return "parentToolUseId" in b ? (b.parentToolUseId ?? null) : null;
}

function isStandaloneTool(name: string): "missing-login" | "delegate" | "subagent" | null {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  if (bare === "report_missing_login") return "missing-login";
  if (bare === "agent_delegate") return "delegate";
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
export function MessageBlocks({ blocks, streaming = false, compact = false }: { blocks: MessageBlock[]; streaming?: boolean; compact?: boolean }) {
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
                <Markdown className={cn(compact && "text-[0.85rem]")}>{item.text}</Markdown>
                {active && lastBlock?.type === "text" && <span aria-hidden className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-pulse rounded-full bg-primary" />}
              </div>
            );
          case "thinking":
            return <ThinkingItem key={item.key} text={item.text} active={active} />;
          case "error":
            return (
              <div key={item.key} role="alert" className="flex gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 break-words whitespace-pre-wrap">{item.text}</div>
              </div>
            );
          case "notice":
            return <NoticeItem key={item.key} level={item.level} text={item.text} />;
          case "tools":
            return <ToolGroup key={item.key} steps={item.steps} ctx={ctx} streaming={active} />;
          case "missing-login":
            return <MissingLoginCard key={item.key} block={item.block} />;
          case "delegate":
            return <DelegateCard key={item.key} block={item.block} streaming={streaming} />;
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
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  if (active) {
    return (
      <div className="space-y-1.5">
        <ThinkingState />
        {trimmed && (
          <p className="line-clamp-3 border-l-2 border-primary/25 pl-3 text-[13px] leading-relaxed text-muted-foreground/80 italic">
            {trimmed.length > 360 ? `…${trimmed.slice(-360)}` : trimmed}
          </p>
        )}
      </div>
    );
  }
  if (!trimmed) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md py-0.5 text-[13px] text-muted-foreground transition hover:text-foreground"
      >
        <Brain className="size-3.5" />
        Thought process
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <Collapse open={open}>
        <p className="mt-1.5 border-l-2 border-border pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{trimmed}</p>
      </Collapse>
    </div>
  );
}

function NoticeItem({ level, text }: { level: "info" | "warning" | "success"; text: string }) {
  const meta = {
    info: { icon: Info, cls: "border-border bg-muted/40 text-muted-foreground" },
    warning: { icon: TriangleAlert, cls: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
    success: { icon: CheckCircle2, cls: "border-success/30 bg-success/10 text-success" },
  }[level];
  const Icon = meta.icon;
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-[13px]", meta.cls)}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
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

const KIND_TONE: Partial<Record<ToolKind, string>> = {
  browser: "text-sky-500 bg-sky-500/10 border-sky-500/20",
  vault: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
  delegate: "text-violet-500 bg-violet-500/10 border-violet-500/20",
  agents: "text-violet-500 bg-violet-500/10 border-violet-500/20",
  subagent: "text-violet-500 bg-violet-500/10 border-violet-500/20",
  web: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20",
  plan: "text-amber-500 bg-amber-500/10 border-amber-500/20",
  notify: "text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/20",
};

function toneFor(kind: ToolKind) {
  return KIND_TONE[kind] ?? "text-muted-foreground bg-muted/60 border-border";
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
    <div className="rounded-2xl border bg-card/40">
      <button
        type="button"
        onClick={() => setManual(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-accent/30"
      >
        <span className="flex -space-x-1.5">
          {uniqueIcons.map((m, i) => {
            const Icon = m.icon;
            return (
              <span key={i} className={cn("grid size-6 place-items-center rounded-full border bg-background ring-2 ring-background", toneFor(m.kind))}>
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
          <span className="hidden gap-1 sm:flex">
            {images.slice(-3).map((img, i) => (
              <img key={i} src={imageSrc(img)} alt="" className="h-8 w-12 rounded-md border object-cover object-top" />
            ))}
          </span>
        )}
        {runningIdx >= 0 && <Loader2 className="size-4 animate-spin text-primary" />}
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
      <span className="absolute top-1 left-0 grid size-[27px] place-items-center rounded-full border bg-background text-muted-foreground">
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
      {running ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
    </span>
  );

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
        <span className="hidden shrink-0 items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 sm:inline-flex dark:text-emerald-400">
          <Lock className="size-3" /> Secret hidden
        </span>
      )}
      {failed && <span className="shrink-0 text-[11px] font-medium text-destructive">Failed</span>}
      {incomplete && <span className="shrink-0 text-[11px] text-muted-foreground">No result</span>}
      <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground opacity-60 transition group-hover:opacity-100", open && "rotate-90")} />
    </button>
  );

  const body = (
    <>
      {block.image && <Screenshot image={block.image} alt={meta.title} />}
      <Collapse open={open}>
        <ToolDetails block={block} />
      </Collapse>
    </>
  );

  if (standalone) {
    return (
      <div className={cn("rounded-2xl border bg-card/40 transition hover:bg-card/60", failed && "border-destructive/30")}>
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
        className="mt-1 mb-1.5 block overflow-hidden rounded-xl border bg-muted/30 shadow-sm transition hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label="Enlarge screenshot"
      >
        <img src={src} alt={alt} loading="lazy" className="max-h-56 w-auto max-w-full object-contain object-top" />
      </button>
      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="max-w-[min(92vw,1200px)] p-2 sm:max-w-[min(92vw,1200px)]">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img src={src} alt={alt} className="max-h-[85vh] w-full rounded-lg object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

const RESULT_PREVIEW = 1800;

function ToolDetails({ block }: { block: ToolUseBlock }) {
  const [full, setFull] = useState(false);
  const todos = todoItems(block.input);
  const input = formatToolInput(block.input);
  const result = block.result ?? "";
  const shown = full || result.length <= RESULT_PREVIEW ? result : `${result.slice(0, RESULT_PREVIEW)}…`;

  return (
    <div className="mt-1 mb-2 space-y-2">
      {todos ? (
        <ul className="space-y-1 rounded-xl border bg-background/40 p-3">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              {t.status === "completed" ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : t.status === "in_progress" ? (
                <CircleDot className="mt-0.5 size-3.5 shrink-0 text-primary" />
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
          <DetailPanel label="Input" text={input} />
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
    <div className={cn("overflow-hidden rounded-xl border bg-muted/40 dark:bg-black/25", error && "border-destructive/30 bg-destructive/5")}>
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
      className="relative overflow-hidden rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] p-4"
    >
      <div aria-hidden className="pointer-events-none absolute -top-10 -right-10 size-32 rounded-full bg-amber-500/15 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <ShieldAlert className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm font-semibold">I need a login for {service}</h4>
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
              {MISSING_KIND_LABEL[kind] ?? MISSING_KIND_LABEL.other}
            </span>
          </div>
          {input.reason && <p className="mt-1 text-[13px] text-muted-foreground">{input.reason}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {kind === "missing_totp" ? (
              <Button asChild size="sm" className="bg-amber-500 text-black hover:bg-amber-400">
                <Link to="/vault/2fa?import=1">Add 2FA code</Link>
              </Button>
            ) : (
              <Button asChild size="sm" className="bg-amber-500 text-black hover:bg-amber-400">
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

function DelegateCard({ block, streaming }: { block: ToolUseBlock; streaming: boolean }) {
  const input = (block.input ?? {}) as { agentId?: string; task?: string; wait?: boolean };
  const agent = useAgentById(input.agentId);
  const [open, setOpen] = useState(false);
  const running = stepRunning(block, streaming);
  const result = block.result ?? "";
  return (
    <div className={cn("overflow-hidden rounded-2xl border bg-card/40", running && "glow-border", block.isError && "border-destructive/30")}>
      <div className="flex items-start gap-3 p-3.5">
        {agent ? (
          <AgentAvatar agent={agent} size="md" />
        ) : (
          <span className="grid size-9 place-items-center rounded-xl bg-violet-500/15 text-violet-500">
            <Brain className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Delegated to</span>
            {agent ? (
              <Link to={`/agents/${agent.id}`} className="font-semibold hover:underline">
                {agent.name}
              </Link>
            ) : (
              <span className="font-semibold">another agent</span>
            )}
            {running ? (
              <span className="text-shimmer text-xs font-medium">working on it…</span>
            ) : block.isError ? (
              <span className="text-xs font-medium text-destructive">failed</span>
            ) : block.result !== undefined ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                <CheckCircle2 className="size-3.5" /> {input.wait === false ? "handed off" : "done"}
              </span>
            ) : null}
          </div>
          {input.task && <p className="mt-1 line-clamp-3 text-[13px] text-muted-foreground">{input.task}</p>}
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
    <div className={cn("rounded-2xl border bg-card/40", running && "glow-border")}>
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-accent/30"
      >
        <span className={cn("grid size-[27px] place-items-center rounded-full border", toneFor("subagent"))}>
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
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
            <div className="border-l-2 border-violet-500/25 pl-3">
              <MessageBlocks blocks={childBlocks} streaming={running} compact />
            </div>
          ) : running ? (
            <ThinkingState />
          ) : null}
          {block.result && (
            <div className="rounded-xl border bg-background/40 p-3">
              <div className="mb-1.5 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">Result</div>
              <Markdown className="text-[0.85rem]">{block.result}</Markdown>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

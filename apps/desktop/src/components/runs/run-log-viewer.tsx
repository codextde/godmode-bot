import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Brain,
  ChevronRight,
  CircleCheck,
  CircleX,
  Download,
  FileJson,
  Gauge,
  MessageSquareText,
  Power,
  Reply,
  Settings2,
} from "lucide-react";
import { useLocale } from "@/i18n/language";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { saveBlob } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { describeTool, formatToolInput } from "@/components/chat/tool-meta";
import { Markdown } from "@/components/chat/markdown";
import { LiveDot } from "@/components/aicss/Motion";
import { CopyButton } from "@/components/chat/copy-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { formatDuration, formatTokens } from "./run-status";

type Json = Record<string, unknown>;

export type LogEntry =
  | { kind: "init"; raw: string; model: string; tools: number; mcp: { name: string; status: string }[]; cwd: string }
  | { kind: "text"; raw: string; text: string; sub: boolean }
  | { kind: "thinking"; raw: string; text: string }
  | { kind: "tool_use"; raw: string; id: string; name: string; input: unknown; sub: boolean }
  | { kind: "tool_result"; raw: string; toolUseId: string; content: string; isError: boolean; images: number }
  | {
      kind: "result";
      raw: string;
      subtype: string;
      isError: boolean;
      durationMs: number | null;
      numTurns: number | null;
      tokensIn: number | null;
      tokensOut: number | null;
    }
  | { kind: "rate_limit"; raw: string; status: string; detail: string }
  | { kind: "system"; raw: string; subtype: string }
  | { kind: "stream"; raw: string; eventType: string }
  | { kind: "other"; raw: string; type: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function resultContent(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (Array.isArray(content)) {
    let images = 0;
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === "object") {
        const o = c as Json;
        if (o.type === "text") parts.push(str(o.text));
        else if (o.type === "image") images++;
        else parts.push(JSON.stringify(o));
      }
    }
    return { text: parts.join("\n"), images };
  }
  return { text: content == null ? "" : JSON.stringify(content, null, 2), images: 0 };
}

/** Turn Claude CLI stream-json lines into displayable entries. */
export function parseRunLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    let ev: Json;
    try {
      ev = JSON.parse(raw);
    } catch {
      out.push({ kind: "other", raw, type: "text" });
      continue;
    }
    const type = str(ev.type);
    const sub = !!ev.parent_tool_use_id;
    if (type === "system" && ev.subtype === "init") {
      const mcp = Array.isArray(ev.mcp_servers)
        ? (ev.mcp_servers as Json[]).map((m) => ({ name: str(m.name), status: str(m.status) }))
        : [];
      out.push({
        kind: "init",
        raw,
        model: str(ev.model),
        tools: Array.isArray(ev.tools) ? ev.tools.length : 0,
        mcp,
        cwd: str(ev.cwd),
      });
    } else if (type === "system") {
      out.push({ kind: "system", raw, subtype: str(ev.subtype) || "system" });
    } else if (type === "assistant") {
      const content = ((ev.message as Json | undefined)?.content ?? []) as Json[];
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === "text" && str(block.text).trim()) out.push({ kind: "text", raw, text: str(block.text), sub });
        else if (block.type === "thinking") out.push({ kind: "thinking", raw, text: str(block.thinking) });
        else if (block.type === "redacted_thinking") out.push({ kind: "thinking", raw, text: "" });
        else if (block.type === "tool_use")
          out.push({ kind: "tool_use", raw, id: str(block.id), name: str(block.name), input: block.input, sub });
      }
    } else if (type === "user") {
      const content = ((ev.message as Json | undefined)?.content ?? []) as unknown;
      if (Array.isArray(content)) {
        for (const block of content as Json[]) {
          if (block?.type === "tool_result") {
            const { text: t, images } = resultContent(block.content);
            out.push({ kind: "tool_result", raw, toolUseId: str(block.tool_use_id), content: t, isError: !!block.is_error, images });
          } else if (block?.type === "text" && str(block.text).trim()) {
            out.push({ kind: "other", raw, type: "user" });
          }
        }
      } else if (typeof content === "string") {
        out.push({ kind: "other", raw, type: "user" });
      }
    } else if (type === "result" || (ev.total_cost_usd !== undefined && ev.duration_ms !== undefined)) {
      const usage = (ev.usage ?? {}) as Json;
      out.push({
        kind: "result",
        raw,
        subtype: str(ev.subtype) || str(ev.stop_reason) || "done",
        isError: !!ev.is_error,
        durationMs: num(ev.duration_ms),
        numTurns: num(ev.num_turns),
        tokensIn: num(usage.input_tokens),
        tokensOut: num(usage.output_tokens),
      });
    } else if (type === "rate_limit_event") {
      const info = (ev.rate_limit_info ?? {}) as Json;
      const windows = (info.unifiedWindows ?? {}) as Record<string, Json>;
      const detail = Object.entries(windows)
        .map(([k, w]) => `${k.replace("_", " ")} ${Math.round((num(w.utilization) ?? 0) * 100)}%`)
        .join(" · ");
      out.push({ kind: "rate_limit", raw, status: str(info.status) || "unknown", detail });
    } else if (type === "stream_event") {
      out.push({ kind: "stream", raw, eventType: str((ev.event as Json | undefined)?.type) || "event" });
    } else {
      out.push({ kind: "other", raw, type: type || "event" });
    }
  }
  return out;
}

async function fetchLog(id: string): Promise<string> {
  const res = (await api.runs.log(id)) as unknown;
  if (typeof res === "string") return res;
  if (res instanceof Blob) return res.text();
  if (Array.isArray(res)) return res.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
  if (res && typeof res === "object") {
    const o = res as Json;
    if (typeof o.log === "string") return o.log;
    if (Array.isArray(o.lines)) return (o.lines as unknown[]).map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
    return JSON.stringify(res);
  }
  return "";
}

const PAGE = 300;

export function RunLogViewer({ runId, live = false }: { runId: string; live?: boolean }) {
  const { t } = useTranslation("runs");
  const { intlLocale } = useLocale();
  const [showStream, setShowStream] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const log = useQuery({
    queryKey: [...qk.run(runId), "log"],
    queryFn: () => fetchLog(runId),
    refetchInterval: live ? 3000 : false,
  });
  const entries = useMemo(() => parseRunLog(log.data ?? ""), [log.data]);
  const toolNames = useMemo(() => {
    const m = new Map<string, { name: string; input: unknown }>();
    for (const e of entries) if (e.kind === "tool_use") m.set(e.id, { name: e.name, input: e.input });
    return m;
  }, [entries]);
  const streamCount = entries.filter((e) => e.kind === "stream").length;
  const visible = entries.filter((e) => showStream || e.kind !== "stream");

  if (log.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (log.isError) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("log.loadFailed", { error: errorMessage(log.error) })}</p>;
  }
  if (!entries.length) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("log.empty")}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">{t("log.events", { count: entries.length, formatted: entries.length.toLocaleString(intlLocale) })}</span>
        {live && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-strong">
            <LiveDot /> {t("log.live")}
          </span>
        )}
        {streamCount > 0 && (
          <div className="flex items-center gap-2">
            <Switch id={`stream-${runId}`} size="sm" checked={showStream} onCheckedChange={setShowStream} />
            <Label htmlFor={`stream-${runId}`} className="text-xs font-normal text-muted-foreground">
              {t("log.streamingDeltas", { count: streamCount })}
            </Label>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <CopyButton text={log.data ?? ""} label={t("log.copy")} />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("log.download")}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void saveBlob(new Blob([log.data ?? ""], { type: "application/x-ndjson" }), `run-${runId}.jsonl`)}
          >
            <Download />
          </Button>
        </div>
      </div>
      <ol className="relative space-y-1 border-l pl-4">
        {visible.slice(0, limit).map((e, i) => (
          <LogRow key={i} entry={e} toolNames={toolNames} />
        ))}
      </ol>
      {visible.length > limit && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setLimit((l) => l + PAGE)}>
          {t("log.showMore", { shown: Math.min(PAGE, visible.length - limit), total: visible.length - limit })}
        </Button>
      )}
    </div>
  );
}

function LogRow({ entry, toolNames }: { entry: LogEntry; toolNames: Map<string, { name: string; input: unknown }> }) {
  const { t } = useTranslation("runs");
  switch (entry.kind) {
    case "init":
      return (
        <Row icon={<Power className="size-3.5 text-foreground" />} title={t("log.sessionStarted")} raw={entry.raw}>
          <span className="text-muted-foreground">
            {entry.model || t("log.model")} · {t("log.tools", { count: entry.tools })}
            {entry.mcp.length > 0 && ` · MCP: ${entry.mcp.map((m) => `${m.name}${m.status && m.status !== "connected" ? ` (${m.status})` : ""}`).join(", ")}`}
          </span>
        </Row>
      );
    case "text":
      return (
        <Row icon={<MessageSquareText className="size-3.5 text-foreground" />} title={entry.sub ? t("log.subagentSaid") : t("log.assistant")} raw={entry.raw} defaultOpen>
          <Markdown className="text-[13px]">{entry.text}</Markdown>
        </Row>
      );
    case "thinking":
      return (
        <Row
          icon={<Brain className="size-3.5 text-muted-foreground" />}
          title={t("log.thinking")}
          summary={entry.text ? entry.text.replace(/\s+/g, " ").slice(0, 90) : t("log.redacted")}
          raw={entry.raw}
        >
          {entry.text ? <p className="whitespace-pre-wrap text-muted-foreground">{entry.text}</p> : <p className="text-muted-foreground italic">{t("log.thinkingRedacted")}</p>}
        </Row>
      );
    case "tool_use": {
      const meta = describeTool(entry.name, entry.input);
      const Icon = meta.icon;
      return (
        <Row
          icon={<Icon className="size-3.5 text-foreground" />}
          title={meta.title}
          summary={meta.detail ?? entry.name}
          raw={entry.raw}
          badge={entry.sub ? t("log.subagent") : undefined}
        >
          <Pre text={formatToolInput(entry.input)} />
        </Row>
      );
    }
    case "tool_result": {
      const tool = toolNames.get(entry.toolUseId);
      const title = tool ? describeTool(tool.name, tool.input).title : t("log.toolResult");
      return (
        <Row
          icon={entry.isError ? <CircleX className="size-3.5 text-destructive" /> : <Reply className="size-3.5 text-muted-foreground" />}
          title={entry.isError ? t("log.failedTool", { title }) : t("log.resultTool", { title })}
          summary={entry.images ? t("log.images", { count: entry.images }) : entry.content.replace(/\s+/g, " ").slice(0, 90)}
          raw={entry.raw}
          tone={entry.isError ? "error" : undefined}
        >
          <Pre text={entry.content || (entry.images ? t("log.imageResult") : t("detail.empty"))} />
        </Row>
      );
    }
    case "result":
      return (
        <Row
          icon={entry.isError ? <CircleX className="size-3.5 text-destructive" /> : <CircleCheck className="size-3.5 text-success" />}
          title={entry.isError ? t("log.finishedError", { subtype: entry.subtype }) : t("log.finished")}
          raw={entry.raw}
          tone={entry.isError ? "error" : "success"}
        >
          <span className="text-muted-foreground tabular-nums">
            {formatDuration(entry.durationMs)}
            {entry.numTurns != null && ` · ${t("log.turns", { count: entry.numTurns })}`}
            {entry.tokensIn != null && ` · ${t("log.tokens", { in: formatTokens(entry.tokensIn), out: formatTokens(entry.tokensOut) })}`}
          </span>
        </Row>
      );
    case "rate_limit":
      return (
        <Row icon={<Gauge className="size-3.5 text-muted-foreground" />} title={t("log.rateLimit", { status: entry.status })} summary={entry.detail} raw={entry.raw} muted />
      );
    case "system":
      return <Row icon={<Settings2 className="size-3.5 text-muted-foreground" />} title={`System · ${entry.subtype}`} raw={entry.raw} muted />;
    case "stream":
      return <Row icon={<FileJson className="size-3.5 text-muted-foreground" />} title={`stream · ${entry.eventType}`} raw={entry.raw} muted />;
    case "other":
      return <Row icon={<FileJson className="size-3.5 text-muted-foreground" />} title={entry.type} summary={entry.raw.slice(0, 90)} raw={entry.raw} muted />;
  }
}

function Row({
  icon,
  title,
  summary,
  children,
  raw,
  defaultOpen = false,
  muted,
  tone,
  badge,
}: {
  icon: ReactNode;
  title: string;
  summary?: string;
  children?: ReactNode;
  raw: string;
  defaultOpen?: boolean;
  muted?: boolean;
  tone?: "error" | "success";
  badge?: string;
}) {
  const { t } = useTranslation("runs");
  const [open, setOpen] = useState(defaultOpen);
  const [showRaw, setShowRaw] = useState(false);
  return (
    <li className="relative">
      <span className="absolute top-2 -left-[23px] grid size-3.5 place-items-center rounded-full bg-card ring-4 ring-card">{icon}</span>
      <div
        className={cn(
          "rounded-lg text-[13px]",
          tone === "error" && "bg-destructive/[0.05]",
          tone === "success" && "bg-success/[0.06]",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className={cn("shrink-0 font-medium", muted && "font-normal text-muted-foreground")}>{title}</span>
          {badge && <span className="shrink-0 rounded-[4px] border bg-secondary px-1 text-[10px] text-muted-foreground">{badge}</span>}
          {summary && !open && <span className="min-w-0 truncate text-muted-foreground">{summary}</span>}
        </button>
        {open && (
          <div className="space-y-2 px-2 pb-2 pl-7">
            {children}
            <div>
              <button
                type="button"
                onClick={() => setShowRaw((r) => !r)}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {showRaw ? t("log.hideRaw") : t("log.raw")}
              </button>
              {showRaw && <Pre text={prettyJson(raw)} />}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function prettyJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Pre({ text }: { text: string }) {
  const { t } = useTranslation("runs");
  const { intlLocale } = useLocale();
  return (
    <pre className="mt-1 max-h-72 overflow-auto rounded-lg border bg-paper-2 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">
      {text.length > 20_000 ? `${text.slice(0, 20_000)}\n${t("log.truncated", { count: text.length - 20_000, formatted: (text.length - 20_000).toLocaleString(intlLocale) })}` : text}
    </pre>
  );
}

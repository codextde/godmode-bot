import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { McpApp, MessageBlock } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { coreUrl } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;
type JsonRpc = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type Ask = { title: string; hint?: string; resolve: (ok: boolean) => void };
type DisplayMode = "inline" | "fullscreen";

const PROTOCOL_VERSION = "2026-01-26";
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 900;
const BUILTIN_SERVERS = new Set(["godmode", "browser", "computer", "cua", "vm", "ssh", "android"]);

export function mcpServerOf(name: string): string | null {
  const m = /^mcp__(.+?)__.+$/.exec(name);
  return m && !BUILTIN_SERVERS.has(m[1]!) && !m[1]!.startsWith("composio") ? m[1]! : null;
}

const STYLE_VARS: [string, string][] = [
  ["--color-background-primary", "--background"],
  ["--color-background-secondary", "--card"],
  ["--color-background-tertiary", "--muted"],
  ["--color-text-primary", "--foreground"],
  ["--color-text-secondary", "--muted-foreground"],
  ["--color-text-danger", "--destructive"],
  ["--color-border-primary", "--border"],
  ["--color-border-secondary", "--border"],
  ["--color-ring-primary", "--ring"],
  ["--border-radius-md", "--radius"],
];

function hostStyles(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const [key, from] of STYLE_VARS) {
    const v = css.getPropertyValue(from).trim();
    if (v) out[key] = v;
  }
  const body = getComputedStyle(document.body);
  out["--font-sans"] = body.fontFamily;
  return out;
}

function toolResultOf(block: ToolUseBlock): Record<string, unknown> {
  const text = block.result ?? "";
  let structured: unknown;
  try {
    structured = JSON.parse(text);
  } catch {
    structured = undefined;
  }
  return {
    content: [{ type: "text", text }],
    ...(structured && typeof structured === "object" && !Array.isArray(structured) ? { structuredContent: structured } : {}),
    ...(block.isError ? { isError: true } : {}),
  };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n\n");
}

function allowAttribute(p: McpApp["permissions"]): string | undefined {
  if (!p) return undefined;
  const parts = [p.camera && "camera", p.microphone && "microphone", p.geolocation && "geolocation", p.clipboardWrite && "clipboard-write"].filter(Boolean);
  return parts.length ? parts.join("; ") : undefined;
}

export function McpAppSlot({ conversationId, block }: { conversationId: string; block: ToolUseBlock }) {
  const { data } = useQuery({
    queryKey: ["mcp-app", conversationId, block.name],
    queryFn: () => api.conversations.mcpApp(conversationId, block.name),
    staleTime: Infinity,
    retry: false,
  });
  if (!data?.app) return null;
  return <McpAppView conversationId={conversationId} block={block} app={data.app} />;
}

function McpAppView({ conversationId, block, app }: { conversationId: string; block: ToolUseBlock; app: McpApp }) {
  const { t } = useTranslation("chat");
  const { resolved } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const [mode, setMode] = useState<DisplayMode>("inline");
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [reloads, setReloads] = useState(0);
  const trusted = useRef(false);
  const initialized = useRef(false);
  const nextId = useRef(1);
  const label = app.tool.annotations?.title ?? app.server;

  const src = useMemo(() => coreUrl(`/api/mcp-apps/frame?csp=${encodeURIComponent(JSON.stringify(app.csp ?? {}))}`), [app.csp]);

  const post = useCallback((msg: JsonRpc) => frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", ...msg }, "*"), []);

  const confirm = useCallback((title: string, hint?: string) => new Promise<boolean>((resolve) => setAsk({ title, hint, resolve })), []);

  const hostContext = useCallback(
    (displayMode: DisplayMode) => ({
      toolInfo: { id: block.id, tool: app.tool },
      theme: resolved,
      styles: { variables: hostStyles() },
      displayMode,
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: displayMode === "fullscreen" ? { height: window.innerHeight - 96, width: window.innerWidth - 64 } : { maxHeight: MAX_HEIGHT, width: frame.current?.clientWidth ?? 640 },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: "Godmode",
      platform: "desktop",
      deviceCapabilities: { touch: false, hover: true },
    }),
    [app.tool, block.id, resolved],
  );

  const handle = useCallback(
    async (msg: JsonRpc): Promise<unknown> => {
      const p = msg.params ?? {};
      switch (msg.method) {
        case "ui/initialize":
          return {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: { name: "Godmode", version: "1" },
            hostCapabilities: {
              openLinks: {},
              serverTools: {},
              serverResources: {},
              logging: {},
              message: { text: {} },
              sandbox: { ...(app.permissions ? { permissions: app.permissions } : {}), ...(app.csp ? { csp: app.csp } : {}) },
            },
            hostContext: hostContext(mode),
          };
        case "ping":
          return {};
        case "tools/call": {
          const name = String(p.name ?? "");
          const tool = app.appTools.find((x) => x.name === name);
          if (!tool) throw new Error(`Unknown tool ${name}`);
          if (!tool.readOnly && !trusted.current && !(await confirm(t("mcpApp.askTool", { server: label, tool: name }), t("mcpApp.askToolHint")))) {
            return { content: [{ type: "text", text: t("mcpApp.denied") }], isError: true };
          }
          return api.conversations.mcpAppCall(conversationId, { server: app.server, name, arguments: (p.arguments as Record<string, unknown>) ?? {} });
        }
        case "resources/read":
          return api.conversations.mcpAppRead(conversationId, { server: app.server, uri: String(p.uri ?? "") });
        case "ui/open-link": {
          const url = String(p.url ?? "");
          if (!/^https?:\/\//i.test(url)) return { isError: true };
          if (!trusted.current && !(await confirm(t("mcpApp.askLink", { server: label }), url))) return { isError: true };
          await openExternal(url);
          return {};
        }
        case "ui/message": {
          const text = textOf(p.content);
          if (!text) return { isError: true };
          if (!(await confirm(t("mcpApp.askMessage", { server: label }), text))) return { isError: true };
          await api.conversations.send(conversationId, { content: text });
          return {};
        }
        case "ui/request-display-mode": {
          const next: DisplayMode = p.mode === "fullscreen" ? "fullscreen" : "inline";
          setMode(next);
          return { mode: next };
        }
        case "ui/update-model-context":
          return {};
        default:
          throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
      }
    },
    [app, conversationId, confirm, hostContext, label, mode, t],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as JsonRpc & { type?: string };
      if (data?.type === "gm:shell") {
        frame.current.contentWindow?.postMessage({ type: "gm:load", doc: app.html }, "*");
        return;
      }
      if (data?.jsonrpc !== "2.0" || typeof data.method !== "string") return;
      if (data.id !== undefined) {
        const id = data.id;
        handle(data).then(
          (result) => post({ id, result: result ?? {} }),
          (err: unknown) => post({ id, error: { code: (err as { code?: number }).code ?? -32000, message: errorMessage(err) } }),
        );
        return;
      }
      if (data.method === "ui/notifications/initialized") {
        initialized.current = true;
        setLoaded(true);
        post({ method: "ui/notifications/tool-input", params: { arguments: block.input ?? {} } });
        post({ method: "ui/notifications/tool-result", params: toolResultOf(block) });
      } else if (data.method === "ui/notifications/size-changed") {
        const h = Number(data.params?.height);
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h))));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app.html, block, handle, post]);

  useEffect(() => {
    if (initialized.current) post({ method: "ui/notifications/host-context-changed", params: hostContext(mode) });
  }, [hostContext, mode, post]);

  useEffect(() => {
    const id = nextId;
    return () => {
      if (initialized.current) post({ id: `teardown-${id.current++}`, method: "ui/resource-teardown", params: {} });
    };
  }, [post, reloads]);

  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => {
      if (!initialized.current) setFailure(t("mcpApp.failed", { error: "no answer" }));
    }, 15_000);
    return () => clearTimeout(timer);
  }, [loaded, reloads, t]);

  useEffect(() => {
    if (mode !== "fullscreen") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMode("inline");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const reload = () => {
    initialized.current = false;
    setLoaded(false);
    setFailure(null);
    setReloads((n) => n + 1);
  };

  const answer = (ok: boolean, always = false) => {
    if (always) trusted.current = true;
    ask?.resolve(ok);
    setAsk(null);
  };

  const fullscreen = mode === "fullscreen";
  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card",
        fullscreen && "fixed inset-6 z-50 shadow-2xl",
        app.prefersBorder === false && !fullscreen && "border-transparent bg-transparent",
      )}
    >
      <div className="flex h-8 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-brand" />
        <span className="truncate font-medium text-foreground">{label}</span>
        <span className="truncate">· {app.tool.name}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="size-6" onClick={reload} aria-label={t("mcpApp.reload")}>
            <RotateCcw className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" onClick={() => setMode(fullscreen ? "inline" : "fullscreen")} aria-label={fullscreen ? t("mcpApp.exitFullscreen") : t("mcpApp.fullscreen")}>
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          key={reloads}
          ref={frame}
          title={`${label} · ${app.tool.name}`}
          src={src}
          sandbox="allow-scripts allow-forms"
          allow={allowAttribute(app.permissions)}
          className={cn("block w-full border-0 bg-transparent", !loaded && "opacity-0")}
          style={{ height: fullscreen ? "100%" : height }}
        />
        {!loaded && !failure && (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Spinner className="size-3.5" /> {t("mcpApp.loading")}
            </span>
          </div>
        )}
        {failure && <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-muted-foreground">{failure}</div>}
        {ask && (
          <div className="absolute inset-0 grid place-items-center bg-background/70 p-4 backdrop-blur-[2px]">
            <div className="max-w-sm space-y-2 rounded-xl border border-border bg-card p-4 shadow-lg">
              <p className="text-sm font-medium">{ask.title}</p>
              {ask.hint && <p className="line-clamp-4 text-xs break-words whitespace-pre-wrap text-muted-foreground">{ask.hint}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" onClick={() => answer(true)}>
                  {t("mcpApp.allow")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => answer(false)}>
                  {t("mcpApp.deny")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => answer(true, true)}>
                  {t("mcpApp.always")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

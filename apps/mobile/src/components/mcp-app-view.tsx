import { useQuery } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type Ref } from "react";
import { ActivityIndicator, Alert, Linking, Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import RNWebView, { type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import { artifactDocument, type McpApp, type McpAppCsp, type MessageBlock } from "@godmode/shared";
import { useFullAccess } from "./full-access";
import { Icon } from "./icon";
import { ChatScope } from "./question-card";
import { T, tap } from "./ui";
import { api, errorText, request } from "@/lib/api";
import { useChatPrefs } from "@/lib/chat-prefs";
import { intlLocale } from "@/lib/i18n";
import { newQueueId } from "@/lib/pending-queue";
import { radius, space, useColors, useIsDark, type Colors } from "@/lib/theme";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;
type JsonRpc = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type WebViewHandle = { injectJavaScript: (script: string) => void };
type DisplayMode = "inline" | "fullscreen";
/** Its class defaults its extra props to `undefined`, which TypeScript 6 turns into `never`. */
const WebView = RNWebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;

const PROTOCOL_VERSION = "2026-01-26";
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 900;
const LOAD_WAIT_MS = 15_000;
const FULL_HEAD = 44;
/** Godmode's own tool servers show no apps (and Composio's run on its side). */
const BUILTIN_SERVERS = new Set(["godmode", "browser", "computer", "cua", "vm", "ssh", "android"]);

export function mcpServerOf(name: string): string | null {
  const m = /^mcp__(.+?)__.+$/.exec(name);
  return m && !BUILTIN_SERVERS.has(m[1]!) && !m[1]!.startsWith("composio") ? m[1]! : null;
}

const appApi = {
  app: (id: string, tool: string) => request<{ app: McpApp | null }>("GET", `/api/conversations/${id}/mcp-app?tool=${encodeURIComponent(tool)}`),
  call: (id: string, input: { server: string; name: string; arguments: Record<string, unknown> }) => request<Record<string, unknown>>("POST", `/api/conversations/${id}/mcp-app/call`, input, 60_000),
  read: (id: string, input: { server: string; uri: string }) => request<Record<string, unknown>>("POST", `/api/conversations/${id}/mcp-app/read`, input, 60_000),
};

const list = (domains: string[] | undefined, fallback: string) => (domains?.length ? domains.join(" ") : fallback);

/** The computer's sandbox rules for an app (server/mcpAppFrame.ts), as a tag: no address of the computer, no key. */
function cspTag(csp: McpAppCsp | null): string {
  const resources = list(csp?.resourceDomains, "");
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: data: ${resources}`.trim(),
    `style-src 'unsafe-inline' data: ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(csp?.connectDomains, "'none'")}`,
    `frame-src ${list(csp?.frameDomains, "'none'")}`,
    `base-uri ${list(csp?.baseUriDomains, "'none'")}`,
    "worker-src blob:",
    "form-action 'none'",
  ].join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">`;
}

/**
 * In the WebView the app is its own top window, so what it posts to its "parent" would come back to itself: the bridge
 * sends that to the phone instead, and what the phone answers arrives as a message from the parent.
 */
function bridge(token: string): string {
  return `<script>(function(){var T=${JSON.stringify(token)},own=window.postMessage.bind(window);window.postMessage=function(m){try{window.ReactNativeWebView.postMessage(JSON.stringify({__gm:T,m:m}));}catch(x){}};window.__gmDeliver=function(m){own(m,"*");};})();</script>`;
}

function hostStyles(c: Colors): Record<string, string> {
  return {
    "--color-background-primary": c.background,
    "--color-background-secondary": c.surface,
    "--color-background-tertiary": c.sunken,
    "--color-text-primary": c.text,
    "--color-text-secondary": c.textMuted,
    "--color-text-danger": c.danger,
    "--color-border-primary": c.border,
    "--color-border-secondary": c.border,
    "--color-ring-primary": c.borderStrong,
    "--border-radius-md": `${radius.md}px`,
  };
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

/** The apps of a chat's finished tool calls, under the steps that made them; only when Settings → General switched them on. */
export function McpAppSlots({ steps }: { steps: { type: string }[] }) {
  const on = useChatPrefs((s) => s.mcpApps);
  const scope = useContext(ChatScope);
  const { fullAccess } = useFullAccess();
  if (!on || !scope || !fullAccess) return null;
  const blocks = (steps as MessageBlock[]).filter((s): s is ToolUseBlock => s.type === "tool_use" && s.result !== undefined && !s.isError && !!mcpServerOf(s.name));
  return (
    <>
      {blocks.map((b) => (
        <McpAppSlot key={b.id} conversationId={scope.conversationId} block={b} />
      ))}
    </>
  );
}

function McpAppSlot({ conversationId, block }: { conversationId: string; block: ToolUseBlock }) {
  const { data } = useQuery({ queryKey: ["mcp-app", conversationId, block.name], queryFn: () => appApi.app(conversationId, block.name), staleTime: Infinity, retry: false });
  const [full, setFull] = useState(false);
  if (!data?.app) return null;
  const onMode = (mode: DisplayMode) => setFull(mode === "fullscreen");
  return (
    <>
      <McpAppView conversationId={conversationId} block={block} app={data.app} mode="inline" onMode={onMode} />
      {/* A WebView can't change parents: full screen is a second one, and the card stays where it is in the chat. */}
      {full ? (
        <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setFull(false)}>
          <McpAppView conversationId={conversationId} block={block} app={data.app} mode="fullscreen" onMode={onMode} />
        </Modal>
      ) : null}
    </>
  );
}

function McpAppView({ conversationId, block, app, mode, onMode }: { conversationId: string; block: ToolUseBlock; app: McpApp; mode: DisplayMode; onMode: (mode: DisplayMode) => void }) {
  const c = useColors();
  const dark = useIsDark();
  const { t } = useTranslation("chat");
  const { width, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const fullscreen = mode === "fullscreen";
  const frame = useRef<WebViewHandle>(null);
  const [height, setHeight] = useState(240);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const trusted = useRef(false);
  const initialized = useRef(false);
  const [token] = useState(() => Math.random().toString(36).slice(2));
  const label = app.tool.annotations?.title ?? app.server;
  const doc = useMemo(() => {
    const viewport = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`;
    return artifactDocument(app.html, viewport + cspTag(app.csp) + bridge(token));
  }, [app.html, app.csp, token]);

  const post = useCallback((msg: JsonRpc) => {
    const json = JSON.stringify({ jsonrpc: "2.0", ...msg }).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, "");
    frame.current?.injectJavaScript(`window.__gmDeliver(${json});true;`);
  }, []);

  /** Asks before the app acts in the human's name; "Always" holds for this view. */
  const confirm = useCallback(
    (title: string, hint?: string, always = true) =>
      new Promise<boolean>((resolve) => {
        Alert.alert(title, hint, [
          { text: t("mcpApp.deny"), style: "cancel", onPress: () => resolve(false) },
          ...(always
            ? [
                {
                  text: t("mcpApp.always"),
                  onPress: () => {
                    trusted.current = true;
                    resolve(true);
                  },
                },
              ]
            : []),
          { text: t("mcpApp.allow"), onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
      }),
    [t],
  );

  const handle = useCallback(
    async (msg: JsonRpc): Promise<unknown> => {
      const p = msg.params ?? {};
      switch (msg.method) {
        case "ui/initialize":
          return {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: { name: "Godmode", version: "1" },
            hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, message: { text: {} }, sandbox: { ...(app.csp ? { csp: app.csp } : {}) } },
            hostContext: {
              toolInfo: { id: block.id, tool: app.tool },
              theme: dark ? "dark" : "light",
              styles: { variables: hostStyles(c) },
              displayMode: mode,
              availableDisplayModes: ["inline", "fullscreen"],
              containerDimensions: fullscreen ? { height: windowHeight - insets.top - insets.bottom - FULL_HEAD, width } : { maxHeight: MAX_HEIGHT, width: width - space.xl * 2 },
              locale: intlLocale(),
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              userAgent: "Godmode",
              platform: "mobile",
              deviceCapabilities: { touch: true, hover: false },
            },
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
          return appApi.call(conversationId, { server: app.server, name, arguments: (p.arguments as Record<string, unknown>) ?? {} });
        }
        case "resources/read":
          return appApi.read(conversationId, { server: app.server, uri: String(p.uri ?? "") });
        case "ui/open-link": {
          const url = String(p.url ?? "");
          if (!/^https?:\/\//i.test(url)) return { isError: true };
          if (!trusted.current && !(await confirm(t("mcpApp.askLink", { server: label }), url))) return { isError: true };
          await Linking.openURL(url);
          return {};
        }
        case "ui/message": {
          const text = textOf(p.content);
          if (!text) return { isError: true };
          if (!(await confirm(t("mcpApp.askMessage", { server: label }), text, false))) return { isError: true };
          await api.conversations.send(conversationId, { content: text, attachments: [], queueId: newQueueId() });
          return {};
        }
        case "ui/request-display-mode": {
          const next: DisplayMode = p.mode === "fullscreen" ? "fullscreen" : "inline";
          onMode(next);
          return { mode: next };
        }
        case "ui/update-model-context":
          return {};
        default:
          throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
      }
    },
    [app, block.id, c, confirm, conversationId, dark, fullscreen, insets.bottom, insets.top, label, mode, onMode, t, width, windowHeight],
  );

  const onMessage = (e: WebViewMessageEvent) => {
    let envelope: { __gm?: string; m?: JsonRpc };
    try {
      envelope = JSON.parse(e.nativeEvent.data) as { __gm?: string; m?: JsonRpc };
    } catch {
      return;
    }
    const data = envelope.m;
    // Only the document this view loaded talks to the app.
    if (envelope.__gm !== token || !data || data.jsonrpc !== "2.0" || typeof data.method !== "string") return;
    if (data.id !== undefined) {
      const id = data.id;
      handle(data).then(
        (result) => post({ id, result: result ?? {} }),
        (err: unknown) => post({ id, error: { code: (err as { code?: number }).code ?? -32000, message: errorText(err) } }),
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

  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => {
      if (!initialized.current) setFailure(t("mcpApp.failed", { error: "no answer" }));
    }, LOAD_WAIT_MS);
    return () => clearTimeout(timer);
  }, [loaded, attempt, t]);

  const reload = () => {
    tap();
    initialized.current = false;
    setLoaded(false);
    setFailure(null);
    setAttempt((n) => n + 1);
  };

  return (
    <View
      style={
        fullscreen
          ? { flex: 1, backgroundColor: c.background, paddingTop: insets.top, paddingBottom: insets.bottom }
          : [styles.card, { borderColor: app.prefersBorder === false ? "transparent" : c.border, backgroundColor: c.surface }]
      }
    >
      <View style={[styles.head, fullscreen && { height: FULL_HEAD }, { borderBottomColor: c.border }]}>
        <View style={[styles.dot, { backgroundColor: c.brand }]} />
        <T variant="caption" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "600" }}>
          {label}
        </T>
        <T variant="caption" muted numberOfLines={1} style={{ flex: 1 }}>
          {`· ${app.tool.name}`}
        </T>
        <Pressable accessibilityRole="button" accessibilityLabel={t("mcpApp.reload")} hitSlop={8} onPress={reload}>
          <Icon name="refresh" size={13} color={c.textMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={fullscreen ? t("mcpApp.exitFullscreen") : t("mcpApp.fullscreen")}
          hitSlop={8}
          onPress={() => {
            tap();
            onMode(fullscreen ? "inline" : "fullscreen");
          }}
        >
          <Icon name={fullscreen ? "close" : "expand"} size={13} color={c.textMuted} />
        </Pressable>
      </View>
      <View style={fullscreen ? { flex: 1 } : { height }}>
        <WebView
          key={attempt}
          ref={frame}
          source={{ html: doc }}
          originWhitelist={["*"]}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled={false}
          incognito
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          allowFileAccess={false}
          allowsLinkPreview={false}
          setSupportMultipleWindows={false}
          scrollEnabled={fullscreen || height >= MAX_HEIGHT}
          // Links leave through the host; the app itself never goes anywhere else.
          onShouldStartLoadWithRequest={(r) => r.url === "about:blank" || r.url.startsWith("about:") || r.url.startsWith("data:") || r.url.startsWith("blob:") || r.isTopFrame === false}
          onContentProcessDidTerminate={() => setAttempt((n) => n + 1)}
          style={{ backgroundColor: "transparent" }}
        />
        {!loaded && !failure ? (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <ActivityIndicator color={c.textMuted} />
          </View>
        ) : null}
        {failure ? (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.surface }]}>
            <T variant="footnote" muted style={{ textAlign: "center" }}>
              {failure}
            </T>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, borderCurve: "continuous", overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", gap: 10, height: 32, paddingHorizontal: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 6, height: 6, borderRadius: 3 },
  center: { alignItems: "center", justifyContent: "center", padding: space.lg },
});

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MonitorSmartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cloudContext, coreUrl } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { artifactDocument, bridgeScript } from "@godmode/shared";

export { standaloneDocument } from "@godmode/shared";

/**
 * Runs an artifact's HTML in the core's sandbox page (`/api/artifacts/frame`): an opaque origin with its own policy, so
 * the code can load CDN libraries but never reaches the app, its token or Godmode's API. The document gets
 * `window.godmode` (ARTIFACT_BRIDGE_DOC in @godmode/shared) and talks to the app only through postMessage.
 */

function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

export interface ArtifactFrameHandlers {
  /** The app saved data (`godmode.setData`); reject to tell the app it wasn't saved. */
  onSetData?: (data: unknown) => Promise<void>;
  onAsk?: (text: string) => void;
  onRefresh?: () => void;
  onError?: (message: string) => void;
  onReady?: () => void;
}

const SAVE_DELAY_MS = 300;

interface Session {
  key: string;
  token: string;
  loaded: boolean;
  /** The data the frame has (it sent or was sent): the same data coming back isn't sent again. */
  lastData: string;
  /** Saves not answered yet: data from the server meanwhile may be older than what the frame has. */
  pending: number;
  /** Saves close together become one: the newest data, answered for all of them. */
  queued: { data: unknown; ids: number[]; timer: ReturnType<typeof setTimeout> } | null;
}

export function ArtifactFrame({
  html,
  data,
  title,
  className,
  style,
  interactive = true,
  lazy = false,
  ...handlers
}: {
  html: string;
  data: unknown;
  title: string;
  className?: string;
  style?: CSSProperties;
  /** Off for thumbnails: no clicks, nothing saved or sent. */
  interactive?: boolean;
  lazy?: boolean;
} & ArtifactFrameHandlers) {
  const { t } = useTranslation("artifacts");
  const { resolved } = useTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  const handlersRef = useRef(handlers);
  const key = useMemo(() => hashOf(html), [html]);
  // One token per loaded document; what it said it saved isn't sent back to it.
  const session = useRef<Session>({ key: "", token: "", loaded: false, lastData: "", pending: 0, queued: null });
  const latest = useRef({ html, data, theme: resolved });
  useLayoutEffect(() => {
    handlersRef.current = handlers;
    if (session.current.key !== key) session.current = { key, token: randomToken(), loaded: false, lastData: JSON.stringify(data ?? null), pending: 0, queued: null };
    latest.current = { html, data, theme: resolved };
  });

  // Layout effect: listening before the frame's page can say it is there.
  useLayoutEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current?.contentWindow;
      if (!frame || e.source !== frame) return;
      const m = e.data as { type?: string; __gm?: string; id?: number; data?: unknown; text?: string; message?: string; url?: string } | null;
      if (!m || typeof m !== "object") return;
      const s = session.current;
      if (m.type === "gm:shell") {
        const { html: h, data: d, theme } = latest.current;
        s.loaded = true;
        s.lastData = JSON.stringify(d ?? null);
        frame.postMessage({ type: "gm:load", doc: artifactDocument(h, bridgeScript(s.token, d, theme)) }, "*");
        handlersRef.current.onReady?.();
        return;
      }
      if (m.__gm !== s.token) return;
      const reply = (id: number | undefined, ok: boolean, error?: string) => frame.postMessage({ __gm: s.token, type: "reply", id, ok, error }, "*");
      const h = handlersRef.current;
      if (m.type === "setData") {
        if (!interactive || !h.onSetData) return reply(m.id, false, "This view can't save");
        s.lastData = JSON.stringify(m.data ?? null);
        s.pending++;
        if (s.queued) clearTimeout(s.queued.timer);
        const ids = [...(s.queued?.ids ?? []), m.id ?? 0];
        const timer = setTimeout(() => {
          const batch = s.queued!;
          s.queued = null;
          const done = (ok: boolean, error?: string) => {
            s.pending -= batch.ids.length;
            for (const id of batch.ids) reply(id, ok, error);
          };
          (handlersRef.current.onSetData ?? (() => Promise.reject(new Error("This view can't save"))))(batch.data).then(
            () => done(true),
            (err: unknown) => done(false, err instanceof Error ? err.message : "Not saved"),
          );
        }, SAVE_DELAY_MS);
        s.queued = { data: m.data ?? null, ids, timer };
        return;
      }
      if (!interactive) return;
      if (m.type === "ask" && m.text?.trim()) h.onAsk?.(m.text.trim().slice(0, 500));
      else if (m.type === "refresh") h.onRefresh?.();
      else if (m.type === "error" && m.message) h.onError?.(m.message.slice(0, 300));
      else if (m.type === "open" && m.url && /^https?:\/\//i.test(m.url)) void openExternal(m.url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [interactive]);

  // New data from the agent or another window: hand it over without reloading.
  useEffect(() => {
    const s = session.current;
    const text = JSON.stringify(data ?? null);
    if (!s.loaded || s.pending > 0 || text === s.lastData) return;
    s.lastData = text;
    ref.current?.contentWindow?.postMessage({ __gm: s.token, type: "data", data: data ?? null }, "*");
  }, [data]);

  useEffect(() => {
    const s = session.current;
    if (s.loaded) ref.current?.contentWindow?.postMessage({ __gm: s.token, type: "theme", theme: resolved }, "*");
  }, [resolved]);

  if (cloudContext) {
    return (
      <div className={cn("grid place-items-center bg-paper-2 p-6 text-center", className)} style={style}>
        <div className="max-w-xs space-y-2">
          <MonitorSmartphone className="mx-auto size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t("frame.cloudTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("frame.cloudDescription")}</p>
        </div>
      </div>
    );
  }

  return (
    <iframe
      ref={ref}
      key={key}
      title={title}
      src={coreUrl("/api/artifacts/frame")}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      loading={lazy ? "lazy" : undefined}
      tabIndex={interactive ? undefined : -1}
      aria-hidden={interactive ? undefined : true}
      className={cn("block border-0 bg-transparent", !interactive && "pointer-events-none select-none", className)}
      style={style}
    />
  );
}

/** A live, scaled-down picture of an artifact (a desktop-sized page fitted to the box). */
export function ArtifactThumb({ html, data, title, className }: { html: string; data: unknown; title: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const PAGE = 1200;
  const scale = width ? width / PAGE : 0;
  return (
    <div ref={box} className={cn("relative overflow-hidden", className)}>
      {scale > 0 && (
        <ArtifactFrame
          html={html}
          data={data}
          title={title}
          interactive={false}
          lazy
          style={{ width: PAGE, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "0 0" }}
          className="absolute top-0 left-0"
        />
      )}
    </div>
  );
}

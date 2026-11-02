import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MonitorSmartphone, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cloudContext, coreUrl } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { artifactDocument, bridgeScript, type ArtifactFile } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

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
  /** Saving failed for good, after a retry. */
  onSaveError?: (message: string) => void;
  /** A review gallery's Send: called once what the page saved is saved. */
  onReviewDone?: () => void;
  /** The page wants a file shown large. */
  onViewFile?: (name: string) => void;
  /** Its document is there and parsed. */
  onReady?: () => void;
}

/** An artifact's attached files, as the frame needs them. */
export interface ArtifactFrameFiles {
  base: string | null;
  list: ArtifactFile[];
}

export const artifactFrameFiles = (a: { filesBase: string | null; files: ArtifactFile[] } | undefined): ArtifactFrameFiles | undefined =>
  a?.filesBase ? { base: a.filesBase, list: a.files } : undefined;

const SAVE_DELAY_MS = 300;
const SAVE_RETRY_MS = 1000;
/** Scripts from a slow CDN hold the page back: show what is there after this long. */
const SHOW_ANYWAY_MS = 1500;
/** The sandbox page never answered: the core is away. */
const STUCK_MS = 8000;

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
  /** Counts what the page saved: a retry of older data must not land after newer data. */
  saves: number;
}

export function ArtifactFrame({
  html,
  data,
  title,
  className,
  style,
  interactive = true,
  lazy = false,
  files,
  status = false,
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
  files?: ArtifactFrameFiles;
  /** Shows that it loads, and a way out when it doesn't. */
  status?: boolean;
} & ArtifactFrameHandlers) {
  const { t } = useTranslation("artifacts");
  const { resolved } = useTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  const handlersRef = useRef(handlers);
  const [attempt, setAttempt] = useState(0);
  const filesKey = files ? `${files.base}|${files.list.map((f) => `${f.name}:${f.updatedAt}`).join("|")}` : "";
  // New or replaced files load only with a new document: the page read the list when it started.
  const key = useMemo(() => `${hashOf(html)}-${hashOf(filesKey)}-${attempt}`, [html, filesKey, attempt]);
  const [state, setState] = useState<{ key: string; phase: "loading" | "shown" | "stuck" }>({ key, phase: "loading" });
  const phase = state.key === key ? state.phase : "loading";
  // One token per loaded document; what it said it saved isn't sent back to it.
  const session = useRef<Session>({ key: "", token: "", loaded: false, lastData: "", pending: 0, queued: null, saves: 0 });
  const latest = useRef({ html, data, theme: resolved, files });
  useLayoutEffect(() => {
    handlersRef.current = handlers;
    if (session.current.key !== key) session.current = { key, token: randomToken(), loaded: false, lastData: JSON.stringify(data ?? null), pending: 0, queued: null, saves: 0 };
    latest.current = { html, data, theme: resolved, files };
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
        const { html: h, data: d, theme, files: f } = latest.current;
        s.loaded = true;
        s.lastData = JSON.stringify(d ?? null);
        const pageFiles = f?.base ? { base: coreUrl(f.base), list: f.list } : undefined;
        frame.postMessage({ type: "gm:load", doc: artifactDocument(h, bridgeScript(s.token, d, theme, false, pageFiles)) }, "*");
        setState((now) => (now.key === s.key && now.phase === "stuck" ? { key: s.key, phase: "loading" } : now));
        return;
      }
      if (m.__gm !== s.token) return;
      const reply = (id: number | undefined, ok: boolean, error?: string) => frame.postMessage({ __gm: s.token, type: "reply", id, ok, error }, "*");
      const h = handlersRef.current;
      if (m.type === "ready") {
        setState({ key: s.key, phase: "shown" });
        h.onReady?.();
        return;
      }
      if (m.type === "setData") {
        if (!interactive || !h.onSetData) return reply(m.id, false, "This view can't save");
        s.lastData = JSON.stringify(m.data ?? null);
        s.pending++;
        const saveNumber = ++s.saves;
        if (s.queued) clearTimeout(s.queued.timer);
        const ids = [...(s.queued?.ids ?? []), m.id ?? 0];
        const timer = setTimeout(() => {
          const batch = s.queued!;
          s.queued = null;
          const done = (ok: boolean, error?: string) => {
            s.pending -= batch.ids.length;
            for (const id of batch.ids) reply(id, ok, error);
          };
          const save = () => (handlersRef.current.onSetData ?? (() => Promise.reject(new Error("This view can't save"))))(batch.data);
          // A core restarting drops a save for a moment; what the human entered shouldn't go with it.
          save()
            .catch(
              () =>
                new Promise<void>((resolve, reject) =>
                  setTimeout(() => {
                    if (s.saves !== saveNumber) resolve();
                    else save().then(resolve, reject);
                  }, SAVE_RETRY_MS),
                ),
            )
            .then(
              () => done(true),
              (err: unknown) => {
                const message = err instanceof Error ? err.message : "Not saved";
                handlersRef.current.onSaveError?.(message);
                done(false, message);
              },
            );
        }, SAVE_DELAY_MS);
        s.queued = { data: m.data ?? null, ids, timer };
        return;
      }
      if (!interactive) return;
      if (m.type === "ask" && m.text?.trim()) h.onAsk?.(m.text.trim().slice(0, 500));
      else if (m.type === "refresh") h.onRefresh?.();
      else if (m.type === "error" && m.message) h.onError?.(m.message.slice(0, 300));
      else if (m.type === "reviewDone") {
        const whenSaved = () => (s.pending > 0 ? void setTimeout(whenSaved, 100) : handlersRef.current.onReviewDone?.());
        whenSaved();
      } else if (m.type === "viewFile" && typeof (m as { name?: unknown }).name === "string") h.onViewFile?.((m as unknown as { name: string }).name);
      else if (m.type === "open" && m.url && /^(https?:\/\/|mailto:|tel:)/i.test(m.url)) void openExternal(m.url);
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

  useEffect(() => {
    if (cloudContext) return;
    const show = setTimeout(() => setState((now) => (now.key !== key || now.phase === "loading" ? { key, phase: "shown" } : now)), SHOW_ANYWAY_MS);
    const stuck = setTimeout(() => {
      if (!session.current.loaded) setState({ key, phase: "stuck" });
    }, STUCK_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(stuck);
    };
  }, [key]);

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

  const frame = (
    <iframe
      ref={ref}
      key={key}
      title={title}
      src={coreUrl("/api/artifacts/frame")}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      loading={lazy ? "lazy" : undefined}
      tabIndex={interactive ? undefined : -1}
      aria-hidden={interactive ? undefined : true}
      className={cn(
        "block border-0 bg-transparent",
        !interactive && "pointer-events-none select-none",
        phase !== "shown" && !status && lazy && "opacity-0",
        lazy && "transition-opacity duration-200",
        status ? "absolute inset-0 size-full" : className,
      )}
      style={status ? undefined : style}
    />
  );
  if (!status) return frame;
  return (
    <div className={cn("relative", className)} style={style}>
      {frame}
      {phase === "loading" && (
        <div className="absolute inset-0 grid place-items-center bg-background">
          <Spinner className="text-muted-foreground" />
        </div>
      )}
      {phase === "stuck" && (
        <div className="absolute inset-0 grid place-items-center bg-background p-6 text-center">
          <div className="max-w-xs space-y-3">
            <p className="text-sm font-medium">{t("frame.stuckTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("frame.stuckDescription")}</p>
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              <RotateCcw /> {t("frame.retry")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A live, scaled-down picture of an artifact (a desktop-sized page fitted to the box). */
export function ArtifactThumb({ html, data, title, files, className }: { html: string; data: unknown; title: string; files?: ArtifactFrameFiles; className?: string }) {
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
          files={files}
          interactive={false}
          lazy
          style={{ width: PAGE, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "0 0" }}
          className="absolute top-0 left-0"
        />
      )}
    </div>
  );
}

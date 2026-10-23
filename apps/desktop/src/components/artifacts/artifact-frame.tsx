import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MonitorSmartphone } from "lucide-react";
import { cloudContext, coreUrl } from "@/lib/core";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

/**
 * Runs an artifact's HTML in the core's sandbox page (`/api/artifacts/frame`): an opaque origin with its own policy, so
 * the code can load CDN libraries but never reaches the app, its token or Godmode's API. The document gets
 * `window.godmode` (ARTIFACT_BRIDGE_DOC in @godmode/shared) and talks to the app only through postMessage.
 */

const LIGHT = {
  bg: "#faf9f5",
  card: "#ffffff",
  fg: "#1a1a1a",
  muted: "#75716a",
  border: "rgb(38 32 22 / 0.1)",
  accent: "#0eca7b",
  "accent-fg": "#04130c",
  positive: "#087f4d",
  negative: "#d4101f",
};

const DARK = {
  bg: "#1c1b19",
  card: "#232220",
  fg: "#f4f2ed",
  muted: "#a29e96",
  border: "rgb(255 250 240 / 0.09)",
  accent: "#2fd690",
  "accent-fg": "#06140d",
  positive: "#2fd690",
  negative: "#f0525b",
};

const FONT = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

const vars = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `--gm-${k}:${v};`).join("") + `--gm-font:${FONT};`;

const BASE_STYLE = `:root{${vars(LIGHT)}color-scheme:light}:root.dark{${vars(DARK)}color-scheme:dark}html,body{margin:0}body{background:var(--gm-bg);color:var(--gm-fg);font-family:var(--gm-font);-webkit-font-smoothing:antialiased}`;

/** Runs first in the artifact's document. Kept as plain ES5 so any page can carry it. */
function bridgeScript(token: string, data: unknown, theme: "light" | "dark", standalone = false): string {
    const json = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return `<style>${BASE_STYLE}</style><base target="_blank"><script>(function(){
var T=${json(token)},P=${standalone ? "null" : "window.parent"},dl=[],tl=[],w={},n=0;
function post(m){if(!P)return;m.__gm=T;P.postMessage(m,"*");}
function call(fn,v){try{fn(v);}catch(e){report(e);}}
function report(e){post({type:"error",message:String(e&&e.message||e),stack:String(e&&e.stack||"").slice(0,2000)});}
function setTheme(t){g.theme=t;document.documentElement.classList.toggle("dark",t==="dark");tl.forEach(function(f){call(f,t);});}
var g={data:${json(data)},theme:${json(theme)},
onData:function(f){dl.push(f);call(f,g.data);return function(){dl=dl.filter(function(x){return x!==f;});};},
onTheme:function(f){tl.push(f);return function(){tl=tl.filter(function(x){return x!==f;});};},
setData:function(next){if(typeof next==="function")next=next(g.data);g.data=next;dl.forEach(function(f){call(f,next);});if(!P)return Promise.resolve(true);var id=++n;return new Promise(function(res,rej){w[id]=[res,rej];post({type:"setData",id:id,data:next});});},
ask:function(text){post({type:"ask",text:String(text||"")});},
refresh:function(){post({type:"refresh"});}};
window.godmode=g;
document.documentElement.classList.toggle("dark",g.theme==="dark");
window.addEventListener("message",function(e){if(e.source!==P)return;var m=e.data;if(!m||m.__gm!==T)return;
if(m.type==="data"){g.data=m.data;dl.forEach(function(f){call(f,m.data);});}
else if(m.type==="theme")setTheme(m.theme);
else if(m.type==="reply"&&w[m.id]){var p=w[m.id];delete w[m.id];m.ok?p[0](true):p[1](new Error(m.error||"Not saved"));}});
window.addEventListener("error",function(e){report(e.error||e.message);});
window.addEventListener("unhandledrejection",function(e){report(e.reason);});
})();</script>`;
}

/** The artifact's HTML with the bridge first in <head> (a fragment gets a document around it). */
export function artifactDocument(html: string, bridge: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + bridge + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${bridge}</head>` + html.slice(root.index + root[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  const body = doctype ? html.slice(doctype.index + doctype[0].length) : html;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${bridge}</head><body>${body}</body></html>`;
}

/** A standalone copy to download: same bridge, data saved in the file, setData kept in memory. */
export function standaloneDocument(html: string, data: unknown, theme: "light" | "dark"): string {
  return artifactDocument(html, bridgeScript("standalone", data, theme, true));
}

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
  const { resolved } = useTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const key = useMemo(() => hashOf(html), [html]);
  // One token per loaded document; what it said it saved isn't sent back to it.
  const session = useRef<{ key: string; token: string; loaded: boolean; lastData: string }>({ key: "", token: "", loaded: false, lastData: "" });
  if (session.current.key !== key) session.current = { key, token: randomToken(), loaded: false, lastData: JSON.stringify(data ?? null) };
  const latest = useRef({ html, data, theme: resolved });
  latest.current = { html, data, theme: resolved };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current?.contentWindow;
      if (!frame || e.source !== frame) return;
      const m = e.data as { type?: string; __gm?: string; id?: number; data?: unknown; text?: string; message?: string } | null;
      if (!m || typeof m !== "object") return;
      const s = session.current;
      if (m.type === "gm:shell") {
        const { html: h, data: d, theme } = latest.current;
        s.loaded = true;
        s.lastData = JSON.stringify(d ?? null);
        frame.postMessage({ type: "gm:load", doc: artifactDocument(h, bridgeScript(s.token, d, theme)) }, "*");
        return;
      }
      if (m.__gm !== s.token || !interactive) return;
      const h = handlersRef.current;
      if (m.type === "setData") {
        const text = JSON.stringify(m.data ?? null);
        s.lastData = text;
        const reply = (ok: boolean, error?: string) => frame.postMessage({ __gm: s.token, type: "reply", id: m.id, ok, error }, "*");
        if (!h.onSetData) return reply(false, "This view can't save");
        h.onSetData(m.data).then(
          () => reply(true),
          (err: unknown) => reply(false, err instanceof Error ? err.message : "Not saved"),
        );
      } else if (m.type === "ask" && m.text?.trim()) h.onAsk?.(m.text.trim().slice(0, 4000));
      else if (m.type === "refresh") h.onRefresh?.();
      else if (m.type === "error" && m.message) h.onError?.(m.message.slice(0, 500));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [interactive]);

  // New data from the agent or another window: hand it over without reloading.
  useEffect(() => {
    const s = session.current;
    const text = JSON.stringify(data ?? null);
    if (!s.loaded || text === s.lastData) return;
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
          <p className="text-sm font-medium">Open it on your computer</p>
          <p className="text-xs text-muted-foreground">Artifacts run in the Godmode app or the dashboard on your computer, not through Godmode Cloud.</p>
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
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
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

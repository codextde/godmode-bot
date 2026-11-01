import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Smartphone } from "lucide-react";
import type { AndroidDevice, AndroidInputEvent, AndroidKey } from "@godmode/shared";
import { Orb } from "@/components/aicss/Orb";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { onServerEvent, sendClientEvent, subscribeAndroid } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { screenAspect } from "./android-parts";

interface Ripple {
  id: number;
  x: number;
  y: number;
  agent: boolean;
}

const LONG_PRESS_MS = 550;
const MOVE_SLOP = 8;
const BEZEL = 0.022;

const KEY_MAP: Record<string, AndroidKey> = {
  Enter: "enter",
  Backspace: "delete",
  Tab: "tab",
  Escape: "back",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
};

function base64Bytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const canDecode = typeof window !== "undefined" && "VideoDecoder" in window;

/**
 * A phone's screen, live: H.264 decoded with WebCodecs (still pictures where the webview can't decode it). With
 * `interactive`, the human controls it — click = tap, drag = swipe, hold = long press, wheel = scroll, right click =
 * back, middle click = home, and typing goes to the focused field.
 */
export function PhoneScreen({
  device,
  interactive = false,
  className,
  onLive,
}: {
  device: AndroidDevice;
  interactive?: boolean;
  className?: string;
  /** Whether pictures are arriving (for a "Live" badge outside). */
  onLive?: (live: boolean) => void;
}) {
  const { t } = useTranslation("android");
  const qc = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const size = useRef({ width: 0, height: 0 });
  const screenSize = useRef({ width: 0, height: 0 });
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const lastFrameAt = useRef(0);
  const connected = device.state === "connected";

  const ripple = useCallback((x: number, y: number, agent: boolean) => {
    const id = Date.now() + Math.random();
    setRipples((r) => [...r.slice(-6), { id, x, y, agent }]);
    setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 700);
  }, []);

  /** Position (0–1 of the screen) → pixels inside the view, letterboxing included. */
  const place = useCallback((rx: number, ry: number) => {
    const canvas = canvasRef.current;
    const { width, height } = size.current;
    if (!canvas || !width || !height) return null;
    // The screen sits letterboxed inside the video (its edges are rounded to multiples of 16), the video inside the view.
    const sw = screenSize.current.width || width;
    const sh = screenSize.current.height || height;
    const inVideo = Math.min(width / sw, height / sh);
    const vx = (width - sw * inVideo) / 2 + rx * sw * inVideo;
    const vy = (height - sh * inVideo) / 2 + ry * sh * inVideo;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / width, rect.height / height);
    return { x: (rect.width - width * scale) / 2 + vx * scale, y: (rect.height - height * scale) / 2 + vy * scale };
  }, []);

  /* ------------------------------ the stream ------------------------------ */

  useEffect(() => {
    if (!connected) return;
    let mode: "video" | "frames" = canDecode ? "video" : "frames";
    let unsubscribe = subscribeAndroid(device.id, mode);
    let decoder: VideoDecoder | null = null;
    let waitingKey = true;
    let failures = 0;
    let lastAsk = 0;
    let disposed = false;
    setError(null);

    const draw = (source: CanvasImageSource, width: number, height: number) => {
      const canvas = canvasRef.current;
      if (!canvas || disposed) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      canvas.getContext("2d")?.drawImage(source, 0, 0, width, height);
      lastFrameAt.current = Date.now();
      setHasPicture(true);
      setError(null);
    };

    const askKeyframe = () => {
      if (Date.now() - lastAsk < 1500) return;
      lastAsk = Date.now();
      sendClientEvent({ type: "android.subscribe", deviceId: device.id, mode: "video" });
    };

    const fallBack = () => {
      decoder?.close();
      decoder = null;
      unsubscribe();
      mode = "frames";
      unsubscribe = subscribeAndroid(device.id, "frames");
    };

    const off = onServerEvent((e) => {
      if (disposed || !("deviceId" in e) || e.deviceId !== device.id) return;
      if (e.type === "android.action") {
        if (e.x === undefined || e.y === undefined) return;
        const p = place(e.toX ?? e.x, e.toY ?? e.y);
        if (p) ripple(p.x, p.y, true);
        return;
      }
      if (e.type !== "android.video") return;
      if (e.kind === "error") {
        setError(e.message);
        return;
      }
      if (e.kind === "frame") {
        size.current = { width: e.width, height: e.height };
        screenSize.current = e.screen;
        setFrameSize({ width: e.width, height: e.height });
        const img = new Image();
        img.onload = () => draw(img, e.width, e.height);
        img.src = `data:${e.mime};base64,${e.data}`;
        return;
      }
      if (mode !== "video") return;
      if (e.kind === "config") {
        decoder?.close();
        size.current = { width: e.width, height: e.height };
        screenSize.current = e.screen;
        setFrameSize({ width: e.width, height: e.height });
        waitingKey = true;
        try {
          decoder = new VideoDecoder({
            output: (frame) => {
              draw(frame, frame.displayWidth, frame.displayHeight);
              frame.close();
            },
            error: () => {
              decoder = null;
              waitingKey = true;
              failures = failures + 1;
              if (failures >= 3) fallBack();
              else askKeyframe();
            },
          });
          decoder.configure({ codec: e.codec, description: base64Bytes(e.description), optimizeForLatency: true });
        } catch {
          fallBack();
        }
        return;
      }
      if (!decoder || decoder.state !== "configured") return;
      if (waitingKey && !e.key) return;
      waitingKey = false;
      try {
        decoder.decode(new EncodedVideoChunk({ type: e.key ? "key" : "delta", timestamp: e.timestamp, data: base64Bytes(e.data) }));
        failures = 0;
      } catch {
        waitingKey = true;
        askKeyframe();
      }
    });
    return () => {
      disposed = true;
      off();
      unsubscribe();
      decoder?.close();
    };
  }, [device.id, connected, place, ripple]);

  // "Live" means a picture arrived lately — or the screen is simply unchanged (H.264 only sends changes).
  useEffect(() => {
    if (!onLive) return;
    const t = setInterval(() => onLive(connected && hasPicture && !error), 1000);
    return () => clearInterval(t);
  }, [onLive, connected, hasPicture, error]);

  /* ------------------------------- the human ------------------------------- */

  const queue = useRef<Promise<void>>(Promise.resolve());
  const lastErrorAt = useRef(0);
  const send = useCallback(
    (event: AndroidInputEvent) => {
      const frame = size.current.width ? { ...size.current } : undefined;
      queue.current = queue.current
        .then(() => api.android.input(device.id, { event, frame }).then(() => undefined))
        .catch((e) => {
          if (Date.now() - lastErrorAt.current > 3000) {
            lastErrorAt.current = Date.now();
            toastApiError(e, t("device.sendFailed"), qc);
          }
        });
    },
    [device.id, qc, t],
  );

  const textBuf = useRef("");
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushText = useCallback(() => {
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = null;
    if (textBuf.current) {
      send({ type: "text", text: textBuf.current });
      textBuf.current = "";
    }
  }, [send]);
  useEffect(() => () => flushText(), [flushText]);

  const mapPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const { width, height } = size.current;
    if (!canvas || !width || !height) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / width, rect.height / height);
    if (!scale) return null;
    const offX = (rect.width - width * scale) / 2;
    const offY = (rect.height - height * scale) / 2;
    const x = (clientX - rect.left - offX) / scale;
    const y = (clientY - rect.top - offY) / scale;
    if (x < 0 || y < 0 || x > width || y > height) return null;
    return { x: Math.round(x), y: Math.round(y), localX: clientX - rect.left, localY: clientY - rect.top };
  }, []);

  const press = useRef<{ x: number; y: number; cx: number; cy: number; at: number; held: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || !connected) return;
    viewRef.current?.focus();
    if (e.button === 2) return;
    if (e.button === 1) {
      e.preventDefault();
      send({ type: "key", key: "home" });
      return;
    }
    if (e.button !== 0) return;
    const pt = mapPoint(e.clientX, e.clientY);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    flushText();
    const start = { x: pt.x, y: pt.y, cx: e.clientX, cy: e.clientY, at: Date.now(), held: false, timer: null as ReturnType<typeof setTimeout> | null };
    start.timer = setTimeout(() => {
      if (press.current !== start) return;
      start.held = true;
      send({ type: "long_press", x: start.x, y: start.y });
      ripple(pt.localX, pt.localY, false);
    }, LONG_PRESS_MS);
    press.current = start;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current;
    if (start?.timer && Math.hypot(e.clientX - start.cx, e.clientY - start.cy) > MOVE_SLOP) {
      clearTimeout(start.timer);
      start.timer = null;
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current;
    press.current = null;
    if (!start) return;
    if (start.timer) clearTimeout(start.timer);
    if (start.held) return;
    const pt = mapPoint(e.clientX, e.clientY);
    if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) > MOVE_SLOP) {
      const end = pt ?? mapPoint(Math.min(Math.max(e.clientX, 0), window.innerWidth), e.clientY);
      if (!end) return;
      send({ type: "swipe", x: start.x, y: start.y, toX: end.x, toY: end.y, durationMs: Math.min(2000, Math.max(80, Date.now() - start.at)) });
      ripple(end.localX, end.localY, false);
      return;
    }
    if (!pt) return;
    send({ type: "tap", x: start.x, y: start.y });
    ripple(pt.localX, pt.localY, false);
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (!interactive || !connected) return;
    e.preventDefault();
    flushText();
    send({ type: "key", key: "back" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !connected) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = KEY_MAP[e.key];
    if (key) {
      e.preventDefault();
      flushText();
      send({ type: "key", key });
    } else if (e.key.length === 1) {
      e.preventDefault();
      textBuf.current += e.key;
      if (!textTimer.current) textTimer.current = setTimeout(flushText, 80);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!interactive || !connected) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    flushText();
    send({ type: "text", text: text.slice(0, 10_000) });
  };

  // Wheel = a swipe the other way (content follows the finger), collected for a moment.
  useEffect(() => {
    const el = viewRef.current;
    if (!el || !interactive || !connected) return;
    let dy = 0;
    let dx = 0;
    let at: { x: number; y: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      const pt = mapPoint(e.clientX, e.clientY);
      if (!pt) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      dx += e.deltaX * unit;
      dy += e.deltaY * unit;
      at = { x: pt.x, y: pt.y };
      if (timer != null) return;
      timer = setTimeout(() => {
        timer = null;
        const { width, height } = size.current;
        if (!at || !width) return;
        // Away from the edges, where swipes are system gestures (home, back, notifications).
        const clampX = (v: number) => Math.min(width * 0.9, Math.max(width * 0.1, v));
        const clampY = (v: number) => Math.min(height * 0.88, Math.max(height * 0.12, v));
        const limit = (d: number, edge: number) => Math.sign(d) * Math.min(Math.abs(d) * 1.2, edge * 0.6);
        const mx = limit(dx, width);
        const my = limit(dy, height);
        dx = 0;
        dy = 0;
        if (Math.abs(mx) < 4 && Math.abs(my) < 4) return;
        send({ type: "swipe", x: clampX(at.x), y: clampY(at.y), toX: clampX(at.x - mx), toY: clampY(at.y - my), durationMs: 220 });
      }, 120);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (timer) clearTimeout(timer);
    };
  }, [interactive, connected, mapPoint, send]);

  // The bezel's padding is a share of the width on every side: the outer box is shaped so the screen inside keeps its own.
  const aspect = screenAspect(device, frameSize);
  const outer = aspect / (1 - 2 * BEZEL + 2 * BEZEL * aspect);

  return (
    <div className={cn("relative mx-auto", className)} style={{ aspectRatio: outer }}>
      <div className="absolute inset-0 rounded-[clamp(18px,7%,40px)] bg-[#141414] shadow-float ring-1 ring-black/10 dark:ring-white/10" style={{ padding: `${BEZEL * 100}%` }}>
        <div
          ref={viewRef}
          tabIndex={interactive ? 0 : -1}
          role={interactive ? "application" : undefined}
          aria-label={interactive ? t("screen.ariaInteractive", { name: device.name }) : t("screen.aria", { name: device.name })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (press.current = null)}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={cn(
            "relative size-full touch-none overflow-hidden rounded-[clamp(12px,5.6%,32px)] bg-black outline-none select-none",
            interactive && connected && "cursor-pointer focus-visible:ring-2 focus-visible:ring-brand/70",
          )}
        >
          <canvas ref={canvasRef} className={cn("absolute inset-0 size-full object-contain transition-opacity duration-300", hasPicture && connected ? "opacity-100" : "opacity-0")} />
          {(!hasPicture || !connected) && (
            <span className="absolute inset-0 grid place-items-center px-6 text-center">
              <span className="flex flex-col items-center gap-2.5">
                {!connected ? (
                  <>
                    <span className="grid size-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-white/60">
                      <Smartphone className="size-4" />
                    </span>
                    <span className="text-xs text-white/60">{device.state === "unauthorized" ? t("screen.unlock") : t("state.disconnected")}</span>
                  </>
                ) : error ? (
                  <span className="text-xs text-white/70">{error}</span>
                ) : (
                  <>
                    <Orb variant="C3" size={24} label={t("screen.connectingLabel")} />
                    <span className="text-shimmer text-xs font-medium text-white/80">{t("screen.connecting")}</span>
                  </>
                )}
              </span>
            </span>
          )}
          <AnimatePresence>
            {ripples.map((r) => (
              <motion.span
                key={r.id}
                className={cn("pointer-events-none absolute size-10 rounded-full border-2", r.agent ? "border-sky-400 bg-sky-400/25" : "border-white/80 bg-white/25")}
                style={{ left: r.x - 20, top: r.y - 20 }}
                initial={{ scale: 0.3, opacity: 0.9 }}
                animate={{ scale: 1.4, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

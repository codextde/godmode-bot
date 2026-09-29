import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { AppWindow, Globe, Hand, Layers, Maximize2, Minimize2, Monitor, MousePointerClick, TriangleAlert } from "lucide-react";
import type { ComputerInputEvent, ComputerTarget } from "@godmode/shared";
import { computerTargetLabel } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { toastApiError } from "@/components/vault/vault-utils";
import { useNow } from "@/components/vault/use-now";
import { api } from "@/lib/api";
import { subscribeComputer } from "@/lib/realtime";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";
import { controlNote } from "./computer-utils";

const KEYS_WITHOUT_TEXT = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

export function targetIcon(target: ComputerTarget, className?: string) {
  const Icon = target.kind === "window" ? AppWindow : target.kind === "tab" ? Globe : target.kind === "desktop" ? Layers : Monitor;
  return <Icon className={className} />;
}

interface Ripple {
  id: number;
  x: number;
  y: number;
  agent: boolean;
}

/**
 * Live picture of a shared window, tab or display, with takeover: clicks, double/right clicks, drags, scrolling and
 * typing on the picture go to the shared thing (a window keeps running in the background).
 */
export function ComputerLiveView({
  target,
  views,
  expanded: expandedProp,
  onExpandedChange,
  defaultTakeover = false,
  className,
}: {
  target: ComputerTarget;
  /** One view per display for a shared desktop; a single view otherwise. */
  views: { view: string; label: string }[];
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  defaultTakeover?: boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const [viewIndex, setViewIndex] = useState(0);
  const view = views[Math.min(viewIndex, views.length - 1)]?.view ?? views[0]!.view;
  const frame = useLive((s) => s.computerFrames[view]);
  const agentAction = useLive((s) => s.computerActions[view]);
  const now = useNow(1000);
  const [takeover, setTakeover] = useState(defaultTakeover);
  const [expandedState, setExpandedState] = useState(false);
  const controlled = expandedProp !== undefined;
  const expanded = expandedProp ?? expandedState;
  const onExpandedChangeRef = useRef(onExpandedChange);
  onExpandedChangeRef.current = onExpandedChange;
  const setExpanded = useCallback(
    (next: boolean) => {
      if (!controlled) setExpandedState(next);
      onExpandedChangeRef.current?.(next);
    },
    [controlled],
  );
  const [focused, setFocused] = useState(false);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const size = useRef({ width: 0, height: 0 });
  size.current = { width: frame?.width ?? 0, height: frame?.height ?? 0 };

  useEffect(() => subscribeComputer(view), [view]);
  useEffect(() => {
    if (takeover) viewportRef.current?.focus();
  }, [takeover]);

  // Esc leaves the focus view unless it goes to the shared thing.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !takeover) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, takeover, setExpanded]);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!rootRef.current?.contains(previous)) rootRef.current?.focus();
    return () => previous?.focus();
  }, [expanded]);

  /** Frame-relative (0–1) → position inside the viewport, accounting for letterboxing. */
  const place = useCallback((rx: number, ry: number) => {
    const img = imgRef.current;
    const { width, height } = size.current;
    if (!img || !width || !height) return null;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / width, rect.height / height);
    const offX = (rect.width - width * scale) / 2;
    const offY = (rect.height - height * scale) / 2;
    return { x: offX + rx * width * scale, y: offY + ry * height * scale };
  }, []);

  const ripple = useCallback((x: number, y: number, agent: boolean) => {
    const id = Date.now() + Math.random();
    setRipples((r) => [...r.slice(-6), { id, x, y, agent }]);
    setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 700);
  }, []);

  // Where the agent acts.
  const lastAgentAt = useRef(0);
  useEffect(() => {
    if (!agentAction || agentAction.at === lastAgentAt.current || agentAction.x === undefined || agentAction.y === undefined) return;
    lastAgentAt.current = agentAction.at;
    const p = place(agentAction.x, agentAction.y);
    if (p) ripple(p.x, p.y, true);
  }, [agentAction, place, ripple]);

  /* ---------------------------- input forwarding ---------------------------- */

  const queue = useRef<Promise<void>>(Promise.resolve());
  const lastErrorAt = useRef(0);
  const send = useCallback(
    (event: ComputerInputEvent, seen?: { width: number; height: number }) => {
      // Coordinates refer to the frame the human acted on (a click is sent a moment after mouseup).
      const frameSize = seen ?? (size.current.width ? { ...size.current } : undefined);
      queue.current = queue.current
        .then(() => api.computer.input(view, event, frameSize).then(() => undefined))
        .catch((e) => {
          if (Date.now() - lastErrorAt.current > 3000) {
            lastErrorAt.current = Date.now();
            toastApiError(e, "Input could not be delivered", qc);
          }
        });
    },
    [view, qc],
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

  /** Viewport client coords → frame coords (null outside the picture). */
  const mapPoint = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current;
    const { width, height } = size.current;
    if (!img || !width || !height) return null;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / width, rect.height / height);
    if (!scale) return null;
    const offX = (rect.width - width * scale) / 2;
    const offY = (rect.height - height * scale) / 2;
    const x = (clientX - rect.left - offX) / scale;
    const y = (clientY - rect.top - offY) / scale;
    if (x < 0 || y < 0 || x > width || y > height) return null;
    return { x: Math.round(x), y: Math.round(y), localX: clientX - rect.left, localY: clientY - rect.top };
  }, []);

  const press = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingClicks = useRef(0);
  // A click still waiting for a possible double-click is dropped when the view closes.
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (!takeover || e.button !== 0) return;
    const pt = mapPoint(e.clientX, e.clientY);
    press.current = pt ? { x: pt.x, y: pt.y, cx: e.clientX, cy: e.clientY } : null;
  };

  const onMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    if (!takeover || e.button !== 0) return;
    viewportRef.current?.focus();
    const start = press.current;
    press.current = null;
    const pt = mapPoint(e.clientX, e.clientY);
    if (!start || !pt) return;
    flushText();
    if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) > 6) {
      send({ type: "drag", x: start.x, y: start.y, toX: pt.x, toY: pt.y });
      ripple(pt.localX, pt.localY, false);
      return;
    }
    ripple(pt.localX, pt.localY, false);
    // Collect double/triple clicks into one event.
    pendingClicks.current = Math.min(3, pendingClicks.current + 1);
    if (clickTimer.current) clearTimeout(clickTimer.current);
    const at = { x: pt.x, y: pt.y };
    const seen = { ...size.current };
    clickTimer.current = setTimeout(() => {
      const count = pendingClicks.current;
      pendingClicks.current = 0;
      clickTimer.current = null;
      send({ type: "click", x: at.x, y: at.y, count }, seen);
    }, 220);
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (!takeover) return;
    e.preventDefault();
    const pt = mapPoint(e.clientX, e.clientY);
    if (!pt) return;
    flushText();
    send({ type: "click", x: pt.x, y: pt.y, button: "right" });
    ripple(pt.localX, pt.localY, false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!takeover) return;
    const combo = e.metaKey || e.ctrlKey || e.altKey;
    // ⌘V / Ctrl+V: the paste event carries the text.
    if (combo && e.key.toLowerCase() === "v" && !e.altKey) return;
    if (combo && e.key.length === 1) {
      e.preventDefault();
      flushText();
      const modifiers = [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean) as string[];
      send({ type: "key", key: e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase(), modifiers });
    } else if (KEYS_WITHOUT_TEXT.has(e.key)) {
      e.preventDefault();
      flushText();
      const modifiers = [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean) as string[];
      send({ type: "key", key: e.key, modifiers });
    } else if (e.key.length === 1) {
      e.preventDefault();
      textBuf.current += e.key;
      if (!textTimer.current) textTimer.current = setTimeout(flushText, 60);
    }
  };

  // Wheel: non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !takeover) return;
    let dx = 0;
    let dy = 0;
    let last = { x: 0, y: 0 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      const pt = mapPoint(e.clientX, e.clientY);
      if (!pt) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      dx += e.deltaX * unit;
      dy += e.deltaY * unit;
      last = { x: pt.x, y: pt.y };
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (dx || dy) send({ type: "scroll", x: last.x, y: last.y, deltaX: Math.round(dx), deltaY: Math.round(dy) });
          dx = 0;
          dy = 0;
        }, 90);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (timer) clearTimeout(timer);
    };
  }, [takeover, mapPoint, send]);

  const live = !!frame?.data && !frame.error && now - frame.at < 4000;
  const label = frame?.label || views[Math.min(viewIndex, views.length - 1)]?.label || computerTargetLabel(target);
  const hasPicture = !!frame?.data;

  return (
    <>
      <AnimatePresence propagate>
        {expanded && (
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-40 bg-[#1c1b19]/35 dark:bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setExpanded(false)}
          />
        )}
      </AnimatePresence>
      <motion.div
        ref={rootRef}
        layout
        role={expanded ? "dialog" : undefined}
        aria-modal={expanded || undefined}
        aria-label={expanded ? `Shared: ${label}` : undefined}
        tabIndex={-1}
        initial={controlled ? { opacity: 0, scale: 0.98 } : false}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
        className={cn("rounded-xl outline-none", expanded ? "fixed inset-4 z-50 flex flex-col md:inset-8" : "relative", className)}
      >
        <div className={cn("rounded-xl", takeover && "glow-border", expanded && "flex min-h-0 flex-1 flex-col")}>
          <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-float", expanded && "h-full")}>
            {/* Header */}
            <div className="flex flex-wrap items-center gap-2 border-b bg-paper-2 px-3 py-2">
              <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">{targetIcon(target, "size-3.5")}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
              {views.length > 1 && (
                <div className="flex items-center gap-1 rounded-md border bg-card p-0.5" role="tablist" aria-label="Displays">
                  {views.map((v, i) => (
                    <button
                      key={v.view}
                      type="button"
                      role="tab"
                      aria-selected={i === viewIndex}
                      onClick={() => setViewIndex(i)}
                      className={cn(
                        "max-w-32 truncate rounded-[5px] px-2 py-0.5 text-[11px] font-medium transition",
                        i === viewIndex ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {v.label || `Display ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
                  live ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
                )}
                title={frame?.width ? `${frame.width}×${frame.height}` : undefined}
              >
                <LiveDot live={live} />
                {live ? "Live" : "Idle"}
              </span>
              <label
                className={cn(
                  "flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition select-none",
                  takeover ? "border-foreground/40 bg-secondary text-foreground" : "bg-card text-muted-foreground hover:text-foreground",
                  !hasPicture && "pointer-events-none opacity-50",
                )}
              >
                <Hand className="size-3.5" />
                <span className="hidden sm:inline">Take over</span>
                <Switch checked={takeover} onCheckedChange={setTakeover} disabled={!hasPicture} size="sm" aria-label="Take over" />
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Exit focus view" : "Expand"}>
                    {expanded ? <Minimize2 /> : <Maximize2 />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{expanded ? "Exit focus view" : "Focus view"}</TooltipContent>
              </Tooltip>
            </div>

            {/* Banner */}
            <div className={cn("flex items-center gap-2 border-b px-3 py-1.5 text-xs", takeover ? "bg-secondary text-foreground" : "bg-paper-2 text-muted-foreground")}>
              {takeover ? <MousePointerClick className="size-3.5 shrink-0" /> : <LiveDot live={live} className="shrink-0" />}
              <span className="min-w-0 flex-1">
                {takeover
                  ? target.kind === "window" || target.kind === "tab"
                    ? "You're in control — clicks, scrolling and typing go to the shared window, in the background."
                    : "You're in control — clicks and typing move your real mouse and keyboard."
                  : controlNote(target)}
              </span>
            </div>

            {/* Viewport */}
            <div
              ref={viewportRef}
              tabIndex={takeover ? 0 : -1}
              role={takeover ? "application" : undefined}
              aria-label={takeover ? "Shared screen — keyboard and mouse input is forwarded" : "Shared screen live view"}
              onMouseDown={onMouseDown}
              onMouseUp={onMouseUp}
              onContextMenu={onContextMenu}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                if (!takeover) return;
                const text = e.clipboardData.getData("text");
                if (text) {
                  e.preventDefault();
                  flushText();
                  send({ type: "text", text });
                }
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                flushText();
              }}
              className={cn(
                "group/viewport relative w-full overflow-hidden bg-secondary outline-none",
                expanded ? "min-h-0 flex-1" : "max-h-[68vh]",
                takeover && "cursor-crosshair",
              )}
              style={expanded ? undefined : { aspectRatio: frame?.width ? `${frame.width} / ${frame.height}` : "16 / 10" }}
            >
              {hasPicture ? (
                <>
                  <img
                    ref={imgRef}
                    src={`data:${frame!.mime};base64,${frame!.data}`}
                    alt={`Live view: ${label}`}
                    draggable={false}
                    className="absolute inset-0 size-full object-contain select-none"
                  />
                  {!takeover && (
                    <div className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover/viewport:bg-black/25 group-hover/viewport:opacity-100">
                      <Button
                        size="sm"
                        className="shadow-float"
                        onClick={(e) => {
                          e.stopPropagation();
                          setTakeover(true);
                        }}
                      >
                        <Hand /> Take over
                      </Button>
                    </div>
                  )}
                  {takeover && !focused && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                      <span className="glass rounded-md px-3 py-1 text-[11px] text-muted-foreground">Click the picture to send keyboard input</span>
                    </div>
                  )}
                  {frame?.error && (
                    <div className="pointer-events-none absolute inset-x-3 top-3 flex justify-center">
                      <span className="glass inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[11px] text-foreground">
                        <TriangleAlert className="size-3.5 text-amber-600" /> {frame.error}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <Waiting error={frame?.error} />
              )}
              <AnimatePresence>
                {ripples.map((r) => (
                  <motion.span
                    key={r.id}
                    className={cn(
                      "pointer-events-none absolute size-10 rounded-full border-2",
                      r.agent ? "border-sky-500 bg-sky-500/20" : "border-brand bg-brand/20",
                    )}
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
      </motion.div>
    </>
  );
}

function Waiting({ error }: { error?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-paper-2 text-muted-foreground">
      <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
        {error ? (
          <>
            <TriangleAlert className="size-5 text-amber-600" />
            <p className="text-sm">{error}</p>
          </>
        ) : (
          <>
            <Orb variant="C3" size={32} label="Waiting for the first picture" />
            <p className="text-shimmer text-sm font-medium">Connecting to the screen…</p>
          </>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Globe, Hand, Lock, Maximize2, Minimize2, MousePointerClick, Play, RotateCw } from "lucide-react";
import { browserView, type BrowserChat, type BrowserProfile } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { Favicon } from "@/components/vault/favicon";
import { domainFromUrl, normalizeUrl, toastApiError } from "@/components/vault/vault-utils";
import { useNow } from "@/components/vault/use-now";
import { api } from "@/lib/api";
import { subscribeBrowser } from "@/lib/realtime";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";

type InputEvent = Parameters<typeof api.browser.input>[1];

const SPECIAL_KEYS = new Set([
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
]);

interface Ripple {
  id: number;
  x: number;
  y: number;
}

/**
 * Live view of a Godmode browser profile (CDP screencast frames over the WebSocket) with optional human takeover:
 * clicks, scrolling and typing on the image are forwarded to the page.
 * With `conversationId` it shows the tab that chat works in; with `onConversationChange` too, the tab strip lists
 * the chats browsing in the profile to switch between them.
 * Pass `expanded` + `onExpandedChange` to control the focus view from outside (e.g. the chat's browser panel).
 */
export function LiveView({
  profile,
  conversationId = null,
  onConversationChange,
  onLaunch,
  launching,
  expanded: expandedProp,
  onExpandedChange,
  defaultTakeover = false,
}: {
  profile: BrowserProfile;
  conversationId?: string | null;
  onConversationChange?: (conversationId: string) => void;
  onLaunch: () => void;
  launching: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  defaultTakeover?: boolean;
}) {
  const qc = useQueryClient();
  const running = profile.running;
  const view = browserView(profile.id, conversationId);
  const frame = useLive((s) => (running ? s.frames[view] : undefined));
  const chat = conversationId ? profile.chats.find((c) => c.conversationId === conversationId) : undefined;
  const noTabYet = !!conversationId && running && !chat && !frame;
  const hasFrame = !!frame;
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
  const [waitedLong, setWaitedLong] = useState(false);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [urlDraft, setUrlDraft] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const frameSize = useRef({ width: 0, height: 0 });
  frameSize.current = { width: frame?.width ?? 0, height: frame?.height ?? 0 };

  // Subscribe to frames while the profile is running.
  useEffect(() => {
    if (!running) return;
    return subscribeBrowser(profile.id, { conversationId });
  }, [profile.id, conversationId, running]);

  // Reset per-view UI state.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    setTakeover(false);
    setEditingUrl(false);
    setRipples([]);
  }, [view]);

  useEffect(() => {
    if (!running) setTakeover(false);
  }, [running]);

  // Hint when no frame arrives for a while.
  useEffect(() => {
    setWaitedLong(false);
    if (!running || hasFrame) return;
    const t = setTimeout(() => setWaitedLong(true), 5000);
    return () => clearTimeout(t);
  }, [running, hasFrame, view]);

  // Esc leaves the expanded view when not taking over (in takeover Esc goes to the page).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !takeover) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, takeover, setExpanded]);

  useEffect(() => {
    if (takeover) viewportRef.current?.focus();
  }, [takeover]);

  // The focus view sits on top of the page: pull keyboard focus into it and hand it back when it closes.
  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!rootRef.current?.contains(previous)) rootRef.current?.focus();
    return () => previous?.focus();
  }, [expanded]);

  /* ---------------------------- input forwarding ---------------------------- */

  const queue = useRef<Promise<void>>(Promise.resolve());
  const lastErrorAt = useRef(0);
  const send = useCallback(
    (event: InputEvent) => {
      queue.current = queue.current
        .then(() => api.browser.input(profile.id, event, conversationId).then(() => undefined))
        .catch((e) => {
          if (Date.now() - lastErrorAt.current > 3000) {
            lastErrorAt.current = Date.now();
            toastApiError(e, "Input could not be delivered", qc);
          }
        });
    },
    [profile.id, conversationId, qc],
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
  const pushText = useCallback(
    (text: string) => {
      textBuf.current += text;
      if (!textTimer.current) textTimer.current = setTimeout(flushText, 60);
    },
    [flushText],
  );
  useEffect(() => () => flushText(), [flushText]);

  /** Map viewport client coords → frame coords, accounting for object-contain letterboxing. */
  const mapPoint = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current;
    const { width, height } = frameSize.current;
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

  const onViewportClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!takeover) return;
    viewportRef.current?.focus();
    const pt = mapPoint(e.clientX, e.clientY);
    if (!pt) return;
    flushText();
    send({ type: "click", x: pt.x, y: pt.y });
    const id = Date.now() + Math.random();
    setRipples((r) => [...r, { id, x: pt.localX, y: pt.localY }]);
    setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 650);
  };

  const onViewportKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!takeover) return;
    // Let OS shortcuts through (⌘V / Ctrl+V fires a paste event we forward below).
    if (e.metaKey || e.ctrlKey) return;
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      flushText();
      send({ type: "key", key: e.key });
    } else if (e.key.length === 1) {
      e.preventDefault();
      pushText(e.key);
    }
  };

  // Wheel needs a non-passive listener to prevent page scroll.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !takeover) return;
    let acc = 0;
    let last = { x: 0, y: 0 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      const pt = mapPoint(e.clientX, e.clientY);
      if (!pt) return;
      e.preventDefault();
      acc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      last = { x: pt.x, y: pt.y };
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (acc) send({ type: "scroll", x: last.x, y: last.y, deltaY: Math.round(acc) });
          acc = 0;
        }, 80);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (timer) clearTimeout(timer);
    };
  }, [takeover, mapPoint, send]);

  /* ------------------------------- navigation ------------------------------- */

  const navigate = useMutation({
    mutationFn: (url: string) => api.browser.navigate(profile.id, url, conversationId),
    onError: (e) => toastApiError(e, "Navigation failed", qc),
  });

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeUrl(urlDraft);
    if (!url) return;
    navigate.mutate(url);
    setEditingUrl(false);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const displayUrl = editingUrl ? urlDraft : (frame?.url ?? "");
  const domain = domainFromUrl(frame?.url);
  const secure = frame?.url?.startsWith("https://");
  const live = !!frame && now - frame.at < 4000;

  /* --------------------------------- render --------------------------------- */

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
        aria-label={expanded ? `${profile.name} browser` : undefined}
        tabIndex={-1}
        initial={controlled ? { opacity: 0, scale: 0.98 } : false}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
        className={cn("rounded-xl outline-none", expanded ? "fixed inset-4 z-50 flex flex-col md:inset-8" : "relative")}
      >
        <div className={cn("rounded-xl", takeover && "glow-border", expanded && "flex min-h-0 flex-1 flex-col")}>
        <div
          className={cn(
            "flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-float",
            expanded && "h-full",
          )}
        >
          {/* Tab strip */}
          <div className="flex items-center gap-3 border-b bg-paper-2 px-3 pt-2">
            <div className="flex shrink-0 gap-1.5 pb-2" aria-hidden>
              <span className="size-2.5 rounded-full bg-foreground/15" />
              <span className="size-2.5 rounded-full bg-foreground/15" />
              <span className="size-2.5 rounded-full bg-foreground/15" />
            </div>
            {running && onConversationChange && profile.chats.length > 0 ? (
              <ChatTabs chats={profile.chats} selected={conversationId} onSelect={onConversationChange} />
            ) : (
              <div className="-mb-px flex min-w-0 max-w-72 items-center gap-2 rounded-t-md border border-b-0 bg-card px-3 py-1.5 text-xs">
                {domain ? <Favicon domain={domain} name={frame?.title || domain} size="sm" className="size-4 rounded-sm" /> : <Globe className="size-3.5 text-muted-foreground" />}
                <span className="truncate font-medium">{running ? frame?.title || chat?.pageTitle || domain || "New tab" : profile.name}</span>
              </div>
            )}
            <div className="ml-auto flex items-center gap-2 pb-2">
              {running && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
                    live ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
                  )}
                  title={frame ? `${frame.width}×${frame.height}` : undefined}
                >
                  <LiveDot live={live} />
                  {live ? "Live" : "Idle"}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Exit focus view" : "Expand"}>
                    {expanded ? <Minimize2 /> : <Maximize2 />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{expanded ? "Exit focus view" : "Focus view"}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Address bar + takeover */}
          <div className="flex items-center gap-2 border-b bg-card px-3 py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reload"
                  disabled={!running || !frame?.url || navigate.isPending}
                  onClick={() => frame?.url && navigate.mutate(frame.url)}
                >
                  <RotateCw className={cn(navigate.isPending && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reload</TooltipContent>
            </Tooltip>
            <form onSubmit={submitUrl} className="relative min-w-0 flex-1">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                {navigate.isPending ? <Spinner className="size-3.5" /> : secure ? <Lock className="size-3.5 text-brand-strong" /> : <Globe className="size-3.5" />}
              </span>
              <input
                aria-label="Address"
                value={displayUrl}
                disabled={!running}
                placeholder={running ? "Search or enter address" : "Browser is not running"}
                onFocus={(e) => {
                  setUrlDraft(frame?.url ?? "");
                  setEditingUrl(true);
                  requestAnimationFrame(() => e.target.select());
                }}
                onBlur={() => setEditingUrl(false)}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setEditingUrl(false);
                    e.currentTarget.blur();
                  }
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="h-8 w-full rounded-md border bg-paper-2 pr-3 pl-8 font-mono text-xs outline-none transition focus:border-ring focus:bg-card focus:ring-[3px] focus:ring-ring/40 disabled:opacity-60"
              />
            </form>
            <label
              className={cn(
                "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium transition select-none",
                takeover ? "border-foreground/40 bg-secondary text-foreground" : "bg-card text-muted-foreground hover:text-foreground",
                !running && "pointer-events-none opacity-50",
              )}
            >
              <Hand className="size-3.5" />
              <span className="hidden sm:inline">Take over</span>
              <Switch checked={takeover} onCheckedChange={setTakeover} disabled={!running || !frame} size="sm" aria-label="Take over the browser" />
            </label>
          </div>

          {/* Banner */}
          {running && (
            <div
              className={cn(
                "flex items-center gap-2 border-b px-3 py-1.5 text-xs transition-colors",
                takeover ? "bg-secondary text-foreground" : "bg-paper-2 text-muted-foreground",
              )}
            >
              {takeover ? (
                <MousePointerClick className="size-3.5 shrink-0" />
              ) : (
                <span className="grid size-3.5 shrink-0 place-items-center">
                  <LiveDot live={live} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                {takeover
                  ? "You're in control — clicks, scrolling and typing go to the page. Turn off Take over when you're done."
                  : conversationId
                    ? "This chat's own tab — other chats browse in theirs. Take over to solve CAPTCHAs or log in manually."
                    : "Agents keep working in this browser — take over to solve CAPTCHAs or log in manually."}
              </span>
            </div>
          )}

          {/* Viewport */}
          <div
            ref={viewportRef}
            tabIndex={takeover ? 0 : -1}
            role={takeover ? "application" : undefined}
            aria-label={takeover ? "Remote browser — keyboard and mouse input is forwarded" : "Browser live view"}
            onClick={onViewportClick}
            onKeyDown={onViewportKeyDown}
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
            style={expanded ? undefined : { aspectRatio: frame ? `${frame.width} / ${frame.height}` : "16 / 10" }}
          >
            {!running ? (
              <NotRunning profileName={profile.name} onLaunch={onLaunch} launching={launching} />
            ) : noTabYet ? (
              <NoTabYet />
            ) : frame ? (
              <>
                <img
                  ref={imgRef}
                  src={`data:image/jpeg;base64,${frame.data}`}
                  alt={frame.title ? `Live view: ${frame.title}` : "Live view"}
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
                    <span className="glass rounded-md px-3 py-1 text-[11px] text-muted-foreground">Click the page to send keyboard input</span>
                  </div>
                )}
                <AnimatePresence>
                  {ripples.map((r) => (
                    <motion.span
                      key={r.id}
                      className="pointer-events-none absolute size-10 rounded-full border-2 border-brand bg-brand/20"
                      style={{ left: r.x - 20, top: r.y - 20 }}
                      initial={{ scale: 0.3, opacity: 0.9 }}
                      animate={{ scale: 1.4, opacity: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.6, ease: "easeOut" }}
                    />
                  ))}
                </AnimatePresence>
              </>
            ) : (
              <WaitingForFrame waitedLong={waitedLong} />
            )}
          </div>
        </div>
        </div>
      </motion.div>
    </>
  );
}

function NotRunning({ profileName, onLaunch, launching }: { profileName: string; onLaunch: () => void; launching: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-hidden bg-background">
      <div className="bg-dots absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" aria-hidden />
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative flex max-w-sm flex-col items-center px-6 text-center">
        <div className="mb-4 grid size-12 place-items-center rounded-lg border bg-card text-foreground shadow-card">
          <Globe className="size-6" />
        </div>
        <h3 className="text-base font-medium tracking-[-0.01em]">{profileName} isn't running</h3>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Agents start it automatically when they need the web. Launch it now to watch, log in manually or check your imported sessions.
        </p>
        <Button className="mt-5" onClick={onLaunch} disabled={launching}>
          {launching ? <Spinner /> : <Play />} Launch browser
        </Button>
      </motion.div>
    </div>
  );
}

/** One tab per chat browsing in the profile, a dot while its agent is at work. */
function ChatTabs({ chats, selected, onSelect }: { chats: BrowserChat[]; selected: string | null; onSelect: (conversationId: string) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Chats in this browser"
      className="-mb-px flex min-w-0 flex-1 items-end gap-1 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] pr-8 [scrollbar-width:none]"
    >
      {chats.map((chat) => {
        const active = chat.conversationId === selected;
        const domain = domainFromUrl(chat.url);
        const title = chat.title || "Untitled chat";
        return (
          <Tooltip key={chat.conversationId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(chat.conversationId)}
                className={cn(
                  "flex h-8 max-w-56 min-w-28 shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active ? "bg-card font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                {domain ? <Favicon domain={domain} name={chat.pageTitle || domain} size="sm" className="size-4 rounded-sm" /> : <Globe className="size-3.5 shrink-0" />}
                <span className="truncate">{title}</span>
                {chat.active && <LiveDot className="ml-auto shrink-0" />}
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              <p className="font-medium">{title}</p>
              <p className="truncate text-muted-foreground">
                {chat.pageTitle || domain || "New tab"}
                {chat.tabs > 1 ? ` · ${chat.tabs} tabs` : ""}
              </p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function NoTabYet() {
  return (
    <div className="absolute inset-0 grid place-items-center bg-paper-2">
      <div className="flex max-w-xs flex-col items-center gap-3 px-6 text-center">
        <span className="grid size-10 place-items-center rounded-lg border bg-card text-muted-foreground shadow-card">
          <Globe className="size-5" />
        </span>
        <p className="text-sm font-medium">No page open in this chat</p>
        <p className="text-xs text-muted-foreground">The agent opens its own tab when it needs the web. Enter an address above to open one yourself.</p>
      </div>
    </div>
  );
}

function WaitingForFrame({ waitedLong }: { waitedLong: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-paper-2 text-muted-foreground">
      <div className="flex max-w-xs flex-col items-center gap-3 px-6 text-center">
        <Orb variant="C3" size={32} label="Waiting for the first frame" />
        <p className="text-shimmer text-sm font-medium">Waiting for the first frame…</p>
        {waitedLong && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-xs text-muted-foreground">
            Still nothing? Live view may be turned off in Settings → Browser, or the browser runs without a visible page yet.
          </motion.p>
        )}
      </div>
    </div>
  );
}

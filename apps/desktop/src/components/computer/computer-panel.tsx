import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Eye, Hand, Loader2, Maximize2, MonitorUp, PanelRightClose, PanelRightOpen, Repeat2, ScreenShareOff } from "lucide-react";
import type { Agent, ComputerTarget } from "@godmode/shared";
import { computerTargetLabel } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot, WorkingTicks } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { useNow } from "@/components/vault/use-now";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { subscribeComputer } from "@/lib/realtime";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";
import { ComputerLiveView, targetIcon } from "./computer-live-view";
import { ComputerShareDialog } from "./share-dialog";
import { controlNote, viewsOf } from "./computer-utils";

export type ComputerFocusMode = "watch" | "control";

/** Views of a shared target — a shared desktop has one per display. */
export function useComputerViews(target: ComputerTarget | null): { view: string; label: string }[] {
  const { data } = useQuery({
    queryKey: qk.computerSources,
    queryFn: api.computer.sources,
    enabled: target?.kind === "desktop",
    staleTime: 30_000,
    retry: false,
  });
  return target ? viewsOf(target, data?.displays) : [];
}

/** Composer control: share a window, screen or tab — or, while sharing, what is shared (change / watch / stop). */
export function ComputerShareChip({
  target,
  agentName,
  onShare,
  onWatch,
  busy,
}: {
  target: ComputerTarget | null;
  agentName?: string;
  onShare: (target: ComputerTarget | null) => void | Promise<unknown>;
  onWatch?: () => void;
  busy?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickAfterMenu = useRef(false);
  const dialog = (
    <ComputerShareDialog
      open={picking}
      onOpenChange={setPicking}
      current={target}
      agentName={agentName}
      sharing={busy}
      onShare={async (t) => {
        await onShare(t);
        setPicking(false);
      }}
    />
  );

  if (!target) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              onClick={() => setPicking(true)}
              aria-label="Share a window or screen"
              className="h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4"
            >
              {busy ? <Loader2 className="animate-spin" /> : <MonitorUp />}
              <span className="@max-sm/composer:sr-only">Share screen</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Share a window or screen</TooltipContent>
        </Tooltip>
        {dialog}
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                aria-label={`Sharing: ${computerTargetLabel(target)}`}
                className="flex h-8 max-w-[15rem] min-w-0 items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft pr-1.5 pl-2 text-[13px] text-brand-strong transition hover:bg-brand-soft/80 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : targetIcon(target, "size-3.5 shrink-0")}
                <span className="truncate font-medium">{computerTargetLabel(target)}</span>
                <LiveDot className="shrink-0" />
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{controlNote(target)}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-72"
          onCloseAutoFocus={(e) => {
            if (!pickAfterMenu.current) return;
            pickAfterMenu.current = false;
            e.preventDefault();
            setPicking(true);
          }}
        >
          <DropdownMenuLabel className="space-y-1 font-normal">
            <span className="block text-xs text-muted-foreground">Shared with {agentName ?? "the agent"}</span>
            <span className="block text-[13px] font-medium break-words text-foreground">{computerTargetLabel(target)}</span>
            <span className="block text-[11px] text-muted-foreground">{controlNote(target)}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {onWatch && (
            <DropdownMenuItem onClick={onWatch}>
              <Eye /> Watch
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => (pickAfterMenu.current = true)}>
            <Repeat2 /> Share something else…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void onShare(null)}>
            <ScreenShareOff /> Stop sharing
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

/** Right-hand panel of a chat that has something shared: live preview, what the agent does, take control, stop. */
export function ComputerPanel({
  target,
  agent,
  activity,
  onHide,
  onFocus,
  onStop,
  stopping,
}: {
  target: ComputerTarget;
  agent: Agent;
  activity: string | null;
  onHide: () => void;
  onFocus: (mode: ComputerFocusMode) => void;
  onStop: () => void;
  stopping?: boolean;
}) {
  const views = useComputerViews(target);
  const [index, setIndex] = useState(0);
  const view = views[Math.min(index, Math.max(0, views.length - 1))]?.view;
  const frame = useLive((s) => (view ? s.computerFrames[view] : undefined));
  const now = useNow(1000);
  const live = !!frame?.data && !frame.error && now - frame.at < 4000;

  useEffect(() => (view ? subscribeComputer(view) : undefined), [view]);

  return (
    <motion.aside
      aria-label="Shared screen"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 320, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 36 }}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full w-80 flex-col">
        <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b px-4", isTauri && isMac && "h-auto pt-7 pb-2")}>
          <span className="text-sm font-medium">Shared</span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
              live ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
            )}
          >
            <LiveDot live={live} />
            {live ? "Live" : "Idle"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-mr-1.5 ml-auto text-muted-foreground" onClick={onHide} aria-label="Hide shared screen">
                <PanelRightClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {views.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {views.map((v, i) => (
                <button
                  key={v.view}
                  type="button"
                  onClick={() => setIndex(i)}
                  className={cn(
                    "max-w-full truncate rounded-md border px-2 py-0.5 text-[11px] font-medium transition",
                    i === index ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <div className={cn("rounded-xl", activity && "glow-border")}>
            <button
              type="button"
              onClick={() => onFocus("watch")}
              aria-label="Watch full size"
              className="group/preview relative block max-h-[45vh] w-full overflow-hidden rounded-xl border bg-card shadow-card outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              style={{ aspectRatio: frame?.width ? `${frame.width} / ${frame.height}` : "16 / 10" }}
            >
              {frame?.data ? (
                <img src={`data:${frame.mime};base64,${frame.data}`} alt="" draggable={false} className="absolute inset-0 size-full object-contain select-none" />
              ) : (
                <span className="absolute inset-0 grid place-items-center bg-paper-2 px-6 text-center">
                  <span className="flex flex-col items-center gap-2.5">
                    {frame?.error ? (
                      <span className="text-xs text-muted-foreground">{frame.error}</span>
                    ) : (
                      <>
                        <Orb variant="C3" size={24} label="Connecting to the screen" />
                        <span className="text-shimmer text-xs font-medium">Connecting…</span>
                      </>
                    )}
                  </span>
                </span>
              )}
              <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover/preview:bg-black/30 group-hover/preview:opacity-100 group-focus-visible/preview:bg-black/30 group-focus-visible/preview:opacity-100">
                <span className="glass inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground">
                  <Maximize2 className="size-3.5" /> Watch full size
                </span>
              </span>
            </button>
          </div>

          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">{targetIcon(target, "size-3.5")}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] leading-5 font-medium">{frame?.label || computerTargetLabel(target)}</p>
              <p className="text-[11px] leading-4 text-muted-foreground">{controlNote(target)}</p>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {activity && (
              <motion.div key="activity" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-card">
                  <WorkingTicks count={8} className="shrink-0 text-brand" />
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{activity}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={() => onFocus("control")} disabled={!frame?.data}>
              <Hand /> Take control
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon-sm" onClick={onStop} disabled={stopping} aria-label="Stop sharing">
                  {stopping ? <Loader2 className="animate-spin" /> : <ScreenShareOff />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop sharing</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="shrink-0 border-t px-4 py-3 text-[11px] text-muted-foreground">
          {agent.name} sees only what you share here, and only while it's shared. Stopping takes effect immediately.
        </div>
      </div>
    </motion.aside>
  );
}

/** Full-size live view on top of the chat, optionally starting in takeover mode. */
export function ComputerFocus({ target, mode, onClose }: { target: ComputerTarget | null; mode: ComputerFocusMode | null; onClose: () => void }) {
  const views = useComputerViews(target);
  return (
    <AnimatePresence>
      {target && mode && views.length > 0 && (
        <ComputerLiveView
          key={`${views[0]!.view}:${mode}`}
          target={target}
          views={views}
          expanded
          onExpandedChange={(expanded) => !expanded && onClose()}
          defaultTakeover={mode === "control"}
        />
      )}
    </AnimatePresence>
  );
}

/** Header button that brings the shared-screen panel back once it's hidden. */
export function ComputerToggle({ working, onClick }: { working: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Show shared screen" onClick={onClick} className="relative text-muted-foreground">
          <PanelRightOpen />
          {working && <LiveDot className="absolute top-1.5 right-1.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Show shared screen</TooltipContent>
    </Tooltip>
  );
}

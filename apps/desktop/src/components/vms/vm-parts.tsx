import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Moon, TriangleAlert } from "lucide-react";
import type { Vm, VmImagePreset, VmProgress, VmState } from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

/** Decimal GB, like the core's free-space figure and macOS Finder. */
export function formatGb(bytes: number): string {
  const gb = bytes / 1e9;
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

export function formatMemory(mb: number): string {
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export function formatDisplay(display: string): string {
  return display.replace("x", " × ");
}

/** The preset a VM was created from, if it's one of Godmode's images. */
export function presetOf(image: string, presets: VmImagePreset[] | undefined): VmImagePreset | undefined {
  return presets?.find((p) => p.image === image || p.id === image);
}

/** "macOS Tahoe" for presets, else the image's last path segment ("my-image:latest"). */
export function imageName(image: string, presets: VmImagePreset[] | undefined): string {
  return presetOf(image, presets)?.name ?? image.replace(/^.*\//, "");
}

/** Where the VM's shared folder shows up inside the guest, for humans: "~/Godmode". */
export function guestFolderLabel(vm: Pick<Vm, "guestSharedDir">): string {
  return vm.guestSharedDir.replace(/^\/Users\/[^/]+/, "~");
}

/** "macOS VM", then "macOS VM 2", "macOS VM 3", … */
export function nextVmName(vms: Pick<Vm, "name">[], base = "macOS VM"): string {
  const taken = new Set(vms.map((v) => v.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/* ------------------------------------------------------------------ */
/* States                                                               */
/* ------------------------------------------------------------------ */

export const VM_STATE_LABEL: Record<VmState, string> = {
  creating: "Creating",
  starting: "Starting",
  running: "Running",
  suspended: "Suspended",
  stopping: "Stopping",
  stopped: "Stopped",
  error: "Needs attention",
};

/** Busy = Godmode is doing something with the VM right now (progress shows). */
export function vmBusy(state: VmState): boolean {
  return state === "creating" || state === "starting" || state === "stopping";
}

const BADGE: Record<VmState, string> = {
  running: "border-brand/25 bg-brand-soft text-brand-strong",
  starting: "border-brand/20 bg-brand-soft text-brand-strong",
  creating: "border-border bg-secondary text-foreground",
  stopping: "border-border bg-secondary text-muted-foreground",
  stopped: "border-border bg-secondary text-muted-foreground",
  suspended: "border-dream/20 bg-dream-soft text-dream",
  error: "border-destructive/25 bg-destructive/[0.06] text-destructive",
};

export function VmStateBadge({ state, className }: { state: VmState; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap [&_svg]:size-3",
        BADGE[state],
        className,
      )}
    >
      {state === "running" ? (
        <LiveDot className="size-1.5" />
      ) : vmBusy(state) ? (
        <Spinner className="size-3" aria-hidden />
      ) : state === "suspended" ? (
        <Moon aria-hidden />
      ) : state === "error" ? (
        <TriangleAlert aria-hidden />
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
      )}
      {VM_STATE_LABEL[state]}
    </span>
  );
}

/** Small dot for pickers: live while running, dream-tinted while suspended, muted otherwise. */
export function VmStateDot({ state, className }: { state: VmState; className?: string }) {
  if (state === "running") return <LiveDot className={cn("size-1.5", className)} />;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        state === "suspended" ? "bg-dream" : state === "error" ? "bg-destructive" : vmBusy(state) ? "bg-brand/60" : "bg-muted-foreground/45",
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Progress                                                             */
/* ------------------------------------------------------------------ */

/** Thin bar; determinate with a percentage, otherwise a segment that sweeps across. */
export function VmProgressBar({ percent, className, label }: { percent: number | null; className?: string; label: string }) {
  const value = percent === null ? undefined : Math.max(0, Math.min(100, percent));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07]", className)}
    >
      {value === undefined ? (
        <motion.span
          className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-brand/80"
          initial={{ x: "-100%" }}
          animate={{ x: "300%" }}
          transition={{ duration: 1.6, ease: [0.4, 0, 0.2, 1], repeat: Infinity }}
        />
      ) : (
        <span className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-700 ease-out" style={{ width: `${value}%` }} />
      )}
    </div>
  );
}

/**
 * Rough time left from how fast the percentage moved over the last minute or so. null until there's enough to go on
 * (a few seconds of movement), and whenever the progress starts over.
 */
function useEta(key: string, percent: number | null): number | null {
  const samples = useRef<{ key: string; points: { t: number; p: number }[] }>({ key, points: [] });
  const [eta, setEta] = useState<number | null>(null);

  useEffect(() => {
    const s = samples.current;
    if (s.key !== key) {
      s.key = key;
      s.points = [];
      setEta(null);
    }
    if (percent === null) return;
    const now = Date.now();
    const last = s.points.at(-1);
    if (last && percent < last.p) s.points = [];
    if (!last || percent !== last.p) s.points.push({ t: now, p: percent });
    while (s.points.length > 2 && now - s.points[0].t > 90_000) s.points.shift();
    const first = s.points[0];
    const latest = s.points.at(-1)!;
    const dt = latest.t - first.t;
    const dp = latest.p - first.p;
    setEta(dt >= 8_000 && dp > 0 ? ((100 - latest.p) / dp) * dt : null);
  }, [key, percent]);

  return eta;
}

function formatEta(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "less than a minute left";
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `about ${h} h${m ? ` ${m} min` : ""} left`;
}

/**
 * What Godmode is doing with the VM: the label ("Downloading macOS Tahoe (27.3 GB)"), a bar, and — for the image
 * download — how much arrived and roughly how long is left.
 */
export function VmProgressBlock({ vm, progress, preset }: { vm: Vm; progress: VmProgress; preset?: VmImagePreset }) {
  const eta = useEta(`${vm.id}:${progress.phase}`, progress.percent);
  const pct = progress.percent === null ? null : Math.max(0, Math.min(100, progress.percent));
  const downloaded = progress.phase === "download" && pct !== null && preset ? (preset.downloadGb * pct) / 100 : null;

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-[13px] font-medium" title={progress.label}>
          <span className="text-shimmer">{progress.label}</span>
        </p>
        {pct !== null && <span className="shrink-0 font-mono text-[13px] font-medium tabular-nums">{pct < 10 ? pct.toFixed(1) : Math.floor(pct)}%</span>}
      </div>
      <VmProgressBar percent={pct} label={progress.label} />
      {(downloaded !== null || eta !== null || progress.phase === "download") && (
        <p className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground tabular-nums">
          {downloaded !== null && preset && (
            <span>
              {downloaded.toFixed(1)} of {preset.downloadGb} GB
            </span>
          )}
          {downloaded !== null && eta !== null && <span className="opacity-40">·</span>}
          {eta !== null && <span>{formatEta(eta)}</span>}
          {progress.phase === "download" && eta === null && downloaded === null && <span>The first download takes a while — later VMs from this image are ready in seconds.</span>}
        </p>
      )}
    </div>
  );
}

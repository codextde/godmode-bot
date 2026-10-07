import { ArrowUpRight, CircleArrowUp, CircleX, Hourglass, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import type { RemoteRunner, RunnerUpdate } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CommandBlock, THIS_COMPUTER_INLINE } from "./runner-parts";
import type { RunnerActions } from "./use-runner-actions";

/** "6e83efe 2026-10-07" → "6e83efe"; "dev" stays. */
export function shortBuild(build: string | null | undefined): string | null {
  const commit = build?.trim().split(/\s+/)[0]?.replace(/\+changes$/, "*");
  return commit && commit !== "unknown" ? commit : null;
}

/** Whether the card shows the update strip: something to install, on its way, or in the way. */
export function hasUpdateNews(update: RunnerUpdate): boolean {
  return update.state !== "current" || update.tools.length > 0;
}

const BUSY: ReadonlySet<RunnerUpdate["state"]> = new Set(["sending", "waiting", "installing", "restarting"]);

function versionLine(runner: RemoteRunner): string {
  const { target } = runner.update;
  const from = [runner.version, shortBuild(runner.build)].filter(Boolean).join(" · ");
  const to = [target.version, shortBuild(target.build)].filter(Boolean).join(" · ");
  return from && from !== to ? `Godmode ${from} → ${to}` : `Godmode ${to}`;
}

function toolsLine(update: RunnerUpdate): string | null {
  if (!update.tools.length) return null;
  return update.tools.map((t) => (t.current && t.latest ? `${t.name} ${t.current} → ${t.latest}` : t.name)).join(", ");
}

function copy(runner: RemoteRunner): { title: string; detail: string | null } {
  const u = runner.update;
  const tools = toolsLine(u);
  switch (u.state) {
    case "available":
      return {
        title: "Update available",
        detail: [`${versionLine(runner)}, the one ${THIS_COMPUTER_INLINE} runs`, tools].filter(Boolean).join(". Also: "),
      };
    case "current":
      return { title: u.tools.length === 1 ? "Tool update" : "Tool updates", detail: tools };
    case "sending":
      return {
        title: u.source === "bridge" ? "Fetching the new Godmode" : "Sending the new Godmode",
        detail: u.detail ?? (u.source === "controller" ? `From ${THIS_COMPUTER_INLINE}, end-to-end encrypted` : null),
      };
    case "waiting":
      return { title: "Ready to install", detail: u.detail ?? "It installs once its chats are done." };
    case "installing":
      return { title: "Installing", detail: u.detail ?? "Checking the new Godmode and putting it in place" };
    case "restarting":
      return { title: "Restarting", detail: "With the new Godmode. It's back in a moment." };
    case "failed":
      return { title: "The update didn't work", detail: u.detail };
    case "unsupported":
      return { title: "Update it on the runner", detail: u.detail };
  }
}

/**
 * The runner's update, right in its card: what it would get, the progress while it gets there, and what to do when it
 * can't be updated from here.
 */
export function RunnerUpdateStrip({ runner, actions, className }: { runner: RemoteRunner; actions: RunnerActions; className?: string }) {
  const u = runner.update;
  const busy = BUSY.has(u.state);
  const starting = actions.isBusy("upgrade", runner.id);
  const online = runner.state === "online";
  const { title, detail } = copy(runner);
  const tone = u.state === "failed" ? "fail" : u.state === "unsupported" ? "warn" : "brand";
  const Icon = u.state === "failed" ? CircleX : u.state === "unsupported" ? TriangleAlert : u.state === "waiting" ? Hourglass : u.state === "restarting" ? RotateCw : CircleArrowUp;
  const percent = u.progress === null ? null : Math.round(u.progress * 100);
  const actionable = u.state === "available" || u.state === "failed" || (u.state === "current" && u.tools.length > 0);

  return (
    <section
      aria-label={`Update of ${runner.name}`}
      aria-live="polite"
      className={cn(
        "relative overflow-hidden rounded-lg border px-3 py-2.5 text-xs",
        tone === "fail" ? "border-destructive/25 bg-destructive/[0.05]" : tone === "warn" ? "border-warning/30 bg-warning/[0.07]" : "border-brand/20 bg-brand-soft/60",
        className,
      )}
    >
      <div className="flex flex-wrap items-start gap-x-2.5 gap-y-2">
        <span className={cn("mt-px shrink-0", tone === "fail" ? "text-destructive" : tone === "warn" ? "text-warning" : "text-brand-strong")}>
          {busy && u.state !== "waiting" ? <Spinner className="size-3.5" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1 basis-48 space-y-0.5">
          <p className={cn("flex items-baseline gap-1.5 font-medium", tone === "fail" ? "text-destructive" : "text-foreground", busy && "text-shimmer")}>
            {title}
            {percent !== null && u.state === "sending" && <span className="font-normal text-muted-foreground tabular-nums">{percent}%</span>}
          </p>
          {detail && <p className="leading-relaxed break-words text-muted-foreground">{detail}</p>}
        </div>
        {actionable && (
          <Button size="xs" variant={u.state === "failed" ? "outline" : "default"} disabled={!online || starting} onClick={() => actions.upgrade.mutate(runner)}>
            {starting ? <Spinner className="size-3" /> : u.state === "failed" ? <RefreshCw /> : <ArrowUpRight />}
            {u.state === "failed" ? "Try again" : "Update"}
          </Button>
        )}
      </div>
      {u.command && <CommandBlock text={u.command} title={`Run this on ${runner.hostname || runner.name}`} className="mt-2.5" />}
      {u.state === "sending" && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-brand/10" aria-hidden>
          <div
            className={cn("h-full bg-brand transition-[width] duration-300 ease-out", percent === null && "w-1/3 animate-indeterminate")}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      )}
    </section>
  );
}

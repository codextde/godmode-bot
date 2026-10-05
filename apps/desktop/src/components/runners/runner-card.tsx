import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cookie, Ellipsis, HeartPulse, KeyRound, Monitor, MonitorSmartphone, Network, Pencil, RefreshCw, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import type { RemoteRunner } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot } from "@/components/aicss/Motion";
import { CopyButton } from "@/components/chat/copy-button";
import { cn } from "@/lib/utils";
import { TailscaleMark, isTailscaleHost } from "./network-picker";
import { RunnerHealthPanel, useRunnerHealth } from "./runner-health";
import {
  CHECK_COLOR,
  CHECK_ICON,
  HealthPill,
  RunnerStateBadge,
  latestSummary,
  runnerEndpoint,
  runnerPlatform,
  runnerProblem,
  runnerSyncLine,
  runnerVerdict,
  runnerWorkLine,
} from "./runner-parts";
import type { RunnerActions } from "./use-runner-actions";

const FOOTER_BUTTON = "h-7 gap-1.5 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3.5";

export function RunnerCard({
  runner,
  actions,
  onRename,
  onAddresses,
  onRemove,
  onScreen,
}: {
  runner: RemoteRunner;
  actions: RunnerActions;
  onRename: () => void;
  onAddresses: () => void;
  onRemove: () => void;
  onScreen: () => void;
}) {
  const online = runner.state === "online";
  const [healthOpen, setHealthOpen] = useState((runner.health?.failing ?? 0) > 0);
  // The report is loaded while the checks are open — and once by itself when nobody has looked at this runner yet, so
  // the card never just says "not checked". The pill shows the fresher of this report and the list's summary.
  const health = useRunnerHealth(runner, { enabled: healthOpen || !runner.health });
  const summary = latestSummary(runner.health, health.data);
  const failing = summary?.failing ?? 0;
  // Something keeps it from working: the checks open by themselves, once — that is where the fixes are.
  const opened = useRef(healthOpen);
  useEffect(() => {
    if (failing === 0 || opened.current) return;
    opened.current = true;
    setHealthOpen(true);
  }, [failing]);
  const working = runner.activeRuns > 0;
  const verdict = runnerVerdict(runner, summary);
  const problem = runnerProblem(runner);
  const sync = runnerSyncLine(runner);
  const platform = runnerPlatform(runner);
  const endpoint = runnerEndpoint(runner);
  const connecting = actions.isBusy("connect", runner.id) || runner.state === "connecting";
  const syncing = actions.isBusy("sync", runner.id) || runner.sync.state === "syncing";
  const rechecking = actions.isBusy("health", runner.id);
  const checking = rechecking || (online && !summary && health.isFetching);
  const repairing = actions.isBusy("autofix", runner.id);
  const panelId = `runner-health-${runner.id}`;
  const VerdictIcon = verdict.tone === "busy" ? null : CHECK_ICON[verdict.tone];

  return (
    <article aria-label={runner.name} className={cn("flex min-w-0 flex-col rounded-xl border bg-card shadow-card transition hover:border-foreground/15", working && "glow-border")}>
      <div className="flex items-start gap-3.5 p-4">
        <div className="relative shrink-0">
          <div className={cn("grid size-10 place-items-center rounded-lg border [&_svg]:size-5", online ? "bg-card text-foreground shadow-card" : "bg-paper-2 text-muted-foreground")}>
            <MonitorSmartphone />
          </div>
          <span className="absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-card p-[2px]">
            {online ? (
              <LiveDot live={working} className="bg-brand" />
            ) : (
              <span
                aria-hidden
                className={cn(
                  "block size-[7px] rounded-full",
                  runner.state === "offline" ? "bg-destructive" : runner.state === "update_required" ? "bg-warning" : "animate-pulse bg-brand/60",
                )}
              />
            )}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[15px] leading-snug font-medium tracking-[-0.01em]">{runner.name}</h3>
            <RunnerStateBadge runner={runner} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {platform ? <span className="text-foreground/80">{platform}</span> : <span>Hasn't connected yet</span>}
            {runner.version && (
              <>
                <span aria-hidden className="opacity-40">
                  ·
                </span>
                <span>Godmode {runner.version}</span>
              </>
            )}
          </p>
          {endpoint && (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs">
              <span className={cn("truncate font-mono", runner.address ? "text-foreground/80" : "text-muted-foreground")} title={runner.address ? `Connected through ${endpoint}` : `Godmode tries ${runner.addresses.join(", ")}`}>
                {endpoint}
              </span>
              {isTailscaleHost(runner.address ?? runner.addresses[0]) && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                  <TailscaleMark className="size-2.5" /> Tailscale
                </span>
              )}
              <CopyButton text={endpoint} label="Copy address" className="size-5" />
            </p>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                tabIndex={0}
                className="mt-0.5 flex max-w-full min-w-0 items-center gap-1 rounded-sm text-[11px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <KeyRound className="size-3 shrink-0 text-muted-foreground/80" aria-hidden />
                <span className="sr-only">Key fingerprint:</span>
                <span className="truncate font-mono">{runner.fingerprint}</span>
              </p>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
              <span className="block font-mono text-[11px]">{runner.fingerprint}</span>
              <span className="mt-1 block opacity-80">
                The key of {runner.hostname || runner.name}, pinned when you paired it. Godmode only talks to the computer that holds it, and everything between the two is
                end-to-end encrypted.
              </span>
            </TooltipContent>
          </Tooltip>
        </div>

        <RunnerMenu runner={runner} actions={actions} onRename={onRename} onAddresses={onAddresses} onRemove={onRemove} />
      </div>

      {problem && (
        <div
          className={cn(
            "mx-4 mb-4 flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border px-3 py-2.5 text-xs",
            problem.tone === "warn" ? "border-warning/30 bg-warning/[0.07]" : "border-destructive/25 bg-destructive/[0.05]",
          )}
          role="alert"
        >
          <TriangleAlert className={cn("mt-px size-3.5 shrink-0", problem.tone === "warn" ? "text-warning" : "text-destructive")} aria-hidden />
          <div className="min-w-0 flex-1 basis-48 space-y-0.5">
            <p className={cn("font-medium", problem.tone === "warn" ? "text-foreground" : "text-destructive")}>{problem.title}</p>
            <p className="leading-relaxed break-words text-muted-foreground">{problem.detail}</p>
          </div>
          {problem.kind === "connection" ? (
            <Button size="xs" variant="outline" disabled={connecting} onClick={() => actions.connect.mutate(runner)}>
              {connecting ? <Spinner className="size-3" /> : <RefreshCw />} Try again
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={syncing} onClick={() => actions.sync.mutate(runner)}>
              {syncing ? <Spinner className="size-3" /> : <RefreshCw />} Copy setup now
            </Button>
          )}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-1.5 text-[13px] font-medium">
            {VerdictIcon && verdict.tone !== "busy" ? (
              <VerdictIcon className={cn("size-3.5 shrink-0", CHECK_COLOR[verdict.tone])} aria-hidden />
            ) : (
              <Spinner className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="truncate">{verdict.label}</span>
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              {working && <LiveDot />}
              {runnerWorkLine(runner)}
            </span>
            <span aria-hidden className="opacity-40">
              ·
            </span>
            <span className={cn("inline-flex items-center gap-1", sync.tone === "error" && "text-destructive", sync.tone === "busy" && "text-shimmer font-medium")}>{sync.text}</span>
          </p>
        </div>
        <HealthPill
          summary={summary}
          checking={checking}
          stale={!online}
          expanded={healthOpen}
          controls={panelId}
          onClick={() => {
            opened.current = true;
            setHealthOpen((o) => !o);
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-0.5 rounded-b-xl border-t bg-paper-2/70 px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={!online || rechecking}
              className={FOOTER_BUTTON}
              onClick={() => {
                opened.current = true;
                setHealthOpen(true);
                actions.checkHealth.mutate(runner);
              }}
            >
              {rechecking ? <Spinner className="size-3.5" /> : <HeartPulse />}
              {rechecking ? "Checking…" : "Check health"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Look at its software, permissions and access again</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!online || syncing} className={FOOTER_BUTTON} onClick={() => actions.sync.mutate(runner)}>
              {syncing ? <Spinner className="size-3.5" /> : <RefreshCw />}
              {syncing ? "Copying…" : "Copy setup now"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Send your agents, logins, integrations and settings again — Godmode also does this by itself</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!online} className={FOOTER_BUTTON} onClick={onScreen}>
              <Monitor /> Screen
            </Button>
          </TooltipTrigger>
          <TooltipContent>See its screen and use its mouse and keyboard</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!online || repairing} className={cn(FOOTER_BUTTON, "ml-auto")} onClick={() => actions.autofix.mutate({ runner })}>
              {repairing ? <Spinner className="size-3.5" /> : <Sparkles />} Fix with Claude
            </Button>
          </TooltipTrigger>
          <TooltipContent>Start a chat that looks at this runner and repairs it</TooltipContent>
        </Tooltip>
      </div>

      <AnimatePresence initial={false}>
        {healthOpen && (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <RunnerHealthPanel runner={runner} actions={actions} className="border-t px-4 py-4" />
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function RunnerMenu({ runner, actions, onRename, onAddresses, onRemove }: { runner: RemoteRunner; actions: RunnerActions; onRename: () => void; onAddresses: () => void; onRemove: () => void }) {
  const pending = actions.isBusy("update", runner.id) || actions.isBusy("remove", runner.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={`More actions for ${runner.name}`}>
          {pending ? <Spinner /> : <Ellipsis />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={onRename}>
          <Pencil /> Rename…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAddresses}>
          <Network /> Addresses…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Stays open on a click: the switch is the answer. */}
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={runner.syncBrowser}
          className="items-start"
          onSelect={(e) => {
            e.preventDefault();
            actions.update.mutate({ runner, patch: { syncBrowser: !runner.syncBrowser } });
          }}
        >
          <Cookie className="mt-0.5" />
          <span className="min-w-0 flex-1">
            <span className="block">Copy browser sessions</span>
            <span className="block text-[11px] leading-snug text-muted-foreground">Chats start there signed in to the same sites as here.</span>
          </span>
          <Switch size="sm" checked={runner.syncBrowser} tabIndex={-1} aria-hidden className="pointer-events-none mt-0.5" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trash2 /> Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

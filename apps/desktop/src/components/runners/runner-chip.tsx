import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Laptop, MonitorSmartphone, Plus, RefreshCw, Settings2, TriangleAlert, WifiOff } from "lucide-react";
import type { RemoteRunner } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { timeAgo } from "@/components/ssh/ssh-parts";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useRunners } from "@/lib/hooks";
import { upsertRunner } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { RUNNER_STATE_LABEL, RunnerStateDot, THIS_COMPUTER, THIS_COMPUTER_INLINE } from "./runner-parts";

/** Why a runner can or can't take a chat right now, in a few words. */
function runnerLine(runner: RemoteRunner): string {
  switch (runner.state) {
    case "online": {
      const parts = ["Online"];
      if (runner.activeRuns > 0) parts.push(`${runner.activeRuns} working`);
      if (runner.health && runner.health.failing > 0) parts.push(`${runner.health.failing} to fix first`);
      return parts.join(" · ");
    }
    case "offline":
      return runner.lastSeenAt ? `Offline · last online ${timeAgo(runner.lastSeenAt)}` : "Offline";
    case "connecting":
    case "update_required":
      return RUNNER_STATE_LABEL[runner.state];
  }
}

/**
 * Composer control of a new chat for where it works: this computer, or a runner. Hidden while no runner is paired. A
 * runner that isn't online is listed but can't be picked.
 */
export function RunnerChip({ value, onChange }: { value: string | null; onChange: (runnerId: string | null) => void }) {
  const { data: runners = [] } = useRunners();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (runners.length === 0) return null;

  const current = value ? (runners.find((r) => r.id === value) ?? null) : null;
  const pick = (runnerId: string | null) => {
    setOpen(false);
    if (runnerId !== value) onChange(runnerId);
  };
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {current ? (
              <button
                type="button"
                aria-label={`Runs on ${current.name} (${RUNNER_STATE_LABEL[current.state].toLowerCase()})`}
                className="flex h-8 max-w-[12rem] min-w-0 shrink items-center gap-1.5 rounded-lg border bg-card pr-1.5 pl-2 text-[13px] transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <MonitorSmartphone className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{current.name}</span>
                <RunnerStateDot state={current.state} />
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                aria-label={`Runs on ${THIS_COMPUTER_INLINE} — pick a runner`}
                className={cn(
                  "h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4",
                  open && "bg-accent text-foreground",
                )}
              >
                <Laptop />
                <span className="@max-sm/composer:sr-only">{THIS_COMPUTER}</span>
              </Button>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{current ? `This chat will work on ${current.name}` : "Work on another computer"}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <div className="border-b px-3 pt-2.5 pb-2">
          <p className="text-[13px] font-medium">Run on</p>
          <p className="text-xs text-muted-foreground">The computer that does the work of this chat. A runner keeps going while this one sleeps — and the chat stays where it started.</p>
        </div>
        <Command>
          <CommandList className="max-h-72">
            <CommandGroup>
              <CommandItem value="__local" onSelect={() => pick(null)} className="gap-2.5 py-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground [&_svg]:size-3.5">
                  <Laptop />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{THIS_COMPUTER}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">Works here, with your folders, screen and VMs</span>
                </span>
                {!current && <Check className="size-4" aria-label="Selected" />}
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Runners">
              {runners.map((runner) => (
                <CommandItem
                  key={runner.id}
                  value={`runner ${runner.name} ${runner.id}`}
                  disabled={runner.state !== "online"}
                  onSelect={() => pick(runner.id)}
                  className="gap-2.5 py-2"
                  title={runner.state !== "online" && runner.error ? runner.error : undefined}
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground [&_svg]:size-3.5">
                    <MonitorSmartphone />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{runner.name}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <RunnerStateDot state={runner.state} />
                      <span className="truncate">{runnerLine(runner)}</span>
                    </span>
                  </span>
                  {current?.id === runner.id && <Check className="size-4" aria-label="Selected" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__add" onSelect={() => go("/runners?new=1")} className="text-muted-foreground">
                <Plus /> Add runner
              </CommandItem>
              <CommandItem value="__manage" onSelect={() => go("/runners")} className="text-muted-foreground">
                <Settings2 /> Manage runners
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The line under a new chat's composer once a runner is picked: what happens before the work starts there. */
export function RunnerNote({ runner }: { runner: RemoteRunner | null }) {
  if (runner && runner.state !== "online") {
    return (
      <p className="flex items-start gap-1.5 px-1 pt-2 text-xs text-warning" role="status">
        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {runner.state === "update_required"
            ? `${runner.name} runs another version of Godmode. Update Godmode on both computers, or pick another one — your message stays here.`
            : runner.state === "connecting"
              ? `Connecting to ${runner.name}… Your message stays here until it's there.`
              : `${runner.name} went offline. Pick another computer, or wait until it's back — your message stays here.`}
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 px-1 pt-2 text-xs text-muted-foreground">
      <MonitorSmartphone className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        Runs on <span className="font-medium text-foreground">{runner?.name ?? "a runner"}</span>.{" "}
        {runner && !runner.syncBrowser ? "Your agents and logins are copied there first." : "Your agents, logins and browser sessions are copied there first."}
      </span>
    </p>
  );
}

/** In the tray of a chat that lives on a runner: where it works, and whether that computer is there. A chat can't move. */
export function RunnerPill({ runner }: { runner: RemoteRunner | null }) {
  const tooltip = !runner
    ? "This chat works on a runner"
    : runner.state === "online"
      ? `This chat works on ${runner.name} — it keeps going while ${THIS_COMPUTER_INLINE} sleeps`
      : runner.state === "connecting"
        ? `This chat works on ${runner.name} — connecting…`
        : runner.state === "offline"
          ? `This chat works on ${runner.name}, which is offline`
          : `This chat works on ${runner.name}, which needs an update`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/runners"
          aria-label={runner ? `On ${runner.name} (${RUNNER_STATE_LABEL[runner.state].toLowerCase()}) — open runners` : "On a runner — open runners"}
          className="flex h-8 max-w-[12rem] min-w-0 shrink items-center gap-1.5 rounded-lg border bg-card px-2 text-[13px] transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <MonitorSmartphone className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            On <span className="font-medium">{runner?.name ?? "a runner"}</span>
          </span>
          {runner && <RunnerStateDot state={runner.state} />}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Above the composer of a runner's chat while that runner can't be reached: why nothing can be sent, and a way to try now. */
export function RunnerOfflineBar({ runner }: { runner: RemoteRunner }) {
  const qc = useQueryClient();
  const connect = useMutation({
    mutationFn: () => api.runners.connect(runner.id),
    onSuccess: (next) => void upsertRunner(qc, next),
    onError: (e) => toastApiError(e, `Couldn't reach ${runner.name}`, qc),
  });
  const connecting = runner.state === "connecting" || connect.isPending;
  const update = runner.state === "update_required";

  return (
    <div className="mb-2 flex items-center gap-2.5 rounded-lg border bg-card py-1.5 pr-1.5 pl-3 text-[13px] text-muted-foreground shadow-card" role="status">
      {connecting ? <Spinner className="size-3.5 shrink-0" aria-hidden /> : update ? <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden /> : <WifiOff className="size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 leading-snug" title={runner.error ?? undefined}>
        {connecting ? (
          <>
            <span className="font-medium text-foreground">Connecting to {runner.name}…</span> Messages can be sent again when it's there.
          </>
        ) : update ? (
          <>
            <span className="font-medium text-foreground">{runner.name} needs an update</span> — messages can be sent again once it runs the same Godmode as this computer.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">{runner.name} is offline</span> — messages can be sent again when it's back.
          </>
        )}
      </span>
      {update ? (
        <Button size="xs" variant="ghost" asChild>
          <Link to="/runners">Open runners</Link>
        </Button>
      ) : (
        <Button size="xs" variant="ghost" disabled={connecting} onClick={() => connect.mutate()}>
          <RefreshCw /> Try again
        </Button>
      )}
    </div>
  );
}

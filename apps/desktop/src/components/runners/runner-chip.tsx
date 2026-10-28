import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Laptop, MonitorSmartphone, RefreshCw, Settings2, TriangleAlert, WifiOff } from "lucide-react";
import type { RemoteRunner } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { timeAgo } from "@/components/ssh/ssh-parts";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { isOlderRunner, isRunnerPlace, placeName, usePlaces, type Place } from "@/lib/places";
import { upsertRunner } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { RUNNER_STATE_LABEL, RunnerStateDot, RunnerTag, THIS_COMPUTER, THIS_COMPUTER_INLINE } from "./runner-parts";

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

function placeLine(place: Place): string {
  if (place.here) return "Works here, with your folders, screen and VMs";
  if (place.runner) return place.twinOf ? `${runnerLine(place.runner)} · older setup` : runnerLine(place.runner);
  return place.state === "online" ? "Online · the primary of your group" : "Offline";
}

function PlaceIcon({ place }: { place: Place }) {
  return place.here ? <Laptop /> : <MonitorSmartphone />;
}

/**
 * Composer control of a new chat for where it works: this computer or another computer of the device group. Hidden
 * while there is nowhere else. A place that isn't online is listed but can't be picked.
 */
export function RunnerChip({ value, onChange }: { value: string | null; onChange: (runnerId: string | null) => void }) {
  const { places, hereId } = usePlaces();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const others = places.filter((p) => !p.here && !isOlderRunner(p));
  if (!others.length) return null;

  const current = others.find((p) => p.runnerId === value) ?? null;
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
                aria-label={`Runs on ${placeName(current)} (${RUNNER_STATE_LABEL[current.state].toLowerCase()})`}
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
                aria-label={`Runs on ${THIS_COMPUTER_INLINE} — pick another computer`}
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
        <TooltipContent>{current ? `This chat will work on ${placeName(current)}` : "Work on another computer"}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <div className="border-b px-3 pt-2.5 pb-2">
          <p className="text-[13px] font-medium">Run on</p>
          <p className="text-xs text-muted-foreground">
            The computer that does the work of this chat. You see it on every computer of your group, and it can move later — also while it works.
          </p>
        </div>
        <Command>
          <CommandList className="max-h-72">
            <CommandGroup>
              <CommandItem value="__local" onSelect={() => pick(hereId)} className="gap-2.5 py-2">
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
            <CommandGroup heading="Your devices">
              {others.map((place) => (
                <PlaceItem key={place.runnerId ?? "primary"} place={place} selected={current === place} onSelect={() => pick(place.runnerId)} />
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__devices" onSelect={() => go("/settings/devices")} className="text-muted-foreground">
                <Settings2 /> Manage devices
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PlaceItem({ place, selected, onSelect }: { place: Place; selected: boolean; onSelect: () => void }) {
  return (
    <CommandItem
      value={`place ${place.name} ${place.runnerId ?? "primary"}`}
      disabled={place.state !== "online"}
      onSelect={onSelect}
      className="gap-2.5 py-2"
      title={place.state !== "online" && place.runner?.error ? place.runner.error : undefined}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground [&_svg]:size-3.5">
        <PlaceIcon place={place} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{place.name}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <RunnerStateDot state={place.state} />
          <span className="truncate">{placeLine(place)}</span>
        </span>
      </span>
      {selected && <Check className="size-4" aria-label="Selected" />}
    </CommandItem>
  );
}

/** The line under a new chat's composer once another computer is picked: what happens before the work starts there. */
export function RunnerNote({ place }: { place: Place | null }) {
  const name = place ? placeName(place) : "another computer";
  if (place && place.state !== "online") {
    return (
      <p className="flex items-start gap-1.5 px-1 pt-2 text-xs text-warning" role="status">
        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {place.state === "update_required"
            ? `${name} runs another version of Godmode. Update Godmode on both computers, or pick another one — your message stays here.`
            : place.state === "connecting"
              ? `Connecting to ${name}… Your message stays here until it's there.`
              : `${name} went offline. Pick another computer, or wait until it's back — your message stays here.`}
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 px-1 pt-2 text-xs text-muted-foreground">
      <MonitorSmartphone className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        Runs on <span className="font-medium text-foreground">{name}</span>. It has your agents and logins too, and you can follow it from here.
      </span>
    </p>
  );
}

/**
 * In the tray of a chat: where it works (another computer of the group, a runner, or this Mac within a group) and
 * whether that computer is there. Its menu moves the chat to another online computer.
 */
export function RunnerPill({ place, targets, onMove }: { place: Place | null; targets: Place[]; onMove: (to: Place) => void }) {
  const navigate = useNavigate();
  const { inGroup } = usePlaces();
  const [open, setOpen] = useState(false);
  const name = place?.name ?? "a runner";
  const full = place ? placeName(place) : "a runner";
  const tagged = isRunnerPlace(place, inGroup);
  const tooltip = !place
    ? "This chat works on a runner"
    : place.here
      ? `This chat works on ${THIS_COMPUTER_INLINE}`
      : place.state === "online"
        ? `This chat works on ${full} — it keeps going while ${THIS_COMPUTER_INLINE} sleeps`
        : place.state === "connecting"
          ? `This chat works on ${full} — connecting…`
          : place.state === "offline"
            ? `This chat works on ${full}, which is offline`
            : `This chat works on ${full}, which needs an update`;
  const act = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={place ? `On ${full} (${RUNNER_STATE_LABEL[place.state].toLowerCase()})` : "On a runner"}
              className={cn(
                "flex h-8 max-w-[15rem] min-w-0 shrink items-center gap-1.5 rounded-lg border bg-card pr-1.5 pl-2 text-[13px] transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                open && "bg-accent",
              )}
            >
              {place?.here ? <Laptop className="size-3.5 shrink-0 text-muted-foreground" /> : <MonitorSmartphone className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="truncate">
                On <span className="font-medium">{name}</span>
              </span>
              {tagged && <RunnerTag />}
              {place && !place.here && <RunnerStateDot state={place.state} />}
              <ChevronDown className="size-3.5 shrink-0 opacity-60" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <div className="flex items-start gap-2.5 border-b px-3 pt-2.5 pb-2">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground [&_svg]:size-3.5">
            {place?.here ? <Laptop /> : <MonitorSmartphone />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-medium">{place?.name ?? "A runner"}</span>
              {tagged && <RunnerTag />}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {place && <RunnerStateDot state={place.state} />}
              <span className="truncate">{place ? placeLine(place) : "Removed"}</span>
            </span>
          </span>
        </div>
        <Command>
          <CommandList>
            {targets.length > 0 && (
              <CommandGroup heading="Move to">
                {targets.map((t) => (
                  <CommandItem key={t.runnerId ?? "primary"} value={`move ${t.name} ${t.runnerId ?? "primary"}`} onSelect={() => act(() => onMove(t))} className="gap-2.5 py-2">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground [&_svg]:size-3.5">
                      <PlaceIcon place={t} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{t.name}</span>
                        {isRunnerPlace(t, inGroup) && <RunnerTag />}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">Continue there with the whole conversation</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__manage" onSelect={() => act(() => navigate("/settings/devices"))} className="text-muted-foreground">
                <Settings2 /> Manage devices
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Above the composer of a runner's chat while that runner can't be reached: why nothing can be sent, a way to try now,
 * and a way to continue on this computer instead.
 */
export function RunnerOfflineBar({ runner, onMove }: { runner: RemoteRunner; onMove: () => void }) {
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
          <Link to="/settings/devices">Open devices</Link>
        </Button>
      ) : (
        <Button size="xs" variant="ghost" disabled={connecting} onClick={() => connect.mutate()}>
          <RefreshCw /> Try again
        </Button>
      )}
      <Button size="xs" variant="outline" onClick={onMove}>
        <Laptop />
        <span className="@lg:hidden">Move here</span>
        <span className="hidden @lg:inline">Continue on {THIS_COMPUTER_INLINE}</span>
      </Button>
    </div>
  );
}

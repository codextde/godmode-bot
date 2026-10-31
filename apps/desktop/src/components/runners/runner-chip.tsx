import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Check, ChevronDown, Laptop, MonitorSmartphone, RefreshCw, Settings2, TriangleAlert, WifiOff } from "lucide-react";
import type { RemoteRunner } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { timeAgo } from "@/components/ssh/ssh-parts";
import { toastApiError } from "@/components/vault/vault-utils";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { isOlderRunner, isRunnerPlace, placeName, usePlaces, type Place } from "@/lib/places";
import { upsertRunner } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { RUNNER_STATE_LABEL, RunnerStateDot, RunnerTag, thisComputer, thisComputerInline } from "./runner-parts";

/** Why a runner can or can't take a chat right now, in a few words. */
function runnerLine(runner: RemoteRunner): string {
  switch (runner.state) {
    case "online": {
      const parts = [RUNNER_STATE_LABEL.online];
      if (runner.activeRuns > 0) parts.push(t("runners:chip.working", { count: runner.activeRuns }));
      if (runner.health && runner.health.failing > 0) parts.push(t("runners:chip.toFix", { count: runner.health.failing }));
      return parts.join(" · ");
    }
    case "offline":
      return runner.lastSeenAt ? t("runners:chip.offlineSince", { when: timeAgo(runner.lastSeenAt) }) : RUNNER_STATE_LABEL.offline;
    case "connecting":
    case "update_required":
      return RUNNER_STATE_LABEL[runner.state];
  }
}

function placeLine(place: Place): string {
  if (place.here) return t("runners:chip.worksHere");
  if (place.runner) return place.twinOf ? t("runners:chip.olderSetup", { line: runnerLine(place.runner) }) : runnerLine(place.runner);
  return place.state === "online" ? t("runners:chip.primaryOnline") : RUNNER_STATE_LABEL.offline;
}

function PlaceIcon({ place }: { place: Place }) {
  return place.here ? <Laptop /> : <MonitorSmartphone />;
}

/**
 * Composer control of a new chat for where it works: this computer or another computer of the device group. Hidden
 * while there is nowhere else. A place that isn't online is listed but can't be picked.
 */
export function RunnerChip({ value, onChange }: { value: string | null; onChange: (runnerId: string | null) => void }) {
  const { t } = useTranslation("runners");
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
                aria-label={t("chip.runsOnLabel", { name: placeName(current), state: RUNNER_STATE_LABEL[current.state].toLowerCase() })}
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
                aria-label={t("chip.runsHereLabel", { name: thisComputerInline() })}
                className={cn(
                  "h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4",
                  open && "bg-accent text-foreground",
                )}
              >
                <Laptop />
                <span className="@max-sm/composer:sr-only">{thisComputer()}</span>
              </Button>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{current ? t("chip.willWorkOn", { name: placeName(current) }) : t("chip.workElsewhere")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <div className="border-b px-3 pt-2.5 pb-2">
          <p className="text-[13px] font-medium">{t("chip.runOn")}</p>
          <p className="text-xs text-muted-foreground">{t("chip.runOnHint")}</p>
        </div>
        <Command>
          <CommandList className="max-h-72">
            <CommandGroup>
              <CommandItem value="__local" onSelect={() => pick(hereId)} className="gap-2.5 py-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground [&_svg]:size-3.5">
                  <Laptop />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{thisComputer()}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{t("chip.worksHere")}</span>
                </span>
                {!current && <Check className="size-4" aria-label={t("chip.selected")} />}
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={t("chip.yourDevices")}>
              {others.map((place) => (
                <PlaceItem key={place.runnerId ?? "primary"} place={place} selected={current === place} onSelect={() => pick(place.runnerId)} />
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__devices" onSelect={() => go("/settings/devices")} className="text-muted-foreground">
                <Settings2 /> {t("chip.manageDevices")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PlaceItem({ place, selected, onSelect }: { place: Place; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation("runners");
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
      {selected && <Check className="size-4" aria-label={t("chip.selected")} />}
    </CommandItem>
  );
}

/** The line under a new chat's composer once another computer is picked: what happens before the work starts there. */
export function RunnerNote({ place }: { place: Place | null }) {
  const { t } = useTranslation("runners");
  const name = place ? placeName(place) : t("move.anotherComputerInline");
  if (place && place.state !== "online") {
    return (
      <p className="flex items-start gap-1.5 px-1 pt-2 text-xs text-warning" role="status">
        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {place.state === "update_required"
            ? t("note.updateRequired", { name })
            : place.state === "connecting"
              ? t("note.connecting", { name })
              : t("note.offline", { name })}
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 px-1 pt-2 text-xs text-muted-foreground">
      <MonitorSmartphone className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        <Trans t={t} i18nKey="note.runsOn" values={{ name }} components={{ b: <span className="font-medium text-foreground" /> }} />
      </span>
    </p>
  );
}

/**
 * In the tray of a chat: where it works (another computer of the group, a runner, or this Mac within a group) and
 * whether that computer is there. Its menu moves the chat to another online computer.
 */
export function RunnerPill({ place, targets, onMove }: { place: Place | null; targets: Place[]; onMove: (to: Place) => void }) {
  const { t } = useTranslation("runners");
  const navigate = useNavigate();
  const { inGroup } = usePlaces();
  const [open, setOpen] = useState(false);
  const name = place?.name ?? t("pill.aRunner");
  const full = place ? placeName(place) : t("pill.aRunner");
  const tagged = isRunnerPlace(place, inGroup);
  const tooltip = !place
    ? t("pill.onRunner")
    : place.here
      ? t("pill.worksOn", { name: thisComputerInline() })
      : place.state === "online"
        ? t("pill.worksOnOnline", { name: full, here: thisComputerInline() })
        : place.state === "connecting"
          ? t("pill.worksOnConnecting", { name: full })
          : place.state === "offline"
            ? t("pill.worksOnOffline", { name: full })
            : t("pill.worksOnUpdate", { name: full });
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
              aria-label={place ? t("pill.onLabel", { name: full, state: RUNNER_STATE_LABEL[place.state].toLowerCase() }) : t("pill.onARunner")}
              className={cn(
                "flex h-8 max-w-[15rem] min-w-0 shrink items-center gap-1.5 rounded-lg border bg-card pr-1.5 pl-2 text-[13px] transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                open && "bg-accent",
              )}
            >
              {place?.here ? <Laptop className="size-3.5 shrink-0 text-muted-foreground" /> : <MonitorSmartphone className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="truncate">
                <Trans t={t} i18nKey="pill.on" values={{ name }} components={{ b: <span className="font-medium" /> }} />
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
              <span className="truncate text-[13px] font-medium">{place?.name ?? t("pill.aRunnerTitle")}</span>
              {tagged && <RunnerTag />}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {place && <RunnerStateDot state={place.state} />}
              <span className="truncate">{place ? placeLine(place) : t("pill.removed")}</span>
            </span>
          </span>
        </div>
        <Command>
          <CommandList>
            {targets.length > 0 && (
              <CommandGroup heading={t("move.moveTo")}>
                {targets.map((target) => (
                  <CommandItem key={target.runnerId ?? "primary"} value={`move ${target.name} ${target.runnerId ?? "primary"}`} onSelect={() => act(() => onMove(target))} className="gap-2.5 py-2">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground [&_svg]:size-3.5">
                      <PlaceIcon place={target} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{target.name}</span>
                        {isRunnerPlace(target, inGroup) && <RunnerTag />}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">{t("pill.continueThere")}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__manage" onSelect={() => act(() => navigate("/settings/devices"))} className="text-muted-foreground">
                <Settings2 /> {t("chip.manageDevices")}
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
  const { t } = useTranslation(["runners", "common"]);
  const qc = useQueryClient();
  const connect = useMutation({
    mutationFn: () => api.runners.connect(runner.id),
    onSuccess: (next) => void upsertRunner(qc, next),
    onError: (e) => toastApiError(e, t("offline.unreachable", { name: runner.name }), qc),
  });
  const connecting = runner.state === "connecting" || connect.isPending;
  const update = runner.state === "update_required";

  return (
    <div className="mb-2 flex items-center gap-2.5 rounded-lg border bg-card py-1.5 pr-1.5 pl-3 text-[13px] text-muted-foreground shadow-card" role="status">
      {connecting ? <Spinner className="size-3.5 shrink-0" aria-hidden /> : update ? <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden /> : <WifiOff className="size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 leading-snug" title={runner.error ?? undefined}>
        {connecting ? (
          <Trans t={t} i18nKey="offline.connecting" values={{ name: runner.name }} components={{ b: <span className="font-medium text-foreground" /> }} />
        ) : update ? (
          <Trans t={t} i18nKey="offline.update" values={{ name: runner.name }} components={{ b: <span className="font-medium text-foreground" /> }} />
        ) : (
          <Trans t={t} i18nKey="offline.offline" values={{ name: runner.name }} components={{ b: <span className="font-medium text-foreground" /> }} />
        )}
      </span>
      {update ? (
        <Button size="xs" variant="ghost" asChild>
          <Link to="/settings/devices">{t("offline.openDevices")}</Link>
        </Button>
      ) : (
        <Button size="xs" variant="ghost" disabled={connecting} onClick={() => connect.mutate()}>
          <RefreshCw /> {t("common:actions.tryAgain")}
        </Button>
      )}
      <Button size="xs" variant="outline" onClick={onMove}>
        <Laptop />
        <span className="@lg:hidden">{t("offline.moveHere")}</span>
        <span className="hidden @lg:inline">{t("offline.continueOn", { name: thisComputerInline() })}</span>
      </Button>
    </div>
  );
}

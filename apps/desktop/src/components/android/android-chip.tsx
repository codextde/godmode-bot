import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, Check, ChevronDown, Loader2, Lock, Plus, Settings2, Smartphone } from "lucide-react";
import type { Agent, AndroidDevice } from "@godmode/shared";
import { androidSummary } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAndroidDevices, useBootstrap } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AndroidDot, stateLabel } from "./android-parts";

function listNames(devices: AndroidDevice[]): string {
  const names = devices.map((d) => d.name);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** Phone controls show while Android phones are on in Settings (runs get no phones otherwise). */
function useAndroidEnabled(): boolean {
  const { data: boot } = useBootstrap();
  return !!boot?.settings.android.enabled;
}

/**
 * Composer control for the Android phones a chat can control: a quiet button while the run would have none, a pill
 * with the first phone's name otherwise (dashed when they all come from the agent). The agent's own phones are always
 * on; the chat adds more.
 */
export function AndroidChip({
  agent,
  value,
  onChange,
  busy,
}: {
  agent: Agent | undefined;
  /** The chat's own phones (the agent's apply anyway). */
  value: string[];
  onChange: (androidDeviceIds: string[]) => void | Promise<unknown>;
  busy?: boolean;
}) {
  const enabled = useAndroidEnabled();
  const { data: devices = [], isLoading } = useAndroidDevices();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!agent || !enabled) return null;

  const fromAgent = new Set(agent.androidDeviceIds ?? []);
  const own = devices.filter((d) => value.includes(d.id) && !fromAgent.has(d.id));
  const inherited = devices.filter((d) => fromAgent.has(d.id));
  const active = [...own, ...inherited];
  const first = active[0];

  const known = value.filter((id) => devices.some((d) => d.id === id));
  const toggle = (id: string) => void onChange(known.includes(id) ? known.filter((x) => x !== id) : [...known, id]);
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  const tooltip = !first
    ? "Let this chat use your Android phones"
    : own.length === 0
      ? `Can use ${listNames(inherited)} — assigned to ${agent.name}`
      : `This chat can use ${listNames(active)}`;
  const icon = busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {first ? (
              <button
                type="button"
                aria-label={`Android phones: ${active.map((d) => d.name).join(", ")}`}
                className={cn(
                  "flex h-8 max-w-[12rem] min-w-14 shrink items-center gap-1.5 rounded-lg border pr-1.5 pl-2 text-[13px] transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  own.length > 0 ? "bg-card hover:bg-accent" : "border-dashed text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {icon}
                <span className={cn("truncate @max-md/composer:sr-only", own.length > 0 && "font-medium")}>{first.name}</span>
                {active.length > 1 && (
                  <span className="shrink-0 rounded-[4px] border bg-paper-2 px-1 font-mono text-[10px] text-muted-foreground tabular-nums">+{active.length - 1}</span>
                )}
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                aria-label="Android phones"
                className={cn(
                  "h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4",
                  open && "bg-accent text-foreground",
                )}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Smartphone />}
                <span className="@max-sm/composer:sr-only">Phone</span>
              </Button>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <div className="border-b px-3 pt-2.5 pb-2">
          <p className="text-[13px] font-medium">Android phones</p>
          <p className="text-xs text-muted-foreground">Runs in this chat see the screen, tap, type, open apps and run shell commands.</p>
        </div>
        {!isLoading && devices.length === 0 ? (
          <div className="space-y-3 px-3 py-4 text-center">
            <p className="text-xs text-muted-foreground">No phones yet.</p>
            <Button size="sm" onClick={() => go("/settings/android")}>
              <Plus /> Connect a phone
            </Button>
          </div>
        ) : (
          <>
            <Command>
              {devices.length > 6 && <CommandInput placeholder="Find a phone…" />}
              <CommandList className="max-h-72">
                <CommandEmpty>No phone with that name.</CommandEmpty>
                <CommandGroup>
                  {devices.map((d) => {
                    const locked = fromAgent.has(d.id);
                    const on = locked || value.includes(d.id);
                    return (
                      <CommandItem
                        key={d.id}
                        value={`${d.name} ${androidSummary(d)} ${d.id}`}
                        disabled={locked}
                        onSelect={() => toggle(d.id)}
                        className="gap-2.5 py-2 data-[disabled=true]:opacity-100"
                      >
                        <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
                          <Smartphone className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate">{d.name}</span>
                            <AndroidDot device={d} className="shrink-0" />
                          </span>
                          {locked ? (
                            <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                              <Lock className="size-3" aria-hidden /> Assigned to {agent.name}
                            </span>
                          ) : (
                            <span className="block truncate text-[11px] text-muted-foreground">{androidSummary(d)}</span>
                          )}
                        </span>
                        {on && <Check className={cn("size-4", locked && "opacity-50")} aria-label={locked ? "Always on" : "Selected"} />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
            <div className="border-t p-1">
              <Button type="button" variant="ghost" size="sm" className="w-full justify-start font-normal text-muted-foreground" onClick={() => go("/settings/android")}>
                <Settings2 /> Manage phones
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The agent form's list of phones: every run of the agent can control the checked ones. */
export function AndroidField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { data: devices = [], isLoading } = useAndroidDevices();
  if (!isLoading && devices.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3.5">
        <Smartphone className="size-5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">No phones yet — connect one and this agent can use it.</p>
        <Button type="button" variant="outline" size="sm" asChild>
          <Link to="/settings/android">
            <Plus /> Connect a phone
          </Link>
        </Button>
      </div>
    );
  }
  const toggle = (id: string, on: boolean) => onChange(on ? [...value.filter((x) => x !== id), id] : value.filter((x) => x !== id));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span id="agent-android-label" className="text-sm font-medium">
          Can control
        </span>
        <Link to="/settings/android" className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          Manage phones <ArrowRight className="size-3" />
        </Link>
      </div>
      <div role="group" aria-labelledby="agent-android-label" className="divide-y overflow-hidden rounded-lg border">
        {isLoading
          ? [0, 1].map((i) => <div key={i} className="h-[52px] animate-pulse bg-paper-2/60" />)
          : devices.map((d) => {
              const id = `agent-android-${d.id}`;
              return (
                <label key={d.id} htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-accent/50">
                  <Checkbox id={id} checked={value.includes(d.id)} onCheckedChange={(v) => toggle(d.id, v === true)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{d.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{androidSummary(d)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <AndroidDot device={d} className="shrink-0" />
                    <span className="hidden @xl:inline">{stateLabel(d)}</span>
                  </span>
                </label>
              );
            })}
      </div>
      <p className="text-xs text-muted-foreground">Every run of this agent can control these. A single chat can add more with the phone button in its message box.</p>
    </div>
  );
}

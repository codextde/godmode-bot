import { useState } from "react";
import { useNavigate } from "react-router";
import { Check, ChevronDown, Loader2, Lock, Plus, Server, Settings2 } from "lucide-react";
import type { Agent, SshServer } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSshServers } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { SshStatusDot, sshAddress } from "./ssh-parts";

function listNames(servers: SshServer[]): string {
  const names = servers.map((s) => s.name);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/**
 * Composer control for the SSH servers a chat can sign in to: a quiet button while the run would have none, a pill
 * with the first server's name otherwise (dashed when they all come from the agent). The agent's own servers are
 * always on; the chat adds more.
 */
export function SshChip({
  agent,
  value,
  onChange,
  busy,
}: {
  agent: Agent | undefined;
  /** The chat's own servers (the agent's apply anyway). */
  value: string[];
  onChange: (sshServerIds: string[]) => void | Promise<unknown>;
  busy?: boolean;
}) {
  const { data: servers = [], isLoading } = useSshServers();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!agent) return null;

  const fromAgent = new Set(agent.sshServerIds ?? []);
  const own = servers.filter((s) => value.includes(s.id) && !fromAgent.has(s.id));
  const inherited = servers.filter((s) => fromAgent.has(s.id));
  const active = [...own, ...inherited];
  const first = active[0];

  const toggle = (id: string) => void onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  const tooltip = !first
    ? "Let this chat sign in to your servers"
    : own.length === 0
      ? `Can sign in to ${listNames(inherited)} — assigned to ${agent.name}`
      : `This chat can sign in to ${listNames(active)}`;
  const icon = busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Server className="size-3.5 shrink-0 text-muted-foreground" />;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {first ? (
              <button
                type="button"
                aria-label={`SSH servers: ${active.map((s) => s.name).join(", ")}`}
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
                aria-label="SSH servers"
                className={cn(
                  "h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4",
                  open && "bg-accent text-foreground",
                )}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Server />}
                <span className="@max-sm/composer:sr-only">SSH</span>
              </Button>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <div className="border-b px-3 pt-2.5 pb-2">
          <p className="text-[13px] font-medium">SSH servers</p>
          <p className="text-xs text-muted-foreground">Runs in this chat can sign in, run commands and move files. Godmode types the password or key.</p>
        </div>
        {!isLoading && servers.length === 0 ? (
          <div className="space-y-3 px-3 py-4 text-center">
            <p className="text-xs text-muted-foreground">No SSH servers yet.</p>
            <Button size="sm" onClick={() => go("/ssh?new=1")}>
              <Plus /> Add server
            </Button>
          </div>
        ) : (
          <>
            <Command>
              {servers.length > 6 && <CommandInput placeholder="Find a server…" />}
              <CommandList className="max-h-72">
                <CommandEmpty>No server with that name.</CommandEmpty>
                <CommandGroup>
                  {servers.map((s) => {
                    const locked = fromAgent.has(s.id);
                    const on = locked || value.includes(s.id);
                    return (
                      <CommandItem
                        key={s.id}
                        value={`${s.name} ${s.host} ${s.id}`}
                        disabled={locked}
                        onSelect={() => toggle(s.id)}
                        className="gap-2.5 py-2 data-[disabled=true]:opacity-100"
                      >
                        <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
                          <Server className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate">{s.name}</span>
                            <SshStatusDot server={s} />
                          </span>
                          {locked ? (
                            <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                              <Lock className="size-3" aria-hidden /> Assigned to {agent.name}
                            </span>
                          ) : (
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">{sshAddress(s)}</span>
                          )}
                        </span>
                        {on && <Check className={cn("size-4", locked && "opacity-50")} aria-label={locked ? "Always on" : "Selected"} />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
            <div className="flex items-center gap-1 border-t p-1">
              <Button type="button" variant="ghost" size="sm" className="flex-1 justify-start font-normal text-muted-foreground" onClick={() => go("/ssh?new=1")}>
                <Plus /> Add server
              </Button>
              <Button type="button" variant="ghost" size="sm" className="font-normal text-muted-foreground" onClick={() => go("/ssh")}>
                <Settings2 /> Manage
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

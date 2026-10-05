import { Check, Users } from "lucide-react";
import type { Mod, ModScope } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { Segmented } from "@/components/settings/settings-kit";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { ModActions } from "./use-mod-actions";

const AGENT_CHIP = "inline-flex h-6 max-w-[12rem] min-w-0 items-center gap-1.5 rounded-md border bg-card pr-2 pl-1.5 text-xs shadow-xs";

/** Whose runs load the mod, as chips: "Every agent", the chosen agents, or a nudge while nobody is chosen. */
export function RunsForSummary({ mod, max = 3 }: { mod: Mod; max?: number }) {
  const { data: agents = [] } = useAllAgents();
  if (mod.scope === "all") {
    return (
      <span className={AGENT_CHIP}>
        <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        Every agent
      </span>
    );
  }
  if (mod.agentIds.length === 0) return <span className="mr-1 text-xs text-warning/85">No agent yet</span>;
  const rest = mod.agentIds.length - max;
  return (
    <>
      {mod.agentIds.slice(0, max).map((id) => {
        const agent = agents.find((a) => a.id === id);
        return (
          <span key={id} className={AGENT_CHIP}>
            {agent && <AgentAvatar agent={agent} size="sm" still className="size-4 rounded-[4px] text-[10px]" />}
            <span className="truncate">{agent?.name ?? "Agent"}</span>
          </span>
        );
      })}
      {rest > 0 && <span className="text-xs text-muted-foreground tabular-nums">+{rest}</span>}
    </>
  );
}

/** The two-way choice and, for "Only these agents", the checklist. Every click saves. */
export function RunsForEditor({ mod, actions, className, listClassName }: { mod: Mod; actions: ModActions; className?: string; listClassName?: string }) {
  const { data: agents = [] } = useAllAgents();
  const sorted = [...agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  const chosen = new Set(mod.agentIds);

  const setScope = (scope: ModScope) => {
    if (scope !== mod.scope) actions.update.mutate({ mod, patch: { scope } });
  };
  const toggle = (id: string) =>
    actions.update.mutate({ mod, patch: { agentIds: chosen.has(id) ? mod.agentIds.filter((x) => x !== id) : [...mod.agentIds, id] } });

  return (
    <div className={className}>
      <Segmented
        aria-label="Runs for"
        value={mod.scope}
        onChange={setScope}
        className="grid w-full grid-cols-2"
        options={[
          { value: "all", label: <span className="normal-case">Every agent</span> },
          { value: "agents", label: <span className="normal-case">Only these agents</span> },
        ]}
      />
      {mod.scope === "all" ? (
        <p className="px-1 pt-2.5 text-xs leading-relaxed text-muted-foreground">Every agent's runs load this mod, the agents you add later too.</p>
      ) : (
        <Command className={cn("mt-2 rounded-lg border bg-card", listClassName)}>
          {sorted.length > 6 && <CommandInput placeholder="Search agents…" />}
          <CommandList className="max-h-60">
            <CommandEmpty>No agents found.</CommandEmpty>
            <CommandGroup>
              {sorted.map((a) => {
                const on = chosen.has(a.id);
                return (
                  <CommandItem key={a.id} value={`agent ${a.name} ${a.id}`} onSelect={() => toggle(a.id)} className="gap-2.5 py-1.5">
                    <AgentAvatar agent={a} size="sm" still />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="sr-only">{on ? "Runs this mod" : "Doesn't run this mod"}</span>
                    {on && <Check className="size-4" aria-hidden />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      )}
    </div>
  );
}

/** The "Runs for" row of a mod card: who runs it, and a popover to change that. */
export function RunsForRow({ mod, actions }: { mod: Mod; actions: ModActions }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="eyebrow mr-1 text-[10.5px]">Runs for</span>
      <RunsForSummary mod={mod} />
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" className="h-6 text-muted-foreground hover:text-foreground" aria-label={`Change who ${mod.title} runs for`}>
            Change
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 overflow-hidden p-0">
          <RunsForEditor mod={mod} actions={actions} className="p-2" />
          <p className="border-t bg-paper-2 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">Changes apply from the next message of each agent.</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

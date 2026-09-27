import { AnimatePresence, motion } from "motion/react";
import { Bot, Globe2, Layers } from "lucide-react";
import type { Agent } from "@godmode/shared";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { AgentAvatar, ScopeBadge } from "@/components/common";
import { useAllAgents, useWorkspaces } from "@/lib/hooks";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

export interface IntegrationScope {
  workspaceId: string | null;
  agentId: string | null;
}

type Mode = "global" | "workspace" | "agent";

function modeOf(v: IntegrationScope): Mode {
  return v.agentId ? "agent" : v.workspaceId ? "workspace" : "global";
}

/** Initial scope from the sidebar selection: a workspace id → that workspace, otherwise global. */
export function useDefaultScope(): IntegrationScope {
  const scope = useUi((s) => s.workspace);
  const { data: workspaces = [] } = useWorkspaces();
  const ws = workspaces.find((w) => w.id === scope);
  return { workspaceId: ws ? ws.id : null, agentId: null };
}

/**
 * Who can use an integration: every agent (global), agents of one workspace, or a single agent.
 * Agent scope also carries the agent's workspace id so scoped lists stay consistent.
 */
export function ScopePicker({ value, onChange, className, disabled }: { value: IntegrationScope; onChange: (v: IntegrationScope) => void; className?: string; disabled?: boolean }) {
  const { data: workspaces = [] } = useWorkspaces();
  const { data: agents = [] } = useAllAgents();
  // Workspace/agent modes always carry an id (the options are disabled when none exist), so the value alone defines the mode.
  const mode = modeOf(value);

  const pick = (m: Mode) => {
    if (m === "global") onChange({ workspaceId: null, agentId: null });
    else if (m === "workspace") onChange({ workspaceId: value.workspaceId ?? workspaces[0]?.id ?? null, agentId: null });
    else {
      const a = agents.find((x) => x.id === value.agentId) ?? agents.find((x) => x.isDefault) ?? agents[0];
      onChange({ workspaceId: a?.workspaceId ?? null, agentId: a?.id ?? null });
    }
  };

  const options: { id: Mode; icon: typeof Globe2; title: string; hint: string; disabled?: boolean }[] = [
    { id: "global", icon: Globe2, title: "Global", hint: "Every agent, every workspace" },
    { id: "workspace", icon: Layers, title: "Workspace", hint: workspaces.length ? "Agents in one workspace" : "No workspaces yet", disabled: !workspaces.length },
    { id: "agent", icon: Bot, title: "One agent", hint: agents.length ? "Only a specific agent" : "No agents yet", disabled: !agents.length },
  ];

  return (
    <div className={cn("space-y-3", className)}>
      <RadioGroup value={mode} onValueChange={(v) => pick(v as Mode)} className="grid gap-2 sm:grid-cols-3" disabled={disabled} aria-label="Scope">
        {options.map((o) => (
          <Label
            key={o.id}
            htmlFor={`scope-${o.id}`}
            className={cn(
              "relative flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border bg-card/40 p-3 font-normal transition",
              "hover:border-primary/30 has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-primary/5 has-[[data-state=checked]]:shadow-sm has-[[data-state=checked]]:shadow-glow-a/10",
              o.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <RadioGroupItem id={`scope-${o.id}`} value={o.id} disabled={o.disabled} className="absolute top-3 right-3" />
            <o.icon className="size-4 text-primary" />
            <span className="text-sm font-medium">{o.title}</span>
            <span className="text-xs leading-snug text-muted-foreground">{o.hint}</span>
          </Label>
        ))}
      </RadioGroup>

      <AnimatePresence initial={false} mode="wait">
        {mode === "workspace" && workspaces.length > 0 && (
          <motion.div key="ws" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <Select value={value.workspaceId ?? undefined} onValueChange={(id) => onChange({ workspaceId: id, agentId: null })} disabled={disabled}>
              <SelectTrigger className="w-full" aria-label="Workspace">
                <SelectValue placeholder="Choose a workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    <span className="w-4 text-center">{w.icon || "🗂️"}</span> {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </motion.div>
        )}
        {mode === "agent" && agents.length > 0 && (
          <motion.div key="agent" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <Select
              value={value.agentId ?? undefined}
              onValueChange={(id) => {
                const a = agents.find((x) => x.id === id);
                onChange({ workspaceId: a?.workspaceId ?? null, agentId: id });
              }}
              disabled={disabled}
            >
              <SelectTrigger className="h-10 w-full" aria-label="Agent">
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <AgentAvatar agent={a} size="sm" /> {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Compact display of an integration's scope (agent chip or workspace/global badge). */
export function ScopeChip({ workspaceId, agentId, agents, className }: IntegrationScope & { agents?: Agent[]; className?: string }) {
  const { data: all = [] } = useAllAgents();
  const agent = agentId ? (agents ?? all).find((a) => a.id === agentId) : undefined;
  if (agentId)
    return (
      <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-full bg-secondary pr-2 pl-0.5 text-xs text-secondary-foreground", className)}>
        {agent ? <AgentAvatar agent={agent} size="sm" className="size-4 rounded-full text-[9px]" /> : <Bot className="ml-1 size-3" />}
        {agent?.name ?? "Agent"}
      </span>
    );
  return <ScopeBadge workspaceId={workspaceId} className={className} />;
}

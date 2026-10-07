import { useId, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, ChevronRight, Globe } from "lucide-react";
import type { Agent, Workspace } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

export interface AgentGroup<T = Agent> {
  /** "global" or the workspace id. */
  key: string;
  workspace: Workspace | null;
  agents: T[];
}

/** Agents by workspace: global first, then in the sidebar's workspace order. Keeps the order of `agents` inside a group. */
export function groupByWorkspace<T extends { workspaceId: string | null }>(agents: T[], workspaces: Workspace[]): AgentGroup<T>[] {
  const order = new Map(workspaces.map((w, i) => [w.id, i]));
  const groups = new Map<string, AgentGroup<T>>();
  for (const a of agents) {
    const key = a.workspaceId ?? "global";
    const g = groups.get(key) ?? { key, workspace: a.workspaceId ? (workspaces.find((w) => w.id === a.workspaceId) ?? null) : null, agents: [] };
    g.agents.push(a);
    groups.set(key, g);
  }
  const rank = (g: AgentGroup<T>) => (g.key === "global" ? -1 : (order.get(g.key) ?? Number.MAX_SAFE_INTEGER));
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || (a.workspace?.name ?? "").localeCompare(b.workspace?.name ?? ""));
}

export function groupLabel(group: { key: string; workspace: Workspace | null }) {
  return group.key === "global" ? "Global" : (group.workspace?.name ?? "Workspace");
}

export function GroupIcon({ workspace, isGlobal, className }: { workspace: Workspace | null; isGlobal: boolean; className?: string }) {
  if (isGlobal || !workspace)
    return (
      <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground ring-1 ring-foreground/5 ring-inset", className)}>
        <Globe className="size-3.5" />
      </span>
    );
  return <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" className={className} />;
}

/**
 * One workspace's agents under a heading that folds them away. The heading sums up who is working and who needs you,
 * and shows the faces when folded so you still see who is in there. `panel` frames it as a card (the org chart).
 */
export function WorkspaceSection({
  group,
  working,
  needsYou,
  count,
  panel,
  label: title,
  icon,
  forceOpen,
  aside,
  className,
  dropRef,
  dropState = "none",
  children,
}: {
  group: AgentGroup;
  working: number;
  needsYou: number;
  /** Shown as the size of the group; defaults to its agents. */
  count?: number;
  panel?: boolean;
  /** Override the workspace's name and icon (a team inside one workspace). */
  label?: string;
  icon?: ReactNode;
  /** Open whatever was folded, e.g. while a search runs, so no hit hides. */
  forceOpen?: boolean;
  /** Extra line under the heading, e.g. who the group reports to. */
  aside?: ReactNode;
  className?: string;
  /** Takes dragged agents (agent-dnd). */
  dropRef?: (el: HTMLElement | null) => void;
  dropState?: "none" | "available" | "valid" | "invalid";
  children: ReactNode;
}) {
  const folded = useUi((s) => s.collapsedAgentGroups.includes(group.key));
  const collapsed = folded && !forceOpen;
  const toggle = useUi((s) => s.toggleAgentGroup);
  const setWorkspace = useUi((s) => s.setWorkspace);
  const bodyId = useId();
  const label = title ?? groupLabel(group);
  const total = count ?? group.agents.length;
  const faces = group.agents.slice(0, 5);
  return (
    <section
      ref={dropRef}
      aria-label={label}
      className={cn(
        "transition-[box-shadow,border-color,background-color,outline-color] duration-150",
        panel ? "overflow-hidden rounded-xl border bg-card shadow-card" : "rounded-xl outline-2 outline-offset-[6px] outline-transparent outline-dashed",
        dropState === "available" && (panel ? "border-brand/30" : "outline-brand/25"),
        dropState === "valid" && (panel ? "border-brand/60 ring-4 ring-brand/15" : "bg-brand/[0.03] outline-brand/60"),
        className,
      )}
    >
      <div className={cn("group/head @container/head flex min-h-9 items-center gap-2", panel ? "h-12 px-3" : !collapsed && "mb-3", panel && !collapsed && "border-b")}>
        <h2 className="min-w-0">
          <button
            type="button"
            onClick={() => toggle(group.key)}
            title={label}
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : bodyId}
            className="-ml-1 flex max-w-full min-w-0 items-center gap-2 rounded-md py-0.5 pr-1.5 pl-1 text-left transition hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", !collapsed && "rotate-90")} />
            {icon ?? <GroupIcon workspace={group.workspace} isGlobal={group.key === "global"} />}
            <span className="truncate text-sm font-medium tracking-[-0.01em]">{label}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{total}</span>
          </button>
        </h2>
        <GroupStats working={working} needsYou={needsYou} />
        {dropState === "valid" && (
          <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="shrink-0 rounded-full bg-brand-strong px-2 py-0.5 text-[11px] font-medium text-white dark:bg-brand dark:text-black">
            Drop here
          </motion.span>
        )}
        <AnimatePresence initial={false}>
          {collapsed && (
            <motion.span initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} aria-hidden className="ml-1 hidden items-center @sm:flex">
              {faces.map((a, i) => (
                <AgentAvatar key={a.id} agent={a} size="sm" still className={cn("rounded-full ring-2 ring-background", i > 0 && "-ml-1.5")} />
              ))}
              {group.agents.length > faces.length && <span className="ml-1 text-[11px] text-muted-foreground tabular-nums">+{group.agents.length - faces.length}</span>}
            </motion.span>
          )}
        </AnimatePresence>
        {group.workspace && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-muted-foreground opacity-0 transition-opacity group-hover/head:opacity-100 focus-visible:opacity-100"
                aria-label={`Open ${label}`}
                onClick={() => setWorkspace(group.workspace!.id)}
              >
                <ArrowUpRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Show only {label}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            id={bodyId}
            key="body"
            // A panel slides open; cards fade, so their shadows aren't clipped while the height moves.
            initial={panel ? { height: 0, opacity: 0 } : { opacity: 0, y: -4 }}
            animate={panel ? { height: "auto", opacity: 1 } : { opacity: 1, y: 0 }}
            exit={panel ? { height: 0, opacity: 0 } : { opacity: 0, transition: { duration: 0 } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className={cn(panel && "overflow-hidden")}
          >
            {aside}
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function GroupStats({ working, needsYou }: { working: number; needsYou: number }) {
  if (!working && !needsYou) return null;
  // In a narrow heading the name keeps the room: just dot and number, the words on hover.
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      {working > 0 && (
        <span className="inline-flex items-center gap-1" title={`${working} working`}>
          <span aria-hidden className="size-1.5 rounded-full bg-brand animate-live-dot" />
          {working}
          <span className="hidden @[26rem]/head:inline">working</span>
        </span>
      )}
      {needsYou > 0 && (
        <span className="inline-flex items-center gap-1 text-foreground" title={`${needsYou} need${needsYou === 1 ? "s" : ""} you`}>
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          {needsYou}
          <span className="hidden @[26rem]/head:inline">need{needsYou === 1 ? "s" : ""} you</span>
        </span>
      )}
    </span>
  );
}

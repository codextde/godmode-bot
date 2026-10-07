import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Workspace } from "@godmode/shared";
import { Check, ChevronsUpDown, Globe2, Layers, Plus, Settings2 } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { type WorkspaceActivity, useWorkspaceActivity } from "@/components/workspaces/workspace-activity";
import { useWorkspaces } from "@/lib/hooks";
import { isMac, modKey } from "@/lib/desktop";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

/** Typing somewhere ⌘1 could mean something else (a remote screen, a field): the shortcut stays out of it. */
function busyTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest("[role=application]");
}

/** Switches the active scope: all workspaces, global only, or a single workspace. ⌘0 is all, ⌘1–9 the workspaces in order. */
export function WorkspaceSwitcher() {
  const { data: workspaces = [] } = useWorkspaces();
  const scope = useUi((s) => s.workspace);
  const setScope = useUi((s) => s.setWorkspace);
  const recentIds = useUi((s) => s.recentWorkspaces);
  const navigate = useNavigate();
  const { of: activity, total: totals } = useWorkspaceActivity();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { state, isMobile } = useSidebar();
  const railed = state === "collapsed" && !isMobile;

  const sorted = useMemo(() => [...workspaces].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })), [workspaces]);
  const recent = useMemo(
    () => (sorted.length > 6 ? recentIds.flatMap((id) => (id === scope ? [] : (sorted.find((w) => w.id === id) ?? []))).slice(0, 3) : []),
    [sorted, recentIds, scope],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || !/^Digit[0-9]$/.test(e.code) || busyTarget(e.target)) return;
      const n = Number(e.code.slice(5));
      const next = n === 0 ? "all" : sorted[n - 1]?.id;
      if (!next) return;
      e.preventDefault();
      setScope(next);
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sorted, setScope]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const current = workspaces.find((w) => w.id === scope);
  const label = scope === "global" ? "Global" : (current?.name ?? "All workspaces");
  const here = scope === "all" ? null : activity(scope === "global" ? null : scope);
  const shown = here ?? totals;
  // Waiting elsewhere: the human sees it without opening the list.
  const elsewhere = scope === "all" ? 0 : totals.needsYou - (here?.needsYou ?? 0);

  const pick = (id: string) => {
    setScope(id);
    setOpen(false);
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
            <button
              type="button"
              aria-label={`Workspace: ${label}. Switch workspace`}
              className={cn(
                "group/ws relative flex h-11 w-full items-center gap-2.5 rounded-lg border bg-card px-1.5 text-left shadow-card outline-none transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent",
                "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0",
              )}
            >
              <ScopeTile scope={scope} workspace={current} className="size-8 rounded-md text-base group-data-[collapsible=icon]:size-7" />
              <span className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
                <span className="block truncate text-[13.5px] font-medium">{label}</span>
                <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                  <ActivityLine activity={shown} fallback={scope === "all" ? `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}` : "All quiet"} />
                </span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
              {elsewhere > 0 && (
                <span
                  className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-warning px-1 font-mono text-[9.5px] font-semibold text-white dark:text-black ring-2 ring-sidebar tabular-nums"
                  aria-label={`${elsewhere} waiting for you in other workspaces`}
                >
                  {elsewhere}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {(railed || elsewhere > 0) && !open && (
          <TooltipContent side="right">
            {railed && `${label} · `}
            {elsewhere > 0 ? `${elsewhere} waiting for you in other workspaces` : `Switch workspace (${modKey}0–9)`}
          </TooltipContent>
        )}
      </Tooltip>
      <PopoverContent align="start" sideOffset={6} className="w-80 overflow-hidden p-0">
        <Command loop filter={(_value, search, keywords) => (keywords?.join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}>
          <CommandInput placeholder="Find a workspace…" value={query} onValueChange={setQuery} className="h-10" />
          <CommandList className="max-h-[min(62vh,440px)]">
            <CommandEmpty>No workspace called “{query}”.</CommandEmpty>
            <CommandGroup>
              <ScopeRow value="all" keywords={["All workspaces", "everything"]} selected={scope === "all"} onSelect={() => pick("all")} shortcut={`${modKey}0`}>
                <ScopeTile scope="all" />
                <RowText name="All workspaces" meta={<ActivityLine activity={totals} fallback="Everything in one place" />} />
              </ScopeRow>
              <ScopeRow value="global" keywords={["Global", "shared"]} selected={scope === "global"} onSelect={() => pick("global")} activity={activity(null)}>
                <ScopeTile scope="global" />
                <RowText name="Global" meta="Shared with every workspace" />
              </ScopeRow>
            </CommandGroup>
            {recent.length > 0 && !query && (
              <CommandGroup heading="Recent">
                {recent.map((w) => (
                  <WorkspaceRow key={w.id} keyPrefix="recent" workspace={w} selected={scope === w.id} activity={activity(w.id)} onSelect={() => pick(w.id)} />
                ))}
              </CommandGroup>
            )}
            {sorted.length > 0 && (
              <CommandGroup heading={`Workspaces · ${sorted.length}`}>
                {sorted.map((w, i) => (
                  <WorkspaceRow
                    key={w.id}
                    workspace={w}
                    selected={scope === w.id}
                    activity={activity(w.id)}
                    shortcut={i < 9 ? `${modKey}${i + 1}` : undefined}
                    onSelect={() => pick(w.id)}
                  />
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="new" keywords={["New workspace", "create", "add"]} onSelect={() => go("/workspaces?new=1")} className="text-[13px]">
                <Plus /> New workspace
              </CommandItem>
              <CommandItem value="manage" keywords={["Manage workspaces", "settings", "edit"]} onSelect={() => go("/workspaces")} className="text-[13px]">
                <Settings2 /> Manage workspaces
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ScopeTile({ scope, workspace, className }: { scope: string; workspace?: Workspace; className?: string }) {
  if (workspace) return <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" className={className} />;
  const Icon = scope === "global" ? Globe2 : Layers;
  return (
    <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-md bg-secondary text-foreground ring-1 ring-border ring-inset", className)}>
      <Icon className="size-3.5" />
    </span>
  );
}

function ActivityLine({ activity, fallback }: { activity: Pick<WorkspaceActivity, "running" | "needsYou">; fallback: string }) {
  if (!activity.running && !activity.needsYou) return <span className="truncate">{fallback}</span>;
  return (
    <>
      {activity.needsYou > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-warning">
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {activity.needsYou} need{activity.needsYou === 1 ? "s" : ""} you
        </span>
      )}
      {activity.running > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-brand-strong">
          <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          {activity.running} working
        </span>
      )}
    </>
  );
}

function RowText({ name, meta }: { name: string; meta?: React.ReactNode }) {
  return (
    <span className="min-w-0 flex-1 leading-tight">
      <span className="block truncate text-[13px]">{name}</span>
      {meta && <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">{meta}</span>}
    </span>
  );
}

function ScopeRow({
  value,
  keywords,
  selected,
  onSelect,
  shortcut,
  activity,
  children,
}: {
  value: string;
  keywords: string[];
  selected: boolean;
  onSelect: () => void;
  shortcut?: string;
  activity?: WorkspaceActivity;
  children: React.ReactNode;
}) {
  return (
    <CommandItem value={value} keywords={keywords} onSelect={onSelect} className="group/row gap-2.5 py-1.5" aria-current={selected || undefined}>
      {children}
      <RowBadges activity={activity} />
      <span className="flex w-7 shrink-0 justify-end">
        {selected ? (
          <Check className="size-3.5 text-foreground" />
        ) : shortcut ? (
          <span className="font-mono text-[10px] text-muted-foreground/70 opacity-0 transition group-data-[selected=true]/row:opacity-100">{shortcut}</span>
        ) : null}
      </span>
    </CommandItem>
  );
}

function RowBadges({ activity }: { activity?: WorkspaceActivity }) {
  if (!activity) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {activity.running > 0 && (
        <span className="flex h-4.5 items-center gap-1 rounded-full bg-brand-strong/10 px-1.5 font-mono text-[10px] text-brand-strong tabular-nums" title={`${activity.running} working`}>
          <span className="size-1 animate-pulse rounded-full bg-current" aria-hidden />
          {activity.running}
        </span>
      )}
      {activity.needsYou > 0 && (
        <span className="flex h-4.5 items-center rounded-full bg-warning/15 px-1.5 font-mono text-[10px] font-medium text-warning tabular-nums" title={`${activity.needsYou} waiting for you`}>
          {activity.needsYou}
        </span>
      )}
    </span>
  );
}

function WorkspaceRow({
  workspace,
  selected,
  activity,
  shortcut,
  keyPrefix = "ws",
  onSelect,
}: {
  workspace: Workspace;
  selected: boolean;
  activity: WorkspaceActivity;
  shortcut?: string;
  keyPrefix?: string;
  onSelect: () => void;
}) {
  const meta = [
    activity.agents ? `${activity.agents} agent${activity.agents === 1 ? "" : "s"}` : null,
    activity.openTasks ? `${activity.openTasks} open task${activity.openTasks === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ScopeRow value={`${keyPrefix}:${workspace.id}`} keywords={[workspace.name, workspace.description]} selected={selected} onSelect={onSelect} shortcut={shortcut} activity={activity}>
      <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" />
      <RowText name={workspace.name} meta={meta || "Empty"} />
    </ScopeRow>
  );
}

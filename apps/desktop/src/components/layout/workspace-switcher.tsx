import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Project, Workspace } from "@godmode/shared";
import { Check, ChevronRight, ChevronsUpDown, FolderPlus, Globe2, Layers, Plus, Settings2 } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { type WorkspaceActivity, projectKey, useWorkspaceActivity } from "@/components/workspaces/workspace-activity";
import { useWorkspaces } from "@/lib/hooks";
import { isMac, modKey } from "@/lib/desktop";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

/** ⌘0 is all workspaces, ⌘1–9 the workspaces in A–Z order. Not behind dialogs or on a remote screen the human controls. */
export function useWorkspaceShortcuts() {
  const { data: workspaces = [] } = useWorkspaces();
  const setScope = useUi((s) => s.setWorkspace);
  useEffect(() => {
    const sorted = [...workspaces].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || !/^Digit[0-9]$/.test(e.code)) return;
      if ((e.target as HTMLElement | null)?.closest?.("[role=application],[role=dialog],[role=alertdialog]")) return;
      const n = Number(e.code.slice(5));
      const next = n === 0 ? "all" : sorted[n - 1]?.id;
      if (!next) return;
      e.preventDefault();
      setScope(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaces, setScope]);
}

/** Switches the active scope: all workspaces, global only, or a single workspace. */
export function WorkspaceSwitcher() {
  const { data: workspaces = [] } = useWorkspaces();
  const scope = useUi((s) => s.workspace);
  const projectScope = useUi((s) => s.project);
  const setScope = useUi((s) => s.setWorkspace);
  const recentIds = useUi((s) => s.recentWorkspaces);
  const navigate = useNavigate();
  // Workspaces whose projects are unfolded in the list (the current one starts open; a search shows all).
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set([scope]));
  const { of: activity, total: totals } = useWorkspaceActivity();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { state, isMobile } = useSidebar();
  const railed = state === "collapsed" && !isMobile;

  const sorted = useMemo(() => [...workspaces].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })), [workspaces]);
  // Rows line up behind the fold toggles once any workspace has projects.
  const indent = workspaces.some((w) => (w.projects?.length ?? 0) > 0);
  const recent = useMemo(
    () => (sorted.length > 6 ? recentIds.flatMap((id) => (id === scope ? [] : (sorted.find((w) => w.id === id) ?? []))).slice(0, 3) : []),
    [sorted, recentIds, scope],
  );

  useEffect(() => {
    if (!open) setQuery("");
    else setUnfolded((u) => (u.has(scope) ? u : new Set([...u, scope])));
  }, [open]);

  const current = workspaces.find((w) => w.id === scope);
  const currentProject = current?.projects.find((p) => p.id === projectScope);
  const label = scope === "global" ? "Global" : (currentProject?.name ?? current?.name ?? "All workspaces");
  const here = scope === "all" ? null : currentProject ? activity(projectKey(currentProject.id)) : activity(scope === "global" ? null : scope);
  const shown = here ?? totals;
  // Waiting elsewhere: the human sees it without opening the list.
  const elsewhere = scope === "all" ? 0 : totals.needsYou - (here?.needsYou ?? 0);

  const pick = (id: string, project: string | null = null) => {
    setScope(id, project);
    setOpen(false);
  };
  const toggle = (id: string) =>
    setUnfolded((u) => {
      const next = new Set(u);
      if (!next.delete(id)) next.add(id);
      return next;
    });
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
              <ScopeTile scope={scope} workspace={currentProject ?? current} className="size-8 rounded-md text-base group-data-[collapsible=icon]:size-7" />
              <span className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
                <span className="block truncate text-[13.5px] font-medium">{label}</span>
                <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                  {currentProject && current && (
                    <span className={cn("truncate", (shown.running > 0 || shown.needsYou > 0) && "max-w-[45%]")}>{current.name}</span>
                  )}
                  {currentProject && current && (shown.running > 0 || shown.needsYou > 0) && <span aria-hidden className="opacity-50">·</span>}
                  {!(currentProject && !shown.running && !shown.needsYou) && (
                    <ActivityLine activity={shown} fallback={scope === "all" ? `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}` : "All quiet"} />
                  )}
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
              <ScopeRow
                value="all"
                keywords={["All workspaces", "everything"]}
                selected={scope === "all"}
                onSelect={() => pick("all")}
                shortcut={`${modKey}0`}
                lead={indent ? <FoldSpace /> : undefined}
              >
                <ScopeTile scope="all" />
                <RowText name="All workspaces" meta={<ActivityLine activity={totals} fallback="Everything in one place" />} />
              </ScopeRow>
              <ScopeRow
                value="global"
                keywords={["Global", "shared"]}
                selected={scope === "global"}
                onSelect={() => pick("global")}
                activity={activity(null)}
                lead={indent ? <FoldSpace /> : undefined}
              >
                <ScopeTile scope="global" />
                <RowText name="Global" meta="Shared with every workspace" />
              </ScopeRow>
            </CommandGroup>
            {recent.length > 0 && !query && (
              <CommandGroup heading="Recent">
                {recent.map((w) => (
                  <WorkspaceRow
                    key={w.id}
                    keyPrefix="recent"
                    workspace={w}
                    selected={scope === w.id && !projectScope}
                    activity={activity(w.id)}
                    onSelect={() => pick(w.id)}
                    indent={indent}
                  />
                ))}
              </CommandGroup>
            )}
            {sorted.length > 0 && (
              <CommandGroup heading={`Workspaces · ${sorted.length}`}>
                {sorted.map((w, i) => {
                  const projects = w.projects ?? [];
                  const shownProjects = projects.length > 0 && (!!query || unfolded.has(w.id));
                  return (
                    <Fragment key={w.id}>
                      <WorkspaceRow
                        workspace={w}
                        selected={scope === w.id && !projectScope}
                        activity={activity(w.id)}
                        shortcut={i < 9 ? `${modKey}${i + 1}` : undefined}
                        onSelect={() => pick(w.id)}
                        fold={projects.length && !query ? { open: unfolded.has(w.id), toggle: () => toggle(w.id) } : undefined}
                        indent={indent}
                      />
                      {shownProjects &&
                        projects.map((p, j) => (
                          <ProjectRow
                            key={p.id}
                            project={p}
                            workspace={w}
                            last={j === projects.length - 1}
                            selected={scope === w.id && projectScope === p.id}
                            activity={activity(projectKey(p.id))}
                            onSelect={() => pick(w.id, p.id)}
                          />
                        ))}
                    </Fragment>
                  );
                })}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="new" keywords={["New workspace", "create", "add"]} onSelect={() => go("/workspaces?new=1")} className="text-[13px]">
                <Plus /> New workspace
              </CommandItem>
              {current && (
                <CommandItem
                  value="new-project"
                  keywords={["New project", "create", "add", current.name]}
                  onSelect={() => go(`/workspaces?newProject=${current.id}`)}
                  className="text-[13px]"
                >
                  <FolderPlus />
                  <span className="truncate">
                    New project <span className="text-muted-foreground">in {current.name}</span>
                  </span>
                </CommandItem>
              )}
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

function ScopeTile({ scope, workspace, className }: { scope: string; workspace?: Pick<Workspace, "icon" | "color">; className?: string }) {
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
  lead,
  className,
  children,
}: {
  value: string;
  keywords: string[];
  selected: boolean;
  onSelect: () => void;
  shortcut?: string;
  activity?: WorkspaceActivity;
  /** Before the tile: a fold toggle, or the tree line of a project. */
  lead?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <CommandItem value={value} keywords={keywords} onSelect={onSelect} className={cn("group/row gap-2.5 py-1.5", className)} aria-current={selected || undefined}>
      {lead}
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

function activityMeta(activity: WorkspaceActivity, extra: (string | null)[] = []): string {
  return [
    ...extra,
    activity.agents ? `${activity.agents} agent${activity.agents === 1 ? "" : "s"}` : null,
    activity.openTasks ? `${activity.openTasks} open task${activity.openTasks === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function WorkspaceRow({
  workspace,
  selected,
  activity,
  shortcut,
  keyPrefix = "ws",
  onSelect,
  fold,
  indent,
}: {
  workspace: Workspace;
  selected: boolean;
  activity: WorkspaceActivity;
  shortcut?: string;
  keyPrefix?: string;
  onSelect: () => void;
  /** Its projects can be folded away. */
  fold?: { open: boolean; toggle: () => void };
  /** Keep the room of a fold toggle (other rows have one). */
  indent?: boolean;
}) {
  const count = workspace.projects?.length ?? 0;
  const meta = activityMeta(activity, [count ? `${count} project${count === 1 ? "" : "s"}` : null]);
  return (
    <ScopeRow
      value={`${keyPrefix}:${workspace.id}`}
      keywords={[workspace.name, workspace.description]}
      selected={selected}
      onSelect={onSelect}
      shortcut={shortcut}
      activity={activity}
      lead={
        fold ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={fold.open ? `Hide ${workspace.name}'s projects` : `Show ${workspace.name}'s projects`}
            aria-expanded={fold.open}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              fold.toggle();
            }}
            className="-mr-1.5 -ml-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition hover:bg-background hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform duration-150", fold.open && "rotate-90")} />
          </button>
        ) : indent ? (
          <FoldSpace />
        ) : undefined
      }
    >
      <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" />
      <RowText name={workspace.name} meta={meta || "Empty"} />
    </ScopeRow>
  );
}

function FoldSpace() {
  return <span className="-mr-1.5 -ml-1 size-5 shrink-0" aria-hidden />;
}

function ProjectRow({
  project,
  workspace,
  last,
  selected,
  activity,
  onSelect,
}: {
  project: Project;
  workspace: Workspace;
  last: boolean;
  selected: boolean;
  activity: WorkspaceActivity;
  onSelect: () => void;
}) {
  return (
    <ScopeRow
      value={`project:${project.id}`}
      keywords={[project.name, workspace.name, project.description]}
      selected={selected}
      onSelect={onSelect}
      activity={activity}
      lead={
        <span aria-hidden className="relative ml-1.5 h-9 w-4 shrink-0">
          <span className={cn("absolute top-0 left-1 w-px bg-border", last ? "h-1/2" : "h-full")} />
          <span className="absolute top-1/2 left-1 h-px w-2.5 bg-border" />
        </span>
      }
      className="py-0"
    >
      <WorkspaceTile icon={project.icon} color={project.color} size="sm" className="size-5 rounded text-[11px]" />
      <RowText name={project.name} meta={activityMeta(activity) || undefined} />
    </ScopeRow>
  );
}

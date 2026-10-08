import { useState } from "react";
import { useNavigate } from "react-router";
import type { Agent, Project } from "@godmode/shared";
import { Check, ChevronDown, FolderKanban, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { effectiveProject, projectsFor, useProjectIndex } from "./project-utils";

export function projectMeta(project: Project): string {
  const repos = project.sources.filter((s) => s.kind === "git").length;
  const folders = project.sources.length - repos;
  const parts = [
    project.description.trim().split("\n")[0],
    folders ? `${folders} folder${folders === 1 ? "" : "s"}` : null,
    repos ? `${repos} repo${repos === 1 ? "" : "s"}` : null,
  ];
  return parts.filter(Boolean).join(" · ") || "No details yet";
}

/**
 * Composer control for the project a chat works on: hidden while the agent has no projects to pick from, a quiet
 * button without one, a pill with the project's name otherwise (dashed when it is the agent's).
 */
export function ProjectChip({
  agent,
  value,
  onChange,
  busy,
}: {
  agent: Agent | undefined;
  /** The chat's own project; null = the agent's. */
  value: string | null;
  onChange: (projectId: string | null) => void | Promise<unknown>;
  busy?: boolean;
}) {
  const { data: workspaces = [] } = useWorkspaces();
  const index = useProjectIndex();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const groups = projectsFor(agent, workspaces);
  if (!agent || (!groups.length && !value)) return null;

  const own = value ? (index.get(value) ?? null) : null;
  const inherited = effectiveProject(agent, null, index);
  const shown = own ?? inherited;
  const pick = (projectId: string | null) => {
    setOpen(false);
    if (projectId !== value) void onChange(projectId);
  };
  const tooltip = own
    ? `This chat works on ${own.project.name}`
    : inherited
      ? `Works on ${inherited.project.name} — ${agent.name}'s project`
      : "Work on a project";
  const newIn = agent.workspaceId ?? groups[0]?.id;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {shown ? (
              <button
                type="button"
                aria-label={`Project: ${shown.project.name}${own ? "" : " (default)"}`}
                className={cn(
                  "flex h-8 max-w-[12rem] min-w-14 shrink items-center gap-1.5 rounded-lg border pr-1.5 pl-1.5 text-[13px] transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  own ? "bg-card hover:bg-accent" : "border-dashed text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {busy ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <WorkspaceTile icon={shown.project.icon} color={shown.project.color} size="sm" className="size-5 rounded text-[11px]" />
                )}
                <span className={cn("truncate @max-md/composer:sr-only", own && "font-medium")}>{shown.project.name}</span>
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                aria-label="Project"
                className={cn(
                  "h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4",
                  open && "bg-accent text-foreground",
                )}
              >
                {busy ? <Loader2 className="animate-spin" /> : <FolderKanban />}
                <span className="@max-sm/composer:sr-only">Project</span>
              </Button>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <div className="border-b px-3 pt-2.5 pb-2">
          <p className="text-[13px] font-medium">Project</p>
          <p className="text-xs text-muted-foreground">Runs in this chat get the project's context, folders and repositories, and browse with its profile.</p>
        </div>
        <Command>
          {groups.reduce((n, w) => n + w.projects.length, 0) > 6 && <CommandInput placeholder="Find a project…" />}
          <CommandList className="max-h-72">
            <CommandEmpty>No project with that name.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__default" keywords={["none", "default"]} onSelect={() => pick(null)} className="gap-2.5 py-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-md border border-dashed text-muted-foreground">
                  <FolderKanban className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{inherited ? `Default — ${inherited.project.name}` : "No project"}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {inherited ? `Set in ${agent.name}'s settings` : "Only the workspace's context and folders"}
                  </span>
                </span>
                {!value && <Check className="size-4" aria-label="Selected" />}
              </CommandItem>
            </CommandGroup>
            {groups.map((w) => (
              <CommandGroup key={w.id} heading={agent.workspaceId ? "Work on" : w.name}>
                {w.projects.map((p) => (
                  <CommandItem key={p.id} value={p.id} keywords={[p.name, w.name, p.description]} onSelect={() => pick(p.id)} className="gap-2.5 py-2">
                    <WorkspaceTile icon={p.icon} color={p.color} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{p.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{projectMeta(p)}</span>
                    </span>
                    {value === p.id && <Check className="size-4" aria-label="Selected" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {newIn && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__new"
                    keywords={["new project", "create"]}
                    onSelect={() => {
                      setOpen(false);
                      navigate(`/workspaces?newProject=${newIn}`);
                    }}
                    className="text-[13px]"
                  >
                    <Plus /> New project
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

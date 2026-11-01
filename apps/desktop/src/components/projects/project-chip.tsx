import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import type { Agent, Project } from "@godmode/shared";
import { Check, ChevronDown, FolderKanban, Globe, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { t as translate } from "@/i18n";
import { useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { effectiveProject, useProjectIndex } from "./project-utils";

export function projectMeta(project: Project): string {
  const repos = project.sources.filter((s) => s.kind === "git").length;
  const folders = project.sources.length - repos;
  const parts = [
    project.description.trim().split("\n")[0],
    folders ? translate("projects:meta.folders", { count: folders }) : null,
    repos ? translate("projects:meta.repos", { count: repos }) : null,
  ];
  return parts.filter(Boolean).join(" · ") || translate("projects:meta.none");
}

function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const text = texts.join(" ").toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

export interface PlacePick {
  /** Only for a global agent's chat; omitted = unchanged. */
  workspaceId?: string | null;
  projectId: string | null;
}

/**
 * Composer control for where a chat works: a workspace (global agents only) or one of its projects, as a searchable
 * tree. Hidden while there is nothing to pick; a quiet button without a pick, a pill with the name otherwise (dashed
 * when it is the agent's project).
 */
export function ProjectChip({
  agent,
  workspaceId,
  value,
  onChange,
  busy,
}: {
  agent: Agent | undefined;
  /** The chat's workspace (global agents); ignored for workspace agents. */
  workspaceId?: string | null;
  /** The chat's own project; null = the agent's. */
  value: string | null;
  onChange: (pick: PlacePick) => void | Promise<unknown>;
  busy?: boolean;
}) {
  const { t } = useTranslation("projects");
  const { data: workspaces = [] } = useWorkspaces();
  const index = useProjectIndex();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const global = !!agent && !agent.workspaceId;
  const groups = global ? workspaces : workspaces.filter((w) => w.id === agent?.workspaceId && (w.projects?.length ?? 0) > 0);
  if (!agent || (!groups.length && !value)) return null;

  const own = value ? (index.get(value) ?? null) : null;
  const inherited = effectiveProject(agent, null, index);
  const chatWorkspace = global && workspaceId ? (workspaces.find((w) => w.id === workspaceId) ?? null) : null;
  const usesDefault = !!inherited && (!global || !chatWorkspace || chatWorkspace.id === inherited.workspace.id);
  const current = own ? `p:${own.project.id}` : usesDefault ? "default" : chatWorkspace ? `w:${chatWorkspace.id}` : global ? "none" : `w:${agent.workspaceId}`;
  const shown = own ?? (usesDefault ? inherited : null);
  const pick = (key: string, place: PlacePick) => {
    setOpen(false);
    setQuery("");
    setActive("");
    if (key !== current) void onChange(place);
  };
  const tooltip = own
    ? t("chip.tooltipOwn", { name: own.project.name })
    : shown
      ? t("chip.tooltipInherited", { name: shown.project.name, agent: agent.name })
      : chatWorkspace
        ? t("chip.tooltipWorkspace", { name: chatWorkspace.name })
        : global
          ? t("chip.tooltipNoWorkspace")
          : t("chip.tooltipNone");
  const newIn = agent.workspaceId ?? chatWorkspace?.id ?? own?.workspace.id ?? groups[0]?.id;
  const checked = (key: string) => current === key && <Check className="size-4 shrink-0" aria-label={t("chip.selected")} />;
  const pill = shown
    ? { icon: shown.project.icon, color: shown.project.color, name: shown.project.name, solid: !!own }
    : chatWorkspace
      ? { icon: chatWorkspace.icon, color: chatWorkspace.color, name: chatWorkspace.name, solid: true }
      : null;
  const emptyLabel = global ? t("chip.workspace") : t("chip.project");
  const showDefault = !!inherited && matches(query, "default", t("chip.default", { name: inherited.project.name }));
  const showNone = global && !inherited && matches(query, "none", t("chip.noWorkspace"));
  const visibleGroups = groups
    .map((w) => {
      const hit = matches(query, w.name);
      const projects = (w.projects ?? []).filter((p) => hit || matches(query, p.name, p.description, w.name));
      return { w, projects, hit, showWorkspace: hit || projects.length > 0 };
    })
    .filter((g) => g.showWorkspace);
  const anyMatch = showDefault || showNone || visibleGroups.length > 0;
  const firstMatch = showDefault
    ? "default"
    : showNone
      ? "none"
      : visibleGroups[0]
        ? visibleGroups[0].hit && (global || !inherited)
          ? `w:${visibleGroups[0].w.id}`
          : `p:${visibleGroups[0].projects[0]?.id}`
        : "";
  const search = (next: string) => {
    setQuery(next);
    setActive("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setActive("");
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {pill ? (
              <button
                type="button"
                aria-label={pill.solid ? t("chip.label", { name: pill.name }) : t("chip.labelDefault", { name: pill.name })}
                className={cn(
                  "flex h-8 max-w-[12rem] min-w-14 shrink items-center gap-1.5 rounded-lg border pr-1.5 pl-1.5 text-[13px] transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  pill.solid ? "bg-card hover:bg-accent" : "border-dashed text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {busy ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <WorkspaceTile icon={pill.icon} color={pill.color} size="sm" className="size-5 rounded text-[11px]" />
                )}
                <span className={cn("truncate @max-md/composer:sr-only", pill.solid && "font-medium")}>{pill.name}</span>
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                aria-label={emptyLabel}
                className={cn(
                  "h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4",
                  open && "bg-accent text-foreground",
                )}
              >
                {busy ? <Loader2 className="animate-spin" /> : <FolderKanban />}
                <span className="@max-sm/composer:sr-only">{emptyLabel}</span>
              </Button>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <Command loop shouldFilter={false} value={active || (query.trim() ? firstMatch : current)} onValueChange={setActive}>
          <CommandInput value={query} onValueChange={search} placeholder={global ? t("chip.findPlace") : t("chip.find")} aria-label={global ? t("chip.findPlace") : t("chip.find")} />
          <CommandList className="max-h-80">
            {!anyMatch && <div className="py-6 text-center text-sm">{t("chip.empty")}</div>}
            {(showDefault || showNone) && (
              <CommandGroup>
                {inherited && showDefault && (
                  <CommandItem
                    value="default"
                    onSelect={() => pick("default", global ? { workspaceId: inherited.workspace.id, projectId: null } : { projectId: null })}
                    className="gap-2.5 py-2"
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-md border border-dashed text-muted-foreground">
                      <FolderKanban className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{t("chip.default", { name: inherited.project.name })}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{t("chip.setIn", { agent: agent.name })}</span>
                    </span>
                    {checked("default")}
                  </CommandItem>
                )}
                {showNone && (
                  <CommandItem
                    value="none"
                    onSelect={() => pick("none", { workspaceId: null, projectId: null })}
                    className="gap-2.5 py-2"
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-md border border-dashed text-muted-foreground">
                      <Globe className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{t("chip.noWorkspace")}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{t("chip.onlyGlobal")}</span>
                    </span>
                    {checked("none")}
                  </CommandItem>
                )}
              </CommandGroup>
            )}
            {visibleGroups.map(({ w, projects, showWorkspace }) => {
              const selectable = global || !inherited;
              return (
                <CommandGroup key={w.id} heading={selectable ? undefined : w.name}>
                  {selectable && showWorkspace && (
                    <CommandItem
                      value={`w:${w.id}`}
                      onSelect={() => pick(`w:${w.id}`, global ? { workspaceId: w.id, projectId: null } : { projectId: null })}
                      className="gap-2.5 py-2"
                    >
                      <WorkspaceTile icon={w.icon} color={w.color} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{w.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {w.projects?.length ? t("chip.workspaceMeta", { count: w.projects.length }) : t("chip.onlyWorkspace")}
                        </span>
                      </span>
                      {checked(`w:${w.id}`)}
                    </CommandItem>
                  )}
                  {projects.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`p:${p.id}`}
                      onSelect={() => pick(`p:${p.id}`, { projectId: p.id })}
                      className={cn("relative gap-2.5 py-1.5", selectable && "ml-5 before:absolute before:inset-y-0 before:-left-2 before:border-l before:border-border")}
                    >
                      <WorkspaceTile icon={p.icon} color={p.color} size="sm" className="size-5 rounded text-[11px]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{p.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{projectMeta(p)}</span>
                      </span>
                      {checked(`p:${p.id}`)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
            {newIn && !query.trim() && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__new"
                    onSelect={() => {
                      setOpen(false);
                      navigate(`/workspaces?newProject=${newIn}`);
                    }}
                    className="text-[13px]"
                  >
                    <Plus /> {t("dialog.newTitle")}
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

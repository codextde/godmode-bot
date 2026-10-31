import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Bot, CircleCheck, FolderGit2, FolderKanban, FolderPlus, MessagesSquare, Pencil, Plus, ScrollText, Search, SquareKanban } from "lucide-react";
import type { Project, Workspace } from "@godmode/shared";
import { EmptyState, Kbd, PageBody, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/api";
import { useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { ProjectDialog } from "@/components/projects/project-dialog";
import { ActivityChips } from "@/components/workspaces/activity-chips";
import { SourcesSummary } from "@/components/workspaces/workspace-sources";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { type WorkspaceActivity, projectKey, useWorkspaceActivity } from "@/components/workspaces/workspace-activity";

type Sort = "name" | "active" | "attention";
const SORTS: Sort[] = ["name", "active", "attention"];

interface Entry {
  project: Project;
  workspace: Workspace;
  activity: WorkspaceActivity;
  doneTasks: number;
}

export default function ProjectsPage() {
  const { t } = useTranslation(["projects", "common"]);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const scope = useUi((s) => s.workspace);
  const scopedProject = useUi((s) => s.project);
  const setScope = useUi((s) => s.setWorkspace);
  const { data: workspaces, isLoading, isError, error, refetch } = useWorkspaces();
  const activity = useWorkspaceActivity();
  const { data: tasks } = useQuery({ queryKey: qk.taskList("all"), queryFn: () => api.tasks.list({ workspaceId: "all" }), staleTime: 30_000 });
  const [sort, setSort] = useState<Sort>("active");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<{ workspaceId: string; projectId: string | null } | null>(null);
  const lastDialogWorkspace = useRef<Workspace | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || el?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "")) return;
      if (el?.closest("[role=dialog],[role=alertdialog],[role=menu],[role=listbox]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const all = workspaces ?? [];
  const newIn = params.get("new");
  useEffect(() => {
    if (!newIn || !workspaces) return;
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
    const target = workspaces.find((w) => w.id === newIn) ?? (scope !== "all" && scope !== "global" ? workspaces.find((w) => w.id === scope) : undefined) ?? workspaces[0];
    if (target) setDialog({ workspaceId: target.id, projectId: null });
  }, [newIn, workspaces, params, setParams, scope]);

  const doneByProject = useMemo(() => {
    const out = new Map<string, number>();
    for (const task of tasks ?? []) if (task.projectId && !task.archivedAt && task.status === "done") out.set(task.projectId, (out.get(task.projectId) ?? 0) + 1);
    return out;
  }, [tasks]);

  const entries = useMemo<Entry[]>(
    () => all.flatMap((workspace) => workspace.projects.map((project) => ({ project, workspace, activity: activity.of(projectKey(project.id)), doneTasks: doneByProject.get(project.id) ?? 0 }))),
    [all, activity, doneByProject],
  );
  const query = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const hits = query ? entries.filter((e) => [e.project.name, e.project.description, e.workspace.name].join(" ").toLowerCase().includes(query)) : entries;
    const byName = (x: Entry, y: Entry) => x.project.name.localeCompare(y.project.name, undefined, { sensitivity: "base" });
    const sorted = [...hits].sort((x, y) => {
      if (sort === "active") return (y.activity.lastActive ?? "").localeCompare(x.activity.lastActive ?? "") || byName(x, y);
      if (sort === "attention") return y.activity.needsYou - x.activity.needsYou || y.activity.running - x.activity.running || y.activity.openTasks - x.activity.openTasks || byName(x, y);
      return byName(x, y);
    });
    const out = new Map<string, { workspace: Workspace; entries: Entry[] }>();
    for (const e of sorted) {
      const group = out.get(e.workspace.id) ?? { workspace: e.workspace, entries: [] };
      group.entries.push(e);
      out.set(e.workspace.id, group);
    }
    return [...out.values()];
  }, [entries, query, sort]);

  const totals = useMemo(
    () =>
      entries.reduce(
        (sum, e) => ({ needsYou: sum.needsYou + e.activity.needsYou, running: sum.running + e.activity.running, openTasks: sum.openTasks + e.activity.openTasks }),
        { needsYou: 0, running: 0, openTasks: 0 },
      ),
    [entries],
  );

  const open = (e: Entry, to = "/") => {
    setScope(e.workspace.id, e.project.id);
    navigate(to);
  };

  const dialogWorkspace = (dialog ? all.find((w) => w.id === dialog.workspaceId) : undefined) ?? (dialog ? undefined : lastDialogWorkspace.current);
  if (dialog && dialogWorkspace) lastDialogWorkspace.current = dialogWorkspace;
  const dialogProject = dialog?.projectId ? dialogWorkspace?.projects.find((p) => p.id === dialog.projectId) : undefined;

  const newButton = (variant: "default" | "outline" = "default") =>
    all.length === 1 ? (
      <Button variant={variant} onClick={() => setDialog({ workspaceId: all[0]!.id, projectId: null })}>
        <Plus /> {t("dialog.newTitle")}
      </Button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} disabled={!all.length}>
            <Plus /> {t("dialog.newTitle")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{t("overview.inWhichWorkspace")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {all.map((w) => (
            <DropdownMenuItem key={w.id} onClick={() => setDialog({ workspaceId: w.id, projectId: null })}>
              <WorkspaceTile icon={w.icon} color={w.color} size="sm" className="size-5 rounded text-[11px]" />
              <span className="truncate">{w.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  let index = 0;
  return (
    <div className="relative min-h-full">
      <PageHeader icon={<FolderKanban />} title={t("overview.title")} description={t("overview.description")} actions={newButton()} />
      <PageBody>
        {entries.length > 0 && (
          <>
            <div className="mb-5 grid grid-cols-3 gap-3 @3xl:max-w-2xl">
              <Summary label={t("overview.summary.needsYou")} value={totals.needsYou} tone={totals.needsYou ? "warning" : undefined} />
              <Summary label={t("overview.summary.working")} value={totals.running} tone={totals.running ? "brand" : undefined} />
              <Summary label={t("overview.summary.openTasks")} value={totals.openTasks} />
            </div>
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <div className="relative w-full max-w-sm min-w-48 @3xl:w-auto @3xl:flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setSearch("")}
                  placeholder={t("overview.searchPlaceholder", { count: entries.length })}
                  aria-label={t("overview.searchLabel")}
                  className="pr-10 pl-9"
                />
                <span className="absolute top-1/2 right-2.5 -translate-y-1/2">
                  <Kbd>/</Kbd>
                </span>
              </div>
              <div role="radiogroup" aria-label={t("overview.sortLabel")} className="flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
                {SORTS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={sort === id}
                    onClick={() => setSort(id)}
                    className={cn(
                      "relative rounded-md px-3 py-1 text-sm transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                      sort === id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {sort === id && <motion.span layoutId="projects-sort" className="absolute inset-0 rounded-md border bg-card shadow-card" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} />}
                    <span className="relative">{t(`overview.sort.${id}`)}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-60 rounded-xl" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
            <p className="font-medium text-destructive">{t("overview.loadFailed")}</p>
            <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
              {t("common:actions.tryAgain")}
            </Button>
          </div>
        ) : !entries.length ? (
          <EmptyState
            icon={<FolderKanban />}
            title={t("overview.emptyTitle")}
            description={all.length ? t("overview.emptyDescription") : t("overview.noWorkspaces")}
            action={all.length ? newButton("outline") : <Button variant="outline" onClick={() => navigate("/workspaces?new=1")}><Plus /> {t("overview.createWorkspace")}</Button>}
          />
        ) : !groups.length ? (
          <EmptyState icon={<Search />} title={t("overview.noMatch", { query: search.trim() })} description={t("overview.noMatchHint")} />
        ) : (
          <div className="flex flex-col gap-8">
            {groups.map(({ workspace, entries: list }) => (
              <section key={workspace.id} aria-label={workspace.name}>
                <div className="mb-3 flex items-center gap-2">
                  <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" className="size-6 rounded-md text-xs" />
                  <h2 className="truncate text-sm font-medium">{workspace.name}</h2>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{list.length}</span>
                  <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setDialog({ workspaceId: workspace.id, projectId: null })}>
                    <FolderPlus /> {t("overview.add")}
                  </Button>
                </div>
                <motion.div layout className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
                  <AnimatePresence initial={false}>
                    {list.map((e) => (
                      <ProjectCard
                        key={e.project.id}
                        entry={e}
                        index={index++}
                        current={scope === e.workspace.id && scopedProject === e.project.id}
                        onOpen={() => open(e)}
                        onBoard={() => open(e, "/tasks")}
                        onEdit={() => setDialog({ workspaceId: e.workspace.id, projectId: e.project.id })}
                      />
                    ))}
                  </AnimatePresence>
                </motion.div>
              </section>
            ))}
          </div>
        )}
      </PageBody>

      {dialogWorkspace && (
        <ProjectDialog
          open={!!dialog && (!dialog.projectId || !!dialogProject)}
          workspace={dialogWorkspace}
          project={dialogProject}
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: number; tone?: "warning" | "brand" }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-card">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-xl font-medium tabular-nums", tone === "warning" && "text-warning", tone === "brand" && "text-brand-strong")}>{value}</div>
    </div>
  );
}

function ProjectCard({
  entry: { project: p, activity, doneTasks },
  index,
  current,
  onOpen,
  onBoard,
  onEdit,
}: {
  entry: Entry;
  index: number;
  current: boolean;
  onOpen: () => void;
  onBoard: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation(["projects", "common"]);
  const stats: { label: string; value: number; icon: ReactNode }[] = [
    { label: t("common:words.agents"), value: activity.agents, icon: <Bot /> },
    { label: t("overview.stats.openTasks"), value: activity.openTasks, icon: <SquareKanban /> },
    { label: t("overview.stats.doneTasks"), value: doneTasks, icon: <CircleCheck /> },
    { label: t("overview.stats.sources"), value: p.sources.length, icon: <FolderGit2 /> },
  ];
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border bg-card p-5 shadow-card transition hover:shadow-float",
        current ? "border-brand/35 ring-1 ring-brand/15" : "hover:border-foreground/15",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <WorkspaceTile icon={p.icon} color={p.color} size="lg" />
        <div className="flex items-center gap-1">
          {current && (
            <Badge variant="outline" className="gap-1.5 border-brand/25 bg-brand-soft text-brand-strong">
              <span aria-hidden className="size-1.5 rounded-full bg-brand" />
              {t("overview.current")}
            </Badge>
          )}
          <Button variant="ghost" size="icon-sm" aria-label={t("overview.edit", { name: p.name })} onClick={onEdit} className="text-muted-foreground">
            <Pencil />
          </Button>
        </div>
      </div>
      <div className="mt-4 min-w-0">
        <h3 className="truncate text-base font-medium tracking-[-0.015em]">{p.name}</h3>
        <ActivityChips activity={activity} className="mt-2" />
        <p className={cn("mt-1.5 line-clamp-2 min-h-10 text-sm text-muted-foreground", !p.description && "italic opacity-70")}>{p.description || t("overview.noDescription")}</p>
        <div className="mt-2.5 flex min-h-4 flex-col gap-1.5 text-xs">
          {p.instructions.trim() && (
            <span className="flex items-center gap-1.5 text-foreground">
              <ScrollText className="size-3.5 shrink-0 text-brand-strong" />
              <span className="truncate">{t("dialog.agentContext")}</span>
            </span>
          )}
          {p.sources.length > 0 && (
            <span className="flex max-w-full items-center gap-1.5 text-foreground">
              <SourcesSummary sources={p.sources} />
            </span>
          )}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-1.5">
        {stats.map((s) => (
          <Tooltip key={s.label}>
            <TooltipTrigger asChild>
              <div className="flex flex-col items-center gap-1 rounded-lg border bg-paper-2 px-1 py-2 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
                {s.icon}
                <span className="font-mono text-sm font-medium tabular-nums">{s.value}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{s.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="outline" className="flex-1 justify-between" onClick={onOpen}>
          <span className="flex items-center gap-2">
            <MessagesSquare /> {t("overview.open")}
          </span>
          <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
        </Button>
        <Button variant="outline" onClick={onBoard} aria-label={t("overview.tasksOf", { name: p.name })}>
          <SquareKanban /> {t("overview.tasks")}
        </Button>
      </div>
    </motion.article>
  );
}

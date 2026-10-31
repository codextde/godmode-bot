import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Bot,
  EllipsisVertical,
  FolderGit2,
  FolderPlus,
  Globe2,
  KeyRound,
  Layers,
  LayoutGrid,
  List,
  MessagesSquare,
  Pencil,
  Plug,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
  SquareKanban,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import type { Project, Workspace, WorkspaceSource } from "@godmode/shared";
import { EmptyState, Kbd, PageBody, PageHeader } from "@/components/common";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { t as translate } from "@/i18n";
import { useLocale } from "@/i18n/language";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { useBootstrap, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { type WorkspacesSort, type WorkspacesView, useUi } from "@/stores/ui";
import { WorkspaceDialog } from "@/components/workspaces/workspace-dialog";
import { SourcesSummary } from "@/components/workspaces/workspace-sources";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { type WorkspaceActivity, projectKey, useWorkspaceActivity } from "@/components/workspaces/workspace-activity";
import { ActivityChips } from "@/components/workspaces/activity-chips";
import { ProjectMoveMenu, ScopeDnd, WorkspaceMoveMenu, useProjectDnd, useWorkspaceDnd } from "@/components/workspaces/scope-dnd";
import { ProjectDialog } from "@/components/projects/project-dialog";

const SORTS = [
  { id: "name", labelKey: "page.sort.name" },
  { id: "active", labelKey: "page.sort.active" },
  { id: "attention", labelKey: "page.sort.attention" },
] as const satisfies readonly { id: WorkspacesSort; labelKey: string }[];

const VIEWS = [
  { id: "grid", labelKey: "page.view.grid", icon: LayoutGrid },
  { id: "list", labelKey: "page.view.list", icon: List },
] as const satisfies readonly { id: WorkspacesView; labelKey: string; icon: typeof List }[];

interface Counts {
  agents: number | null;
  logins: number | null;
  totp: number | null;
  integrations: number | null;
}


/** Per-scope item counts computed from the list endpoints; unavailable lists (e.g. vault locked) yield null → "–". */
function useScopeCounts(): { get: (workspaceId: string | null) => Counts; loading: boolean } {
  const opts = { retry: false, staleTime: 30_000 } as const;
  const agents = useQuery({ queryKey: qk.agentList("all"), queryFn: () => api.agents.list({ workspaceId: "all" }), ...opts });
  const creds = useQuery({ queryKey: qk.credentialList("all", ""), queryFn: () => api.credentials.list({ workspaceId: "all" }), ...opts });
  const totp = useQuery({ queryKey: qk.totpList("all"), queryFn: () => api.totp.list({ workspaceId: "all" }), ...opts });
  const mcp = useQuery({ queryKey: qk.mcpServers, queryFn: () => api.mcpServers.list({ workspaceId: "all" }), ...opts });
  const composio = useQuery({ queryKey: qk.composioConnections, queryFn: api.composio.connections, ...opts });
  const tools = useQuery({ queryKey: qk.apiTools, queryFn: () => api.apiTools.list({ workspaceId: "all" }), ...opts });

  const get = useMemo(() => {
    const count = <T extends { workspaceId: string | null }>(list: T[] | undefined, ws: string | null) =>
      list ? list.filter((x) => (x.workspaceId ?? null) === ws).length : null;
    return (ws: string | null): Counts => {
      const custom = mcp.data?.filter((m) => m.source !== "composio");
      const mcpCount = count(custom, ws);
      const composioCount = count(composio.data, ws);
      const toolCount = count(tools.data, ws);
      return {
        agents: count(agents.data, ws),
        logins: count(creds.data, ws),
        totp: count(totp.data, ws),
        integrations: mcpCount === null && composioCount === null && toolCount === null ? null : (mcpCount ?? 0) + (composioCount ?? 0) + (toolCount ?? 0),
      };
    };
  }, [agents.data, creds.data, totp.data, mcp.data, composio.data, tools.data]);

  return { get, loading: agents.isLoading || creds.isLoading || totp.isLoading };
}

export default function WorkspacesPage() {
  const { t } = useTranslation(["workspaces", "common"]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const scope = useUi((s) => s.workspace);
  const scopedProject = useUi((s) => s.project);
  const setScope = useUi((s) => s.setWorkspace);
  const { data: workspaces, isLoading, isError, error, refetch } = useWorkspaces();
  const { data: boot } = useBootstrap();
  const counts = useScopeCounts();
  const activity = useWorkspaceActivity();
  const view = useUi((s) => s.workspacesView);
  const setView = useUi((s) => s.setWorkspacesView);
  const sort = useUi((s) => s.workspacesSort);
  const setSort = useUi((s) => s.setWorkspacesSort);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
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
  const hasGlobalInstructions = !!boot?.settings.runner.appendSystemPrompt?.trim();

  const [editing, setEditing] = useState<Workspace | null>(null);
  const [focus, setFocus] = useState<"instructions" | "sources" | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [forceDelete, setForceDelete] = useState<{ workspace: Workspace; counts: [string, number][] } | null>(null);

  const creating = params.get("new") === "1";
  const editId = creating ? null : params.get("edit");
  const linked = editId ? (workspaces?.find((w) => w.id === editId) ?? null) : null;
  const target = creating ? null : (editing ?? linked);
  const dialogOpen = creating || !!target;
  const closeDialog = () => {
    setEditing(null);
    setFocus(null);
    if (creating || editId) {
      const next = new URLSearchParams(params);
      next.delete("new");
      next.delete("edit");
      setParams(next, { replace: true });
    }
  };
  useEffect(() => {
    if (!editId || !workspaces || linked) return;
    const next = new URLSearchParams(params);
    next.delete("edit");
    setParams(next, { replace: true });
    toast.error(t("page.gone"));
  }, [editId, workspaces, linked, params, setParams]);
  const editFocused = (ws: Workspace, field: "instructions" | "sources") => {
    setFocus(field);
    setEditing(ws);
  };
  const openCreate = () => {
    const next = new URLSearchParams(params);
    next.set("new", "1");
    setParams(next, { replace: true });
  };

  const open = (ws: Workspace | null, to = "/agents") => {
    setScope(ws ? ws.id : "global");
    navigate(to);
  };
  const openProject = (ws: Workspace, project: Project, to = "/") => {
    setScope(ws.id, project.id);
    navigate(to);
  };

  const [projectDialog, setProjectDialog] = useState<{ workspaceId: string; projectId: string | null } | null>(null);
  const newProjectIn = params.get("newProject");
  useEffect(() => {
    if (!newProjectIn || !workspaces) return;
    const next = new URLSearchParams(params);
    next.delete("newProject");
    setParams(next, { replace: true });
    if (workspaces.some((w) => w.id === newProjectIn)) setProjectDialog({ workspaceId: newProjectIn, projectId: null });
    else toast.error(t("page.gone"));
  }, [newProjectIn, workspaces, params, setParams]);
  // Kept while the dialog closes, so it can animate out.
  const lastProjectWorkspace = useRef<Workspace | undefined>(undefined);
  const projectWorkspace = (projectDialog ? workspaces?.find((w) => w.id === projectDialog.workspaceId) : undefined) ?? (projectDialog ? undefined : lastProjectWorkspace.current);
  if (projectDialog && projectWorkspace) lastProjectWorkspace.current = projectWorkspace;
  const projectTarget = projectDialog?.projectId ? projectWorkspace?.projects.find((p) => p.id === projectDialog.projectId) : undefined;
  const addProject = (ws: Workspace) => setProjectDialog({ workspaceId: ws.id, projectId: null });
  const editProject = (ws: Workspace, project: Project) => setProjectDialog({ workspaceId: ws.id, projectId: project.id });

  const remove = useMutation({
    mutationFn: ({ ws, force }: { ws: Workspace; force: boolean }) => api.workspaces.delete(ws.id, force),
    onSuccess: (_r, { ws }) => {
      if (scope === ws.id) setScope("all");
      toast.success(t("page.deleted", { name: ws.name }));
      setDeleting(null);
      setForceDelete(null);
      for (const key of [qk.workspaces, qk.bootstrap, qk.agents, qk.credentials, qk.totp, qk.mcpServers, qk.apiTools, qk.composio, qk.browserProfiles])
        void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e, { ws, force }) => {
      setDeleting(null);
      if (!force && e instanceof ApiRequestError && e.status === 409) {
        setForceDelete({ workspace: ws, counts: conflictCounts(e.details, counts.get(ws.id)) });
        return;
      }
      toastApiError(e, t("page.deleteFailed"), qc);
    },
  });

  const all = workspaces ?? [];
  const query = search.trim().toLowerCase();
  const list = useMemo(() => {
    const hits = query
      ? all.filter((w) => [w.name, w.description, ...w.projects.map((p) => p.name)].join(" ").toLowerCase().includes(query))
      : all;
    const byName = (x: Workspace, y: Workspace) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" });
    return [...hits].sort((x, y) => {
      const ax = activity.of(x.id);
      const ay = activity.of(y.id);
      if (sort === "active") return (ay.lastActive ?? "").localeCompare(ax.lastActive ?? "") || byName(x, y);
      if (sort === "attention") return ay.needsYou - ax.needsYou || ay.running - ax.running || ay.openTasks - ax.openTasks || byName(x, y);
      return byName(x, y);
    });
  }, [all, query, sort, activity]);
  const showGlobal = !query || "global shared".includes(query);
  const movable = all.length > 1 || all.some((w) => w.projects.length > 0);
  const menuFor = (ws: Workspace) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("page.actionsFor", { name: ws.name })} className="text-muted-foreground">
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => open(ws, "/")}>
          <MessagesSquare /> {t("page.menu.chats")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(ws, "/tasks")}>
          <SquareKanban /> {t("page.menu.tasks")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(ws, "/agents")}>
          <Bot /> {t("common:words.agents")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setEditing(ws)}>
          <Pencil /> {t("common:actions.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => addProject(ws)}>
          <FolderPlus /> {t("page.menu.newProject")}
        </DropdownMenuItem>
        <WorkspaceMoveMenu workspace={ws} />
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(ws)}>
          <Trash2 /> {t("common:actions.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const globalTile = (
    <div aria-hidden className="grid size-14 shrink-0 place-items-center rounded-xl bg-secondary text-foreground ring-1 ring-border ring-inset">
      <Globe2 className="size-6" />
    </div>
  );
  const globalContext = {
    label: hasGlobalInstructions ? t("page.globalInstructions") : t("page.addGlobalInstructions"),
    set: hasGlobalInstructions,
    onClick: () => navigate("/settings/instructions"),
  };

  return (
    <div className="relative min-h-full">
      <PageHeader
        icon={<Layers />}
        title={t("page.title")}
        description={t("page.description")}
        actions={
          <Button onClick={openCreate}>
            <Plus /> {t("dialog.newTitle")}
          </Button>
        }
      />
      <PageBody>
        {all.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm min-w-48 @3xl:w-auto @3xl:flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setSearch("")}
                placeholder={t("page.searchPlaceholder", { count: all.length })}
                aria-label={t("page.searchLabel")}
                className="pr-10 pl-9"
              />
              <span className="absolute top-1/2 right-2.5 -translate-y-1/2">
                <Kbd>/</Kbd>
              </span>
            </div>
            <div role="radiogroup" aria-label={t("page.sortLabel")} className="flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
              {SORTS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={sort === o.id}
                  onClick={() => setSort(o.id)}
                  className={cn(
                    "relative rounded-md px-3 py-1 text-sm transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                    sort === o.id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {sort === o.id && (
                    <motion.span layoutId="workspaces-sort" className="absolute inset-0 rounded-md border bg-card shadow-card" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} />
                  )}
                  <span className="relative">{t(o.labelKey)}</span>
                </button>
              ))}
            </div>
            <div role="group" aria-label={t("page.viewLabel")} className="ml-auto flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={view === v.id}
                  aria-label={t(v.labelKey)}
                  title={t(v.labelKey)}
                  onClick={() => setView(v.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5",
                    view === v.id ? "border bg-card text-foreground shadow-card" : "border border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <v.icon aria-hidden />
                </button>
              ))}
            </div>
          </div>
        )}
        <ScopeDnd workspaces={all}>
          {isLoading ? (
            <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-64 rounded-xl" />
              ))}
            </div>
          ) : isError ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
              <p className="font-medium text-destructive">{t("page.loadFailed")}</p>
              <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
                {t("common:actions.tryAgain")}
              </Button>
            </div>
          ) : query && !list.length && !showGlobal ? (
            <EmptyState
              icon={<Search />}
              title={t("page.noMatch", { query: search.trim() })}
              description={t("page.noMatchHint")}
              action={
                <Button variant="outline" onClick={openCreate}>
                  <Plus /> {t("dialog.newTitle")}
                </Button>
              }
            />
          ) : view === "list" ? (
            <div className="overflow-hidden rounded-xl border bg-card shadow-card">
              {showGlobal && (
                <ScopeListRow
                  workspace={null}
                  current={scope === "global"}
                  tile={<div aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary ring-1 ring-border ring-inset"><Globe2 className="size-4" /></div>}
                  title={t("page.global")}
                  description={t("page.globalShared")}
                  counts={counts.get(null)}
                  activity={activity.of(null)}
                  onOpen={() => open(null)}
                  onBoard={() => open(null, "/tasks")}
                />
              )}
              {list.map((ws) => (
                <Fragment key={ws.id}>
                  <ScopeListRow
                    workspace={ws}
                    current={scope === ws.id && !scopedProject}
                    tile={<WorkspaceTile icon={ws.icon} color={ws.color} size="sm" className="size-9 rounded-lg text-lg" />}
                    title={ws.name}
                    description={ws.description}
                    counts={counts.get(ws.id)}
                    activity={activity.of(ws.id)}
                    onOpen={() => open(ws)}
                    onBoard={() => open(ws, "/tasks")}
                    menu={menuFor(ws)}
                  />
                  {ws.projects.map((p, i) => (
                    <ProjectListRow
                      key={p.id}
                      project={p}
                      workspace={ws}
                      last={i === ws.projects.length - 1}
                      current={scope === ws.id && scopedProject === p.id}
                      activity={activity.of(projectKey(p.id))}
                      onOpen={() => openProject(ws, p)}
                      onBoard={() => openProject(ws, p, "/tasks")}
                      onEdit={() => editProject(ws, p)}
                    />
                  ))}
                </Fragment>
              ))}
              {!query && (
                <button
                  type="button"
                  onClick={openCreate}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-muted-foreground transition hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:outline-none"
                >
                  <span className="grid size-9 place-items-center rounded-lg border border-dashed">
                    <Plus className="size-4" />
                  </span>
                  {t("dialog.newTitle")}
                </button>
              )}
            </div>
          ) : (
            <motion.div layout className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
              {showGlobal && (
                <ScopeCard
                  workspace={null}
                  index={0}
                  current={scope === "global"}
                  tile={globalTile}
                  title={t("page.global")}
                  subtitle={t("page.globalShared")}
                  description={t("page.globalDescription")}
                  counts={counts.get(null)}
                  countsLoading={counts.loading}
                  activity={activity.of(null)}
                  onOpen={() => open(null)}
                  onBoard={() => open(null, "/tasks")}
                  context={globalContext}
                />
              )}
              <AnimatePresence initial={false}>
                {list.map((ws, i) => (
                  <ScopeCard
                    key={ws.id}
                    workspace={ws}
                    index={i + 1}
                    current={scope === ws.id && !scopedProject}
                    tile={<WorkspaceTile icon={ws.icon} color={ws.color} size="lg" />}
                    title={ws.name}
                    description={ws.description}
                    counts={counts.get(ws.id)}
                    countsLoading={counts.loading}
                    activity={activity.of(ws.id)}
                    onOpen={() => open(ws)}
                    onBoard={() => open(ws, "/tasks")}
                    context={{
                      label: ws.instructions.trim() ? t("dialog.agentContext") : t("page.addAgentContext"),
                      set: !!ws.instructions.trim(),
                      onClick: () => editFocused(ws, "instructions"),
                    }}
                    sources={{ list: ws.sources, onClick: () => editFocused(ws, "sources") }}
                    projects={{
                      list: ws.projects,
                      current: scope === ws.id ? scopedProject : null,
                      onOpen: (p) => openProject(ws, p),
                      onEdit: (p) => editProject(ws, p),
                      onAdd: () => addProject(ws),
                    }}
                    menu={menuFor(ws)}
                  />
                ))}
              </AnimatePresence>
              {!query && (
                <motion.button
                  layout
                  type="button"
                  onClick={openCreate}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(list.length + 1, 12) * 0.03 }}
                  className="group flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-foreground/15 p-6 text-center transition hover:border-foreground/25 hover:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="grid size-11 place-items-center rounded-lg border bg-card text-muted-foreground shadow-card transition group-hover:text-foreground group-hover:shadow-float">
                    <Plus className="size-5" />
                  </span>
                  <span className="text-sm font-medium">{list.length ? t("dialog.newTitle") : t("page.createFirst")}</span>
                  <span className="max-w-60 text-xs text-muted-foreground">
                    {list.length ? t("page.anotherHint") : t("page.firstHint")}
                  </span>
                </motion.button>
              )}
            </motion.div>
          )}
          {movable && list.length > 0 && (
            <p className="mt-6 text-xs text-muted-foreground">
              {t("page.dragHint")}
            </p>
          )}
        </ScopeDnd>
      </PageBody>

      <WorkspaceDialog
        open={dialogOpen}
        workspace={target}
        focus={focus ?? (linked && !editing ? "instructions" : undefined)}
        onOpenChange={(o) => {
          if (!o) closeDialog();
        }}
      />

      {projectWorkspace && (
        <ProjectDialog
          open={!!projectDialog && (!projectDialog.projectId || !!projectTarget)}
          workspace={projectWorkspace}
          project={projectTarget}
          onOpenChange={(o) => !o && setProjectDialog(null)}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("page.deleteDialog.title", { icon: deleting?.icon, name: deleting?.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("page.deleteDialog.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) remove.mutate({ ws: deleting, force: false });
              }}
            >
              {t("page.deleteDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!forceDelete} onOpenChange={(o) => !o && setForceDelete(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-destructive" /> {t("page.forceDialog.title", { name: forceDelete?.workspace.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("page.forceDialog.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          {forceDelete && forceDelete.counts.length > 0 && (
            <ul className="grid gap-2 sm:grid-cols-2">
              {forceDelete.counts.map(([label, n]) => (
                <li key={label} className="flex items-center justify-between rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm">
                  <span className="capitalize">{label}</span>
                  <span className="font-mono font-medium tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t("page.forceDialog.tip")}</p>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("page.forceDialog.keep")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (forceDelete) remove.mutate({ ws: forceDelete.workspace, force: true });
              }}
            >
              {t("page.forceDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const SERVER_COUNT_KEYS = {
  projects: "workspaces:page.counts.projects",
  agents: "workspaces:page.counts.agents",
  credentials: "workspaces:page.counts.credentials",
  totp: "workspaces:page.counts.totpServer",
  cards: "workspaces:page.counts.cards",
  mcpServers: "workspaces:page.counts.mcpServers",
  apiTools: "workspaces:page.counts.apiTools",
  browserProfiles: "workspaces:page.counts.browserProfiles",
  composioConnections: "workspaces:page.counts.composioConnections",
  tasks: "workspaces:page.counts.tasks",
} as const;

/** Counts for the force-delete dialog: from the 409 details when the core sends them, else computed client-side. */
function conflictCounts(details: unknown, fallback: Counts): [string, number][] {
  const source =
    details && typeof details === "object"
      ? ((details as { counts?: unknown }).counts && typeof (details as { counts?: unknown }).counts === "object"
          ? (details as { counts: Record<string, unknown> }).counts
          : (details as Record<string, unknown>))
      : null;
  const fromServer = source
    ? Object.entries(source)
        .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
        .map(([k, v]) => [k in SERVER_COUNT_KEYS ? translate(SERVER_COUNT_KEYS[k as keyof typeof SERVER_COUNT_KEYS]) : k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").toLowerCase(), v] as [string, number])
    : [];
  if (fromServer.length) return fromServer;
  const labels = [
    ["agents", "workspaces:page.counts.agents"],
    ["logins", "workspaces:page.counts.logins"],
    ["totp", "workspaces:page.counts.totp"],
    ["integrations", "workspaces:page.counts.integrations"],
  ] as const satisfies readonly (readonly [keyof Counts, string])[];
  return labels.flatMap(([k, label]) => (fallback[k] ? [[translate(label), fallback[k]!] as [string, number]] : []));
}

function ScopeCard({
  workspace,
  index,
  current,
  tile,
  title,
  subtitle,
  description,
  counts,
  countsLoading,
  activity,
  onOpen,
  onBoard,
  menu,
  context,
  sources,
  projects,
}: {
  /** null for Global. */
  workspace: Workspace | null;
  index: number;
  current: boolean;
  tile: ReactNode;
  title: string;
  subtitle?: string;
  description?: string;
  counts: Counts;
  countsLoading: boolean;
  activity: WorkspaceActivity;
  onOpen: () => void;
  onBoard: () => void;
  menu?: ReactNode;
  context?: { label: string; set: boolean; onClick: () => void };
  sources?: { list: WorkspaceSource[]; onClick: () => void };
  projects?: { list: Project[]; current: string | null; onOpen: (p: Project) => void; onEdit: (p: Project) => void; onAdd: () => void };
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  const stats: { key: keyof Counts; label: string; icon: ReactNode }[] = [
    { key: "agents", label: t("common:words.agents"), icon: <Bot /> },
    { key: "logins", label: t("page.stats.logins"), icon: <KeyRound /> },
    { key: "totp", label: t("page.stats.totp"), icon: <ShieldCheck /> },
    { key: "integrations", label: t("page.stats.integrations"), icon: <Plug /> },
  ];
  const dnd = useWorkspaceDnd(workspace);
  return (
    <motion.article
      ref={dnd.ref}
      {...dnd.props}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border bg-card p-5 shadow-card transition hover:shadow-float",
        current ? "border-brand/35 ring-1 ring-brand/15" : dnd.state === "none" && "hover:border-foreground/15",
        dnd.state === "available" && "border-dashed border-brand/40",
        dnd.state === "valid" && "scale-[1.015] border-brand/60 ring-4 ring-brand/15",
        // `!` because motion holds the card's opacity inline.
        dnd.isDragging && "opacity-35!",
      )}
    >
      <div className="relative flex items-start justify-between gap-3">
        {tile}
        <div className="flex items-center gap-1">
          {current && (
            <Badge variant="outline" className="gap-1.5 border-brand/25 bg-brand-soft text-brand-strong">
              <span aria-hidden className="size-1.5 rounded-full bg-brand" />
              {t("page.current")}
            </Badge>
          )}
          {menu}
        </div>
      </div>
      <div className="relative mt-4 min-w-0">
        <h3 className="truncate text-base font-medium tracking-[-0.015em]">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        <ActivityChips activity={activity} className="mt-2" />
        <p className={cn("mt-1.5 line-clamp-2 min-h-10 text-sm text-muted-foreground", !description && "italic opacity-70")}>
          {description || t("page.noDescription")}
        </p>
        {context && (
          <button
            type="button"
            onClick={context.onClick}
            className={cn(
              "mt-2.5 flex max-w-full items-center gap-1.5 rounded-md text-xs transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              context.set ? "text-foreground hover:text-foreground/70" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {context.set ? <ScrollText className="size-3.5 shrink-0 text-brand-strong" /> : <Plus className="size-3.5 shrink-0" />}
            <span className="truncate">{context.label}</span>
          </button>
        )}
        {sources && (
          <button
            type="button"
            onClick={sources.onClick}
            aria-label={sources.list.length ? t("page.sourcesLabel", { names: sources.list.map((s) => s.name).join(", ") }) : undefined}
            className={cn(
              "mt-1.5 flex max-w-full items-center gap-1.5 rounded-md text-xs transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              sources.list.length ? "text-foreground hover:text-foreground/70" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {sources.list.length ? (
              <SourcesSummary sources={sources.list} />
            ) : (
              <>
                <Plus className="size-3.5 shrink-0" />
                <span className="truncate">{t("page.addSources")}</span>
              </>
            )}
          </button>
        )}
        {projects && !projects.list.length && (
          <button
            type="button"
            onClick={projects.onAdd}
            className="mt-1.5 flex max-w-full items-center gap-1.5 rounded-md text-xs text-muted-foreground transition hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <FolderPlus className="size-3.5 shrink-0" />
            <span className="truncate">{t("page.addProject")}</span>
          </button>
        )}
      </div>
      {projects && projects.list.length > 0 && <ProjectStrip {...projects} />}
      <div className="relative mt-4 grid grid-cols-4 gap-1.5">
        {stats.map((s) => {
          const n = counts[s.key];
          return (
            <Tooltip key={s.key}>
              <TooltipTrigger asChild>
                <div className="flex flex-col items-center gap-1 rounded-lg border bg-paper-2 px-1 py-2 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
                  {s.icon}
                  {countsLoading && n === null ? (
                    <Skeleton className="h-4 w-5" />
                  ) : (
                    <span className="font-mono text-sm font-medium tabular-nums">{n ?? "–"}</span>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>{n === null && !countsLoading ? t("page.statUnavailable", { label: s.label }) : s.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="relative mt-4 flex gap-2">
        <Button variant="outline" className="flex-1 justify-between" onClick={onOpen}>
          {workspace ? t("page.openWorkspace") : t("page.openGlobal")}
          <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
        </Button>
        <Button variant="outline" onClick={onBoard} aria-label={t("page.tasksOf", { name: title })}>
          <SquareKanban /> {t("page.menu.tasks")}
        </Button>
      </div>
    </motion.article>
  );
}


function ScopeListRow({
  workspace,
  current,
  tile,
  title,
  description,
  counts,
  activity,
  onOpen,
  onBoard,
  menu,
}: {
  /** null for Global. */
  workspace: Workspace | null;
  current: boolean;
  tile: ReactNode;
  title: string;
  description?: string;
  counts: Counts;
  activity: WorkspaceActivity;
  onOpen: () => void;
  onBoard: () => void;
  menu?: ReactNode;
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  const { dateLocale } = useLocale();
  const stats: { label: string; n: number | null; icon: ReactNode }[] = [
    { label: t("common:words.agents"), n: counts.agents, icon: <Bot /> },
    { label: t("page.stats.openTasks"), n: activity.openTasks, icon: <SquareKanban /> },
    { label: t("page.stats.logins"), n: counts.logins, icon: <KeyRound /> },
    { label: t("page.stats.integrations"), n: counts.integrations, icon: <Plug /> },
  ];
  const dnd = useWorkspaceDnd(workspace);
  return (
    <div
      ref={dnd.ref}
      {...dnd.props}
      className={cn(
        "group relative flex items-center gap-3 border-b px-4 py-2.5 transition last:border-b-0",
        dnd.state === "none" && "hover:bg-accent/40",
        current && "bg-brand-soft/40",
        dnd.state === "available" && "bg-brand/[0.03]",
        dnd.state === "valid" && "bg-brand/10",
        dnd.isDragging && "opacity-35",
      )}
    >
      {current && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" />}
      {tile}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {current && <span className="shrink-0 text-[11px] font-medium text-brand-strong">{t("page.current")}</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {activity.lastActive ? t("page.activity.active", { when: formatDistanceToNowStrict(new Date(activity.lastActive), { addSuffix: true, locale: dateLocale }) }) : description || t("page.activity.none")}
        </span>
      </button>
      <ActivityChips activity={activity} compact className="pointer-events-none hidden shrink-0 flex-nowrap @3xl:flex" />
      <div className="relative z-10 hidden shrink-0 items-center gap-3 @5xl:flex">
        {stats.map((s) => (
          <Tooltip key={s.label}>
            <TooltipTrigger asChild>
              <span className="flex w-11 items-center gap-1.5 font-mono text-xs text-muted-foreground tabular-nums [&_svg]:size-3.5">
                {s.icon}
                <span className={cn(s.n ? "text-foreground" : "")}>{s.n ?? "–"}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{s.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onBoard} aria-label={t("page.tasksOf", { name: title })} className="text-muted-foreground">
          <SquareKanban /> <span className="hidden @2xl:inline">{t("page.menu.tasks")}</span>
        </Button>
        {menu ?? <span className="w-8" />}
      </div>
    </div>
  );
}

const STRIP_MAX = 4;

/** A workspace card's projects: open one, edit it, or add another. */
function ProjectStrip({
  list,
  current,
  onOpen,
  onEdit,
  onAdd,
}: {
  list: Project[];
  current: string | null;
  onOpen: (p: Project) => void;
  onEdit: (p: Project) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, STRIP_MAX);
  const hidden = list.length - shown.length;
  return (
    <div className="relative mt-4 rounded-lg border bg-paper-2 p-2">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="eyebrow text-[10.5px] text-muted-foreground">
          {t("page.projects")}
          {list.length > 0 && <span className="ml-1 font-mono tabular-nums">{list.length}</span>}
        </span>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Plus className="size-3.5" /> {t("page.newProjectShort")}
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {shown.map((p) => (
          <ProjectChip key={p.id} project={p} current={current === p.id} onOpen={() => onOpen(p)} onEdit={() => onEdit(p)} />
        ))}
      </ul>
      {(hidden > 0 || all) && list.length > STRIP_MAX && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-0.5 px-1.5 text-xs text-muted-foreground transition hover:text-foreground">
          {all ? t("common:actions.showLess") : t("page.more", { count: hidden })}
        </button>
      )}
    </div>
  );
}

/** One project in a card's strip; drag it to another workspace or out into its own. */
function ProjectChip({ project: p, current, onOpen, onEdit }: { project: Project; current: boolean; onOpen: () => void; onEdit: () => void }) {
  const { t } = useTranslation("workspaces");
  const dnd = useProjectDnd(p);
  const reveal = "size-6 text-muted-foreground opacity-0 transition group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [&_svg]:size-3.5";
  return (
    <li ref={dnd.ref} {...dnd.props} className={cn("group/project relative flex items-center rounded-md transition hover:bg-card", dnd.isDragging && "opacity-35")}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-current={current || undefined}
      >
        <WorkspaceTile icon={p.icon} color={p.color} size="sm" className="size-5 rounded text-[11px]" />
        <span className="truncate">{p.name}</span>
        {current && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />}
        {p.sources.length > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground tabular-nums" title={p.sources.map((x) => x.name).join(", ")}>
            <FolderGit2 className="size-3" aria-hidden />
            {p.sources.length}
          </span>
        )}
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={t("page.editNamed", { name: p.name })} onClick={onEdit} className={reveal}>
        <Pencil />
      </Button>
      <ProjectMoveMenu project={p} className={cn("mr-0.5", reveal)} />
    </li>
  );
}

/** A project under its workspace in the list view. */
function ProjectListRow({
  project,
  workspace,
  last,
  current,
  activity,
  onOpen,
  onBoard,
  onEdit,
}: {
  project: Project;
  workspace: Workspace;
  last: boolean;
  current: boolean;
  activity: WorkspaceActivity;
  onOpen: () => void;
  onBoard: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation("workspaces");
  const { dateLocale } = useLocale();
  const dnd = useProjectDnd(project, workspace);
  return (
    <div
      ref={dnd.ref}
      {...dnd.props}
      className={cn(
        "group relative flex items-center gap-3 border-b py-2 pr-4 pl-8 transition last:border-b-0",
        dnd.state === "none" && "hover:bg-accent/40",
        current && "bg-brand-soft/40",
        dnd.state === "valid" && "bg-brand/10",
        dnd.isDragging && "opacity-35",
      )}
    >
      {current && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" />}
      <span aria-hidden className="absolute top-0 left-8 h-full w-3">
        <span className={cn("absolute left-0 w-px bg-border", last ? "top-0 h-1/2" : "inset-y-0")} />
        <span className="absolute top-1/2 left-0 h-px w-3 bg-border" />
      </span>
      <WorkspaceTile icon={project.icon} color={project.color} size="sm" className="ml-5 size-7 rounded-md text-sm" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{project.name}</span>
          {current && <span className="shrink-0 text-[11px] font-medium text-brand-strong">{t("page.current")}</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {activity.lastActive ? t("page.activity.active", { when: formatDistanceToNowStrict(new Date(activity.lastActive), { addSuffix: true, locale: dateLocale }) }) : project.description || t("page.activity.none")}
        </span>
      </button>
      <ActivityChips activity={activity} compact className="pointer-events-none hidden shrink-0 flex-nowrap @3xl:flex" />
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onBoard} aria-label={t("page.tasksOf", { name: project.name })} className="text-muted-foreground">
          <SquareKanban /> <span className="hidden @2xl:inline">{t("page.menu.tasks")}</span>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={t("page.editNamed", { name: project.name })} className="text-muted-foreground">
          <Pencil />
        </Button>
        <ProjectMoveMenu project={project} />
      </div>
    </div>
  );
}

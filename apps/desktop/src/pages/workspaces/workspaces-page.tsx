import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
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
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { useBootstrap, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { type WorkspacesSort, type WorkspacesView, useUi } from "@/stores/ui";
import { WorkspaceDialog } from "@/components/workspaces/workspace-dialog";
import { SourcesSummary } from "@/components/workspaces/workspace-sources";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { type WorkspaceActivity, projectKey, useWorkspaceActivity } from "@/components/workspaces/workspace-activity";
import { ProjectDialog } from "@/components/projects/project-dialog";

const SORTS: { id: WorkspacesSort; label: string }[] = [
  { id: "name", label: "A–Z" },
  { id: "active", label: "Recently active" },
  { id: "attention", label: "Needs you" },
];

const VIEWS: { id: WorkspacesView; label: string; icon: typeof List }[] = [
  { id: "grid", label: "Cards", icon: LayoutGrid },
  { id: "list", label: "List", icon: List },
];

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
    toast.error("That workspace doesn't exist anymore");
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
    else toast.error("That workspace doesn't exist anymore");
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
      toast.success(`${ws.name} deleted`);
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
      toastApiError(e, "Could not delete workspace", qc);
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
  const menuFor = (ws: Workspace) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${ws.name}`} className="text-muted-foreground">
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => open(ws, "/")}>
          <MessagesSquare /> Chats
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(ws, "/tasks")}>
          <SquareKanban /> Tasks
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(ws, "/agents")}>
          <Bot /> Agents
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setEditing(ws)}>
          <Pencil /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => addProject(ws)}>
          <FolderPlus /> New project
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(ws)}>
          <Trash2 /> Delete
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
    label: hasGlobalInstructions ? "Instructions for every agent" : "Add instructions for every agent",
    set: hasGlobalInstructions,
    onClick: () => navigate("/settings/instructions"),
  };

  return (
    <div className="relative min-h-full">
      <PageHeader
        icon={<Layers />}
        title="Workspaces"
        description="Separate clients, projects or areas of your life. Each workspace has its own agents, logins, 2FA codes and integrations — global items are shared with all of them."
        actions={
          <Button onClick={openCreate}>
            <Plus /> New workspace
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
                placeholder={`Search ${all.length} workspace${all.length === 1 ? "" : "s"}…`}
                aria-label="Search workspaces"
                className="pr-10 pl-9"
              />
              <span className="absolute top-1/2 right-2.5 -translate-y-1/2">
                <Kbd>/</Kbd>
              </span>
            </div>
            <div role="radiogroup" aria-label="Sort workspaces" className="flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
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
                  <span className="relative">{o.label}</span>
                </button>
              ))}
            </div>
            <div role="group" aria-label="View" className="ml-auto flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={view === v.id}
                  aria-label={v.label}
                  title={v.label}
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
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-xl" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
            <p className="font-medium text-destructive">Couldn't load workspaces</p>
            <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        ) : query && !list.length && !showGlobal ? (
          <EmptyState
            icon={<Search />}
            title={`No workspace matches “${search.trim()}”`}
            description="Try another name, or create it."
            action={
              <Button variant="outline" onClick={openCreate}>
                <Plus /> New workspace
              </Button>
            }
          />
        ) : view === "list" ? (
          <div className="overflow-hidden rounded-xl border bg-card shadow-card">
            {showGlobal && (
              <ScopeListRow
                current={scope === "global"}
                tile={<div aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary ring-1 ring-border ring-inset"><Globe2 className="size-4" /></div>}
                title="Global"
                description="Shared with every workspace"
                counts={counts.get(null)}
                activity={activity.of(null)}
                onOpen={() => open(null)}
                onBoard={() => open(null, "/tasks")}
              />
            )}
            {list.map((ws) => (
              <Fragment key={ws.id}>
                <ScopeListRow
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
                New workspace
              </button>
            )}
          </div>
        ) : (
          <motion.div layout className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {showGlobal && (
              <ScopeCard
                index={0}
                current={scope === "global"}
                tile={globalTile}
                title="Global"
                subtitle="Shared with every workspace"
                description="Logins, 2FA codes, integrations and agents here are available everywhere — perfect for your personal accounts and the main Godmode assistant."
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
                    label: ws.instructions.trim() ? "Agent context" : "Add agent context",
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
                <span className="text-sm font-medium">{list.length ? "New workspace" : "Create your first workspace"}</span>
                <span className="max-w-60 text-xs text-muted-foreground">
                  {list.length ? "Another client, project or team." : "e.g. one per client — agents there only see that client's logins."}
                </span>
              </motion.button>
            )}
          </motion.div>
        )}
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
            <AlertDialogTitle>
              Delete {deleting?.icon} {deleting?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>This can't be undone. Global items and other workspaces are not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) remove.mutate({ ws: deleting, force: false });
              }}
            >
              Delete workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!forceDelete} onOpenChange={(o) => !o && setForceDelete(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-destructive" /> {forceDelete?.workspace.name} isn't empty
            </AlertDialogTitle>
            <AlertDialogDescription>Force delete removes the workspace together with everything that belongs to it:</AlertDialogDescription>
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
          <p className="text-xs text-muted-foreground">Tip: move items you want to keep to Global or another workspace first.</p>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep workspace</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (forceDelete) remove.mutate({ ws: forceDelete.workspace, force: true });
              }}
            >
              Delete everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

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
        .map(([k, v]) => [k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").toLowerCase(), v] as [string, number])
    : [];
  if (fromServer.length) return fromServer;
  const labels: [keyof Counts, string][] = [
    ["agents", "agents"],
    ["logins", "logins"],
    ["totp", "2FA codes"],
    ["integrations", "integrations"],
  ];
  return labels.flatMap(([k, label]) => (fallback[k] ? [[label, fallback[k]!] as [string, number]] : []));
}

function ScopeCard({
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
  const stats: { key: keyof Counts; label: string; icon: ReactNode }[] = [
    { key: "agents", label: "Agents", icon: <Bot /> },
    { key: "logins", label: "Logins", icon: <KeyRound /> },
    { key: "totp", label: "2FA", icon: <ShieldCheck /> },
    { key: "integrations", label: "Integrations", icon: <Plug /> },
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
      <div className="relative flex items-start justify-between gap-3">
        {tile}
        <div className="flex items-center gap-1">
          {current && (
            <Badge variant="outline" className="gap-1.5 border-brand/25 bg-brand-soft text-brand-strong">
              <span aria-hidden className="size-1.5 rounded-full bg-brand" />
              Current
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
          {description || "No description yet."}
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
            aria-label={sources.list.length ? `Folders and repositories: ${sources.list.map((s) => s.name).join(", ")}` : undefined}
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
                <span className="truncate">Add folders or repositories</span>
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
            <span className="truncate">Add a project (optional)</span>
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
              <TooltipContent>{n === null && !countsLoading ? `${s.label}: unavailable (vault locked?)` : s.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="relative mt-4 flex gap-2">
        <Button variant="outline" className="flex-1 justify-between" onClick={onOpen}>
          Open {title === "Global" ? "Global" : "workspace"}
          <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
        </Button>
        <Button variant="outline" onClick={onBoard} aria-label={`Tasks of ${title}`}>
          <SquareKanban /> Tasks
        </Button>
      </div>
    </motion.article>
  );
}


/** What's going on in a scope, in a line: what waits for the human, what works, what's open, and when it last moved. */
function ActivityChips({ activity, className, compact }: { activity: WorkspaceActivity; className?: string; compact?: boolean }) {
  const quiet = !activity.needsYou && !activity.running;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5 text-xs", className)}>
      {activity.needsYou > 0 && (
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-warning/12 px-2 font-medium text-warning">
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {activity.needsYou} need{activity.needsYou === 1 ? "s" : ""} you
        </span>
      )}
      {activity.running > 0 && (
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-brand-strong/10 px-2 font-medium text-brand-strong">
          <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          {activity.running} working
        </span>
      )}
      {!compact && (
        <span className="truncate text-muted-foreground">
          {[
            activity.openTasks ? `${activity.openTasks} open task${activity.openTasks === 1 ? "" : "s"}` : quiet ? "No open tasks" : null,
            activity.lastActive ? `active ${formatDistanceToNowStrict(new Date(activity.lastActive), { addSuffix: true })}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}

function ScopeListRow({
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
  const stats: { label: string; n: number | null; icon: ReactNode }[] = [
    { label: "Agents", n: counts.agents, icon: <Bot /> },
    { label: "Open tasks", n: activity.openTasks, icon: <SquareKanban /> },
    { label: "Logins", n: counts.logins, icon: <KeyRound /> },
    { label: "Integrations", n: counts.integrations, icon: <Plug /> },
  ];
  return (
    <div className={cn("group relative flex items-center gap-3 border-b px-4 py-2.5 transition last:border-b-0 hover:bg-accent/40", current && "bg-brand-soft/40")}>
      {current && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" />}
      {tile}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {current && <span className="shrink-0 text-[11px] font-medium text-brand-strong">Current</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {activity.lastActive ? `Active ${formatDistanceToNowStrict(new Date(activity.lastActive), { addSuffix: true })}` : description || "No activity yet"}
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
        <Button variant="ghost" size="sm" onClick={onBoard} aria-label={`Tasks of ${title}`} className="text-muted-foreground">
          <SquareKanban /> <span className="hidden @2xl:inline">Tasks</span>
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
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, STRIP_MAX);
  const hidden = list.length - shown.length;
  return (
    <div className="relative mt-4 rounded-lg border bg-paper-2 p-2">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="eyebrow text-[10.5px] text-muted-foreground">
          Projects{list.length > 0 && <span className="ml-1 font-mono tabular-nums">{list.length}</span>}
        </span>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Plus className="size-3.5" /> New
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {shown.map((p) => (
          <li key={p.id} className="group/project relative flex items-center rounded-md transition hover:bg-card">
            <button
              type="button"
              onClick={() => onOpen(p)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              aria-current={current === p.id || undefined}
            >
              <WorkspaceTile icon={p.icon} color={p.color} size="sm" className="size-5 rounded text-[11px]" />
              <span className="truncate">{p.name}</span>
              {current === p.id && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />}
              {p.sources.length > 0 && (
                <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground tabular-nums" title={p.sources.map((x) => x.name).join(", ")}>
                  <FolderGit2 className="size-3" aria-hidden />
                  {p.sources.length}
                </span>
              )}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${p.name}`}
              onClick={() => onEdit(p)}
              className="mr-0.5 size-6 text-muted-foreground opacity-0 transition group-hover/project:opacity-100 focus-visible:opacity-100 [&_svg]:size-3.5"
            >
              <Pencil />
            </Button>
          </li>
        ))}
      </ul>
      {(hidden > 0 || all) && list.length > STRIP_MAX && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-0.5 px-1.5 text-xs text-muted-foreground transition hover:text-foreground">
          {all ? "Show less" : `${hidden} more`}
        </button>
      )}
    </div>
  );
}

/** A project under its workspace in the list view. */
function ProjectListRow({
  project,
  last,
  current,
  activity,
  onOpen,
  onBoard,
  onEdit,
}: {
  project: Project;
  last: boolean;
  current: boolean;
  activity: WorkspaceActivity;
  onOpen: () => void;
  onBoard: () => void;
  onEdit: () => void;
}) {
  return (
    <div className={cn("group relative flex items-center gap-3 border-b py-2 pr-4 pl-8 transition last:border-b-0 hover:bg-accent/40", current && "bg-brand-soft/40")}>
      {current && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" />}
      <span aria-hidden className="absolute top-0 left-8 h-full w-3">
        <span className={cn("absolute left-0 w-px bg-border", last ? "top-0 h-1/2" : "inset-y-0")} />
        <span className="absolute top-1/2 left-0 h-px w-3 bg-border" />
      </span>
      <WorkspaceTile icon={project.icon} color={project.color} size="sm" className="ml-5 size-7 rounded-md text-sm" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{project.name}</span>
          {current && <span className="shrink-0 text-[11px] font-medium text-brand-strong">Current</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {activity.lastActive ? `Active ${formatDistanceToNowStrict(new Date(activity.lastActive), { addSuffix: true })}` : project.description || "No activity yet"}
        </span>
      </button>
      <ActivityChips activity={activity} compact className="pointer-events-none hidden shrink-0 flex-nowrap @3xl:flex" />
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onBoard} aria-label={`Tasks of ${project.name}`} className="text-muted-foreground">
          <SquareKanban /> <span className="hidden @2xl:inline">Tasks</span>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${project.name}`} className="text-muted-foreground">
          <Pencil />
        </Button>
      </div>
    </div>
  );
}

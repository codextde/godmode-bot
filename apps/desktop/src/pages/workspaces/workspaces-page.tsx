import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Bot, EllipsisVertical, Globe2, KeyRound, Layers, Pencil, Plug, Plus, ScrollText, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Workspace, WorkspaceSource } from "@godmode/shared";
import { PageBody, PageHeader } from "@/components/common";
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
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { useBootstrap, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { WorkspaceDialog } from "@/components/workspaces/workspace-dialog";
import { SourcesSummary } from "@/components/workspaces/workspace-sources";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";

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
  const setScope = useUi((s) => s.setWorkspace);
  const { data: workspaces, isLoading, isError, error, refetch } = useWorkspaces();
  const { data: boot } = useBootstrap();
  const counts = useScopeCounts();
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

  const open = (ws: Workspace | null) => {
    setScope(ws ? ws.id : "global");
    navigate("/agents");
  };

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

  const list = workspaces ?? [];

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
        ) : (
          <motion.div layout className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            <ScopeCard
              index={0}
              current={scope === "global"}
              tile={
                <div aria-hidden className="grid size-14 shrink-0 place-items-center rounded-xl bg-secondary text-foreground ring-1 ring-border ring-inset">
                  <Globe2 className="size-6" />
                </div>
              }
              title="Global"
              subtitle="Shared with every workspace"
              description="Logins, 2FA codes, integrations and agents here are available everywhere — perfect for your personal accounts and the main Godmode assistant."
              counts={counts.get(null)}
              countsLoading={counts.loading}
              onOpen={() => open(null)}
              context={{
                label: hasGlobalInstructions ? "Instructions for every agent" : "Add instructions for every agent",
                set: hasGlobalInstructions,
                onClick: () => navigate("/settings/instructions"),
              }}
            />
            <AnimatePresence initial={false}>
              {list.map((ws, i) => (
                <ScopeCard
                  key={ws.id}
                  index={i + 1}
                  current={scope === ws.id}
                  tile={<WorkspaceTile icon={ws.icon} color={ws.color} size="lg" />}
                  title={ws.name}
                  description={ws.description}
                  counts={counts.get(ws.id)}
                  countsLoading={counts.loading}
                  onOpen={() => open(ws)}
                  context={{
                    label: ws.instructions.trim() ? "Agent context" : "Add agent context",
                    set: !!ws.instructions.trim(),
                    onClick: () => editFocused(ws, "instructions"),
                  }}
                  sources={{ list: ws.sources, onClick: () => editFocused(ws, "sources") }}
                  menu={
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${ws.name}`} className="text-muted-foreground">
                          <EllipsisVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onClick={() => setEditing(ws)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(ws)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                />
              ))}
            </AnimatePresence>
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
  onOpen,
  menu,
  context,
  sources,
}: {
  index: number;
  current: boolean;
  tile: ReactNode;
  title: string;
  subtitle?: string;
  description?: string;
  counts: Counts;
  countsLoading: boolean;
  onOpen: () => void;
  menu?: ReactNode;
  context?: { label: string; set: boolean; onClick: () => void };
  sources?: { list: WorkspaceSource[]; onClick: () => void };
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
      </div>
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
      <Button variant="outline" className="relative mt-4 w-full justify-between" onClick={onOpen}>
        Open {title === "Global" ? "Global" : "workspace"}
        <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
      </Button>
    </motion.article>
  );
}


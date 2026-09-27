import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Bot, EllipsisVertical, Globe2, KeyRound, Layers, Pencil, Plug, Plus, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Workspace } from "@godmode/shared";
import { colorGradient, PageBody, PageHeader } from "@/components/common";
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
import { useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { WorkspaceDialog } from "./workspace-dialog";
import { WorkspaceTile } from "./workspace-tile";

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

  const get = useMemo(() => {
    const count = <T extends { workspaceId: string | null }>(list: T[] | undefined, ws: string | null) =>
      list ? list.filter((x) => (x.workspaceId ?? null) === ws).length : null;
    return (ws: string | null): Counts => {
      const custom = mcp.data?.filter((m) => m.source !== "composio");
      const mcpCount = count(custom, ws);
      const composioCount = count(composio.data, ws);
      return {
        agents: count(agents.data, ws),
        logins: count(creds.data, ws),
        totp: count(totp.data, ws),
        integrations: mcpCount === null && composioCount === null ? null : (mcpCount ?? 0) + (composioCount ?? 0),
      };
    };
  }, [agents.data, creds.data, totp.data, mcp.data, composio.data]);

  return { get, loading: agents.isLoading || creds.isLoading || totp.isLoading };
}

export default function WorkspacesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const scope = useUi((s) => s.workspace);
  const setScope = useUi((s) => s.setWorkspace);
  const { data: workspaces, isLoading, isError, error, refetch } = useWorkspaces();
  const counts = useScopeCounts();

  const [editing, setEditing] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [forceDelete, setForceDelete] = useState<{ workspace: Workspace; counts: [string, number][] } | null>(null);

  const creating = params.get("new") === "1";
  const dialogOpen = creating || !!editing;
  const closeDialog = () => {
    setEditing(null);
    if (creating) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
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
      for (const key of [qk.workspaces, qk.bootstrap, qk.agents, qk.credentials, qk.totp, qk.mcpServers, qk.composio, qk.browserProfiles])
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
          <Button onClick={openCreate} className="bg-gradient-brand text-white shadow-md shadow-glow-a/25 hover:opacity-95">
            <Plus /> New workspace
          </Button>
        }
      />
      <PageBody>
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-2xl" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
            <p className="font-medium text-destructive">Couldn't load workspaces</p>
            <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <motion.div layout className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <ScopeCard
              index={0}
              current={scope === "global"}
              tile={
                <WorkspaceTile color="zinc" size="lg" className="from-zinc-500 to-zinc-700 text-white">
                  <Globe2 className="size-7 text-white drop-shadow-sm" />
                </WorkspaceTile>
              }
              wash="from-zinc-400 to-zinc-600"
              title="Global"
              subtitle="Shared with every workspace"
              description="Logins, 2FA codes, integrations and agents here are available everywhere — perfect for your personal accounts and the main Godmode assistant."
              counts={counts.get(null)}
              countsLoading={counts.loading}
              onOpen={() => open(null)}
            />
            <AnimatePresence initial={false}>
              {list.map((ws, i) => (
                <ScopeCard
                  key={ws.id}
                  index={i + 1}
                  current={scope === ws.id}
                  tile={<WorkspaceTile icon={ws.icon} color={ws.color} size="lg" />}
                  wash={colorGradient(ws.color)}
                  title={ws.name}
                  description={ws.description}
                  counts={counts.get(ws.id)}
                  countsLoading={counts.loading}
                  onOpen={() => open(ws)}
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
              className="group flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground transition group-hover:bg-gradient-brand group-hover:text-white group-hover:shadow-lg group-hover:shadow-glow-a/25">
                <Plus className="size-6" />
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
        workspace={editing}
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
  wash,
  title,
  subtitle,
  description,
  counts,
  countsLoading,
  onOpen,
  menu,
}: {
  index: number;
  current: boolean;
  tile: ReactNode;
  wash: string;
  title: string;
  subtitle?: string;
  description?: string;
  counts: Counts;
  countsLoading: boolean;
  onOpen: () => void;
  menu?: ReactNode;
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
        "group relative flex flex-col overflow-hidden rounded-2xl border bg-card/60 p-5 backdrop-blur-sm transition hover:border-primary/30 hover:shadow-lg hover:shadow-glow-a/5",
        current && "border-primary/40 ring-1 ring-primary/25",
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-br opacity-[0.14] transition-opacity [mask-image:linear-gradient(to_bottom,black_20%,transparent)] group-hover:opacity-25",
          wash,
        )}
      />
      <div className="relative flex items-start justify-between gap-3">
        <motion.div whileHover={{ rotate: -4, scale: 1.04 }} transition={{ type: "spring", stiffness: 300, damping: 15 }}>
          {tile}
        </motion.div>
        <div className="flex items-center gap-1">
          {current && (
            <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
              Current
            </Badge>
          )}
          {menu}
        </div>
      </div>
      <div className="relative mt-4 min-w-0">
        <h3 className="truncate text-base font-semibold tracking-tight">{title}</h3>
        {subtitle && <p className="text-xs font-medium text-muted-foreground">{subtitle}</p>}
        <p className={cn("mt-1.5 line-clamp-2 min-h-10 text-sm text-muted-foreground", !description && "italic opacity-70")}>
          {description || "No description yet."}
        </p>
      </div>
      <div className="relative mt-4 grid grid-cols-4 gap-1.5">
        {stats.map((s) => {
          const n = counts[s.key];
          return (
            <Tooltip key={s.key}>
              <TooltipTrigger asChild>
                <div className="flex flex-col items-center gap-1 rounded-xl border bg-background/40 px-1 py-2 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
                  {s.icon}
                  {countsLoading && n === null ? (
                    <Skeleton className="h-4 w-5" />
                  ) : (
                    <span className="text-sm font-semibold tabular-nums">{n ?? "–"}</span>
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


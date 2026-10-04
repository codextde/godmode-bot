import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Boxes, ChevronDown, FlaskConical, Heading, KeyRound, MoreHorizontal, Pencil, Plus, Server, Trash2, Zap } from "lucide-react";
import type { McpServer } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/common";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ConfirmDialog } from "./confirm-dialog";
import { McpServerDialog, type McpDialogState } from "./mcp-server-dialog";
import { McpTestDialog } from "./mcp-test-dialog";
import { formatArgs, MCP_PRESETS, transportMeta, type McpPreset } from "./mcp-utils";
import { QueryError } from "./query-error";
import { ScopeChip } from "./scope-picker";
import { prettySlug } from "./toolkit-logo";

export function useMcpServers() {
  return useQuery({ queryKey: qk.mcpServers, queryFn: () => api.mcpServers.list({ workspaceId: "all" }) });
}

/** Custom (and Composio-managed) MCP servers with enable/test/edit/delete. */
export function McpServersTab() {
  const qc = useQueryClient();
  const servers = useMcpServers();
  const [dialog, setDialog] = useState<McpDialogState>(null);
  const [testing, setTesting] = useState<McpServer | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.mcpServers.update(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.mcpServers });
      const prev = qc.getQueryData<McpServer[]>(qk.mcpServers);
      qc.setQueryData<McpServer[]>(qk.mcpServers, (list) => list?.map((s) => (s.id === id ? { ...s, enabled } : s)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.mcpServers, ctx.prev);
      toastApiError(e, "Couldn't update the server", qc);
    },
    onSuccess: (s) => toast.success(s.enabled ? `${s.name} enabled` : `${s.name} disabled`),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mcpServers }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.mcpServers.delete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.mcpServers });
      const prev = qc.getQueryData<McpServer[]>(qk.mcpServers);
      qc.setQueryData<McpServer[]>(qk.mcpServers, (list) => list?.filter((s) => s.id !== id));
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.mcpServers, ctx.prev);
      toastApiError(e, "Couldn't delete the server", qc);
    },
    onSuccess: () => toast.success("Server removed"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.mcpServers });
      void qc.invalidateQueries({ queryKey: qk.agents });
    },
  });

  const openPreset = (preset: McpPreset | null) => setDialog({ mode: "create", preset });
  const list = servers.data ?? [];
  const custom = list.filter((s) => s.source === "custom");
  const managed = list.filter((s) => s.source === "composio");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.02em]">
            <Server className="size-4 text-muted-foreground" /> MCP servers
          </h2>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            Any Model Context Protocol server — local commands or remote endpoints. Scope them globally, to a workspace, or to one agent.
          </p>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Zap /> Quick add <ChevronDown className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Popular servers</DropdownMenuLabel>
              {MCP_PRESETS.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => openPreset(p)} className="items-start gap-2.5 py-2">
                  <p.icon className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">{p.description}</span>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openPreset(null)}>
                <Plus /> Custom server…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => openPreset(null)}>
            <Plus /> Add server
          </Button>
        </div>
      </div>

      {servers.isError ? (
        <QueryError error={servers.error} onRetry={() => servers.refetch()} title="Couldn't load MCP servers" />
      ) : servers.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="space-y-5">
          <EmptyState
            icon={<Server />}
            title="No MCP servers yet"
            description="Add a server to give agents new abilities — a database, your file system, an internal API. Start with one of these:"
          />
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {MCP_PRESETS.map((p, i) => (
              <motion.button
                key={p.id}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 12) * 0.03 }}
                onClick={() => openPreset(p)}
                className="group flex items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-card transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground transition group-hover:bg-card group-hover:shadow-card">
                  <p.icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-sm font-medium">{p.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{p.description}</span>
                </span>
              </motion.button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {custom.length > 0 && (
            <ServerList
              servers={custom}
              onToggle={(s, enabled) => toggle.mutate({ id: s.id, enabled })}
              onTest={setTesting}
              onEdit={(s) => setDialog({ mode: "edit", server: s })}
              onDelete={setDeleting}
            />
          )}
          {managed.length > 0 && (
            <div className="space-y-2">
              <h3 className="eyebrow flex items-center gap-1.5">
                <Boxes className="size-3.5" /> Managed by Composio
              </h3>
              <ServerList servers={managed} onToggle={(s, enabled) => toggle.mutate({ id: s.id, enabled })} onTest={setTesting} onDelete={setDeleting} />
            </div>
          )}
        </div>
      )}

      <McpServerDialog state={dialog} onOpenChange={(o) => !o && setDialog(null)} onSaved={(s, test) => test && setTesting(s)} />
      <McpTestDialog server={testing} onOpenChange={(o) => !o && setTesting(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name ?? "server"}?`}
        description="Agents lose these tools from their next run. Stored environment variables and headers are deleted from the vault."
        confirmLabel="Remove"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function ServerList({
  servers,
  onToggle,
  onTest,
  onEdit,
  onDelete,
}: {
  servers: McpServer[];
  onToggle: (s: McpServer, enabled: boolean) => void;
  onTest: (s: McpServer) => void;
  onEdit?: (s: McpServer) => void;
  onDelete: (s: McpServer) => void;
}) {
  return (
    <ul className="space-y-2">
      <AnimatePresence initial={false}>
        {servers.map((s, i) => (
          <motion.li
            key={s.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.03 } }}
            exit={{ opacity: 0, height: 0 }}
          >
            <ServerRow server={s} onToggle={(v) => onToggle(s, v)} onTest={() => onTest(s)} onEdit={onEdit && (() => onEdit(s))} onDelete={() => onDelete(s)} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function ServerRow({
  server: s,
  onToggle,
  onTest,
  onEdit,
  onDelete,
}: {
  server: McpServer;
  onToggle: (v: boolean) => void;
  onTest: () => void;
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const t = transportMeta(s.transport);
  const composio = s.source === "composio";
  const target = s.transport === "stdio" ? [s.command, formatArgs(s.args)].filter(Boolean).join(" ") : s.url;
  return (
    <div
      className={cn(
        "group flex items-start gap-3.5 rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float",
        !s.enabled && "opacity-70",
      )}
    >
      <div
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg border",
          composio ? "bg-card text-foreground shadow-card" : "bg-paper-2 text-foreground",
        )}
      >
        {composio ? <Boxes className="size-5" /> : <t.icon className="size-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">{s.name}</span>
          <Badge variant="outline" className="h-5 gap-1 text-[10px] font-normal">
            <t.icon /> {s.transport}
          </Badge>
          {composio && <Badge variant="secondary" className="h-5 text-[10px]">Composio</Badge>}
        </div>
        {s.description && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{s.description}</p>}
        {!composio && target && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="mt-1.5 truncate rounded-md border bg-paper-2 px-2 py-1 font-mono text-[11.5px] text-muted-foreground">{target}</p>
            </TooltipTrigger>
            <TooltipContent className="max-w-md font-mono text-[11px] break-all">{target}</TooltipContent>
          </Tooltip>
        )}
        {composio && s.composio?.toolkits.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {s.composio.toolkits.map((tk) => (
              <Badge key={tk} variant="secondary" className="h-5 text-[10px] font-normal">
                {prettySlug(tk)}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <ScopeChip workspaceId={s.workspaceId} agentId={s.agentId} />
          {s.envKeys.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  <KeyRound className="size-3" /> {s.envKeys.length} env
                </span>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-[11px]">{s.envKeys.join(", ")}</TooltipContent>
            </Tooltip>
          )}
          {s.headerKeys.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  <Heading className="size-3" /> {s.headerKeys.length} header{s.headerKeys.length === 1 ? "" : "s"}
                </span>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-[11px]">{s.headerKeys.join(", ")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="mr-1 inline-flex">
              <Switch checked={s.enabled} onCheckedChange={onToggle} aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{s.enabled ? "Enabled" : "Disabled"}</TooltipContent>
        </Tooltip>
        <Button size="sm" variant="ghost" onClick={onTest} aria-label={`Test ${s.name}`}>
          <FlaskConical /> <span className="hidden @xl:inline">Test</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${s.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEdit ? (
              <DropdownMenuItem onClick={onEdit}>
                <Pencil /> Edit
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <Pencil /> Managed by Composio
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

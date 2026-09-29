import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Bot, Globe2, Layers, Link2, RefreshCw, Unplug } from "lucide-react";
import type { ComposioConnection, ComposioToolkit } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/common";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useAllAgents, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ConfirmDialog } from "./confirm-dialog";
import { prettySlug, ToolkitLogo } from "./toolkit-logo";

export function connectionTone(status: string): "ok" | "pending" | "error" | "neutral" {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "ok";
  if (s === "INITIATED" || s === "INITIALIZING" || s === "PENDING") return "pending";
  if (s === "FAILED" || s === "EXPIRED" || s === "REVOKED") return "error";
  return "neutral";
}

export function ConnectionStatusBadge({ status }: { status: string }) {
  const tone = connectionTone(status);
  const upper = status.toUpperCase();
  const label =
    tone === "ok"
      ? "Active"
      : tone === "pending"
        ? "Waiting for sign-in"
        : upper === "DELETED"
          ? "Deleted upstream"
          : status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  return (
    <Badge
      className={cn(
        "h-5 gap-1.5 text-[10px]",
        tone === "ok" && "border-brand/25 bg-brand-soft text-brand-strong",
        tone === "pending" && "border-warning/25 bg-warning/[0.08] text-warning",
        tone === "error" && "border-destructive/25 bg-destructive/[0.07] text-destructive",
        tone === "neutral" && "border-border bg-secondary text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full bg-current", tone === "pending" && "animate-pulse")} />
      {label}
    </Badge>
  );
}

interface Group {
  key: string;
  label: string;
  icon: ReactNode;
  items: ComposioConnection[];
}

/** Connected Composio accounts grouped by who can use them. */
export function ComposioConnections({ connections, toolkits }: { connections: ComposioConnection[]; toolkits: Record<string, ComposioToolkit> }) {
  const qc = useQueryClient();
  const { data: workspaces = [] } = useWorkspaces();
  const { data: agents = [] } = useAllAgents();
  const [pending, setPending] = useState<ComposioConnection | null>(null);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    const ensure = (key: string, make: () => Omit<Group, "items">) => {
      if (!map.has(key)) map.set(key, { ...make(), items: [] });
      return map.get(key)!;
    };
    for (const c of connections) {
      if (c.agentId) {
        const a = agents.find((x) => x.id === c.agentId);
        ensure(`agent:${c.agentId}`, () => ({
          key: `agent:${c.agentId}`,
          label: a?.name ?? "Agent",
          icon: a ? <AgentAvatar agent={a} size="sm" /> : <Bot className="size-4" />,
        })).items.push(c);
      } else if (c.workspaceId) {
        const w = workspaces.find((x) => x.id === c.workspaceId);
        ensure(`ws:${c.workspaceId}`, () => ({
          key: `ws:${c.workspaceId}`,
          label: w?.name ?? "Workspace",
          icon: w?.icon ? <span className="text-sm">{w.icon}</span> : <Layers className="size-4" />,
        })).items.push(c);
      } else {
        ensure("global", () => ({ key: "global", label: "Global — every agent", icon: <Globe2 className="size-4" /> })).items.push(c);
      }
    }
    const order = (k: string) => (k === "global" ? 0 : k.startsWith("ws:") ? 1 : 2);
    return [...map.values()].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label));
  }, [connections, agents, workspaces]);

  const disconnect = useMutation({
    mutationFn: (id: string) => api.composio.disconnect(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.composioConnections });
      const prev = qc.getQueryData<ComposioConnection[]>(qk.composioConnections);
      qc.setQueryData<ComposioConnection[]>(qk.composioConnections, (list) => list?.filter((c) => c.id !== id));
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.composioConnections, ctx.prev);
      toastApiError(e, "Couldn't disconnect", qc);
    },
    onSuccess: () => toast.success("Disconnected"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.composio });
      void qc.invalidateQueries({ queryKey: qk.mcpServers });
    },
  });

  const refresh = useMutation({
    mutationFn: (id: string) => api.composio.refresh(id),
    onSuccess: (c) => {
      qc.setQueryData<ComposioConnection[]>(qk.composioConnections, (list) => list?.map((x) => (x.id === c.id ? c : x)));
      toast(connectionTone(c.status) === "ok" ? "Connection is active" : `Status: ${c.status.toLowerCase()}`);
    },
    onError: (e) => toastApiError(e, "Couldn't refresh the connection", qc),
  });

  return (
    <section aria-label="Connected accounts" className="space-y-3">
      <h2 className="eyebrow flex items-center gap-2">
        <Link2 className="size-3.5" /> Connected accounts
        <span className="rounded-[4px] border bg-card px-1 font-mono text-[10px] tabular-nums">{connections.length}</span>
      </h2>
      <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
        {groups.map((g) => (
          <div key={g.key} className="rounded-xl border bg-card p-2 shadow-card">
            <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-2 text-xs font-medium text-muted-foreground">
              <span className="grid size-6 place-items-center">{g.icon}</span>
              {g.label}
            </div>
            <ul className="space-y-1">
              <AnimatePresence initial={false}>
                {g.items.map((c, i) => {
                  const tk = toolkits[c.toolkit];
                  const name = tk?.name ?? prettySlug(c.toolkit);
                  return (
                    <motion.li
                      key={c.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.03 } }}
                      exit={{ opacity: 0, height: 0 }}
                      className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition hover:bg-accent"
                    >
                      <ToolkitLogo src={tk?.logo ?? `https://logos.composio.dev/api/${c.toolkit}`} name={name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{name}</span>
                          <ConnectionStatusBadge status={c.status} />
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="truncate text-xs text-muted-foreground">
                              Connected {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent>
                            Composio user <span className="font-mono">{c.userId}</span> · account <span className="font-mono">{c.connectedAccountId}</span>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      {connectionTone(c.status) !== "ok" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Refresh ${name} status`}
                              onClick={() => refresh.mutate(c.id)}
                              disabled={refresh.isPending && refresh.variables === c.id}
                            >
                              <RefreshCw className={cn(refresh.isPending && refresh.variables === c.id && "animate-spin")} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Check status</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-muted-foreground opacity-70 group-hover:opacity-100 hover:text-destructive"
                            aria-label={`Disconnect ${name}`}
                            onClick={() => setPending(c)}
                          >
                            <Unplug />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Disconnect</TooltipContent>
                      </Tooltip>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Disconnect ${pending ? (toolkits[pending.toolkit]?.name ?? prettySlug(pending.toolkit)) : ""}?`}
        description="Agents in this scope immediately lose access to this account. You can reconnect it any time."
        confirmLabel="Disconnect"
        onConfirm={() => pending && disconnect.mutate(pending.id)}
      />
    </section>
  );
}

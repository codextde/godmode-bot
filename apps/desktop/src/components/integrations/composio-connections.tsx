import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Bot, Globe2, Layers, Link2, RefreshCw, Unplug } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { ComposioConnection, ComposioToolkit } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/common";
import { toastApiError } from "@/components/vault/vault-utils";
import { useLocale } from "@/i18n/language";
import { api } from "@/lib/api";
import { useAllAgents, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ConfirmDialog } from "./confirm-dialog";
import { prettySlug, ToolkitLogo, toolkitLogoUrl } from "./toolkit-logo";
import { useReduceAnimations } from "@/lib/motion";

export function connectionTone(status: string): "ok" | "pending" | "error" | "neutral" {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "ok";
  if (s === "INITIATED" || s === "INITIALIZING" || s === "PENDING") return "pending";
  if (s === "FAILED" || s === "EXPIRED" || s === "REVOKED") return "error";
  return "neutral";
}

export function ConnectionStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("integrations");
  const tone = connectionTone(status);
  const upper = status.toUpperCase();
  const label =
    tone === "ok"
      ? t("connections.status.active")
      : tone === "pending"
        ? t("connections.status.pending")
        : upper === "DELETED"
          ? t("connections.status.deleted")
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
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["integrations", "common"]);
  const { dateLocale } = useLocale();
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
          label: a?.name ?? t("common:words.agent"),
          icon: a ? <AgentAvatar agent={a} size="sm" /> : <Bot className="size-4" />,
        })).items.push(c);
      } else if (c.workspaceId) {
        const w = workspaces.find((x) => x.id === c.workspaceId);
        ensure(`ws:${c.workspaceId}`, () => ({
          key: `ws:${c.workspaceId}`,
          label: w?.name ?? t("scope.workspace"),
          icon: w?.icon ? <span className="text-sm">{w.icon}</span> : <Layers className="size-4" />,
        })).items.push(c);
      } else {
        ensure("global", () => ({ key: "global", label: t("connections.globalGroup"), icon: <Globe2 className="size-4" /> })).items.push(c);
      }
    }
    const order = (k: string) => (k === "global" ? 0 : k.startsWith("ws:") ? 1 : 2);
    return [...map.values()].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label));
  }, [connections, agents, workspaces, t]);

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
      toastApiError(e, t("connections.disconnectFailed"), qc);
    },
    onSuccess: () => toast.success(t("connections.disconnected")),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.composio });
      void qc.invalidateQueries({ queryKey: qk.mcpServers });
    },
  });

  const refresh = useMutation({
    mutationFn: (id: string) => api.composio.refresh(id),
    onSuccess: (c) => {
      qc.setQueryData<ComposioConnection[]>(qk.composioConnections, (list) => list?.map((x) => (x.id === c.id ? c : x)));
      toast(connectionTone(c.status) === "ok" ? t("connections.isActive") : t("connections.statusToast", { status: c.status.toLowerCase() }));
    },
    onError: (e) => toastApiError(e, t("connections.refreshFailed"), qc),
  });

  return (
    <section aria-label={t("connections.title")} className="space-y-3">
      <h2 className="eyebrow flex items-center gap-2">
        <Link2 className="size-3.5" /> {t("connections.title")}
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
                      animate={reduce ? { opacity: 1, y: 0 } : { opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.03 } }}
                      exit={{ opacity: 0, height: 0 }}
                      className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent"
                    >
                      <ToolkitLogo src={tk?.logo ?? toolkitLogoUrl(c.toolkit)} name={name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{name}</span>
                          <ConnectionStatusBadge status={c.status} />
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="truncate text-xs text-muted-foreground">
                              {t("connections.connectedAgo", { ago: formatDistanceToNow(new Date(c.createdAt), { addSuffix: true, locale: dateLocale }) })}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent>
                            <Trans
                              t={t}
                              i18nKey="connections.accountInfo"
                              values={{ user: c.userId, account: c.connectedAccountId }}
                              components={{ code: <span className="font-mono" /> }}
                            />
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      {connectionTone(c.status) !== "ok" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("connections.refreshAria", { name })}
                              onClick={() => refresh.mutate(c.id)}
                              disabled={refresh.isPending && refresh.variables === c.id}
                            >
                              <RefreshCw className={cn(refresh.isPending && refresh.variables === c.id && "animate-spin")} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t("connections.checkStatus")}</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-muted-foreground opacity-70 group-hover:opacity-100 hover:text-destructive"
                            aria-label={t("connections.disconnectAria", { name })}
                            onClick={() => setPending(c)}
                          >
                            <Unplug />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("connections.disconnect")}</TooltipContent>
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
        title={t("connections.disconnectTitle", { name: pending ? (toolkits[pending.toolkit]?.name ?? prettySlug(pending.toolkit)) : "" })}
        description={t("connections.disconnectDescription")}
        confirmLabel={t("connections.disconnect")}
        onConfirm={() => pending && disconnect.mutate(pending.id)}
      />
    </section>
  );
}

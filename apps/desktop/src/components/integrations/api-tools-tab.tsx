import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, CircleCheck, CircleDashed, CircleX, FileText, FlaskConical, Globe, MoreHorizontal, Pencil, Plus, ShieldCheck, Terminal, Trash2, Wrench, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ApiTool, ApiToolTestResult } from "@godmode/shared";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { useLocale } from "@/i18n/language";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ApiToolDialog, type ApiToolDialogState } from "./api-tool-dialog";
import { API_TOOL_PRESETS, CUSTOM_ICON, toolIcon, type ApiToolPreset } from "./api-tool-presets";
import { ConfirmDialog } from "./confirm-dialog";
import { QueryError } from "./query-error";
import { ScopeChip } from "./scope-picker";

export function useApiTools() {
  return useQuery({ queryKey: qk.apiTools, queryFn: () => api.apiTools.list({ workspaceId: "all" }) });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** APIs agents may call with a stored key: add from a preset or from scratch, test, scope, enable. */
export function ApiToolsTab() {
  const { t } = useTranslation(["integrations", "common"]);
  const qc = useQueryClient();
  const tools = useApiTools();
  const [dialog, setDialog] = useState<ApiToolDialogState>(null);
  const [deleting, setDeleting] = useState<ApiTool | null>(null);
  const [results, setResults] = useState<Record<string, ApiToolTestResult>>({});

  const onTested = (tool: ApiTool, result: ApiToolTestResult) => setResults((r) => ({ ...r, [tool.id]: result }));

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.apiTools.update(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.apiTools });
      const prev = qc.getQueryData<ApiTool[]>(qk.apiTools);
      qc.setQueryData<ApiTool[]>(qk.apiTools, (list) => list?.map((tool) => (tool.id === id ? { ...tool, enabled } : tool)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.apiTools, ctx.prev);
      toastApiError(e, t("tools.updateFailed"), qc);
    },
    onSuccess: (tool) =>
      toast.success(tool.enabled ? t("tools.isOn", { name: tool.name }) : t("tools.isOff", { name: tool.name }), {
        description: tool.enabled ? t("tools.isOnHint") : t("tools.isOffHint"),
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.apiTools }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.apiTools.delete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.apiTools });
      const prev = qc.getQueryData<ApiTool[]>(qk.apiTools);
      qc.setQueryData<ApiTool[]>(qk.apiTools, (list) => list?.filter((tool) => tool.id !== id));
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.apiTools, ctx.prev);
      toastApiError(e, t("tools.removeFailed"), qc);
    },
    onSuccess: () => toast.success(t("tools.removed")),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.apiTools }),
  });

  const openPreset = (preset: ApiToolPreset | null) => setDialog({ mode: "create", preset });
  const list = tools.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.02em]">
            <Wrench className="size-4 text-muted-foreground" /> {t("tabs.tools")}
          </h2>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            {t("tools.description")}
          </p>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Zap /> {t("mcp.quickAdd")} <ChevronDown className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-xs text-muted-foreground">{t("tools.readyToGo")}</DropdownMenuLabel>
              {API_TOOL_PRESETS.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => openPreset(p)} className="items-start gap-2.5 py-2">
                  <p.icon className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">{t(p.tagline)}</span>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openPreset(null)}>
                <Plus /> {t("tools.anyOtherMenu")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => openPreset(null)}>
            <Plus /> {t("tools.addTool")}
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-brand/25 bg-brand-soft p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-strong" />
        <div className="text-sm">
          <p className="font-medium">{t("tools.keyHiddenTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("tools.keyHiddenDescription")}</p>
        </div>
      </div>

      {tools.isError ? (
        <QueryError error={tools.error} onRetry={() => tools.refetch()} title={t("tools.loadError")} />
      ) : tools.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <PresetGallery onPick={openPreset} />
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {list.map((t, i) => (
              <motion.li
                key={t.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.03 } }}
                exit={{ opacity: 0, height: 0 }}
              >
                <ToolRow
                  tool={t}
                  result={results[t.id]}
                  onTested={(r) => onTested(t, r)}
                  onToggle={(enabled) => toggle.mutate({ id: t.id, enabled })}
                  onEdit={() => setDialog({ mode: "edit", tool: t })}
                  onDelete={() => setDeleting(t)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <ApiToolDialog state={dialog} onOpenChange={(o) => !o && setDialog(null)} onTested={onTested} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? t("mcp.removeTitle", { name: deleting.name }) : t("tools.removeToolTitle")}
        description={t("tools.removeDescription")}
        confirmLabel={t("common:actions.remove")}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function PresetGallery({ onPick }: { onPick: (p: ApiToolPreset | null) => void }) {
  const { t } = useTranslation("integrations");
  const cards = [
    ...API_TOOL_PRESETS.map((p) => ({ key: p.id, preset: p as ApiToolPreset | null, icon: p.icon, name: p.name, tagline: t(p.tagline) })),
    { key: "custom", preset: null, icon: CUSTOM_ICON, name: t("tools.anyOther"), tagline: t("tools.anyOtherTagline") },
  ];
  return (
    <div className="space-y-4">
      <div className="px-1">
        <h3 className="text-base font-medium tracking-[-0.01em]">{t("tools.emptyTitle")}</h3>
        <p className="mt-1 max-w-lg text-sm text-muted-foreground">{t("tools.emptyDescription")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {cards.map((c, i) => (
          <motion.button
            key={c.key}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 12) * 0.035 }}
            onClick={() => onPick(c.preset)}
            className={cn(
              "group flex items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-card transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              !c.preset && "border-dashed bg-card/60 shadow-none",
            )}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground transition group-hover:bg-card group-hover:shadow-card">
              <c.icon className="size-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{c.name}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{c.tagline}</span>
            </span>
            <Plus className="ml-auto size-4 shrink-0 self-center text-muted-foreground opacity-0 transition group-hover:opacity-100" />
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function ToolRow({
  tool,
  result,
  onTested,
  onToggle,
  onEdit,
  onDelete,
}: {
  tool: ApiTool;
  result: ApiToolTestResult | undefined;
  onTested: (r: ApiToolTestResult) => void;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["integrations", "common"]);
  const { dateLocale } = useLocale();
  const qc = useQueryClient();
  const Icon = toolIcon(tool.preset);
  const test = useMutation({
    mutationFn: () => api.apiTools.test(tool.id),
    onSuccess: onTested,
    onError: (e) => toastApiError(e, t("tools.testFailedToast", { name: tool.name }), qc),
  });

  return (
    <div className={cn("group rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float", !tool.enabled && "opacity-70")}>
      <div className="flex items-start gap-3.5">
        <button type="button" onClick={onEdit} aria-label={t("mcpDialog.editTitle", { name: tool.name })} className="grid size-10 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground transition hover:bg-card hover:shadow-card">
          <Icon className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onEdit} className="truncate text-sm font-medium tracking-[-0.01em] hover:underline hover:decoration-foreground/30 hover:underline-offset-[3px]">
              {tool.name}
            </button>
            {tool.hasKey ? (
              <Badge variant="outline" className="h-5 gap-1 border-brand/25 bg-brand-soft text-[10px] text-brand-strong">
                <CircleCheck /> {t("tools.keySaved")}
              </Badge>
            ) : (
              <Badge variant="outline" className="h-5 gap-1 text-[10px] font-normal text-muted-foreground">
                <CircleDashed /> {t("tools.noKey")}
              </Badge>
            )}
            {tool.envVar && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="h-5 gap-1 font-mono text-[10px] font-normal">
                    <Terminal /> ${tool.envVar}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{t("tools.envVarHint")}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {tool.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <ScopeChip workspaceId={tool.workspaceId} agentId={tool.agentId} />
            {tool.baseUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px]">
                    <Globe className="size-3 shrink-0" /> <span className="truncate">{hostOf(tool.baseUrl)}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="font-mono text-[11px]">{t("tools.onlySentTo", { url: tool.baseUrl })}</TooltipContent>
              </Tooltip>
            )}
            <span className={cn("inline-flex items-center gap-1", !tool.docs && !tool.docsUrl && "text-warning")}>
              <FileText className="size-3" /> {tool.docs ? t("tools.docs") : tool.docsUrl ? t("tools.docsLink") : t("tools.noDocs")}
            </span>
            <span>{tool.lastUsedAt ? t("tools.usedAgo", { ago: formatDistanceToNow(new Date(tool.lastUsedAt), { addSuffix: true, locale: dateLocale }) }) : t("tools.notUsed")}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mr-1 inline-flex">
                <Switch checked={tool.enabled} onCheckedChange={onToggle} aria-label={tool.enabled ? t("tools.turnOffAria", { name: tool.name }) : t("tools.turnOnAria", { name: tool.name })} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{tool.enabled ? t("tools.onHint") : t("common:status.off")}</TooltipContent>
          </Tooltip>
          {tool.testPath && tool.baseUrl && (
            <Button size="sm" variant="ghost" onClick={() => test.mutate()} disabled={test.isPending} aria-label={t("mcpTest.title", { name: tool.name })}>
              {test.isPending ? <Spinner /> : <FlaskConical />} <span className="hidden @xl:inline">{t("mcp.test")}</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t("mcp.moreActionsAria", { name: tool.name })}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil /> {t("common:actions.edit")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 /> {t("common:actions.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {result && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div
              role="status"
              className={cn(
                "mt-3 ml-[3.375rem] flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                result.ok ? "border-brand/25 bg-brand-soft text-foreground" : "border-destructive/25 bg-destructive/[0.05]",
              )}
            >
              {result.ok ? <CircleCheck className="mt-px size-3.5 shrink-0 text-brand-strong" /> : <CircleX className="mt-px size-3.5 shrink-0 text-destructive" />}
              <span className="min-w-0 break-words">
                <span className="font-medium">{result.ok ? t("tools.keyWorks") : t("tools.testFailed")}</span>
                <span className="text-muted-foreground"> — {result.message}</span>
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, CircleCheck, CircleDashed, CircleX, FileText, FlaskConical, Globe, MoreHorizontal, Pencil, Plus, ShieldCheck, Terminal, Trash2, Wrench, Zap } from "lucide-react";
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
      qc.setQueryData<ApiTool[]>(qk.apiTools, (list) => list?.map((t) => (t.id === id ? { ...t, enabled } : t)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.apiTools, ctx.prev);
      toastApiError(e, "Couldn't update the tool", qc);
    },
    onSuccess: (t) => toast.success(t.enabled ? `${t.name} is on` : `${t.name} is off`, { description: t.enabled ? "Agents in scope can use it again." : "Agents won't see it until you turn it back on." }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.apiTools }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.apiTools.delete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.apiTools });
      const prev = qc.getQueryData<ApiTool[]>(qk.apiTools);
      qc.setQueryData<ApiTool[]>(qk.apiTools, (list) => list?.filter((t) => t.id !== id));
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.apiTools, ctx.prev);
      toastApiError(e, "Couldn't remove the tool", qc);
    },
    onSuccess: () => toast.success("Tool removed"),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.apiTools }),
  });

  const openPreset = (preset: ApiToolPreset | null) => setDialog({ mode: "create", preset });
  const list = tools.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.02em]">
            <Wrench className="size-4 text-muted-foreground" /> Tools
          </h2>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            Give agents any API with your key — image generation, voices, search, your own services. Say what it's for; they work out the calls.
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
              <DropdownMenuLabel className="text-xs text-muted-foreground">Ready to go — just add your key</DropdownMenuLabel>
              {API_TOOL_PRESETS.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => openPreset(p)} className="items-start gap-2.5 py-2">
                  <p.icon className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">{p.tagline}</span>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openPreset(null)}>
                <Plus /> Any other API…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => openPreset(null)}>
            <Plus /> Add tool
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-brand/25 bg-brand-soft p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-strong" />
        <div className="text-sm">
          <p className="font-medium">Agents use the key, they never see it</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Keys are sealed in your vault. Godmode adds them to each request and only sends them to the tool's own address; every call is in the audit log.
          </p>
        </div>
      </div>

      {tools.isError ? (
        <QueryError error={tools.error} onRetry={() => tools.refetch()} title="Couldn't load tools" />
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
        title={`Remove ${deleting?.name ?? "tool"}?`}
        description="Agents lose it from their next message, and its key is deleted from the vault."
        confirmLabel="Remove"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function PresetGallery({ onPick }: { onPick: (p: ApiToolPreset | null) => void }) {
  const cards = [...API_TOOL_PRESETS.map((p) => ({ key: p.id, preset: p as ApiToolPreset | null, icon: p.icon, name: p.name, tagline: p.tagline })), { key: "custom", preset: null, icon: CUSTOM_ICON, name: "Any other API", tagline: "Your key, its address and docs" }];
  return (
    <div className="space-y-4">
      <div className="px-1">
        <h3 className="text-base font-medium tracking-[-0.01em]">No tools yet</h3>
        <p className="mt-1 max-w-lg text-sm text-muted-foreground">Start with one of these — they come with the address and docs filled in, so all you add is the key.</p>
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
  tool: t,
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
  const qc = useQueryClient();
  const Icon = toolIcon(t.preset);
  const test = useMutation({
    mutationFn: () => api.apiTools.test(t.id),
    onSuccess: onTested,
    onError: (e) => toastApiError(e, `Couldn't test ${t.name}`, qc),
  });

  return (
    <div className={cn("group rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float", !t.enabled && "opacity-70")}>
      <div className="flex items-start gap-3.5">
        <button type="button" onClick={onEdit} aria-label={`Edit ${t.name}`} className="grid size-10 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground transition hover:bg-card hover:shadow-card">
          <Icon className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onEdit} className="truncate text-sm font-medium tracking-[-0.01em] hover:underline hover:decoration-foreground/30 hover:underline-offset-[3px]">
              {t.name}
            </button>
            {t.hasKey ? (
              <Badge variant="outline" className="h-5 gap-1 border-brand/25 bg-brand-soft text-[10px] text-brand-strong">
                <CircleCheck /> Key saved
              </Badge>
            ) : (
              <Badge variant="outline" className="h-5 gap-1 text-[10px] font-normal text-muted-foreground">
                <CircleDashed /> No key
              </Badge>
            )}
            {t.envVar && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="h-5 gap-1 font-mono text-[10px] font-normal">
                    <Terminal /> ${t.envVar}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Runs also get the key in this environment variable</TooltipContent>
              </Tooltip>
            )}
          </div>
          {t.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <ScopeChip workspaceId={t.workspaceId} agentId={t.agentId} />
            {t.baseUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px]">
                    <Globe className="size-3 shrink-0" /> <span className="truncate">{hostOf(t.baseUrl)}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="font-mono text-[11px]">The key is only sent to {t.baseUrl}</TooltipContent>
              </Tooltip>
            )}
            <span className={cn("inline-flex items-center gap-1", !t.docs && !t.docsUrl && "text-warning")}>
              <FileText className="size-3" /> {t.docs ? "Docs" : t.docsUrl ? "Docs link" : "No docs"}
            </span>
            <span>{t.lastUsedAt ? `Used ${formatDistanceToNow(new Date(t.lastUsedAt), { addSuffix: true })}` : "Not used yet"}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mr-1 inline-flex">
                <Switch checked={t.enabled} onCheckedChange={onToggle} aria-label={`${t.enabled ? "Turn off" : "Turn on"} ${t.name}`} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t.enabled ? "On — agents can use it" : "Off"}</TooltipContent>
          </Tooltip>
          {t.testPath && t.baseUrl && (
            <Button size="sm" variant="ghost" onClick={() => test.mutate()} disabled={test.isPending} aria-label={`Test ${t.name}`}>
              {test.isPending ? <Spinner /> : <FlaskConical />} <span className="hidden @xl:inline">Test</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${t.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 /> Remove
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
                <span className="font-medium">{result.ok ? "The key works" : "Test failed"}</span>
                <span className="text-muted-foreground"> — {result.message}</span>
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

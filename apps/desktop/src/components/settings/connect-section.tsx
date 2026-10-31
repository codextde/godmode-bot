import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Activity, Bot, Box, Plug, Plus, ShieldCheck, SquareKanban, SquareTerminal, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import type { Connector, ConnectorTool } from "@godmode/shared";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { dateLocale } from "@/i18n";
import { cloudContext } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { ConnectAppDialog, type ConnectTab } from "./connect-app-dialog";
import { Callout, SectionHeading, SettingsGroup } from "./settings-kit";

/** The tools by what they are about, in the words of the app's own pages. */
const TOOL_GROUPS = [
  { id: "agents", titleKey: "connect.tools.agents", icon: <Bot />, aboutKey: "connect.tools.agentsAbout", match: (n: string) => n.startsWith("agent") },
  { id: "automations", titleKey: "connect.tools.automations", icon: <Workflow />, aboutKey: "connect.tools.automationsAbout", match: (n: string) => n.startsWith("routine") || n.startsWith("automation") },
  { id: "tasks", titleKey: "connect.tools.tasks", icon: <SquareKanban />, aboutKey: "connect.tools.tasksAbout", match: (n: string) => n.startsWith("task") },
  { id: "vms", titleKey: "connect.tools.vms", icon: <Box />, aboutKey: "connect.tools.vmsAbout", match: (n: string) => n.startsWith("vm") },
  { id: "activity", titleKey: "connect.tools.activity", icon: <Activity />, aboutKey: "connect.tools.activityAbout", match: () => true },
] as const satisfies readonly { id: string; titleKey: string; icon: ReactNode; aboutKey: string; match: (name: string) => boolean }[];

export function ConnectSection() {
  const { t } = useTranslation("settings");
  const [dialog, setDialog] = useState<ConnectTab | null>(null);
  // Keys are made and removed on the computer itself: through Godmode Cloud the page only explains.
  const remote = !!cloudContext;
  const status = useQuery({ queryKey: qk.connectors, queryFn: api.connectors.status, enabled: !remote });
  const s = status.data;

  return (
    <div className="space-y-5">
      <SectionHeading title="Claude Code & MCP" description={t("connect.description")} />

      {remote ? (
        <Callout tone="muted">{t("connect.remoteOnly")}</Callout>
      ) : (
        <>
          <Hero onConnect={setDialog} loading={status.isLoading} connected={!!s?.connectors.some((c) => c.installed)} />

          <SettingsGroup
            title={t("connect.apps.title")}
            icon={<Plug />}
            description={t("connect.apps.description")}
            actions={
              s?.connectors.length ? (
                <Button variant="outline" size="sm" onClick={() => setDialog("other")}>
                  <Plus /> {t("connect.apps.connect")}
                </Button>
              ) : undefined
            }
          >
            {!s && status.isError ? (
              <p className="py-5 text-sm text-muted-foreground">{errorMessage(status.error)}</p>
            ) : !s ? (
              <div className="py-4">
                <Skeleton className="h-10 w-full" />
              </div>
            ) : s.connectors.length === 0 ? (
              <p className="py-5 text-sm text-muted-foreground">{t("connect.apps.empty")}</p>
            ) : (
              s.connectors.map((c) => <ConnectorRow key={c.id} connector={c} />)
            )}
          </SettingsGroup>

          {s && <ToolsGroup tools={s.tools} />}

          <Callout tone="muted" icon={<ShieldCheck className="text-muted-foreground" />} title={t("connect.stays.title")}>
            {t("connect.stays.body")}
          </Callout>

          <ConnectAppDialog tab={dialog} onClose={() => setDialog(null)} claudeCode={s?.claudeCode ?? true} />
        </>
      )}
    </div>
  );
}

function Hero({ onConnect, loading, connected }: { onConnect: (tab: ConnectTab) => void; loading: boolean; connected: boolean }) {
  const { t } = useTranslation("settings");
  return (
    <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-col gap-6 p-6 @xl:flex-row @xl:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{t("connect.hero.eyebrow")}</p>
          <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">{t("connect.hero.title")}</h3>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{t("connect.hero.body")}</p>
          <Button className="mt-5" onClick={() => onConnect("claude-code")} disabled={loading}>
            <SquareTerminal /> {connected ? t("connect.hero.again") : t("connect.hero.connect")}
          </Button>
          <p className="mt-2.5 text-xs text-muted-foreground">
            {t("connect.hero.other")}{" "}
            <button
              type="button"
              onClick={() => onConnect("other")}
              disabled={loading}
              className="rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t("connect.hero.otherLink")}
            </button>
          </p>
        </div>
        <TerminalGlyph />
      </div>
    </section>
  );
}

/** A quiet terminal: one request, and the tool call it turns into. */
function TerminalGlyph() {
  const { t } = useTranslation("settings");
  return (
    <div aria-hidden className="w-full shrink-0 rounded-lg border bg-paper-2 font-mono text-[11px] leading-relaxed @xl:w-[272px]">
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-2 rounded-full bg-foreground/12" />
        ))}
        <span className="ml-1.5 text-[10px] text-muted-foreground">claude</span>
      </div>
      <div className="space-y-2 px-3 py-3">
        <p className="text-foreground/85">
          <span className="text-muted-foreground">&gt; </span>{t("connect.glyph.prompt")}
        </p>
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-brand" />
          godmode · agent_create
        </p>
        <p className="rounded-md border bg-card px-2 py-1.5 font-sans text-xs text-foreground">
          {t("connect.glyph.agent")} <span className="text-muted-foreground">· {t("connect.glyph.meta")}</span>
        </p>
      </div>
    </div>
  );
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.connectors.remove(connector.id),
    onSuccess: () => {
      toast.success(t("phone.device.removed", { name: connector.name }));
      void qc.invalidateQueries({ queryKey: qk.connectors });
    },
    onError: (e) => toastApiError(e, t("connect.row.removeError"), qc),
  });
  const connected = t("connect.row.connected", { time: formatDistanceToNow(new Date(connector.createdAt), { addSuffix: true, locale: dateLocale() }) });

  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4">{connector.client === "claude-code" ? <SquareTerminal /> : <Plug />}</div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <span className="truncate">{connector.name}</span>
          <Badge variant="outline" className={cn("font-normal", connector.access === "manage" ? "border-brand/25 bg-brand-soft text-brand-strong" : "text-muted-foreground")}>
            {connector.access === "manage" ? t("connect.access.manage") : t("connect.access.read")}
          </Badge>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {connector.lastUsedAt ? (
            <Trans
              t={t}
              i18nKey={connector.lastTool ? "connect.row.lastUsedTool" : "connect.row.lastUsed"}
              values={{
                time: formatDistanceToNow(new Date(connector.lastUsedAt), { addSuffix: true, locale: dateLocale() }),
                tool: connector.lastTool,
                calls: t("connect.row.calls", { count: connector.calls }),
                connected,
              }}
              components={{ code: <span className="font-mono text-[11px]" /> }}
            />
          ) : (
            t("connect.row.notUsed", { connected })
          )}
        </p>
      </div>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={t("phone.device.removeLabel", { name: connector.name })} onClick={() => setConfirm(true)}>
        {remove.isPending ? <Spinner /> : <Trash2 />}
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("phone.device.confirmTitle", { name: connector.name })}</AlertDialogTitle>
            <AlertDialogDescription>{connector.installed ? t("connect.row.confirmInstalled") : t("connect.row.confirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              {t("common:actions.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function firstSentence(text: string): string {
  return /^.*?\.(?=\s|$)/.exec(text)?.[0] ?? text;
}

function ToolsGroup({ tools }: { tools: ConnectorTool[] }) {
  const { t } = useTranslation("settings");
  const rest = [...tools];
  const groups = TOOL_GROUPS.map((g) => {
    const own = rest.filter((tool) => g.match(tool.name));
    for (const tool of own) rest.splice(rest.indexOf(tool), 1);
    return { ...g, tools: own };
  }).filter((g) => g.tools.length);
  const description = t("connect.tools.description", { count: tools.length });

  return (
    <SettingsGroup
      title={t("connect.tools.title")}
      icon={<SquareTerminal />}
      description={description}
    >
      {groups.map((g) => (
        <div key={g.id} className="flex flex-col gap-2.5 py-4 @xl:flex-row @xl:gap-6">
          <div className="flex min-w-0 gap-2.5 @xl:w-56 @xl:shrink-0">
            <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">{g.icon}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{t(g.titleKey)}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(g.aboutKey)}</p>
            </div>
          </div>
          <ul className="flex min-w-0 flex-1 flex-wrap content-start gap-1.5">
            {g.tools.map((tool) => (
              <li key={tool.name}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      className={cn(
                        "inline-flex h-6 cursor-default items-center rounded-md border px-2 font-mono text-[11px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        tool.access === "read" ? "bg-secondary/60 text-muted-foreground" : "bg-card text-foreground",
                      )}
                    >
                      {tool.name}
                      {tool.access === "read" && <span className="sr-only"> {t("connect.tools.onlyReads")}</span>}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">{firstSentence(tool.description)}</TooltipContent>
                </Tooltip>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </SettingsGroup>
  );
}

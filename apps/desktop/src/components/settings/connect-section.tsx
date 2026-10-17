import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Activity, Bot, Box, Plug, Plus, ShieldCheck, SquareKanban, SquareTerminal, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
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
import { cloudContext } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { ConnectAppDialog, type ConnectTab } from "./connect-app-dialog";
import { Callout, SectionHeading, SettingsGroup } from "./settings-kit";

/** The tools by what they are about, in the words of the app's own pages. */
const TOOL_GROUPS: { title: string; icon: ReactNode; about: string; match: (name: string) => boolean }[] = [
  { title: "Agents", icon: <Bot />, about: "See the team, add agents, change their job, instructions and look.", match: (n) => n.startsWith("agent") },
  { title: "Automations", icon: <Workflow />, about: "Schedules, app events, conditions and webhooks that start an agent.", match: (n) => n.startsWith("routine") || n.startsWith("automation") },
  { title: "Tasks", icon: <SquareKanban />, about: "File tickets, hand them to agents, read results, send feedback.", match: (n) => n.startsWith("task") },
  { title: "Virtual machines", icon: <Box />, about: "Create VMs and put agents to work in them.", match: (n) => n.startsWith("vm") },
  { title: "Activity", icon: <Activity />, about: "What every agent did, what failed, which logins are missing.", match: () => true },
];

export function ConnectSection() {
  const [dialog, setDialog] = useState<ConnectTab | null>(null);
  // Keys are made and removed on the computer itself: through Godmode Cloud the page only explains.
  const remote = !!cloudContext;
  const status = useQuery({ queryKey: qk.connectors, queryFn: api.connectors.status, enabled: !remote });
  const s = status.data;

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Claude Code & MCP"
        description="Let Claude Code, or any AI tool that speaks MCP, set Godmode up for you: create agents, give them automations, hand out tasks and check on their work. You say what you need in your terminal, and the team shows up here."
      />

      {remote ? (
        <Callout tone="muted">Connecting apps only works in Godmode on the computer itself.</Callout>
      ) : (
        <>
          <Hero onConnect={setDialog} loading={status.isLoading} connected={!!s?.connectors.some((c) => c.installed)} />

          <SettingsGroup
            title="Connected apps"
            icon={<Plug />}
            description="Each app has its own key. Removing an app cuts it off right away."
            actions={
              s?.connectors.length ? (
                <Button variant="outline" size="sm" onClick={() => setDialog("other")}>
                  <Plus /> Connect an app
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
              <p className="py-5 text-sm text-muted-foreground">No apps yet. Connect Claude Code to build your team from the terminal.</p>
            ) : (
              s.connectors.map((c) => <ConnectorRow key={c.id} connector={c} />)
            )}
          </SettingsGroup>

          {s && <ToolsGroup tools={s.tools} />}

          <Callout tone="muted" icon={<ShieldCheck className="text-muted-foreground" />} title="What stays with you">
            A connected app works as Godmode, your built-in agent, and inside its limits. It never sees a password or a 2FA code, only which
            logins exist, and it can't open settings, backups or files. It does see what agents were asked and what they answered. Agents it
            creates may use saved logins but not read them, and can't manage other agents or control this computer until you allow it. Every
            change is in the audit log under Security.
          </Callout>

          <ConnectAppDialog tab={dialog} onClose={() => setDialog(null)} claudeCode={s?.claudeCode ?? true} />
        </>
      )}
    </div>
  );
}

function Hero({ onConnect, loading, connected }: { onConnect: (tab: ConnectTab) => void; loading: boolean; connected: boolean }) {
  return (
    <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-col gap-6 p-6 @xl:flex-row @xl:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Godmode MCP server</p>
          <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">Build your team from the terminal.</h3>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            One click adds Godmode to Claude Code on this computer, for every project. Then ask for an agent the way you'd ask for a function.
          </p>
          <Button className="mt-5" onClick={() => onConnect("claude-code")} disabled={loading}>
            <SquareTerminal /> {connected ? "Connect Claude Code again" : "Connect Claude Code"}
          </Button>
          <p className="mt-2.5 text-xs text-muted-foreground">
            Cursor, Codex, Claude Desktop or a script?{" "}
            <button
              type="button"
              onClick={() => onConnect("other")}
              disabled={loading}
              className="rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Connect another app
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
          <span className="text-muted-foreground">&gt; </span>Create a Godmode agent that checks competitor pricing every Monday
        </p>
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-brand" />
          godmode · agent_create
        </p>
        <p className="rounded-md border bg-card px-2 py-1.5 font-sans text-xs text-foreground">
          Price Scout <span className="text-muted-foreground">· Research analyst · Mondays 09:00</span>
        </p>
      </div>
    </div>
  );
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.connectors.remove(connector.id),
    onSuccess: () => {
      toast.success(`${connector.name} removed`);
      void qc.invalidateQueries({ queryKey: qk.connectors });
    },
    onError: (e) => toastApiError(e, "Could not remove the app", qc),
  });
  const connected = `connected ${formatDistanceToNow(new Date(connector.createdAt), { addSuffix: true })}`;

  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4">{connector.client === "claude-code" ? <SquareTerminal /> : <Plug />}</div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <span className="truncate">{connector.name}</span>
          <Badge variant="outline" className={cn("font-normal", connector.access === "manage" ? "border-brand/25 bg-brand-soft text-brand-strong" : "text-muted-foreground")}>
            {connector.access === "manage" ? "Sets up and steers" : "Looks only"}
          </Badge>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {connector.lastUsedAt ? (
            <>
              Last used {formatDistanceToNow(new Date(connector.lastUsedAt), { addSuffix: true })}
              {connector.lastTool && (
                <>
                  {" for "}
                  <span className="font-mono text-[11px]">{connector.lastTool}</span>
                </>
              )}
              {` · ${connector.calls} ${connector.calls === 1 ? "call" : "calls"} · ${connected}`}
            </>
          ) : (
            `Not used yet · ${connected}`
          )}
        </p>
      </div>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${connector.name}`} onClick={() => setConfirm(true)}>
        {remove.isPending ? <Spinner /> : <Trash2 />}
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {connector.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its key stops working right away{connector.installed ? ", and Godmode takes itself out of Claude Code" : ""}. Agents and automations it created stay. You can connect
              it again with a new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              Remove
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
  const rest = [...tools];
  const groups = TOOL_GROUPS.map((g) => {
    const own = rest.filter((t) => g.match(t.name));
    for (const t of own) rest.splice(rest.indexOf(t), 1);
    return { ...g, tools: own };
  }).filter((g) => g.tools.length);

  return (
    <SettingsGroup
      title="What a connected app can do"
      icon={<SquareTerminal />}
      description={`${tools.length} tools, the same ones Godmode uses to run your team. A “Looks only” key gets the ones in grey.`}
    >
      {groups.map((g) => (
        <div key={g.title} className="flex flex-col gap-2.5 py-4 @xl:flex-row @xl:gap-6">
          <div className="flex min-w-0 gap-2.5 @xl:w-56 @xl:shrink-0">
            <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">{g.icon}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{g.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{g.about}</p>
            </div>
          </div>
          <ul className="flex min-w-0 flex-1 flex-wrap content-start gap-1.5">
            {g.tools.map((t) => (
              <li key={t.name}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      className={cn(
                        "inline-flex h-6 cursor-default items-center rounded-md border px-2 font-mono text-[11px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        t.access === "read" ? "bg-secondary/60 text-muted-foreground" : "bg-card text-foreground",
                      )}
                    >
                      {t.name}
                      {t.access === "read" && <span className="sr-only"> (only reads)</span>}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">{firstSentence(t.description)}</TooltipContent>
                </Tooltip>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </SettingsGroup>
  );
}

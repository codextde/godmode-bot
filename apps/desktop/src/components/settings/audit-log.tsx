import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { ChevronRight, Cpu, RefreshCw, ScrollText, UserRound } from "lucide-react";
import type { AuditEntry } from "@godmode/shared";
import { AgentAvatar, EmptyState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/api";
import { useAllAgents } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./settings-kit";

const COMMON_ACTIONS = ["credential.fill", "credential.reveal", "totp.fill", "totp.reveal", "vault.unlock", "vault.lock", "vault.passphrase", "backup.export", "backup.import"];

function actionTone(action: string): string {
  if (action.includes("reveal")) return "border-warning/40 bg-warning/10 text-warning";
  if (action.includes("delete") || action.includes("fail")) return "border-destructive/40 bg-destructive/10 text-destructive";
  if (action.endsWith(".fill")) return "border-primary/40 bg-primary/10 text-primary";
  if (action.startsWith("vault.")) return "border-border bg-muted text-muted-foreground";
  return "border-border bg-secondary text-secondary-foreground";
}

function Actor({ actor, agents }: { actor: string; agents: Map<string, { id: string; name: string; avatar: string; color: string }> }) {
  if (actor.startsWith("agent:")) {
    const agent = agents.get(actor.slice(6));
    return agent ? (
      <span className="flex min-w-0 items-center gap-2">
        <AgentAvatar agent={agent} size="sm" />
        <span className="truncate">{agent.name}</span>
      </span>
    ) : (
      <span className="font-mono text-xs text-muted-foreground">{actor}</span>
    );
  }
  if (actor === "user")
    return (
      <span className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-md bg-primary/15 text-primary">
          <UserRound className="size-3.5" />
        </span>
        You
      </span>
    );
  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      <span className="grid size-6 place-items-center rounded-md bg-muted">
        <Cpu className="size-3.5" />
      </span>
      {actor === "system" ? "System" : actor}
    </span>
  );
}

/** Every secret access and security-relevant action, newest first. */
export function AuditLog() {
  const [action, setAction] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [seenActions, setSeenActions] = useState<string[]>([]);
  const { data: agentList = [] } = useAllAgents();
  const agents = useMemo(() => new Map(agentList.map((a) => [a.id, a])), [agentList]);

  const query = useQuery({
    queryKey: [...qk.audit, action],
    queryFn: () => api.audit.list({ limit: 200, action: action === "all" ? undefined : action }),
  });

  useEffect(() => {
    const rows = query.data;
    if (rows?.length) setSeenActions((prev) => Array.from(new Set([...prev, ...rows.map((r) => r.action)])));
  }, [query.data]);

  const actions = useMemo(() => Array.from(new Set([...COMMON_ACTIONS, ...seenActions])).sort(), [seenActions]);

  return (
    <SettingsGroup
      title="Audit log"
      icon={<ScrollText />}
      description="Every time an agent or you uses a secret — and every vault event — is recorded here."
      bodyClassName="px-0"
      actions={
        <>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger size="sm" className="w-44" aria-label="Filter by action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              <SelectSeparator />
              {actions.map((a) => (
                <SelectItem key={a} value={a}>
                  <span className="font-mono text-xs">{a}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Refresh audit log" onClick={() => query.refetch()} disabled={query.isFetching}>
                <RefreshCw className={cn(query.isFetching && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </>
      }
    >
      {query.isLoading ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : query.isError ? (
        <div className="p-5 text-sm">
          <p className="font-medium text-destructive">Could not load the audit log</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(query.error)}</p>
        </div>
      ) : !query.data?.length ? (
        <div className="p-5">
          <EmptyState
            icon={<ScrollText />}
            title={action === "all" ? "Nothing recorded yet" : "No matching entries"}
            description={action === "all" ? "Secret fills, reveals and vault events will show up here." : `No “${action}” events in the recent log.`}
            className="py-10"
          />
        </div>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8 pl-5" />
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="pr-5">Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.map((row) => (
                <AuditRow
                  key={row.id}
                  row={row}
                  agents={agents}
                  open={expanded === row.id}
                  onToggle={() => setExpanded((e) => (e === row.id ? null : row.id))}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsGroup>
  );
}

function AuditRow({
  row,
  agents,
  open,
  onToggle,
}: {
  row: AuditEntry;
  agents: Map<string, { id: string; name: string; avatar: string; color: string }>;
  open: boolean;
  onToggle: () => void;
}) {
  const hasDetails = row.details && Object.keys(row.details).length > 0;
  const ts = new Date(row.ts);
  return (
    <Fragment>
      <TableRow
        className={cn(hasDetails && "cursor-pointer", open && "bg-muted/40")}
        onClick={hasDetails ? onToggle : undefined}
        aria-expanded={hasDetails ? open : undefined}
      >
        <TableCell className="pl-5">
          {hasDetails && <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />}
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground tabular-nums">{format(ts, "MMM d, HH:mm:ss")}</span>
            </TooltipTrigger>
            <TooltipContent>{formatDistanceToNow(ts, { addSuffix: true })}</TooltipContent>
          </Tooltip>
        </TableCell>
        <TableCell className="max-w-44">
          <Actor actor={row.actor} agents={agents} />
        </TableCell>
        <TableCell>
          <Badge variant="outline" className={cn("font-mono text-[11px] font-normal", actionTone(row.action))}>
            {row.action}
          </Badge>
        </TableCell>
        <TableCell className="max-w-56 truncate pr-5 text-xs text-muted-foreground">{row.target ?? "—"}</TableCell>
      </TableRow>
      {open && hasDetails && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell />
          <TableCell colSpan={4} className="pr-5">
            <pre className="max-h-48 overflow-auto rounded-lg border bg-background/60 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {JSON.stringify(row.details, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

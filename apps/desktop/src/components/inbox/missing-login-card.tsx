import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Archive, CircleAlert, Check, ExternalLink, KeyRound, RotateCcw, ShieldAlert, ShieldPlus, UserX, X } from "lucide-react";
import type { Agent, MissingLogin, MissingLoginKind, MissingLoginStatus } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/common";
import { Favicon } from "@/components/vault/favicon";
import { domainFromUrl, toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export const KIND_META: Record<MissingLoginKind, { label: string; icon: typeof KeyRound; className: string }> = {
  missing_credential: { label: "Missing login", icon: KeyRound, className: "bg-warning/12 text-warning" },
  invalid_credential: { label: "Login failed", icon: ShieldAlert, className: "bg-destructive/10 text-destructive" },
  missing_totp: { label: "Missing 2FA", icon: ShieldPlus, className: "bg-warning/12 text-warning" },
  missing_account: { label: "No account", icon: UserX, className: "bg-secondary text-foreground" },
  other: { label: "Needs attention", icon: CircleAlert, className: "bg-secondary text-muted-foreground" },
};

/** Status change with optimistic removal from the current tab's list. */
export function useMissingLoginStatus(currentStatus: MissingLoginStatus) {
  const qc = useQueryClient();
  const listKey = [...qk.missingLogins, currentStatus];
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: MissingLoginStatus }) => api.missingLogins.update(id, { status }),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<MissingLogin[]>(listKey);
      qc.setQueryData<MissingLogin[]>(listKey, (items) => items?.filter((m) => m.id !== id));
      return { previous };
    },
    onSuccess: (_res, { status }) => {
      const msg = status === "resolved" ? "Marked as resolved" : status === "dismissed" ? "Dismissed" : "Moved back to open";
      toast.success(msg);
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(listKey, ctx.previous);
      toastApiError(e, "Could not update the request", qc);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.missingLogins });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });
}

function isHttp(url: string) {
  return /^https?:\/\//i.test(url);
}

export function MissingLoginCard({
  item,
  agent,
  onStatus,
  pending,
}: {
  item: MissingLogin;
  agent: Agent | undefined;
  onStatus: (status: MissingLoginStatus) => void;
  pending: boolean;
}) {
  const navigate = useNavigate();
  const meta = KIND_META[item.kind] ?? KIND_META.other;
  const KindIcon = meta.icon;
  const domain = domainFromUrl(item.url);
  const when = (() => {
    try {
      return formatDistanceToNow(new Date(item.updatedAt || item.createdAt), { addSuffix: true });
    } catch {
      return "";
    }
  })();

  const addLogin = () => {
    const q = new URLSearchParams({ new: "1", domain, service: item.service, missingLoginId: item.id });
    navigate(`/vault/logins?${q.toString()}`);
  };
  const addTotp = () => navigate("/vault/2fa?import=1");

  const open = item.status === "open";
  const failed = item.kind === "invalid_credential";

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card p-4 shadow-card transition hover:shadow-float",
        open && (failed ? "border-destructive/25" : "border-warning/30"),
      )}
      aria-label={`${meta.label}: ${item.service}`}
    >
      {open && <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", failed ? "bg-destructive" : "bg-warning")} />}
      <div className="flex items-start gap-3.5">
        <Favicon domain={domain} name={item.service} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium tracking-[-0.01em]">{item.service || domain || "Unknown service"}</h3>
            <Badge variant="secondary" className={cn("h-5 gap-1 border-0 px-1.5 text-[11px]", meta.className)}>
              <KindIcon className="size-3" /> {meta.label}
            </Badge>
            {item.occurrences > 1 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="rounded-[5px] bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">×{item.occurrences}</span>
                </TooltipTrigger>
                <TooltipContent>Reported {item.occurrences} times</TooltipContent>
              </Tooltip>
            )}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{when}</span>
          </div>
          {item.url && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1">
              <span className="truncate font-mono text-xs text-muted-foreground" title={item.url}>
                {item.url}
              </span>
              {isHttp(item.url) && (
                <button
                  type="button"
                  onClick={() => void openExternal(item.url)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                  aria-label={`Open ${item.url} in your browser`}
                >
                  <ExternalLink className="size-3" />
                </button>
              )}
            </div>
          )}
          {item.reason && <p className="mt-2 text-sm leading-relaxed text-foreground/85">{item.reason}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {agent ? (
              <Link
                to={`/agents/${agent.id}`}
                className="mr-auto inline-flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-2 pl-0.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <AgentAvatar agent={agent} size="sm" mood={open ? "attention" : "idle"} />
                <span className="truncate">
                  Reported by <span className="font-medium text-foreground">{agent.name}</span>
                </span>
              </Link>
            ) : (
              <span className="mr-auto text-xs text-muted-foreground">{item.agentId ? "Reported by an agent" : "Reported by Godmode"}</span>
            )}

            {open ? (
              <>
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => onStatus("dismissed")} disabled={pending}>
                  <X /> Dismiss
                </Button>
                <Button size="sm" variant="outline" onClick={() => onStatus("resolved")} disabled={pending}>
                  <Check /> Mark resolved
                </Button>
                {item.kind === "missing_totp" ? (
                  <Button size="sm" onClick={addTotp}>
                    <ShieldPlus /> Add 2FA
                  </Button>
                ) : (
                  <Button size="sm" onClick={addLogin}>
                    <KeyRound /> {item.kind === "invalid_credential" ? "Update login" : "Add login"}
                  </Button>
                )}
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  {item.status === "resolved" ? <Check className="size-3.5 text-success" /> : <Archive className="size-3.5" />}
                  {item.status === "resolved" ? (item.credentialId ? "Resolved with a saved login" : "Resolved") : "Dismissed"}
                </span>
                <Button size="sm" variant="outline" onClick={() => onStatus("open")} disabled={pending}>
                  <RotateCcw /> Reopen
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

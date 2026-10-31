import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
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
import { useLocale } from "@/i18n/language";
import { LinkTotpDialog } from "./link-totp-dialog";

export const KIND_META = {
  missing_credential: { labelKey: "missingLogin.kinds.missingCredential", icon: KeyRound, className: "bg-warning/12 text-warning" },
  invalid_credential: { labelKey: "missingLogin.kinds.invalidCredential", icon: ShieldAlert, className: "bg-destructive/10 text-destructive" },
  missing_totp: { labelKey: "missingLogin.kinds.missingTotp", icon: ShieldPlus, className: "bg-warning/12 text-warning" },
  missing_account: { labelKey: "missingLogin.kinds.missingAccount", icon: UserX, className: "bg-secondary text-foreground" },
  other: { labelKey: "missingLogin.kinds.other", icon: CircleAlert, className: "bg-secondary text-muted-foreground" },
} as const satisfies Record<MissingLoginKind, { labelKey: string; icon: typeof KeyRound; className: string }>;

/** Status change with optimistic removal from the current tab's list. */
export function useMissingLoginStatus(currentStatus: MissingLoginStatus) {
  const { t } = useTranslation("inbox");
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
      const msg = status === "resolved" ? t("missingLogin.markedResolved") : status === "dismissed" ? t("missingLogin.dismissed") : t("missingLogin.reopened");
      toast.success(msg);
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(listKey, ctx.previous);
      toastApiError(e, t("missingLogin.updateError"), qc);
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
  autoOpenLink = false,
}: {
  item: MissingLogin;
  agent: Agent | undefined;
  onStatus: (status: MissingLoginStatus) => void;
  pending: boolean;
  autoOpenLink?: boolean;
}) {
  const { t } = useTranslation("inbox");
  const { dateLocale } = useLocale();
  const navigate = useNavigate();
  const [linkOpen, setLinkOpen] = useState(autoOpenLink && item.kind === "missing_totp" && item.status === "open");
  const meta = KIND_META[item.kind] ?? KIND_META.other;
  const KindIcon = meta.icon;
  const domain = domainFromUrl(item.url);
  const when = (() => {
    try {
      return formatDistanceToNow(new Date(item.updatedAt || item.createdAt), { addSuffix: true, locale: dateLocale });
    } catch {
      return "";
    }
  })();

  const addLogin = () => {
    const q = new URLSearchParams({ new: "1", domain, service: item.service, missingLoginId: item.id });
    navigate(`/vault/logins?${q.toString()}`);
  };

  const open = item.status === "open";
  const failed = item.kind === "invalid_credential";

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card p-4 shadow-card transition hover:shadow-float",
        open && (failed ? "border-destructive/25" : "border-warning/30"),
      )}
      aria-label={`${t(meta.labelKey)}: ${item.service}`}
    >
      {open && <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", failed ? "bg-destructive" : "bg-warning")} />}
      <div className="flex items-start gap-3.5">
        <Favicon domain={domain} name={item.service} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium tracking-[-0.01em]">{item.service || domain || t("missingLogin.unknownService")}</h3>
            <Badge variant="secondary" className={cn("h-5 gap-1 border-0 px-1.5 text-[11px]", meta.className)}>
              <KindIcon className="size-3" /> {t(meta.labelKey)}
            </Badge>
            {item.occurrences > 1 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="rounded-[5px] bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">×{item.occurrences}</span>
                </TooltipTrigger>
                <TooltipContent>{t("missingLogin.reportedTimes", { count: item.occurrences })}</TooltipContent>
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
                  aria-label={t("missingLogin.openInBrowser", { url: item.url })}
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
                  <Trans t={t} i18nKey="missingLogin.reportedBy" values={{ name: agent.name }} components={{ b: <span className="font-medium text-foreground" /> }} />
                </span>
              </Link>
            ) : (
              <span className="mr-auto text-xs text-muted-foreground">{item.agentId ? t("missingLogin.reportedByAgent") : t("missingLogin.reportedByGodmode")}</span>
            )}

            {open ? (
              <>
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => onStatus("dismissed")} disabled={pending}>
                  <X /> {t("missingLogin.dismiss")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onStatus("resolved")} disabled={pending}>
                  <Check /> {t("missingLogin.markResolved")}
                </Button>
                {item.kind === "missing_totp" ? (
                  <Button size="sm" onClick={() => setLinkOpen(true)}>
                    <ShieldPlus /> {t("missingLogin.add2fa")}
                  </Button>
                ) : (
                  <Button size="sm" onClick={addLogin}>
                    <KeyRound /> {item.kind === "invalid_credential" ? t("missingLogin.updateLogin") : t("missingLogin.addLogin")}
                  </Button>
                )}
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  {item.status === "resolved" ? <Check className="size-3.5 text-success" /> : <Archive className="size-3.5" />}
                  {item.status === "resolved" ? (item.credentialId ? t("missingLogin.resolvedWithLogin") : t("missingLogin.resolved")) : t("missingLogin.dismissed")}
                </span>
                <Button size="sm" variant="outline" onClick={() => onStatus("open")} disabled={pending}>
                  <RotateCcw /> {t("missingLogin.reopen")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
      {item.kind === "missing_totp" && <LinkTotpDialog item={item} open={linkOpen} onOpenChange={setLinkOpen} />}
    </article>
  );
}

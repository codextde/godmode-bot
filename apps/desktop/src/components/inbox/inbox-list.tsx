import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, GitMerge, Play, RotateCcw, X } from "lucide-react";
import type { Agent, AttentionItem, MissingLogin, Workspace } from "@godmode/shared";
import { mergesOnApprove } from "@godmode/shared";
import { ATTENTION_ICON } from "@/components/attention/attention-list";
import { AgentAvatar } from "@/components/common";
import { shortAge } from "@/components/human-tasks/human-task-card";
import { InboxQuestion } from "@/components/inbox/question-item";
import { KIND_META } from "@/components/inbox/missing-login-card";
import { INBOX_SECTIONS, actionOf, itemCopy, loginIdOf, sectionOf, type InboxSectionId } from "@/components/inbox/inbox-model";
import { useTicketActions } from "@/components/inbox/ticket-sheet";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Favicon } from "@/components/vault/favicon";
import { domainFromUrl } from "@/components/vault/vault-utils";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { api, errorMessage } from "@/lib/api";
import { useReduceAnimations } from "@/lib/motion";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

const QUIET = "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100";

export function InboxSections({
  items,
  agentById,
  loginById,
  workspaceOf,
  onOpen,
  onAct,
  onLoginStatus,
}: {
  items: AttentionItem[];
  agentById: Map<string, Agent>;
  loginById: Map<string, MissingLogin>;
  workspaceOf?: (item: AttentionItem) => Workspace | undefined;
  onOpen: (item: AttentionItem) => void;
  /** The row's main button; a login goes straight to adding it. */
  onAct: (item: AttentionItem) => void;
  onLoginStatus: (login: MissingLogin, status: "resolved" | "dismissed") => void;
}) {
  const { t } = useTranslation("inbox");
  const reduce = useReduceAnimations();
  const tickets = useTicketActions();
  const collapsed = useUi((s) => s.collapsedInboxSections);
  const toggle = useUi((s) => s.toggleInboxSection);
  const bySection = new Map<InboxSectionId, AttentionItem[]>();
  for (const item of items) {
    const id = sectionOf(item.kind);
    bySection.set(id, [...(bySection.get(id) ?? []), item]);
  }

  return (
    <div className="space-y-6">
      {INBOX_SECTIONS.filter((s) => bySection.has(s.id)).map((section) => {
        const rows = bySection.get(section.id)!;
        const open = !collapsed.includes(section.id);
        return (
          <section key={section.id} aria-label={t(`sections.${section.id}`)}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(section.id)}
              className="group/head mb-2 flex items-center gap-2 rounded-md py-0.5 pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="text-[13px] font-medium text-foreground">{t(`sections.${section.id}`)}</span>
              <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">{rows.length}</span>
              <ChevronDown className={cn("size-3.5 text-muted-foreground/70 transition-transform group-hover/head:text-foreground", !open && "-rotate-90")} aria-hidden />
            </button>
            {open &&
              (section.id === "question" ? (
                <div className="space-y-3">
                  {rows.map((item) => item.question && <InboxQuestion key={item.id} question={item.question} agent={agentById.get(item.question.agentId)} />)}
                </div>
              ) : (
                <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
                  <AnimatePresence initial={false}>
                    {rows.map((item) => {
                      const login = loginById.get(loginIdOf(item) ?? "");
                      return (
                        <motion.li
                          key={item.id}
                          layout={reduce ? false : "position"}
                          exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, transition: { duration: 0.18 } }}
                          className="group/row relative transition-colors focus-within:bg-foreground/[0.03] hover:bg-foreground/[0.03]"
                        >
                          <InboxRow
                            item={item}
                            login={login}
                            agent={item.agentId ? agentById.get(item.agentId) : undefined}
                            workspace={workspaceOf?.(item)}
                            onOpen={() => onOpen(item)}
                            onAct={() => onAct(item)}
                            quiet={
                              item.kind === "review" && item.task ? (
                                <ApproveButton merges={mergesOnApprove(item.task)} busy={tickets.approving === item.task.id} onClick={() => tickets.approve(item.task!)} />
                              ) : login ? (
                                <LoginQuiet onStatus={(status) => onLoginStatus(login, status)} />
                              ) : null
                            }
                          />
                        </motion.li>
                      );
                    })}
                  </AnimatePresence>
                </ul>
              ))}
          </section>
        );
      })}
    </div>
  );
}

function InboxRow({ item, login, agent, workspace, quiet, onOpen, onAct }: { item: AttentionItem; login?: MissingLogin; agent?: Agent; workspace?: Workspace; quiet?: ReactNode; onOpen: () => void; onAct: () => void }) {
  const { t } = useTranslation("inbox");
  const Icon = ATTENTION_ICON[item.kind];
  const copy = itemCopy(item, login);
  const kind = login ? (KIND_META[login.kind] ?? KIND_META.other) : null;
  const action = actionOf(item, login);
  return (
    <div className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">
      <span className="relative shrink-0">
        {login ? (
          <Favicon domain={domainFromUrl(login.url)} name={login.service} size="sm" className="size-7" />
        ) : agent ? (
          <AgentAvatar agent={agent} size="sm" still className="size-7 rounded-lg" />
        ) : (
          <span className="grid size-7 place-items-center rounded-lg border bg-secondary text-foreground/70">
            <Icon className="size-3.5" aria-hidden />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-baseline gap-1.5 text-left text-[13.5px] font-medium tracking-[-0.005em] outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
          title={copy.title}
        >
          {copy.ref && <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground tabular-nums">{copy.ref}</span>}
          <span className="truncate">{copy.title}</span>
        </button>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {kind && <span className={cn("shrink-0 rounded-[4px] px-1 text-[11px] font-medium", kind.className)}>{t(kind.labelKey)}</span>}
          {workspace && (
            <span className="inline-flex shrink-0 items-center gap-1 text-foreground/70">
              <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" className="size-3.5 rounded-[4px] text-[8px]" />
              {workspace.name}
            </span>
          )}
          {agent && (
            <span className="shrink-0">
              {workspace && <span className="mr-1.5 text-muted-foreground/50">·</span>}
              {agent.name}
            </span>
          )}
          {copy.detail && (
            <span className="truncate" title={copy.detail}>
              {(workspace || agent) && <span className="mr-1.5 text-muted-foreground/50">·</span>}
              {copy.detail}
            </span>
          )}
        </div>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1.5">
        {quiet}
        <time dateTime={item.since} className="w-8 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {shortAge(item.since)}
        </time>
        {item.kind === "paused" && item.conversationId ? (
          <ResumeButton conversationId={item.conversationId} />
        ) : (
          <Button size="xs" variant="outline" className="min-w-16" onClick={onAct}>
            {t(`actions.${action}`)}
          </Button>
        )}
      </div>
    </div>
  );
}

function ApproveButton({ merges, busy, onClick }: { merges: boolean; busy: boolean; onClick: () => void }) {
  const { t } = useTranslation("inbox");
  return (
    <Button size="xs" variant="ghost" disabled={busy} onClick={onClick} className={cn("text-muted-foreground hover:text-foreground", !busy && QUIET)}>
      {busy ? <Spinner /> : merges ? <GitMerge /> : <Check />} {merges ? t("actions.approveMerge") : t("actions.approve")}
    </Button>
  );
}

function LoginQuiet({ onStatus }: { onStatus: (status: "resolved" | "dismissed") => void }) {
  const { t } = useTranslation("inbox");
  return (
    <span className={cn("flex items-center", QUIET)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" className="size-7 text-muted-foreground" aria-label={t("missingLogin.dismiss")} onClick={() => onStatus("dismissed")}>
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("missingLogin.dismiss")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" className="size-7 text-muted-foreground" aria-label={t("missingLogin.markResolved")} onClick={() => onStatus("resolved")}>
            <Check />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("missingLogin.markResolved")}</TooltipContent>
      </Tooltip>
    </span>
  );
}

function ResumeButton({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation(["inbox", "attention"]);
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => api.conversations.continue(conversationId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (err) => toast.error(t("attention:list.continueError"), { description: errorMessage(err) }),
  });
  return (
    <Button size="xs" variant="outline" className="min-w-16" disabled={resume.isPending} onClick={() => resume.mutate()}>
      {resume.isPending ? <Spinner /> : <Play className="fill-current" />} {t("attention:list.continue")}
    </Button>
  );
}

/** A login of the Resolved or Dismissed tab: one line and the way back. */
export function ClosedLoginRow({ login, agent, pending, onReopen, onOpen }: { login: MissingLogin; agent?: Agent; pending: boolean; onReopen: () => void; onOpen: () => void }) {
  const { t } = useTranslation("inbox");
  const kind = KIND_META[login.kind] ?? KIND_META.other;
  return (
    <div className="group/row relative flex min-w-0 items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-foreground/[0.03]">
      <Favicon domain={domainFromUrl(login.url)} name={login.service} size="sm" className="size-7 shrink-0" />
      <div className="min-w-0 flex-1 leading-snug">
        <button type="button" onClick={onOpen} className="block w-full truncate text-left text-[13.5px] font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset">
          {login.service || t("missingLogin.unknownService")}
        </button>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">{t(kind.labelKey)}</span>
          {agent && <span className="truncate">· {agent.name}</span>}
        </p>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1.5">
        <time dateTime={login.updatedAt} className="w-8 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {shortAge(login.updatedAt)}
        </time>
        <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={onReopen}>
          <RotateCcw /> {t("missingLogin.reopen")}
        </Button>
      </div>
    </div>
  );
}

export function useOpenAttention(handlers: { todo: (item: AttentionItem) => void; ticket: (item: AttentionItem) => void; sheet: (item: AttentionItem) => void }) {
  const navigate = useNavigate();
  return (item: AttentionItem) => {
    if (item.kind === "todo" && item.humanTask) handlers.todo(item);
    else if ((item.kind === "review" || item.kind === "blocked") && item.task) handlers.ticket(item);
    else if ((item.kind === "question" && item.question) || item.kind === "login") handlers.sheet(item);
    else void navigate(item.link);
  };
}


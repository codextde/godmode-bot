import type { Agent, AttentionItem, MissingLogin, Workspace } from "@godmode/shared";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/common";
import { ATTENTION_ICON } from "@/components/attention/attention-list";
import { shortAge } from "@/components/human-tasks/human-task-card";
import { itemCopy } from "@/components/inbox/inbox-model";
import { Favicon } from "@/components/vault/favicon";
import { domainFromUrl } from "@/components/vault/vault-utils";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { cn } from "@/lib/utils";

const TONE: Partial<Record<AttentionItem["kind"], string>> = {
  review: "text-brand-strong",
  question: "text-warning",
  login: "text-warning",
  blocked: "text-rose-600 dark:text-rose-400",
  failed: "text-destructive",
  automation: "text-destructive",
};

/** A card on the board for what waits for the human but isn't a to-do of theirs: a ticket to review, a login to add. Opens, doesn't drag. */
export function AttentionCard({ item, agent, workspace, login, onOpen }: { item: AttentionItem; agent?: Agent; workspace?: Workspace; login?: MissingLogin; onOpen: () => void }) {
  const { t } = useTranslation("inbox");
  const Icon = ATTENTION_ICON[item.kind];
  const copy = itemCopy(item, login);
  const domain = login ? domainFromUrl(login.url) : "";
  return (
    <article className="relative rounded-lg border bg-card p-3 text-left shadow-card transition-[border-color,box-shadow] duration-150 focus-within:border-foreground/25 hover:border-foreground/20">
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className={cn("flex min-w-0 items-center gap-1 font-medium", TONE[item.kind])}>
          <Icon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{t(`kinds.${item.kind}`)}</span>
        </span>
        {copy.ref && <span className="font-mono tabular-nums">{copy.ref}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {workspace && (
            <span title={workspace.name}>
              <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" className="size-3.5 rounded-[4px] text-[8px]" />
            </span>
          )}
          <time dateTime={item.since} className="font-mono text-[11px] tabular-nums">
            {shortAge(item.since)}
          </time>
        </span>
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-1.5 block w-full cursor-pointer text-left text-[13.5px] leading-snug font-medium tracking-[-0.01em] text-foreground outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
      >
        <span className="line-clamp-3">{copy.title}</span>
      </button>
      {copy.detail && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{copy.detail}</p>}

      <div className="mt-3 flex items-center text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-foreground/80">
          {login ? (
            <Favicon domain={domain} name={login.service} size="xs" />
          ) : agent ? (
            <AgentAvatar agent={agent} size="sm" still className="size-5 rounded-[5px] text-[11px]" />
          ) : null}
          <span className="truncate">{agent?.name ?? ""}</span>
        </span>
      </div>
    </article>
  );
}

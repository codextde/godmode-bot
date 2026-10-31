import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Conversation, ConversationWithMessages } from "@godmode/shared";
import { Archive, ArchiveRestore, AudioLines, ChevronRight, Cpu, Ellipsis, HeartPulse, Laptop, Moon, Pencil, Pin, PinOff, Share2, SquareKanban, Trash2, Plug, Workflow, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { AgentAvatar } from "@/components/common";
import type { AgentMood } from "@/components/chat/conversation-mood";
import { PLATFORMS } from "@/components/messaging/platform";
import { DeleteChatDialog, useArchiveChat } from "@/components/chat/chat-actions";
import { PrivateChatBadge } from "@/components/chat/private-chat";
import { useEffectiveModel } from "@/components/chat/model-picker";
import { useModelLabel } from "@/components/runs/run-status";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents } from "@/lib/hooks";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { AnimatedTitle } from "@/components/chat/animated-title";

const ORIGIN_META = {
  routine: { label: "header.origin.routine", icon: Workflow },
  delegation: { label: "header.origin.delegation", icon: Share2 },
  api: { label: "header.origin.api", icon: Plug },
  dream: { label: "header.origin.dream", icon: Moon },
  slack: { name: "Slack", icon: PLATFORMS.slack.glyph },
  telegram: { name: "Telegram", icon: PLATFORMS.telegram.glyph },
  teams: { name: "Teams", icon: PLATFORMS.teams.glyph },
  task: { label: "header.origin.task", icon: SquareKanban },
  heartbeat: { label: "header.origin.heartbeat", icon: HeartPulse },
} as const;

export function ConversationHeader({
  conversation,
  agent,
  mood,
  onVoiceMode,
  browserToggle,
  move,
}: {
  conversation: Conversation;
  agent?: Agent;
  /** The agent's live mood in this chat (its character reacts; the label shows next to its name). */
  mood?: AgentMood;
  onVoiceMode?: () => void;
  browserToggle?: ReactNode;
  /** A runner's chat: move it to this computer, unless `blocked` says why not now. */
  move?: { onSelect: () => void; blocked: string | null; label?: string };
}) {
  const { t } = useTranslation(["chat", "common"]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const modelLabel = useModelLabel();
  const { isMobile, state } = useSidebar();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const id = conversation.id;

  const update = useMutation({
    mutationFn: (input: { title?: string; pinned?: boolean }) => api.conversations.update(id, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.conversation(id) });
      const prev = qc.getQueryData<ConversationWithMessages>(qk.conversation(id));
      if (prev) qc.setQueryData<ConversationWithMessages>(qk.conversation(id), { ...prev, ...input });
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.conversation(id), ctx.prev);
      toast.error(t("header.updateError"), { description: errorMessage(err) });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
  });

  const { setArchived } = useArchiveChat();

  const origin = conversation.origin !== "chat" && conversation.origin !== "api" ? ORIGIN_META[conversation.origin] : null;
  const originLabel = origin ? ("name" in origin ? origin.name : t(origin.label)) : "";
  const { data: allAgents = [] } = useAllAgents();
  const from = conversation.delegatedFrom ? allAgents.find((a) => a.id === conversation.delegatedFrom!.agentId) : undefined;

  // What this chat overrides. Ultracode only counts with a model that can run it, as in the model picker.
  const { current } = useEffectiveModel(agent, { model: conversation.model ?? null, effort: conversation.effort ?? null, ultracode: conversation.ultracode ?? null });
  const overrides = [
    conversation.model && modelLabel(conversation.model),
    conversation.effort && t(`effort.${conversation.effort}`),
    conversation.ultracode != null && (conversation.ultracode ? current.ultracode && "Ultracode" : t("header.ultracodeOff")),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <header
      data-titlebar
      data-tauri-drag-region
      className={cn(
        "relative z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 @xl:px-4",
        isTauri && isMac && !isMobile && state === "collapsed" && "pl-12 @xl:pl-12",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {agent ? (
          <Link
            to={`/agents/${agent.id}`}
            className="flex shrink-0 items-center gap-2 rounded-lg py-1 pr-1.5 pl-1 text-sm font-medium transition hover:bg-accent/50"
            aria-label={t("header.openAgent", { name: agent.name })}
          >
            <AgentAvatar agent={agent} size="sm" mood={mood?.mood} className="size-7" />
            <span className="hidden min-w-0 flex-col leading-tight @2xl:flex">
              <span className="max-w-[10rem] truncate">{agent.name}</span>
              {mood?.label ? (
                <span
                  aria-live="polite"
                  className={cn(
                    "max-w-[10rem] truncate text-[11px] font-normal text-muted-foreground",
                    (mood.mood === "thinking" || mood.mood === "working") && "text-shimmer",
                    mood.mood === "attention" && "font-medium text-warning",
                    mood.mood === "error" && "text-destructive",
                  )}
                >
                  {mood.label}
                </span>
              ) : (
                agent.role && <span className="max-w-[10rem] truncate text-[11px] font-normal text-muted-foreground">{agent.role}</span>
              )}
            </span>
          </Link>
        ) : (
          <span className="size-6 shrink-0 animate-pulse rounded-md bg-muted" />
        )}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
        <EditableTitle
          value={conversation.title}
          editing={editing}
          setEditing={setEditing}
          onSave={(title) => title !== conversation.title && update.mutate({ title })}
        />
        {from && conversation.delegatedFrom ? (
          // Who handed this over, back to the chat that asked (or the agent, when that chat is gone).
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to={conversation.delegatedFrom.conversationId ? `/chat/${conversation.delegatedFrom.conversationId}` : `/agents/${from.id}`}
                aria-label={
                  conversation.delegatedFrom.conversationId
                    ? t("header.handedOverByOpenChat", { name: from.name })
                    : t("header.handedOverByOpenAgent", { name: from.name })
                }
                className="inline-flex max-w-[11rem] shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground"
              >
                <AgentAvatar agent={from} size="sm" still className="size-3.5 rounded-[3px] text-[8px]" />
                <span className="truncate">{t("header.from", { name: from.name })}</span>
              </Link>
            </TooltipTrigger>
            <TooltipContent>{conversation.delegatedFrom.conversationId ? t("header.handedOverHint", { name: from.name }) : t("header.sourceDeleted")}</TooltipContent>
          </Tooltip>
        ) : origin && (conversation.origin === "routine" || conversation.origin === "heartbeat") && agent ? (
          <Link
            to={`/agents/${agent.id}/${conversation.origin === "heartbeat" ? "heartbeat" : "routines"}`}
            className="hidden shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground @xl:inline-flex"
          >
            <origin.icon className="size-3" /> {originLabel}
          </Link>
        ) : (
          origin && (
            <span className="hidden shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground @xl:inline-flex">
              <origin.icon className="size-3" /> {originLabel}
            </span>
          )
        )}
        {overrides && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hidden shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground @xl:inline-flex">
                <Cpu className="size-3" />
                {overrides}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("header.overridesHint")}</TooltipContent>
          </Tooltip>
        )}
        {conversation.private && <PrivateChatBadge />}
        {conversation.archived && (
          <Link
            to="/archived"
            className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:text-foreground"
          >
            <Archive className="size-3" /> {t("header.archived")}
          </Link>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {browserToggle}
        {!conversation.private && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={conversation.pinned ? t("header.unpinChat") : t("header.pinChat")}
                aria-pressed={conversation.pinned}
                onClick={() => update.mutate({ pinned: !conversation.pinned })}
                className={cn("text-muted-foreground", conversation.pinned && "text-foreground")}
              >
                <Pin className={cn(conversation.pinned && "fill-current")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{conversation.pinned ? t("header.unpin") : t("header.pinToSidebar")}</TooltipContent>
          </Tooltip>
        )}
        {onVoiceMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("header.voiceMode")} onClick={onVoiceMode} className="text-muted-foreground">
                <AudioLines />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("header.voiceMode")}</TooltipContent>
          </Tooltip>
        )}
        {conversation.private ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={t("header.endPrivate")} className="gap-1 text-muted-foreground" onClick={() => navigate("/")}>
                <X /> {t("header.end")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("header.endHint")}</TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("header.moreActions")} className="text-muted-foreground">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <Pencil /> {t("common:actions.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => update.mutate({ pinned: !conversation.pinned })}>
                {conversation.pinned ? <PinOff /> : <Pin />} {conversation.pinned ? t("header.unpin") : t("header.pin")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setArchived(conversation, !conversation.archived)}>
                {conversation.archived ? <ArchiveRestore /> : <Archive />} {conversation.archived ? t("header.unarchive") : t("header.archive")}
              </DropdownMenuItem>
              {move && (
                <DropdownMenuItem disabled={!!move.blocked} title={move.blocked ?? undefined} onClick={move.onSelect}>
                  <Laptop /> {move.label ?? (isMac ? t("header.moveToMac") : t("header.moveToComputer"))}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> {t("common:actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <DeleteChatDialog
        chat={conversation}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        onDeleted={() => navigate("/", { replace: true })}
      />
    </header>
  );
}

function EditableTitle({
  value,
  editing,
  setEditing,
  onSave,
}: {
  value: string;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onSave: (title: string) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, value]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={t("common:actions.rename")}
        className="min-w-0 truncate rounded-md px-1.5 py-1 text-left text-sm font-medium transition hover:bg-accent/50"
      >
        <AnimatedTitle text={value || t("header.newChat")} />
      </button>
    );
  }

  const commit = () => {
    const title = draft.trim();
    setEditing(false);
    if (title) onSave(title);
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label={t("header.chatTitle")}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
        }
      }}
      className="h-8 w-full max-w-md min-w-0 rounded-md border bg-card px-2 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    />
  );
}

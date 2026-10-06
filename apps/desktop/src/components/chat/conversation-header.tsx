import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Conversation, ConversationWithMessages } from "@godmode/shared";
import { EFFORT_LABELS } from "@godmode/shared";
import { Archive, ArchiveRestore, AudioLines, ChevronRight, Cpu, Ellipsis, HeartPulse, Moon, Pencil, Pin, PinOff, Share2, SquareKanban, Trash2, Plug, Workflow } from "lucide-react";
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
import { useEffectiveModel } from "@/components/chat/model-picker";
import { useModelLabel } from "@/components/runs/run-status";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents } from "@/lib/hooks";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { cn } from "@/lib/utils";

const ORIGIN_META = {
  routine: { label: "Automation", icon: Workflow },
  delegation: { label: "Handed over", icon: Share2 },
  api: { label: "Chat", icon: Plug },
  dream: { label: "Dreams", icon: Moon },
  slack: { label: "Slack", icon: PLATFORMS.slack.glyph },
  telegram: { label: "Telegram", icon: PLATFORMS.telegram.glyph },
  teams: { label: "Teams", icon: PLATFORMS.teams.glyph },
  task: { label: "Task", icon: SquareKanban },
  heartbeat: { label: "Heartbeat", icon: HeartPulse },
} as const;

export function ConversationHeader({
  conversation,
  agent,
  mood,
  onVoiceMode,
  browserToggle,
}: {
  conversation: Conversation;
  agent?: Agent;
  /** The agent's live mood in this chat (its character reacts; the label shows next to its name). */
  mood?: AgentMood;
  onVoiceMode?: () => void;
  browserToggle?: ReactNode;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const modelLabel = useModelLabel();
  const { isMobile } = useSidebar();
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
      toast.error("Couldn't update the chat", { description: errorMessage(err) });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
  });

  const { setArchived } = useArchiveChat();

  const origin = conversation.origin !== "chat" && conversation.origin !== "api" ? ORIGIN_META[conversation.origin] : null;
  const { data: allAgents = [] } = useAllAgents();
  const from = conversation.delegatedFrom ? allAgents.find((a) => a.id === conversation.delegatedFrom!.agentId) : undefined;

  // What this chat overrides. Ultracode only counts with a model that can run it, as in the model picker.
  const { current } = useEffectiveModel(agent, { model: conversation.model ?? null, effort: conversation.effort ?? null, ultracode: conversation.ultracode ?? null });
  const overrides = [
    conversation.model && modelLabel(conversation.model),
    conversation.effort && EFFORT_LABELS[conversation.effort],
    conversation.ultracode != null && (conversation.ultracode ? current.ultracode && "Ultracode" : "Ultracode off"),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <header
      className={cn(
        "relative z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 @xl:px-4",
        isTauri && isMac && !isMobile && "h-auto pt-7 pb-2",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {agent ? (
          <Link
            to={`/agents/${agent.id}`}
            className="flex shrink-0 items-center gap-2 rounded-lg py-1 pr-1.5 pl-1 text-sm font-medium transition hover:bg-accent/50"
            aria-label={`Open ${agent.name}`}
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
                aria-label={`Handed over by ${from.name} — open ${conversation.delegatedFrom.conversationId ? "that chat" : from.name}`}
                className="inline-flex max-w-[11rem] shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground"
              >
                <AgentAvatar agent={from} size="sm" still className="size-3.5 rounded-[3px] text-[8px]" />
                <span className="truncate">From {from.name}</span>
              </Link>
            </TooltipTrigger>
            <TooltipContent>{conversation.delegatedFrom.conversationId ? `${from.name} handed this over — open the chat it came from` : "The chat this came from was deleted"}</TooltipContent>
          </Tooltip>
        ) : origin && (conversation.origin === "routine" || conversation.origin === "heartbeat") && agent ? (
          <Link
            to={`/agents/${agent.id}/${conversation.origin === "heartbeat" ? "heartbeat" : "routines"}`}
            className="hidden shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground @xl:inline-flex"
          >
            <origin.icon className="size-3" /> {origin.label}
          </Link>
        ) : (
          origin && (
            <span className="hidden shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground @xl:inline-flex">
              <origin.icon className="size-3" /> {origin.label}
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
            <TooltipContent>Model, effort and Ultracode set for this chat — in the model picker or with /model and /effort</TooltipContent>
          </Tooltip>
        )}
        {conversation.archived && (
          <Link
            to="/archived"
            className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:text-foreground"
          >
            <Archive className="size-3" /> Archived
          </Link>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {browserToggle}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={conversation.pinned ? "Unpin chat" : "Pin chat"}
              aria-pressed={conversation.pinned}
              onClick={() => update.mutate({ pinned: !conversation.pinned })}
              className={cn("text-muted-foreground", conversation.pinned && "text-foreground")}
            >
              <Pin className={cn(conversation.pinned && "fill-current")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{conversation.pinned ? "Unpin" : "Pin to sidebar"}</TooltipContent>
        </Tooltip>
        {onVoiceMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Voice mode" onClick={onVoiceMode} className="text-muted-foreground">
                <AudioLines />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Voice mode</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions" className="text-muted-foreground">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => update.mutate({ pinned: !conversation.pinned })}>
              {conversation.pinned ? <PinOff /> : <Pin />} {conversation.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setArchived(conversation, !conversation.archived)}>
              {conversation.archived ? <ArchiveRestore /> : <Archive />} {conversation.archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
        title="Rename"
        className="min-w-0 truncate rounded-md px-1.5 py-1 text-left text-sm font-medium transition hover:bg-accent/50"
      >
        {value || "New chat"}
      </button>
    );
  }

  const commit = () => {
    const t = draft.trim();
    setEditing(false);
    if (t) onSave(t);
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label="Chat title"
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

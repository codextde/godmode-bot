import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Conversation, ConversationWithMessages } from "@godmode/shared";
import { Archive, ArchiveRestore, AudioLines, CalendarClock, ChevronRight, Ellipsis, Pencil, Pin, PinOff, Share2, Trash2, Plug } from "lucide-react";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { cn } from "@/lib/utils";

const ORIGIN_META = {
  routine: { label: "Routine", icon: CalendarClock },
  delegation: { label: "Delegated", icon: Share2 },
  api: { label: "API", icon: Plug },
} as const;

export function ConversationHeader({
  conversation,
  agent,
  onVoiceMode,
}: {
  conversation: Conversation;
  agent?: Agent;
  onVoiceMode?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const id = conversation.id;

  const update = useMutation({
    mutationFn: (input: { title?: string; pinned?: boolean; archived?: boolean }) => api.conversations.update(id, input),
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

  const remove = useMutation({
    mutationFn: () => api.conversations.delete(id),
    onSuccess: () => {
      toast.success("Chat deleted");
      qc.removeQueries({ queryKey: qk.conversation(id) });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate("/", { replace: true });
    },
    onError: (err) => toast.error("Couldn't delete the chat", { description: errorMessage(err) }),
  });

  const toggleArchive = () => {
    const archived = !conversation.archived;
    update.mutate(
      { archived },
      {
        onSuccess: () =>
          toast.success(archived ? "Chat archived" : "Chat restored", {
            action: archived ? { label: "Undo", onClick: () => update.mutate({ archived: false }) } : undefined,
          }),
      },
    );
  };

  const origin = conversation.origin !== "chat" ? ORIGIN_META[conversation.origin] : null;

  return (
    <header
      className={cn(
        "relative z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4",
        isTauri && isMac && "h-auto pt-7 pb-2",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {agent ? (
          <Link
            to={`/agents/${agent.id}`}
            className="flex shrink-0 items-center gap-2 rounded-lg py-1 pr-1.5 pl-1 text-sm font-medium transition hover:bg-accent/50"
            aria-label={`Open ${agent.name}`}
          >
            <AgentAvatar agent={agent} size="sm" />
            <span className="hidden max-w-[10rem] truncate md:inline">{agent.name}</span>
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
        {origin && (
          <span className="hidden shrink-0 items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline-flex">
            <origin.icon className="size-3" /> {origin.label}
          </span>
        )}
        {conversation.archived && (
          <span className="shrink-0 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground">Archived</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
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
            <DropdownMenuItem onClick={toggleArchive}>
              {conversation.archived ? <ArchiveRestore /> : <Archive />} {conversation.archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              “{conversation.title || "New chat"}” and its messages will be removed. The agent keeps its memory and the transcript in its history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate()}
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={remove.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

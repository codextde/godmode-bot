import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Conversation, ConversationWithMessages } from "@godmode/shared";
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
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

type ChatRef = Pick<Conversation, "id" | "title">;

interface ArchiveVars {
  chat: ChatRef;
  archived: boolean;
  undo?: boolean;
}

/** Archive or restore a chat. It leaves its list right away; the toast offers undo. */
export function useArchiveChat() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ chat, archived }: ArchiveVars) => api.conversations.update(chat.id, { archived }),
    onMutate: async ({ chat, archived }) => {
      const leaving = archived ? qk.conversationLists : qk.archivedConversationLists;
      await Promise.all([qc.cancelQueries({ queryKey: leaving }), qc.cancelQueries({ queryKey: qk.conversation(chat.id) })]);
      const snapshot = qc.getQueriesData<Conversation[]>({ queryKey: leaving });
      qc.setQueriesData<Conversation[]>({ queryKey: leaving }, (list) => list?.filter((c) => c.id !== chat.id));
      qc.setQueryData<ConversationWithMessages>(qk.conversation(chat.id), (c) => (c ? { ...c, archived } : c));
      return { snapshot };
    },
    onError: (err, { chat, archived }, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
      qc.setQueryData<ConversationWithMessages>(qk.conversation(chat.id), (c) => (c ? { ...c, archived: !archived } : c));
      toast.error(archived ? "Couldn't archive the chat" : "Couldn't restore the chat", { description: errorMessage(err) });
    },
    onSuccess: (_res, { chat, archived, undo }) => {
      if (undo) return;
      toast.success(archived ? "Chat archived" : "Chat restored", {
        description: chat.title || "New chat",
        action: { label: "Undo", onClick: () => mutation.mutate({ chat, archived: !archived, undo: true }) },
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.conversationsAll }),
  });

  return { setArchived: (chat: ChatRef, archived: boolean) => mutation.mutate({ chat, archived }) };
}

/** Ask before deleting a chat for good; render `deleteDialog` once and call `askDelete` from any row. */
export function useDeleteChat(onDeleted?: (id: string) => void) {
  const [chat, setChat] = useState<ChatRef | null>(null);
  const [open, setOpen] = useState(false);
  return {
    askDelete: (c: ChatRef) => {
      setChat(c);
      setOpen(true);
    },
    deleteDialog: <DeleteChatDialog chat={chat} open={open} onOpenChange={setOpen} onDeleted={onDeleted} />,
  };
}

export function DeleteChatDialog({
  chat,
  open,
  onOpenChange,
  onDeleted,
}: {
  chat: ChatRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (chat: ChatRef) => api.conversations.delete(chat.id),
    onMutate: async (chat) => {
      const lists = [qk.conversationLists, qk.archivedConversationLists];
      await Promise.all(lists.map((queryKey) => qc.cancelQueries({ queryKey })));
      const snapshot = lists.flatMap((queryKey) => qc.getQueriesData<Conversation[]>({ queryKey }));
      for (const queryKey of lists) qc.setQueriesData<Conversation[]>({ queryKey }, (list) => list?.filter((c) => c.id !== chat.id));
      return { snapshot };
    },
    onSuccess: (_res, chat) => {
      toast.success("Chat deleted", { description: chat.title || "New chat" });
      onDeleted?.(chat.id);
      qc.removeQueries({ queryKey: qk.conversation(chat.id) });
    },
    onError: (err, _chat, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
      toast.error("Couldn't delete the chat", { description: errorMessage(err) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.conversationsAll }),
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            “{chat?.title || "New chat"}” and its messages will be removed. The agent keeps its memory and the transcript in its history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => chat && remove.mutate(chat)} disabled={remove.isPending && remove.variables?.id === chat?.id}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

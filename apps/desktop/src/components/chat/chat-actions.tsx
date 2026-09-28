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

export function DeleteChatDialog({
  chat,
  open,
  onOpenChange,
  onDeleted,
}: {
  chat: ChatRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api.conversations.delete(id),
    onSuccess: (_res, id) => {
      toast.success("Chat deleted");
      qc.removeQueries({ queryKey: qk.conversation(id) });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      onDeleted?.();
    },
    onError: (err) => toast.error("Couldn't delete the chat", { description: errorMessage(err) }),
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
          <AlertDialogAction
            onClick={() => chat && remove.mutate(chat.id)}
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={remove.isPending}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

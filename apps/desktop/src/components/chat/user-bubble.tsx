import type { Attachment } from "@godmode/shared";
import { cn } from "@/lib/utils";
import { AttachmentImages, isShownPicture } from "./attachment-images";
import { AttachmentList } from "./attachments";
import { useChatScope } from "./local-files";
import { CommandText } from "./slash-commands";

/** What the human wrote, right-aligned: in the thread, and inside a turn where the agent picked a queued message up. */
export function UserBubble({
  content,
  attachments,
  dim,
}: {
  content: string;
  attachments: (Pick<Attachment, "name" | "mime" | "size"> & { path?: string })[];
  dim?: boolean;
}) {
  const { conversationId } = useChatScope();
  const pictures = attachments.filter((a) => isShownPicture(a, conversationId));
  const others = attachments.filter((a) => !isShownPicture(a, conversationId));
  return (
    <>
      {pictures.length > 0 && conversationId && <AttachmentImages files={pictures} conversationId={conversationId} className={cn("mb-1.5 max-w-[85%]", dim && "opacity-70")} />}
      {others.length > 0 && <AttachmentList files={others} className="mb-1.5 max-w-[85%] justify-end" />}
      {content && (
        <div
          className={cn(
            "max-w-[85%] rounded-2xl rounded-br-[6px] border border-foreground/[0.05] bg-secondary px-4 py-2.5 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap",
            dim && "opacity-70",
          )}
        >
          <CommandText text={content} />
        </div>
      )}
    </>
  );
}

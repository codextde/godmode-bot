import type { Attachment } from "@godmode/shared";
import { cn } from "@/lib/utils";
import { AttachmentChip } from "./attachments";
import { CommandText } from "./slash-commands";

/** What the human wrote, right-aligned: in the thread, and inside a turn where the agent picked a queued message up. */
export function UserBubble({ content, attachments, dim }: { content: string; attachments: Pick<Attachment, "name" | "mime" | "size">[]; dim?: boolean }) {
  return (
    <>
      {attachments.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {attachments.map((a, i) => (
            <AttachmentChip key={`${a.name}-${i}`} name={a.name} mime={a.mime} size={a.size} />
          ))}
        </div>
      )}
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

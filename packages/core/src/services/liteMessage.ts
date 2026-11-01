import type { Message } from "@godmode/shared";

/** How much of a tool's output a light message keeps: the phone shows its first lines. */
const LITE_RESULT_CHARS = 6000;

export function messageImagePath(conversationId: string, messageId: string, toolUseId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/images/${encodeURIComponent(toolUseId)}`;
}

/**
 * A message for a slow link: each screenshot becomes its own request (`imageUrl`) and long tool output is cut. With
 * `cutResults` false only the screenshots go (the desktop app, which shows tool output in full).
 */
export function liteMessage(message: Message, cutResults = true): Message {
  let changed = false;
  const blocks = message.blocks.map((b) => {
    const long = cutResults && (b.type === "tool_use" ? (b.result?.length ?? 0) > LITE_RESULT_CHARS : false);
    if (b.type !== "tool_use" || (!b.image && !long)) return b;
    changed = true;
    const { image, ...rest } = b;
    const cut = long;
    return {
      ...rest,
      ...(image ? { imageUrl: messageImagePath(message.conversationId, message.id, b.id) } : {}),
      ...(cut ? { result: b.result!.slice(0, LITE_RESULT_CHARS), resultTruncated: true } : {}),
    };
  });
  return changed ? { ...message, blocks } : message;
}

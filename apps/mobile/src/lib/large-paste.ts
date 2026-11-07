/** Like the desktop: over this, a paste goes along as a file. */
export const LARGE_PASTE_BYTES = 32 * 1024;
const MAX_MESSAGE_CHARS = 200_000;
/** Typing past the message limit isn't a paste. */
const MIN_PASTE_CHARS = 1024;

export const utf8Size = (text: string) => (typeof TextEncoder === "undefined" ? text.length : new TextEncoder().encode(text).length);

/** What one change of the field put in, when only a paste that large does that; with the text around it. */
export function largePaste(before: string, after: string): { pasted: string; rest: string } | null {
  if (after.length - before.length < MIN_PASTE_CHARS) return null;
  let head = 0;
  while (head < before.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const pasted = after.slice(head, after.length - tail);
  if (utf8Size(pasted) < LARGE_PASTE_BYTES && after.length <= MAX_MESSAGE_CHARS) return null;
  return { pasted, rest: before.slice(0, head) + before.slice(before.length - tail) };
}

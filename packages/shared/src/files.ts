/**
 * Files and folders a chat message names on the machine the core runs on. The chat shows the pictures among them and
 * links the rest to the file manager. A message only says what might be a path; which of them exist is the core's
 * answer (`POST /api/conversations/:id/files`).
 */

export interface ChatFile {
  /** The path as the message wrote it. */
  ref: string;
  /** Absolute path on the core's machine. */
  path: string;
  name: string;
  kind: "file" | "folder";
  /** Where the core serves the file, when it is a picture the chat can show. */
  image: string | null;
}

export interface ChatFiles {
  /** The app asking runs on the core's machine, so that machine's file manager is of use to it. */
  local: boolean;
  /** Per message, the paths that exist. */
  files: ChatFile[][];
}

export const CHAT_IMAGE_PATH = "/api/files/image";

/** File names as one short line: "a.png, b.png, c.png and 12 more". */
export function fileNameSummary(names: string[], max = 3): string {
  return names.length > max + 1 ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
}
export const MAX_CHAT_FILE_REFS = 80;
// Paths stand in prose: a longer line is data, and a message is only read this far.
const MAX_LINE = 4000;
const MAX_TEXT = 200_000;

/** `version` changes with the file, so a picture that was written again is fetched again. */
export function chatImageUrl(path: string, version: number): string {
  return `${CHAT_IMAGE_PATH}?path=${encodeURIComponent(path)}&v=${Math.round(version)}`;
}

// No lookbehind here: the phone app's JavaScript engine compiles this file too. Every repetition that could run to the
// end of a line is bounded, so text made to be slow ("[[[[…") stays fast.
const BARE = String.raw`(?:(?:file:\/\/|~)?\/|[A-Za-z]:[\\/])[^\s/\\()<>\`"'*][^\s()<>\`"'*]{0,1023}`;
const BARE_PATH = new RegExp(String.raw`(^|[\s(])(${BARE})`, "g");
const WHOLE_BARE_PATH = new RegExp(`^${BARE}$`);

/** Without the punctuation of the sentence around it; null when nothing of a path is left, or it goes on in brackets. */
function barePath(match: string, next: string | undefined): string | null {
  if (next === "(") return null;
  let end = match.length;
  while (end > 0 && ".,;:!?".includes(match[end - 1]!)) end--;
  const path = match.slice(0, end);
  return WHOLE_BARE_PATH.test(path) ? path : null;
}

/** Paths written out in plain text — absolute, in the home folder (`~/…`) or a file:// url — and where each starts. */
export function barePaths(text: string): { path: string; index: number }[] {
  if (text.length > MAX_TEXT) return [];
  return [...text.matchAll(BARE_PATH)].flatMap((m) => {
    const path = barePath(m[2]!, text[m.index + m[0].length]);
    return path ? [{ path, index: m.index + m[1]!.length }] : [];
  });
}

const REF = new RegExp(
  [
    // A Markdown link or image (group 1: its target, which may hold balanced brackets).
    String.raw`!?\[(?:\\.|\[[^\]\n]{0,300}\]|[^[\]\\\n]){0,300}\]\(\s*(<[^>\n]{1,1024}>|(?:[^\s()]|\([^\s()]{0,300}\)){1,1024})(?:\s+(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'|\([^)\n]{0,300}\)))?\s*\)`,
    // Inline code (groups 2–3: backticks, code).
    String.raw`(\`+)([^\`\n]+?)\2(?!\`)`,
    // Group 5: a bare path.
    BARE_PATH.source,
  ].join("|"),
  "g",
);

const ROOTED = /^(?:file:\/\/|~[\\/]|[\\/](?![\\/])|[A-Za-z]:[\\/])/;
const FILE_NAME = /\.[A-Za-z0-9]{1,10}(?::\d+){0,2}$/;

/** Could this piece of code or link target be a path? Urls, commands, routes (`/home`) and plain words can't. */
export function isPathLike(ref: string): boolean {
  if (!ref || ref.length > 400 || /[\n\r\0<>|*?"`$;{}]/.test(ref)) return false;
  // Right below the root there are no files of anyone's work: `/` and `/tasks` are routes.
  if (/^[\\/][^\\/]*[\\/]?$/.test(ref)) return false;
  if (ROOTED.test(ref)) return true;
  // `notes.txt:3` is a line in a file, `mailto:…` is not.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(ref) || /^(?:#|[\\/]{2})/.test(ref)) return false;
  // A name with spaces counts when it ends like a file; a single word needs a folder or an extension.
  return /\s/.test(ref) ? FILE_NAME.test(ref) : /[\\/]/.test(ref) || FILE_NAME.test(ref);
}

/** The path a Markdown link target means: `<…>` and percent-encoding are Markdown's, not the path's. */
export function linkedPath(target: string): string {
  const path = target.trim().replace(/^<(.*)>$/, "$1");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** What a message names that could be a file or folder, in order and without repeats. Code blocks are left out. */
export function fileRefs(markdown: string): string[] {
  const refs = new Set<string>();
  let fence: string | null = null;
  for (const line of markdown.slice(0, MAX_TEXT).split("\n")) {
    const [, marker, rest = ""] = /^\s*(`{3,}|~{3,})(.*)/.exec(line) ?? [];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !rest.trim()) fence = null;
      continue;
    }
    // ```code``` within a line is inline code, not a fence.
    if (marker && !(marker[0] === "`" && rest.includes("`"))) {
      fence = marker;
      continue;
    }
    if (line.length > MAX_LINE) continue;
    for (const match of line.matchAll(REF)) {
      const [, target, , code, , bare] = match;
      const ref = target !== undefined ? linkedPath(target) : bare !== undefined ? barePath(bare, line[match.index + match[0].length]) : code?.trim();
      if (ref && isPathLike(ref)) refs.add(ref);
      if (refs.size >= MAX_CHAT_FILE_REFS) return [...refs];
    }
  }
  return [...refs];
}

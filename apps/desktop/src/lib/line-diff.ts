/**
 * Line diff for reviewing prose edits (memory files): Myers' O((N+M)·D) diff over lines, word-level highlights
 * inside edited lines, and unchanged runs folded into expandable blocks.
 */

export type DiffKind = "same" | "add" | "del";

export interface WordPart {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line numbers in the old / new text (null on the side the line doesn't exist). */
  oldNo: number | null;
  newNo: number | null;
  /** Set when the line is one half of an edited line: the words that changed are marked. */
  parts?: WordPart[];
}

export type DiffBlock = { type: "lines"; lines: DiffLine[] } | { type: "fold"; lines: DiffLine[] };

export interface FileDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Only set when both versions exist, aren't empty and disagree on ending with a newline. */
  finalNewline: "added" | "removed" | null;
}

/** Edit distance Myers explores before giving up (dream-sized edits are far below it). */
const MAX_EDITS = 2_000;
/** Beyond MAX_EDITS, an exact LCS table is still affordable up to this many cells; past it the middle is replaced. */
const MAX_LINE_CELLS = 2_000_000;
const MAX_WORD_CELLS = 40_000;
/** Share of an edited line that must survive for word highlights to help rather than confetti the line. */
const MIN_WORD_OVERLAP = 0.35;
const TOKEN = /\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu;

function normalize(text: string | null): string | null {
  return text === null ? null : text.replace(/\r\n?/g, "\n");
}

function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Index pairs of a longest common subsequence via Myers' greedy algorithm; null when the edit distance exceeds
 * `maxEdits`. Keeps one V slice per edit step for the backtrack, so memory grows with D², not N·M.
 */
function myers<T>(a: readonly T[], b: readonly T[], maxEdits: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (!max) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxEdits) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) found = d;
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (found < 0) return null;

  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) pairs.push([--x, --y]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) pairs.push([--x, --y]);
  return pairs.reverse();
}

/** Index pairs of a longest common subsequence via a DP table; null when the table would be too large. */
function lcsTable<T>(a: readonly T[], b: readonly T[], maxCells: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > maxCells) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

function toParts(tokens: string[], kept: Set<number>): WordPart[] {
  const changed = tokens.map((_, i) => !kept.has(i));
  // Whitespace between two changed words belongs to the change: one highlight instead of two.
  for (let i = 1; i < tokens.length - 1; i++) {
    if (!changed[i] && /^\s+$/.test(tokens[i]) && changed[i - 1] && changed[i + 1]) changed[i] = true;
  }
  const parts: WordPart[] = [];
  tokens.forEach((text, i) => {
    const last = parts[parts.length - 1];
    if (last && last.changed === changed[i]) last.text += text;
    else parts.push({ text, changed: changed[i] });
  });
  return parts;
}

/** Word-level parts of an old and a new version of a line, or null when the lines have too little in common. */
export function diffWords(before: string, after: string): [WordPart[], WordPart[]] | null {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  const pairs = lcsTable(a, b, MAX_WORD_CELLS);
  if (!pairs) return null;
  const common = pairs.reduce((sum, [i]) => sum + a[i].replace(/\s+/g, "").length, 0);
  const longest = Math.max(before.replace(/\s+/g, "").length, after.replace(/\s+/g, "").length);
  if (!longest || common / longest < MIN_WORD_OVERLAP) return null;
  return [toParts(a, new Set(pairs.map((p) => p[0]))), toParts(b, new Set(pairs.map((p) => p[1])))];
}

/** Pair the removed and added lines of one change block in order and mark the words that changed. */
function pairEdits(dels: DiffLine[], adds: DiffLine[]) {
  for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
    const words = diffWords(dels[k].text, adds[k].text);
    if (!words) continue;
    dels[k].parts = words[0];
    adds[k].parts = words[1];
  }
}

/**
 * Diff two versions of a text by line. `null` means the file didn't exist (before) or was deleted (after):
 * every line shows as added or removed. Line endings are normalised to \n.
 */
export function diffText(before: string | null, after: string | null): DiffLine[] {
  const a = splitLines(normalize(before));
  const b = splitLines(normalize(after));
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const pairs = myers(midA, midB, MAX_EDITS) ?? lcsTable(midA, midB, MAX_LINE_CELLS) ?? [];

  const out: DiffLine[] = [];
  for (let k = 0; k < head; k++) out.push({ kind: "same", text: a[k], oldNo: k + 1, newNo: k + 1 });
  let i = 0;
  let j = 0;
  const changesUntil = (ti: number, tj: number) => {
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    for (; i < ti; i++) dels.push({ kind: "del", text: midA[i], oldNo: head + i + 1, newNo: null });
    for (; j < tj; j++) adds.push({ kind: "add", text: midB[j], oldNo: null, newNo: head + j + 1 });
    pairEdits(dels, adds);
    out.push(...dels, ...adds);
  };
  for (const [pi, pj] of pairs) {
    changesUntil(pi, pj);
    out.push({ kind: "same", text: midA[pi], oldNo: head + pi + 1, newNo: head + pj + 1 });
    i++;
    j++;
  }
  changesUntil(midA.length, midB.length);
  for (let k = tail; k > 0; k--) out.push({ kind: "same", text: a[a.length - k], oldNo: a.length - k + 1, newNo: b.length - k + 1 });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

/** Everything the review of one file needs: the line diff, its stats and a change of the final newline. */
export function diffFile(before: string | null, after: string | null): FileDiff {
  const lines = diffText(before, after);
  const a = normalize(before);
  const b = normalize(after);
  const finalNewline = a && b && a.endsWith("\n") !== b.endsWith("\n") ? (b.endsWith("\n") ? "added" : "removed") : null;
  return { lines, ...diffStats(lines), finalNewline };
}

/** Keep `context` unchanged lines around each change; longer unchanged runs become fold blocks. */
export function foldContext(lines: DiffLine[], context = 3): DiffBlock[] {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) near[k] = true;
  });
  if (!near.includes(true)) return lines.length ? [{ type: "lines", lines }] : [];

  const blocks: DiffBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const visible = near[i];
    let j = i;
    while (j < lines.length && near[j] === visible) j++;
    const run = lines.slice(i, j);
    // Folding a line or two saves nothing.
    if (!visible && run.length > 2) blocks.push({ type: "fold", lines: run });
    else {
      const last = blocks[blocks.length - 1];
      if (last?.type === "lines") last.lines.push(...run);
      else blocks.push({ type: "lines", lines: run });
    }
    i = j;
  }
  return blocks;
}

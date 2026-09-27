import { useMemo, useState } from "react";
import styles from "./FileDiff.module.css";

/*
 * aicss "File Diff" (github.com/kvnkld/aicss), adapted to render real edits: pass the text before and
 * after a change and it computes a line diff, with context folding for long unchanged runs.
 */

type RowType = "ctx" | "add" | "del" | "fold";
export interface DiffRow {
  old: number | null;
  cur: number | null;
  type: RowType;
  text: string;
}

const KEYWORDS = new Set([
  "export", "function", "return", "const", "let", "var", "if", "else", "throw", "new", "import", "from", "async", "await",
  "class", "extends", "typeof", "void", "true", "false", "null", "undefined", "for", "while", "switch", "case", "break",
  "continue", "try", "catch", "finally", "this", "super", "static", "type", "interface", "enum", "as", "of", "in", "def",
  "self", "None", "True", "False", "fn", "pub", "use", "impl", "struct",
]);

function tokenize(line: string): { t: string; v: string }[] {
  const raw: { kind: string; v: string }[] = [];
  const re = /(\s+)|(\/\/.*|#.*)|(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)|(\S)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[1]) raw.push({ kind: "txt", v: m[1] });
    else if (m[2] || m[3]) raw.push({ kind: "cm", v: m[0] });
    else if (m[4]) raw.push({ kind: "str", v: m[0] });
    else if (m[5]) raw.push({ kind: "num", v: m[0] });
    else if (m[6]) raw.push({ kind: "id", v: m[0] });
    else raw.push({ kind: "txt", v: m[0] });
  }
  const out: { t: string; v: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    if (cur.kind !== "id") {
      out.push({ t: cur.kind, v: cur.v });
      continue;
    }
    if (KEYWORDS.has(cur.v)) {
      out.push({ t: "kw", v: cur.v });
      continue;
    }
    let j = i + 1;
    while (j < raw.length && raw[j].kind === "txt" && /^\s+$/.test(raw[j].v)) j++;
    const next = raw[j];
    out.push({ t: next && next.v.startsWith("(") ? "fn" : "txt", v: cur.v });
  }
  return out;
}

const MAX_LCS = 600;

/** Line diff via LCS (falls back to "all removed, all added" for very large inputs). */
export function diffLines(before: string, after: string, context = 3): DiffRow[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const rows: DiffRow[] = [];
  if (a.length > MAX_LCS || b.length > MAX_LCS) {
    a.forEach((text, i) => rows.push({ old: i + 1, cur: null, type: "del", text }));
    b.forEach((text, i) => rows.push({ old: null, cur: i + 1, type: "add", text }));
    return rows;
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      rows.push({ old: i + 1, cur: j + 1, type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      rows.push({ old: null, cur: j + 1, type: "add", text: b[j] });
      j++;
    } else {
      rows.push({ old: i + 1, cur: null, type: "del", text: a[i] });
      i++;
    }
  }
  // Fold long unchanged runs, keeping `context` lines around each change.
  const keep = rows.map((r) => r.type !== "ctx");
  const near = rows.map((_, k) => rows.slice(Math.max(0, k - context), k + context + 1).some((r) => r.type !== "ctx"));
  const out: DiffRow[] = [];
  let hidden = 0;
  rows.forEach((r, k) => {
    if (keep[k] || near[k]) {
      if (hidden) out.push({ old: null, cur: null, type: "fold", text: `${hidden} unchanged line${hidden === 1 ? "" : "s"}` });
      hidden = 0;
      out.push(r);
    } else hidden++;
  });
  if (hidden) out.push({ old: null, cur: null, type: "fold", text: `${hidden} unchanged line${hidden === 1 ? "" : "s"}` });
  return out;
}

const PREVIEW_ROWS = 40;

export function FileDiff({ file, before, after, rows: given }: { file: string; before?: string; after?: string; rows?: DiffRow[] }) {
  const rows = useMemo(() => given ?? diffLines(before ?? "", after ?? ""), [given, before, after]);
  const [all, setAll] = useState(false);
  const added = rows.filter((r) => r.type === "add").length;
  const removed = rows.filter((r) => r.type === "del").length;
  const shown = all ? rows : rows.slice(0, PREVIEW_ROWS);
  return (
    <div className={styles.diff}>
      <div className={styles.diffHead}>
        <span className={styles.diffFileWrap}>
          <svg className={styles.diffIcon} viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={styles.diffFile} title={file}>
            {file}
          </span>
        </span>
        <span className={styles.diffStat}>
          <span className={styles.add}>+{added}</span>
          <span className={styles.del}>-{removed}</span>
        </span>
      </div>
      <div className={styles.diffBody}>
        <div className={styles.diffLines}>
          {shown.map((r, i) =>
            r.type === "fold" ? (
              <div key={i} className={styles.diffFold}>
                {r.text}
              </div>
            ) : (
              <div key={i} className={styles.diffRow + " " + styles[r.type]} style={{ animationDelay: `${Math.min(i, 24) * 14}ms` }}>
                <span className={styles.ln + " " + styles.old}>{r.old ?? ""}</span>
                <span className={styles.ln + " " + styles.new}>{r.cur ?? ""}</span>
                <span className={styles.sign}>{r.type === "add" ? "+" : r.type === "del" ? "-" : ""}</span>
                <code>
                  {tokenize(r.text).map((tok, j) => (
                    <span key={j} className={tok.t === "txt" ? undefined : styles[tok.t]}>
                      {tok.v}
                    </span>
                  ))}
                  {!r.text && " "}
                </code>
              </div>
            ),
          )}
        </div>
      </div>
      {rows.length > PREVIEW_ROWS && (
        <button type="button" className={styles.diffMore} onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : `Show ${rows.length - PREVIEW_ROWS} more lines`}
        </button>
      )}
    </div>
  );
}

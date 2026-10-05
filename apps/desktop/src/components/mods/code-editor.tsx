import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { tokenize, type CodeLanguage, type TokenKind } from "./highlight";

const INDENT = "  ";
const LINE_HEIGHT = 20;
const PADDING_TOP = 12;
/** Past this size the text stays plain, so typing never waits for the colours. */
const HIGHLIGHT_LIMIT = 80_000;

/** Both layers share these, so every glyph of the textarea sits exactly on its coloured twin. */
const TEXT = "m-0 font-mono text-[12.5px] leading-5 tracking-normal whitespace-pre [font-variant-ligatures:none] [tab-size:2]";

const TOKEN_CLASS: Record<Exclude<TokenKind, "plain">, string> = {
  comment: "text-muted-foreground",
  string: "text-brand-strong",
  number: "text-warning",
  literal: "text-warning",
  keyword: "font-medium text-foreground",
  engine: "rounded-[3px] bg-foreground/[0.08] font-medium text-foreground",
  punct: "text-foreground/50",
  key: "text-foreground",
};

function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Replace a range the way typing would, so the browser's undo history survives. */
function replaceRange(el: HTMLTextAreaElement, from: number, to: number, text: string) {
  el.focus();
  el.setSelectionRange(from, to);
  const done = text ? document.execCommand("insertText", false, text) : from === to || document.execCommand("delete");
  if (!done) {
    el.setRangeText(text, from, to, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function indentLines(el: HTMLTextAreaElement, outdent: boolean) {
  const { value, selectionStart: start, selectionEnd: end } = el;
  if (!outdent && start === end) return replaceRange(el, start, end, INDENT);
  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  // A selection that ends at the start of a line doesn't take that line along.
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", last);
  const blockEnd = nextBreak < 0 ? value.length : nextBreak;
  let first = 0;
  let total = 0;
  const lines = value
    .slice(blockStart, blockEnd)
    .split("\n")
    .map((line, i) => {
      const cut = outdent ? (/^(?: {1,2}|\t)/.exec(line)?.[0].length ?? 0) : 0;
      const delta = outdent ? -cut : line ? INDENT.length : 0;
      if (i === 0) first = delta;
      total += delta;
      return outdent ? line.slice(cut) : line ? INDENT + line : line;
    });
  if (!total) return;
  replaceRange(el, blockStart, blockEnd, lines.join("\n"));
  const from = Math.max(blockStart, start + first);
  el.setSelectionRange(from, start === end ? from : Math.max(from, end + total));
}

function breakLine(el: HTMLTextAreaElement) {
  const { value, selectionStart: start, selectionEnd: end } = el;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const indent = /^[ \t]*/.exec(value.slice(lineStart, start))?.[0] ?? "";
  const opens = "{[(".includes(value[start - 1] ?? " ");
  const closes = opens && "}])".includes(value[end] ?? " ");
  replaceRange(el, start, end, `\n${indent}${opens ? INDENT : ""}${closes ? `\n${indent}` : ""}`);
  if (closes) {
    const caret = start + 1 + indent.length + INDENT.length;
    el.setSelectionRange(caret, caret);
  }
}

/**
 * A code editor without a dependency: a transparent textarea over a highlighted copy of its text. The textarea is as
 * large as the text, so the frame around both does the scrolling and the two layers can never drift apart.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  label,
  onSave,
  jump,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  language: CodeLanguage;
  /** Accessible name, e.g. the file's path. */
  label: string;
  onSave?: () => void;
  /** Select this line (1-based); a new object jumps again. */
  jump?: { line: number } | null;
  className?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // Tab indents; Escape lets the next Tab move the focus on, so the editor is no keyboard trap.
  const leaving = useRef(false);
  const hintId = useId();
  const [activeLine, setActiveLine] = useState<number | null>(null);

  const numbers = useMemo(() => {
    const count = lineOf(value, value.length) + 1;
    return Array.from({ length: count }, (_, i) => i + 1).join("\n");
  }, [value]);

  const highlighted = useMemo(
    () => (
      <pre aria-hidden className={cn(TEXT, "pointer-events-none relative pt-3 pr-10 pb-10 pl-3 text-foreground/85")}>
        {value.length > HIGHLIGHT_LIMIT
          ? value
          : tokenize(value, language).map((t, i) =>
              t.kind === "plain" ? (
                t.text
              ) : (
                <span key={i} className={TOKEN_CLASS[t.kind]}>
                  {t.text}
                </span>
              ),
            )}
        {"\n"}
      </pre>
    ),
    [value, language],
  );

  useEffect(() => {
    const el = area.current;
    if (!el || !jump) return;
    const lines = el.value.split("\n");
    const line = Math.min(Math.max(jump.line, 1), lines.length);
    const offset = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0);
    el.focus({ preventScroll: true });
    el.setSelectionRange(offset, offset + lines[line - 1].length);
    const box = frame.current;
    box?.scrollTo({ top: Math.max(0, (line - 1) * LINE_HEIGHT - box.clientHeight / 3) });
  }, [jump]);

  const trackCaret = () => {
    const el = area.current;
    if (!el || document.activeElement !== el) return;
    setActiveLine(el.selectionStart === el.selectionEnd ? lineOf(el.value, el.selectionStart) : null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave?.();
    } else if (e.key === "Escape") {
      leaving.current = true;
    } else if (e.key === "Tab" && plain) {
      if (leaving.current) return;
      e.preventDefault();
      indentLines(el, e.shiftKey);
    } else if (e.key === "Enter" && plain && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      breakLine(el);
      leaving.current = false;
    } else if (e.key !== "Shift") {
      leaving.current = false;
    }
  };

  return (
    <div ref={frame} className={cn("relative min-h-0 flex-1 scroll-py-5 scroll-pl-16 overflow-auto bg-card", className)}>
      <div className="flex min-h-full w-max min-w-full">
        <pre
          aria-hidden
          className="sticky left-0 z-10 m-0 min-w-11 shrink-0 border-r bg-paper-2 px-2 pt-3 pb-10 text-right font-mono text-[11px] leading-5 text-muted-foreground/70 tabular-nums select-none"
        >
          {numbers}
        </pre>
        <div className="relative grow">
          {activeLine !== null && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 h-5 bg-foreground/[0.04]" style={{ top: PADDING_TOP + activeLine * LINE_HEIGHT }} />
          )}
          {highlighted}
          <textarea
            ref={area}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onSelect={trackCaret}
            onFocus={trackCaret}
            onBlur={() => {
              setActiveLine(null);
              leaving.current = false;
            }}
            aria-label={label}
            aria-describedby={hintId}
            aria-multiline
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            className={cn(
              TEXT,
              "absolute inset-0 size-full resize-none overflow-hidden border-0 bg-transparent p-3 text-transparent caret-foreground outline-none selection:text-transparent",
            )}
          />
        </div>
      </div>
      <span id={hintId} className="sr-only">
        Tab indents the code. Press Escape, then Tab, to leave the editor.
      </span>
    </div>
  );
}

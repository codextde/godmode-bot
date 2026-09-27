import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import styles from "./ThinkingReasoning.module.css";

/*
 * aicss "Thinking + Reasoning" (MIT, github.com/kvnkld/aicss), adapted to real streamed thinking:
 * while the model thinks, sentences roll up inside a capped viewport behind a soft fade; once done
 * the block folds into a "Thought for Ns" summary that unfolds into the full, scrollable reasoning.
 */

// Geometry — sentences wrap freely (chat columns are wide), so the stream is measured, not assumed.
const MAX_H = 120; // live viewport grows with content up to this, then rolls
const FADE = 16;

/** Lines first (lists, plans), then sentences within each line — any script, any capitalisation of digits/quotes. */
function sentencesOf(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.replace(/\s+/g, " ").split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}"'“„«(])/u))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ThinkingReasoning({ text, active, seconds }: { text: string; active: boolean; seconds?: number | null }) {
  const [open, setOpen] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: true });
  const viewportRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const [contentH, setContentH] = useState(0);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState<number | null>(null);
  const wasActive = useRef(active);

  // Measure how long we watched it think, for the "Thought for Ns" summary.
  useEffect(() => {
    if (wasActive.current && !active) setElapsed(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
    wasActive.current = active;
  }, [active]);

  const sentences = useMemo(() => sentencesOf(text), [text]);
  const done = !active;
  const count = sentences.length;
  useLayoutEffect(() => {
    if (streamRef.current) setContentH(streamRef.current.scrollHeight);
  }, [sentences]);
  const capped = contentH > MAX_H;
  const viewH = capped ? MAX_H : contentH;
  const translate = capped ? MAX_H - FADE - contentH : 0;
  const liveMask = capped ? `linear-gradient(to bottom, transparent 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent 100%)` : "none";
  const openMask = `linear-gradient(to bottom, transparent 0, #000 ${fade.top ? FADE : 0}px, #000 calc(100% - ${fade.bottom ? FADE : 0}px), transparent 100%)`;
  const secs = seconds ?? elapsed;

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    setFade({ top: el.scrollTop > 1, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1 });
  };

  useEffect(() => {
    if (!open) return;
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setFade({ top: false, bottom: el.scrollHeight > el.clientHeight + 1 });
  }, [open]);

  if (done && !text.trim()) return null;

  return (
    <div className={styles.tr}>
      {done ? (
        <button type="button" className={styles.trHeader + " " + styles.isClickable} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className={styles.trLabel}>
            <span className={styles.trVerb}>Thought</span>
            {secs ? ` for ${secs}s` : " process"}
          </span>
          <svg className={styles.trChevron} viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="m4.5 15.75 7.5-7.5 7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <div className={styles.trHeader}>
          <span className={styles.trLabel + " " + styles.trShimmer}>Reasoning…</span>
        </div>
      )}

      {!done && count > 0 && (
        <div className={styles.trViewport} style={{ height: `${viewH}px`, WebkitMaskImage: liveMask, maskImage: liveMask }}>
          <div ref={streamRef} className={styles.trStream} style={{ transform: `translateY(${translate}px)` }}>
            {sentences.map((line, i) => (
              // The newest sentence is never clamped, so streaming tokens stay visible at the bottom.
              <p key={i} className={styles.trSentence + (i === count - 1 ? " " + styles.isLive : "")}>
                {line}
              </p>
            ))}
          </div>
        </div>
      )}

      {done && (
        <div className={styles.trCollapsible + (open ? "" : " " + styles.isCollapsed)} inert={!open} aria-hidden={!open}>
          <div className={styles.trInner}>
            <div
              ref={viewportRef}
              className={styles.trFull}
              style={{ WebkitMaskImage: openMask, maskImage: openMask }}
              onScroll={onScroll}
            >
              {text.trim()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

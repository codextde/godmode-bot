import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { TextQuote } from "lucide-react";
import { isMac, modKey } from "@/lib/desktop";
import { cn } from "@/lib/utils";

/** The text selected in `container`, if there is some and all of it is there (not in a field the human types in). */
function selectionIn(container: HTMLElement | null): { text: string; range: Range } | null {
  const selection = window.getSelection();
  if (!container || !selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const text = selection.toString().trim();
  if (!text || !container.contains(range.commonAncestorContainer)) return null;
  const active = document.activeElement as HTMLElement | null;
  if (active && container.contains(active) && (active.isContentEditable || ["INPUT", "TEXTAREA"].includes(active.tagName))) return null;
  return { text, range };
}

/** A Markdown block quote of the text, with an empty line after it for the reply. */
function quoteOf(text: string): string {
  return `${text
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n")}\n\n`;
}

/**
 * Text selected in the messages can be quoted in the next message: with the Quote button over the selection or
 * ⌘L / Ctrl+L.
 */
export function QuoteSelection({ onQuote, disabled, children }: { onQuote: (quote: string) => void; disabled?: boolean; children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;

  const quote = () => {
    const picked = selectionIn(containerRef.current);
    setAt(null);
    if (!picked) return;
    window.getSelection()?.removeAllRanges();
    onQuoteRef.current(quoteOf(picked.text));
  };

  useEffect(() => {
    if (disabled) {
      setAt(null);
      return;
    }
    // While the mouse is down the selection is still being made; Escape hides the button until it changes.
    let selecting = false;
    let dismissed = false;
    const place = () => {
      const container = containerRef.current;
      const picked = selecting || dismissed ? null : selectionIn(container);
      if (!picked || !container) return setAt(null);
      const box = picked.range.getBoundingClientRect();
      const end = Array.from(picked.range.getClientRects()).findLast((r) => r.width > 0) ?? box;
      const view = container.getBoundingClientRect();
      // Scrolled out of the messages: nothing to point at.
      if (box.bottom < view.top || box.top > view.bottom) return setAt(null);
      const below = box.top - 40 < view.top;
      setAt({
        x: Math.min(Math.max(end.right, view.left + 48), view.right - 48),
        y: below ? Math.min(box.bottom, view.bottom - 40) + 6 : box.top - 6,
        below,
      });
    };
    const onSelectionChange = () => {
      dismissed = false;
      place();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (pillRef.current?.contains(e.target as Node)) return;
      selecting = true;
      setAt(null);
    };
    const onMouseUp = () => {
      selecting = false;
      requestAnimationFrame(place);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismissed = true;
        setAt(null);
        return;
      }
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.defaultPrevented || e.key.toLowerCase() !== "l" || !selectionIn(containerRef.current)) return;
      e.preventDefault();
      quote();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("keydown", onKey);
    };
  }, [disabled]);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      {children}
      {createPortal(
        <AnimatePresence>
          {at && (
            <motion.button
              ref={pillRef}
              type="button"
              initial={{ opacity: 0, y: at.below ? -4 : 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
              style={{ left: at.x, top: at.y }}
              // Keep the selection: it is read on click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={quote}
              className={cn(
                "fixed z-50 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-md border bg-popover px-2 text-xs font-medium text-popover-foreground shadow-float transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                !at.below && "-translate-y-full",
              )}
            >
              <TextQuote className="size-3.5 text-muted-foreground" />
              Quote
              <span className="font-normal text-muted-foreground">{modKey}L</span>
            </motion.button>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

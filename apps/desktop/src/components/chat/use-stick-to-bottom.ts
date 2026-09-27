import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps a scroll container pinned to the bottom while its content grows (streaming),
 * until the user scrolls up. Returns refs for the scroller and its content.
 */
export function useStickToBottom(threshold = 72) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      const dist = el.scrollHeight - top - el.clientHeight;
      if (dist <= threshold) stickRef.current = true;
      else if (top < lastTop - 2) stickRef.current = false;
      lastTop = top;
      setAtBottom(dist <= threshold);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickRef.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (["PageUp", "ArrowUp", "Home"].includes(e.key)) stickRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
    };
  }, [threshold]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
      else setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= threshold);
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [threshold]);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  return { scrollRef, contentRef, atBottom, scrollToBottom, isStuck: () => stickRef.current };
}

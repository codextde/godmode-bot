import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const SETTLE_MS = 600;
const FOLLOW_TAU_MS = 70;
const JUMP_TAU_MS = 110;
const PIN_OFFSET = 64;

const maxTop = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);

export function useStickToBottom({ threshold = 72, reduceMotion = false }: { threshold?: number; reduceMotion?: boolean } = {}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const pinnedRef = useRef(false);
  const reduceRef = useRef(reduceMotion);
  useLayoutEffect(() => {
    reduceRef.current = reduceMotion;
  });
  const [atBottom, setAtBottom] = useState(true);

  const engine = useRef({ frame: 0, last: 0, tau: FOLLOW_TAU_MS, mountedAt: 0, pointerDown: false, scrollbarDrag: false });

  const layoutSpacer = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const spacer = spacerRef.current;
    if (!el || !content || !spacer) return;
    const anchors = pinnedRef.current ? content.querySelectorAll<HTMLElement>("[data-turn-anchor]") : null;
    const anchor = anchors?.[anchors.length - 1];
    if (!anchor) {
      if (spacer.style.height !== "0px") spacer.style.height = "0px";
      return;
    }
    const base = el.getBoundingClientRect().top - el.scrollTop;
    const anchorTop = anchor.getBoundingClientRect().top - base;
    const contentBottom = content.getBoundingClientRect().bottom - base;
    const need = Math.max(0, Math.round(el.clientHeight - (contentBottom - anchorTop) - PIN_OFFSET));
    const next = `${need}px`;
    if (spacer.style.height !== next) spacer.style.height = next;
  }, []);

  const tick = useCallback(function step(now: number) {
    const e = engine.current;
    e.frame = 0;
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    if (e.pointerDown) {
      e.last = now;
      e.frame = requestAnimationFrame(step);
      return;
    }
    const target = maxTop(el);
    const diff = target - el.scrollTop;
    if (Math.abs(diff) < 1 || reduceRef.current || now - e.mountedAt < SETTLE_MS) {
      el.scrollTop = target;
      e.tau = FOLLOW_TAU_MS;
      return;
    }
    const dt = Math.min(64, Math.max(1, now - (e.last || now - 16)));
    e.last = now;
    const delta = diff * (1 - Math.exp(-dt / e.tau));
    el.scrollTop += Math.abs(delta) < 1 ? Math.sign(diff) : delta;
    e.frame = requestAnimationFrame(step);
  }, []);

  const kick = useCallback(() => {
    const e = engine.current;
    if (e.frame || !stickRef.current) return;
    e.last = 0;
    e.frame = requestAnimationFrame(tick);
  }, [tick]);

  const release = useCallback(() => {
    stickRef.current = false;
    const e = engine.current;
    if (e.frame) cancelAnimationFrame(e.frame);
    e.frame = 0;
    e.tau = FOLLOW_TAU_MS;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    engine.current.mountedAt = performance.now();
    if (el) el.scrollTop = maxTop(el);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const e = engine.current;
    let lastTop = el.scrollTop;
    let touchY = 0;
    const onScroll = () => {
      const top = el.scrollTop;
      const dist = el.scrollHeight - top - el.clientHeight;
      if (e.scrollbarDrag && top < lastTop - 1) release();
      if (!stickRef.current && (dist <= 2 || (top > lastTop && dist <= threshold && !e.pointerDown))) stickRef.current = true;
      lastTop = top;
      setAtBottom(dist <= threshold);
    };
    const onWheel = (ev: WheelEvent) => {
      if (ev.deltaY < 0) release();
    };
    const onTouchStart = (ev: TouchEvent) => {
      touchY = ev.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (ev: TouchEvent) => {
      const y = ev.touches[0]?.clientY ?? 0;
      if (y > touchY + 2) release();
      touchY = y;
    };
    const onKey = (ev: KeyboardEvent) => {
      if (["PageUp", "ArrowUp", "Home"].includes(ev.key)) release();
      else if (ev.key === "End" && !ev.shiftKey) {
        stickRef.current = true;
        kick();
      }
    };
    const onPointerDown = (ev: PointerEvent) => {
      e.pointerDown = true;
      e.scrollbarDrag = ev.target === el;
    };
    const onPointerUp = () => {
      e.pointerDown = false;
      e.scrollbarDrag = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (e.frame) cancelAnimationFrame(e.frame);
      e.frame = 0;
    };
  }, [threshold, release, kick]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      layoutSpacer();
      if (stickRef.current) kick();
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= threshold);
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [threshold, layoutSpacer, kick]);

  const scrollToBottom = useCallback(() => {
    stickRef.current = true;
    engine.current.tau = JUMP_TAU_MS;
    kick();
  }, [kick]);

  const pinTurn = useCallback(
    () => {
      pinnedRef.current = true;
      layoutSpacer();
      scrollToBottom();
    },
    [layoutSpacer, scrollToBottom],
  );

  return { scrollRef, contentRef, spacerRef, atBottom, scrollToBottom, pinTurn, unstick: release, isStuck: () => stickRef.current };
}

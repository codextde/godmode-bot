"use client";

import { useEffect } from "react";

/** Scrolls the visible element marked `data-highlighted` for this row id into view once (DataTable's highlightId). */
export function ScrollToHighlight({ id }: { id: string }) {
  useEffect(() => {
    const candidates = document.querySelectorAll<HTMLElement>(`[data-row-id="${CSS.escape(id)}"][data-highlighted]`);
    const target = [...candidates].find((el) => el.offsetParent !== null);
    target?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [id]);
  return null;
}

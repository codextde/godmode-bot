"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the current page's server components every `seconds` while the tab is visible (and once on coming back
 * after a longer absence). Client state such as open dialogs and typed text survives a refresh. Renders nothing.
 */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  const last = useRef(Date.now());

  useEffect(() => {
    const ms = Math.max(seconds, 2) * 1000;
    const refresh = () => {
      last.current = Date.now();
      router.refresh();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current >= ms) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, seconds]);

  return null;
}

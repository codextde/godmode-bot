import { useEffect, useState } from "react";
import { useMotionRest } from "@/lib/motion-rest";

/** Current time in ms, re-rendering every `intervalMs` (paused while the tab is hidden or nobody looks). */
export function useNow(intervalMs = 250, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  const resting = useMotionRest();
  useEffect(() => {
    if (!active || resting) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      setNow(Date.now());
      id = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (id) clearInterval(id);
      id = null;
    };
    const onVis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs, active, resting]);
  return now;
}

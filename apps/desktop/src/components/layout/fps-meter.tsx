import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/core";
import { useUi } from "@/stores/ui";

const SAMPLE_MS = 500;
const HISTORY = 40;
const GRAPH_FPS = 120;

const tone = (fps: number) => (fps >= 50 ? "var(--success)" : fps >= 30 ? "var(--warning)" : "var(--destructive)");

export function FpsMeter() {
  const on = useUi((s) => s.fpsMeter);
  return isTauri && on ? <Meter /> : null;
}

/** Writes to the DOM directly: a React render per sample would show up in the numbers it measures. */
function Meter() {
  const root = useRef<HTMLDivElement>(null);
  const fpsText = useRef<HTMLSpanElement>(null);
  const worstText = useRef<HTMLSpanElement>(null);
  const bars = useRef<SVGPathElement>(null);

  useEffect(() => {
    const history: number[] = [];
    let frame = 0;
    let last = performance.now();
    let start = last;
    let frames = 0;
    let worst = 0;

    const restart = (now: number) => {
      last = start = now;
      frames = worst = 0;
    };
    // Hidden windows draw nothing, and that gap is no stutter.
    const onVisibility = () => restart(performance.now());

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      worst = Math.max(worst, now - last);
      last = now;
      frames++;
      if (now - start < SAMPLE_MS) return;
      const fps = (frames * 1000) / (now - start);
      history.push(fps);
      if (history.length > HISTORY) history.shift();
      root.current!.style.color = tone(fps);
      fpsText.current!.textContent = String(Math.round(fps));
      worstText.current!.textContent = String(Math.round(worst));
      bars.current!.setAttribute(
        "d",
        history.map((v, i) => `M${HISTORY - history.length + i + 0.5} 20V${20 - Math.max(1, (Math.min(v, GRAPH_FPS) / GRAPH_FPS) * 20)}`).join(""),
      );
      start = now;
      frames = worst = 0;
    };

    frame = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div
      ref={root}
      aria-hidden
      className="pointer-events-none fixed top-2 left-1/2 z-[9999] flex h-7 -translate-x-1/2 items-center gap-2 rounded-lg border bg-popover/90 px-2 font-mono text-xs tabular-nums shadow-sm backdrop-blur-sm select-none"
    >
      <svg viewBox={`0 0 ${HISTORY} 20`} className="h-4 w-14 opacity-70" preserveAspectRatio="none">
        <path ref={bars} stroke="currentColor" strokeWidth="0.7" fill="none" />
      </svg>
      <span className="flex items-baseline gap-1">
        <span ref={fpsText} className="inline-block w-[3ch] text-right font-semibold">
          --
        </span>
        <span className="text-[10px] text-muted-foreground">FPS</span>
      </span>
      <span className="flex items-baseline gap-1">
        <span ref={worstText} className="inline-block w-[3ch] text-right text-foreground">
          --
        </span>
        <span className="text-[10px] text-muted-foreground">ms</span>
      </span>
    </div>
  );
}

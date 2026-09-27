import { useEffect, useRef, type RefObject } from "react";
import { Orb, type OrbVariant } from "@/components/aicss/Orb";
import { cn } from "@/lib/utils";

export type VoiceOrbPhase = "listening" | "transcribing" | "sending" | "thinking" | "speaking" | "paused";

/** Per-tick stretch factors for the dial (fixed, so the "spectrum" has shape without per-frame work). */
const TICKS = Array.from({ length: 72 }, (_, i) => (0.5 + 1.4 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.53))).toFixed(2));

const ORB_FOR_PHASE: Record<VoiceOrbPhase, OrbVariant> = {
  listening: "C2",
  transcribing: "S2",
  sending: "S2",
  thinking: "B1",
  speaking: "C3",
  paused: "G5",
};

/**
 * The big voice-mode orb: hairline rings, a radial tick dial and a solid paper core with a dot-matrix
 * Orb, breathing with the audio level (mic while listening, playback while speaking). Level is read
 * from a ref per frame and exposed as `--lvl`. Monochrome ink; the brand colour marks "listening".
 */
export function VoiceOrb({
  phase,
  levelRef,
  onClick,
  label,
  className,
}: {
  phase: VoiceOrbPhase;
  levelRef: RefObject<number>;
  onClick?: () => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      const p = phaseRef.current;
      let target = levelRef.current ?? 0;
      if (p === "thinking" || p === "sending" || p === "transcribing") target = 0.18 + 0.1 * Math.sin(t * 2.2);
      else if (p === "paused") target = 0.04;
      else if (p === "listening") target = Math.max(0.06 + 0.03 * Math.sin(t * 1.6), target);
      smooth += (Math.min(1, target) - smooth) * 0.18;
      ref.current?.style.setProperty("--lvl", smooth.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      data-phase={phase}
      style={{ ["--lvl" as string]: 0 }}
      className={cn(
        "group relative grid size-56 place-items-center rounded-full text-foreground outline-none transition-colors duration-500 sm:size-64",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-8 focus-visible:ring-offset-background",
        "data-[phase=listening]:text-brand-strong data-[phase=paused]:text-muted-foreground",
        className,
      )}
    >
      {/* Outer hairline rings — they widen with the level */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full border border-current opacity-[0.08]"
        style={{ transform: "scale(calc(0.9 + var(--lvl) * 0.22))" }}
      />
      <span
        aria-hidden
        className="absolute inset-[7%] rounded-full border border-current opacity-[0.14]"
        style={{ transform: "scale(calc(0.94 + var(--lvl) * 0.14))" }}
      />
      {/* Radial tick dial — each tick stretches with the level, like a round equaliser */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-[7%] [animation:spin_40s_linear_infinite]",
          "group-data-[phase=thinking]:[animation-duration:14s] group-data-[phase=sending]:[animation-duration:14s] group-data-[phase=paused]:[animation-play-state:paused]",
        )}
      >
        {TICKS.map((k, i) => (
          <span key={i} className="absolute inset-0" style={{ transform: `rotate(${i * (360 / TICKS.length)}deg)` }}>
            <span
              className="absolute top-[4%] left-1/2 h-[11%] w-[1.5px] -translate-x-1/2 origin-bottom rounded-[1px] bg-current opacity-50"
              style={{ transform: `scaleY(calc(0.18 + var(--lvl) * ${k}))` }}
            />
          </span>
        ))}
      </span>
      {/* Solid paper core */}
      <span
        aria-hidden
        className="absolute inset-[24%] rounded-full border bg-card shadow-float transition-[border-color] duration-500 group-data-[phase=listening]:border-brand/30"
        style={{ transform: "scale(calc(1 + var(--lvl) * 0.08))" }}
      />
      <span className="relative transition-transform duration-300 [--orb-fg:currentColor] group-active:scale-[0.97]">
        <Orb variant={ORB_FOR_PHASE[phase]} size={56} label={label} />
      </span>
    </button>
  );
}

/** Tiny equalizer bars driven by a 0…1 level ref (no React re-renders per frame). */
export function LevelBars({ levelRef, className, bars = 4 }: { levelRef: RefObject<number>; className?: string; bars?: number }) {
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const t0 = performance.now();
    const tick = () => {
      const el = wrap.current;
      if (el) {
        smooth += ((levelRef.current ?? 0) - smooth) * 0.35;
        const t = (performance.now() - t0) / 1000;
        const children = el.children;
        for (let i = 0; i < children.length; i++) {
          const wobble = 0.55 + 0.45 * Math.sin(t * (7 + i * 2.3) + i);
          const h = 0.18 + Math.min(1, smooth * 1.6) * wobble * 0.82;
          (children[i] as HTMLElement).style.transform = `scaleY(${h.toFixed(3)})`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);
  return (
    <span ref={wrap} aria-hidden className={cn("inline-flex h-3.5 items-center gap-[2px]", className)}>
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className="h-full w-[3px] origin-center rounded-full bg-current transition-none" style={{ transform: "scaleY(0.2)" }} />
      ))}
    </span>
  );
}

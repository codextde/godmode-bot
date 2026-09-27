import { useEffect, useRef, type RefObject } from "react";
import { Orb, type OrbVariant } from "@/components/aicss/Orb";
import { cn } from "@/lib/utils";

export type VoiceOrbPhase = "listening" | "transcribing" | "sending" | "thinking" | "speaking" | "paused";

const ORB_FOR_PHASE: Record<VoiceOrbPhase, OrbVariant> = {
  listening: "C2",
  transcribing: "S2",
  sending: "S2",
  thinking: "B1",
  speaking: "C3",
  paused: "G5",
};

/**
 * The big voice-mode orb: aurora glow + conic ring + glass core, breathing with the
 * audio level (mic while listening, playback while speaking). Level is read from a ref per frame.
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
        "group relative grid size-56 place-items-center rounded-full outline-none sm:size-64",
        "focus-visible:ring-4 focus-visible:ring-ring/40 focus-visible:ring-offset-8 focus-visible:ring-offset-transparent",
        phase === "paused" && "opacity-70 saturate-50",
        className,
      )}
    >
      {/* Soft outer bloom */}
      <span
        aria-hidden
        className="absolute inset-[-30%] rounded-full bg-gradient-brand opacity-35 blur-3xl transition-opacity duration-700 group-data-[phase=speaking]:opacity-55"
        style={{ transform: "scale(calc(0.8 + var(--lvl) * 0.6))" }}
      />
      {/* Rotating conic ring */}
      <span aria-hidden className="absolute inset-0" style={{ transform: "scale(calc(0.94 + var(--lvl) * 0.22))" }}>
        <span
          className={cn(
            "absolute inset-0 animate-spin-slow rounded-full opacity-80 blur-xl",
            "group-data-[phase=speaking]:[animation-duration:2.5s] group-data-[phase=thinking]:[animation-duration:3.5s] group-data-[phase=paused]:[animation-play-state:paused]",
          )}
          style={{ background: "conic-gradient(from 0deg, var(--glow-a), var(--glow-b), var(--glow-c), var(--glow-a))" }}
        />
      </span>
      {/* Glass core */}
      <span
        aria-hidden
        className="absolute inset-[9%] rounded-full border border-white/15 bg-background/55 shadow-[inset_0_2px_30px_rgba(255,255,255,0.08)] backdrop-blur-2xl dark:bg-background/40"
        style={{ transform: "scale(calc(1 + var(--lvl) * 0.1))" }}
      />
      {/* Inner swirl */}
      <span aria-hidden className="absolute inset-[26%]" style={{ transform: "scale(calc(0.7 + var(--lvl) * 0.9))" }}>
        <span className="absolute inset-0 animate-aurora rounded-full bg-gradient-brand opacity-60 blur-2xl" />
      </span>
      <span className="relative transition-transform duration-300 group-hover:scale-105 group-active:scale-95">
        <Orb variant={ORB_FOR_PHASE[phase]} size={46} label={label} />
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

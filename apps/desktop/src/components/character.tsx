import { useEffect, useId, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { motion } from "motion/react";
import type { AgentCharacter, CharacterMood } from "@godmode/shared";
import { characterPhase, renderCharacterSvg } from "@godmode/shared";
import { cn } from "@/lib/utils";

/** How far the eyes may travel (viewBox units) and how far away the pointer must be for the full glance (px). */
const LOOK_MAX = 4;
const LOOK_REACH = 240;

/**
 * An agent's creature. The SVG comes from the shared renderer (inputs are enum-normalized, so the markup is safe to
 * inject); blinking, breathing and moods are CSS (`@godmode/shared/character.css`).
 */
export function Character({
  character,
  color,
  mood = "idle",
  size,
  title,
  follow = false,
  still = false,
  phaseSeed,
  faceScale,
  className,
}: {
  character: AgentCharacter;
  color: string | undefined;
  mood?: CharacterMood;
  /** Pixels, or size classes (e.g. "size-8") so callers can still resize it with `className`. */
  size?: number | string;
  /** Accessible name (also the hover tooltip); omit when the name is written next to it. */
  title?: string;
  /** Eyes follow the pointer. */
  follow?: boolean;
  /** No idle animation — for long lists where a crowd of blinking faces gets busy. */
  still?: boolean;
  /** Offsets the blink/breathe cycle so neighbours don't move in unison (usually the agent id). */
  phaseSeed?: string;
  /** Face enlargement; defaults to 1.25 for tiny pixel sizes so the face still reads. */
  faceScale?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const uid = `gmc${useId().replace(/[^\w-]/g, "")}`;
  const scale = faceScale ?? (typeof size === "number" && size <= 28 ? 1.25 : 1);
  const { body, eyes, mouth, top, face, neck } = character;
  const svg = useMemo(
    // "size-full" keeps icon-sizing rules (`[&_svg:not([class*='size-'])]:size-4` in buttons and menus) off the SVG.
    () => renderCharacterSvg({ body, eyes, mouth, top, face, neck }, { color, mood, uid, faceScale: scale, title, className: "size-full" }),
    [body, eyes, mouth, top, face, neck, color, mood, uid, scale, title],
  );

  useEffect(() => {
    const el = ref.current;
    if (!follow || !el) return;
    let frame = 0;
    let point: { x: number; y: number } | null = null;
    const apply = () => {
      frame = 0;
      if (!point) {
        el.style.removeProperty("--gm-look-x");
        el.style.removeProperty("--gm-look-y");
        return;
      }
      const r = el.getBoundingClientRect();
      const dx = point.x - (r.left + r.width / 2);
      const dy = point.y - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / LOOK_REACH) * LOOK_MAX;
      el.style.setProperty("--gm-look-x", ((dx / d) * k).toFixed(2));
      el.style.setProperty("--gm-look-y", ((dy / d) * k).toFixed(2));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onMove = (e: PointerEvent) => {
      point = { x: e.clientX, y: e.clientY };
      schedule();
    };
    const onLeave = () => {
      point = null;
      schedule();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, [follow]);

  const style: CSSProperties & Record<`--${string}`, string> = { "--gm-phase": `${characterPhase(phaseSeed)}s` };
  if (typeof size === "number") {
    style.width = size;
    style.height = size;
  }

  return (
    <span
      ref={ref}
      style={style}
      className={cn("inline-block shrink-0", typeof size === "string" && size, still && "gm-still", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** A small speech bubble for what a character says; the tail points at the speaker. */
export function SpeechBubble({
  children,
  tail = "bottom",
  className,
  delay = 0.15,
}: {
  children: ReactNode;
  tail?: "top" | "bottom" | "left";
  className?: string;
  delay?: number;
}) {
  const origin = { top: "50% 0%", bottom: "50% 100%", left: "0% 50%" }[tail];
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92, y: tail === "top" ? -4 : tail === "bottom" ? 4 : 0 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 26, delay }}
      style={{ transformOrigin: origin }}
      className={cn("relative rounded-2xl border bg-card px-4 py-2.5 text-[15px] leading-snug text-card-foreground shadow-float", className)}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          "absolute size-3 rotate-45 border bg-card",
          tail === "top" && "-top-[6.5px] left-1/2 -ml-1.5 border-r-0 border-b-0",
          tail === "bottom" && "-bottom-[6.5px] left-1/2 -ml-1.5 border-t-0 border-l-0",
          tail === "left" && "top-1/2 -left-[6.5px] -mt-1.5 border-t-0 border-r-0",
        )}
      />
    </motion.div>
  );
}

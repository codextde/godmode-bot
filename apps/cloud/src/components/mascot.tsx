import { useId, type CSSProperties } from "react";
import { MASCOT_CHARACTER, MASCOT_COLOR, characterPhase, renderCharacterSvg, type CharacterMood } from "@godmode/shared";
import { cn } from "@/lib/utils";

/**
 * Godmode's mascot (the emerald blob with the bolt). Works in server and client components. The SVG comes from the
 * shared renderer, whose inputs are fixed enums, so the markup is safe to inject; blinking and moods are CSS
 * (@godmode/shared/character.css, imported by globals.css) and stop under prefers-reduced-motion.
 */
export function Mascot({
  mood = "idle",
  size = 64,
  title,
  still = false,
  className,
}: {
  mood?: CharacterMood;
  /** Pixels, or size classes such as "size-16". */
  size?: number | string;
  /** Accessible name; leave it out where the mascot is decoration. */
  title?: string;
  /** No idle animation. */
  still?: boolean;
  className?: string;
}) {
  const uid = `gmm${useId().replace(/[^\w-]/g, "")}`;
  const svg = renderCharacterSvg(MASCOT_CHARACTER, {
    color: MASCOT_COLOR,
    mood,
    uid,
    title,
    faceScale: typeof size === "number" && size <= 28 ? 1.25 : 1,
    className: "size-full",
  });
  const style: CSSProperties & Record<`--${string}`, string> = { "--gm-phase": `${characterPhase("godmode")}s` };
  if (typeof size === "number") {
    style.width = size;
    style.height = size;
  }
  return (
    <span
      style={style}
      className={cn("inline-block shrink-0", typeof size === "string" && size, still && "gm-still", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

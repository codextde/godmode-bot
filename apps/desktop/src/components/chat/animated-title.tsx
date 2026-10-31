import { useState } from "react";
import { useReduceAnimations } from "@/lib/motion";

const STEP_MS = 22;

export function AnimatedTitle({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const [fresh, setFresh] = useState(false);
  const spread = useReduceAnimations() ? 300 : 520;
  if (text !== shown) {
    setShown(text);
    setFresh(true);
  }
  if (!fresh) return <>{text}</>;
  const chars = Array.from(text);
  const step = Math.min(STEP_MS, spread / Math.max(chars.length, 1));
  return (
    <span key={text} aria-label={text}>
      {chars.map((ch, i) => (
        <span
          key={i}
          aria-hidden
          className="animate-title-in calm-motion:[animation-duration:0.25s]"
          style={{ animationDelay: `${Math.round(i * step)}ms` }}
          onAnimationEnd={i === chars.length - 1 ? () => setFresh(false) : undefined}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}

import { useState } from "react";

const SPREAD_MS = 520;
const STEP_MS = 22;

export function AnimatedTitle({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const [fresh, setFresh] = useState(false);
  if (text !== shown) {
    setShown(text);
    setFresh(true);
  }
  if (!fresh) return <>{text}</>;
  const chars = Array.from(text);
  const step = Math.min(STEP_MS, SPREAD_MS / Math.max(chars.length, 1));
  return (
    <span key={text} aria-label={text}>
      {chars.map((ch, i) => (
        <span
          key={i}
          aria-hidden
          className="animate-title-in"
          style={{ animationDelay: `${Math.round(i * step)}ms` }}
          onAnimationEnd={i === chars.length - 1 ? () => setFresh(false) : undefined}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}

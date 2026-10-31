import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";

const SPREAD_MS = 520;
const MAX_STEP_MS = 28;

export function useTypewriter(text: string): string {
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState(text);
  const from = useRef(text);

  useEffect(() => {
    const prev = from.current;
    from.current = text;
    if (prev === text) return;
    if (reduceMotion) return setShown(text);
    const target = Array.from(text);
    const old = Array.from(prev);
    let start = 0;
    while (start < target.length && start < old.length && target[start] === old[start]) start++;
    const step = Math.min(MAX_STEP_MS, SPREAD_MS / Math.max(target.length - start, 1));
    const began = Date.now();
    let frame = 0;
    const tick = () => {
      const count = Math.min(target.length, start + 1 + Math.floor((Date.now() - began) / step));
      setShown(target.slice(0, count).join(""));
      if (count < target.length) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [text, reduceMotion]);

  return shown;
}

import { useEffect, useRef, useState } from "react";

const LAG_S = 0.18;
const MIN_CPS = 90;
const COMMIT_MS = 32;
export const FADE_MS = 420;

export interface SmoothText {
  text: string;
  marks: number[];
}

function snapToWord(text: string, at: number) {
  if (at >= text.length) return text.length;
  for (let i = at; i < Math.min(text.length, at + 14); i++) if (/\s/.test(text[i]!)) return i;
  return at;
}

export function useSmoothText(target: string, enabled = true): SmoothText {
  const [state, setState] = useState<SmoothText>(() => ({ text: target, marks: [] }));
  const live = useRef({ target, shown: target.length, exact: target.length, text: target, marks: [] as { at: number; t: number }[], frame: 0, last: 0, commit: 0 });

  useEffect(() => {
    const s = live.current;
    s.target = target;
    if (!enabled || target.length < s.shown || !target.startsWith(s.text)) {
      s.shown = s.exact = target.length;
      s.text = target;
      s.marks = [];
      if (s.frame) cancelAnimationFrame(s.frame);
      s.frame = 0;
      setState({ text: target, marks: [] });
      return;
    }
    if (s.frame || s.shown >= target.length) return;
    const step = (now: number) => {
      const len = s.target.length;
      const dt = Math.min(0.1, s.last ? (now - s.last) / 1000 : 1 / 60);
      s.last = now;
      const backlog = len - s.exact;
      s.exact = Math.min(len, s.exact + Math.max(MIN_CPS, backlog / LAG_S) * dt);
      const next = Math.max(s.shown, snapToWord(s.target, Math.floor(s.exact)));
      const done = next >= len;
      if (next > s.shown && (done || now - s.commit >= COMMIT_MS)) {
        s.marks = s.marks.filter((m) => now - m.t < FADE_MS);
        s.marks.push({ at: s.shown, t: now });
        s.shown = next;
        s.exact = Math.max(s.exact, next);
        s.commit = now;
        s.text = s.target.slice(0, next);
        setState({ text: s.target.slice(0, next), marks: s.marks.map((m) => m.at) });
      }
      if (done) {
        s.frame = 0;
        s.last = 0;
        return;
      }
      s.frame = requestAnimationFrame(step);
    };
    s.frame = requestAnimationFrame(step);
  }, [target, enabled]);

  useEffect(() => () => cancelAnimationFrame(live.current.frame), []);

  return state;
}

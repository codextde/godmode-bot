import { useEffect, useRef, useState } from "react";
import { specDocument } from "@godmode/shared";
import { cn } from "@/lib/utils";
import { useReduceAnimations } from "@/lib/motion";
import { ArtifactFrame } from "./artifact-frame";
import { parsePartialJson, safePartialHtml } from "./partial";

const RELOAD_MS = 700;

export interface LiveInput {
  title?: string;
  html?: string;
  spec?: unknown;
  specText?: string;
  data?: unknown;
  dataText?: string;
}

function documentOf(input: LiveInput, title: string, lastSpec: { current: unknown }): string | null {
  if (typeof input.html === "string") {
    const html = safePartialHtml(input.html);
    return html.trim() ? html : null;
  }
  const spec = input.spec !== undefined && typeof input.spec === "object" ? input.spec : parsePartialJson(input.specText);
  if (spec && typeof spec === "object") lastSpec.current = spec;
  if (!lastSpec.current) return null;
  try {
    return specDocument(lastSpec.current as Parameters<typeof specDocument>[0], title);
  } catch {
    return null;
  }
}

export function hasLivePreview(input: LiveInput | undefined): boolean {
  if (!input) return false;
  return (typeof input.html === "string" && input.html.trim() !== "") || !!input.specText?.trim() || (input.spec !== undefined && input.spec !== null);
}

export function LivePreview({ input, title, className }: { input: LiveInput; title: string; className?: string }) {
  const reduce = useReduceAnimations();
  const lastSpec = useRef<unknown>(undefined);
  const lastData = useRef<unknown>(null);
  const doc = documentOf(input, title, lastSpec);
  const parsedData = input.data !== undefined ? input.data : parsePartialJson(input.dataText);
  if (parsedData !== undefined) lastData.current = parsedData;
  const data = lastData.current;

  const [slots, setSlots] = useState<[string | null, string | null]>([null, null]);
  const [front, setFront] = useState(0);
  const loadedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanted = useRef<string | null>(null);
  wanted.current = doc;

  useEffect(() => {
    if (!doc) return;
    const load = () => {
      timer.current = null;
      const next = wanted.current;
      if (!next) return;
      loadedAt.current = Date.now();
      setSlots((s) => {
        const back = 1 - front;
        if (s[front] === next || s[back] === next) return s;
        const out: [string | null, string | null] = [s[0], s[1]];
        out[s[front] === null ? front : back] = next;
        return out;
      });
    };
    if (timer.current) return;
    const wait = RELOAD_MS - (Date.now() - loadedAt.current);
    if (wait <= 0) load();
    else timer.current = setTimeout(load, wait);
  }, [doc, front]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className={cn("relative overflow-hidden rounded-xl border bg-paper-2 shadow-card", className)}>
      {slots.map((html, i) =>
        html === null ? null : (
          <ArtifactFrame
            key={i}
            html={html}
            data={data}
            title={title}
            interactive={false}
            onReady={() => {
              setTimeout(() => setFront(i), 60);
            }}
            className={cn("absolute inset-0 size-full", !reduce && "transition-opacity duration-150", i === front ? "opacity-100" : "opacity-0")}
          />
        ),
      )}
    </div>
  );
}

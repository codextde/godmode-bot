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

function documentOf(input: LiveInput, title: string, lastSpec: unknown): string | null {
  if (typeof input.html === "string") {
    const html = safePartialHtml(input.html);
    return html.trim() ? html : null;
  }
  if (!lastSpec) return null;
  try {
    return specDocument(lastSpec as Parameters<typeof specDocument>[0], title);
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
  const specSource = input.spec !== undefined && typeof input.spec === "object" ? input.spec : input.specText;
  const [lastSpec, setLastSpec] = useState<{ source: unknown; spec: unknown }>({ source: undefined, spec: undefined });
  let spec = lastSpec.spec;
  if (typeof input.html !== "string" && specSource !== lastSpec.source) {
    const parsedSpec = input.spec !== undefined && typeof input.spec === "object" ? input.spec : parsePartialJson(input.specText);
    if (parsedSpec && typeof parsedSpec === "object") {
      spec = parsedSpec;
      setLastSpec({ source: specSource, spec: parsedSpec });
    }
  }
  const doc = documentOf(input, title, spec);
  const dataSource = input.data !== undefined ? input.data : input.dataText;
  const [lastData, setLastData] = useState<{ source: unknown; data: unknown }>({ source: undefined, data: null });
  let data = lastData.data;
  if (dataSource !== lastData.source) {
    const parsedData = input.data !== undefined ? input.data : parsePartialJson(input.dataText);
    if (parsedData !== undefined) {
      data = parsedData;
      setLastData({ source: dataSource, data: parsedData });
    }
  }

  const [slots, setSlots] = useState<[string | null, string | null]>([null, null]);
  const [front, setFront] = useState(0);
  const loadedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanted = useRef<string | null>(null);

  useEffect(() => {
    wanted.current = doc;
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

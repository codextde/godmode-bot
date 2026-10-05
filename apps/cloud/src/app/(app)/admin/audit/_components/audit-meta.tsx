import { ChevronDown } from "lucide-react";

/** The `meta` of an audit entry behind a "Details" toggle (a native <details>, so it needs no script). */
export function AuditMeta({ meta }: { meta: Record<string, unknown> | null }) {
  const entries = meta ? Object.entries(meta) : [];
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <details className="group min-w-0">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:py-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
        {entries.length === 1 ? "1 detail" : `${entries.length} details`}
      </summary>
      <dl className="mt-2 space-y-1 rounded-md border bg-paper-2 p-2.5 text-left font-mono text-[11px] tabular-nums">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">{key}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

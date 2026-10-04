import type { ReactNode } from "react";
import type { PageWidth } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/*
 * Loading states shaped like the page they stand in for (house rule 9): the real card chrome with placeholder lines
 * inside. No full-page spinners. A route's loading.tsx is usually one line:
 *
 *   export default function Loading() { return <PageSkeleton variant="list" />; }
 */

const WIDTH: Record<PageWidth, string> = { list: "max-w-6xl", form: "max-w-3xl", full: "" };

// Fixed, varied widths so placeholder rows don't look stamped out (and render the same on server and client).
const LINE_WIDTHS = ["w-40", "w-28", "w-48", "w-32", "w-36", "w-24", "w-44"];
const line = (i: number) => LINE_WIDTHS[i % LINE_WIDTHS.length];

function Busy({ children, label = "Loading…" }: { children: ReactNode; label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden>{children}</div>
    </div>
  );
}

export function PageHeaderSkeleton({ width = "list", action = false }: { width?: PageWidth; action?: boolean }) {
  return (
    <div className="px-5 pt-6 pb-5 @2xl:px-8 @2xl:pt-8 @2xl:pb-6">
      <div className={cn("mx-auto flex w-full items-start justify-between gap-4", WIDTH[width])}>
        <div className="flex items-start gap-3.5">
          <Skeleton className="mt-0.5 size-10 rounded-lg" />
          <div className="space-y-2.5 pt-1">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-3.5 w-64 max-w-[60vw]" />
          </div>
        </div>
        {action && <Skeleton className="h-9 w-28 shrink-0" />}
      </div>
    </div>
  );
}

/** A DataTable placeholder: toolbar, header row and rows (stacked cards on narrow lists). */
export function ListSkeleton({ rows = 6, columns = 4, toolbar = true }: { rows?: number; columns?: number; toolbar?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {toolbar && (
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-9 w-full @xl:w-72" />
          <Skeleton className="hidden h-9 w-36 @2xl:block" />
        </div>
      )}
      <div className="@container/table overflow-hidden rounded-xl border bg-card shadow-card">
        <div className="hidden @2xl/table:block">
          <div className="flex gap-6 border-b bg-paper-2/70 px-5 py-3">
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton key={c} className={cn("h-3", c === 0 ? "w-24" : "w-16")} />
            ))}
          </div>
          <div className="divide-y">
            {Array.from({ length: rows }, (_, r) => (
              <div key={r} className="flex items-center gap-6 px-5 py-3.5">
                {Array.from({ length: columns }, (_, c) => (
                  <Skeleton key={c} className={cn("h-3.5", c === 0 ? line(r) : "w-20")} />
                ))}
                <Skeleton className="ml-auto size-6 rounded-md" />
              </div>
            ))}
          </div>
        </div>
        <div className="divide-y @2xl/table:hidden">
          {Array.from({ length: Math.min(rows, 5) }, (_, r) => (
            <div key={r} className="space-y-2.5 px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className={cn("h-4", line(r))} />
                <Skeleton className="size-6 rounded-md" />
              </div>
              <div className="flex justify-between gap-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="flex justify-between gap-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-14" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A SettingsGroup placeholder: header with icon tile, then label/control rows. */
export function FormSkeleton({ rows = 3, footer = true }: { rows?: number; footer?: boolean }) {
  return (
    <div className="rounded-xl border bg-card shadow-card">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <Skeleton className="size-8 rounded-lg" />
        <div className="space-y-2 pt-0.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-56 max-w-[50vw]" />
        </div>
      </div>
      <div className="divide-y px-5">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="space-y-2">
              <Skeleton className={cn("h-3.5", line(r))} />
              <Skeleton className="h-3 w-52 max-w-[50vw]" />
            </div>
            <Skeleton className="h-9 w-full @xl:w-56" />
          </div>
        ))}
      </div>
      {footer && (
        <div className="flex justify-end rounded-b-xl border-t bg-paper-2/60 px-5 py-3">
          <Skeleton className="h-9 w-20" />
        </div>
      )}
    </div>
  );
}

/** A grid of cards (computers, plans). */
export function CardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-4 rounded-xl border bg-card p-5 shadow-card">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className={cn("h-4", line(i))} />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-9" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A row of StatCards. */
export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 @md:grid-cols-2 @4xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-3 rounded-xl border bg-card p-4 shadow-card @2xl:p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

/** A ChartCard placeholder. */
export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-card">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-2 h-3 w-20" />
      <Skeleton className="mt-5 w-full rounded-lg" style={{ height: height - 20 }} />
    </div>
  );
}

/** A whole page: header plus a body shaped like a list, a form, a card grid or a dashboard. */
export function PageSkeleton({
  variant = "list",
  width,
  action = variant === "list",
}: {
  variant?: "list" | "form" | "cards" | "dashboard";
  width?: PageWidth;
  action?: boolean;
}) {
  const w = width ?? (variant === "form" ? "form" : "list");
  return (
    <Busy>
      <PageHeaderSkeleton width={w} action={action} />
      <div className="px-5 pb-10 @2xl:px-8">
        <div className={cn("mx-auto flex w-full flex-col gap-5", WIDTH[w])}>
          {variant === "list" && <ListSkeleton />}
          {variant === "form" && (
            <>
              <FormSkeleton rows={3} />
              <FormSkeleton rows={2} />
            </>
          )}
          {variant === "cards" && <CardsSkeleton />}
          {variant === "dashboard" && (
            <>
              <StatsSkeleton />
              <div className="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
                <ChartSkeleton />
                <ChartSkeleton />
              </div>
              <ListSkeleton rows={5} toolbar={false} />
            </>
          )}
        </div>
      </div>
    </Busy>
  );
}

export { Busy as SkeletonRegion };

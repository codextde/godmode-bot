"use client";

import { useEffect, useState } from "react";
import { formatDate, formatRelative, toDate, type DateInput } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "5 minutes ago", with the absolute time in `title` (house rule 15). Re-renders every 30 s and switches to the
 * browser's time zone after hydration. `null` prints `fallback`.
 */
export function RelativeTime({
  date,
  fallback = "Never",
  className,
}: {
  date: DateInput | null | undefined;
  fallback?: string;
  className?: string;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (date === null || date === undefined) return <span className={cn("text-muted-foreground", className)}>{fallback}</span>;
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return <span className={cn("text-muted-foreground", className)}>{fallback}</span>;
  return (
    <time dateTime={d.toISOString()} title={formatDate(d, "datetime")} className={className} suppressHydrationWarning>
      {formatRelative(d, now ?? undefined)}
    </time>
  );
}

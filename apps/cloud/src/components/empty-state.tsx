import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Nothing here yet (house rule 10): icon tile, one sentence, one action. First-run states pass the Mascot as `art`
 * and the way forward as numbered `steps`. Also the body of every route's error.tsx (see RouteError).
 */
export function EmptyState({
  icon,
  art,
  title,
  description,
  steps,
  action,
  className,
}: {
  icon?: ReactNode;
  /** A larger illustration (usually <Mascot />) shown instead of the icon tile. */
  art?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Numbered steps, e.g. how to link the first computer. */
  steps?: ReactNode[];
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "animate-enter flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center @2xl:py-14",
        className,
      )}
    >
      {art && <div className="mb-4">{art}</div>}
      {icon && !art && (
        <div
          aria-hidden
          className="mb-4 grid size-11 place-items-center rounded-lg border bg-card text-foreground shadow-card [&_svg]:size-5"
        >
          {icon}
        </div>
      )}
      <h2 className="text-base font-medium tracking-[-0.01em]">{title}</h2>
      {description && <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>}
      {steps && steps.length > 0 && (
        <ol className="mt-6 w-full max-w-md space-y-3 text-left">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span
                aria-hidden
                className="grid size-6 shrink-0 place-items-center rounded-md border bg-card font-mono text-[11px] font-medium text-foreground tabular-nums shadow-card"
              >
                {i + 1}
              </span>
              <div className="min-w-0 pt-0.5 leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
                {step}
              </div>
            </li>
          ))}
        </ol>
      )}
      {action && <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

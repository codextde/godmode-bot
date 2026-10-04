import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Card grouping related content (house rule 5): `rounded-xl border bg-card shadow-card`, rows divided by hairlines.
 * Never put a card inside it. `footer` holds the group's explicit Save (a SubmitButton) or other actions.
 */
export function SettingsGroup({
  id,
  title,
  description,
  icon,
  actions,
  children,
  footer,
  tone,
  className,
  bodyClassName,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Small controls on the right of the header (a badge, a secondary button). */
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: "danger";
  className?: string;
  /** Use "px-0" for edge-to-edge content such as a DataTable. */
  bodyClassName?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        "animate-enter scroll-mt-6 rounded-xl border bg-card shadow-card",
        tone === "danger" && "border-destructive/25",
        className,
      )}
    >
      <header className={cn("flex flex-wrap items-start justify-between gap-3 px-5 py-4", (children || footer) && "border-b")}>
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
          {icon && (
            <div
              aria-hidden
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground [&_svg]:size-4",
                tone === "danger" && "border-destructive/20 bg-destructive/[0.06] text-destructive",
              )}
            >
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">{title}</h2>
            {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children && <div className={cn("divide-y px-5", bodyClassName)}>{children}</div>}
      {footer && (
        <footer className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t bg-paper-2/60 px-5 py-3">
          {footer}
        </footer>
      )}
    </section>
  );
}

/** Label and description on the left, control on the right — or below with `stacked` (text fields, lists). */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
  stacked = false,
  className,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** The id of the control, so clicking the label focuses it. */
  htmlFor?: string;
  children?: ReactNode;
  stacked?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-x-6 gap-y-2.5 py-4",
        stacked ? "flex-col" : "flex-wrap items-center justify-between @xl:flex-nowrap",
        disabled && "opacity-60",
        className,
      )}
    >
      <div className={cn("min-w-0 space-y-1", stacked ? "flex-1" : "grow basis-56")}>
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description && <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>}
      </div>
      {children !== undefined && <div className={cn(stacked ? "w-full" : "flex shrink-0 items-center gap-2")}>{children}</div>}
    </div>
  );
}

/** A "key: value" row for read-only facts. `mono` for ids, versions, addresses and amounts. */
export function InfoRow({
  label,
  children,
  mono,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3 text-sm", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("flex min-w-0 items-center gap-1.5 text-right break-all", mono && "font-mono text-xs tabular-nums")}>
        {children}
      </span>
    </div>
  );
}

const CALLOUT = {
  info: { cls: "border-border bg-paper-2", icon: <Info className="text-foreground" /> },
  warning: { cls: "border-warning/30 bg-warning/[0.07]", icon: <TriangleAlert className="text-warning" /> },
  danger: { cls: "border-destructive/30 bg-destructive/[0.06]", icon: <ShieldAlert className="text-destructive" /> },
  success: { cls: "border-brand/25 bg-brand-soft", icon: <CircleCheck className="text-brand-strong" /> },
  muted: { cls: "border-border bg-secondary/60", icon: <CircleAlert className="text-muted-foreground" /> },
} as const;

export type CalloutTone = keyof typeof CALLOUT;

/**
 * A boxed notice. Form errors are `tone="danger"` with a title starting "Could not …". Danger callouts are announced
 * (role="alert"); pass `role` to change that.
 */
export function Callout({
  tone = "info",
  title,
  children,
  icon,
  action,
  role,
  className,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  /** A button or link shown beside the text (below it when narrow). */
  action?: ReactNode;
  role?: "alert" | "status" | "note";
  className?: string;
}) {
  const t = CALLOUT[tone];
  return (
    <div
      className={cn("flex flex-wrap items-start gap-x-3 gap-y-2.5 rounded-lg border p-3.5 text-sm", t.cls, className)}
      role={role ?? (tone === "danger" ? "alert" : undefined)}
    >
      <div className="flex min-w-0 flex-1 basis-60 gap-3">
        <span aria-hidden className="mt-0.5 shrink-0 [&_svg]:size-4">
          {icon ?? t.icon}
        </span>
        <div className="min-w-0 space-y-1">
          {title && <p className="font-medium">{title}</p>}
          {children && <div className="text-xs leading-relaxed text-muted-foreground [&_a]:font-medium [&_a]:text-foreground [&_a]:underline-offset-4 [&_a:hover]:underline">{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 pl-7">{action}</div>}
    </div>
  );
}

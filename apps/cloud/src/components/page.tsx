import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Page widths (house rule 1): lists and dashboards `max-w-6xl`, forms `max-w-3xl`. Pass the same width to
 * PageHeader and PageBody so their edges line up.
 */
export type PageWidth = "list" | "form" | "full";

const WIDTH: Record<PageWidth, string> = {
  list: "max-w-6xl",
  form: "max-w-3xl",
  full: "",
};

/**
 * The top of every page: optional back link, quiet icon tile, title (the page's only h1), one sentence and at most
 * one primary action. Responds to the shell's scroll-area width, not the viewport.
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  back,
  badge,
  width = "list",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** A link one level up, e.g. { href: "/admin/users", label: "People" } on a person's page. */
  back?: { href: string; label: string };
  /** Shown after the title, e.g. a StatusBadge. */
  badge?: ReactNode;
  width?: PageWidth;
  className?: string;
}) {
  return (
    <header className={cn("px-5 pt-6 pb-5 @2xl:px-8 @2xl:pt-8 @2xl:pb-6", className)}>
      <div className={cn("mx-auto w-full", WIDTH[width])}>
        {back && (
          <Link
            href={back.href}
            className="-ml-1 mb-3 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:py-2"
          >
            <ChevronLeft className="size-4" aria-hidden />
            {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-3.5">
            {icon && (
              <div
                aria-hidden
                className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card [&_svg]:size-[18px]"
              >
                {icon}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <h1 className="text-[23px] leading-tight font-medium tracking-[-0.03em] break-words">{title}</h1>
                {badge}
              </div>
              {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>
    </header>
  );
}

/** The page's content column. Children are stacked with the house rhythm (20 px). */
export function PageBody({
  children,
  width = "list",
  className,
}: {
  children: ReactNode;
  width?: PageWidth;
  className?: string;
}) {
  return (
    <div className="px-5 pb-[calc(2.5rem+env(safe-area-inset-bottom))] @2xl:px-8">
      <div className={cn("mx-auto flex w-full flex-col gap-5", WIDTH[width], className)}>{children}</div>
    </div>
  );
}

/** A plain titled card with padded content — for detail pages whose content is not a list of rows. */
export function Section({
  id,
  title,
  description,
  children,
  actions,
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("animate-enter scroll-mt-6 rounded-xl border bg-card p-5 shadow-card", className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Sub-navigation beside content (settings groups): a scrolling strip on narrow containers, a sticky 13 rem column from
 * `@4xl`. Put a `SectionNav` in `nav`; the content column is capped at `max-w-3xl`.
 */
export function SectionLayout({ nav, children, className }: { nav: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-5 @4xl:flex-row @4xl:items-start @4xl:gap-8", className)}>
      <div className="min-w-0 @4xl:sticky @4xl:top-6 @4xl:w-52 @4xl:shrink-0">{nav}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-5 @4xl:max-w-3xl">{children}</div>
    </div>
  );
}

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { Backdrop, Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SetupStep {
  id: string;
  title: string;
  hint?: string;
  optional?: boolean;
}

/**
 * The first-run wizard frame: brand and "Step N of M" on top, a numbered step rail on the left from `lg`, a slim
 * progress bar below it, and the step's content. `current` is the 0-based index of the step on screen.
 * Build the step itself from StepHeader, StepCard and StepFooter.
 */
export function SetupShell({
  steps,
  current,
  appName,
  aside,
  children,
}: {
  steps: SetupStep[];
  current: number;
  appName?: string;
  /** Under the rail (wide screens): a help line or the setup code hint. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const index = Math.min(Math.max(current, 0), steps.length - 1);
  return (
    <div className="relative flex min-h-svh flex-col bg-background">
      <Backdrop rails={false} />
      <header className="relative z-10 flex items-center justify-between gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
        <Brand appName={appName} />
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            Step {index + 1} of {steps.length}
          </span>
          <ThemeToggle variant="icon" />
        </div>
      </header>
      <div className="relative mx-auto flex w-full max-w-5xl flex-1 gap-12 px-4 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-12 lg:pt-16">
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-10 space-y-8">
            <StepRail steps={steps} current={index} />
            {aside && <div className="text-xs leading-relaxed text-muted-foreground">{aside}</div>}
          </div>
        </aside>
        <main className="min-w-0 flex-1 lg:max-w-2xl">
          <StepProgress steps={steps} current={index} />
          <div key={steps[index]?.id} className="animate-enter">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Vertical numbered rail (wide screens): done steps show a check, the current one is raised. */
export function StepRail({ steps, current }: { steps: SetupStep[]; current: number }) {
  return (
    <ol className="relative space-y-1" aria-label="Setup steps">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.id} className="relative flex gap-3 py-2" aria-current={active ? "step" : undefined}>
            {i < steps.length - 1 && (
              <span aria-hidden className={cn("absolute top-11 bottom-[-6px] left-[17px] w-px", done ? "bg-foreground" : "bg-border")} />
            )}
            <div
              className={cn(
                "relative grid size-9 shrink-0 place-items-center rounded-lg border font-mono text-[13px] font-medium tabular-nums transition-colors duration-300",
                done && "border-transparent bg-primary text-primary-foreground",
                active && "border-foreground/20 bg-card text-foreground shadow-card ring-[3px] ring-foreground/[0.04]",
                !done && !active && "bg-card/60 text-muted-foreground",
              )}
            >
              {done ? <Check className="size-4" aria-hidden /> : i + 1}
              {done && <span className="sr-only">Done:</span>}
            </div>
            <div className="min-w-0 pt-0.5">
              <p className={cn("text-sm font-medium tracking-[-0.01em]", !active && !done && "text-muted-foreground")}>
                {s.title}
                {s.optional && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">optional</span>}
              </p>
              {s.hint && <p className="truncate text-xs text-muted-foreground">{s.hint}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Segmented progress bar (narrow screens). */
export function StepProgress({ steps, current }: { steps: SetupStep[]; current: number }) {
  return (
    <div className="mb-8 lg:hidden">
      <div className="mb-2.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate font-medium text-foreground">{steps[current]?.title}</span>
      </div>
      <div
        className="flex gap-1"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={current + 1}
        aria-valuetext={`Step ${current + 1} of ${steps.length}: ${steps[current]?.title ?? ""}`}
      >
        {steps.map((s, i) => (
          <div key={s.id} className="h-1 flex-1 overflow-hidden rounded-[2px] bg-foreground/[0.07]">
            <div className={cn("h-full rounded-[2px] bg-foreground transition-[width] duration-500", i <= current ? "w-full" : "w-0")} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The heading of a step, on the paper above its card. */
export function StepHeader({ eyebrow, title, description }: { eyebrow?: string; title: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-7">
      {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
      <h1 className="heading-display text-[30px] sm:text-[34px]">{title}</h1>
      {description && <div className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted-foreground">{description}</div>}
    </div>
  );
}

/** The card holding a step's form. */
export function StepCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border bg-card p-5 shadow-float sm:p-7", className)}>{children}</div>;
}

/**
 * Back link and the step's actions. Sticks to the bottom of the screen on phones so the primary action stays in reach.
 */
export function StepFooter({ backHref, children, className }: { backHref?: string; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mt-7 flex flex-wrap items-center justify-between gap-3 border-t pt-5",
        "max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-4 max-md:bg-background/90 max-md:px-4 max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-md:backdrop-blur-md",
        className,
      )}
    >
      {backHref ? (
        <Button variant="ghost" asChild className="text-muted-foreground">
          <Link href={backHref}>
            <ArrowLeft /> Back
          </Link>
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

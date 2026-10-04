"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

/** Pill segmented control with a sliding active indicator (a radio group; arrow keys move the choice). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  "aria-label": ariaLabel,
  disabled,
  size = "default",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode; "aria-label"?: string }[];
  className?: string;
  "aria-label": string;
  disabled?: boolean;
  size?: "default" | "sm";
}) {
  const layoutId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.value === value);
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex max-w-full flex-wrap rounded-lg border bg-secondary p-0.5",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o["aria-label"]}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative flex-1 rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
              size === "sm" ? "h-7 px-2.5 text-[13px] pointer-coarse:h-10" : "h-8 pointer-coarse:h-10",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                aria-hidden
                className="absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border dark:bg-accent"
                transition={{ type: "spring", stiffness: 420, damping: 36 }}
              />
            )}
            <span className="relative flex items-center justify-center gap-1.5 [&_svg]:size-3.5">
              {o.icon}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  title: ReactNode;
  description: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

/** Radio options as selectable cards — one column, two from `@xl` (override with `className`, e.g. `@3xl:grid-cols-3`). */
export function ChoiceCards<T extends string>({
  value,
  onChange,
  options,
  name,
  "aria-label": ariaLabel,
  disabled,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ChoiceOption<T>[];
  /** Also used for the radio ids, so keep it unique on the page. */
  name: string;
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as T)}
      name={name}
      disabled={disabled}
      aria-label={ariaLabel ?? name}
      className={cn("grid grid-cols-1 gap-3 @xl:grid-cols-2", className)}
    >
      {options.map((o) => {
        const checked = o.value === value;
        const id = `${name}-${o.value}`;
        const off = disabled || o.disabled;
        return (
          <label
            key={o.value}
            htmlFor={id}
            className={cn(
              "relative flex cursor-pointer gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-foreground/15",
              checked && "border-foreground/40 bg-paper-2 ring-1 ring-foreground/10 hover:border-foreground/40",
              off && "cursor-not-allowed opacity-60 hover:border-border",
            )}
          >
            <RadioGroupItem value={o.value} id={id} disabled={o.disabled} className="mt-0.5" />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-foreground">
                {o.icon}
                {o.title}
                {o.badge}
              </div>
              <div className="text-xs leading-relaxed text-muted-foreground">{o.description}</div>
            </div>
          </label>
        );
      })}
    </RadioGroup>
  );
}

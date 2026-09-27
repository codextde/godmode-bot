import { useMemo, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Check } from "lucide-react";
import { DrawCheck } from "@/components/aicss/Motion";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/vault/password-input";
import { StrengthMeter } from "@/components/vault/strength-meter";
import { cn } from "@/lib/utils";

export interface StepMeta {
  id: string;
  title: string;
  hint: string;
  icon: ReactNode;
  optional?: boolean;
}

/** Vertical progress rail (wide screens). */
export function StepRail({ steps, current }: { steps: StepMeta[]; current: number }) {
  return (
    <ol className="relative space-y-1" aria-label="Setup steps">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.id} className="relative flex gap-3 py-2" aria-current={active ? "step" : undefined}>
            {i < steps.length - 1 && (
              <span aria-hidden className="absolute top-11 bottom-[-6px] left-[17px] w-px overflow-hidden bg-border">
                <motion.span
                  className="block w-full bg-foreground"
                  initial={false}
                  animate={{ height: done ? "100%" : "0%" }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
              </span>
            )}
            <div
              className={cn(
                "relative grid size-9 shrink-0 place-items-center rounded-lg border transition-colors duration-300 [&_svg]:size-4",
                done && "border-transparent bg-primary text-primary-foreground",
                active && "border-foreground/20 bg-card text-foreground shadow-card ring-[3px] ring-foreground/[0.04]",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? <DrawCheck /> : s.icon}
            </div>
            <div className="min-w-0 pt-0.5">
              <p className={cn("text-sm font-medium tracking-[-0.01em] transition-colors", !active && !done && "text-muted-foreground")}>
                {s.title}
                {s.optional && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">optional</span>}
              </p>
              <p className="truncate text-xs text-muted-foreground">{s.hint}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Compact progress bar (narrow screens). */
export function StepProgress({ steps, current }: { steps: StepMeta[]; current: number }) {
  return (
    <div className="mb-8 lg:hidden">
      <div className="mb-2.5 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{steps[current]?.title}</span>
        <span className="font-mono text-[11px] tabular-nums">
          Step {current + 1} of {steps.length}
        </span>
      </div>
      <div className="flex gap-1">
        {steps.map((s, i) => (
          <div key={s.id} className="h-1 flex-1 overflow-hidden rounded-[2px] bg-foreground/[0.07]">
            <motion.div
              className="h-full rounded-[2px] bg-foreground"
              initial={false}
              animate={{ width: i <= current ? "100%" : "0%" }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Hero heading that sits on the paper above a step's card. */
export function StepHeader({ eyebrow, title, description }: { eyebrow?: string; title: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-7">
      {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
      <h2 className="heading-display text-[30px] sm:text-[34px]">{title}</h2>
      {description && <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  );
}

/** Solid white hairline card that holds a step's form. */
export function StepCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border bg-card p-6 shadow-float sm:p-7", className)}>{children}</div>;
}

/** Back + primary actions row. */
export function StepFooter({ onBack, children, className }: { onBack?: () => void; children: ReactNode; className?: string }) {
  return (
    <div className={cn("mt-7 flex flex-wrap items-center justify-between gap-3 border-t pt-5", className)}>
      {onBack ? (
        <Button type="button" variant="ghost" onClick={onBack} className="text-muted-foreground">
          <ArrowLeft /> Back
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function secretValid(value: string, confirm: string, minLength: number) {
  return value.length >= minLength && value === confirm;
}

/** New secret + confirmation with strength meter (vault passphrase, dashboard password). */
export function NewSecretFields({
  idPrefix,
  label,
  value,
  confirm,
  onChange,
  onConfirmChange,
  minLength,
  userInputs,
  autoFocus,
}: {
  idPrefix: string;
  label: string;
  value: string;
  confirm: string;
  onChange: (v: string) => void;
  onConfirmChange: (v: string) => void;
  minLength: number;
  userInputs?: string[];
  autoFocus?: boolean;
}) {
  const tooShort = value.length > 0 && value.length < minLength;
  const mismatch = confirm.length > 0 && confirm !== value;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-new`}>{label}</Label>
        <PasswordInput
          id={`${idPrefix}-new`}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={tooShort}
          aria-describedby={`${idPrefix}-hint`}
          placeholder={`At least ${minLength} characters`}
        />
        <StrengthMeter password={value} userInputs={userInputs} />
        {tooShort && (
          <p id={`${idPrefix}-hint`} className="text-xs text-destructive">
            Use at least {minLength} characters.
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-confirm`}>Confirm</Label>
        <PasswordInput
          id={`${idPrefix}-confirm`}
          value={confirm}
          onChange={(e) => onConfirmChange(e.target.value)}
          aria-invalid={mismatch}
          placeholder="Type it again"
          trailing={
            confirm.length > 0 && !mismatch ? <Check className="size-4 text-success" aria-label="Matches" /> : undefined
          }
        />
        {mismatch && <p className="text-xs text-destructive">Doesn't match yet.</p>}
      </div>
    </div>
  );
}

/** Paper-and-ink confetti with the one brand accent — no rainbow. */
const CONFETTI_COLORS = [
  "var(--foreground)",
  "var(--brand)",
  "var(--muted-foreground)",
  "var(--brand-strong)",
  "color-mix(in oklab, var(--foreground) 22%, transparent)",
];

/** One-shot confetti burst (skipped for reduced motion). */
export function Confetti({ pieces = 90 }: { pieces?: number }) {
  const reduce = useReducedMotion();
  const bits = useMemo(
    () =>
      Array.from({ length: pieces }, (_, i) => {
        const angle = (Math.random() * Math.PI) / 1.2 + Math.PI / 12;
        const power = 260 + Math.random() * 420;
        return {
          id: i,
          x: Math.cos(angle) * power * (Math.random() > 0.5 ? 1 : -1),
          y: -Math.sin(angle) * power * 0.9,
          fall: 380 + Math.random() * 420,
          rotate: (Math.random() - 0.5) * 900,
          color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          w: 5 + Math.random() * 5,
          h: Math.random() > 0.4 ? 9 + Math.random() * 6 : 6,
          round: Math.random() > 0.7,
          delay: Math.random() * 0.15,
          duration: 1.8 + Math.random() * 1.2,
        };
      }),
    [pieces],
  );
  if (reduce) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {bits.map((b) => (
        <motion.span
          key={b.id}
          className="absolute top-[42%] left-1/2 block"
          style={{ width: b.w, height: b.h, background: b.color, borderRadius: b.round ? 999 : 1 }}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.6 }}
          animate={{ x: b.x, y: [0, b.y, b.y + b.fall], opacity: [1, 1, 0], rotate: b.rotate, scale: 1 }}
          transition={{ duration: b.duration, delay: b.delay, ease: [0.16, 0.8, 0.4, 1], times: [0, 0.35, 1] }}
        />
      ))}
    </div>
  );
}

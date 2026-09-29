import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { CircleAlert, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Settings } from "@godmode/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, type DeepPartial } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v as DeepPartial<unknown>) : v;
  }
  return out as T;
}

/** Optimistic settings update (PUT /api/settings with a partial) with rollback + a de-duplicated "Saved" toast. */
export function useSettingsPatch() {
  const qc = useQueryClient();
  const m = useMutation({
    // Some changes (secret access "reveal") need a vault passphrase grant; withGrant asks for it when the core does.
    mutationFn: (p: DeepPartial<Settings>) => withGrant((grant) => api.settings.update(p, grant)),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: qk.settings });
      const prev = qc.getQueryData<Settings>(qk.settings);
      if (prev) qc.setQueryData<Settings>(qk.settings, deepMerge(prev, p));
      return { prev };
    },
    onError: (err, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.settings, ctx.prev);
      if (!isGrantCancelled(err)) toastApiError(err, "Could not save settings", qc);
    },
    onSuccess: (next) => {
      if (isPlainObject(next) && "general" in next) qc.setQueryData(qk.settings, next);
      else void qc.invalidateQueries({ queryKey: qk.settings });
      toast.success("Saved", { id: "settings-saved", duration: 1200 });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });
  return { patch: m.mutate, patchAsync: m.mutateAsync, isPending: m.isPending };
}

/**
 * Local draft for a text-like value that commits after `delay` ms idle (null = only on blur/Enter).
 * Pending edits are flushed on unmount (e.g. when switching sections).
 */
function useCommitDraft<T>(value: T, onCommit: (v: T) => void, delay: number | null = 600) {
  const [draft, setDraftState] = useState(value);
  const focused = useRef(false);
  const dirty = useRef(false);
  const committed = useRef(value);
  const latest = useRef({ draft: value, onCommit });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = { draft, onCommit };

  useEffect(() => {
    committed.current = value;
    if (!focused.current && !dirty.current) setDraftState(value);
  }, [value]);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const flush = (v: T = latest.current.draft) => {
    clearTimer();
    dirty.current = false;
    if (JSON.stringify(v) !== JSON.stringify(committed.current)) {
      committed.current = v;
      latest.current.onCommit(v);
    }
  };

  useEffect(
    () => () => {
      if (dirty.current) flush();
    },
    [],
  );

  const setDraft = (v: T) => {
    setDraftState(v);
    latest.current.draft = v;
    dirty.current = true;
    clearTimer();
    if (delay !== null) timer.current = setTimeout(() => flush(v), delay);
  };

  /** Replace the draft without saving (e.g. revert invalid input). */
  const reset = (v: T) => {
    clearTimer();
    dirty.current = false;
    committed.current = v;
    latest.current.draft = v;
    setDraftState(v);
  };

  return {
    draft,
    setDraft,
    flush,
    reset,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      flush();
    },
  };
}

type InputProps = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "defaultValue">;

/** Text input bound to a settings value; saves when the user pauses (`delay` ms, null = never), leaves the field or presses Enter. */
export function CommitInput({
  value,
  onCommit,
  transform,
  delay = 600,
  className,
  ...props
}: InputProps & { value: string; onCommit: (v: string) => void; transform?: (v: string) => string; delay?: number | null }) {
  const d = useCommitDraft(value, (v) => onCommit(transform ? transform(v) : v), delay);
  return (
    <Input
      {...props}
      className={className}
      value={d.draft}
      onChange={(e) => d.setDraft(e.target.value)}
      onFocus={d.onFocus}
      onBlur={d.onBlur}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") d.flush();
        props.onKeyDown?.(e);
      }}
    />
  );
}

export function CommitTextarea({
  value,
  onCommit,
  className,
  ...props
}: Omit<ComponentProps<typeof Textarea>, "value" | "onChange" | "defaultValue"> & { value: string; onCommit: (v: string) => void }) {
  const d = useCommitDraft(value, onCommit, 800);
  return (
    <Textarea
      {...props}
      className={cn("min-h-24 font-mono text-[13px]", className)}
      value={d.draft}
      onChange={(e) => d.setDraft(e.target.value)}
      onFocus={d.onFocus}
      onBlur={d.onBlur}
    />
  );
}

/** Multi-line list editor: one entry per line ↔ string[]. */
export function LinesTextarea({
  value,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof Textarea>, "value" | "onChange" | "defaultValue"> & { value: string[]; onCommit: (v: string[]) => void }) {
  return (
    <CommitTextarea
      {...props}
      value={value.join("\n")}
      onCommit={(v) =>
        onCommit(
          v
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** Numeric input with clamp, optional suffix/prefix, and optional "empty = null". */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
  prefix,
  allowEmpty = false,
  placeholder,
  id,
  className,
  "aria-label": ariaLabel,
  disabled,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  prefix?: string;
  allowEmpty?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  const toText = (v: number | null) => (v === null || v === undefined ? "" : String(v));
  const d = useCommitDraft(toText(value), (text) => {
    const t = text.trim();
    if (!t) {
      if (allowEmpty) onCommit(null);
      else d.reset(toText(value));
      return;
    }
    let n = Number(t);
    if (!Number.isFinite(n)) return d.reset(toText(value));
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    if (step >= 1) n = Math.round(n);
    if (String(n) !== t) d.reset(String(n));
    onCommit(n);
  }, null);
  return (
    <div
      className={cn(
        "flex h-9 w-36 items-center rounded-md border border-input bg-card shadow-xs transition-[color,box-shadow]",
        "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        disabled && "opacity-50",
        className,
      )}
    >
      {prefix && <span className="pl-3 text-sm text-muted-foreground">{prefix}</span>}
      <input
        id={id}
        aria-label={ariaLabel}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        className="h-full w-full min-w-0 bg-transparent px-3 text-sm tabular-nums outline-none placeholder:text-muted-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={d.draft}
        onChange={(e) => d.setDraft(e.target.value)}
        onFocus={d.onFocus}
        onBlur={d.onBlur}
        onKeyDown={(e) => e.key === "Enter" && d.flush()}
      />
      {suffix && <span className="pr-3 text-xs whitespace-nowrap text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layout                                                               */
/* ------------------------------------------------------------------ */

export function SectionHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-5">
      <h2 className="text-[22px] leading-tight font-medium tracking-[-0.025em]">{title}</h2>
      {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

/** Card grouping related settings; children are separated by hairlines. */
export function SettingsGroup({
  title,
  description,
  icon,
  actions,
  children,
  className,
  tone,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: "danger";
  bodyClassName?: string;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("rounded-xl border bg-card shadow-card", tone === "danger" && "border-destructive/25", className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          {icon && (
            <div
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground [&_svg]:size-4",
                tone === "danger" && "border-destructive/20 bg-destructive/[0.06] text-destructive",
              )}
            >
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h3 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">{title}</h3>
            {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("divide-y px-5", bodyClassName)}>{children}</div>
    </motion.section>
  );
}

/** Label + description on the left, control on the right (or below when `stacked`). */
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

/** Pill segmented control with a sliding active indicator. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  "aria-label": ariaLabel,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  const layoutId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = options.findIndex((o) => o.value === value);
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (idx + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn("inline-flex flex-wrap rounded-lg border bg-secondary p-0.5", disabled && "pointer-events-none opacity-50", className)}
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
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative h-8 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border dark:bg-accent"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative flex items-center gap-1.5 capitalize [&_svg]:size-3.5">
              {o.icon}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Radio options rendered as selectable cards. */
export function ChoiceCards<T extends string>({
  value,
  onChange,
  options,
  className,
  name,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: ReactNode; description: ReactNode; icon?: ReactNode; badge?: ReactNode }[];
  className?: string;
  name: string;
}) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} className={cn("grid grid-cols-1 gap-3 @xl:grid-cols-2", className)} aria-label={name}>
      {options.map((o) => {
        const checked = o.value === value;
        const id = `${name}-${o.value}`;
        return (
          <label
            key={o.value}
            htmlFor={id}
            className={cn(
              "relative flex cursor-pointer gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-foreground/15",
              checked && "border-foreground/40 bg-paper-2 ring-1 ring-foreground/10 hover:border-foreground/40",
            )}
          >
            <RadioGroupItem value={o.value} id={id} className="mt-0.5" />
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

const CALLOUT = {
  info: { cls: "border-border bg-paper-2", icon: <Info className="text-foreground" /> },
  warning: { cls: "border-warning/30 bg-warning/[0.07]", icon: <TriangleAlert className="text-warning" /> },
  danger: { cls: "border-destructive/30 bg-destructive/[0.06]", icon: <ShieldAlert className="text-destructive" /> },
  muted: { cls: "border-border bg-secondary/60", icon: <CircleAlert className="text-muted-foreground" /> },
} as const;

export function Callout({
  tone = "info",
  title,
  children,
  icon,
  className,
}: {
  tone?: keyof typeof CALLOUT;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const t = CALLOUT[tone];
  return (
    <div className={cn("flex gap-3 rounded-lg border p-3.5 text-sm", t.cls, className)} role={tone === "danger" || tone === "warning" ? "alert" : undefined}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon ?? t.icon}</span>
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

/** Tiny "key: value" row used in info cards. */
export function InfoRow({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("flex min-w-0 items-center gap-1 text-right", mono && "font-mono text-xs")}>{children}</span>
    </div>
  );
}

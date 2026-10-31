import type { KeyboardEvent } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { InterfaceMode } from "@godmode/shared";
import { INTERFACE_MODES } from "@godmode/shared";
import { MODE_BLURB, MODE_LABEL } from "@/lib/mode";
import { cn } from "@/lib/utils";

/** Easy or Professional, as two cards with a sketch of how much the sidebar holds. */
export function ModePicker({ value, onChange, className }: { value: InterfaceMode; onChange: (mode: InterfaceMode) => void; className?: string }) {
  const { t } = useTranslation("settings");
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = INTERFACE_MODES[(INTERFACE_MODES.indexOf(value) + step + INTERFACE_MODES.length) % INTERFACE_MODES.length];
    onChange(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={t("modePicker.label")} onKeyDown={onKeyDown} className={cn("grid gap-3 sm:grid-cols-2", className)}>
      {INTERFACE_MODES.map((mode) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-mode={mode}
            onClick={() => onChange(mode)}
            className={cn(
              "group relative flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-card outline-none transition",
              "hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active && "border-foreground/35 ring-1 ring-foreground/10",
            )}
          >
            <Sketch mode={mode} active={active} />
            <span className="flex items-start gap-3 border-t px-4 py-3.5">
              <span
                className={cn(
                  "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition",
                  active ? "border-foreground bg-foreground" : "border-foreground/25",
                )}
              >
                {active && <motion.span layoutId="mode-dot" className="size-1.5 rounded-full bg-background" />}
              </span>
              <span className="min-w-0 space-y-1">
                <span className="flex items-center gap-2 text-sm font-medium tracking-[-0.01em]">
                  {MODE_LABEL[mode]}
                  {mode === "pro" && <span className="text-[11px] font-normal text-muted-foreground">{t("modePicker.default")}</span>}
                </span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{MODE_BLURB[mode]}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const EASY_ROWS = [0.7, 0.55, 0.62, 0.5, 0.58];
const PRO_ROWS = [0.7, 0.55, 0.62, 0.5, 0.58, 0.45, 0.6, 0.52, 0.4, 0.56];

function Sketch({ mode, active }: { mode: InterfaceMode; active: boolean }) {
  const rows = mode === "easy" ? EASY_ROWS : PRO_ROWS;
  return (
    <span aria-hidden className="flex h-28 gap-2.5 overflow-hidden bg-paper-2 p-3">
      <span className={cn("flex w-[38%] flex-col overflow-hidden rounded-md border bg-card p-2", mode === "easy" ? "gap-2" : "gap-1")}>
        <span className={cn("h-2 w-1/2 shrink-0 rounded-full bg-foreground/80", mode === "easy" && "mb-1")} />
        {rows.map((w, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className={cn("shrink-0 rounded-[3px] bg-foreground/15", mode === "easy" ? "size-2" : "size-1.5")} />
            <span
              className={cn("rounded-full transition-colors", mode === "easy" ? "h-1.5" : "h-1", i === 0 && active ? "bg-brand/70" : "bg-foreground/15")}
              style={{ width: `${w * 100}%` }}
            />
          </span>
        ))}
      </span>
      <span className="flex flex-1 flex-col gap-2 rounded-md border bg-card p-2">
        {mode === "easy" ? (
          <>
            <span className="mt-auto h-2 w-3/4 self-end rounded-full bg-foreground/15" />
            <span className="h-2 w-1/2 rounded-full bg-foreground/10" />
            <span className="mt-1 h-5 rounded-md border bg-paper-2" />
          </>
        ) : (
          <>
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1.5 flex-1 rounded-full bg-foreground/15" />
              ))}
            </span>
            <span className="grid flex-1 grid-cols-2 gap-1">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="rounded-[4px] border bg-paper-2" />
              ))}
            </span>
            <span className="h-1 w-2/3 rounded-full bg-foreground/10" />
          </>
        )}
      </span>
    </span>
  );
}

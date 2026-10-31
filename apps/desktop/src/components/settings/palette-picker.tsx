import type { KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { PALETTES, type Palette } from "@godmode/shared";
import { PALETTE_DEFS, type Mode } from "@/lib/palettes";
import { cn } from "@/lib/utils";

export function PalettePicker({ value, mode, onChange }: { value: Palette; mode: Mode; onChange: (p: Palette) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = PALETTES[(PALETTES.indexOf(value) + step + PALETTES.length) % PALETTES.length];
    onChange(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-palette="${next}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Palette" onKeyDown={onKeyDown} className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {PALETTES.map((id) => {
        const def = PALETTE_DEFS[id];
        const s = def[mode];
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-palette={id}
            title={def.blurb}
            onClick={() => onChange(id)}
            className={cn(
              "group flex flex-col overflow-hidden rounded-lg border bg-card text-left shadow-card outline-none transition",
              "hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active && "border-foreground/35 ring-1 ring-foreground/10",
            )}
          >
            <span aria-hidden className="flex h-16 gap-1.5 p-2" style={{ background: s.background }}>
              <span className="flex w-1/3 flex-col gap-1 rounded-[4px] p-1.5" style={{ background: s.sidebar }}>
                <span className="h-1 w-3/4 rounded-full" style={{ background: s.brand }} />
                <span className="h-1 w-1/2 rounded-full opacity-30" style={{ background: s.foreground }} />
                <span className="h-1 w-2/3 rounded-full opacity-30" style={{ background: s.foreground }} />
              </span>
              <span className="flex flex-1 flex-col gap-1 rounded-[4px] p-1.5" style={{ background: s.card }}>
                <span className="h-1.5 w-2/3 rounded-full" style={{ background: s.foreground }} />
                <span className="h-1 w-1/2 rounded-full" style={{ background: s.mutedForeground }} />
                <span className="mt-auto h-2.5 w-8 self-end rounded-[3px]" style={{ background: s.primary }} />
              </span>
            </span>
            <span className="flex items-center gap-1.5 border-t px-2.5 py-2 text-xs font-medium">
              <span className="min-w-0 flex-1 truncate">{def.label}</span>
              {active && <Check className="size-3.5 shrink-0" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

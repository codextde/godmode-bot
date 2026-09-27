import { useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Tag/chip input: Enter, comma, space or Tab commits; Backspace on empty removes the last chip. */
export function ChipInput({
  value,
  onChange,
  placeholder,
  normalize = (s) => s.trim(),
  validate,
  className,
  id,
  "aria-label": ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  normalize?: (s: string) => string;
  validate?: (s: string) => boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const parts = raw.split(/[,\s]+/).map(normalize).filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.includes(p) && (!validate || validate(p))) next.push(p);
    if (next.length !== value.length) onChange(next);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === "," || e.key === " " || (e.key === "Tab" && draft)) && draft.trim()) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1.5 shadow-xs transition-[color,box-shadow]",
        "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {value.map((chip) => (
          <motion.span
            key={chip}
            layout
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border bg-secondary pr-1 pl-2 text-xs font-medium text-foreground"
          >
            {chip}
            <button
              type="button"
              className="grid size-4 place-items-center rounded-[3px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              aria-label={`Remove ${chip}`}
              onClick={() => onChange(value.filter((v) => v !== chip))}
            >
              <X className="size-3" />
            </button>
          </motion.span>
        ))}
      </AnimatePresence>
      <input
        id={id}
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && commit(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (/[,\s]/.test(text)) {
            e.preventDefault();
            commit(text);
          }
        }}
        placeholder={value.length ? "" : placeholder}
        className="h-6 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

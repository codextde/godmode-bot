import { useState } from "react";
import { Check } from "lucide-react";
import { AGENT_COLORS } from "@godmode/shared";
import { colorGradient } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export const AGENT_EMOJIS = [
  "🤖", "🧠", "⚡️", "🦾", "🛰️", "🧭", "🚀", "✨",
  "📬", "📨", "🧾", "💸", "💰", "🏦", "📈", "📊",
  "🗂️", "📅", "⏰", "📝", "✍️", "📚", "🔍", "🕵️",
  "🧪", "🛠️", "🧰", "💻", "🌐", "🔐", "🛡️", "🧹",
  "🎯", "💡", "🎨", "🎬", "🎧", "📣", "🤝", "💬",
  "🛒", "✈️", "🏠", "🌱", "☕️", "🐙", "🦉", "🦊",
];

/** Big emoji avatar button that opens a curated emoji grid (plus free input). */
export function AvatarPicker({
  avatar,
  color,
  onChange,
  id,
}: {
  avatar: string;
  color: string;
  onChange: (emoji: string) => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={`Avatar ${avatar || "🤖"} — change`}
          className={cn(
            "group relative grid size-20 shrink-0 place-items-center rounded-3xl bg-gradient-to-br text-4xl shadow-lg ring-1 ring-white/10 transition hover:scale-[1.03] focus-visible:ring-[3px] focus-visible:ring-ring/60 focus-visible:outline-none",
            colorGradient(color),
          )}
        >
          <span className="drop-shadow-sm">{avatar || "🤖"}</span>
          <span className="absolute -right-1 -bottom-1 rounded-full border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
            Edit
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <div role="listbox" aria-label="Choose an emoji" className="grid grid-cols-8 gap-1">
          {AGENT_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              role="option"
              aria-selected={avatar === e}
              onClick={() => {
                onChange(e);
                setOpen(false);
              }}
              className={cn(
                "grid size-8 place-items-center rounded-lg text-lg transition hover:scale-110 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                avatar === e && "bg-primary/15 ring-1 ring-primary/40",
              )}
            >
              {e}
            </button>
          ))}
        </div>
        <form
          className="mt-3 flex gap-2 border-t pt-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            const v = [...custom.trim()].slice(0, 2).join("");
            if (v) {
              onChange(v);
              setCustom("");
              setOpen(false);
            }
          }}
        >
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or type any emoji…" aria-label="Custom emoji" className="h-8" />
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function ColorSwatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap gap-2">
      {AGENT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          onClick={() => onChange(c)}
          className={cn(
            "grid size-7 place-items-center rounded-full bg-gradient-to-br ring-offset-2 ring-offset-background transition hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            colorGradient(c),
            value === c && "ring-2 ring-foreground/70",
          )}
        >
          {value === c && <Check className="size-3.5 text-white drop-shadow" />}
        </button>
      ))}
    </div>
  );
}

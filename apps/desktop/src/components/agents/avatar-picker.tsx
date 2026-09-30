import { useState } from "react";
import { Check } from "lucide-react";
import { AGENT_COLORS, characterPalette } from "@godmode/shared";
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

/** The emoji an agent signs with where only text fits (chat apps, CLAUDE.md): a small button with a curated grid. */
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
          aria-label={`Emoji ${avatar || "🤖"} — change`}
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg text-lg ring-1 ring-inset transition hover:ring-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            colorGradient(color),
          )}
        >
          {avatar || "🤖"}
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
                "grid size-8 place-items-center rounded-md text-lg transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                avatar === e && "bg-secondary ring-1 ring-foreground/20 ring-inset",
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
            "grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-background transition hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            value === c && "ring-2 ring-foreground/70",
          )}
          style={{ background: characterPalette(c).fill }}
        >
          {value === c && <Check className="size-3.5 text-[#24211d]" />}
        </button>
      ))}
    </div>
  );
}

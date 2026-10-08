import { useEffect, useState } from "react";
import { Check, SmilePlus } from "lucide-react";
import { AGENT_COLORS } from "@godmode/shared";
import { colorSwatch } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { WorkspaceTile } from "./workspace-tile";

export const ICONS = [
  "🚀", "💼", "🏢", "🏠", "🛒", "📈", "💰", "🏦", "💡", "🎯",
  "🧠", "🎨", "✍️", "📣", "💬", "🤝", "🧑‍💻", "🛠️", "⚙️", "🧪",
  "🔬", "📚", "🎓", "🏥", "✈️", "🌍", "🌱", "🍀", "🔥", "⭐",
  "🎮", "🎬", "🎵", "📦", "🧾", "📊", "🗂️", "📝", "🔒", "🐙",
];

/** The workspace or project tile; a click opens the emoji grid. */
export function IconPicker({
  icon,
  color,
  onChange,
  size = "xl",
}: {
  icon: string;
  color: string;
  onChange: (icon: string) => void;
  size?: "lg" | "xl";
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  useEffect(() => {
    if (open) setCustom("");
  }, [open]);
  const pick = (value: string) => {
    onChange(value);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Choose icon" className="group relative rounded-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <WorkspaceTile icon={icon} color={color} size={size} />
          <span className="absolute -right-1 -bottom-1 grid size-6 place-items-center rounded-md border bg-card text-muted-foreground shadow-card transition group-hover:text-foreground">
            <SmilePlus className="size-3.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[20.5rem] rounded-xl p-3">
        <div className="grid grid-cols-8 gap-1" role="listbox" aria-label="Icons">
          {ICONS.map((e) => (
            <button
              key={e}
              type="button"
              role="option"
              aria-selected={icon === e}
              onClick={() => pick(e)}
              className={cn("grid size-9 place-items-center rounded-lg text-xl transition hover:bg-accent", icon === e && "bg-accent ring-1 ring-foreground/20")}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2 border-t pt-3">
          <Input
            aria-label="Custom emoji"
            placeholder="Or paste any emoji…"
            value={custom}
            maxLength={16}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom.trim()) {
                e.preventDefault();
                pick(custom.trim());
              }
            }}
          />
          <Button type="button" size="icon" variant="secondary" aria-label="Use emoji" disabled={!custom.trim()} onClick={() => pick(custom.trim())}>
            <Check />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ColorRadios({ value, onChange, labelledBy }: { value: string; onChange: (color: string) => void; labelledBy: string }) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      {AGENT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn(
            "grid size-7 place-items-center rounded-md ring-offset-2 ring-offset-background transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            colorSwatch(c),
            value === c && "ring-2 ring-foreground/70",
          )}
        >
          {value === c && <Check className="size-3.5 text-white" />}
        </button>
      ))}
    </div>
  );
}

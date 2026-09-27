import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { InputGroupButton } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_GENERATOR, generatePassword, type GeneratorOptions } from "@/lib/password";
import { StrengthMeter } from "./strength-meter";
import { copySecret } from "./clipboard";

const STORAGE_KEY = "godmode-pwgen";

function loadOptions(): GeneratorOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_GENERATOR, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_GENERATOR;
}

/** Wand button (for PasswordInput `trailing`) opening a generator popover. */
export function PasswordGeneratorButton({ onUse }: { onUse: (password: string) => void }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<GeneratorOptions>(loadOptions);
  const [pw, setPw] = useState(() => generatePassword(opts));

  useEffect(() => {
    if (!open) return;
    setPw(generatePassword(opts));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(opts));
    } catch {
      /* ignore */
    }
  }, [opts, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <InputGroupButton size="icon-xs" aria-label="Generate password">
              <Wand2 />
            </InputGroupButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Generate a strong password</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 space-y-4 rounded-xl p-4">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 rounded-lg border bg-paper-2 px-3 py-2 font-mono text-sm break-all select-all">{pw}</div>
          <div className="flex flex-col gap-1">
            <Button size="icon-sm" variant="ghost" aria-label="Regenerate" onClick={() => setPw(generatePassword(opts))}>
              <RefreshCw />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Copy" onClick={() => copySecret(pw, "Password copied")}>
              <Copy />
            </Button>
          </div>
        </div>
        <StrengthMeter password={pw} showFeedback={false} />
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="pwgen-length">Length</Label>
            <span className="font-mono text-sm tabular-nums">{opts.length}</span>
          </div>
          <Slider id="pwgen-length" min={8} max={64} step={1} value={[opts.length]} onValueChange={([v]) => setOpts((o) => ({ ...o, length: v }))} />
          <div className="flex items-center justify-between">
            <Label htmlFor="pwgen-numbers">Numbers</Label>
            <Switch id="pwgen-numbers" checked={opts.numbers} onCheckedChange={(numbers) => setOpts((o) => ({ ...o, numbers }))} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="pwgen-symbols">Symbols</Label>
            <Switch id="pwgen-symbols" checked={opts.symbols} onCheckedChange={(symbols) => setOpts((o) => ({ ...o, symbols }))} />
          </div>
        </div>
        <Button
          className="w-full"
          onClick={() => {
            onUse(pw);
            setOpen(false);
          }}
        >
          <Check /> Use this password
        </Button>
      </PopoverContent>
    </Popover>
  );
}

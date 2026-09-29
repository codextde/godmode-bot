import type { RoutineTriggerType } from "@godmode/shared";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { TRIGGER_ORDER, TRIGGER_TYPES } from "./trigger-meta";

/** Four cards: what starts the automation. */
export function TriggerPicker({ value, onChange, className }: { value: RoutineTriggerType; onChange: (type: RoutineTriggerType) => void; className?: string }) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as RoutineTriggerType)}
      aria-label="What starts this automation"
      className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2", className)}
    >
      {TRIGGER_ORDER.map((type) => {
        const meta = TRIGGER_TYPES[type];
        const Icon = meta.icon;
        return (
          <Label
            key={type}
            htmlFor={`trigger-type-${type}`}
            className={cn(
              "group/trigger relative flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 pr-9 font-normal shadow-card transition-colors",
              "hover:border-foreground/15 has-[[data-state=checked]]:border-foreground/40 has-[[data-state=checked]]:bg-paper-2 has-[[data-state=checked]]:ring-1 has-[[data-state=checked]]:ring-foreground/10",
            )}
          >
            <RadioGroupItem id={`trigger-type-${type}`} value={type} className="absolute top-3 right-3" />
            <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground transition-colors group-has-[[data-state=checked]]/trigger:border-foreground/15 group-has-[[data-state=checked]]/trigger:bg-card group-has-[[data-state=checked]]/trigger:text-foreground">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm leading-snug font-medium">{meta.title}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{meta.hint}</span>
            </span>
          </Label>
        );
      })}
    </RadioGroup>
  );
}

import type { ClaudeModel } from "@godmode/shared";
import { findModel } from "@godmode/shared";
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";

/** Select items for a model catalog: latest models with descriptions, older ones grouped, plus an unknown current id. */
export function ModelOptions({ models, current }: { models: ClaudeModel[]; current?: string }) {
  const older = models.filter((m) => !m.latest);
  return (
    <>
      {models
        .filter((m) => m.latest)
        .map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <span>{m.label}</span>
            {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
          </SelectItem>
        ))}
      {older.length > 0 && (
        <SelectGroup>
          <SelectLabel>Older models</SelectLabel>
          {older.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {current && !findModel(models, current) && <SelectItem value={current}>{current}</SelectItem>}
    </>
  );
}

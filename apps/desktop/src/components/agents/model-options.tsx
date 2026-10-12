import type { ClaudeModel } from "@godmode/shared";
import { findModel } from "@godmode/shared";
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";

function Item({ model }: { model: ClaudeModel }) {
  return (
    <SelectItem value={model.id}>
      <span>{model.label}</span>
      {model.description && <span className="text-xs text-muted-foreground">{model.description}</span>}
    </SelectItem>
  );
}

/**
 * Select items for a model catalog: latest Claude models with descriptions, older ones grouped, GLM apart as the
 * special case, plus an unknown current id. `claudeOnly` leaves GLM out (subagents share their run's provider).
 */
export function ModelOptions({ models: all, current, claudeOnly }: { models: ClaudeModel[]; current?: string; claudeOnly?: boolean }) {
  const models = all.filter((m) => !m.provider);
  const special = claudeOnly ? [] : all.filter((m) => m.provider);
  const older = models.filter((m) => !m.latest);
  return (
    <>
      {models
        .filter((m) => m.latest)
        .map((m) => (
          <Item key={m.id} model={m} />
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
      {special.length > 0 && (
        <SelectGroup>
          <SelectLabel>Special tasks</SelectLabel>
          {special.map((m) => (
            <Item key={m.id} model={m} />
          ))}
        </SelectGroup>
      )}
      {current && !findModel([...models, ...special], current) && <SelectItem value={current}>{current}</SelectItem>}
    </>
  );
}

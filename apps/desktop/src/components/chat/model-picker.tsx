import { useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Cpu, RotateCw, Workflow } from "lucide-react";
import { toast } from "sonner";
import {
  DEFAULT_MODEL,
  EFFORT_LABELS,
  EFFORT_OPTIONS,
  ULTRACODE_HINT,
  effortForModel,
  findModel,
  type Agent,
  type ClaudeModel,
  type Effort,
} from "@godmode/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/api";
import { useModelCatalog, useSettings } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export interface ModelChoice {
  /** null = the agent's model */
  model: string | null;
  /** null = the agent's effort */
  effort: Effort | null;
  /** null = the agent's Ultracode setting */
  ultracode: boolean | null;
}

const EFFORT_HINTS: Record<Effort, string> = {
  low: "Quick answers with little deliberation.",
  medium: "Balanced speed and depth.",
  high: "Thinks problems through before acting.",
  xhigh: "Extra deliberation for hard, multi-step work.",
  max: "Thinks as long as it needs. Slowest, most tokens.",
};

function customModel(id: string, ultracode: boolean): ClaudeModel {
  return { id, resolvedModel: id, label: id, description: "Custom model id", efforts: [...EFFORT_OPTIONS], ultracode, latest: true };
}

/** What a chat runs with: its override, else the agent's, else the global default. */
export function useEffectiveModel(agent: Agent | undefined, choice: ModelChoice) {
  const { catalog } = useModelCatalog();
  const { data: settings } = useSettings();
  // Nobody knows what a custom model id can do: it gets Ultracode whenever this Claude Code has it at all.
  const anyUltracode = catalog.models.some((m) => m.ultracode);
  const baseId = agent?.model?.trim() || settings?.runner.model?.trim() || DEFAULT_MODEL;
  const base = findModel(catalog.models, baseId) ?? customModel(baseId, anyUltracode);
  const current = choice.model ? (findModel(catalog.models, choice.model) ?? customModel(choice.model, anyUltracode)) : base;
  const baseEffort = agent?.effort ?? settings?.runner.effort ?? "high";
  const effort = effortForModel(current.efforts, choice.effort ?? baseEffort);
  const baseUltracode = agent?.ultracode ?? settings?.runner.ultracode ?? false;
  const ultracode = current.ultracode && (choice.ultracode ?? baseUltracode);
  return { catalog, base, baseEffort, baseUltracode, anyUltracode, current, effort, ultracode };
}

function EffortGlyph({ level, count }: { level: number; count: number }) {
  return (
    <span aria-hidden className="flex h-3 items-end gap-[2px]">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn("w-[2px] rounded-full bg-current transition-opacity", i <= level ? "opacity-90" : "opacity-25")}
          style={{ height: 4 + (8 * i) / Math.max(1, count - 1) }}
        />
      ))}
    </span>
  );
}

function EffortMeter({ levels, value, onChange }: { levels: readonly Effort[]; value: Effort; onChange: (e: Effort) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const active = levels.indexOf(value);
  const shown = levels[hover ?? active] ?? value;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? levels.length - 1 : step ? Math.min(levels.length - 1, Math.max(0, active + step)) : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    const next = levels[to];
    if (next && next !== value) onChange(next);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[to]?.focus();
  };

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium">Effort</span>
        <span className={cn("text-xs tabular-nums transition-colors", hover !== null ? "text-muted-foreground" : "text-foreground")}>{EFFORT_LABELS[shown]}</span>
      </div>
      <div role="radiogroup" aria-label="Effort" onKeyDown={onKeyDown} onMouseLeave={() => setHover(null)} className="-mx-0.5 mt-1.5 flex">
        {levels.map((level, i) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={i === active}
            aria-label={EFFORT_LABELS[level]}
            tabIndex={i === active ? 0 : -1}
            onMouseEnter={() => setHover(i)}
            onClick={() => level !== value && onChange(level)}
            className="group flex h-7 flex-1 items-center rounded-md px-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span
              className={cn(
                "h-1.5 w-full rounded-full transition-[background-color,transform] duration-150 group-hover:scale-y-[1.35]",
                i <= (hover ?? active) ? (hover !== null ? "bg-foreground/45" : "bg-foreground/85") : "bg-foreground/10",
              )}
            />
          </button>
        ))}
      </div>
      <div className="flex justify-between text-[10.5px] text-muted-foreground/80">
        <span>Faster</span>
        <span>Deeper</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{EFFORT_HINTS[shown]}</p>
    </div>
  );
}

export function ModelPicker({
  agent,
  value,
  onChange,
  className,
}: {
  agent: Agent | undefined;
  value: ModelChoice;
  onChange: (patch: Partial<ModelChoice>) => void;
  className?: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const ultracodeId = useId();
  const { catalog, base, baseEffort, baseUltracode, anyUltracode, current, effort, ultracode } = useEffectiveModel(agent, value);

  const listed = catalog.models.some((m) => m.id === current.id) ? catalog.models : [current, ...catalog.models];
  const latest = listed.filter((m) => m.latest);
  const older = listed.filter((m) => !m.latest);
  const overridden = value.model !== null || value.effort !== null || value.ultracode !== null;
  const effortIndex = effort ? current.efforts.indexOf(effort) : -1;

  const pickModel = (m: ClaudeModel) => onChange({ model: m.id === base.id ? null : m.id });
  const pickEffort = (e: Effort) => onChange({ effort: e === baseEffort ? null : e });
  const pickUltracode = (on: boolean) => onChange({ ultracode: on === baseUltracode ? null : on });
  const focusId = showOlder || current.latest ? current.id : latest[0]?.id;

  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(qk.models, await api.models.get(true));
    } catch (err) {
      toast.error("Couldn't reload models", { description: errorMessage(err) });
    } finally {
      setRefreshing(false);
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const options = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-option]")];
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1 + options.length, Home: 0, End: options.length - 1 };
    const to = moves[e.key];
    const next = to === undefined ? undefined : options[to % options.length];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const summary = [current.label, effort && `${EFFORT_LABELS[effort]} effort`, ultracode && "Ultracode"].filter(Boolean).join(" · ");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setShowOlder(!current.latest);
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Model: ${summary}`}
              className={cn(
                "flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground transition",
                "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:bg-accent data-[state=open]:text-foreground",
                className,
              )}
            >
              <Cpu className="hidden size-4 shrink-0 @max-sm/composer:block" />
              <span className="truncate @max-sm/composer:hidden">{current.label}</span>
              {effort && <EffortGlyph level={effortIndex} count={current.efforts.length} />}
              {ultracode && <Workflow aria-hidden className="size-3.5 shrink-0" />}
              <ChevronDown className="size-3.5 shrink-0 opacity-60" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open && <TooltipContent>{summary}</TooltipContent>}
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-80 overflow-hidden rounded-xl p-0 shadow-float"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          selectedRef.current?.focus({ preventScroll: true });
        }}
      >
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          <span className="eyebrow">Model</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-label="Reload models from Claude Code"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
              >
                <RotateCw className={cn("size-3.5", refreshing && "animate-spin")} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Reload from Claude Code</TooltipContent>
          </Tooltip>
        </div>

        <div role="menu" aria-label="Models" onKeyDown={onListKeyDown} className="max-h-[min(22rem,50vh)] overflow-y-auto px-1.5 pb-1.5">
          {latest.map((m) => (
            <ModelOption
              key={m.id}
              model={m}
              selected={m.id === current.id}
              isDefault={m.id === base.id}
              tabbable={m.id === focusId}
              onSelect={() => pickModel(m)}
              ref={m.id === focusId ? selectedRef : undefined}
            />
          ))}
          {older.length > 0 && (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-option
                aria-expanded={showOlder}
                onClick={() => setShowOlder((v) => !v)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground outline-none transition hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
              >
                <span className="flex-1">Older models</span>
                <span className="tabular-nums opacity-70">{older.length}</span>
                <ChevronDown className={cn("size-3.5 transition-transform", showOlder && "rotate-180")} />
              </button>
              {showOlder &&
                older.map((m) => (
                  <ModelOption
                    key={m.id}
                    model={m}
                    compact
                    selected={m.id === current.id}
                    isDefault={m.id === base.id}
                    tabbable={m.id === focusId}
                    onSelect={() => pickModel(m)}
                    ref={m.id === focusId ? selectedRef : undefined}
                  />
                ))}
            </>
          )}
        </div>

        <div className="border-t px-3 py-3">
          {effort ? (
            <EffortMeter levels={current.efforts} value={effort} onChange={pickEffort} />
          ) : (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Effort</span> isn't adjustable for {current.label}.
            </p>
          )}
        </div>

        {current.ultracode ? (
          <div className="border-t px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor={ultracodeId} className="flex items-center gap-1.5 text-[13px] font-medium">
                <Workflow aria-hidden className="size-3.5 text-muted-foreground" /> Ultracode
              </label>
              <Switch id={ultracodeId} checked={ultracode} onCheckedChange={pickUltracode} aria-describedby={`${ultracodeId}-hint`} />
            </div>
            <p id={`${ultracodeId}-hint`} className="mt-1.5 text-xs text-muted-foreground">
              {ULTRACODE_HINT}
            </p>
          </div>
        ) : (
          anyUltracode && (
            <p className="border-t px-3 py-2.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Ultracode</span> isn't available for {current.label}.
            </p>
          )
        )}

        <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("size-1.5 shrink-0 rounded-full", catalog.source === "claude" ? "bg-success" : "bg-warning")} />
                <span className="truncate">
                  {catalog.source === "claude" ? `Claude Code ${catalog.claudeVersion ?? ""}`.trim() : "Built-in list"}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {catalog.source === "claude"
                ? "The same models Claude Code offers in /model — updated when Claude Code updates."
                : catalog.error
                  ? `Claude Code couldn't be asked: ${catalog.error}`
                  : "Loading the list from Claude Code…"}
            </TooltipContent>
          </Tooltip>
          {overridden && (
            <button
              type="button"
              onClick={() => onChange({ model: null, effort: null, ultracode: null })}
              className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-medium text-foreground/80 transition hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Use {agent ? `${agent.name}'s` : "agent"} default
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ModelOption({
  model,
  selected,
  isDefault,
  tabbable,
  compact,
  onSelect,
  ref,
}: {
  model: ClaudeModel;
  selected: boolean;
  isDefault: boolean;
  tabbable: boolean;
  compact?: boolean;
  onSelect: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      data-option
      onClick={onSelect}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-lg px-2 text-left outline-none transition",
        "hover:bg-accent focus-visible:bg-accent",
        compact ? "py-1.5" : "py-2",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-[13px]", selected ? "font-semibold" : "font-medium")}>{model.label}</span>
          {isDefault && (
            <span className="shrink-0 rounded-[4px] border px-1 text-[10px] leading-4 text-muted-foreground">Default</span>
          )}
        </span>
        {!compact && model.description && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{model.description}</span>}
      </span>
      <Check className={cn("mt-0.5 size-4 shrink-0 text-foreground transition-opacity", selected ? "opacity-100" : "opacity-0")} />
    </button>
  );
}

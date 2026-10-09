import { useState } from "react";
import { Cpu, Gauge, ShieldAlert, SlidersHorizontal, Sparkles, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_LOOP_REPEATS, DEFAULT_STALL_MINUTES, EFFORT_LABELS, EFFORT_OPTIONS, ULTRACODE_HINT, findModel, type ClaudeModel, type Effort, type Settings } from "@godmode/shared";
import { ReasoningEffort } from "@/components/aicss/ReasoningEffort";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { useBudgets, useModelCatalog } from "@/lib/hooks";
import { BudgetMeter } from "@/components/budgets/budget-meter";
import { cn } from "@/lib/utils";
import {
  Callout,
  CommitInput,
  LinesTextarea,
  NumberField,
  SectionHeading,
  SettingRow,
  SettingsGroup,
  useSettingsPatch,
} from "./settings-kit";

const CUSTOM = "__custom__";
const NONE = "__none__";

function ModelItem({ model }: { model: ClaudeModel }) {
  return (
    <SelectItem value={model.id}>
      <span className="flex flex-col items-start gap-0.5">
        <span className="font-medium">{model.label}</span>
        {model.description && <span className="text-xs text-muted-foreground">{model.description}</span>}
      </span>
    </SelectItem>
  );
}

/** Model picker: the models Claude Code offers + "Custom…" for any Claude CLI model id/alias. */
export function ModelSelect({
  id,
  value,
  onChange,
  allowNone = false,
  noneLabel = "None",
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** Offer an empty value, shown as `noneLabel`. */
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
}) {
  const { catalog, isPending } = useModelCatalog();
  const known = findModel(catalog.models, value);
  const [customMode, setCustom] = useState(false);
  const custom = customMode || (!isPending && !known && !(allowNone && !value));
  const selectValue = custom ? CUSTOM : allowNone && !value ? NONE : (known?.id ?? value);
  const display = custom ? "Custom model id" : selectValue === NONE ? noneLabel : (known?.label ?? value);
  const older = catalog.models.filter((m) => !m.latest);

  return (
    <div className="flex w-full flex-col items-stretch gap-2 @xl:w-72">
      <Select
        value={selectValue}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(v === NONE ? "" : v);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{display}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {allowNone && (
            <>
              <SelectItem value={NONE}>{noneLabel}</SelectItem>
              <SelectSeparator />
            </>
          )}
          {catalog.models
            .filter((m) => m.latest)
            .map((m) => (
              <ModelItem key={m.id} model={m} />
            ))}
          {older.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Older models</SelectLabel>
                {older.map((m) => (
                  <ModelItem key={m.id} model={m} />
                ))}
              </SelectGroup>
            </>
          )}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>Custom model id…</SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <CommitInput
          aria-label="Custom model id"
          disabled={disabled}
          autoFocus={!value || !!known}
          className="font-mono text-[13px]"
          placeholder="e.g. claude-opus-5-5 or opus"
          value={known ? "" : value}
          onCommit={(v) => v.trim() && onChange(v.trim())}
        />
      )}
    </div>
  );
}

export function AiSection({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const { catalog } = useModelCatalog();
  const r = settings.runner;
  const [confirmBypass, setConfirmBypass] = useState(false);
  const defaultModel = findModel(catalog.models, r.model);
  // A custom model id: possible whenever this Claude Code has Ultracode at all.
  const anyUltracode = catalog.models.some((m) => m.ultracode);
  const ultracodeAvailable = defaultModel ? defaultModel.ultracode : anyUltracode;

  const setBypass = (on: boolean) => {
    if (on) {
      setConfirmBypass(true);
      return;
    }
    patch({ runner: { bypassPermissions: false } });
    toast.warning("Full bypass mode is off", { description: "Agents will pause at permission prompts — unattended automations may stall." });
  };

  return (
    <div className="space-y-5">
      <SectionHeading
        title="AI & Claude"
        description="Godmode drives the Claude Code CLI as the brain of every agent. These defaults apply unless an agent overrides them."
      />

      <SettingsGroup title="Model" icon={<Sparkles />} description="Agents can pick their own model; this is the default.">
        <SettingRow label="Default model" htmlFor="default-model" description="Opus 5.5 is tuned for long, autonomous multi-step work.">
          <ModelSelect id="default-model" value={r.model} onChange={(model) => patch({ runner: { model } })} />
        </SettingRow>
        <SettingRow label="Fallback model" htmlFor="fallback-model" description="Used automatically when the default model is overloaded.">
          <ModelSelect id="fallback-model" allowNone value={r.fallbackModel} onChange={(fallbackModel) => patch({ runner: { fallbackModel } })} />
        </SettingRow>
        <SettingRow label="Reasoning effort" description="Higher effort thinks longer before acting — better results, more tokens.">
          <ReasoningEffort
            aria-label="Reasoning effort"
            label={defaultModel?.label ?? "Effort"}
            stops={EFFORT_OPTIONS.map((e) => EFFORT_LABELS[e])}
            value={Math.max(0, EFFORT_OPTIONS.indexOf(r.effort))}
            onChange={(i) => {
              const effort: Effort = EFFORT_OPTIONS[i] ?? "high";
              if (effort !== r.effort) patch({ runner: { effort } });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Ultracode"
          htmlFor="ultracode"
          description={
            <>
              {ULTRACODE_HINT}
              {!ultracodeAvailable && (
                <span className="mt-1 block font-medium text-foreground/80">
                  {anyUltracode
                    ? `${defaultModel?.label ?? "The default model"} doesn't support dynamic workflows — pick a model that does.`
                    : "The installed Claude Code doesn't offer dynamic workflows."}
                </span>
              )}
            </>
          }
        >
          {/* Stays switchable while it is on: agents with a model of their own still follow this default. */}
          <Switch
            id="ultracode"
            checked={r.ultracode ?? false}
            disabled={!ultracodeAvailable && !r.ultracode}
            onCheckedChange={(ultracode) => patch({ runner: { ultracode } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Autonomy"
        icon={<ShieldAlert />}
        description="How much your agents may do without asking."
        actions={
          <Badge
            variant="outline"
            className={cn(
              "gap-1.5 font-normal",
              r.bypassPermissions ? "border-warning/30 bg-warning/[0.07] text-warning" : "border-brand/25 bg-brand-soft text-brand-strong",
            )}
          >
            <span className={cn("size-1.5 rounded-full", r.bypassPermissions ? "bg-warning" : "bg-brand")} />
            {r.bypassPermissions ? "Full bypass" : "Ask for permission"}
          </Badge>
        }
      >
        <SettingRow
          label="Full bypass mode"
          htmlFor="bypass"
          description={
            <>
              Runs Claude Code with <code className="rounded-[4px] bg-secondary px-1 py-0.5 font-mono text-[11px]">--dangerously-skip-permissions</code>.
            </>
          }
        >
          <Switch id="bypass" checked={r.bypassPermissions} onCheckedChange={setBypass} />
        </SettingRow>
        <div className="py-4">
          {r.bypassPermissions ? (
            <Callout tone="warning" title="Agents act without asking">
              They can run any shell command, install software, and create, edit or delete files on this machine — exactly like a coworker with
              full access. This is what lets automations finish unattended. Vault secrets stay protected: in fill mode the AI never sees your
              passwords, and every secret use is audited.
            </Callout>
          ) : (
            <Callout tone="muted" title="Agents stop at permission prompts">
              Every command or file edit needs approval. Nobody is watching an automation, so unattended work will stall until you turn
              full bypass back on.
            </Callout>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Limits" icon={<Gauge />} description="Guardrails for cost and runaway tasks.">
        <SettingRow label="Parallel runs" htmlFor="max-runs" description="How many agent runs may execute at the same time. Extra runs wait in a queue.">
          <NumberField id="max-runs" min={1} max={32} value={r.maxConcurrentRuns} onCommit={(v) => v !== null && patch({ runner: { maxConcurrentRuns: v } })} />
        </SettingRow>
        <SettingRow label="Run timeout" htmlFor="timeout" description="A run is stopped after this long.">
          <NumberField id="timeout" min={1} max={1440} suffix="min" value={r.runTimeoutMinutes} onCommit={(v) => v !== null && patch({ runner: { runTimeoutMinutes: v } })} />
        </SettingRow>
        <SettingRow
          label="Continue after a usage limit"
          htmlFor="auto-continue"
          description="When Claude's usage limit stops a run, it waits and continues by itself once the limit has reset — where it stopped."
        >
          <Switch id="auto-continue" checked={r.autoContinueOnLimit ?? true} onCheckedChange={(autoContinueOnLimit) => patch({ runner: { autoContinueOnLimit } })} />
        </SettingRow>
        <SettingRow
          label="Continue after a restart"
          htmlFor="resume-after-restart"
          description="Chats, automations and handed-over tasks that were working when Godmode quit, updated or crashed pick up where they stopped once it is back (work of the last day). Board tickets always do."
        >
          <Switch id="resume-after-restart" checked={r.resumeAfterRestart ?? true} onCheckedChange={(resumeAfterRestart) => patch({ runner: { resumeAfterRestart } })} />
        </SettingRow>
        <SettingRow
          label="Watchdog"
          htmlFor="watchdog"
          description="Stops runs that stall or go in circles, with a report of where they stood. Board tickets try again once on their own."
        >
          <Switch id="watchdog" checked={r.watchdog ?? true} onCheckedChange={(watchdog) => patch({ runner: { watchdog } })} />
        </SettingRow>
        {(r.watchdog ?? true) && (
          <>
            <SettingRow label="Stalled after" htmlFor="stall-minutes" description="No sign of life for this long. A tool that is still running gets three times as long, at least 30 minutes.">
              <NumberField
                id="stall-minutes"
                min={3}
                max={240}
                suffix="min"
                value={r.stallMinutes ?? DEFAULT_STALL_MINUTES}
                onCommit={(v) => v !== null && patch({ runner: { stallMinutes: v } })}
              />
            </SettingRow>
            <SettingRow label="Same step repeated" htmlFor="loop-repeats" description="The same tool with the same input and result, this many times in a row.">
              <NumberField
                id="loop-repeats"
                min={3}
                max={50}
                suffix="times"
                value={r.loopRepeats ?? DEFAULT_LOOP_REPEATS}
                onCommit={(v) => v !== null && patch({ runner: { loopRepeats: v } })}
              />
            </SettingRow>
          </>
        )}
        <SettingRow label="Default budget per run" htmlFor="budget" description="Hard spending cap passed to Claude Code. Leave empty for unlimited.">
          <NumberField
            id="budget"
            prefix="$"
            suffix="USD"
            min={0}
            step={0.5}
            allowEmpty
            placeholder="Unlimited"
            value={r.defaultMaxBudgetUsd}
            onCommit={(v) => patch({ runner: { defaultMaxBudgetUsd: v === 0 ? null : v } })}
          />
        </SettingRow>
        <SettingRow
          label="Monthly team budget"
          htmlFor="team-budget"
          description="Everything your agents cost in a calendar month. At 80% you're told; at 100% automations, follow-ups and board tickets wait until you raise it or let them run. Chats you start still run."
        >
          <NumberField
            id="team-budget"
            prefix="$"
            suffix="USD"
            min={0}
            step={5}
            allowEmpty
            placeholder="No budget"
            value={r.monthlyBudgetUsd ?? null}
            onCommit={(v) => patch({ runner: { monthlyBudgetUsd: v === 0 ? null : v } })}
          />
        </SettingRow>
        <TeamBudget />
      </SettingsGroup>

      <SettingsGroup title="Claude Code CLI" icon={<TerminalSquare />}>
        <SettingRow label="CLI path" htmlFor="claude-path" description={<InlineCode text="Leave empty to auto-detect the `claude` binary on your PATH." />}>
          <CommitInput
            id="claude-path"
            className="w-72 font-mono text-[13px]"
            placeholder="Auto-detect"
            value={r.claudePath}
            onCommit={(claudePath) => patch({ runner: { claudePath: claudePath.trim() } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Advanced" icon={<SlidersHorizontal />} description="For power users — mistakes here can break every run.">
        <SettingRow stacked label="Extra CLI arguments" htmlFor="extra-args" description={<InlineCode text="One argument per line, appended to every `claude` invocation." />}>
          <LinesTextarea
            id="extra-args"
            placeholder={"--verbose\n--add-dir\n/Users/me/projects"}
            value={r.extraArgs}
            onCommit={(extraArgs) => patch({ runner: { extraArgs } })}
          />
        </SettingRow>
      </SettingsGroup>

      <AlertDialog open={confirmBypass} onOpenChange={setConfirmBypass}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Cpu className="size-5 text-warning" /> Turn on full bypass mode?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Agents will run commands and change files on this computer without asking first. Only enable this if you trust the instructions
              your agents receive. You can turn it off at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-warning text-black hover:bg-warning/90"
              onClick={() => patch({ runner: { bypassPermissions: true } })}
            >
              Enable full bypass
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** What the team spent this month against its budget, under the field that sets it. */
function TeamBudget() {
  const { data } = useBudgets();
  if (!data) return null;
  return (
    <div className="px-4 pb-4">
      <BudgetMeter status={data.team} resetsAt={data.resetsAt} whose="the team's" release={{ scope: "team" }} />
    </div>
  );
}

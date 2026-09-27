import { useState } from "react";
import { Cpu, Gauge, ShieldAlert, SlidersHorizontal, Sparkles, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { EFFORT_LABELS, EFFORT_OPTIONS, findModel, type ClaudeModel, type Effort, type Settings } from "@godmode/shared";
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
import { useModelCatalog } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import {
  Callout,
  CommitInput,
  CommitTextarea,
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
function ModelSelect({
  id,
  value,
  onChange,
  allowNone = false,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  allowNone?: boolean;
}) {
  const { catalog, isPending } = useModelCatalog();
  const known = findModel(catalog.models, value);
  const [customMode, setCustom] = useState(false);
  const custom = customMode || (!isPending && !known && !(allowNone && !value));
  const selectValue = custom ? CUSTOM : allowNone && !value ? NONE : (known?.id ?? value);
  const display = custom ? "Custom model id" : selectValue === NONE ? "None" : (known?.label ?? value);
  const older = catalog.models.filter((m) => !m.latest);

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-72">
      <Select
        value={selectValue}
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
              <SelectItem value={NONE}>None</SelectItem>
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

  const setBypass = (on: boolean) => {
    if (on) {
      setConfirmBypass(true);
      return;
    }
    patch({ runner: { bypassPermissions: false } });
    toast.warning("Full bypass mode is off", { description: "Agents will pause at permission prompts — unattended routines may stall." });
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
            label={findModel(catalog.models, r.model)?.label ?? "Effort"}
            stops={EFFORT_OPTIONS.map((e) => EFFORT_LABELS[e])}
            value={Math.max(0, EFFORT_OPTIONS.indexOf(r.effort))}
            onChange={(i) => {
              const effort: Effort = EFFORT_OPTIONS[i] ?? "high";
              if (effort !== r.effort) patch({ runner: { effort } });
            }}
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
              full access. This is what lets routines finish unattended. Vault secrets stay protected: in fill mode the AI never sees your
              passwords, and every secret use is audited.
            </Callout>
          ) : (
            <Callout tone="muted" title="Agents stop at permission prompts">
              Every command or file edit needs approval. Nobody is watching a scheduled routine, so unattended work will stall until you turn
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
        <SettingRow
          stacked
          label="Extra system prompt"
          htmlFor="system-prompt"
          description="Appended to the Godmode system prompt for every agent — house rules, tone, company context."
        >
          <CommitTextarea
            id="system-prompt"
            className="min-h-32 font-sans text-sm"
            placeholder="e.g. Always answer in German. Our company is ACME GmbH…"
            value={r.appendSystemPrompt}
            onCommit={(appendSystemPrompt) => patch({ runner: { appendSystemPrompt } })}
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

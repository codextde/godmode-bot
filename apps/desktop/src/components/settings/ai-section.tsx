import { useState } from "react";
import { Cpu, Gauge, ShieldAlert, SlidersHorizontal, Sparkles, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { DEFAULT_AUTO_COMPACT_PERCENT, DEFAULT_LOOP_REPEATS, DEFAULT_STALL_MINUTES, EFFORT_OPTIONS, ULTRACODE_HINT, ULTRACODE_HINT_DE, effortLabel, findModel, type ClaudeModel, type Effort, type Settings } from "@godmode/shared";
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
  LinesTextarea,
  NumberField,
  SectionHeading,
  SettingRow,
  SettingsGroup,
  useSettingsPatch,
} from "./settings-kit";
import { currentLanguage } from "@/i18n";

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
  noneLabel,
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
  const { t } = useTranslation(["settings", "common"]);
  const { catalog: full, isPending } = useModelCatalog();
  // Defaults and the fallback are Claude only: GLM is picked per agent or chat.
  const catalog = { ...full, models: full.models.filter((m) => !m.provider) };
  const known = findModel(catalog.models, value);
  const [customMode, setCustom] = useState(false);
  const custom = customMode || (!isPending && !known && !(allowNone && !value));
  const selectValue = custom ? CUSTOM : allowNone && !value ? NONE : (known?.id ?? value);
  const none = noneLabel ?? t("common:status.none");
  const display = custom ? t("ai.modelSelect.custom") : selectValue === NONE ? none : (known?.label ?? value);
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
              <SelectItem value={NONE}>{none}</SelectItem>
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
                <SelectLabel>{t("ai.modelSelect.older")}</SelectLabel>
                {older.map((m) => (
                  <ModelItem key={m.id} model={m} />
                ))}
              </SelectGroup>
            </>
          )}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>{t("ai.modelSelect.customItem")}</SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <CommitInput
          aria-label={t("ai.modelSelect.custom")}
          disabled={disabled}
          autoFocus={!value || !!known}
          className="font-mono text-[13px]"
          placeholder={t("ai.modelSelect.customPlaceholder")}
          value={known ? "" : value}
          onCommit={(v) => v.trim() && onChange(v.trim())}
        />
      )}
    </div>
  );
}

export function AiSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation(["settings", "common"]);
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
    toast.warning(t("ai.bypassOffToast"), { description: t("ai.bypassOffToastDescription") });
  };

  return (
    <div className="space-y-5">
      <SectionHeading title={t("ai.title")} description={t("ai.description")} />

      <SettingsGroup title={t("ai.model.title")} icon={<Sparkles />} description={t("ai.model.description")}>
        <SettingRow label={t("ai.model.default")} htmlFor="default-model" description={t("ai.model.defaultDescription")}>
          <ModelSelect id="default-model" value={r.model} onChange={(model) => patch({ runner: { model } })} />
        </SettingRow>
        <SettingRow label={t("ai.model.fallback")} htmlFor="fallback-model" description={t("ai.model.fallbackDescription")}>
          <ModelSelect id="fallback-model" allowNone value={r.fallbackModel} onChange={(fallbackModel) => patch({ runner: { fallbackModel } })} />
        </SettingRow>
        <SettingRow label={t("ai.model.effort")} description={t("ai.model.effortDescription")}>
          <ReasoningEffort
            aria-label={t("ai.model.effort")}
            label={defaultModel?.label ?? t("ai.model.effortShort")}
            stops={EFFORT_OPTIONS.map((e) => effortLabel(e, currentLanguage()))}
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
              {currentLanguage() === "de" ? ULTRACODE_HINT_DE : ULTRACODE_HINT}
              {!ultracodeAvailable && (
                <span className="mt-1 block font-medium text-foreground/80">
                  {anyUltracode
                    ? t("ai.model.ultracodeUnsupported", { model: defaultModel?.label ?? t("ai.model.theDefaultModel") })
                    : t("ai.model.ultracodeMissing")}
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
        title={t("ai.autonomy.title")}
        icon={<ShieldAlert />}
        description={t("ai.autonomy.description")}
        actions={
          <Badge
            variant="outline"
            className={cn(
              "gap-1.5 font-normal",
              r.bypassPermissions ? "border-warning/30 bg-warning/[0.07] text-warning" : "border-brand/25 bg-brand-soft text-brand-strong",
            )}
          >
            <span className={cn("size-1.5 rounded-full", r.bypassPermissions ? "bg-warning" : "bg-brand")} />
            {r.bypassPermissions ? t("ai.autonomy.badgeBypass") : t("ai.autonomy.badgeAsk")}
          </Badge>
        }
      >
        <SettingRow
          label={t("ai.autonomy.bypass")}
          htmlFor="bypass"
          description={
            <Trans t={t} i18nKey="ai.autonomy.bypassDescription" values={{ flag: "--dangerously-skip-permissions" }} components={{ code: <code className="rounded-[4px] bg-secondary px-1 py-0.5 font-mono text-[11px]" /> }} />
          }
        >
          <Switch id="bypass" checked={r.bypassPermissions} onCheckedChange={setBypass} />
        </SettingRow>
        <div className="py-4">
          {r.bypassPermissions ? (
            <Callout tone="warning" title={t("ai.autonomy.onTitle")}>
              {t("ai.autonomy.onBody")}
            </Callout>
          ) : (
            <Callout tone="muted" title={t("ai.autonomy.offTitle")}>
              {t("ai.autonomy.offBody")}
            </Callout>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("ai.limits.title")} icon={<Gauge />} description={t("ai.limits.description")}>
        <SettingRow label={t("ai.limits.parallel")} htmlFor="max-runs" description={t("ai.limits.parallelDescription")}>
          <NumberField id="max-runs" min={1} max={32} value={r.maxConcurrentRuns} onCommit={(v) => v !== null && patch({ runner: { maxConcurrentRuns: v } })} />
        </SettingRow>
        <SettingRow label={t("ai.limits.timeout")} htmlFor="timeout" description={t("ai.limits.timeoutDescription")}>
          <NumberField id="timeout" min={1} max={1440} suffix={t("ai.limits.minutes")} value={r.runTimeoutMinutes} onCommit={(v) => v !== null && patch({ runner: { runTimeoutMinutes: v } })} />
        </SettingRow>
        <SettingRow
          label={t("ai.limits.compact")}
          htmlFor="auto-compact"
          description={t("ai.limits.compactDescription")}
        >
          <Select
            value={r.autoCompactPercent === undefined ? String(DEFAULT_AUTO_COMPACT_PERCENT) : r.autoCompactPercent === null ? "claude" : String(r.autoCompactPercent)}
            onValueChange={(v) => patch({ runner: { autoCompactPercent: v === "claude" ? null : Number(v) } })}
          >
            <SelectTrigger id="auto-compact" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {[40, 50, 60, 70, 80].map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {p === DEFAULT_AUTO_COMPACT_PERCENT ? t("ai.limits.compactAtDefault", { percent: p }) : t("ai.limits.compactAt", { percent: p })}
                </SelectItem>
              ))}
              <SelectItem value="claude">{t("ai.limits.compactNearlyFull")}</SelectItem>
              <SelectSeparator />
              <SelectItem value="0">{t("ai.limits.compactNever")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label={t("ai.limits.autoContinue")}
          htmlFor="auto-continue"
          description={t("ai.limits.autoContinueDescription")}
        >
          <Switch id="auto-continue" checked={r.autoContinueOnLimit ?? true} onCheckedChange={(autoContinueOnLimit) => patch({ runner: { autoContinueOnLimit } })} />
        </SettingRow>
        <SettingRow
          label={t("ai.limits.resume")}
          htmlFor="resume-after-restart"
          description={t("ai.limits.resumeDescription")}
        >
          <Switch id="resume-after-restart" checked={r.resumeAfterRestart ?? true} onCheckedChange={(resumeAfterRestart) => patch({ runner: { resumeAfterRestart } })} />
        </SettingRow>
        <SettingRow
          label={t("ai.limits.watchdog")}
          htmlFor="watchdog"
          description={t("ai.limits.watchdogDescription")}
        >
          <Switch id="watchdog" checked={r.watchdog ?? true} onCheckedChange={(watchdog) => patch({ runner: { watchdog } })} />
        </SettingRow>
        {(r.watchdog ?? true) && (
          <>
            <SettingRow label={t("ai.limits.stalled")} htmlFor="stall-minutes" description={t("ai.limits.stalledDescription")}>
              <NumberField
                id="stall-minutes"
                min={3}
                max={240}
                suffix={t("ai.limits.minutes")}
                value={r.stallMinutes ?? DEFAULT_STALL_MINUTES}
                onCommit={(v) => v !== null && patch({ runner: { stallMinutes: v } })}
              />
            </SettingRow>
            <SettingRow label={t("ai.limits.loop")} htmlFor="loop-repeats" description={t("ai.limits.loopDescription")}>
              <NumberField
                id="loop-repeats"
                min={3}
                max={50}
                suffix={t("ai.limits.times")}
                value={r.loopRepeats ?? DEFAULT_LOOP_REPEATS}
                onCommit={(v) => v !== null && patch({ runner: { loopRepeats: v } })}
              />
            </SettingRow>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Claude Code CLI" icon={<TerminalSquare />}>
        <SettingRow label={t("ai.cli.path")} htmlFor="claude-path" description={<InlineCode text={t("ai.cli.pathDescription")} />}>
          <CommitInput
            id="claude-path"
            className="w-72 font-mono text-[13px]"
            placeholder={t("ai.cli.autoDetect")}
            value={r.claudePath}
            onCommit={(claudePath) => patch({ runner: { claudePath: claudePath.trim() } })}
          />
        </SettingRow>
        <SettingRow
          label={t("ai.cli.configDir")}
          htmlFor="claude-config-dir"
          description={<InlineCode text={t("ai.cli.configDirDescription")} />}
        >
          <CommitInput
            id="claude-config-dir"
            className="w-72 font-mono text-[13px]"
            placeholder="~/.claude"
            value={r.claudeConfigDir}
            onCommit={(claudeConfigDir) => patch({ runner: { claudeConfigDir: claudeConfigDir.trim() } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("ai.advanced.title")} icon={<SlidersHorizontal />} description={t("ai.advanced.description")}>
        <SettingRow stacked label={t("ai.advanced.extraArgs")} htmlFor="extra-args" description={<InlineCode text={t("ai.advanced.extraArgsDescription")} />}>
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
              <Cpu className="size-5 text-warning" /> {t("ai.confirm.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("ai.confirm.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-warning text-black hover:bg-warning/90"
              onClick={() => patch({ runner: { bypassPermissions: true } })}
            >
              {t("ai.confirm.enable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

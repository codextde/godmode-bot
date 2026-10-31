import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { ArrowDownToLine, BrainCircuit, CheckCircle2, Download, ExternalLink, FileText, GitCommitHorizontal, Loader2, MoonStar, Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import type { DreamingSettings, Settings } from "@godmode/shared";
import { MAX_MEMORY_CHARS, MIN_MEMORY_CHARS, memoryBudget } from "@godmode/shared";
import { cronToHuman, validateCron } from "@/components/agents/cron";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { intlLocale } from "@/i18n";
import { qk } from "@/lib/queryKeys";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { ModelSelect } from "./ai-section";
import { ImportMemoryDialog } from "./import-memory-dialog";
import { ChoiceCards, CommitInput, NumberField, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

type Backend = Settings["memory"]["backend"];

const DREAM_SCHEDULES = [
  { cron: "0 3 * * *", labelKey: "memory.dreaming.schedules.night3" },
  { cron: "0 1 * * *", labelKey: "memory.dreaming.schedules.night1" },
  { cron: "0 3,15 * * *", labelKey: "memory.dreaming.schedules.twice" },
  { cron: "0 3 * * 0", labelKey: "memory.dreaming.schedules.sunday" },
] as const;
const CUSTOM = "__custom__";

export function MemorySection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const { patch } = useSettingsPatch();
  const m = settings.memory;
  const [params, setParams] = useSearchParams();
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    if (params.get("import") === "1") setImportOpen(true);
  }, [params]);
  const onImportOpen = (open: boolean) => {
    setImportOpen(open);
    if (!open && params.has("import")) {
      const next = new URLSearchParams(params);
      next.delete("import");
      setParams(next, { replace: true });
    }
  };

  return (
    <div className="space-y-5">
      <SectionHeading title={t("memory.title")} description={t("memory.description")} />

      <SettingsGroup title={t("memory.backend.title")} icon={<BrainCircuit />} bodyClassName="py-4">
        <ChoiceCards<Backend>
          name="memory-backend"
          value={m.backend}
          onChange={(backend) => patch({ memory: { backend } })}
          options={[
            {
              value: "files",
              icon: <FileText />,
              title: t("memory.backend.files"),
              badge: (
                <Badge variant="secondary" className="h-5 text-[10px]">
                  {t("memory.backend.recommended")}
                </Badge>
              ),
              description: <Trans t={t} i18nKey="memory.backend.filesDescription" components={{ c: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]" /> }} />,
            },
            {
              value: "claude-mem",
              icon: <Sparkles />,
              title: "claude-mem",
              description: (
                <>
                  {t("memory.backend.claudeMemDescription")}{" "}
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                    onClick={(e) => {
                      e.preventDefault();
                      void openExternal("https://github.com/thedotmack/claude-mem");
                    }}
                  >
                    {t("memory.backend.learnMore")} <ExternalLink className="size-3" />
                  </button>
                </>
              ),
            },
          ]}
        />
        {m.backend === "claude-mem" && <ClaudeMemStatus />}
      </SettingsGroup>

      <SettingsGroup title={t("memory.import.title")} icon={<ArrowDownToLine />}>
        <SettingRow label={t("memory.import.label")} description={t("memory.import.description")}>
          <Button variant="outline" size="sm" onClick={() => onImportOpen(true)}>
            {t("memory.import.button")}
          </Button>
        </SettingRow>
      </SettingsGroup>
      <ImportMemoryDialog open={importOpen} onOpenChange={onImportOpen} />

      <SettingsGroup title={t("memory.housekeeping.title")} icon={<GitCommitHorizontal />}>
        <SettingRow
          label={t("memory.housekeeping.inject")}
          htmlFor="inject-memory"
          description={<Trans t={t} i18nKey="memory.housekeeping.injectDescription" components={{ c: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]" /> }} />}
        >
          <Switch id="inject-memory" checked={m.injectMemory} onCheckedChange={(injectMemory) => patch({ memory: { injectMemory } })} />
        </SettingRow>
        <SettingRow
          label={t("memory.housekeeping.autoCommit")}
          htmlFor="auto-commit"
          description={t("memory.housekeeping.autoCommitDescription")}
        >
          <Switch id="auto-commit" checked={m.autoCommit} onCheckedChange={(autoCommit) => patch({ memory: { autoCommit } })} />
        </SettingRow>
        <SettingRow
          label={t("memory.housekeeping.reflect")}
          htmlFor="reflect"
          description={t("memory.housekeeping.reflectDescription")}
        >
          <Switch id="reflect" checked={m.reflectAfterRun} onCheckedChange={(reflectAfterRun) => patch({ memory: { reflectAfterRun } })} />
        </SettingRow>
      </SettingsGroup>

      <DreamingGroup dreaming={m.dreaming} onChange={(dreaming) => patch({ memory: { dreaming } })} />
    </div>
  );
}

function DreamingGroup({ dreaming: d, onChange }: { dreaming: DreamingSettings; onChange: (patch: Partial<DreamingSettings>) => void }) {
  const { t } = useTranslation("settings");
  const off = !d.enabled;
  return (
    <SettingsGroup title={t("memory.dreaming.title")} icon={<MoonStar />} description={t("memory.dreaming.description")}>
      <SettingRow label={t("memory.dreaming.enabled")} htmlFor="dream-enabled" description={t("memory.dreaming.enabledDescription")}>
        <Switch id="dream-enabled" checked={d.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
      </SettingRow>
      <SettingRow
        label={t("memory.dreaming.schedule")}
        htmlFor="dream-schedule"
        disabled={off}
        description={t("memory.dreaming.scheduleDescription")}
      >
        <DreamSchedule cron={d.cron} disabled={off} onChange={(cron) => onChange({ cron })} />
      </SettingRow>
      <SettingRow
        label={t("memory.dreaming.model")}
        htmlFor="dream-model"
        disabled={off}
        description={t("memory.dreaming.modelDescription")}
      >
        <ModelSelect id="dream-model" allowNone noneLabel={t("memory.dreaming.sameAsAgent")} disabled={off} value={d.model} onChange={(model) => onChange({ model })} />
      </SettingRow>
      <SettingRow
        label={t("memory.dreaming.size")}
        htmlFor="dream-memory-size"
        disabled={off}
        description={
          <Trans
            t={t}
            i18nKey="memory.dreaming.sizeDescription"
            values={{ limit: memoryBudget(d.maxMemoryChars).limit.toLocaleString(intlLocale()) }}
            components={{ c: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]" /> }}
          />
        }
      >
        <NumberField
          id="dream-memory-size"
          min={MIN_MEMORY_CHARS}
          max={MAX_MEMORY_CHARS}
          suffix={t("memory.dreaming.characters")}
          disabled={off}
          value={d.maxMemoryChars}
          onCommit={(v) => v !== null && onChange({ maxMemoryChars: v })}
          className="w-40"
        />
      </SettingRow>
      <SettingRow
        label={t("memory.dreaming.tidy")}
        htmlFor="dream-tidy"
        disabled={off}
        description={<Trans t={t} i18nKey="memory.dreaming.tidyDescription" components={{ c: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]" /> }} />}
      >
        <Switch id="dream-tidy" disabled={off} checked={d.tidyWorkspace} onCheckedChange={(tidyWorkspace) => onChange({ tidyWorkspace })} />
      </SettingRow>
      <SettingRow
        label={t("memory.dreaming.offers")}
        htmlFor="dream-offers"
        disabled={off}
        description={t("memory.dreaming.offersDescription")}
      >
        <Switch id="dream-offers" disabled={off} checked={d.offers} onCheckedChange={(offers) => onChange({ offers })} />
      </SettingRow>
      <SettingRow
        label={t("memory.dreaming.minExchanges")}
        htmlFor="dream-min-exchanges"
        disabled={off}
        description={t("memory.dreaming.minExchangesDescription")}
      >
        <NumberField
          id="dream-min-exchanges"
          min={0}
          max={1000}
          suffix={t("memory.dreaming.exchanges")}
          disabled={off}
          value={d.minNewExchanges}
          onCommit={(v) => v !== null && onChange({ minNewExchanges: v })}
          className="w-40"
        />
      </SettingRow>
      <SettingRow
        label={t("memory.dreaming.refresh")}
        htmlFor="dream-refresh-days"
        disabled={off}
        description={t("memory.dreaming.refreshDescription")}
      >
        <NumberField
          id="dream-refresh-days"
          min={0}
          max={365}
          suffix={d.refreshDays === 0 ? t("memory.dreaming.never") : t("memory.dreaming.days", { count: d.refreshDays })}
          disabled={off}
          value={d.refreshDays}
          onCommit={(v) => v !== null && onChange({ refreshDays: v })}
          className="w-40"
        />
      </SettingRow>
    </SettingsGroup>
  );
}

/** Schedule presets + "Custom…" for any 5-field cron expression. */
function DreamSchedule({ cron, disabled, onChange }: { cron: string; disabled: boolean; onChange: (cron: string) => void }) {
  const { t } = useTranslation("settings");
  const normalized = cron.trim().replace(/\s+/g, " ");
  const preset = DREAM_SCHEDULES.find((s) => s.cron === normalized);
  const [customMode, setCustomMode] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const custom = customMode || !preset;

  return (
    <div className="flex w-full flex-col items-stretch gap-2 @xl:w-72">
      <Select
        value={custom ? CUSTOM : preset.cron}
        disabled={disabled}
        onValueChange={(v) => {
          setCustomMode(v === CUSTOM);
          if (v === CUSTOM) return;
          setProblem(null);
          onChange(v);
        }}
      >
        <SelectTrigger id="dream-schedule" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DREAM_SCHEDULES.map((s) => (
            <SelectItem key={s.cron} value={s.cron}>
              {t(s.labelKey)}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>{t("memory.dreaming.custom")}</SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <>
          <CommitInput
            aria-label={t("memory.dreaming.customLabel")}
            autoFocus={customMode && !!preset}
            delay={null}
            disabled={disabled}
            className="font-mono text-[13px]"
            placeholder="0 3 * * *"
            aria-invalid={!!problem}
            aria-describedby="dream-schedule-hint"
            value={cron}
            onCommit={(v) => {
              const next = v.trim().replace(/\s+/g, " ");
              if (!next || next === normalized) return setProblem(null);
              const fields = next.split(" ").length;
              const invalid = fields === 5 ? validateCron(next) : t("memory.dreaming.expectedFields", { count: fields });
              setProblem(invalid);
              if (invalid) toast.error(t("memory.dreaming.invalid"), { description: invalid });
              else onChange(next);
            }}
          />
          <p id="dream-schedule-hint" className={cn("text-[11px] leading-relaxed", problem ? "text-destructive" : "text-muted-foreground")}>
            {problem ? t("memory.dreaming.stillDreaming", { problem, schedule: cronToHuman(cron).replace(/^./, (c) => c.toLowerCase()) }) : cronToHuman(cron)} ·{" "}
            <span className="font-mono whitespace-nowrap">{t("memory.dreaming.cronFields")}</span>
          </p>
        </>
      )}
    </div>
  );
}

/** Install state of the optional claude-mem plugin (managed by Godmode, per-agent stores). */
function ClaudeMemStatus() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const doctor = useQuery({ queryKey: qk.doctor, queryFn: () => api.doctor.get() });
  const dep = doctor.data?.dependencies.find((d) => d.id === "claude-mem");
  const install = useMutation({
    mutationFn: () => api.doctor.install("claude-mem"),
    onSuccess: (res) => {
      if (res.ok) toast.success(t("memory.claudeMem.installed"), { description: t("memory.claudeMem.installedDescription") });
      else toast.error(t("memory.claudeMem.installError"), { description: res.output.split("\n").at(-1) });
      void qc.invalidateQueries({ queryKey: qk.doctor });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (doctor.isLoading) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border bg-paper-2 px-4 py-3 text-sm">
      {dep?.ok ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <CheckCircle2 className="size-4 text-success" /> {t("memory.claudeMem.ready", { version: dep.version })}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">
            <Trans t={t} i18nKey="memory.claudeMem.missing" components={{ c: <code className="font-mono text-[11px]" /> }} />{" "}
            {dep?.detail?.includes("Node.js") && t("memory.claudeMem.needsNode")}
          </p>
          <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending || dep?.installable === false}>
            {install.isPending ? <Loader2 className="animate-spin" /> : <Download />} {t("memory.claudeMem.install")}
          </Button>
        </>
      )}
    </div>
  );
}

import { useState } from "react";
import { BrainCircuit, CheckCircle2, Download, ExternalLink, FileText, GitCommitHorizontal, Loader2, MoonStar, Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DreamingSettings, Settings } from "@godmode/shared";
import { cronToHuman, validateCron } from "@/components/agents/cron";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { ModelSelect } from "./ai-section";
import { ChoiceCards, CommitInput, NumberField, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

type Backend = Settings["memory"]["backend"];

const DREAM_SCHEDULES = [
  { cron: "0 3 * * *", label: "Every night at 3:00" },
  { cron: "0 1 * * *", label: "Every night at 1:00" },
  { cron: "0 3,15 * * *", label: "Twice a day (3:00 and 15:00)" },
  { cron: "0 3 * * 0", label: "Every Sunday at 3:00" },
];
const CUSTOM = "__custom__";

export function MemorySection({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const m = settings.memory;

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Memory"
        description="Agents remember your preferences, facts and learnings across conversations — stored in each agent's own git repository on this machine."
      />

      <SettingsGroup title="Memory backend" icon={<BrainCircuit />} bodyClassName="py-4">
        <ChoiceCards<Backend>
          name="memory-backend"
          value={m.backend}
          onChange={(backend) => patch({ memory: { backend } })}
          options={[
            {
              value: "files",
              icon: <FileText />,
              title: "Markdown files",
              badge: (
                <Badge variant="secondary" className="h-5 text-[10px]">
                  Recommended
                </Badge>
              ),
              description: (
                <>
                  Each agent keeps <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]">MEMORY.md</code> and a{" "}
                  <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]">memory/</code> folder. Plain text you can read and edit — nothing
                  to install.
                </>
              ),
            },
            {
              value: "claude-mem",
              icon: <Sparkles />,
              title: "claude-mem",
              description: (
                <>
                  Automatic, searchable long-term memory via the open-source claude-mem plugin. Captures context from every session; data stays
                  inside the agent's repo.{" "}
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                    onClick={(e) => {
                      e.preventDefault();
                      void openExternal("https://github.com/thedotmack/claude-mem");
                    }}
                  >
                    Learn more <ExternalLink className="size-3" />
                  </button>
                </>
              ),
            },
          ]}
        />
        {m.backend === "claude-mem" && <ClaudeMemStatus />}
      </SettingsGroup>

      <SettingsGroup title="Housekeeping" icon={<GitCommitHorizontal />}>
        <SettingRow
          label="Load memory into every chat"
          htmlFor="inject-memory"
          description={
            <>
              The agent starts each new chat already knowing its <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]">MEMORY.md</code> — no
              need to look things up first.
            </>
          }
        >
          <Switch id="inject-memory" checked={m.injectMemory} onCheckedChange={(injectMemory) => patch({ memory: { injectMemory } })} />
        </SettingRow>
        <SettingRow
          label="Auto-commit after every run"
          htmlFor="auto-commit"
          description="Snapshots the agent's memory, transcripts and files into git so you can see — and undo — what changed."
        >
          <Switch id="auto-commit" checked={m.autoCommit} onCheckedChange={(autoCommit) => patch({ memory: { autoCommit } })} />
        </SettingRow>
        <SettingRow
          label="Reflect after each run"
          htmlFor="reflect"
          description="The agent spends a moment writing down what it learned (costs a few extra tokens, makes it noticeably smarter over time)."
        >
          <Switch id="reflect" checked={m.reflectAfterRun} onCheckedChange={(reflectAfterRun) => patch({ memory: { reflectAfterRun } })} />
        </SettingRow>
      </SettingsGroup>

      <DreamingGroup dreaming={m.dreaming} onChange={(dreaming) => patch({ memory: { dreaming } })} />
    </div>
  );
}

function DreamingGroup({ dreaming: d, onChange }: { dreaming: DreamingSettings; onChange: (patch: Partial<DreamingSettings>) => void }) {
  const off = !d.enabled;
  return (
    <SettingsGroup
      title="Dreaming"
      icon={<MoonStar />}
      description="While you're away, agents review their recent conversations and rewrite their memory: they pick up what they learned, merge duplicates, fix contradictions and update dates — like sleeping on it. Every dream can be reviewed and undone in the agent's Memory tab."
    >
      <SettingRow
        label="Dream while idle"
        htmlFor="dream-enabled"
        description="Agents consolidate their memory in the background, on the schedule below."
      >
        <Switch id="dream-enabled" checked={d.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
      </SettingRow>
      <SettingRow
        label="Schedule"
        htmlFor="dream-schedule"
        disabled={off}
        description="In this computer's local time. Dreams missed while it was off or asleep are caught up when it wakes."
      >
        <DreamSchedule cron={d.cron} disabled={off} onChange={(cron) => onChange({ cron })} />
      </SettingRow>
      <SettingRow
        label="Model"
        htmlFor="dream-model"
        disabled={off}
        description="Consolidating memory is careful reading, not heavy lifting — Sonnet does it well for a fraction of the cost."
      >
        <ModelSelect id="dream-model" allowNone noneLabel="Same as the agent" disabled={off} value={d.model} onChange={(model) => onChange({ model })} />
      </SettingRow>
      <SettingRow
        label="Minimum new exchanges"
        htmlFor="dream-min-exchanges"
        disabled={off}
        description="A scheduled dream waits until the agent has had at least this many new exchanges since its last one."
      >
        <NumberField
          id="dream-min-exchanges"
          min={0}
          max={1000}
          suffix="exchanges"
          disabled={off}
          value={d.minNewExchanges}
          onCommit={(v) => v !== null && onChange({ minNewExchanges: v })}
          className="w-40"
        />
      </SettingRow>
      <SettingRow
        label="Refresh dates after"
        htmlFor="dream-refresh-days"
        disabled={off}
        description="Without enough new activity, still dream when the last dream is this old and the memory mentions dates — so plans that have passed become past events. 0 = never."
      >
        <NumberField
          id="dream-refresh-days"
          min={0}
          max={365}
          suffix={d.refreshDays === 0 ? "never" : d.refreshDays === 1 ? "day" : "days"}
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
              {s.label}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <>
          <CommitInput
            aria-label="Custom dreaming schedule (cron expression)"
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
              const invalid = fields === 5 ? validateCron(next) : `Expected 5 fields (minute hour day month weekday), got ${fields}`;
              setProblem(invalid);
              if (invalid) toast.error("That schedule isn't valid", { description: invalid });
              else onChange(next);
            }}
          />
          <p id="dream-schedule-hint" className={cn("text-[11px] leading-relaxed", problem ? "text-destructive" : "text-muted-foreground")}>
            {problem ? `${problem} — still dreaming ${cronToHuman(cron).replace(/^./, (c) => c.toLowerCase())}.` : cronToHuman(cron)} ·{" "}
            <span className="font-mono whitespace-nowrap">minute hour day month weekday</span>
          </p>
        </>
      )}
    </div>
  );
}

/** Install state of the optional claude-mem plugin (managed by Godmode, per-agent stores). */
function ClaudeMemStatus() {
  const qc = useQueryClient();
  const doctor = useQuery({ queryKey: qk.doctor, queryFn: () => api.doctor.get() });
  const dep = doctor.data?.dependencies.find((d) => d.id === "claude-mem");
  const install = useMutation({
    mutationFn: () => api.doctor.install("claude-mem"),
    onSuccess: (res) => {
      if (res.ok) toast.success("claude-mem installed", { description: "Agents use it from their next run." });
      else toast.error("claude-mem could not be installed", { description: res.output.split("\n").at(-1) });
      void qc.invalidateQueries({ queryKey: qk.doctor });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (doctor.isLoading) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border bg-paper-2 px-4 py-3 text-sm">
      {dep?.ok ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <CheckCircle2 className="size-4 text-success" /> claude-mem {dep.version} is installed. Each agent keeps its own isolated store.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">
            claude-mem isn't installed yet — until it is, agents keep using <code className="font-mono text-[11px]">MEMORY.md</code>.{" "}
            {dep?.detail?.includes("Node.js") && "It needs Node.js 20+."}
          </p>
          <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending || dep?.installable === false}>
            {install.isPending ? <Loader2 className="animate-spin" /> : <Download />} Install
          </Button>
        </>
      )}
    </div>
  );
}

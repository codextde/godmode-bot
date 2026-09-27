import { BrainCircuit, ExternalLink, FileText, GitCommitHorizontal, Sparkles } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { openExternal } from "@/lib/desktop";
import { ChoiceCards, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

type Backend = Settings["memory"]["backend"];

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
                  Each agent keeps <code className="rounded bg-muted px-1 font-mono text-[11px]">MEMORY.md</code> and a{" "}
                  <code className="rounded bg-muted px-1 font-mono text-[11px]">memory/</code> folder. Plain text you can read and edit — nothing
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
      </SettingsGroup>

      <SettingsGroup title="Housekeeping" icon={<GitCommitHorizontal />}>
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
    </div>
  );
}

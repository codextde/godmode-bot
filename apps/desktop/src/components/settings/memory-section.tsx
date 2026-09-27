import { BrainCircuit, CheckCircle2, Download, ExternalLink, FileText, GitCommitHorizontal, Loader2, Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Settings } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
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
        {m.backend === "claude-mem" && <ClaudeMemStatus />}
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
    <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
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

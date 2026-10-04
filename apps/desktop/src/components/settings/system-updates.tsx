import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ArrowDown, ArrowRight, CircleCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { MaintenanceStatus, Settings, ToolId, ToolUpdateResult, ToolUpdateStatus, UpdateReport } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { SettingRow, useSettingsPatch } from "./settings-kit";

const lastLines = (output: string) => output.split("\n").filter((l) => l.trim()).slice(-3).join("\n") || "The update finished without installing anything.";

const due = (report: UpdateReport | undefined) => report?.tools.filter((t) => t.installed && t.updatable && t.updateAvailable) ?? [];

function toastUpdates(results: ToolUpdateResult[]) {
  for (const r of results) {
    if (!r.ok) toast.error(`Couldn't update ${r.name}`, { description: <span className="whitespace-pre-line">{lastLines(r.output)}</span> });
    // Something else (the background upkeep, another window) installed it in the meantime.
    else if (r.upToDate) toast.info(`${r.name} is already up to date`);
    else toast.success(`${r.name}${r.version ? ` ${r.version}` : ""}`, { description: r.previous ? `Updated from ${r.previous}.` : "Updated." });
  }
}

export function useToolUpdates() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.toolUpdates, queryFn: () => api.doctor.updates(false), staleTime: 5 * 60_000 });
  const check = useMutation({
    mutationFn: () => api.doctor.updates(true),
    onSuccess: (report) => qc.setQueryData(qk.toolUpdates, report),
    onError: (e) => toast.error("Couldn't check for updates", { description: errorMessage(e) }),
  });
  // One tool (variables = its id) or everything that is due (no variables).
  const update = useMutation({
    mutationFn: (id?: ToolId) => api.doctor.update(id),
    onSuccess: (results) => {
      if (results.length) toastUpdates(results);
      else toast.info("Everything is up to date");
      // Versions in the system check and the sidebar's Claude Code button change too.
      void qc.invalidateQueries({ queryKey: qk.doctor });
    },
    onError: (e) => toast.error("Couldn't install the update", { description: errorMessage(e) }),
  });
  return { ...query, check, update, due: due(query.data) };
}

/** "Check now" and "Update all" for the group header. */
export function UpdateActions({ updates }: { updates: ReturnType<typeof useToolUpdates> }) {
  const { check, update, due } = updates;
  const updatingAll = update.isPending && update.variables === undefined;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => check.mutate()} disabled={check.isPending || update.isPending}>
        {check.isPending ? <Spinner /> : <RefreshCw />} Check now
      </Button>
      {due.length > 0 && (
        <Button size="sm" onClick={() => update.mutate(undefined)} disabled={update.isPending}>
          {updatingAll ? <Spinner /> : <ArrowDown />}
          {updatingAll ? "Updating…" : due.length === 1 ? "Update" : `Update all ${due.length}`}
        </Button>
      )}
    </>
  );
}

/** Installed tools with their version, and an update button where Godmode can install one. */
export function ToolUpdateList({ updates }: { updates: ReturnType<typeof useToolUpdates> }) {
  const { data, isLoading, isError, error, refetch, update } = updates;
  if (isLoading)
    return (
      <div className="space-y-2 py-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 rounded-lg" />
        ))}
      </div>
    );
  if (isError || !data)
    return (
      <div className="py-4 text-sm">
        <p className="font-medium text-destructive">Could not look for updates</p>
        <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  const installed = data.tools.filter((t) => t.installed);
  if (!installed.length) return <p className="py-4 text-sm text-muted-foreground">No tools are installed yet — install them from the system check above.</p>;
  return (
    <>
      {installed.map((tool) => (
        <ToolRow
          key={tool.id}
          tool={tool}
          updating={update.isPending && (update.variables === tool.id || (update.variables === undefined && tool.updateAvailable && tool.updatable))}
          disabled={update.isPending}
          onUpdate={() => update.mutate(tool.id)}
        />
      ))}
      <p className="py-3 text-xs text-muted-foreground">Checked {formatDistanceToNow(new Date(data.checkedAt), { addSuffix: true })}.</p>
    </>
  );
}

function ToolRow({ tool, updating, disabled, onUpdate }: { tool: ToolUpdateStatus; updating: boolean; disabled: boolean; onUpdate: () => void }) {
  const available = tool.updateAvailable && tool.updatable;
  // Only claim it when it is known: the pinned version is the one installed, or the release feed answered.
  const upToDate = tool.track === "pinned" ? !!tool.current && tool.current === tool.latest : tool.track === "release" && !!tool.latest && !tool.updateAvailable;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{tool.name}</span>
          {tool.current && <span className="font-mono text-xs text-muted-foreground tabular-nums">{tool.current}</span>}
          {available && tool.latest && (
            <span className="flex items-center gap-1 font-mono text-xs text-foreground tabular-nums">
              <ArrowRight className="size-3 text-muted-foreground" aria-label="to" />
              {tool.latest}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{tool.detail}</p>
      </div>
      {available ? (
        <Button size="sm" variant="outline" onClick={onUpdate} disabled={disabled}>
          {updating ? <Spinner /> : <ArrowDown />}
          {updating ? "Updating…" : "Update"}
        </Button>
      ) : (
        upToDate && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <CircleCheck className="size-3.5 text-success" /> Up to date
          </span>
        )
      )}
    </div>
  );
}

function describePass(status: MaintenanceStatus): string {
  if (status.running) return "Working on it right now…";
  if (!status.lastRunAt) return status.nextRunAt ? `First look ${formatDistanceToNow(new Date(status.nextRunAt), { addSuffix: true })}.` : "Hasn't run yet.";
  const fixed = status.fixes.filter((f) => f.outcome === "fixed").map((f) => f.name);
  const updated = status.updates.filter((u) => u.ok).map((u) => `${u.name}${u.version ? ` ${u.version}` : ""}`);
  const failed = [...status.fixes.filter((f) => f.outcome === "failed").map((f) => f.name), ...status.updates.filter((u) => !u.ok).map((u) => u.name)];
  const did = [fixed.length ? `fixed ${fixed.join(", ")}` : "", updated.length ? `updated ${updated.join(", ")}` : "", failed.length ? `couldn't handle ${failed.join(", ")}` : ""].filter(Boolean);
  const when = formatDistanceToNow(new Date(status.lastRunAt), { addSuffix: true });
  return `Last look ${when}: ${did.length ? did.join("; ") : "nothing to do"}.${status.postponed ? ` ${status.postponed}` : ""}`;
}

/** Switches for the background upkeep, and what its last pass did. */
export function UpkeepSettings({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const { data } = useQuery({ queryKey: qk.maintenance, queryFn: api.doctor.maintenance, staleTime: 30_000 });
  const { autoFix, autoUpdate } = settings.maintenance;
  return (
    <>
      <SettingRow
        label="Update tools automatically"
        description="Godmode looks for new versions a few times a day and installs them while no agent is working."
        htmlFor="maintenance-auto-update"
      >
        <Switch id="maintenance-auto-update" checked={autoUpdate} onCheckedChange={(on) => patch({ maintenance: { autoUpdate: on } })} />
      </SettingRow>
      <SettingRow
        label="Fix problems automatically"
        description="Repairs the permissions of Godmode's own files and installs required tools again when they went missing. It never opens a system dialog on its own."
        htmlFor="maintenance-auto-fix"
      >
        <Switch id="maintenance-auto-fix" checked={autoFix} onCheckedChange={(on) => patch({ maintenance: { autoFix: on } })} />
      </SettingRow>
      {(autoFix || autoUpdate) && data && <p className="py-3 text-xs text-muted-foreground">{describePass(data)}</p>}
    </>
  );
}

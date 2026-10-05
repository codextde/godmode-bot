import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ArrowRight, CalendarClock } from "lucide-react";
import type { AgentTemplate, TeamTemplate } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { localTimezone } from "@/components/agents/cron";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { useAgentTemplates, useScopeWorkspace, useTeamTemplates } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";

const face = (t: Pick<AgentTemplate, "id" | "avatar" | "color" | "character">) => ({ id: t.id, avatar: t.avatar, color: t.color, character: t.character });

/**
 * Whole teams to start with — a lead and its reports, wired up in the org chart — next to the single agents. One click
 * (and a look at who leads whom) instead of hiring one agent at a time.
 */
export function TeamTemplates({ compact }: { compact?: boolean }) {
  const teams = useTeamTemplates();
  const { data: agents = [] } = useAgentTemplates();
  const [picked, setPicked] = useState<TeamTemplate | null>(null);
  const byId = new Map(agents.map((a) => [a.id, a]));
  if (teams.isError) return null;
  return (
    <>
      <div className={compact ? "grid grid-cols-1 gap-3 @2xl:grid-cols-2" : "grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-4"}>
        {teams.isLoading &&
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="min-h-36 rounded-xl border bg-card p-4 shadow-card">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-4 h-7 w-40" />
            </div>
          ))}
        {(teams.data ?? []).map((team, i) => (
          <motion.button
            key={team.id}
            type="button"
            onClick={() => setPicked(team)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 8) * 0.04 }}
            className="group flex min-h-36 flex-col rounded-xl border bg-card p-4 text-left shadow-card transition hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span className="flex items-center gap-2 font-medium tracking-[-0.01em]">
              <span aria-hidden>{team.icon}</span> {team.name}
              <ArrowRight className="ml-auto size-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" aria-hidden />
            </span>
            <span className="mt-1 line-clamp-2 flex-1 text-sm text-muted-foreground">{team.description}</span>
            <span className="mt-3 flex items-center" aria-label={`${team.lead.role} and ${team.members.length} reports`}>
              <AgentAvatar agent={face(team.lead)} size="sm" still className="size-7 rounded-lg ring-2 ring-card" />
              {team.members.map((m) => {
                const t = byId.get(m);
                return t ? <AgentAvatar key={m} agent={face(t)} size="sm" still className="-ml-1.5 size-6 rounded-lg ring-2 ring-card" /> : null;
              })}
              <span className="ml-2 text-xs text-muted-foreground">{team.members.length + 1} agents</span>
            </span>
          </motion.button>
        ))}
      </div>
      <InstallTeamDialog team={picked} members={picked ? picked.members.map((m) => byId.get(m)).filter((t): t is AgentTemplate => !!t) : []} onClose={() => setPicked(null)} />
    </>
  );
}

function InstallTeamDialog({ team, members, onClose }: { team: TeamTemplate | null; members: AgentTemplate[]; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspace = useScopeWorkspace();
  const setAgentsView = useUi((s) => s.setAgentsView);
  const [automations, setAutomations] = useState(true);
  const scheduled = members.filter((m) => m.routine);
  const install = useMutation({
    // Schedules in the human's own time zone (the core may run elsewhere: Cloud, a server).
    mutationFn: () => api.agents.installTeam(team!.id, { workspaceId: workspace?.id ?? null, automations, timezone: localTimezone() }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.routines });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      toast.success(`Your ${team!.name} team is ready`, {
        description: `${res.lead.name} leads ${res.members.map((m) => m.name).join(", ")}.${res.automations ? ` ${res.automations} automation${res.automations === 1 ? "" : "s"} set up.` : ""}`,
      });
      onClose();
      setAgentsView("chart");
      navigate("/agents");
    },
    onError: (err) => toast.error("Couldn't start the team", { description: errorMessage(err) }),
  });
  return (
    <Dialog open={!!team} onOpenChange={(o) => !o && !install.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {team && (
          <>
            <DialogHeader>
              <DialogTitle>
                {team.icon} Start the {team.name} team
              </DialogTitle>
              <DialogDescription>{team.description}</DialogDescription>
            </DialogHeader>
            <div className="rounded-xl border bg-card p-3">
              <div className="flex items-center gap-3">
                <AgentAvatar agent={face(team.lead)} size="md" still />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {team.lead.name} <span className="font-normal text-muted-foreground">· {team.lead.role}, leads the team</span>
                  </p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{team.lead.description}</p>
                </div>
              </div>
              <ul className="mt-3 space-y-2 border-l pl-4" aria-label="Reports to the lead">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center gap-2.5">
                    <AgentAvatar agent={face(m)} size="sm" still className="size-6 rounded-md" />
                    <span className="min-w-0 truncate text-sm">
                      {m.name} <span className="text-muted-foreground">· {m.role}</span>
                    </span>
                    {m.routine && <CalendarClock className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-label="Comes with a schedule" />}
                  </li>
                ))}
              </ul>
            </div>
            {scheduled.length > 0 && (
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox checked={automations} onCheckedChange={(v) => setAutomations(v === true)} className="mt-0.5" />
                <span>
                  Set up their schedules too
                  <span className="block text-xs text-muted-foreground">
                    {scheduled.map((m) => m.routine!.name).join(", ")} — you can change or pause them under Automations.
                  </span>
                </span>
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              {workspace ? `They join the ${workspace.name} workspace.` : "They work across all workspaces."} Each agent is yours to adjust afterwards.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={install.isPending}>
                Cancel
              </Button>
              <Button onClick={() => install.mutate()} disabled={install.isPending}>
                {install.isPending && <Spinner />} Start the team
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

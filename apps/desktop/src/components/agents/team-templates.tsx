import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Archive, ArrowRight, Briefcase, Building2, CalendarClock, Code, FlaskConical, Handshake, Megaphone, Rocket, ShoppingBag, UserRound, Users, type LucideIcon } from "lucide-react";
import type { AgentTemplate, OrgTemplateNode, TeamTemplate } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { localTimezone } from "@/components/agents/cron";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { useAgentTemplates, useScopeWorkspace, useTeamTemplates, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  rocket: Rocket,
  briefcase: Briefcase,
  "shopping-bag": ShoppingBag,
  building: Building2,
  "user-round": UserRound,
  archive: Archive,
  megaphone: Megaphone,
  handshake: Handshake,
  code: Code,
  flask: FlaskConical,
};

const face = (t: Pick<AgentTemplate, "id" | "avatar" | "color" | "character">) => ({ id: t.id, avatar: t.avatar, color: t.color, character: t.character });

interface Seat {
  path: string;
  depth: number;
  template: AgentTemplate;
  reports: Seat[];
}

function seatsOf(node: OrgTemplateNode, byId: Map<string, AgentTemplate>, path = "0", depth = 0): Seat | null {
  const template = byId.get(node.template);
  if (!template) return null;
  const reports = (node.reports ?? []).map((r, i) => seatsOf(r, byId, `${path}.${i}`, depth + 1)).filter((s): s is Seat => !!s);
  return { path, depth, template, reports };
}

const flat = (s: Seat): Seat[] => [s, ...s.reports.flatMap(flat)];

export function StructureIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? Users;
  return (
    <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card", className)}>
      <Icon className="size-4" />
    </span>
  );
}

/**
 * Org charts to start with: whole companies (a CEO, its executives and their teams) and single teams, wired up in the
 * org chart in one go instead of hiring one agent at a time.
 */
export function TeamTemplates({ kinds = ["company", "team"] }: { kinds?: TeamTemplate["kind"][] }) {
  const teams = useTeamTemplates();
  const { data: agents = [] } = useAgentTemplates();
  const [kind, setKind] = useState<TeamTemplate["kind"]>(kinds[0]!);
  const [picked, setPicked] = useState<TeamTemplate | null>(null);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  if (teams.isError) return null;
  const shown = (teams.data ?? []).filter((t) => t.kind === kind);
  return (
    <>
      {kinds.length > 1 && (
        <div role="tablist" aria-label="Kind of structure" className="mb-4 inline-flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
          {kinds.map((k) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "relative rounded-md px-3 py-1 text-sm transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                kind === k ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {kind === k && <motion.span layoutId="structure-kind" className="absolute inset-0 rounded-md border bg-card shadow-card" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} />}
              <span className="relative">{k === "company" ? "Companies" : "Teams"}</span>
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {teams.isLoading &&
          Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="min-h-56 rounded-xl border bg-card p-4 shadow-card">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mx-auto mt-8 size-9 rounded-lg" />
              <Skeleton className="mt-4 h-8 w-full" />
            </div>
          ))}
        <AnimatePresence mode="popLayout" initial={false}>
          {shown.map((team, i) => {
            const root = seatsOf(team.root, byId);
            return root ? <StructureCard key={team.id} team={team} root={root} index={i} onPick={() => setPicked(team)} /> : null;
          })}
        </AnimatePresence>
      </div>
      <InstallDialog team={picked} root={picked ? seatsOf(picked.root, byId) : null} onClose={() => setPicked(null)} />
    </>
  );
}

function StructureCard({ team, root, index, onPick }: { team: TeamTemplate; root: Seat; index: number; onPick: () => void }) {
  const total = flat(root).length;
  return (
    <motion.button
      layout
      type="button"
      onClick={onPick}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ delay: Math.min(index, 8) * 0.04, duration: 0.22 }}
      className="group flex flex-col rounded-xl border bg-card p-4 text-left shadow-card transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="flex items-start gap-3">
        <StructureIcon icon={team.icon} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-medium tracking-[-0.01em]">
            {team.name}
            <span className="rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground tabular-nums">{total} agents</span>
          </span>
          <span className="mt-0.5 line-clamp-2 block text-[13px] leading-5 text-muted-foreground">{team.description}</span>
        </span>
      </span>
      <MiniChart root={root} />
      <span className="mt-3 flex items-center gap-1 border-t pt-3 text-xs text-muted-foreground transition group-hover:text-foreground">
        {root.template.name} with {root.reports.map((r) => r.template.name).slice(0, 3).join(", ")}
        {root.reports.length > 3 && ` +${root.reports.length - 3}`}
        <ArrowRight className="ml-auto size-3.5 shrink-0 transition group-hover:translate-x-0.5" aria-hidden />
      </span>
    </motion.button>
  );
}

/** The chart in miniature: the top, a line down, its reports in a row with the size of their own teams. */
function MiniChart({ root }: { root: Seat }) {
  return (
    <span aria-hidden className="mt-5 mb-1 flex flex-col items-center">
      <AgentAvatar agent={face(root.template)} size="md" still className="rounded-xl ring-4 ring-card" />
      <span className="h-3 w-px bg-border" />
      <span className="relative flex justify-center gap-1.5">
        {root.reports.length > 1 && <span className="absolute top-0 right-[1.125rem] left-[1.125rem] h-px bg-border" />}
        {root.reports.map((r) => (
          <span key={r.path} className="flex w-9 flex-col items-center">
            <span className="h-2.5 w-px bg-border" />
            <AgentAvatar agent={face(r.template)} size="sm" still className="size-7 rounded-lg ring-2 ring-card" />
            <span className={cn("mt-1 h-4 text-[10px] text-muted-foreground tabular-nums", !r.reports.length && "invisible")}>+{flat(r).length - 1}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

const NEW = "__new";
const GLOBAL = "__global";

function InstallDialog({ team, root, onClose }: { team: TeamTemplate | null; root: Seat | null; onClose: () => void }) {
  return (
    <Dialog open={!!team && !!root} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-5 sm:max-w-xl">{team && root && <InstallForm key={team.id} team={team} root={root} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

function InstallForm({ team, root, onClose }: { team: TeamTemplate; root: Seat; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const scoped = useScopeWorkspace();
  const scope = useUi((s) => s.workspace);
  const setWorkspace = useUi((s) => s.setWorkspace);
  const setAgentsView = useUi((s) => s.setAgentsView);
  const { data: workspaces = [] } = useWorkspaces();
  const [where, setWhere] = useState(team.kind === "company" ? NEW : (scoped?.id ?? GLOBAL));
  const [wsName, setWsName] = useState(team.name);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [automations, setAutomations] = useState(true);
  const seats = flat(root);
  const kept = seats.filter((s) => !skip.has(s.path));
  const scheduled = kept.filter((s) => s.template.routine);
  const names = new Map(seats.map((s) => [s.path, s.template.name]));
  const parentOf = (path: string) => path.split(".").slice(0, -1).join(".");
  const leadName = (path: string) => {
    let at = parentOf(path);
    while (at && skip.has(at)) at = parentOf(at);
    return names.get(at) ?? root.template.name;
  };

  const install = useMutation({
    // Schedules in the human's own time zone (the core may run elsewhere: Cloud, a server).
    mutationFn: () =>
      api.agents.installTeam(team.id, {
        ...(where === NEW ? { newWorkspace: { name: wsName.trim(), color: root.template.color } } : { workspaceId: where === GLOBAL ? null : where }),
        automations: automations && scheduled.length > 0,
        timezone: localTimezone(),
        skip: [...skip],
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.routines });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      if (res.workspace) qc.invalidateQueries({ queryKey: qk.workspaces });
      const place = res.workspace ? ` in ${res.workspace.name}` : "";
      toast.success(`Your ${team.name.toLowerCase()} is ready`, {
        description: `${res.lead.name} leads ${res.members.length} agent${res.members.length === 1 ? "" : "s"}${place}.${res.automations ? ` ${res.automations} automation${res.automations === 1 ? "" : "s"} set up.` : ""}`,
      });
      onClose();
      setAgentsView("chart");
      // Show where they went, unless everything is on screen anyway.
      if (scope !== "all") setWorkspace(res.workspace?.id ?? (where === GLOBAL ? "global" : where));
      navigate("/agents");
    },
    onError: (err) => toast.error(`Couldn't set up the ${team.name.toLowerCase()}`, { description: errorMessage(err) }),
  });

  const toggle = (path: string) =>
    setSkip((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const canInstall = kept.length > 1 && (where !== NEW || wsName.trim().length > 0) && !install.isPending;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          <StructureIcon icon={team.icon} className="size-8" /> {team.kind === "company" ? `Start a ${team.name.toLowerCase()}` : `Start the ${team.name} team`}
        </DialogTitle>
        <DialogDescription>{team.description}</DialogDescription>
      </DialogHeader>

      <div className="-mx-1 max-h-[42vh] overflow-y-auto rounded-xl border bg-paper-2 p-2">
        <ul aria-label="Org chart">
          <SeatRow seat={root} skip={skip} onToggle={toggle} leadName={leadName} />
        </ul>
      </div>

      <div className="grid gap-3 @container">
        <div className="grid gap-1.5">
          <Label htmlFor="structure-where">Where they work</Label>
          <div className="flex flex-wrap gap-2">
            <Select value={where} onValueChange={setWhere}>
              <SelectTrigger id="structure-where" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW}>A new workspace</SelectItem>
                <SelectSeparator />
                <SelectItem value={GLOBAL}>Global (every workspace)</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {where === NEW && <Input value={wsName} onChange={(e) => setWsName(e.target.value)} aria-label="Name of the new workspace" placeholder="Workspace name" className="min-w-40 flex-1" maxLength={80} />}
          </div>
        </div>
        {scheduled.length > 0 && (
          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox checked={automations} onCheckedChange={(v) => setAutomations(v === true)} className="mt-0.5" />
            <span>
              Set up their {scheduled.length} schedule{scheduled.length === 1 ? "" : "s"} too
              <span className="block text-xs text-muted-foreground">
                {scheduled
                  .map((s) => s.template.routine!.name)
                  .slice(0, 4)
                  .join(", ")}
                {scheduled.length > 4 && ` and ${scheduled.length - 4} more`} — change or pause them under Automations.
              </span>
            </span>
          </label>
        )}
      </div>

      <DialogFooter className="items-center">
        <p className="mr-auto text-xs text-muted-foreground">Leads can hand work to their reports. Every agent is yours to adjust.</p>
        <Button variant="ghost" onClick={onClose} disabled={install.isPending}>
          Cancel
        </Button>
        <Button onClick={() => install.mutate()} disabled={!canInstall}>
          {install.isPending && <Spinner />} Hire {kept.length} agents
        </Button>
      </DialogFooter>
    </>
  );
}

function SeatRow({ seat, skip, onToggle, leadName, last }: { seat: Seat; skip: Set<string>; onToggle: (path: string) => void; leadName: (path: string) => string; last?: boolean }) {
  const off = skip.has(seat.path);
  const top = seat.depth === 0;
  const id = `seat-${seat.path}`;
  return (
    <li className="relative">
      {!top && (
        <>
          <span aria-hidden className="absolute top-0 -left-3 h-[1.125rem] w-3 rounded-bl-md border-b border-l border-border" />
          {!last && <span aria-hidden className="absolute top-0 -bottom-0.5 -left-3 w-px bg-border" />}
        </>
      )}
      <div className={cn("flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors", !top && "hover:bg-foreground/[0.035]")}>
        {top ? (
          <span className="size-4 shrink-0" />
        ) : (
          <Checkbox id={id} checked={!off} onCheckedChange={() => onToggle(seat.path)} aria-label={`Hire ${seat.template.name}`} />
        )}
        <AgentAvatar agent={face(seat.template)} size="sm" still className={cn("size-6 rounded-md transition-opacity", off && "opacity-35 grayscale")} />
        <label htmlFor={top ? undefined : id} className={cn("min-w-0 flex-1 truncate text-sm", !top && "cursor-pointer", off && "text-muted-foreground line-through decoration-muted-foreground/50")}>
          <span className="font-medium">{seat.template.name}</span> <span className="text-muted-foreground">· {seat.template.role}</span>
          {off && seat.reports.length > 0 && <span className="ml-1.5 inline-block text-xs">(its team reports to {leadName(seat.path)})</span>}
        </label>
        {top && <span className="shrink-0 rounded-[5px] border bg-card px-1.5 py-px text-[10px] font-medium text-muted-foreground">Reports to Godmode</span>}
        {seat.template.routine && !off && <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Comes with a schedule" />}
      </div>
      {seat.reports.length > 0 && (
        <ul className="relative ml-[1.375rem] pl-3">
          {seat.reports.map((r, i) => (
            <SeatRow key={r.path} seat={r} skip={skip} onToggle={onToggle} leadName={leadName} last={i === seat.reports.length - 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Ready-made structures (GET /api/team-templates), built from the agent templates and installed in one go with their
 * reporting lines: a team (a lead and its reports) or a whole company (a CEO, its executives and their teams) — the
 * way a company starts a department instead of hiring one person at a time.
 */
import type { Agent, AgentTemplate, OrgTemplateNode, TeamInstallInput, TeamInstallResult, TeamTemplate, Workspace } from "@godmode/shared";
import { audit } from "../services/audit";
import { createRoutine, deleteRoutine } from "../services/routines";
import { createWorkspace, deleteWorkspace } from "../services/workspaces";
import { badRequest, notFound } from "../util";
import { all } from "../db";
import { logger } from "../log";
import { createAgent, deleteAgent } from "./service";
import { AGENT_TEMPLATES } from "./templates";

const log = logger("teams");

const seat = (template: string, ...reports: OrgTemplateNode[]): OrgTemplateNode => (reports.length ? { template, reports } : { template });

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: "startup",
    kind: "company",
    name: "Software startup",
    icon: "rocket",
    description: "A CEO with a CTO, a CMO and a head of sales, each with a small team: build it, tell people about it, sell it.",
    root: seat(
      "ceo",
      seat("cto", seat("software-engineer"), seat("code-reviewer"), seat("web-qa-tester")),
      seat("cmo", seat("content-writer"), seat("social-media-manager")),
      seat("head-of-sales", seat("lead-researcher"), seat("sales-development-rep")),
    ),
  },
  {
    id: "agency",
    kind: "company",
    name: "Agency",
    icon: "briefcase",
    description: "New business, delivery and the back office: prospects found and approached, client work built and reviewed, invoices in order.",
    root: seat(
      "ceo",
      seat("head-of-sales", seat("lead-researcher"), seat("sales-development-rep")),
      seat("cto", seat("software-engineer"), seat("code-reviewer"), seat("web-qa-tester")),
      seat("office-manager", seat("inbox-triage"), seat("invoice-collector")),
    ),
  },
  {
    id: "online-shop",
    kind: "company",
    name: "Online shop",
    icon: "shopping-bag",
    description: "Marketing that brings buyers, operations that answer them and watch competitors, finance that keeps the books.",
    root: seat(
      "ceo",
      seat("cmo", seat("social-media-manager"), seat("seo-specialist"), seat("content-writer")),
      seat("coo", seat("customer-support"), seat("price-monitor")),
      seat("cfo", seat("invoice-collector"), seat("bookkeeping-helper")),
    ),
  },
  {
    id: "saas",
    kind: "company",
    name: "SaaS company",
    icon: "building",
    description: "The full C-suite with every department staffed: product, engineering, marketing, sales, operations and finance.",
    root: seat(
      "ceo",
      seat("head-of-product", seat("research-analyst")),
      seat("cto", seat("software-engineer"), seat("code-reviewer"), seat("uptime-watcher"), seat("web-qa-tester")),
      seat("cmo", seat("content-writer"), seat("seo-specialist"), seat("social-media-manager")),
      seat("head-of-sales", seat("lead-researcher"), seat("sales-development-rep")),
      seat("coo", seat("customer-support"), seat("recruiter")),
      seat("cfo", seat("bookkeeping-helper"), seat("invoice-collector")),
    ),
  },
  {
    id: "solo-founder",
    kind: "company",
    name: "Founder's office",
    icon: "user-round",
    description: "For one person running a business: an assistant who keeps your day, inbox, invoices and posts handled.",
    root: seat("executive-assistant", seat("inbox-triage"), seat("daily-briefing"), seat("invoice-collector"), seat("social-media-manager"), seat("research-analyst")),
  },
  {
    id: "back-office",
    kind: "team",
    name: "Back office",
    icon: "archive",
    description: "Inbox, invoices and bookkeeping handled every week, with an office manager who keeps it together.",
    root: seat("office-manager", seat("inbox-triage"), seat("invoice-collector"), seat("bookkeeping-helper")),
  },
  {
    id: "marketing",
    kind: "team",
    name: "Marketing",
    icon: "megaphone",
    description: "Content written, posts planned, search and the market watched — led by a CMO.",
    root: seat("cmo", seat("content-writer"), seat("social-media-manager"), seat("seo-specialist"), seat("price-monitor")),
  },
  {
    id: "sales",
    kind: "team",
    name: "Sales",
    icon: "handshake",
    description: "Prospects found, qualified and approached, so the human only talks to the right people.",
    root: seat("head-of-sales", seat("lead-researcher"), seat("sales-development-rep"), seat("research-analyst")),
  },
  {
    id: "engineering",
    kind: "team",
    name: "Engineering",
    icon: "code",
    description: "Tickets implemented, every pull request reviewed and the sites watched — led by a CTO.",
    root: seat("cto", seat("software-engineer"), seat("code-reviewer"), seat("uptime-watcher")),
  },
  {
    id: "product-qa",
    kind: "team",
    name: "Product & QA",
    icon: "flask",
    description: "The website and app tested regularly, bugs written up clearly, questions about the product researched.",
    root: seat("head-of-product", seat("web-qa-tester"), seat("research-analyst")),
  },
];

const templateById = new Map(AGENT_TEMPLATES.map((t) => [t.id, t]));

/** Every seat with its path ("0" = the top, "0.2" = its third report), top-down. */
export function seatsOf(root: OrgTemplateNode): { path: string; node: OrgTemplateNode; parent: string | null }[] {
  const out: { path: string; node: OrgTemplateNode; parent: string | null }[] = [];
  const walk = (node: OrgTemplateNode, path: string, parent: string | null) => {
    out.push({ path, node, parent });
    node.reports?.forEach((r, i) => walk(r, `${path}.${i}`, path));
  };
  walk(root, "0", null);
  return out;
}

/** A name nobody on the team has yet: "Research Analyst", then "Research Analyst (Sales)", then "… 2". */
function freeName(name: string, team: string, taken: Set<string>): string {
  const candidates = [name, `${name} (${team})`, ...Array.from({ length: 8 }, (_, i) => `${name} (${team} ${i + 2})`)];
  const free = candidates.find((c) => !taken.has(c.toLowerCase())) ?? `${name} (${Date.now()})`;
  taken.add(free.toLowerCase());
  return free;
}

function agentInput(t: AgentTemplate, name: string, workspaceId: string | null, reportsTo: string | null, lead: boolean) {
  return {
    name,
    role: t.role,
    avatar: t.avatar,
    color: t.color,
    character: t.character,
    personality: t.personality,
    description: t.description,
    instructions: t.instructions,
    workspaceId,
    reportsTo,
    // A lead hands work to its reports.
    ...(lead ? { permissions: { allowDelegation: true } } : {}),
  };
}

/**
 * Create the structure top-down: the top seat (reporting to the built-in agent), then every seat under its lead — or,
 * when its lead was left out, under the nearest one kept — and, when asked, the automations from their templates.
 * All or nothing: a failure removes what was made, so the next try doesn't duplicate half a company.
 */
export async function installTeam(id: string, opts: TeamInstallInput = {}): Promise<TeamInstallResult> {
  const team = TEAM_TEMPLATES.find((t) => t.id === id);
  if (!team) throw notFound("Team");
  const seats = seatsOf(team.root);
  if (seats.some((s) => !templateById.has(s.node.template))) throw badRequest(`The ${team.name} template is incomplete`);
  const skip = new Set((opts.skip ?? []).filter((p) => p !== "0"));
  const kept = seats.filter((s) => !skip.has(s.path));
  if (kept.length < 2) throw badRequest("Keep at least one agent besides the top");

  // Names stay apart from the agents there are (two teams may both bring a Research Analyst).
  const taken = new Set(all<{ name: string }>("SELECT name FROM agents").map((a) => a.name.toLowerCase()));
  let workspace: Workspace | null = null;
  const agents: Agent[] = [];
  const routineIds: string[] = [];
  const created = new Map<string, Agent>();
  try {
    if (opts.newWorkspace) {
      workspace = createWorkspace({
        name: opts.newWorkspace.name,
        icon: opts.newWorkspace.icon,
        color: opts.newWorkspace.color,
        description: team.description,
      });
    }
    const workspaceId = workspace ? workspace.id : (opts.workspaceId ?? null);
    // A seat kept leads when anyone kept ends up under it.
    const leadOf = (path: string | null): string | null => {
      let at = path;
      while (at && skip.has(at)) at = seats.find((s) => s.path === at)!.parent;
      return at;
    };
    const leads = new Set(kept.flatMap((s) => (s.parent ? [leadOf(s.parent)!] : [])));
    for (const s of kept) {
      const t = templateById.get(s.node.template)!;
      const lead = s.parent ? created.get(leadOf(s.parent)!)! : null;
      const agent = await createAgent(
        agentInput(t, freeName(t.name, team.name, taken), workspaceId, lead?.id ?? null, leads.has(s.path)) as Parameters<typeof createAgent>[0],
      );
      created.set(s.path, agent);
      agents.push(agent);
      if (opts.automations && t.routine) {
        routineIds.push(
          createRoutine({ agentId: agent.id, name: t.routine.name, cron: t.routine.cron, prompt: t.routine.prompt, ...(opts.timezone ? { timezone: opts.timezone } : {}) }).id,
        );
      }
    }
    audit("user", "team.install", agents[0]!.id, {
      team: id,
      members: agents.slice(1).map((a) => a.id),
      automations: routineIds.length,
      ...(workspace ? { workspace: workspace.id } : {}),
    });
    return { lead: agents[0]!, members: agents.slice(1), automations: routineIds.length, workspace };
  } catch (err) {
    for (const r of routineIds.reverse()) {
      try {
        deleteRoutine(r);
      } catch (e) {
        log.warn(`could not remove routine ${r} of a failed team install`, e);
      }
    }
    for (const a of agents.reverse()) await deleteAgent(a.id).catch((e) => log.warn(`could not remove agent ${a.id} of a failed team install`, e));
    if (workspace) await deleteWorkspace(workspace.id, true).catch((e) => log.warn(`could not remove workspace ${workspace!.id} of a failed team install`, e));
    throw err;
  }
}

/**
 * Ready-made teams (GET /api/team-templates): a lead and its reports, built from the agent templates, installed in one
 * go with their reporting lines — the way a small company starts a department instead of hiring one person at a time.
 */
import type { Agent, AgentTemplate, TeamInstallResult, TeamTemplate } from "@godmode/shared";
import { audit } from "../services/audit";
import { createRoutine } from "../services/routines";
import { badRequest, notFound } from "../util";
import { createAgent } from "./service";
import { AGENT_TEMPLATES } from "./templates";

/** How a lead works: hand out, review, report — never do the reports' work itself. */
function leadInstructions(area: string, goal: string): string {
  return `Goal: ${goal}

You lead the ${area} team. Your reports are listed in your team section; each has its own job.

When work comes in:
1. Decide what it needs and who on your team does each part best. Do small, quick things yourself; hand everything that is one of your reports' jobs to them.
2. On a board ticket: split it with task_split — one part per report, each self-contained (what to do, what to deliver back). Your ticket waits until the parts are delivered, then you continue with their results.
3. In a chat: hand the work over with agent_delegate, then put together what comes back.
4. Review what your reports deliver before you pass it on: check it against what was asked, send a part back with task_message when it isn't good enough.
5. Report to the human in short: what was done, what needs their decision, what's next.

Keep a short list in MEMORY.md of what each report does well and the human's preferences for your area.
Never: make commitments, payments or public posts for the human without their OK — ask with request_approval.`;
}

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: "back-office",
    name: "Back office",
    icon: "🗂️",
    description: "Inbox, invoices and bookkeeping handled every week, with an office manager who keeps it together.",
    lead: {
      id: "office-manager",
      role: "Office manager",
      name: "Office Manager",
      avatar: "🗂️",
      color: "amber",
      character: { body: "gumdrop", eyes: "dots", mouth: "smile", top: "none", face: "glasses", neck: "bowtie" },
      personality: "butler",
      description: "Runs the back office: inbox, invoices and the books — and tells you only what needs you.",
      instructions: leadInstructions("back-office", "keep the admin side of the business running without the human having to think about it."),
    },
    members: ["inbox-triage", "invoice-collector", "bookkeeping-helper"],
  },
  {
    id: "marketing",
    name: "Marketing",
    icon: "📣",
    description: "Posts planned and drafted, the market watched and topics researched — led by a marketing lead.",
    lead: {
      id: "marketing-lead",
      role: "Marketing lead",
      name: "Marketing Lead",
      avatar: "📣",
      color: "rose",
      character: { body: "drop", eyes: "happy", mouth: "grin", top: "party", face: "none", neck: "scarf" },
      personality: "hype",
      description: "Plans what to say and where, hands the work to the team and keeps the brand consistent.",
      instructions: leadInstructions("marketing", "grow the business's reach with consistent, on-brand content informed by what the market does."),
    },
    members: ["social-media-manager", "price-monitor", "research-analyst"],
  },
  {
    id: "sales",
    name: "Sales",
    icon: "🤝",
    description: "Prospects found, qualified and researched, so the human only talks to the right people.",
    lead: {
      id: "sales-lead",
      role: "Sales lead",
      name: "Sales Lead",
      avatar: "🤝",
      color: "emerald",
      character: { body: "pebble", eyes: "wink", mouth: "grin", top: "none", face: "shades", neck: "bowtie" },
      personality: "sunny",
      description: "Keeps the pipeline full: decides whom to look for, reviews the leads and prepares the human's calls.",
      instructions: leadInstructions("sales", "keep a pipeline of well-qualified prospects and prepare the human for every conversation."),
    },
    members: ["lead-researcher", "research-analyst"],
  },
  {
    id: "product-qa",
    name: "Product & QA",
    icon: "🧪",
    description: "The website and app tested regularly, bugs written up clearly, questions about the product researched.",
    lead: {
      id: "product-lead",
      role: "Product lead",
      name: "Product Lead",
      avatar: "🧪",
      color: "violet",
      character: { body: "ghost", eyes: "lines", mouth: "flat", top: "antenna", face: "glasses", neck: "none" },
      personality: "straight",
      description: "Decides what gets tested and researched, reviews the findings and turns them into clear next steps.",
      instructions: leadInstructions("product", "keep the product working and well understood: tested regularly, problems written up clearly, questions answered with evidence."),
    },
    members: ["web-qa-tester", "research-analyst"],
  },
];

function agentInput(t: AgentTemplate, workspaceId: string | null, reportsTo: string | null, lead: boolean) {
  return {
    name: t.name,
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
 * Create the team: its lead (reporting to the built-in agent), then each member reporting to the lead, and — when asked —
 * the members' automations from their templates.
 */
export async function installTeam(id: string, opts: { workspaceId?: string | null; automations?: boolean } = {}): Promise<TeamInstallResult> {
  const team = TEAM_TEMPLATES.find((t) => t.id === id);
  if (!team) throw notFound("Team");
  const members = team.members.map((m) => AGENT_TEMPLATES.find((t) => t.id === m));
  if (members.some((m) => !m)) throw badRequest(`The ${team.name} team template is incomplete`);
  const workspaceId = opts.workspaceId ?? null;
  const lead = await createAgent(agentInput(team.lead, workspaceId, null, true) as Parameters<typeof createAgent>[0]);
  const created: Agent[] = [];
  let automations = 0;
  for (const t of members as AgentTemplate[]) {
    const agent = await createAgent(agentInput(t, workspaceId, lead.id, false) as Parameters<typeof createAgent>[0]);
    created.push(agent);
    if (opts.automations && t.routine) {
      createRoutine({ agentId: agent.id, name: t.routine.name, cron: t.routine.cron, prompt: t.routine.prompt });
      automations++;
    }
  }
  audit("user", "team.install", lead.id, { team: id, members: created.map((a) => a.id), automations });
  return { lead, members: created, automations };
}

/**
 * Ready-made structures (GET /api/team-templates), built from the agent templates and installed in one go with their
 * reporting lines: a team (a lead and its reports) or a whole company (a CEO, its executives and their teams, or one
 * all-in-one agent per department) — the way a company starts a department instead of hiring one person at a time.
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

const seats = (...templates: string[]): OrgTemplateNode[] => templates.map((t) => seat(t));

/* Every department fully staffed: a full company is all of them under a CEO, a department team is one of them. */
const FINANCE = seat(
  "cfo",
  ...seats("bookkeeping-helper", "accounts-payable", "accounts-receivable", "payroll-accountant", "controller", "fpa-analyst", "treasury-manager", "tax-specialist", "investor-relations"),
);
const LEGAL = seat("general-counsel", ...seats("contract-manager", "data-protection-officer", "compliance-officer", "ip-manager"));
const PEOPLE = seat("head-of-people", ...seats("recruiter", "hr-business-partner", "hr-administrator", "learning-development", "employer-branding"));
const GROWTH = seat(
  "head-of-growth",
  seat("performance-marketing-lead", ...seats("paid-social-manager", "google-ads-manager")),
  ...seats("creative-strategist", "cro-specialist", "email-marketing-manager", "marketing-automation", "marketing-analyst"),
);
const MARKETING = seat(
  "cmo",
  GROWTH,
  ...seats(
    "content-marketing-manager",
    "content-writer",
    "copywriter",
    "seo-specialist",
    "social-media-manager",
    "community-manager",
    "influencer-affiliate-manager",
    "pr-manager",
    "brand-manager",
    "graphic-designer",
    "video-editor",
  ),
);
const SALES = seat(
  "head-of-sales",
  ...seats("lead-researcher", "sales-development-rep", "email-sales-agent", "account-executive", "key-account-manager", "partnership-manager", "sales-engineer", "revops", "sales-support"),
);
const CUSTOMER = seat("head-of-customer", ...seats("customer-support", "customer-success-manager", "knowledge-base-manager", "returns-manager"));
const ECOMMERCE = seat("head-of-ecommerce", ...seats("shop-manager", "marketplace-manager", "product-data-manager", "pricing-manager", "price-monitor", "sourcing-agent"));
const PRODUCT = seat("head-of-product", ...seats("product-manager", "product-owner", "ux-ui-designer", "ux-researcher", "technical-writer"));
const ENGINEERING = seat(
  "cto",
  ...seats(
    "software-engineer",
    "mobile-developer",
    "embedded-engineer",
    "devops-engineer",
    "web-qa-tester",
    "code-reviewer",
    "security-engineer",
    "ml-engineer",
    "data-engineer",
    "automation-engineer",
    "it-administrator",
    "it-helpdesk",
    "erp-crm-admin",
  ),
);
const DATA = seat("head-of-data", ...seats("data-analyst", "bi-developer", "data-scientist", "business-analyst"));
const OPERATIONS = seat(
  "coo",
  ...seats("operations-manager", "procurement-manager", "supply-chain-planner", "logistics-coordinator", "quality-manager", "project-manager", "process-manager", "office-manager"),
);
const CEO_OFFICE = seat("chief-of-staff", ...seats("executive-assistant", "strategy-bizdev"));

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: "all-in-one-company",
    kind: "company",
    name: "All-in-one company",
    icon: "layers",
    description: "A whole company with one agent per department: each covers every job in it, so twelve agents run everything.",
    root: seat(
      "ceo",
      ...seats(
        "finance-department",
        "legal-department",
        "people-department",
        "marketing-department",
        "sales-department",
        "customer-department",
        "ecommerce-department",
        "product-department",
        "engineering-department",
        "data-department",
        "operations-department",
      ),
    ),
  },
  {
    id: "full-company",
    kind: "company",
    name: "Full company",
    icon: "landmark",
    description: "Every department led by its executive with all its specialists. Leave out the seats you don't need.",
    root: seat("ceo", CEO_OFFICE, FINANCE, LEGAL, PEOPLE, MARKETING, SALES, CUSTOMER, ECOMMERCE, PRODUCT, ENGINEERING, DATA, OPERATIONS),
  },
  {
    id: "startup",
    kind: "company",
    name: "Software startup",
    icon: "rocket",
    description: "A CEO with a CTO, a CMO and a head of sales, each with a small team: build it, tell people about it, sell it.",
    root: seat(
      "ceo",
      seat("cto", ...seats("software-engineer", "code-reviewer", "web-qa-tester")),
      seat("cmo", ...seats("content-writer", "social-media-manager", "seo-specialist")),
      seat("head-of-sales", ...seats("lead-researcher", "sales-development-rep")),
      seat("finance-department"),
    ),
  },
  {
    id: "saas",
    kind: "company",
    name: "SaaS company",
    icon: "building",
    description: "Product, engineering, growth, sales, customer success and finance, each with its own team.",
    root: seat(
      "ceo",
      seat("head-of-product", ...seats("product-manager", "ux-ui-designer", "technical-writer")),
      seat("cto", ...seats("software-engineer", "code-reviewer", "web-qa-tester", "devops-engineer", "security-engineer")),
      seat("cmo", seat("head-of-growth", ...seats("cro-specialist", "email-marketing-manager", "marketing-analyst")), ...seats("content-writer", "seo-specialist", "social-media-manager")),
      seat("head-of-sales", ...seats("lead-researcher", "sales-development-rep", "account-executive")),
      seat("head-of-customer", ...seats("customer-support", "customer-success-manager", "knowledge-base-manager")),
      seat("cfo", ...seats("bookkeeping-helper", "accounts-receivable", "fpa-analyst")),
    ),
  },
  {
    id: "online-shop",
    kind: "company",
    name: "Online shop",
    icon: "shopping-bag",
    description: "A D2C brand or dropshipping store: products sourced and listed, ads and creatives that sell, customers looked after.",
    root: seat(
      "ceo",
      seat("head-of-ecommerce", ...seats("shop-manager", "sourcing-agent", "product-data-manager", "pricing-manager", "marketplace-manager")),
      seat(
        "cmo",
        seat("performance-marketing-lead", ...seats("paid-social-manager", "google-ads-manager")),
        ...seats("creative-strategist", "video-editor", "email-marketing-manager", "social-media-manager", "influencer-affiliate-manager"),
      ),
      seat("head-of-customer", ...seats("customer-support", "returns-manager")),
      seat("coo", ...seats("supply-chain-planner", "logistics-coordinator")),
      seat("cfo", ...seats("bookkeeping-helper", "invoice-collector")),
    ),
  },
  {
    id: "agency",
    kind: "company",
    name: "Agency",
    icon: "briefcase",
    description: "New business, client delivery and the back office: prospects won, projects built and shipped on time, invoices paid.",
    root: seat(
      "ceo",
      seat("head-of-sales", ...seats("lead-researcher", "sales-development-rep", "email-sales-agent", "sales-engineer")),
      seat("coo", ...seats("project-manager", "key-account-manager")),
      seat("cto", ...seats("software-engineer", "code-reviewer", "web-qa-tester", "ux-ui-designer")),
      seat("cmo", ...seats("content-writer", "social-media-manager", "seo-specialist")),
      seat("office-manager", ...seats("inbox-triage", "invoice-collector", "accounts-receivable")),
    ),
  },
  {
    id: "hardware-company",
    kind: "company",
    name: "Hardware company",
    icon: "cpu",
    description: "Devices with firmware and an app: engineering, product, purchasing and supply chain, quality, support and finance.",
    root: seat(
      "ceo",
      seat("cto", ...seats("embedded-engineer", "mobile-developer", "software-engineer", "web-qa-tester", "devops-engineer")),
      seat("head-of-product", ...seats("product-manager", "ux-ui-designer", "technical-writer")),
      seat("coo", ...seats("procurement-manager", "supply-chain-planner", "logistics-coordinator", "quality-manager")),
      seat("head-of-customer", ...seats("customer-support", "returns-manager", "knowledge-base-manager")),
      seat("cmo", ...seats("content-writer", "social-media-manager")),
      seat("cfo", ...seats("bookkeeping-helper", "controller")),
    ),
  },
  {
    id: "solo-founder",
    kind: "company",
    name: "Founder's office",
    icon: "user-round",
    description: "For one person running a business: an assistant who keeps your day, inbox, invoices and posts handled.",
    root: seat("executive-assistant", ...seats("inbox-triage", "daily-briefing", "invoice-collector", "social-media-manager", "research-analyst")),
  },

  {
    id: "executive-office",
    kind: "team",
    name: "CEO office",
    icon: "compass",
    description: "A chief of staff who keeps goals and promises on track, with an assistant, strategy and research.",
    root: seat("chief-of-staff", ...seats("executive-assistant", "strategy-bizdev", "daily-briefing", "research-analyst")),
  },
  {
    id: "finance",
    kind: "team",
    name: "Finance & accounting",
    icon: "landmark",
    description: "Books, invoices in and out, payroll, controlling, cash and taxes, led by a CFO.",
    root: FINANCE,
  },
  {
    id: "back-office",
    kind: "team",
    name: "Back office",
    icon: "archive",
    description: "Inbox, invoices and bookkeeping handled every week, with an office manager who keeps it together.",
    root: seat("office-manager", ...seats("inbox-triage", "invoice-collector", "bookkeeping-helper")),
  },
  {
    id: "legal",
    kind: "team",
    name: "Legal & compliance",
    icon: "scale",
    description: "Contracts, data protection, compliance and trademarks covered, led by a general counsel.",
    root: LEGAL,
  },
  {
    id: "people",
    kind: "team",
    name: "People & HR",
    icon: "heart-handshake",
    description: "Hiring, HR paperwork, reviews, training and employer brand, led by a head of people.",
    root: PEOPLE,
  },
  {
    id: "marketing",
    kind: "team",
    name: "Marketing",
    icon: "megaphone",
    description: "Content, social, SEO, email, PR and brand, led by a CMO.",
    root: seat(
      "cmo",
      ...seats("content-marketing-manager", "content-writer", "copywriter", "seo-specialist", "social-media-manager", "community-manager", "email-marketing-manager", "pr-manager", "brand-manager", "graphic-designer"),
    ),
  },
  {
    id: "growth",
    kind: "team",
    name: "Growth & performance",
    icon: "trending-up",
    description: "Paid ads on Meta, Google and TikTok, creatives, conversion and email, judged by what they earn.",
    root: GROWTH,
  },
  {
    id: "creative",
    kind: "team",
    name: "Creative studio",
    icon: "palette",
    description: "Angles and briefs, copy, graphics and videos for ads and social, kept on brand.",
    root: seat("creative-strategist", ...seats("copywriter", "graphic-designer", "video-editor")),
  },
  {
    id: "sales",
    kind: "team",
    name: "Sales",
    icon: "handshake",
    description: "Prospects found and approached, inquiries answered, deals run to close and the CRM kept clean.",
    root: seat("head-of-sales", ...seats("lead-researcher", "sales-development-rep", "email-sales-agent", "account-executive", "research-analyst")),
  },
  {
    id: "customer",
    kind: "team",
    name: "Customer service",
    icon: "life-buoy",
    description: "Support answered fast, customers onboarded and kept, help articles and returns handled.",
    root: CUSTOMER,
  },
  {
    id: "ecommerce",
    kind: "team",
    name: "E-commerce",
    icon: "shopping-cart",
    description: "Shop, marketplaces, product data, prices and sourcing, led by an e-commerce manager.",
    root: ECOMMERCE,
  },
  {
    id: "product",
    kind: "team",
    name: "Product & design",
    icon: "flask",
    description: "What to build and why, designs, research, the backlog, docs and QA, led by a head of product.",
    root: seat("head-of-product", ...seats("product-manager", "product-owner", "ux-ui-designer", "ux-researcher", "technical-writer", "web-qa-tester")),
  },
  {
    id: "engineering",
    kind: "team",
    name: "Engineering",
    icon: "code",
    description: "Tickets implemented, every pull request reviewed and tested, deployments and the sites watched, led by a CTO.",
    root: seat("cto", ...seats("software-engineer", "mobile-developer", "code-reviewer", "web-qa-tester", "devops-engineer", "uptime-watcher")),
  },
  {
    id: "it-security",
    kind: "team",
    name: "IT & security",
    icon: "shield",
    description: "Accounts, devices and tools run, the team helped, systems secured and repetitive work automated.",
    root: seat("cto", ...seats("it-administrator", "it-helpdesk", "security-engineer", "erp-crm-admin", "automation-engineer")),
  },
  {
    id: "data",
    kind: "team",
    name: "Data & analytics",
    icon: "bar-chart",
    description: "Pipelines, dashboards, analyses and forecasts the business can trust, led by a head of data.",
    root: seat("head-of-data", ...seats("data-engineer", "data-analyst", "bi-developer", "data-scientist", "business-analyst")),
  },
  {
    id: "operations",
    kind: "team",
    name: "Operations & procurement",
    icon: "factory",
    description: "Purchasing, stock, logistics, quality, projects and processes, led by a COO.",
    root: OPERATIONS,
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
 * All or nothing: a failure removes what was made, so the next try doesn't duplicate half a company. An agent installing
 * one (`actor` "agent:<id>") gets what agent_create gives it: no secret access or management rights for the new agents.
 */
export async function installTeam(id: string, opts: TeamInstallInput = {}, actor = "user"): Promise<TeamInstallResult> {
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
        actor,
      );
      created.set(s.path, agent);
      agents.push(agent);
      if (opts.automations && t.routine) {
        routineIds.push(
          createRoutine({ agentId: agent.id, name: t.routine.name, cron: t.routine.cron, prompt: t.routine.prompt, ...(opts.timezone ? { timezone: opts.timezone } : {}) }).id,
        );
      }
    }
    audit(actor, "team.install", agents[0]!.id, {
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

/**
 * Monthly budgets: the team's (settings.runner.monthlyBudgetUsd) and each agent's (permissions.monthlyBudgetUsd).
 * Spend comes from the ledger (services/spend.ts), booked in the month it was spent. At 80 % the human is told; at
 * 100 % unattended work (automations, follow-ups, board tickets) is held as a paused run (reason "budget") until the
 * month ends, the budget is raised, or the human lets it run. Chats the human starts still run.
 */
import type { Agent, BudgetOverview, BudgetReleaseInput, BudgetStatus } from "@godmode/shared";
import { BUDGET_WARN_AT, formatUsd, monthName } from "@godmode/shared";
import { all, get, getMeta, run, setMeta } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { listAgents } from "../agents/service";
import { resumeRun } from "../runner/runner";
import { HttpError } from "../util";
import { notify } from "./notifications";
import { emitConversationUpdated } from "./conversations";
import type { PausedRow } from "./pauses";
import { getSettings } from "./settings";
import { spentSince } from "./spend";

const log = logger("budgets");

export function monthStart(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function nextMonthStart(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/** "2026-10" on this computer's clock. */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** What the agent (or, without one, the whole team) spent this month. */
export function spentThisMonth(agentId?: string): number {
  return spentSince(monthStart(), agentId);
}

export interface BudgetStop {
  scope: "agent" | "team";
  agentId: string;
  agentName: string;
  budgetUsd: number;
  spentUsd: number;
}

const amount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function teamBudget(): number | null {
  return amount(getSettings().runner.monthlyBudgetUsd);
}

/** The monthly budget that is used up for this agent's work — the team's first — or null. No query without budgets. */
export function exhaustedBudget(agent: Pick<Agent, "id" | "name" | "permissions">): BudgetStop | null {
  const team = teamBudget();
  if (team !== null) {
    const spent = spentThisMonth();
    if (spent >= team) return { scope: "team", agentId: agent.id, agentName: agent.name, budgetUsd: team, spentUsd: spent };
  }
  const own = amount(agent.permissions.monthlyBudgetUsd);
  if (own !== null) {
    const spent = spentThisMonth(agent.id);
    if (spent >= own) return { scope: "agent", agentId: agent.id, agentName: agent.name, budgetUsd: own, spentUsd: spent };
  }
  return null;
}

/** "Mia's October budget is used up ($50.12 of $50.00)." */
export function budgetSentence(stop: BudgetStop): string {
  const whose = stop.scope === "team" ? "The team's" : `${stop.agentName}'s`;
  return `${whose} ${monthName(new Date())} budget is used up (${formatUsd(stop.spentUsd)} of ${formatUsd(stop.budgetUsd)}).`;
}

function stateOf(budget: number | null, spent: number): BudgetStatus["state"] {
  if (budget === null) return "none";
  return spent >= budget ? "exhausted" : spent >= budget * BUDGET_WARN_AT ? "warning" : "ok";
}

/** Held runs that "Let them run" can continue (a switched-off agent's stay where they are). */
function heldCount(where: string, ...params: string[]): number {
  return (
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM paused_runs WHERE reason = 'budget' AND agent_id IN (SELECT id FROM agents WHERE enabled = 1) ${where}`,
      ...params,
    )?.n ?? 0
  );
}

export function budgetOverview(): BudgetOverview {
  const teamSpent = spentThisMonth();
  const team = teamBudget();
  const agents = listAgents()
    .map((a): BudgetStatus => {
      const budget = amount(a.permissions.monthlyBudgetUsd);
      const spent = spentThisMonth(a.id);
      return { agentId: a.id, budgetUsd: budget, spentUsd: spent, held: heldCount("AND agent_id = ?", a.id), state: stateOf(budget, spent) };
    })
    .filter((s) => s.budgetUsd !== null || s.held > 0);
  return {
    month: monthKey(),
    resetsAt: nextMonthStart().toISOString(),
    team: { agentId: null, budgetUsd: team, spentUsd: teamSpent, held: heldCount("AND budget_scope = 'team'"), state: stateOf(team, teamSpent) },
    agents,
  };
}

/**
 * Tell the human once per budget, month and amount: at 80 % that it runs low, at 100 % that unattended work now waits.
 * A jump past both sends only the second.
 */
export function checkThresholds(agentId: string): void {
  const agent = listAgents().find((a) => a.id === agentId);
  const month = monthKey();
  const name = monthName(new Date());
  const tell = (key: string, budget: number, spent: number, title: (level: number) => string, link: string, whose: string) => {
    const level = spent >= budget ? 100 : spent >= budget * BUDGET_WARN_AT ? 80 : 0;
    if (!level) return;
    const told = parseTold(getMeta(key));
    if (told && told.month === month && told.budget === budget && told.level >= level) return;
    setMeta(key, JSON.stringify({ month, budget, level }));
    const of = `${formatUsd(spent)} of ${formatUsd(budget)}.`;
    notify(
      "warning",
      title(level),
      level === 100
        ? `${of} ${whose} automations, follow-ups and board tickets now wait — raise the budget or let them run. Chats you start still run.`
        : `${of} At ${formatUsd(budget)} ${whose.toLowerCase()} automations, follow-ups and board tickets wait until you raise the budget or let them run.`,
      link,
    );
  };
  const team = teamBudget();
  if (team !== null) {
    const spent = spentThisMonth();
    tell(
      "budget.told.team",
      team,
      spent,
      (level) => (level === 100 ? `The team's ${name} budget is used up` : `Your team has used ${Math.floor((spent / team) * 100)}% of its ${name} budget`),
      "/settings/ai",
      "The team's",
    );
  }
  const own = agent ? amount(agent.permissions.monthlyBudgetUsd) : null;
  if (agent && own !== null) {
    const spent = spentThisMonth(agent.id);
    tell(
      `budget.told.${agent.id}`,
      own,
      spent,
      (level) => (level === 100 ? `${agent.name}'s ${name} budget is used up` : `${agent.name} has used ${Math.floor((spent / own) * 100)}% of its ${name} budget`),
      `/agents/${agent.id}`,
      "Its",
    );
  }
}

function parseTold(raw: string | null): { month: string; budget: number; level: number } | null {
  try {
    return raw ? (JSON.parse(raw) as { month: string; budget: number; level: number }) : null;
  } catch {
    return null;
  }
}

/**
 * Continue held runs. `auto`: only those whose budget has room again (a raise, a new month); `user`: the human lets them
 * run although the budget is used up. Returns how many continued.
 */
export function releaseHeld(by: "auto" | "user", only?: BudgetReleaseInput): number {
  const rows = all<PausedRow>(
    `SELECT * FROM paused_runs WHERE reason = 'budget' ${only?.scope === "team" ? "AND budget_scope = 'team'" : only?.scope === "agent" ? "AND agent_id = ?" : ""} ORDER BY created_at`,
    ...(only?.scope === "agent" ? [only.agentId] : []),
  );
  const agents = new Map(listAgents().map((a) => [a.id, a]));
  let continued = 0;
  for (const row of rows) {
    const agent = agents.get(row.agent_id);
    if (!agent || !agent.enabled) continue;
    if (by === "auto") {
      const stop = exhaustedBudget(agent);
      if (stop) {
        // Still held — maybe by the other budget now: say which, so the chat points to the right one to raise.
        if (stop.scope !== row.budget_scope || stop.budgetUsd !== row.budget_usd) {
          run("UPDATE paused_runs SET budget_scope = ?, budget_usd = ? WHERE run_id = ?", stop.scope, stop.budgetUsd, row.run_id);
          emitConversationUpdated(row.conversation_id);
        }
        continue;
      }
    }
    try {
      resumeRun(row, by);
      continued++;
    } catch (err) {
      if (err instanceof HttpError && err.code === "shutting_down") break;
      log.warn(`could not continue held run ${row.run_id}`, err);
    }
  }
  if (continued) log.info(`${continued} held run(s) continue (${by === "user" ? "let through by the human" : "the budget has room again"})`);
  return continued;
}

/** Chats that were told this month that a budget is used up (one notice per chat and month). */
const told = new Set<string>();

/** For a run the human started although a budget is used up: the sentence to show once per chat and month. */
export function exemptNotice(agent: Pick<Agent, "id" | "name" | "permissions">, conversationId: string): string | null {
  const stop = exhaustedBudget(agent);
  if (!stop) return null;
  const key = `${conversationId}:${monthKey()}:${stop.scope}`;
  if (told.has(key)) return null;
  told.add(key);
  return `${budgetSentence(stop)} This still runs because you started it — automations, follow-ups and board tickets wait.`;
}

let unsubscribe: (() => void) | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/** The budget amounts last seen: held work is looked at again only when one of them changes. */
let lastAmounts: string | null = null;

function amountsNow(): string {
  return JSON.stringify([teamBudget(), ...listAgents().map((a) => [a.id, amount(a.permissions.monthlyBudgetUsd)])]);
}

/** A budget may have changed: held work with room continues (debounced; nothing happens unless an amount changed). */
function budgetsMayHaveChanged(): void {
  if (releaseTimer) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    const now = amountsNow();
    if (now === lastAmounts) return;
    lastAmounts = now;
    if (!get("SELECT 1 FROM paused_runs WHERE reason = 'budget'")) return;
    try {
      releaseHeld("auto");
    } catch (err) {
      log.warn("could not continue held runs", err);
    }
  }, 250);
}

export function startBudgets(): void {
  lastAmounts = amountsNow();
  unsubscribe ??= bus.on((e) => {
    try {
      if (e.type === "run.finished" || e.type === "run.paused") checkThresholds(e.run.agentId);
      else if (e.type === "agent.updated" || (e.type === "entity.changed" && e.entity === "settings")) budgetsMayHaveChanged();
    } catch (err) {
      log.warn("budget check failed", err);
    }
  });
}

export function stopBudgets(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
}

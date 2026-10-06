import type { PauseBudget, RunTrigger } from "./models";

/** Share of a monthly budget at which the human is told it is running low. */
export const BUDGET_WARN_AT = 0.8;

/** What a run was for, as the spend breakdown groups it. */
export type SpendKind = "chat" | "automation" | "task" | "delegation" | "followup" | "memory";

export const SPEND_KIND_OF: Record<RunTrigger, SpendKind> = {
  chat: "chat",
  manual: "chat",
  api: "chat",
  routine: "automation",
  check: "automation",
  task: "task",
  delegation: "delegation",
  followup: "followup",
  heartbeat: "automation",
  dream: "memory",
};

export const SPEND_KIND_LABELS: Record<SpendKind, string> = {
  chat: "Chats",
  automation: "Automations",
  task: "Board tasks",
  delegation: "Handed-over work",
  followup: "Follow-ups",
  memory: "Memory dreams",
};

/** "$1,204.33" — always with cents; "<$0.01" for a fraction of a cent. No Intl (the phone's engine lacks parts of it). */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.005) return "<$0.01";
  const cents = Math.round(Math.abs(n) * 100);
  const whole = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}$${whole}.${String(cents % 100).padStart(2, "0")}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October" for a date, in the viewer's time zone. */
export function monthName(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return MONTHS[d.getMonth()] ?? "this month's";
}

/** The one sentence every surface shows for a run held by a budget. */
export function budgetPauseTitle(b: PauseBudget, agentName: string, pausedAt: string): string {
  return b.scope === "team" ? `Held — the team's ${monthName(pausedAt)} budget is used up` : `Held — ${agentName}'s ${monthName(pausedAt)} budget is used up`;
}

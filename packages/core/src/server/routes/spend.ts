import type { Hono } from "hono";
import type { SpendPeriod } from "@godmode/shared";
import { getAgent } from "../../agents/service";
import { audit } from "../../services/audit";
import { budgetOverview, releaseHeld } from "../../services/budgets";
import { SPEND_PERIODS, spendReport } from "../../services/spend";
import { badRequest, conflict } from "../../util";
import { body, z } from "../validate";

export function registerSpendRoutes(app: Hono): void {
  // What the team cost, booked when it was spent.
  app.get("/api/spend", (c) => {
    const period = (c.req.query("period") || "month") as SpendPeriod;
    if (!SPEND_PERIODS.includes(period)) throw badRequest("period must be today, week, month or all");
    const agentId = c.req.query("agentId") || undefined;
    if (agentId) getAgent(agentId);
    return c.json(spendReport(period, agentId));
  });

  app.get("/api/budgets", (c) => c.json(budgetOverview()));

  // The human lets held work run although its budget is used up.
  app.post("/api/budgets/release", async (c) => {
    const input = await body(c, z.discriminatedUnion("scope", [z.object({ scope: z.literal("team") }), z.object({ scope: z.literal("agent"), agentId: z.string().min(1) })]));
    if (input.scope === "agent") getAgent(input.agentId);
    const continued = releaseHeld("user", input);
    if (!continued) throw conflict("Nothing is held for this budget");
    audit("user", "budget.release", input.scope === "agent" ? input.agentId : null, { scope: input.scope, runs: continued });
    return c.json({ continued });
  });
}

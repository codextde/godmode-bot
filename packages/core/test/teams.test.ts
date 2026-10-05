import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TeamInstallResult, TeamTemplate } from "@godmode/shared";
import { reportsOf } from "@godmode/shared";
import { setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { listAgents } from "../src/agents/service";
import { getAccessToken } from "../src/server/auth";
import { listRoutines } from "../src/services/routines";
import { AGENT_TEMPLATES } from "../src/agents/templates";
import { TEAM_TEMPLATES } from "../src/agents/teams";
import { deviceMayCall } from "../src/mobile/scope";

let env: TestEnv;
const call = (path: string, init: RequestInit = {}) =>
  fetch(`${env.baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });

beforeAll(async () => {
  env = await setupEnv("godmode-teams-");
});

afterAll(async () => {
  await env.close();
});

describe("ready-made teams", () => {
  test("every team is built from agent templates that exist", () => {
    for (const team of TEAM_TEMPLATES) {
      expect(team.members.length).toBeGreaterThan(1);
      for (const m of team.members) expect(AGENT_TEMPLATES.some((t) => t.id === m)).toBe(true);
    }
  });

  test("installing a team creates its lead and reports, wired up, with their automations when asked", async () => {
    const list = (await (await call("/api/team-templates")).json()) as TeamTemplate[];
    expect(list.map((t) => t.id)).toContain("back-office");
    const res = await call("/api/team-templates/back-office/install", { method: "POST", body: JSON.stringify({ automations: true }) });
    expect(res.status).toBe(201);
    const team = (await res.json()) as TeamInstallResult;
    expect(team.lead).toMatchObject({ name: "Office Manager", role: "Office manager" });
    expect(team.lead.permissions.allowDelegation).toBe(true);
    expect(team.members.map((m) => m.role)).toEqual(["Inbox manager", "Invoice collector", "Bookkeeper"]);

    const agents = listAgents({ workspaceId: "all" });
    const lead = agents.find((a) => a.id === team.lead.id)!;
    expect(reportsOf(lead, agents).map((a) => a.id).sort()).toEqual(team.members.map((m) => m.id).sort());
    // The lead reports to the built-in agent (no lead of its own set).
    expect(lead.reportsTo).toBeNull();
    // Members whose template has a schedule got their automation.
    const scheduled = AGENT_TEMPLATES.filter((t) => ["inbox-triage", "invoice-collector", "bookkeeping-helper"].includes(t.id) && t.routine).length;
    expect(team.automations).toBe(scheduled);
    expect(listRoutines().filter((r) => team.members.some((m) => m.id === r.agentId)).length).toBe(scheduled);

    // A second team that brings the same agent gets its own name.
    const sales = (await (await call("/api/team-templates/sales/install", { method: "POST", body: JSON.stringify({ timezone: "Europe/Berlin" }) })).json()) as TeamInstallResult;
    const again = (await (await call("/api/team-templates/sales/install", { method: "POST", body: "{}" })).json()) as TeamInstallResult;
    expect(again.lead.name).toBe("Sales Lead (Sales)");
    expect(new Set(listAgents({ workspaceId: "all" }).map((a) => a.name)).size).toBe(listAgents({ workspaceId: "all" }).length);
    expect(sales.members.map((m) => m.name)).toContain("Research Analyst");

    expect((await call("/api/team-templates/nope/install", { method: "POST", body: "{}" })).status).toBe(404);
    expect(deviceMayCall("POST", "/api/team-templates/back-office/install")).toBe(false);
  });
});

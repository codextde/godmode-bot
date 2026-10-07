import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentMoveResult, TeamInstallResult, TeamTemplate, Workspace } from "@godmode/shared";
import { reportsOf } from "@godmode/shared";
import { setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { listAgents } from "../src/agents/service";
import { getAccessToken } from "../src/server/auth";
import { listRoutines } from "../src/services/routines";
import { AGENT_TEMPLATES } from "../src/agents/templates";
import { TEAM_TEMPLATES, seatsOf } from "../src/agents/teams";
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
  test("every structure is built from agent templates that exist, led by templates made to lead", () => {
    expect(new Set(TEAM_TEMPLATES.map((t) => t.id)).size).toBe(TEAM_TEMPLATES.length);
    for (const team of TEAM_TEMPLATES) {
      const seats = seatsOf(team.root);
      expect(seats.length).toBeGreaterThan(2);
      for (const s of seats) {
        const t = AGENT_TEMPLATES.find((a) => a.id === s.node.template);
        expect(t).toBeDefined();
        if (s.node.reports?.length) expect(t!.leads).toBe(true);
      }
      // A company is at least two levels of leads deep.
      if (team.kind === "company") expect(seats.some((s) => s.path.split(".").length === 3) || team.id === "solo-founder").toBe(true);
    }
    expect(TEAM_TEMPLATES.filter((t) => t.kind === "company").length).toBeGreaterThanOrEqual(4);
    for (const exec of ["ceo", "cto", "cmo", "cfo", "coo"]) expect(AGENT_TEMPLATES.find((t) => t.id === exec)?.category).toBe("leadership");
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
    expect(again.lead.name).toBe("Head of Sales (Sales)");
    expect(new Set(listAgents({ workspaceId: "all" }).map((a) => a.name)).size).toBe(listAgents({ workspaceId: "all" }).length);
    expect(sales.members.map((m) => m.name)).toContain("Research Analyst");

    expect((await call("/api/team-templates/nope/install", { method: "POST", body: "{}" })).status).toBe(404);
    expect(deviceMayCall("POST", "/api/team-templates/back-office/install")).toBe(false);
  });

  test("a company installs as a tree, into a new workspace, with left-out seats' reports moved up", async () => {
    const res = await call("/api/team-templates/startup/install", {
      method: "POST",
      // Leave out the CMO (0.1): its writer and social media manager report to the CEO instead.
      body: JSON.stringify({ newWorkspace: { name: "Acme" }, skip: ["0.1", "0"] }),
    });
    expect(res.status).toBe(201);
    const company = (await res.json()) as TeamInstallResult;
    expect(company.workspace?.name).toBe("Acme");
    expect(company.lead.role).toBe("Chief executive officer");
    expect(company.members.some((m) => m.role === "Chief marketing officer")).toBe(false);
    const agents = listAgents({ workspaceId: "all" });
    const mine = agents.filter((a) => a.workspaceId === company.workspace!.id);
    expect(mine.length).toBe(1 + company.members.length);
    const byRole = (role: string) => mine.find((a) => a.role === role)!;
    expect(byRole("Content writer").reportsTo).toBe(company.lead.id);
    expect(byRole("Software engineer").reportsTo).toBe(byRole("Chief technology officer").id);
    expect(byRole("Chief technology officer").permissions.allowDelegation).toBe(true);

    expect((await call("/api/team-templates/back-office/install", { method: "POST", body: JSON.stringify({ skip: ["0.0", "0.1", "0.2"] }) })).status).toBe(400);
  });

  test("moving an agent to another workspace takes its team along, and the previous placements put it back", async () => {
    const ws = (await (await call("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Elsewhere" }) })).json()) as Workspace;
    const team = (await (await call("/api/team-templates/engineering/install", { method: "POST", body: "{}" })).json()) as TeamInstallResult;
    const res = await call(`/api/agents/${team.lead.id}/move`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });
    expect(res.status).toBe(200);
    const { moved, previous } = (await res.json()) as AgentMoveResult;
    expect(moved[0]!.id).toBe(team.lead.id);
    expect(moved.map((a) => a.id).sort()).toEqual([team.lead.id, ...team.members.map((m) => m.id)].sort());
    let agents = listAgents({ workspaceId: "all" });
    for (const m of team.members) expect(agents.find((a) => a.id === m.id)).toMatchObject({ workspaceId: ws.id, reportsTo: team.lead.id });
    expect(previous.every((p) => p.workspaceId === null)).toBe(true);

    // Its own report can't become its lead.
    const loop = await call(`/api/agents/${team.lead.id}/move`, { method: "POST", body: JSON.stringify({ reportsTo: team.members[0]!.id }) });
    expect(loop.status).toBe(400);

    // Alone: its reports stay and report to the built-in agent.
    const alone = (await (await call(`/api/agents/${team.lead.id}/move`, { method: "POST", body: JSON.stringify({ workspaceId: null, withTeam: false }) })).json()) as AgentMoveResult;
    expect(alone.moved.map((a) => a.id)).toEqual([team.lead.id]);
    agents = listAgents({ workspaceId: "all" });
    // A global lead can still lead them.
    for (const m of team.members) expect(agents.find((a) => a.id === m.id)).toMatchObject({ workspaceId: ws.id, reportsTo: team.lead.id });

    const back = await call(`/api/agents/${team.lead.id}/move`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, withTeam: false }) });
    expect(((await back.json()) as AgentMoveResult).previous[0]).toMatchObject({ workspaceId: null });
    const missing = await call(`/api/agents/${team.lead.id}/move`, { method: "POST", body: JSON.stringify({ workspaceId: "wsp_nope" }) });
    expect(missing.status).toBe(400);
  });
});

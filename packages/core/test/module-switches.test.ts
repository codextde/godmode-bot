import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { getDb, insert, run as sql } from "../src/db";
import { MIGRATIONS, MODULE_SWITCHES_SQL } from "../src/db/migrations";
import { getAccessToken } from "../src/server/auth";
import { DEFAULT_SETTINGS, getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { listToolsFor } from "../src/mcp/tools";
import { callSshTool } from "../src/ssh/tools";
import * as vault from "../src/vault/vault";
import { newId, now } from "../src/util";

let env: TestEnv;
let manager: Agent;

const MODULES = ["plugins", "cards", "ssh", "vm"] as const;
type Module = (typeof MODULES)[number];

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const switches = () => Object.fromEntries(MODULES.map((m) => [m, getSettings()[m].enabled])) as Record<Module, boolean>;
const allOff = { plugins: false, cards: false, ssh: false, vm: false };

function migrate(): Record<Module, boolean> {
  getDb().run(MODULE_SWITCHES_SQL);
  resetSettingsCache();
  return switches();
}

function clear() {
  for (const table of ["mods", "payment_cards", "ssh_servers", "vms"]) sql(`DELETE FROM ${table}`);
  sql("DELETE FROM settings WHERE key IN ('activity', 'plugins', 'cards', 'ssh', 'vm', 'phone')");
  resetSettingsCache();
}

const seed: Record<Module, () => void> = {
  plugins: () => insert("mods", { id: "mod_1", name: "guard", title: "Guard", created_at: now(), updated_at: now() }),
  cards: () =>
    insert("payment_cards", { id: "card_1", name: "Visa", last4: "4242", exp_month: 12, exp_year: 2030, number_enc: "sealed", created_at: now(), updated_at: now() }),
  ssh: () => insert("ssh_servers", { id: "ssh_1", name: "web", host: "10.0.0.2", username: "root", created_at: now(), updated_at: now() }),
  vm: () =>
    insert("vms", { id: "vm_1", name: "Builder", image: "macos", cpu: 4, memory_mb: 8192, disk_gb: 60, display: "1280x800", created_at: now(), updated_at: now() }),
};

function chatRun(agent: Agent) {
  const conversationId = newId("cnv");
  insert("conversations", { id: conversationId, agent_id: agent.id, title: "x", origin: "chat", created_at: now(), updated_at: now() });
  const runId = newId("run");
  insert("runs", { id: runId, agent_id: agent.id, conversation_id: conversationId, trigger: "chat", status: "running", prompt: "x", created_at: now() });
  return { runId, agentId: agent.id, conversationId, workspaceId: null, depth: 0 };
}

const toolNames = (agent: Agent) => listToolsFor(agent, chatRun(agent)).map((t) => t.name);

beforeAll(async () => {
  env = await setupEnv("godmode-modules-");
  await vault.setup("correct horse battery staple", false);
  manager = await makeAgent({ name: "Boss", permissions: { canManageAgents: true, allowDelegation: true } });
});

afterAll(async () => {
  await env.close();
});

describe("new installs", () => {
  test("start with plugins, cards, SSH servers and VMs off, Activity on", () => {
    clear();
    expect(switches()).toEqual(allOff);
    expect(migrate()).toEqual(allOff);
    expect(getSettings().activity.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.phone.enabled).toBe(false);
  });
});

describe("existing installs", () => {
  test("migration 108 is the backfill", () => {
    const migration = MIGRATIONS.find((m) => m.name === "module_switches")!;
    expect(migration.id).toBe(108);
    expect(migration.sql).toBe(MODULE_SWITCHES_SQL);
  });

  test("keep a module on when it is set up", () => {
    for (const module of MODULES) {
      clear();
      seed[module]();
      expect({ module, ...migrate() }).toEqual({ module, ...allOff, [module]: true });
    }
  });

  test("a VM section saved without the switch gets it from the VMs there are", () => {
    clear();
    sql("INSERT INTO settings (key, value) VALUES ('vm', ?)", JSON.stringify({ idleStopMinutes: 30 }));
    expect(migrate().vm).toBe(false);
    clear();
    sql("INSERT INTO settings (key, value) VALUES ('vm', ?)", JSON.stringify({ idleStopMinutes: 30 }));
    seed.vm();
    expect(migrate().vm).toBe(true);
    expect(getSettings().vm.idleStopMinutes).toBe(30);
  });

  test("a switch the human set stays as it is", () => {
    clear();
    for (const module of MODULES) seed[module]();
    updateSettings({ plugins: { enabled: false }, cards: { enabled: false }, ssh: { enabled: false }, vm: { enabled: false } });
    expect(migrate()).toEqual(allOff);
    expect(migrate()).toEqual(allOff);
  });
});

describe("agents only get a module's tools while it is on", () => {
  test("plugins", () => {
    clear();
    const plugin = ["plugins_list", "plugin_install", "plugin_update", "plugin_save"];
    expect(toolNames(manager).filter((n) => plugin.includes(n))).toEqual([]);
    updateSettings({ plugins: { enabled: true } });
    expect(toolNames(manager).filter((n) => plugin.includes(n)).sort()).toEqual([...plugin].sort());
  });

  test("virtual machines", () => {
    clear();
    expect(toolNames(manager).filter((n) => n.startsWith("vm"))).toEqual([]);
    updateSettings({ vm: { enabled: true } });
    expect(toolNames(manager).filter((n) => n.startsWith("vm")).sort()).toEqual(["vm_assign", "vm_create", "vm_power", "vms_list"]);
  });

  test("cards", () => {
    clear();
    seed.cards();
    const card = (n: string) => n.startsWith("vault_card") || n === "vault_list_cards";
    expect(toolNames(manager).filter(card)).toEqual([]);
    updateSettings({ cards: { enabled: true } });
    expect(toolNames(manager).filter(card).sort()).toEqual(["vault_card_purchase", "vault_card_purchase_result", "vault_list_cards"]);
  });

  test("SSH servers refuse calls while off", async () => {
    clear();
    const result = await callSshTool(chatRun(manager), "list_servers", {});
    expect(result.isError).toBe(true);
  });
});

describe("the human switches them", () => {
  test("in the settings, as true or false", async () => {
    clear();
    for (const module of ["activity", "plugins", "cards", "ssh"] as const) {
      expect((await api("PUT", "/api/settings", { [module]: { enabled: "yes" } })).status).toBe(400);
      expect((await api("PUT", "/api/settings", { [module]: { enabled: false } })).status).toBe(200);
      expect(getSettings()[module].enabled).toBe(false);
    }
    const boot = (await (await api("GET", "/api/bootstrap")).json()) as { settings: Record<string, { enabled: boolean }> };
    expect(boot.settings.activity.enabled).toBe(false);
    expect(boot.settings.ssh.enabled).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DEFAULT_FALLBACK_MODEL, modelProvider } from "@godmode/shared";
import { setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { all } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import { getAccessToken } from "../src/server/auth";
import { auditSettings } from "../src/services/agentSettings";
import { DEFAULT_SETTINGS, getSettings, updateSettings } from "../src/services/settings";

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv("godmode-settings-audit-");
});

afterAll(async () => {
  await env.close();
});

const put = (body: unknown) =>
  fetch(`${env.baseUrl}/api/settings`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const updates = (): Record<string, unknown>[] =>
  all<{ actor: string; details: string }>("SELECT actor, details FROM audit_log WHERE action = 'settings.update' ORDER BY rowid").map((r) => ({
    actor: r.actor,
    ...(JSON.parse(r.details) as Record<string, unknown>),
  }));

describe("settings changes", () => {
  test("the fallback model is Opus unless someone picks another", () => {
    expect(DEFAULT_SETTINGS.runner.fallbackModel).toBe(DEFAULT_FALLBACK_MODEL);
    expect(DEFAULT_FALLBACK_MODEL).toStartWith("claude-opus-");
    expect(modelProvider(getSettings().runner.fallbackModel)).toBe("anthropic");
  });

  test("a save from the app is audited setting by setting, and a save that changes nothing is not", async () => {
    updateSettings({ runner: { fallbackModel: "claude-opus-5", effort: "high" } });
    const before = updates().length;
    expect((await put({ runner: { fallbackModel: "sonnet", effort: "xhigh" } })).status).toBe(200);
    expect(updates().slice(before)).toEqual([
      {
        actor: "user",
        via: "app",
        changes: [
          { setting: "runner.fallbackModel", from: "claude-opus-5", to: "sonnet" },
          { setting: "runner.effort", from: "high", to: "xhigh" },
        ],
      },
    ]);
    expect((await put({ runner: { fallbackModel: "sonnet" } })).status).toBe(200);
    expect(updates().length).toBe(before + 1);
    expect(getSettings().runner.fallbackModel).toBe("sonnet");
  });

  test("a phone's or another computer's save names where it came from; secrets in free text stay out of the audit", () => {
    const before = getSettings();
    const after = updateSettings({ runner: { appendSystemPrompt: "Log in with password hunter2", extraArgs: ["--token", "t0k"], stallMinutes: before.runner.stallMinutes + 1 } });
    const changed = auditSettings("user", before, after, ["runner", "bogus"], { via: "phone", name: "Pixel" });
    expect(changed.map((c) => c.setting).sort()).toEqual(["runner.appendSystemPrompt", "runner.extraArgs", "runner.stallMinutes"]);
    const logged = updates().at(-1)!;
    expect(logged).toMatchObject({ actor: "user", via: "phone", name: "Pixel" });
    expect(JSON.stringify(logged)).not.toContain("hunter2");
    expect(JSON.stringify(logged)).not.toContain("t0k");
    expect(logged.changes).toContainEqual({ setting: "runner.stallMinutes", from: before.runner.stallMinutes, to: before.runner.stallMinutes + 1 });
    updateSettings({ runner: { appendSystemPrompt: before.runner.appendSystemPrompt, extraArgs: before.runner.extraArgs, stallMinutes: before.runner.stallMinutes } });
  });

  test("a section can't be replaced by something that isn't one", async () => {
    for (const body of [{ runner: null }, { general: "x" }, { browser: [] }, { voice: 3 }]) expect((await put(body)).status).toBe(400);
    expect(getSettings().runner.model).toBeTruthy();
    expect((await put({ onboardingComplete: true })).status).toBe(200);
  });

  test("saved settings with the old Sonnet default fall back to Opus; a model someone picked stays", () => {
    const migration = MIGRATIONS.find((m) => m.name === "opus_fallback")!;
    const after = (runner: Record<string, unknown> | null) => {
      const db = new Database(":memory:");
      db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.run("CREATE TABLE audit_log (id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, details TEXT NOT NULL DEFAULT '{}')");
      db.query("INSERT INTO settings (key, value) VALUES ('memory', ?)").run(JSON.stringify({ fallbackModel: "claude-sonnet-5" }));
      if (runner) db.query("INSERT INTO settings (key, value) VALUES ('runner', ?)").run(JSON.stringify(runner));
      db.run(migration.sql);
      const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
      const audits = db.query<{ actor: string; action: string; details: string }, []>("SELECT actor, action, details FROM audit_log").all();
      db.close();
      expect(JSON.parse(rows.find((r) => r.key === "memory")!.value)).toEqual({ fallbackModel: "claude-sonnet-5" });
      const row = rows.find((r) => r.key === "runner");
      const value = row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
      const moved = runner?.fallbackModel === "claude-sonnet-5";
      expect(audits.map((a) => ({ actor: a.actor, action: a.action, details: JSON.parse(a.details) }))).toEqual(
        moved ? [{ actor: "system", action: "settings.update", details: { via: "update", changes: [{ setting: "runner.fallbackModel", from: "claude-sonnet-5", to: "claude-opus-5" }] } }] : [],
      );
      return value;
    };
    expect(after({ model: "claude-opus-5-5", fallbackModel: "claude-sonnet-5", effort: "high" })).toEqual({ model: "claude-opus-5-5", fallbackModel: "claude-opus-5", effort: "high" });
    expect(after({ fallbackModel: "sonnet" })!.fallbackModel).toBe("sonnet");
    expect(after({ fallbackModel: "" })!.fallbackModel).toBe("");
    expect(after({ effort: "high" })).toEqual({ effort: "high" });
    expect(after(null)).toBeNull();
  });
});

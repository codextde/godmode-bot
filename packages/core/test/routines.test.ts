import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ServerEvent } from "@godmode/shared";
import { startWindowLimit } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb, run as exec } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { createAgent, listAgentCommits } from "../src/agents/service";
import * as repo from "../src/agents/repo";
import {
  createRoutine,
  defaultTimezone,
  deleteRoutine,
  getRoutine,
  listRoutines,
  nextRandomStart,
  nextRunFor,
  updateRoutine,
} from "../src/services/routines";
import { HttpError, newId, now } from "../src/util";

let dataDir: string;
let agent: Agent;

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-routines-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  agent = await createAgent({ name: "Briefing" });
});

afterAll(async () => {
  await repo.repoIdle(agent.repoPath);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

function catchHttp(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

/** Wall-clock parts of `date` in `timeZone`. */
function partsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) };
}

describe("cron validation", () => {
  test("rejects invalid expressions with 400", () => {
    for (const cron of ["61 * * * *", "foo", "* * *", "0 0 0 1 1 * 2030", "*/5 * * * * *", "0 0 30 2 *"]) {
      const err = catchHttp(() => createRoutine({ agentId: agent.id, name: "Bad", cron, prompt: "x" }));
      expect(err.status).toBe(400);
      expect(err.message).toContain("Invalid cron expression");
    }
    expect(listRoutines({ agentId: agent.id })).toHaveLength(0);
  });

  test("rejects unknown timezones", () => {
    const err = catchHttp(() =>
      createRoutine({ agentId: agent.id, name: "Bad tz", cron: "0 8 * * *", timezone: "Mars/Olympus", prompt: "x" }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain("Invalid timezone");
  });

  test("accepts 5-field, 6-field with fixed seconds, names and nicknames", () => {
    for (const cron of ["0 8 * * 1-5", "30 0 8 * * MON-FRI", "@daily", "0 9 2 * *"]) {
      expect(nextRunFor(cron, "UTC").getTime()).toBeGreaterThan(Date.now());
    }
  });

  test("requires agent, name and prompt", () => {
    expect(catchHttp(() => createRoutine({ agentId: "agt_missing", name: "x", cron: "0 8 * * *", prompt: "x" })).status).toBe(404);
    expect(catchHttp(() => createRoutine({ agentId: agent.id, name: " ", cron: "0 8 * * *", prompt: "x" })).status).toBe(400);
    expect(catchHttp(() => createRoutine({ agentId: agent.id, name: "x", cron: "0 8 * * *", prompt: "" })).status).toBe(400);
  });
});

describe("routines CRUD", () => {
  test("computes nextRunAt in the routine's timezone", () => {
    const routine = createRoutine({
      agentId: agent.id,
      name: "Morning briefing",
      cron: "0  8 * * 1-5",
      timezone: "Europe/Berlin",
      prompt: "Prepare my briefing",
    });
    expect(routine.cron).toBe("0 8 * * 1-5");
    expect(routine.enabled).toBe(true);
    expect(routine.reuseConversation).toBe(true);
    expect(routine.lastStatus).toBeNull();
    const next = new Date(routine.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(4 * 86_400_000);
    const wall = partsIn(next, "Europe/Berlin");
    expect(wall.hour).toBe(8);
    expect(wall.minute).toBe(0);
    expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(wall.weekday);
  });

  test("defaults to the machine timezone", () => {
    const routine = createRoutine({ agentId: agent.id, name: "Local", cron: "0 12 * * *", prompt: "noon" });
    expect(routine.timezone).toBe(defaultTimezone());
    expect(routine.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test("disabled routines have no next run", () => {
    const routine = createRoutine({ agentId: agent.id, name: "Paused", cron: "0 12 * * *", prompt: "x", enabled: false });
    expect(routine.nextRunAt).toBeNull();
    const enabled = updateRoutine(routine.id, { enabled: true });
    expect(enabled.nextRunAt).not.toBeNull();
  });

  test("update recomputes the schedule and emits routine.updated", () => {
    const routine = createRoutine({ agentId: agent.id, name: "Hourly", cron: "0 * * * *", timezone: "UTC", prompt: "x" });
    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    try {
      const updated = updateRoutine(routine.id, { cron: "15 3 * * *", name: "Nightly", reuseConversation: false });
      expect(updated.name).toBe("Nightly");
      expect(updated.reuseConversation).toBe(false);
      const wall = partsIn(new Date(updated.nextRunAt!), "UTC");
      expect([wall.hour, wall.minute]).toEqual([3, 15]);
      expect(events.some((e) => e.type === "routine.updated" && e.routine.id === routine.id)).toBe(true);
    } finally {
      off();
    }
    expect(catchHttp(() => updateRoutine(routine.id, { cron: "nope" })).status).toBe(400);
    expect(getRoutine(routine.id).cron).toBe("15 3 * * *");
  });

  test("writes state/routines.json into the agent repository and commits it", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Repo sync", cron: "0 7 * * *", timezone: "UTC", prompt: "sync" });
    await repo.repoIdle(agent.repoPath);
    const file = join(agent.repoPath, "state", "routines.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { id: string; cron: string; nextRunAt?: string }[];
    const entry = saved.find((r) => r.id === routine.id)!;
    expect(entry.cron).toBe("0 7 * * *");
    expect(entry.nextRunAt).toBeUndefined();
    expect((await listAgentCommits(agent.id)).some((c) => c.message === "Update routines")).toBe(true);
  });

  test("delete removes the routine and updates routines.json", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Doomed", cron: "0 7 * * *", prompt: "x" });
    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    try {
      deleteRoutine(routine.id);
    } finally {
      off();
    }
    expect(events.some((e) => e.type === "routine.deleted" && e.id === routine.id)).toBe(true);
    expect(catchHttp(() => getRoutine(routine.id)).status).toBe(404);
    await repo.repoIdle(agent.repoPath);
    const saved = JSON.parse(readFileSync(join(agent.repoPath, "state", "routines.json"), "utf8")) as { id: string }[];
    expect(saved.some((r) => r.id === routine.id)).toBe(false);
  });

  test("moving a routine to another agent forgets its conversation", async () => {
    const other = await createAgent({ name: "Other" });
    const routine = createRoutine({ agentId: agent.id, name: "Movable", cron: "0 7 * * *", prompt: "x" });
    const moved = updateRoutine(routine.id, { agentId: other.id });
    expect(moved.agentId).toBe(other.id);
    expect(moved.conversationId).toBeNull();
    expect(listRoutines({ agentId: other.id }).map((r) => r.id)).toEqual([routine.id]);
    await repo.repoIdle(other.repoPath);
  });
});

describe("random start window", () => {
  test("starts somewhere in the window after the scheduled time", () => {
    const routine = createRoutine({
      agentId: agent.id,
      name: "Office hours",
      trigger: { type: "schedule", startWindowMinutes: 90 },
      cron: "0 8 * * 1-5",
      timezone: "Europe/Berlin",
      prompt: "Start the day",
    });
    expect(routine.trigger).toEqual({ type: "schedule", startWindowMinutes: 90 });
    const wall = partsIn(new Date(routine.nextRunAt!), "Europe/Berlin");
    const minutes = wall.hour * 60 + wall.minute;
    expect(minutes).toBeGreaterThanOrEqual(8 * 60);
    expect(minutes).toBeLessThan(9 * 60 + 30);
    expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(wall.weekday);
  });

  test("draws a different start per slot, the same one every time for a slot", () => {
    const from = new Date("2026-10-01T00:00:00Z");
    const offsets = new Set<number>();
    let after = from;
    for (let i = 0; i < 20; i++) {
      const { slot, at } = nextRandomStart("rtn_draw", "0 8 * * *", "UTC", 60, after);
      expect(slot.getUTCHours()).toBe(8);
      const offset = at.getTime() - slot.getTime();
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(60 * 60_000);
      expect(nextRandomStart("rtn_draw", "0 8 * * *", "UTC", 60, after)).toEqual({ slot, at });
      offsets.add(offset);
      after = at;
    }
    expect(offsets.size).toBeGreaterThan(10);
  });

  test("keeps an open window across restarts and skips slots that already ran", () => {
    const first = nextRandomStart("rtn_open", "0 8 * * *", "UTC", 120, new Date("2026-10-01T00:00:00Z"));
    const midWindow = new Date(first.slot.getTime() + 1);
    const resumed = nextRandomStart("rtn_open", "0 8 * * *", "UTC", 120, midWindow);
    expect(resumed.slot).toEqual(first.slot);
    const handled = nextRandomStart("rtn_open", "0 8 * * *", "UTC", 120, midWindow, first.slot.getTime());
    expect(handled.slot.getTime() - first.slot.getTime()).toBe(86_400_000);
    const late = nextRandomStart("rtn_open", "0 8 * * *", "UTC", 120, new Date(first.at.getTime() + 1));
    expect(late.slot.getTime() - first.slot.getTime()).toBe(86_400_000);
  });

  test("does not start a slot again after a schedule event for it", () => {
    const slot = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const routine = createRoutine({
      agentId: agent.id,
      name: "Ran today",
      trigger: { type: "schedule", startWindowMinutes: 120 },
      cron: `${slot.getUTCMinutes()} ${slot.getUTCHours()} * * *`,
      timezone: "UTC",
      prompt: "x",
    });
    insert("automation_events", {
      id: newId("aev"),
      routine_id: routine.id,
      source: "schedule",
      title: "Scheduled time reached",
      payload: "null",
      status: "done",
      created_at: now(),
    });
    const next = new Date(updateRoutine(routine.id, { prompt: "y" }).nextRunAt!);
    expect(next.getTime()).toBeGreaterThanOrEqual(slot.getTime() + 86_400_000);
    expect(next.getTime()).toBeLessThan(slot.getTime() + 86_400_000 + 120 * 60_000);
  });

  test("0 means on time", () => {
    const routine = createRoutine({
      agentId: agent.id,
      name: "Punctual",
      trigger: { type: "schedule", startWindowMinutes: 0 },
      cron: "0 8 * * *",
      timezone: "UTC",
      prompt: "x",
    });
    expect(routine.trigger).toEqual({ type: "schedule" });
    expect(new Date(routine.nextRunAt!).getUTCMinutes()).toBe(0);
  });

  test("rejects windows that are invalid or longer than the gap between runs", () => {
    for (const startWindowMinutes of [-5, 1.5, 721]) {
      const err = catchHttp(() =>
        createRoutine({ agentId: agent.id, name: "Bad", trigger: { type: "schedule", startWindowMinutes }, cron: "0 8 * * *", prompt: "x" }),
      );
      expect(err.status).toBe(400);
      expect(err.message).toContain("random start window");
    }
    const tooLong = catchHttp(() =>
      createRoutine({ agentId: agent.id, name: "Hourly", trigger: { type: "schedule", startWindowMinutes: 90 }, cron: "0 * * * *", prompt: "x" }),
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.message).toBe("Runs are only 1 h apart — the random start window can be at most 1 h");
    expect(listRoutines({ agentId: agent.id }).some((r) => r.name === "Hourly" || r.name === "Bad")).toBe(false);
  });

  test("the limit ignores gaps shortened by a daylight saving change", () => {
    const limit = (cron: string, from: string) =>
      startWindowLimit((after) => nextRunFor(cron, "Europe/Berlin", after), "Europe/Berlin", new Date(from));
    expect(limit("0 */2 * * *", "2027-03-27T12:00:00Z")).toBe(120);
    expect(limit("0 8,20 * * *", "2027-03-26T12:00:00Z")).toBe(720);
    expect(limit("0 * * * *", "2027-03-27T20:00:00Z")).toBe(60);
    expect(limit("*/15 * * * *", "2027-03-27T20:00:00Z")).toBe(15);
  });

  test("changes that leave the schedule alone don't check the window again", () => {
    const routine = createRoutine({
      agentId: agent.id,
      name: "Saved window",
      trigger: { type: "schedule", startWindowMinutes: 90 },
      cron: "0 8 * * *",
      timezone: "UTC",
      prompt: "x",
    });
    exec("UPDATE routines SET cron = '0 * * * *' WHERE id = ?", routine.id);
    expect(updateRoutine(routine.id, { enabled: false }).enabled).toBe(false);
    expect(updateRoutine(routine.id, { name: "Renamed" }).name).toBe("Renamed");
    expect(catchHttp(() => updateRoutine(routine.id, { cron: "30 * * * *" })).status).toBe(400);
  });
});

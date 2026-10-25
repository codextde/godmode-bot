/**
 * The device group's shared data (remote/replica.ts): what the triggers note, what a computer gives another one, and
 * how it writes what it gets — the newer change wins, a deletion stays deleted, a row that points at one that isn't
 * there yet waits, and nothing is sent back to the computer it came from.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { all, closeDb, get, openDb, run, setDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { applyChanges, changesFor, ensureReplica, pendingFor, pendingKeys, replicaSeq, replicaTables, resetReplicaCache, retryDeferred, type ReplicaChange } from "../src/remote/replica";

let dir: string;
let a: Database;
let b: Database;

const T = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n)).toISOString();

function use(db: Database) {
  setDb(db);
  resetReplicaCache();
  ensureReplica();
}

function goal(id: string, title: string) {
  run("INSERT INTO goals (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", id, title, T(0), T(0));
}

beforeAll(() => {
  setLogLevel("error");
  dir = mkdtempSync(join(tmpdir(), "godmode-replica-"));
  loadConfig({ dataDir: dir });
  a = openDb(join(dir, "a.db"));
  b = openDb(join(dir, "b.db"));
});

afterAll(() => {
  closeDb();
  a.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const db of [a, b]) {
    use(db);
    for (const t of ["task_dependencies", "tasks", "human_tasks", "goals", "replica_rows", "replica_deferred"]) run(`DELETE FROM ${t}`);
    run("DELETE FROM meta WHERE key LIKE 'link.replica.%'");
  }
});

describe("the change log", () => {
  test("every insert, change and deletion of a shared row is noted once, in order", () => {
    use(a);
    const start = replicaSeq();
    goal("gol_1", "Ship it");
    run("UPDATE goals SET title = 'Ship it today' WHERE id = 'gol_1'");
    const row = get<{ seq: number; deleted: number; origin: string | null }>("SELECT seq, deleted, origin FROM replica_rows WHERE tbl = 'goals' AND pk = 'gol_1'")!;
    expect(row.seq).toBe(start + 2);
    expect(row.deleted).toBe(0);
    expect(row.origin).toBeNull();
    run("DELETE FROM goals WHERE id = 'gol_1'");
    expect(get<{ deleted: number }>("SELECT deleted FROM replica_rows WHERE tbl = 'goals' AND pk = 'gol_1'")!.deleted).toBe(1);
  });

  test("every shared table can be written, changed and emptied with the triggers in place", () => {
    use(a);
    run("PRAGMA foreign_keys = OFF");
    try {
      for (const t of replicaTables()) {
        const cols = all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(`PRAGMA table_info("${t.table}")`);
        const value = (c: { type: string }, n: number) => (/INT|REAL|NUM/i.test(c.type) ? n : `v${n}_${t.table}`);
        const row: Record<string, string | number> = {};
        for (const c of cols) if (c.pk || (c.notnull && c.dflt_value === null)) row[c.name] = value(c, 1);
        if (t.only) row[t.only.column] = t.only.value;
        const names = Object.keys(row);
        run(`INSERT INTO "${t.table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, ...Object.values(row));
        const key = t.key.map((k) => String(row[k])).join("\u001f");
        expect(get<{ deleted: number }>("SELECT deleted FROM replica_rows WHERE tbl = ? AND pk = ?", t.table, key)?.deleted).toBe(0);
        const other = cols.find((c) => !c.pk && !t.own.includes(c.name) && c.name !== "updated_at" && !(t.only && c.name === t.only.column));
        if (other) run(`UPDATE "${t.table}" SET "${other.name}" = ? WHERE ${t.key.map((k) => `"${k}" = ?`).join(" AND ")}`, value(other, 2), ...t.key.map((k) => row[k]!));
        run(`DELETE FROM "${t.table}" WHERE ${t.key.map((k) => `"${k}" = ?`).join(" AND ")}`, ...t.key.map((k) => row[k]!));
        expect(get<{ deleted: number }>("SELECT deleted FROM replica_rows WHERE tbl = ? AND pk = ?", t.table, key)?.deleted).toBe(1);
      }
    } finally {
      run("PRAGMA foreign_keys = ON");
    }
  });

  test("a change of only the bookkeeping (updated_at) is not a change", () => {
    use(a);
    goal("gol_2", "Quiet");
    const before = replicaSeq();
    run("UPDATE goals SET updated_at = ? WHERE id = 'gol_2'", T(5));
    expect(replicaSeq()).toBe(before);
  });

  test("deleting a row others point at still works (the database clears their pointers with its own rules)", () => {
    use(a);
    run("INSERT INTO tasks (id, number, title, created_at, updated_at) VALUES ('tsk_p', 3, 'Parent', ?, ?)", T(0), T(0));
    run("INSERT INTO human_tasks (id, number, title, task_id, created_at, updated_at) VALUES ('hut_p', 4, 'Sign', 'tsk_p', ?, ?)", T(0), T(0));
    run("DELETE FROM tasks WHERE id = 'tsk_p'");
    expect(get<{ task_id: string | null }>("SELECT task_id FROM human_tasks WHERE id = 'hut_p'")?.task_id).toBeNull();
    expect(get<{ deleted: number }>("SELECT deleted FROM replica_rows WHERE tbl = 'tasks' AND pk = 'tsk_p'")?.deleted).toBe(1);
  });

  test("a key of several columns is one key", () => {
    use(a);
    run("INSERT INTO tasks (id, number, title, created_at, updated_at) VALUES ('tsk_a', 1, 'A', ?, ?), ('tsk_b', 2, 'B', ?, ?)", T(0), T(0), T(0), T(0));
    run("INSERT INTO task_dependencies (task_id, waits_for_id, created_at) VALUES ('tsk_a', 'tsk_b', ?)", T(0));
    const page = changesFor("rnr_peer", 0, { setup: true });
    const dep = page.changes.find((c) => c.t === "task_dependencies")!;
    expect(dep.k).toBe("tsk_a\u001ftsk_b");
    use(b);
    applyChanges("rnr_a", page.changes, { peerWinsTies: true });
    expect(get("SELECT 1 AS x FROM task_dependencies WHERE task_id = 'tsk_a' AND waits_for_id = 'tsk_b'")).not.toBeNull();
  });
});

describe("between two computers", () => {
  test("what one computer changed arrives on the other, and is not sent back", () => {
    use(a);
    goal("gol_3", "From A");
    const page = changesFor("rnr_b", 0, { setup: true });
    expect(page.changes.map((c) => c.k)).toContain("gol_3");
    use(b);
    const res = applyChanges("rnr_a", page.changes, { peerWinsTies: true });
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(get<{ title: string }>("SELECT title FROM goals WHERE id = 'gol_3'")?.title).toBe("From A");
    // B noted it as A's: A gets nothing back.
    expect(changesFor("rnr_a", 0, { setup: true }).changes.some((c) => c.k === "gol_3")).toBe(false);
    expect(pendingFor("rnr_a")).toBe(0);
  });

  test("the computer an automation is pinned to goes to the other computer", () => {
    for (const db of [a, b]) {
      use(db);
      run("PRAGMA foreign_keys = OFF");
      const cols = all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>('PRAGMA table_info("agents")').filter((c) => c.pk || (c.notnull && c.dflt_value === null));
      run(`INSERT OR REPLACE INTO agents (${cols.map((c) => `"${c.name}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => (c.name === "id" ? "agt_x" : /INT|REAL|NUM/i.test(c.type) ? 1 : `v_${c.name}`)));
      run("INSERT OR REPLACE INTO routines (id, agent_id, name, cron, timezone, prompt, created_at, updated_at) VALUES ('rtn_pin', 'agt_x', 'Posts', '0 12 * * *', 'UTC', 'post', ?, ?)", T(0), T(0));
      run("PRAGMA foreign_keys = ON");
    }
    use(a);
    const start = replicaSeq();
    run("UPDATE routines SET run_on = 'primary' WHERE id = 'rtn_pin'");
    const page = changesFor("rnr_b", start, { setup: true });
    expect(page.changes.map((c) => c.k)).toContain("rtn_pin");
    use(b);
    run("PRAGMA foreign_keys = OFF");
    try {
      applyChanges("rnr_a", page.changes, { peerWinsTies: true });
    } finally {
      run("PRAGMA foreign_keys = ON");
    }
    expect(get<{ run_on: string | null }>("SELECT run_on FROM routines WHERE id = 'rtn_pin'")?.run_on).toBe("primary");
    for (const db of [a, b]) {
      use(db);
      run("DELETE FROM routines WHERE id = 'rtn_pin'");
      run("DELETE FROM agents WHERE id = 'agt_x'");
    }
  });

  test("the newer change of a row wins, on both sides", () => {
    use(a);
    goal("gol_4", "Old");
    const first = changesFor("rnr_b", 0, { setup: true });
    use(b);
    applyChanges("rnr_a", first.changes, { peerWinsTies: true });
    run("UPDATE goals SET title = 'Newer on B' WHERE id = 'gol_4'");
    const newer: ReplicaChange = { t: "goals", k: "gol_4", at: "2000-01-01T00:00:00.000Z", row: { id: "gol_4", title: "Stale from A", created_at: T(0), updated_at: T(0) } };
    const res = applyChanges("rnr_a", [newer], { peerWinsTies: true });
    expect(res.kept).toBe(1);
    expect(get<{ title: string }>("SELECT title FROM goals WHERE id = 'gol_4'")?.title).toBe("Newer on B");
  });

  test("when this computer's version wins it is sent again, and a change that lost isn't tried again", () => {
    use(b);
    goal("gol_9", "Newer here");
    const before = get<{ seq: number }>("SELECT seq FROM replica_rows WHERE tbl = 'goals' AND pk = 'gol_9'")!.seq;
    run("INSERT INTO replica_deferred (peer, tbl, pk, change, created_at) VALUES ('rnr_a', 'goals', 'gol_9', '{}', ?)", T(0));
    const older: ReplicaChange = { t: "goals", k: "gol_9", at: "2000-01-01T00:00:00.000Z", row: { id: "gol_9", title: "Older there", created_at: T(0), updated_at: T(0) } };
    expect(applyChanges("rnr_a", [older], { peerWinsTies: true }).kept).toBe(1);
    const after = get<{ seq: number }>("SELECT seq FROM replica_rows WHERE tbl = 'goals' AND pk = 'gol_9'")!.seq;
    expect(after).toBeGreaterThan(before);
    expect(changesFor("rnr_a", before, { setup: true }).changes.map((c) => c.k)).toContain("gol_9");
    expect(all("SELECT * FROM replica_deferred WHERE pk = 'gol_9'")).toHaveLength(0);
    // Tried again (a deferred change): it loses again without sending the row once more.
    applyChanges("rnr_a", [older], { peerWinsTies: true, retry: true });
    expect(get<{ seq: number }>("SELECT seq FROM replica_rows WHERE tbl = 'goals' AND pk = 'gol_9'")!.seq).toBe(after);
  });

  test("on a tie the primary's change wins", () => {
    use(b);
    goal("gol_5", "B's");
    const at = get<{ at: string }>("SELECT at FROM replica_rows WHERE tbl = 'goals' AND pk = 'gol_5'")!.at;
    const same: ReplicaChange = { t: "goals", k: "gol_5", at, row: { id: "gol_5", title: "Primary's", created_at: T(0), updated_at: T(0) } };
    expect(applyChanges("rnr_secondary", [same], { peerWinsTies: false }).kept).toBe(1);
    expect(applyChanges("rnr_primary", [same], { peerWinsTies: true }).applied).toBe(1);
    expect(get<{ title: string }>("SELECT title FROM goals WHERE id = 'gol_5'")?.title).toBe("Primary's");
  });

  test("a deletion arrives, and an older copy can't bring the row back", () => {
    use(a);
    goal("gol_6", "Doomed");
    const created = changesFor("rnr_b", 0, { setup: true });
    run("DELETE FROM goals WHERE id = 'gol_6'");
    const deleted = changesFor("rnr_b", created.last, { setup: true });
    expect(deleted.changes.find((c) => c.k === "gol_6")?.d).toBe(1);
    use(b);
    applyChanges("rnr_a", created.changes, { peerWinsTies: true });
    applyChanges("rnr_a", deleted.changes, { peerWinsTies: true });
    expect(get("SELECT id FROM goals WHERE id = 'gol_6'")).toBeNull();
    applyChanges("rnr_a", created.changes, { peerWinsTies: true });
    expect(get("SELECT id FROM goals WHERE id = 'gol_6'")).toBeNull();
  });

  test("a row that points at one that isn't here yet waits, and lands once it is", () => {
    use(b);
    const change: ReplicaChange = {
      t: "human_tasks",
      k: "hut_1",
      at: T(10),
      row: { id: "hut_1", number: 1, title: "Sign", status: "todo", task_id: "tsk_missing", created_at: T(0), updated_at: T(0) },
    };
    const missing: string[] = [];
    const res = applyChanges("rnr_a", [change], { peerWinsTies: true, onMissing: (table, id) => missing.push(`${table}:${id}`) });
    expect(res.deferred).toBe(1);
    expect(missing).toEqual(["tasks:tsk_missing"]);
    expect(get("SELECT id FROM human_tasks WHERE id = 'hut_1'")).toBeNull();
    run("INSERT INTO tasks (id, number, title, created_at, updated_at) VALUES ('tsk_missing', 9, 'Now here', ?, ?)", T(0), T(0));
    expect(retryDeferred("rnr_a", { peerWinsTies: true }).applied).toBe(1);
    expect(get<{ title: string }>("SELECT title FROM human_tasks WHERE id = 'hut_1'")?.title).toBe("Sign");
    expect(all("SELECT * FROM replica_deferred")).toHaveLength(0);
  });

  test("what changed here and the other hasn't taken yet is known, until it says it has", () => {
    use(a);
    goal("gol_7", "Mine");
    expect(pendingKeys("rnr_b", "goals").has("gol_7")).toBe(true);
    const page = changesFor("rnr_b", 0, { setup: true });
    // The next ask says how far it got.
    changesFor("rnr_b", page.last, { setup: true });
    expect(pendingKeys("rnr_b", "goals").has("gol_7")).toBe(false);
    expect(pendingFor("rnr_b")).toBe(0);
  });

  test("a project both computers made while apart lands with its own slug instead of failing", () => {
    use(b);
    run("DELETE FROM projects WHERE workspace_id = 'wsp_apps'");
    run("DELETE FROM workspaces WHERE id = 'wsp_apps'");
    run("INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('wsp_apps', 'Apps', 'apps', ?, ?)", T(0), T(0));
    run("INSERT INTO projects (id, workspace_id, name, slug, created_at, updated_at) VALUES ('prj_here', 'wsp_apps', 'Earshot', 'earshot', ?, ?)", T(1), T(1));
    const theirs: ReplicaChange = {
      t: "projects",
      k: "prj_there",
      at: T(30),
      row: { id: "prj_there", workspace_id: "wsp_apps", name: "Earshot", slug: "earshot", created_at: T(30), updated_at: T(30) },
    };
    // Within the pull the slug may still be freed by a rename that comes later: it waits for the end of the pull.
    expect(applyChanges("rnr_a", [theirs], { peerWinsTies: false }).failed).toBe(1);
    const res = retryDeferred("rnr_a", { peerWinsTies: false });
    expect(res.applied).toBe(1);
    expect(res.failed).toBe(0);
    expect(all("SELECT id, slug FROM projects WHERE workspace_id = 'wsp_apps' ORDER BY id")).toEqual([
      { id: "prj_here", slug: "earshot" },
      { id: "prj_there", slug: "earshot-2" },
    ]);
    expect(all("SELECT * FROM replica_deferred")).toHaveLength(0);
  });

  test("an agent whose folder name isn't safe never lands", () => {
    use(b);
    const evil: ReplicaChange = { t: "agents", k: "agt_evil", at: T(20), row: { id: "agt_evil", name: "Evil", slug: "../../outside", created_at: T(0), updated_at: T(0) } };
    expect(applyChanges("rnr_a", [evil], { peerWinsTies: true }).failed).toBe(1);
    expect(get("SELECT id FROM agents WHERE id = 'agt_evil'")).toBeNull();
  });

  test("a settings change goes to the other computer, which keeps its own programs and its own sections", () => {
    use(a);
    resetSettingsCache();
    updateSettings({ general: { theme: "dark" }, runner: { claudePath: "/on/a/claude" }, mobile: { enabled: true } } as never);
    const page = changesFor("rnr_b", 0, { setup: true });
    const sections = page.changes.filter((c) => c.t === "settings").map((c) => c.k);
    expect(sections).toContain("general");
    expect(sections).not.toContain("mobile");
    use(b);
    resetSettingsCache();
    updateSettings({ runner: { claudePath: "/on/b/claude" } } as never);
    applyChanges("rnr_a", page.changes, { peerWinsTies: false });
    resetSettingsCache();
    expect(getSettings().general.theme).toBe("dark");
    expect(getSettings().runner.claudePath).toBe("/on/b/claude");
    resetSettingsCache();
  });

  test("the setup can be left out (a secondary gets it as the snapshot)", () => {
    use(a);
    run("INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('wsp_1', 'Shop', 'shop', ?, ?)", T(0), T(0));
    goal("gol_8", "State");
    const state = changesFor("rnr_b", 0, { setup: false }).changes.map((c) => c.t);
    expect(state).toContain("goals");
    expect(state).not.toContain("workspaces");
    expect(changesFor("rnr_b", 0, { setup: true }).changes.map((c) => c.t)).toContain("workspaces");
  });
});

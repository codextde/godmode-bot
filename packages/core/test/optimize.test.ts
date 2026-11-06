import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Agent, type RunTrigger } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { get, insert, run as sql, setMeta } from "../src/db";
import { createConversation } from "../src/services/conversations";
import { buildDreamPrompt, dreamDue, ensureDreamListener, memoryToTidy } from "../src/memory/dreaming";
import { markReviewed, noteOf, noteUses, recordMemoryUse, unusedNotes, UNUSED_DAYS, UNUSED_RUNS } from "../src/memory/usage";
import { optimizeReport } from "../src/services/optimize";
import { getSettings } from "../src/services/settings";
import { newId } from "../src/util";

let env: TestEnv;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

beforeAll(async () => {
  env = await setupEnv("godmode-optimize-");
  ensureDreamListener();
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await env.close();
});

/** A note last written `days` ago. */
function note(agent: Agent, path: string, text = "# Note\n- a fact\n", days = UNUSED_DAYS + 20) {
  const abs = join(agent.repoPath, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
  const t = new Date(Date.now() - days * DAY);
  utimesSync(abs, t, t);
}

/** The agent kept working: finished runs in the last days. */
function work(agent: Agent, runs = UNUSED_RUNS) {
  for (let i = 0; i < runs; i++) runWith(agent, [], "chat", ago(i + 1));
}

/** A finished run of the agent whose message holds these tool steps. */
function runWith(agent: Agent, tools: { name: string; input: Record<string, unknown> }[], trigger: RunTrigger = "chat", finishedAt = new Date().toISOString()) {
  const conversationId = createConversation({ agentId: agent.id, title: "Work" }).id;
  const id = newId("run");
  insert("runs", { id, agent_id: agent.id, conversation_id: conversationId, trigger, status: "succeeded", prompt: "x", result: "ok", created_at: finishedAt, started_at: finishedAt, finished_at: finishedAt });
  insert("messages", {
    id: newId("msg"),
    conversation_id: conversationId,
    role: "assistant",
    content: "done",
    blocks: JSON.stringify(tools.map((t, i) => ({ type: "tool_use", id: `tu_${i}`, name: t.name, input: t.input, result: "ok" }))),
    run_id: id,
    attachments: "[]",
    created_at: finishedAt,
  });
  return { id, agentId: agent.id, trigger, finishedAt } as const;
}

const uses = (agentId: string, path: string) => get<{ uses: number; last_used_at: string }>("SELECT uses, last_used_at FROM memory_note_uses WHERE agent_id = ? AND path = ?", agentId, path);

describe("which notes tasks use", () => {
  test("paths a tool named, as notes of the repository", () => {
    const repo = "/data/agents/scout";
    expect(noteOf(repo, "/data/agents/scout/memory/leads.md")).toBe("memory/leads.md");
    expect(noteOf(repo, "memory/a/b.md")).toBe("memory/a/b.md");
    expect(noteOf(repo, "./memory/x.md")).toBe("memory/x.md");
    expect(noteOf(join(homedir(), "agents/scout"), "~/agents/scout/memory/x.md")).toBe("memory/x.md");
    expect(noteOf(repo, "MEMORY.md")).toBeNull();
    expect(noteOf(repo, "/data/agents/other/memory/x.md")).toBeNull();
    expect(noteOf(repo, "workspace/memory.md")).toBeNull();
    expect(noteOf(repo, "memory/../secrets.md")).toBeNull();
    // The team profile reaches every task through its prompt.
    expect(noteOf(repo, "memory/profile.md")).toBeNull();
    // The same repository seen from a VM or a moved data folder.
    expect(noteOf(repo, "/Volumes/My Shared Files/agents/scout/memory/leads.md")).toBe("memory/leads.md");
    expect(noteOf(repo, "/Volumes/x/agents/other/memory/leads.md")).toBeNull();
  });

  test("reads, edits, shell commands and a lead's team_memory_read count; dreams only start the clock", async () => {
    const agent = await makeAgent({ name: "Note Reader" });
    const report = await makeAgent({ name: "Note Owner" });
    const run = runWith(agent, [
      { name: "Read", input: { file_path: join(agent.repoPath, "memory/leads.md") } },
      { name: "Bash", input: { command: "cat memory/tools.md | head -40; ls workspace" } },
      { name: "Edit", input: { file_path: join(agent.repoPath, "MEMORY.md"), old_string: "a", new_string: "b" } },
      { name: "Read", input: { file_path: join(agent.repoPath, "workspace/notes.md") } },
      { name: "mcp__godmode__team_memory_read", input: { agentId: report.slug, path: "memory/cases.md" } },
      { name: "Bash", input: { command: "rg -l invoice memory/kunden-übersicht.md" } },
    ]);
    recordMemoryUse(run);
    expect(uses(agent.id, "memory/leads.md")?.uses).toBe(1);
    expect(uses(agent.id, "memory/tools.md")?.uses).toBe(1);
    expect(uses(report.id, "memory/cases.md")?.uses).toBe(1);
    expect(uses(agent.id, "memory/kunden-übersicht.md")?.uses).toBe(1);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_note_uses WHERE agent_id = ?", agent.id)?.n).toBe(3);

    recordMemoryUse(runWith(agent, [{ name: "Write", input: { file_path: join(agent.repoPath, "memory/leads.md"), content: "x" } }]));
    expect(uses(agent.id, "memory/leads.md")?.uses).toBe(2);

    const dream = runWith(agent, [
      { name: "Read", input: { file_path: join(agent.repoPath, "memory/leads.md") } },
      { name: "Read", input: { file_path: join(agent.repoPath, "memory/only-read.md") } },
      { name: "Write", input: { file_path: join(agent.repoPath, "memory/new-topic.md"), content: "x" } },
    ], "dream", ago(-1));
    recordMemoryUse(dream);
    expect(uses(agent.id, "memory/leads.md")?.uses).toBe(2);
    expect(uses(agent.id, "memory/leads.md")?.last_used_at).not.toBe(dream.finishedAt);
    expect(uses(agent.id, "memory/only-read.md")).toBeNull();
    expect(uses(agent.id, "memory/new-topic.md")).toEqual({ uses: 0, last_used_at: dream.finishedAt });
  });

  test("a note is unused once no task touched it for 30 days, counted from when counting began", async () => {
    const agent = await makeAgent({ name: "Forgetful" });
    for (const n of ["memory/used.md", "memory/stale.md", "memory/never.md", "memory/sub/deep.md", "memory/profile.md"]) note(agent, n);
    note(agent, "memory/fresh.md", undefined, 2);
    writeFileSync(join(agent.repoPath, "memory/image.png"), "x");
    insert("memory_note_uses", { agent_id: agent.id, path: "memory/used.md", last_used_at: ago(2), uses: 4 });
    insert("memory_note_uses", { agent_id: agent.id, path: "memory/stale.md", last_used_at: ago(UNUSED_DAYS + 5), uses: 1 });

    setMeta("memory.usesSince", ago(UNUSED_DAYS + 10));
    // An agent that wasn't needed this month keeps every note.
    expect(unusedNotes(agent.id, agent.repoPath)).toEqual([]);
    work(agent);

    // Counting began 10 days ago: only what was last used before that is known to be unused.
    setMeta("memory.usesSince", ago(10));
    expect(unusedNotes(agent.id, agent.repoPath).map((n) => n.path)).toEqual(["memory/stale.md"]);

    setMeta("memory.usesSince", ago(UNUSED_DAYS + 10));
    const all = noteUses(agent.id, agent.repoPath);
    expect(all.map((n) => n.path)).toEqual(["memory/never.md", "memory/sub/deep.md", "memory/stale.md", "memory/fresh.md", "memory/used.md"]);
    expect(all.filter((n) => n.unused).map((n) => n.path)).toEqual(["memory/never.md", "memory/sub/deep.md", "memory/stale.md"]);
    expect(all.find((n) => n.path === "memory/used.md")).toMatchObject({ uses: 4, unused: false });
    expect(all.find((n) => n.path === "memory/never.md")).toMatchObject({ uses: 0, lastUsedAt: null });

    // A dream kept these: not handed over again for a while. A note that is gone is skipped.
    markReviewed(agent.id, agent.repoPath, ["memory/never.md", "memory/gone.md"]);
    expect(unusedNotes(agent.id, agent.repoPath).map((n) => n.path)).toEqual(["memory/sub/deep.md", "memory/stale.md"]);
    expect(uses(agent.id, "memory/gone.md")).toBeNull();
    expect(uses(agent.id, "memory/never.md")?.uses).toBe(0);
  });

  test("unused notes reach the dream's prompt and make a dream due", async () => {
    const agent = await makeAgent({ name: "Hoarder" });
    setMeta("memory.usesSince", ago(UNUSED_DAYS + 10));
    const settings = getSettings();
    const later = new Date(Date.now() + 8 * DAY);
    note(agent, "memory/old-campaign.md", "# Campaign\n" + "- detail\n".repeat(300));
    // Not needed this month: nothing to tidy.
    expect(memoryToTidy(agent, settings)).toBe(false);
    expect(dreamDue(agent, settings, later)).toBe(false);
    work(agent, UNUSED_RUNS - 1);
    expect(memoryToTidy(agent, settings)).toBe(false);
    work(agent, 1);
    expect(memoryToTidy(agent, settings)).toBe(true);
    expect(dreamDue(agent, settings, later)).toBe(true);
    const prompt = buildDreamPrompt({
      agent,
      settings,
      digestPath: null,
      exchanges: 0,
      conversations: 0,
      since: null,
      lastDream: null,
      unusedNotes: unusedNotes(agent.id, agent.repoPath),
    });
    expect(prompt).toContain(`No task opened or wrote these notes for ${UNUSED_DAYS} days or more: memory/old-campaign.md (3 KB, never used)`);
    expect(prompt).toContain("Report each as `merged` or `removed`");
    const quiet = buildDreamPrompt({ agent, settings, digestPath: null, exchanges: 0, conversations: 0, since: null, lastDream: null });
    expect(quiet).not.toContain("No task opened");
  });
});

describe("optimize report", () => {
  test("large chats this week and the memory of every agent", async () => {
    const agent = await makeAgent({ name: "Long Talker" });
    const big = createConversation({ agentId: agent.id, title: "Huge" }).id;
    const small = createConversation({ agentId: agent.id, title: "Small" }).id;
    const old = createConversation({ agentId: agent.id, title: "Last month" }).id;
    const set = (id: string, tokens: number, at: string) => sql("UPDATE conversations SET context_tokens = ?, last_message_at = ? WHERE id = ?", tokens, at, id);
    set(big, 610_000, ago(1));
    set(small, 40_000, ago(1));
    set(old, 900_000, ago(20));
    writeFileSync(join(agent.repoPath, "MEMORY.md"), `# Memory\n${"- a line of memory\n".repeat(600)}`);
    const report = optimizeReport();
    expect(report.context.share).toBe(70);
    expect(report.context.largest[0]).toMatchObject({ conversationId: big, title: "Huge", agentName: "Long Talker", tokens: 610_000 });
    expect(report.context.largest.some((c) => c.conversationId === old)).toBe(false);
    expect(report.context.over).toBeGreaterThanOrEqual(1);
    const mine = report.memory.agents.find((a) => a.agentId === agent.id)!;
    expect(mine.chars).toBeGreaterThan(report.memory.target);
    expect(report.memory.agents[0]!.agentId).toBe(agent.id);
    expect(report.automatic).toEqual({ cleanup: true, dreaming: true, compress: true });
  });
});

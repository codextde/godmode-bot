import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Review } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { get, insert, run as exec, setMeta } from "../src/db";
import { ensureDefaultAgent, getAgent } from "../src/agents/service";
import { createRoutine, getRoutine } from "../src/services/routines";
import { createConversation, getConversation, sendMessage, setConversationState } from "../src/services/conversations";
import { getFollowup, scheduleFollowup } from "../src/services/followups";
import { getRun, waitForRun } from "../src/runner/runner";
import { getSettings, updateSettings } from "../src/services/settings";
import { checkSettingsPatch } from "../src/services/settingsPatch";
import { newId } from "../src/util";
import { ensureReviewListener, getReview, recoverReviews, reviewOverview, reviewTick, startReview, undoReviewAction } from "../src/review/review";
import { measureSetup, samplesDigest, setupDigest, splitParts, PART_MAX } from "../src/review/digest";
import { getAccessToken } from "../src/server/auth";

let env: TestEnv;
let main: Agent;
const DAY = 86_400_000;

beforeAll(async () => {
  env = await setupEnv("godmode-review-");
  main = await ensureDefaultAgent();
  ensureReviewListener();
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await env.close();
});

afterEach(() => {
  for (const f of ["review-calls.json", "review-report.json", "review-no-report"]) rmSync(join(env.stateDir, f), { force: true });
  updateSettings({ review: { autoFix: true, enabled: true } });
});

function calls(list: { name: string; arguments: unknown }[]) {
  writeFileSync(join(env.stateDir, "review-calls.json"), JSON.stringify(list));
}

function addRun(agentId: string, conversationId: string, opts: { prompt?: string; result?: string; status?: string; error?: string; trigger?: string; at?: number } = {}) {
  const ts = new Date(opts.at ?? Date.now() - 60_000).toISOString();
  const id = newId("run");
  insert("runs", {
    id,
    agent_id: agentId,
    conversation_id: conversationId,
    routine_id: null,
    parent_run_id: null,
    trigger: opts.trigger ?? "chat",
    status: opts.status ?? "succeeded",
    prompt: opts.prompt ?? "Do it",
    result: opts.result ?? "Done",
    error: opts.error ?? null,
    created_at: ts,
    started_at: ts,
    finished_at: ts,
  });
  return id;
}

function quietChat(agent: Agent, title: string, daysAgo: number) {
  const id = createConversation({ agentId: agent.id, title }).id;
  const ts = new Date(Date.now() - daysAgo * DAY).toISOString();
  exec("UPDATE conversations SET last_message_at = ?, created_at = ? WHERE id = ?", ts, ts, id);
  return id;
}

async function reviewToEnd(review: Review): Promise<{ review: Review; out: Record<string, any> }> {
  await waitForRun(review.runId!, 30_000);
  await until(() => !["queued", "running"].includes(getReview(review.id).status), 10_000, "review settled");
  const text = getRun(review.runId!).result ?? "";
  return { review: getReview(review.id), out: text.startsWith("REVIEW ") ? JSON.parse(text.slice(7)) : {} };
}

describe("setup digest", () => {
  test("measures the setup and lists what needs a look", async () => {
    const agent = await makeAgent({ name: "Digest Bot" });
    const since = new Date(Date.now() - DAY).toISOString();
    const busy = createConversation({ agentId: agent.id, title: "Invoices" }).id;
    addRun(agent.id, busy, { status: "failed", error: "Login to Lexoffice failed (run_abcdefgh1234)", at: Date.now() - 3 * 60_000 });
    addRun(agent.id, busy, { status: "failed", error: "Login to Lexoffice failed (run_zyxwvuts9876)", at: Date.now() - 2 * 60_000 });
    addRun(agent.id, busy, { prompt: "Chase the invoices", result: "Sent 3 reminders", at: Date.now() - 60_000 });
    const big = createConversation({ agentId: agent.id, title: "Huge chat" }).id;
    exec("UPDATE conversations SET context_tokens = 180000, context_window = 200000, last_message_at = ? WHERE id = ?", new Date().toISOString(), big);
    const stale = quietChat(agent, "Old research", 30);
    const looping = createConversation({ agentId: agent.id, title: "Waiting for ACME" }).id;
    scheduleFollowup({ conversationId: looping, agentId: agent.id, dueAt: new Date(Date.now() + DAY), note: "Check whether ACME answered" });

    const state = measureSetup(since);
    expect(state.metrics.failed).toBeGreaterThanOrEqual(2);
    expect(state.metrics.continuing).toBeGreaterThanOrEqual(1);
    expect(state.metrics.bigChats).toBeGreaterThanOrEqual(1);

    const text = setupDigest({ state, human: "Daniel", at: new Date() }, "## Previous review\n\nThis is the first auto review.");
    expect(text).toContain("**Digest Bot**");
    expect(text).toContain("2 failed");
    expect(text).toContain(`"Huge chat" (${big})`);
    expect(text).toContain("context 90%");
    expect(text).toContain(`"Old research" (${stale})`);
    expect(text).toContain(`"Waiting for ACME" (${looping})`);
    expect(text).toContain("Follow-up note: Check whether ACME answered");
    // The same failure with different ids is one group.
    expect(text).toMatch(/2× Login to Lexoffice failed/);

    const samples = samplesDigest(state, "Daniel");
    expect(samples).toContain("## Digest Bot");
    expect(samples).toContain("> Sent 3 reminders");
  });

  test("private chats and Godmode's own upkeep stay out", async () => {
    const agent = await makeAgent({ name: "Private Bot" });
    const secret = createConversation({ agentId: agent.id, title: "Secret plans", private: true }).id;
    exec("UPDATE conversations SET context_tokens = 190000 WHERE id = ?", secret);
    const state = measureSetup(new Date(Date.now() - DAY).toISOString());
    expect(state.chats.some((c) => c.id === secret)).toBe(false);
  });

  test("a long digest is split at line ends", () => {
    const text = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const parts = splitParts(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= PART_MAX)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });
});

describe("auto review run", () => {
  test("runs as the main agent with Godmode's review tools only, and records its report", async () => {
    const review = await startReview("manual");
    expect(review.status === "queued" || review.status === "running").toBe(true);
    expect(review.metrics).not.toBeNull();
    await expect(startReview("manual")).rejects.toThrow("running already");
    const { review: done, out } = await reviewToEnd(review);
    expect(done.status).toBe("succeeded");
    expect(done.summary).toBe("Reviewed the setup.");
    expect(getRun(review.runId!).agentId).toBe(main.id);
    expect(getRun(review.runId!).trigger).toBe("review");

    expect(out.servers).toEqual(["godmode"]);
    expect(out.tools).toContain("review_report");
    expect(out.tools).toContain("review_chat_stop");
    expect(out.tools).toContain("agent_update");
    expect(out.tools).not.toContain("agent_delete");
    expect(out.tools).not.toContain("notify_user");
    expect(out.tools).not.toContain("vault_get_login");
    expect(out.forbidden.isError).toBe(true);
    expect(out.files).toBeGreaterThanOrEqual(1);
    expect(out.digest).toContain("# Godmode setup on");
    expect(out.digest).toContain("This is the first auto review.");

    const inv = invocations(env).filter((i) => i.prompt.startsWith("Auto review —")).at(-1)!;
    expect(argValue(inv, "--tools")).toBe("Read,Glob,Grep");
    expect(argValue(inv, "--permission-mode")).toBe("default");
    expect(inv.args).not.toContain("--dangerously-skip-permissions");
    expect(inv.systemPrompt).toContain("auto review");
    expect(realpathSync(inv.cwd)).toBe(realpathSync(main.repoPath));

    // The digest is gone, the chat is the main agent's archived review chat and takes no messages.
    expect(existsSync(join(main.repoPath, "workspace/tmp/reviews", review.id))).toBe(false);
    const conv = getConversation(review.conversationId!);
    expect(conv.origin).toBe("review");
    expect(conv.archived).toBe(true);
    await expect(sendMessage(review.conversationId!, { content: "hi" })).rejects.toThrow("reviews the setup");
  });

  test("the next review gets the previous one's notes and numbers", async () => {
    const { out } = await reviewToEnd(await startReview("manual"));
    expect(out.digest).toContain("### Its notes for this review");
    expect(out.digest).toContain("Watch the follow-ups.");
    expect(out.digest).toContain("How the numbers moved since: runs");
  });

  test("a review that ends without its report fails", async () => {
    writeFileSync(join(env.stateDir, "review-no-report"), "");
    const { review } = await reviewToEnd(await startReview("manual"));
    expect(review.status).toBe("failed");
    expect(review.error).toContain("without its report");
  });

  test("findings and scores are kept; unknown agents are left out", async () => {
    const agent = await makeAgent({ name: "Scored Bot" });
    writeFileSync(
      join(env.stateDir, "review-report.json"),
      JSON.stringify({
        summary: "Two things.",
        findings: [
          { area: "logins", severity: "warning", text: "The Lexoffice login fails every day.", forHuman: "Add the Lexoffice login in the vault." },
          { area: "chats", severity: "info", text: "Archived three old chats." },
        ],
        scores: [
          { agentId: agent.id, score: 4.4, note: "Solid" },
          { agentId: "agt_missing", score: 2, note: "?" },
        ],
        notes: "Lexoffice login next time.",
      }),
    );
    const { review, out } = await reviewToEnd(await startReview("manual"));
    expect(out.report.text).toContain("agt_missing");
    expect(review.findings).toHaveLength(2);
    expect(review.findings[1]!.forHuman).toBe("");
    expect(review.scores).toEqual([{ agentId: agent.id, name: "Scored Bot", score: 4, note: "Solid" }]);
    const n = get<{ title: string }>("SELECT title FROM notifications WHERE link = '/settings/review' ORDER BY created_at DESC LIMIT 1");
    expect(n?.title).toBe("Auto review: 1 thing for you");
  });
});

describe("what a review changes", () => {
  test("agents, automations and chats change, each with an undo", async () => {
    const agent = await makeAgent({ name: "Fix Bot", instructions: "Do things." });
    const routine = createRoutine({ agentId: agent.id, name: "Broken daily", cron: "0 8 * * *", prompt: "Check" });
    const stale = quietChat(agent, "Done long ago", 40);
    const pinned = quietChat(agent, "Pinned note", 40);
    exec("UPDATE conversations SET pinned = 1 WHERE id = ?", pinned);
    const looping = createConversation({ agentId: agent.id, title: "Endless wait" }).id;
    scheduleFollowup({ conversationId: looping, agentId: agent.id, dueAt: new Date(Date.now() + DAY), note: "Check again" });
    const recent = createConversation({ agentId: agent.id, title: "Human is on it" }).id;
    addRun(agent.id, recent, { prompt: "Keep checking every hour" });
    scheduleFollowup({ conversationId: recent, agentId: agent.id, dueAt: new Date(Date.now() + DAY), note: "Check hourly" });
    calls([
      { name: "agent_update", arguments: { agentId: agent.id, instructions: "Do things. Log in through the vault first." } },
      { name: "agent_update", arguments: { agentId: agent.id, model: "haiku" } },
      { name: "routine_update", arguments: { routineId: routine.id, enabled: false } },
      { name: "review_chat_archive", arguments: { conversationId: stale, reason: "Work is done" } },
      { name: "review_chat_archive", arguments: { conversationId: pinned, reason: "Old" } },
      { name: "review_chat_stop", arguments: { conversationId: looping, reason: "Waits for a reply that won't come" } },
      { name: "review_chat_stop", arguments: { conversationId: recent, reason: "Loops" } },
    ]);
    const { review, out } = await reviewToEnd(await startReview("manual"));
    expect(out.calls.map((c: { isError: boolean }) => c.isError)).toEqual([false, true, false, false, false, false, false]);
    expect(out.calls[6].text).toContain("last 3 days");
    expect(getFollowup(recent)?.note).toBe("Check hourly");
    expect(out.calls[1].text).toContain("instructions, description, role, heartbeat only");
    expect(out.calls[4].text).toContain("pinned");
    expect(getAgent(agent.id).instructions).toBe("Do things. Log in through the vault first.");
    expect(getRoutine(routine.id).enabled).toBe(false);
    expect(getConversation(stale).archived).toBe(true);
    expect(getConversation(pinned).archived).toBe(false);
    expect(getFollowup(looping)).toBeNull();

    expect(review.actions.map((a) => a.kind)).toEqual(["agent_updated", "automation_updated", "chat_archived", "chat_stopped"]);
    expect(review.actions.every((a) => a.canUndo)).toBe(true);
    expect(review.actions[1]!.text).toBe(`Paused Fix Bot's automation "Broken daily"`);

    for (const a of review.actions) await undoReviewAction(review.id, a.index);
    expect(getAgent(agent.id).instructions).toBe("Do things.");
    expect(getRoutine(routine.id).enabled).toBe(true);
    expect(getConversation(stale).archived).toBe(false);
    expect(getFollowup(looping)?.note).toBe("Check again");
    const after = getReview(review.id);
    expect(after.actions.every((a) => a.undoneAt && !a.canUndo)).toBe(true);
    await expect(undoReviewAction(review.id, 0)).rejects.toThrow("undone already");

    // The next review is told what the human undid.
    const { out: next } = await reviewToEnd(await startReview("manual"));
    expect(next.digest).toContain("Changes the human undid");
    expect(next.digest).toContain("Changed Fix Bot's instructions");
  });

  test("a change made again since can't be undone", async () => {
    const agent = await makeAgent({ name: "Edited Bot", instructions: "Old." });
    calls([{ name: "agent_update", arguments: { agentId: agent.id, instructions: "New." } }]);
    const { review } = await reviewToEnd(await startReview("manual"));
    const { updateAgent } = await import("../src/agents/service");
    await updateAgent(agent.id, { instructions: "The human's own." });
    expect(getReview(review.id).actions[0]!.canUndo).toBe(false);
    await expect(undoReviewAction(review.id, 0)).rejects.toThrow("changed again");
  });

  test("a big chat continues in a new chat with the summary and its follow-up", async () => {
    const agent = await makeAgent({ name: "Long Chat Bot" });
    const old = createConversation({ agentId: agent.id, title: "Shop relaunch" }).id;
    addRun(agent.id, old, { prompt: "Plan the relaunch", result: "Plan ready", at: Date.now() - 5 * DAY, trigger: "followup" });
    exec("UPDATE conversations SET context_tokens = 190000, context_window = 200000 WHERE id = ?", old);
    scheduleFollowup({ conversationId: old, agentId: agent.id, dueAt: new Date(Date.now() + DAY), note: "Check the DNS" });
    const summary = "The shop relaunch: theme done, DNS moved to Cloudflare on 11-03, waiting for the SSL certificate. Open: payment test, redirects.";
    calls([
      { name: "review_chat_read", arguments: { conversationId: old } },
      { name: "review_chat_restart", arguments: { conversationId: old, summary: "too short", reason: "Too big" } },
      { name: "review_chat_restart", arguments: { conversationId: old, summary, reason: "Context 95% full" } },
    ]);
    const { review, out } = await reviewToEnd(await startReview("manual"));
    expect(out.calls[0].text).toContain("Plan the relaunch");
    expect(out.calls[0].text).toContain("Follow-up due");
    expect(out.calls[1].text).toContain("real summary");
    const action = review.actions.find((a) => a.kind === "chat_restarted")!;
    const fresh = action.conversationId!;
    expect(fresh).not.toBe(old);
    expect(getConversation(old).archived).toBe(true);
    expect(getFollowup(old)).toBeNull();
    expect(getFollowup(fresh)?.note).toBe("Check the DNS");
    const seed = get<{ id: string; prompt: string }>("SELECT id, prompt FROM runs WHERE conversation_id = ? ORDER BY created_at LIMIT 1", fresh)!;
    expect(seed.prompt).toContain(summary);
    await waitForRun(seed.id, 20_000);

    // Once someone goes on in the new chat, the old one stays archived.
    const more = addRun(agent.id, fresh, { prompt: "Go on" });
    expect(getReview(review.id).actions.find((a) => a.index === action.index)!.canUndo).toBe(false);
    exec("DELETE FROM runs WHERE id = ?", more);

    await undoReviewAction(review.id, action.index);
    expect(getConversation(old).archived).toBe(false);
    expect(getConversation(fresh).archived).toBe(true);
    expect(getFollowup(old)?.note).toBe("Check the DNS");
    expect(getFollowup(fresh)).toBeNull();
  });

  test("with auto-fix off it changes nothing", async () => {
    updateSettings({ review: { autoFix: false } });
    const agent = await makeAgent({ name: "Untouched Bot", instructions: "Keep." });
    calls([{ name: "agent_update", arguments: { agentId: agent.id, instructions: "Changed." } }]);
    const { review, out } = await reviewToEnd(await startReview("manual"));
    expect(out.calls[0].isError).toBe(true);
    expect(out.calls[0].text).toContain("Auto-fix is off");
    expect(getAgent(agent.id).instructions).toBe("Keep.");
    expect(review.actions).toHaveLength(0);
  });

  test("tickets are capped per review", async () => {
    const agent = await makeAgent({ name: "Ticket Bot" });
    const ticket = (n: number) => ({ name: "task_create", arguments: { title: `Fix ${n}`, agentId: agent.id, start: false } });
    calls([ticket(1), ticket(2), ticket(3), ticket(4)]);
    const { review, out } = await reviewToEnd(await startReview("manual"));
    expect(out.calls.map((c: { isError: boolean }) => c.isError)).toEqual([false, false, false, true]);
    expect(review.actions.filter((a) => a.kind === "ticket_filed")).toHaveLength(3);
  });
});

describe("schedule", () => {
  test("starts once when its time has come since the last tick", async () => {
    updateSettings({ review: { enabled: true, cron: "0 5 * * *" } });
    const at = new Date();
    at.setHours(6, 0, 0, 0);
    setMeta("review.lastSweepAt", new Date(at.getTime() - DAY).toISOString());
    const started = await reviewTick(at);
    expect(started?.reason).toBe("schedule");
    await reviewToEnd(started!);
    expect(await reviewTick(new Date(at.getTime() + 10 * 60_000))).toBeNull();
    updateSettings({ review: { enabled: false } });
    setMeta("review.lastSweepAt", new Date(at.getTime() - DAY).toISOString());
    expect(await reviewTick(at)).toBeNull();
    expect(reviewOverview().nextReviewAt).toBeNull();
    updateSettings({ review: { enabled: true } });
    expect(reviewOverview().nextReviewAt).not.toBeNull();
  });

  test("a review cut off by a restart ends as failed", () => {
    const id = newId("rvw");
    insert("reviews", { id, run_id: "run_gone", conversation_id: null, reason: "schedule", status: "running", metrics: null, created_at: new Date().toISOString() });
    recoverReviews();
    expect(getReview(id).status).toBe("failed");
    expect(getReview(id).error).toContain("Interrupted");
  });

  test("settings are checked", () => {
    expect(() => checkSettingsPatch({ review: { cron: "every day" } }, () => {})).toThrow("cron");
    expect(() => checkSettingsPatch({ review: { autoFix: "yes" } }, () => {})).toThrow("autoFix");
    expect(() => checkSettingsPatch({ review: { cron: "30 6 * * 1-5", enabled: false } }, () => {})).not.toThrow();
    expect(getSettings().review.cron).toBeTruthy();
  });
});

describe("API", () => {
  test("overview, start, detail and undo", async () => {
    const headers = { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" };
    const overview = await (await fetch(`${env.baseUrl}/api/reviews`, { headers })).json();
    expect(overview.enabled).toBe(true);
    expect(Array.isArray(overview.reviews)).toBe(true);
    const res = await fetch(`${env.baseUrl}/api/reviews`, { method: "POST", headers });
    expect(res.status).toBe(201);
    const started = (await res.json()) as Review;
    await reviewToEnd(started);
    const detail = await (await fetch(`${env.baseUrl}/api/reviews/${started.id}`, { headers })).json();
    expect(detail.id).toBe(started.id);
    const bad = await fetch(`${env.baseUrl}/api/reviews/${started.id}/actions/x/undo`, { method: "POST", headers });
    expect(bad.status).toBe(400);
  });
});

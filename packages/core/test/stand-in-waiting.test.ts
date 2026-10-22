import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { run as sql, setMeta } from "../src/db";
import { getRun } from "../src/runner/runner";
import { getConversation, startChat } from "../src/services/conversations";
import { getFollowup, scheduleFollowup } from "../src/services/followups";
import { pauseConversation, pauseOf, stopPauses } from "../src/services/pauses";
import { stopWaitingWork } from "../src/remote/devices";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-standin-waiting-");
  agent = await makeAgent({ name: "Stand-in Bot" });
});

afterAll(async () => {
  stopPauses();
  await env.close();
});

const PRIMARY = "rnr_primarydesk01";

describe("chats a stand-in took over, once the primary is back", () => {
  test("work that would go on by itself later stops; what waits for the human stays", async () => {
    const since = new Date().toISOString();
    mkdirSync(env.stateDir, { recursive: true });
    writeFileSync(join(env.stateDir, "limit"), String(Math.floor(Date.now() / 1000) + 4 * 86_400));
    const limited = await startChat({ agentId: agent.id, content: "LIMIT_HIT send the follow-up emails" });
    await until(() => getRun(limited.run.id).status === "paused", 15_000, "the run to wait for the limit");
    expect(pauseOf(limited.conversation.id)).toMatchObject({ reason: "limit", auto: 1 });

    const asked = await startChat({ agentId: agent.id, content: "WAIT_TO_FINISH look at the inbox" });
    await until(() => getRun(asked.run.id).status === "running" && getConversation(asked.conversation.id).messages.at(-1)!.blocks.length > 0, 10_000, "the run to start");
    await pauseConversation(asked.conversation.id);
    await until(() => getRun(asked.run.id).status === "paused", 15_000, "the human's pause");

    const later = await startChat({ agentId: agent.id, content: "hello" });
    await until(() => getRun(later.run.id).status === "succeeded", 10_000, "the run to finish");
    scheduleFollowup({ conversationId: later.conversation.id, agentId: agent.id, dueAt: new Date(Date.now() + 86_400_000), note: "post again" });

    const untouched = await startChat({ agentId: agent.id, content: "LIMIT_HIT a chat of this computer" });
    await until(() => getRun(untouched.run.id).status === "paused", 15_000, "its run to wait for the limit");

    const scheduled = await startChat({ agentId: agent.id, content: "LIMIT_HIT the 15:00 posting slot" });
    const older = await startChat({ agentId: agent.id, content: "LIMIT_HIT a slot from before" });
    await until(() => getRun(scheduled.run.id).status === "paused" && getRun(older.run.id).status === "paused", 15_000, "the slots to wait for the limit");
    sql("UPDATE runs SET trigger = 'routine' WHERE id IN (?, ?)", scheduled.run.id, older.run.id);
    sql("UPDATE runs SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", older.run.id);

    setMeta(`link.release.${PRIMARY}`, JSON.stringify([limited.conversation.id, asked.conversation.id, later.conversation.id]));
    expect(await stopWaitingWork(PRIMARY, "Desk", since)).toBe(3);

    expect(getRun(limited.run.id)).toMatchObject({ status: "cancelled" });
    expect(getRun(limited.run.id).error).toStartWith("Stopped: Desk is back");
    expect(pauseOf(limited.conversation.id)).toBeNull();
    expect(getConversation(limited.conversation.id).messages.at(-1)!.blocks.some((b) => b.type === "notice" && b.text.startsWith("Stopped: Desk is back"))).toBe(true);
    expect(getFollowup(later.conversation.id)).toBeNull();
    expect(pauseOf(asked.conversation.id)).toMatchObject({ reason: "user" });
    expect(pauseOf(untouched.conversation.id)).toMatchObject({ reason: "limit" });
    expect(getRun(scheduled.run.id).status).toBe("cancelled");
    expect(pauseOf(older.conversation.id)).toMatchObject({ reason: "limit" });
  }, 60_000);
});

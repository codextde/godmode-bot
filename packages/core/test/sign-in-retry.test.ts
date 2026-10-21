import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, Run } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { all, getMeta } from "../src/db";
import { createRoutine, updateRoutine } from "../src/services/routines";
import { startChat } from "../src/services/conversations";
import { claudeLoginStatus } from "../src/services/claudeLogin";
import { startRunNotices, stopRunNotices } from "../src/services/runNotices";
import { triggerRoutine } from "../src/scheduler/scheduler";
import { signInRetryIdle, startSignInRetry, stopSignInRetry } from "../src/automations/signInRetry";
import { waitForRun } from "../src/runner/runner";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-sign-in-retry-");
  agent = await makeAgent({ name: "Sign-in Retry Bot" });
  startRunNotices();
  startSignInRetry();
});

afterAll(async () => {
  stopSignInRetry();
  stopRunNotices();
  await env.close();
});

const signedOutNotices = () => all<{ kind: string; body: string }>("SELECT kind, body FROM notifications WHERE title = 'Claude is signed out'");
const runsOf = (routineId: string) => all<{ id: string; status: string }>("SELECT id, status FROM runs WHERE routine_id = ? AND trigger = 'routine' ORDER BY created_at, rowid", routineId);

async function answered(): Promise<Run> {
  const { run } = await startChat({ agentId: agent.id, content: "hello" });
  const finished = await waitForRun(run.id, 20_000);
  expect(finished.status).toBe("succeeded");
  await Bun.sleep(100);
  await signInRetryIdle();
  return finished;
}

describe("automations that failed while Claude was signed out", () => {
  test("one notice per outage, one more run once Claude answers, none when the next slot is near", async () => {
    const yearly = createRoutine({ agentId: agent.id, name: "Yearly report", cron: "0 3 1 1 *", timezone: "UTC", prompt: "AUTH_EXPIRED" });
    const often = createRoutine({ agentId: agent.id, name: "Half-hourly check", cron: "*/30 * * * *", timezone: "UTC", prompt: "AUTH_EXPIRED" });
    const off = createRoutine({ agentId: agent.id, name: "Turned off later", cron: "0 4 1 1 *", timezone: "UTC", prompt: "AUTH_EXPIRED" });

    for (const r of [yearly, often, off]) {
      const run = await triggerRoutine(r.id);
      expect((await waitForRun(run.id, 20_000)).status).toBe("failed");
    }
    await until(() => !!claudeLoginStatus().signedOut);
    await Bun.sleep(200);
    // Several runs failed: one notice for all of them, none per automation.
    expect(signedOutNotices()).toHaveLength(1);
    expect(signedOutNotices()[0]!.kind).toBe("error");
    expect(signedOutNotices()[0]!.body).toContain("/login");
    expect(all("SELECT id FROM notifications WHERE title LIKE '“%” failed'")).toHaveLength(0);

    updateRoutine(off.id, { enabled: false });

    await answered();
    await until(() => runsOf(yearly.id).length === 2);
    expect(runsOf(often.id)).toHaveLength(1);
    expect(runsOf(off.id)).toHaveLength(1);
    const again = runsOf(yearly.id)[1]!;
    expect(JSON.parse(getMeta("automations.signInRetried")!)).toContain(again.id);

    // The second try finds Claude signed out again: a new outage, a new notice.
    expect((await waitForRun(again.id, 20_000)).status).toBe("failed");
    await until(() => signedOutNotices().length === 2);

    // It was the one more run: the next answer doesn't start it a third time.
    await answered();
    await Bun.sleep(300);
    expect(runsOf(yearly.id)).toHaveLength(2);
    expect(runsOf(often.id)).toHaveLength(1);
  }, 60_000);
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { licenseDeepLink, licenseKeyFromDeepLink, type LicenseState, type LicenseUsage } from "@godmode/shared";
import { setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { get, getMeta, insert, run as sql, setMeta } from "../src/db";
import { getAccessToken } from "../src/server/auth";
import { ensureDefaultAgent } from "../src/agents/service";
import { waitForRun } from "../src/runner/runner";
import { startChat } from "../src/services/conversations";
import { createRoutine } from "../src/services/routines";
import { triggerRoutine } from "../src/scheduler/scheduler";
import { listNotifications } from "../src/services/notifications";
import { scheduleFollowup, sweep as sweepFollowups } from "../src/services/followups";
import {
  LICENSE_GRACE_MS,
  LICENSE_STALE_MS,
  LICENSE_UNVERIFIED_MS,
  __resetLicenseForTests,
  __setLicenseClockForTests,
  __setLicenseCompiledForTests,
  __setLicenseEnforcedForTests,
  __setLicenseOfficialForTests,
  __setLicenseFetchForTests,
  initLicense,
  licenseEnforced,
  licenseState,
  noteLicenseRefusal,
  licenseUsage,
  refreshLicense,
  requireLicense,
  LicenseRequiredError,
} from "../src/license/license";

const KEY = "GM-7K2QD-9HXRT-C4VMN-PA3ZE";
const OTHER = "GM-AB2CD-EF3GH-JK4MN-PQ5RS";
const DAY = 86_400_000;

let env: TestEnv;
let now = Date.parse("2026-10-05T12:00:00Z");
let calls: string[] = [];
/** What the fake licence server answers: a response, or a thrown error (network down). */
let answer: () => Response = () => Response.json({ valid: false, reason: "unknown" }, { status: 404 });

const json = (body: unknown, status = 200) => () => Response.json(body, { status });
const offline = () => {
  throw new TypeError("fetch failed");
};

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  env = await setupEnv("godmode-license-");
  await ensureDefaultAgent();
  __setLicenseClockForTests(() => now);
  __setLicenseFetchForTests(async (url) => {
    calls.push(url);
    return answer();
  });
});

afterAll(async () => {
  __setLicenseFetchForTests(null);
  __setLicenseClockForTests(null);
  __setLicenseEnforcedForTests(null);
  __setLicenseCompiledForTests(null);
  await env.close();
});

beforeEach(() => {
  __resetLicenseForTests();
  __setLicenseEnforcedForTests(true);
  now = Date.parse("2026-10-05T12:00:00Z");
  calls = [];
  answer = json({ valid: false, reason: "unknown" }, 404);
});

afterEach(() => {
  delete process.env.GODMODE_LICENSE;
});

const trial = (extra: Record<string, unknown> = {}) =>
  json({
    valid: true,
    plan: "monthly",
    status: "trialing",
    trialEndsAt: now + 6 * DAY,
    renewsAt: now + 6 * DAY,
    cancelAtPeriodEnd: false,
    manageUrl: `https://usegodmode.com/api/portal?key=${KEY}`,
    ...extra,
  });

async function putKey(key: string): Promise<{ status: number; body: LicenseState & { error?: string; code?: string } }> {
  const res = await api("PUT", "/api/license", { key });
  return { status: res.status, body: await res.json() };
}

describe("the free trial", () => {
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  test("a new install without a key runs free for 14 days from its first start, and restarts don't extend them", () => {
    const firstStart = new Date(now).toISOString();
    const ends = now + 14 * DAY;
    expect(LICENSE_GRACE_MS).toBe(14 * DAY);
    initLicense();
    const s = licenseState();
    expect(s.status).toBe("grace");
    expect(s.blocked).toBe(false);
    expect(s.graceEndsAt).toBe(new Date(ends).toISOString());
    expect(s.message).toBe(`Free until ${day(ends)}. Then pick a plan to keep your agents working.`);
    expect(() => requireLicense()).not.toThrow();

    now += 3 * DAY;
    initLicense();
    expect(licenseState().graceEndsAt).toBe(s.graceEndsAt);
    expect(getMeta("license.first_start")).toBe(firstStart);

    now += 10 * DAY;
    initLicense();
    expect(licenseState()).toMatchObject({ status: "grace", blocked: false });

    now += DAY;
    initLicense();
    const after = licenseState();
    expect(after.status).toBe("missing");
    expect(after.blocked).toBe(true);
    expect(after.graceEndsAt).toBe(s.graceEndsAt);
    expect(after.message).toBe(`Your free trial ended on ${day(ends)}. Subscribe or add your licence key to keep your agents working.`);
    expect(after.message).not.toContain("free trial to");
    expect(() => requireLicense()).toThrow(LicenseRequiredError);
    expect(getMeta("license.first_start")).toBe(firstStart);
  });

  test("an install that already has its days keeps them as they are (an older 7-day trial isn't extended)", () => {
    setMeta("license.first_start", new Date(now - 6 * DAY).toISOString());
    setMeta("license.grace_ends_at", new Date(now + DAY).toISOString());
    initLicense();
    expect(licenseState()).toMatchObject({ status: "grace", blocked: false, graceEndsAt: new Date(now + DAY).toISOString() });
    now += 2 * DAY;
    initLicense();
    expect(licenseState()).toMatchObject({ status: "missing", blocked: true, graceEndsAt: new Date(now - DAY).toISOString() });
  });

  test("an older install that was refused without a key gets its 14 days from this start", () => {
    setMeta("license.first_start", new Date(now - 20 * DAY).toISOString());
    initLicense();
    expect(licenseState()).toMatchObject({ status: "grace", blocked: false, graceEndsAt: new Date(now + LICENSE_GRACE_MS).toISOString() });
  });

  test("a build that doesn't check licences doesn't start the clock", () => {
    __setLicenseEnforcedForTests(false);
    initLicense();
    expect(licenseState()).toMatchObject({ status: "missing", graceEndsAt: null, message: null, blocked: false });
  });

  test("GODMODE_LICENSE seeds the key, and leaves the environment; an install with a key gets no free days", () => {
    process.env.GODMODE_LICENSE = ` ${KEY.toLowerCase()} `;
    initLicense();
    expect(process.env.GODMODE_LICENSE).toBeUndefined();
    expect(getMeta("license.key")).toBe(KEY);
    expect(licenseState()).toMatchObject({ status: "unverified", graceEndsAt: null });
  });

  test("a key that ends during the free week leaves the rest of the week", async () => {
    initLicense();
    const ends = now + LICENSE_GRACE_MS;
    answer = trial();
    await putKey(KEY);
    answer = json({ valid: false, plan: "monthly", status: "canceled", trialEndsAt: null, renewsAt: null, cancelAtPeriodEnd: false, manageUrl: null });
    const s = await refreshLicense();
    expect(s).toMatchObject({ status: "expired", blocked: false });
    expect(s.message).toBe(`This licence has ended. Everything keeps working until ${day(ends)}.`);
    now = ends;
    expect(licenseState()).toMatchObject({ status: "expired", blocked: true });
  });
});

describe("the gate", () => {
  test("off: no key needed (tests and builds from source)", async () => {
    __setLicenseEnforcedForTests(null);
    expect(licenseEnforced()).toBe(false);
    const s = licenseState();
    expect(s.enforced).toBe(false);
    expect(s.blocked).toBe(false);
    const chat = await startChat({ content: "Say hello" });
    expect((await waitForRun(chat.run.id, 20_000)).status).toBe("succeeded");
  });

  test("only official builds enforce it; builds of your own stay free (MIT)", () => {
    __setLicenseEnforcedForTests(null);
    try {
      __setLicenseCompiledForTests(true);
      __setLicenseOfficialForTests(false);
      expect(licenseEnforced()).toBe(false);
      __setLicenseOfficialForTests(true);
      expect(licenseEnforced()).toBe(true);
    } finally {
      __setLicenseCompiledForTests(null);
      __setLicenseOfficialForTests(null);
      __setLicenseEnforcedForTests(true);
    }
  });

  test("on: a new run is refused with 402 license_required, and nothing is left behind", async () => {
    const before = (await (await api("GET", "/api/conversations")).json()).length;
    const res = await api("POST", "/api/chat", { content: "Say hello" });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe("license_required");
    expect(body.error).toContain("needs a licence");
    expect((await (await api("GET", "/api/conversations")).json()).length).toBe(before);
  });

  test("scheduled work that hits it fails with the licence's reason; the human hears once a day", async () => {
    const routine = createRoutine({ agentId: (await ensureDefaultAgent()).id, name: "Morning digest", prompt: "Digest", cron: "0 8 * * *" });
    const error = await triggerRoutine(routine.id).catch((err) => err);
    expect(error).toBeInstanceOf(LicenseRequiredError);
    const count = () => listNotifications().filter((n) => n.title === "Godmode needs an active licence").length;
    const before = count();
    noteLicenseRefusal("Automation “Morning digest”", error);
    noteLicenseRefusal("Automation “Morning digest”", error);
    expect(count()).toBe(before + 1);
  });
});

describe("keys and the licence server", () => {
  test("a malformed key is refused without asking the server", async () => {
    const { status, body } = await putKey("GM-12345");
    expect(status).toBe(400);
    expect(body.code).toBe("license_invalid");
    expect(calls).toHaveLength(0);
  });

  test("a key the server doesn't know (404) is refused and not stored", async () => {
    const { status, body } = await putKey(OTHER);
    expect(status).toBe(400);
    expect(body.code).toBe("license_invalid");
    expect(getMeta("license.key")).toBeNull();
    expect(calls[0]).toBe(`https://usegodmode.com/api/license?key=${OTHER}`);
  });

  test("a trial key: stored, runs start, the UI only sees the last 5 characters", async () => {
    answer = trial();
    const { status, body } = await putKey(`  ${KEY.toLowerCase()}`);
    expect(status).toBe(200);
    expect(body.status).toBe("trial");
    expect(body.plan).toBe("monthly");
    expect(body.keyHint).toBe("PA3ZE");
    expect(body.trialEndsAt).toBe(new Date(now + 6 * DAY).toISOString());
    expect(body.blocked).toBe(false);
    expect(body.manageUrl).toBe(`https://usegodmode.com/api/portal?key=${KEY}`);
    const { manageUrl: _url, ...rest } = body;
    expect(JSON.stringify(rest)).not.toContain(KEY);
    expect(() => requireLicense()).not.toThrow();
    const res = await api("GET", "/api/license");
    expect((await res.json()).status).toBe("trial");
  });

  test("fails open: network errors and 5xx keep the last state", async () => {
    answer = trial();
    await putKey(KEY);
    answer = offline;
    expect((await refreshLicense()).status).toBe("trial");
    answer = json({ error: "down" }, 503);
    expect((await refreshLicense()).status).toBe("trial");
    // A proxy's 404 without the server's own answer isn't a refusal either.
    answer = () => new Response("<html>Not found</html>", { status: 404 });
    expect((await refreshLicense()).status).toBe("trial");
  });

  test("state changes: past due, active, then ended", async () => {
    answer = trial();
    await putKey(KEY);
    answer = json({ valid: true, plan: "monthly", status: "past_due", renewsAt: now + DAY, cancelAtPeriodEnd: false, manageUrl: null });
    const due = await refreshLicense();
    expect(due.status).toBe("past_due");
    expect(due.blocked).toBe(false);
    answer = json({ valid: true, plan: "yearly", status: "active", trialEndsAt: null, renewsAt: now + 300 * DAY, cancelAtPeriodEnd: true, manageUrl: null });
    const active = await refreshLicense();
    expect(active).toMatchObject({ status: "active", plan: "yearly", cancelAtPeriodEnd: true, blocked: false });
    for (const ended of ["canceled", "refunded", "expired"]) {
      answer = json({ valid: false, plan: "monthly", status: ended, trialEndsAt: null, renewsAt: null, cancelAtPeriodEnd: false, manageUrl: null });
      const s = await refreshLicense();
      expect(s.status).toBe("expired");
      expect(s.blocked).toBe(true);
    }
    expect(() => requireLicense()).toThrow("licence has ended");
  });

  test("an ended key says why: trial ended, cancelled, or a payment that failed", async () => {
    answer = trial();
    await putKey(KEY);
    const ended = (status: string, reason?: string) =>
      json({ valid: false, plan: "monthly", status, reason, trialEndsAt: now - DAY, renewsAt: null, cancelAtPeriodEnd: false, manageUrl: `https://usegodmode.com/api/portal?key=${KEY}&pay=1` });

    answer = ended("canceled", "trial_ended");
    expect(await refreshLicense()).toMatchObject({ status: "expired", endReason: "trial_ended", blocked: true, message: "Your trial has ended. Subscribe to keep your agents working." });
    expect(() => requireLicense()).toThrow("Your trial has ended");
    await refreshLicense(); // the refused run asked the server again

    answer = ended("canceled", "canceled");
    expect(await refreshLicense()).toMatchObject({ endReason: "canceled", message: "Your subscription has ended. Subscribe again to keep your agents working." });

    answer = ended("expired", "payment_failed");
    const failed = await refreshLicense();
    expect(failed).toMatchObject({ status: "expired", endReason: "payment_failed", blocked: true, manageUrl: `https://usegodmode.com/api/portal?key=${KEY}&pay=1` });
    expect(failed.message).toStartWith("Your last payment didn't go through");

    answer = ended("refunded", "refunded");
    expect(await refreshLicense()).toMatchObject({ endReason: "refunded", message: expect.stringContaining("licence has ended") });

    // A server that ends a past-due key itself, without a reason, still reads as a failed payment, not a mistyped key.
    for (const status of ["past_due", "unpaid"]) {
      answer = ended(status);
      expect(await refreshLicense()).toMatchObject({ status: "expired", endReason: "payment_failed", blocked: true });
    }

    answer = ended("canceled", "something_new");
    expect(await refreshLicense()).toMatchObject({ status: "expired", endReason: null, message: expect.stringContaining("licence has ended") });

    answer = trial();
    expect(await refreshLicense()).toMatchObject({ status: "trial", endReason: null, blocked: false });
  });

  test("the older answer { valid, plan, status } is read with the rest as null", async () => {
    answer = json({ valid: true, plan: "lifetime", status: "active" });
    const { body } = await putKey(KEY);
    expect(body).toMatchObject({ status: "active", plan: "lifetime", trialEndsAt: null, renewsAt: null, cancelAtPeriodEnd: false, manageUrl: null });
  });

  test("a key the server can't be asked about counts for 7 days, then refuses until it is checked", async () => {
    answer = offline;
    const { status, body } = await putKey(KEY);
    expect(status).toBe(200);
    expect(body.status).toBe("unverified");
    expect(body.blocked).toBe(false);
    expect(body.unverifiedUntil).toBe(new Date(now + LICENSE_UNVERIFIED_MS).toISOString());

    // Another key doesn't start the window over.
    now += 6 * DAY;
    expect((await putKey(OTHER)).body.unverifiedUntil).toBe(body.unverifiedUntil);

    now += 2 * DAY;
    expect(licenseState()).toMatchObject({ status: "unverified", blocked: true });
    expect(() => requireLicense()).toThrow(LicenseRequiredError);
    // The refusal asked the server again in the background (still unreachable).
    await refreshLicense();
    expect(calls).toHaveLength(3);

    answer = json({ valid: true, plan: "monthly", status: "active" });
    expect(await refreshLicense()).toMatchObject({ status: "active", blocked: false, unverifiedUntil: null });
  });

  test("removing the key gates again", async () => {
    answer = trial();
    await putKey(KEY);
    const res = await api("DELETE", "/api/license");
    expect(await res.json()).toMatchObject({ status: "missing", keyHint: null, blocked: true });
  });

  test("a check without a key doesn't stop the later ones", async () => {
    expect((await refreshLicense()).status).toBe("missing");
    answer = trial();
    await putKey(KEY);
    answer = json({ valid: true, plan: "monthly", status: "active" });
    expect((await refreshLicense()).status).toBe("active");
    expect(calls).toHaveLength(2);
  });

  test("POST /api/license/refresh asks the server again", async () => {
    answer = trial();
    await putKey(KEY);
    answer = json({ valid: true, plan: "monthly", status: "active" });
    const res = await api("POST", "/api/license/refresh");
    expect((await res.json()).status).toBe("active");
    expect(calls).toHaveLength(2);
  });

  test("GODMODE_LICENSE_URL points the check elsewhere, but only from source", async () => {
    process.env.GODMODE_LICENSE_URL = "http://127.0.0.1:9/";
    try {
      answer = trial({ manageUrl: "http://127.0.0.1:9/api/portal?key=x" });
      const { body } = await putKey(KEY);
      expect(calls[0]).toBe(`http://127.0.0.1:9/api/license?key=${KEY}`);
      expect(body.manageUrl).toBe("http://127.0.0.1:9/api/portal?key=x");

      // A release build ignores it: a fake server can't unlock it.
      __setLicenseCompiledForTests(true);
      await refreshLicense();
      expect(calls[1]).toBe(`https://usegodmode.com/api/license?key=${KEY}`);
    } finally {
      __setLicenseCompiledForTests(null);
      delete process.env.GODMODE_LICENSE_URL;
    }
  });

  test("fail-open ends: a trial not confirmed for 14 days after it ended counts as unverified, then refuses", async () => {
    answer = trial({ trialEndsAt: now + 3 * DAY });
    const { body } = await putKey(KEY);
    const checked = Date.parse(body.checkedAt!);
    answer = offline;

    // Offline past the trial's end, but within 14 days of the last answer: still the trial.
    now = checked + 10 * DAY;
    expect(licenseState()).toMatchObject({ status: "trial", blocked: false });

    now = checked + LICENSE_STALE_MS + DAY;
    const stale = licenseState();
    expect(stale.status).toBe("unverified");
    expect(stale.blocked).toBe(false);
    expect(stale.unverifiedUntil).toBe(new Date(checked + LICENSE_STALE_MS + LICENSE_UNVERIFIED_MS).toISOString());

    now = checked + LICENSE_STALE_MS + LICENSE_UNVERIFIED_MS;
    expect(licenseState()).toMatchObject({ status: "unverified", blocked: true });

    // One answer from the server and it is fine again.
    answer = json({ valid: true, plan: "monthly", status: "active", renewsAt: now + 30 * DAY });
    expect(await refreshLicense()).toMatchObject({ status: "active", blocked: false });
  });

  test("fail-open ends for a paid period too, never for lifetime", async () => {
    answer = json({ valid: true, plan: "monthly", status: "active", renewsAt: now + DAY });
    await putKey(KEY);
    answer = offline;
    now += LICENSE_STALE_MS + LICENSE_UNVERIFIED_MS + 2 * DAY;
    expect(licenseState()).toMatchObject({ status: "unverified", blocked: true });

    __resetLicenseForTests();
    now = Date.parse("2026-10-05T12:00:00Z");
    answer = json({ valid: true, plan: "lifetime", status: "active", renewsAt: null });
    await putKey(KEY);
    now += 400 * DAY;
    expect(licenseState()).toMatchObject({ status: "active", blocked: false });
  });

  test("a different GODMODE_LICENSE replaces the stored key once the server answered for it", async () => {
    answer = trial();
    await putKey(KEY);

    process.env.GODMODE_LICENSE = OTHER;
    initLicense();
    expect(getMeta("license.key")).toBe(KEY);

    // Unreachable: the stored key stays, and the env key is tried again on the next check.
    answer = offline;
    await refreshLicense();
    expect(getMeta("license.key")).toBe(KEY);

    answer = json({ valid: true, plan: "yearly", status: "active", renewsAt: now + 300 * DAY });
    const s = await refreshLicense();
    expect(getMeta("license.key")).toBe(OTHER);
    expect(s).toMatchObject({ status: "active", plan: "yearly", keyHint: "PQ5RS" });
  });

  test("a GODMODE_LICENSE the server refuses doesn't replace the stored key", async () => {
    answer = trial();
    await putKey(KEY);
    process.env.GODMODE_LICENSE = OTHER;
    initLicense();
    let n = 0;
    answer = () => (n++ === 0 ? Response.json({ valid: false, reason: "unknown" }, { status: 404 }) : trial()());
    const s = await refreshLicense();
    expect(getMeta("license.key")).toBe(KEY);
    expect(s.status).toBe("trial");
  });
});

describe("follow-ups while the licence refuses runs", () => {
  test("a due follow-up stays and the human hears once, not per follow-up", async () => {
    __setLicenseEnforcedForTests(false);
    const chat = await startChat({ content: "Remind me later" });
    await waitForRun(chat.run.id, 20_000);
    const agentId = chat.conversation.agentId;
    scheduleFollowup({ conversationId: chat.conversation.id, agentId, dueAt: new Date(Date.now() + 60_000), note: "Check the invoice" });
    sql("UPDATE followups SET due_at = ? WHERE conversation_id = ?", new Date(Date.now() - 60_000).toISOString(), chat.conversation.id);

    __setLicenseEnforcedForTests(true);
    const before = listNotifications().length;
    await sweepFollowups();
    await sweepFollowups();
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM followups WHERE conversation_id = ?", chat.conversation.id)?.n).toBe(1);
    const added = listNotifications().slice(0, listNotifications().length - before);
    expect(added.map((n) => n.title)).toEqual(["Godmode needs an active licence"]);
    sql("DELETE FROM followups WHERE conversation_id = ?", chat.conversation.id);
  });
});

describe("what the human is told", () => {
  test("without a key and without a free trial, the way on is to subscribe or add a key", () => {
    expect(licenseState()).toMatchObject({
      status: "missing",
      blocked: true,
      message: "Godmode needs a licence to start new work. Subscribe or add your licence key.",
    });
  });

  test("a key the server doesn't know points to a subscription, not a trial", async () => {
    const { status, body } = await putKey(OTHER);
    expect(status).toBe(400);
    expect(body.error).toBe("This licence key isn't valid. Check it for typos, or subscribe to get one.");
  });
});

describe("what Godmode did so far", () => {
  const usage = async () => (await (await api("GET", "/api/license/usage")).json()) as LicenseUsage;

  test("counts finished work and what is set up, not condition checks, memory, heartbeats, sub-runs or failures", async () => {
    const agentId = (await ensureDefaultAgent()).id;
    const before = await usage();
    expect(before).toEqual(licenseUsage());
    const at = new Date().toISOString();
    let n = 0;
    const addRun = (trigger: string, status: string, durationMs: number, extra: Record<string, string> = {}) =>
      insert("runs", { id: `usage-run-${++n}`, agent_id: agentId, conversation_id: "usage-chat", trigger, status, prompt: "x", duration_ms: durationMs, created_at: at, ...extra });
    addRun("chat", "succeeded", 60 * 60_000);
    addRun("routine", "succeeded", 30 * 60_000);
    addRun("chat", "failed", 60_000);
    addRun("check", "succeeded", 60_000);
    addRun("dream", "succeeded", 60_000);
    addRun("heartbeat", "succeeded", 60_000);
    addRun("delegation", "succeeded", 60_000, { parent_run_id: "usage-run-1" });
    insert("agents", { id: "usage-agent-off", name: "Off", slug: "usage-agent-off", enabled: 0, repo_path: "/tmp/off", created_at: at, updated_at: at });
    insert("routines", { id: "usage-routine-on", agent_id: agentId, name: "On", cron: "0 9 * * *", prompt: "x", enabled: 1, created_at: at, updated_at: at });
    insert("routines", { id: "usage-routine-off", agent_id: agentId, name: "Off", cron: "0 9 * * *", prompt: "x", enabled: 0, created_at: at, updated_at: at });
    insert("credentials", { id: "usage-login", name: "Bank", created_at: at, updated_at: at });

    const after = await usage();
    expect(after.tasksDone - before.tasksDone).toBe(2);
    expect(after.automationRuns - before.automationRuns).toBe(1);
    expect(after.minutesWorked - before.minutesWorked).toBe(90);
    expect(after.agents).toBe(before.agents);
    expect(after.automations - before.automations).toBe(1);
    expect(after.logins - before.logins).toBe(1);
  });

  test("since: the first start, or the first finished run when that came earlier", () => {
    setMeta("license.first_start", "2026-10-01T08:00:00.000Z");
    sql("DELETE FROM runs WHERE id = 'usage-run-early'");
    const agentId = get<{ id: string }>("SELECT id FROM agents WHERE is_default = 1")!.id;
    expect(licenseUsage().since! <= "2026-10-01T08:00:00.000Z").toBe(true);
    insert("runs", { id: "usage-run-early", agent_id: agentId, conversation_id: "usage-chat", trigger: "chat", status: "succeeded", prompt: "x", created_at: "2020-01-02T03:04:05.000Z" });
    expect(licenseUsage().since).toBe("2020-01-02T03:04:05.000Z");
  });
});

describe("godmode://license links", () => {
  test("carry a key from the welcome page to the app; anything else is ignored", () => {
    expect(licenseDeepLink(KEY.toLowerCase())).toBe(`godmode://license?key=${KEY}`);
    expect(licenseKeyFromDeepLink(licenseDeepLink(KEY))).toBe(KEY);
    expect(licenseKeyFromDeepLink(`godmode://license/?key=${KEY.toLowerCase()}`)).toBe(KEY);
    expect(licenseKeyFromDeepLink(`GODMODE://LICENSE?key=${KEY}`)).toBe(KEY);
    expect(licenseKeyFromDeepLink(`godmode://license?key=GM-NOT-A-KEY`)).toBeNull();
    expect(licenseKeyFromDeepLink(`godmode://license?plan=yearly&key=${KEY}`)).toBe(KEY);
    expect(licenseKeyFromDeepLink(`godmode://license?key=${encodeURIComponent(KEY)}%`)).toBeNull();
    expect(licenseKeyFromDeepLink(`godmode://chat?key=${KEY}`)).toBeNull();
    expect(licenseKeyFromDeepLink(`https://license?key=${KEY}`)).toBeNull();
    expect(licenseKeyFromDeepLink("not a url")).toBeNull();
  });
});

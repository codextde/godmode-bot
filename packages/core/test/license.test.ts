import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { LicenseState } from "@godmode/shared";
import { setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { get, getMeta, run as sql } from "../src/db";
import { getAccessToken } from "../src/server/auth";
import { ensureDefaultAgent } from "../src/agents/service";
import { waitForRun } from "../src/runner/runner";
import { startChat } from "../src/services/conversations";
import { updateSettings } from "../src/services/settings";
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
  __setLicenseFetchForTests,
  initLicense,
  licenseEnforced,
  licenseState,
  noteLicenseRefusal,
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

describe("grace for installs from before licences", () => {
  test("a fresh install gets none and is gated", () => {
    initLicense();
    const s = licenseState();
    expect(s.status).toBe("missing");
    expect(s.graceEndsAt).toBeNull();
    expect(s.blocked).toBe(true);
    expect(() => requireLicense()).toThrow(LicenseRequiredError);
  });

  test("an install that was already used gets 7 days once, never extended", () => {
    updateSettings({ onboardingComplete: true });
    try {
      initLicense();
      const s = licenseState();
      expect(s.status).toBe("grace");
      expect(s.blocked).toBe(false);
      expect(s.graceEndsAt).toBe(new Date(now + LICENSE_GRACE_MS).toISOString());
      expect(s.message).toContain("Add your licence key by");

      now += 3 * DAY;
      initLicense();
      expect(licenseState().graceEndsAt).toBe(s.graceEndsAt);

      now += 5 * DAY;
      const after = licenseState();
      expect(after.status).toBe("missing");
      expect(after.blocked).toBe(true);
      expect(after.message).toContain("The 7 days to add a licence key ended");
    } finally {
      updateSettings({ onboardingComplete: false });
    }
  });

  test("GODMODE_LICENSE seeds the key, and leaves the environment", () => {
    process.env.GODMODE_LICENSE = ` ${KEY.toLowerCase()} `;
    initLicense();
    expect(process.env.GODMODE_LICENSE).toBeUndefined();
    expect(getMeta("license.key")).toBe(KEY);
    expect(licenseState().status).toBe("unverified");
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

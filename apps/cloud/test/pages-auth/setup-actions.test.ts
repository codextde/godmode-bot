import "./next-mocks";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { inputToMinor, minorToInput } from "@/app/setup/_lib/money";
import { accessMode, ownerStep } from "@/app/setup/_lib/steps";
import {
  claimAction,
  connectStripeAction,
  createInStripeAction,
  finishSetupAction,
  inviteTeammatesAction,
  saveAccessAction,
  saveCloudAction,
  saveEmailAction,
  setChargingAction,
  testEmailAction,
} from "@/app/setup/actions";
import { createSession, sessionCookieName, validateSessionToken } from "@/server/auth/sessions";
import { db, invites, users } from "@/server/db";
import { getSettings, getSettingsWithSecrets } from "@/server/settings";
import { bootstrapData, ensureSetupCode, finishSetup, setupGate } from "@/server/setup";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, makeUser } from "../platform/fixtures";
import { redirectOf, request } from "./next-mocks";

vi.mock("@/server/billing/stripe", () => ({
  checkStripeKey: vi.fn(async (key: string) =>
    key.startsWith("sk_test_good") ? { ok: true, livemode: false, accountName: "Solakon Test", defaultCurrency: "eur" } : { ok: false, error: "That is not a Stripe secret key. It starts with sk_ (or rk_ for a restricted key)." },
  ),
  ensureWebhook: vi.fn(async () => ({ ok: false, manual: true, error: "Stripe only sends events to https addresses, and this cloud runs at http://localhost:3210." })),
  syncPlanToStripe: vi.fn(async () => {}),
}));

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await bootstrapData();
  request.reset();
});
afterAll(closeDatabase);

/** Signs the pretend browser in as `ctx`. */
async function signIn(ctx: { user: { id: string } }): Promise<void> {
  const { token } = await createSession(ctx.user.id, { ip: "127.0.0.1", userAgent: null });
  request.cookies.set(sessionCookieName(), token);
}

const SMTP = { host: "smtp.example.com", port: 587, security: "starttls" as const, username: "u", password: "p", fromName: "Cloud", fromEmail: "cloud@example.com" };

describe("claimAction", () => {
  test("needs the configured address, the code and the fields; then signs the owner in", async () => {
    const code = (await ensureSetupCode())!;
    request.headers.set("host", "10.0.0.5:3000");
    const wrongHost = await claimAction({ code, email: "owner@example.com", name: "Owner" });
    expect(wrongHost).toMatchObject({ ok: false });
    expect((wrongHost as { error: string }).error).toContain("Open this page at http://localhost:3210");
    request.headers.set("host", "localhost:3210");
    expect(await claimAction({ code: "", email: "", name: "" })).toMatchObject({
      ok: false,
      fields: { code: "Enter the setup code.", email: "Enter your e-mail address.", name: "Enter your name." },
    });
    expect(await claimAction({ code: "AAAA-BBBB-CCCC", email: "owner@example.com", name: "Owner" })).toMatchObject({ ok: false, error: expect.stringContaining("not right") });
    expect(await redirectOf(() => claimAction({ code: code.toLowerCase(), email: "Owner@Example.com", name: " Owner " }))).toBe("/setup?step=cloud");
    const ctx = await validateSessionToken(request.cookies.get(sessionCookieName())!);
    expect(ctx?.user).toMatchObject({ email: "owner@example.com", name: "Owner", roleId: "role_owner" });
    expect(await setupGate()).toBe("wizard");
    expect(await claimAction({ code, email: "x@example.com", name: "X" })).toMatchObject({ ok: false });
  });
});

describe("step guards", () => {
  test("steps 2–6 need a signed-in owner while setup is unfinished", async () => {
    const cloud = { appName: "Solakon Cloud", supportEmail: "", termsUrl: "", privacyUrl: "", imprintUrl: "" };
    expect(await saveCloudAction(cloud)).toMatchObject({ ok: false, error: "Your session has ended. Sign in again." });
    const admin = await makeUser({ role: "admin" });
    await signIn(admin);
    expect(await saveCloudAction(cloud)).toMatchObject({ ok: false, error: "Only an owner can do this." });
    expect(await saveAccessAction({ mode: "open", domains: "", sessionDays: 30 }, true)).toMatchObject({ ok: false, error: "Only an owner can do this." });
    expect(await finishSetupAction()).toMatchObject({ ok: false, error: "Only an owner can do this." });
    const owner = await makeUser({ role: "owner" });
    await signIn(owner);
    expect(await saveCloudAction(cloud)).toEqual({ ok: true, data: undefined });
    expect((await getSettings("general")).appName).toBe("Solakon Cloud");
    await finishSetup(owner);
    expect(await saveCloudAction(cloud)).toMatchObject({ ok: false, error: expect.stringContaining("already finished") });
    expect(await testEmailAction(SMTP)).toMatchObject({ ok: false, error: expect.stringContaining("already finished") });
    expect(await setChargingAction(true)).toMatchObject({ ok: false, error: expect.stringContaining("already finished") });
  });

  test("ownerStep falls back to the first owner step", () => {
    expect(ownerStep("billing")).toBe("billing");
    expect(ownerStep("claim")).toBe("cloud");
    expect(ownerStep(undefined)).toBe("cloud");
    expect(ownerStep(["done"])).toBe("done");
    expect(ownerStep("nope")).toBe("cloud");
  });
});

describe("saveCloudAction", () => {
  test("validates like the settings page", async () => {
    await signIn(await makeUser({ role: "owner" }));
    const result = await saveCloudAction({ appName: "", supportEmail: "nope", termsUrl: "ftp://x", privacyUrl: "", imprintUrl: "" });
    expect(result).toMatchObject({ ok: false, fields: { appName: "Enter a name.", supportEmail: "Enter a valid e-mail address.", termsUrl: expect.stringContaining("https://") } });
  });
});

describe("e-mail step", () => {
  test("stores SMTP only after a test e-mail went out", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@example.com" });
    await signIn(owner);
    expect(await saveEmailAction({ ...SMTP, host: "" })).toMatchObject({ ok: false, fields: { host: "Enter the SMTP server." } });
    expect(await saveEmailAction({ ...SMTP, fromEmail: "" })).toMatchObject({ ok: false, fields: { fromEmail: expect.any(String) } });
    // Nothing listens on this port: the test fails and nothing is saved.
    const failed = await saveEmailAction({ ...SMTP, host: "127.0.0.1", port: 9 });
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("nothing was saved") });
    const stored = await getSettingsWithSecrets("email");
    expect(stored.transport).toBe("log");
    expect(stored.host).toBe("");
    expect((await getSettings("setup")).emailDone).toBe(false);
    const tested = await testEmailAction({ ...SMTP, host: "127.0.0.1", port: 9 });
    expect(tested).toMatchObject({ ok: false, error: expect.stringContaining("Could not send the test e-mail") });
  }, 30_000);
});

describe("access step", () => {
  test("maps the three choices to inviteOnly and allowedDomains", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@solakon.de" });
    await signIn(owner);
    expect(await saveAccessAction({ mode: "domains", domains: " ", sessionDays: 365 }, false)).toMatchObject({ ok: false, fields: { domains: expect.stringContaining("at least one domain") } });
    expect(await saveAccessAction({ mode: "domains", domains: "not a domain!", sessionDays: 365 }, false)).toMatchObject({ ok: false, fields: { domains: expect.any(String) } });
    expect(await saveAccessAction({ mode: "domains", domains: "solakon.de", sessionDays: 0 }, false)).toMatchObject({ ok: false, fields: { sessionDays: expect.stringContaining("1 to 400") } });

    expect(await saveAccessAction({ mode: "domains", domains: "Solakon.de, @example.com\nsolakon.de", sessionDays: 30 }, false)).toEqual({ ok: true, data: undefined });
    let auth = await getSettings("auth");
    expect(auth).toMatchObject({ inviteOnly: false, allowedDomains: ["solakon.de", "example.com"], sessionDays: 30 });
    expect(accessMode(auth)).toBe("domains");
    expect((await getSettings("setup")).accessDone).toBe(false);

    expect(await saveAccessAction({ mode: "invite", domains: "solakon.de", sessionDays: 365 }, true)).toEqual({ ok: true, data: undefined });
    auth = await getSettings("auth");
    expect(auth).toMatchObject({ inviteOnly: true, allowedDomains: ["solakon.de"], sessionDays: 365 });
    expect(accessMode(auth)).toBe("invite");
    expect((await getSettings("setup")).accessDone).toBe(true);

    expect(await saveAccessAction({ mode: "open", domains: "solakon.de", sessionDays: 365 }, true)).toEqual({ ok: true, data: undefined });
    auth = await getSettings("auth");
    expect(auth).toMatchObject({ inviteOnly: false, allowedDomains: [] });
    expect(accessMode(auth)).toBe("open");
  });

  test("invites teammates after saving the rules", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@solakon.de" });
    await signIn(owner);
    const access = { mode: "invite" as const, domains: "solakon.de", sessionDays: 365 };
    expect(await inviteTeammatesAction({ access, emails: "  ", roleId: "role_member" })).toMatchObject({ ok: false, fields: { emails: expect.any(String) } });
    const result = await inviteTeammatesAction({ access, emails: "anna@solakon.de\nben@elsewhere.org, broken", roleId: "role_member" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toHaveLength(1);
    expect(result.data.created[0]).toMatchObject({ email: "anna@solakon.de", emailed: false });
    expect(result.data.created[0]!.url).toMatch(/^http:\/\/localhost:3210\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(result.data.skipped.map((s) => s.email).sort()).toEqual(["ben@elsewhere.org", "broken"]);
    expect(result.data.skipped.find((s) => s.email === "ben@elsewhere.org")?.reason).toContain("solakon.de");
    expect((await getSettings("auth")).allowedDomains).toEqual(["solakon.de"]);
    expect(await db.select().from(invites)).toHaveLength(1);
    expect(await auditRows("invite.create")).toHaveLength(1);
  });
});

describe("billing step", () => {
  test("connects Stripe, creates the prices and products, then charging is a separate switch", async () => {
    const owner = await makeUser({ role: "owner" });
    await signIn(owner);
    expect(await connectStripeAction("")).toMatchObject({ ok: false, fields: { key: "Enter the secret key." } });
    expect(await connectStripeAction("pk_test_nope")).toMatchObject({ ok: false, error: expect.stringContaining("not a Stripe secret key") });
    expect(await setChargingAction(true)).toMatchObject({ ok: false, error: "Connect Stripe before turning billing on." });
    expect(await connectStripeAction(" sk_test_good_123 ")).toEqual({ ok: true, data: { accountName: "Solakon Test", livemode: false } });
    const billing = await getSettingsWithSecrets("billing");
    expect(billing).toMatchObject({ stripeSecretKey: "sk_test_good_123", currency: "eur", enabled: false });

    const { listPlans } = await import("@/server/billing/plans");
    const paid = (await listPlans()).find((p) => !p.isFree)!;
    expect(await createInStripeAction({ currency: "xx", prices: [] })).toMatchObject({ ok: false, fields: { currency: expect.any(String) } });
    expect(await createInStripeAction({ currency: "eur", prices: [{ planId: paid.id, month: "abc", year: "" }] })).toMatchObject({
      ok: false,
      fields: { [`${paid.id}.month`]: "Enter an amount like 10.00." },
    });
    const created = await createInStripeAction({ currency: "eur", prices: [{ planId: paid.id, month: "12,50", year: "120" }] });
    expect(created).toMatchObject({ ok: true, data: { webhookProblem: expect.stringContaining("https") } });
    const after = (await listPlans()).find((p) => p.id === paid.id)!;
    expect(after.prices.map((p) => [p.interval, p.amount, p.currency])).toEqual([
      ["month", 1250, "eur"],
      ["year", 12000, "eur"],
    ]);
    const { syncPlanToStripe, ensureWebhook } = await import("@/server/billing/stripe");
    expect(syncPlanToStripe).toHaveBeenCalledWith(paid.id, expect.anything());
    expect(ensureWebhook).toHaveBeenCalledTimes(1);
    expect((await getSettings("setup")).billingDone).toBe(true);

    expect(await setChargingAction(true)).toEqual({ ok: true, data: undefined });
    expect((await getSettings("billing")).enabled).toBe(true);
    expect(await setChargingAction(false)).toEqual({ ok: true, data: undefined });
    expect((await getSettings("billing")).enabled).toBe(false);
    expect(await auditRows("billing.enable")).toHaveLength(2);
  });

  test("money helpers", () => {
    expect(minorToInput(1000, "eur")).toBe("10.00");
    expect(minorToInput(1250, "usd")).toBe("12.50");
    expect(minorToInput(1000, "jpy")).toBe("1000");
    expect(inputToMinor("10", "eur")).toBe(1000);
    expect(inputToMinor("10.5", "eur")).toBe(1050);
    expect(inputToMinor("10,50", "eur")).toBe(1050);
    expect(inputToMinor("10.555", "eur")).toBeNull();
    expect(inputToMinor("1000", "jpy")).toBe(1000);
    expect(inputToMinor("10.5", "jpy")).toBeNull();
    expect(inputToMinor("-3", "eur")).toBeNull();
    expect(inputToMinor("", "eur")).toBeNull();
  });
});

describe("finishSetupAction", () => {
  test("marks setup complete and opens the start page", async () => {
    const owner = await makeUser({ role: "owner" });
    await signIn(owner);
    expect(await redirectOf(() => finishSetupAction())).toBe("/");
    expect(await setupGate()).toBe("done");
    expect(await auditRows("setup.finish")).toHaveLength(1);
    expect((await db.select().from(users).where(eq(users.id, owner.user.id)))[0]?.roleId).toBe("role_owner");
  });
});

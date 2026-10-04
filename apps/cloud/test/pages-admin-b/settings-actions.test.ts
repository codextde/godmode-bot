import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  saveAuthAction,
  saveBillingOptionsAction,
  saveEmailAction,
  saveGeneralAction,
  saveRelayAction,
  saveSecurityAction,
  saveStripeKeyAction,
  saveWebhookSecretAction,
  setBillingEnabledAction,
  signEveryoneOutAction,
} from "@/app/(app)/admin/settings/actions";
import { countActiveSessions } from "@/server/auth/sessions";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { getSettings, getSettingsWithSecrets, SETTINGS_DEFAULTS } from "@/server/settings";
import { fakeStripe } from "../billing/helpers";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { makeUser, seed } from "../platform/fixtures";
import { closedPort, fakeSmtp, type SessionState } from "./helpers";

const session = vi.hoisted((): SessionState => ({ ctx: null }));
vi.mock("@/lib/session", async () => (await import("./helpers")).sessionModule(session));
const signIn = (ctx: SessionState["ctx"]) => {
  session.ctx = ctx;
};

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterEach(() => {
  signIn(null);
  setStripeClientForTests(null);
  vi.restoreAllMocks();
});
afterAll(closeDatabase);

const general = () => ({ ...SETTINGS_DEFAULTS.general });

describe("permissions per group", () => {
  test("signed out: every action answers with the session error", async () => {
    const result = await saveGeneralAction(general());
    expect(result).toEqual({ ok: false, error: "Your session has ended. Sign in again." });
  });

  test("general and relay need settings.manage: admin yes, billing role no", async () => {
    signIn(await makeUser({ role: "admin" }));
    expect((await saveGeneralAction({ ...general(), appName: "Codext Cloud" })).ok).toBe(true);
    expect((await saveRelayAction({ ...SETTINGS_DEFAULTS.relay, maxBodyMb: 32 })).ok).toBe(true);

    signIn(await makeUser({ role: "billing" }));
    const refused = await saveGeneralAction({ ...general(), appName: "Nope" });
    expect(refused).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect((await saveRelayAction(SETTINGS_DEFAULTS.relay)).ok).toBe(false);
    expect((await getSettings("general")).appName).toBe("Codext Cloud");
  });

  test("sign-in, e-mail and security are owner-only: an admin is refused", async () => {
    signIn(await makeUser({ role: "admin" }));
    const auth = await saveAuthAction({ access: "open", allowedDomains: [], defaultRoleKey: "member", sessionDays: 30, magicLinkMinutes: 15, codeLogin: true, inviteDays: 14 });
    expect(auth).toEqual({ ok: false, error: "Only an owner can do this." });
    expect((await saveEmailAction(SETTINGS_DEFAULTS.email)).ok).toBe(false);
    expect((await saveSecurityAction(SETTINGS_DEFAULTS.security)).ok).toBe(false);
    expect((await signEveryoneOutAction()).ok).toBe(false);
    expect((await getSettings("auth")).inviteOnly).toBe(true);
  });

  test("billing settings need billing.manage: billing role yes, admin no", async () => {
    signIn(await makeUser({ role: "admin" }));
    expect((await saveBillingOptionsAction({ ...SETTINGS_DEFAULTS.billing, trialDays: 7 })).ok).toBe(false);
    expect((await setBillingEnabledAction(true)).ok).toBe(false);
    expect((await saveStripeKeyAction("sk_test_x")).ok).toBe(false);

    signIn(await makeUser({ role: "billing" }));
    const saved = await saveBillingOptionsAction({ ...SETTINGS_DEFAULTS.billing, trialDays: 7, currency: "EUR" });
    expect(saved.ok).toBe(true);
    expect((await getSettings("billing"))).toMatchObject({ trialDays: 7, currency: "eur" });
  });
});

describe("validation comes back per field", () => {
  test("general: an empty name and a bad URL", async () => {
    signIn(await makeUser({ role: "owner" }));
    const result = await saveGeneralAction({ ...general(), appName: "  ", termsUrl: "not a url" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fields).toMatchObject({ appName: "Enter a name.", termsUrl: expect.stringContaining("https://") });
  });

  test("relay: an emptied number is not zero", async () => {
    signIn(await makeUser({ role: "owner" }));
    const result = await saveRelayAction({ ...SETTINGS_DEFAULTS.relay, maxBodyMb: Number.NaN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fields?.maxBodyMb).toMatch(/whole number from 1 to 2048/);
    expect((await getSettings("relay")).maxBodyMb).toBe(64);
  });
});

describe("sign-in & access", () => {
  test("the three choices map to inviteOnly and allowedDomains", async () => {
    signIn(await makeUser({ role: "owner" }));
    const base = { defaultRoleKey: "member", sessionDays: 400, magicLinkMinutes: 10, codeLogin: false, inviteDays: 30 };

    const domains = await saveAuthAction({ ...base, access: "domains", allowedDomains: ["@Solakon.DE", "example.com", "solakon.de"] });
    expect(domains.ok).toBe(true);
    if (!domains.ok) return;
    expect(domains.data).toMatchObject({ inviteOnly: false, allowedDomains: ["solakon.de", "example.com"], sessionDays: 400, codeLogin: false });

    const open = await saveAuthAction({ ...base, access: "open", allowedDomains: ["solakon.de"] });
    expect(open.ok && open.data.allowedDomains).toEqual([]);
    expect(open.ok && open.data.inviteOnly).toBe(false);

    const invite = await saveAuthAction({ ...base, access: "invite", allowedDomains: ["solakon.de"] });
    expect(invite.ok && invite.data).toMatchObject({ inviteOnly: true, allowedDomains: ["solakon.de"] });
  });

  test("“anyone at these domains” needs a domain, and domains must look like one", async () => {
    signIn(await makeUser({ role: "owner" }));
    const base = { defaultRoleKey: "member", sessionDays: 365, magicLinkMinutes: 15, codeLogin: true, inviteDays: 14 };
    const none = await saveAuthAction({ ...base, access: "domains", allowedDomains: [] });
    expect(!none.ok && none.fields).toEqual({ allowedDomains: "Add at least one domain, or choose another option." });
    const bad = await saveAuthAction({ ...base, access: "domains", allowedDomains: ["not a domain"] });
    expect(!bad.ok && bad.fields?.allowedDomains).toMatch(/not a domain/);
    const admin = await saveAuthAction({ ...base, access: "open", allowedDomains: [], defaultRoleKey: "admin" });
    expect(!admin.ok && admin.error).toMatch(/without access to the admin area/);
  });
});

describe("e-mail: test and save", () => {
  const smtp = (port: number) => ({
    transport: "smtp" as const,
    host: "127.0.0.1",
    port,
    security: "none" as const,
    username: "",
    password: "",
    fromName: "",
    fromEmail: "cloud@example.com",
    replyTo: "",
  });

  test("nothing is stored when the test e-mail fails", async () => {
    signIn(await makeUser({ role: "owner" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await saveEmailAction(smtp(await closedPort()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^Could not send the test e-mail, so nothing was saved\./);
    const stored = await getSettings("email");
    expect(stored.transport).toBe("log");
    expect(stored.host).toBe("");
  });

  test("switching to SMTP is stored after the test message went out, to the owner saving", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@example.com" });
    signIn(owner);
    const { server, port, messages } = await fakeSmtp();
    try {
      const result = await saveEmailAction({ ...smtp(port), password: "s3cret" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.testedTo).toBe("owner@example.com");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Test e-mail from");
      // Redacted: the password never comes back, only that one is stored.
      expect(result.data.settings.password).toBe("");
      expect(result.data.settings.passwordSet).toBe(true);
      expect(JSON.stringify(result)).not.toContain("s3cret");
      expect(await getSettingsWithSecrets("email")).toMatchObject({ transport: "smtp", password: "s3cret", port });
    } finally {
      server.close();
    }
  });

  test("the server log transport saves without a test and needs no server", async () => {
    signIn(await makeUser({ role: "owner" }));
    const result = await saveEmailAction({ ...SETTINGS_DEFAULTS.email, fromName: "Codext" });
    expect(result.ok && result.data.testedTo).toBeNull();
    expect((await getSettings("email")).fromName).toBe("Codext");
  });

  test("SMTP without a server or sender is refused on those fields", async () => {
    signIn(await makeUser({ role: "owner" }));
    const result = await saveEmailAction({ ...smtp(25), host: "", fromEmail: "" });
    expect(!result.ok && result.fields).toEqual({ host: "Enter the SMTP server." });
  });
});

describe("billing: Stripe key, webhook secret, charging", () => {
  test("a key that is not a Stripe key fails before any network call and stores nothing", async () => {
    signIn(await makeUser({ role: "billing" }));
    const result = await saveStripeKeyAction("not-a-key");
    expect(!result.ok && result.fields?.stripeSecretKey).toMatch(/not a Stripe secret key/);
    expect((await getSettings("billing")).stripeSecretKeySet).toBe(false);
  });

  test("a key Stripe rejects is reported calmly and not stored", async () => {
    signIn(await makeUser({ role: "billing" }));
    const stripe = fakeStripe();
    stripe.fail.set("accounts.retrieveCurrent", new Stripe.errors.StripeAuthenticationError({ message: "Invalid API Key provided", type: "invalid_request_error" }));
    stripe.install();
    const result = await saveStripeKeyAction("sk_test_wrong");
    expect(!result.ok && result.fields?.stripeSecretKey).toBe("Stripe did not accept the secret key. Check it under Settings → Billing.");
    expect((await getSettings("billing")).stripeSecretKeySet).toBe(false);
  });

  test("an accepted key is stored encrypted; the answer carries mode and account, never the key", async () => {
    signIn(await makeUser({ role: "billing" }));
    fakeStripe().install();
    const result = await saveStripeKeyAction("sk_live_good");
    expect(result).toEqual({ ok: true, data: { livemode: true, accountName: "Codext GmbH", defaultCurrency: "eur" } });
    const stored = await getSettings("billing");
    expect(stored).toMatchObject({ stripeSecretKeySet: true, stripeSecretKey: "", livemode: true, stripeAccountName: "Codext GmbH" });
    expect((await getSettingsWithSecrets("billing")).stripeSecretKey).toBe("sk_live_good");
  });

  test("turning billing on needs a connected Stripe; off works any time", async () => {
    signIn(await makeUser({ role: "billing" }));
    expect(await setBillingEnabledAction(true)).toEqual({ ok: false, error: "Connect Stripe before turning billing on." });
    fakeStripe().install();
    await saveStripeKeyAction("sk_test_good");
    expect(await setBillingEnabledAction(true)).toEqual({ ok: true, data: { enabled: true } });
    expect(await setBillingEnabledAction(false)).toEqual({ ok: true, data: { enabled: false } });
  });

  test("a hand-made webhook secret must look like one and never comes back", async () => {
    signIn(await makeUser({ role: "billing" }));
    const bad = await saveWebhookSecretAction("sk_test_oops");
    expect(!bad.ok && bad.fields).toEqual({ webhookSecret: "That is not a signing secret. It starts with whsec_." });
    const good = await saveWebhookSecretAction("whsec_abc123");
    expect(good).toEqual({ ok: true, data: { webhookSecretSet: true } });
    const stored = await getSettings("billing");
    expect(stored.webhookSecret).toBe("");
    expect(stored.webhookSecretSet).toBe(true);
    expect((await getSettingsWithSecrets("billing")).webhookSecret).toBe("whsec_abc123");
  });
});

describe("security", () => {
  test("sign everyone out keeps the caller's own session", async () => {
    const owner = await makeUser({ role: "owner" });
    await makeUser({ role: "member" });
    await makeUser({ role: "admin" });
    expect(await countActiveSessions()).toBe(3);
    signIn(owner);
    expect(await signEveryoneOutAction()).toEqual({ ok: true, data: { count: 2 } });
    expect(await countActiveSessions()).toBe(1);
  });

  test("owners can change limits and proxy hops within the ranges", async () => {
    signIn(await makeUser({ role: "owner" }));
    const ok = await saveSecurityAction({ loginPerEmail: 10, loginPerIp: 50, auditRetentionDays: 0, trustProxy: false, trustedProxyHops: 2 });
    expect(ok.ok && ok.data).toMatchObject({ loginPerEmail: 10, trustProxy: false, trustedProxyHops: 2 });
    const bad = await saveSecurityAction({ ...SETTINGS_DEFAULTS.security, trustedProxyHops: 9 });
    expect(!bad.ok && bad.fields?.trustedProxyHops).toMatch(/1 to 5/);
  });
});

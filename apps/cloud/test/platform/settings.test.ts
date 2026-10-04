import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ZodError } from "zod";
import { SYSTEM } from "@/server/audit";
import { listSessions } from "@/server/auth/sessions";
import { encryptSecret } from "@/server/crypto";
import { db, settings } from "@/server/db";
import { clientIp } from "@/server/ratelimit";
import {
  clearSettingsCache,
  getSettings,
  getSettingsWithSecrets,
  SETTINGS_DEFAULTS,
  updateSettings,
  updateSetupState,
  writeSettings,
} from "@/server/settings";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, makeUser, seed } from "./fixtures";

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterAll(closeDatabase);

const SMTP = { transport: "smtp" as const, host: "email-smtp.eu-central-1.amazonaws.com", fromEmail: "cloud@example.com", username: "AKIA" };

describe("reading", () => {
  test("defaults when nothing is stored", async () => {
    await db.delete(settings);
    clearSettingsCache();
    expect(await getSettingsWithSecrets("auth")).toEqual(SETTINGS_DEFAULTS.auth);
  });

  test("stored values that no longer validate fall back to their defaults", async () => {
    await db.update(settings).set({ value: { sessionDays: 9000, inviteOnly: false, unknown: 1 } }).where(eq(settings.key, "auth"));
    clearSettingsCache();
    const auth = await getSettingsWithSecrets("auth");
    expect(auth.sessionDays).toBe(365);
    expect(auth.inviteOnly).toBe(false);
    expect("unknown" in auth).toBe(false);
  });
});

describe("secrets", () => {
  test("are stored encrypted, decrypted for the server and redacted for pages", async () => {
    await writeSettings("email", { ...SMTP, password: "s3cret-pass" }, SYSTEM);
    const [row] = await db.select().from(settings).where(eq(settings.key, "email"));
    expect(JSON.stringify(row!.value)).not.toContain("s3cret-pass");
    expect((row!.value.password as { $enc: string }).$enc).toMatch(/^v1\./);
    expect((await getSettingsWithSecrets("email")).password).toBe("s3cret-pass");
    const redacted = await getSettings("email");
    expect(redacted.password).toBe("");
    expect(redacted.passwordSet).toBe(true);
    expect(redacted.host).toBe(SMTP.host);
  });

  test("an empty secret keeps the stored one, null removes it", async () => {
    await writeSettings("billing", { stripeSecretKey: "sk_test_123", webhookSecret: "whsec_1" }, SYSTEM);
    await writeSettings("billing", { stripeSecretKey: "", currency: "EUR" }, SYSTEM);
    const kept = await getSettingsWithSecrets("billing");
    expect(kept.stripeSecretKey).toBe("sk_test_123");
    expect(kept.currency).toBe("eur");
    await writeSettings("billing", { stripeSecretKey: null }, SYSTEM);
    const redacted = await getSettings("billing");
    expect(redacted.stripeSecretKeySet).toBe(false);
    expect(redacted.webhookSecretSet).toBe(true);
  });

  test("a secret sealed with another key reads as not set", async () => {
    const value = { ...SETTINGS_DEFAULTS.email, password: { $enc: "v1.AAAA.BBBB.CCCC" } };
    await db.update(settings).set({ value }).where(eq(settings.key, "email"));
    clearSettingsCache();
    expect((await getSettings("email")).passwordSet).toBe(false);
    // A real one still works.
    await db.update(settings).set({ value: { ...value, password: { $enc: encryptSecret("ok") } } }).where(eq(settings.key, "email"));
    clearSettingsCache();
    expect((await getSettingsWithSecrets("email")).password).toBe("ok");
  });

  test("the audit entry names changed fields, never values", async () => {
    await writeSettings("email", { ...SMTP, password: "s3cret-pass" }, SYSTEM);
    const [entry] = await auditRows("settings.update");
    expect(entry!.meta).toEqual({ group: "email", fields: ["transport", "host", "username", "password", "fromEmail"] });
    expect(JSON.stringify(entry)).not.toContain("s3cret-pass");
  });
});

describe("who may change what", () => {
  test("per group", async () => {
    const owner = await makeUser({ role: "owner" });
    const admin = await makeUser({ role: "admin" });
    const billing = await makeUser({ role: "billing" });
    const member = await makeUser();
    await expect(updateSettings("general", { appName: "Acme Cloud" }, admin)).resolves.toMatchObject({ appName: "Acme Cloud" });
    await expect(updateSettings("relay", { maxBodyMb: 128 }, admin)).resolves.toMatchObject({ maxBodyMb: 128 });
    for (const group of ["billing", "auth", "email", "security"] as const) {
      await expect(updateSettings(group, {}, admin)).rejects.toMatchObject({ status: 403 });
    }
    await expect(updateSettings("billing", { trialDays: 7 }, billing)).resolves.toMatchObject({ trialDays: 7 });
    await expect(updateSettings("general", { appName: "Nope" }, billing)).rejects.toMatchObject({ status: 403 });
    await expect(updateSettings("general", { appName: "Nope" }, member)).rejects.toMatchObject({ status: 403 });
    await expect(updateSettings("setup", { completedAt: "now" }, owner)).rejects.toMatchObject({ status: 403 });
    for (const group of ["auth", "email", "security", "billing", "general", "relay"] as const) {
      await expect(updateSettings(group, {}, owner)).resolves.toBeDefined();
    }
  });

  test("updateSettings never returns secrets", async () => {
    const owner = await makeUser({ role: "owner" });
    const result = await updateSettings("email", { ...SMTP, password: "pw-123" }, owner);
    expect(result.password).toBe("");
    expect(result.passwordSet).toBe(true);
  });
});

describe("validation", () => {
  test("allowed domains are lower-cased, without @ and de-duplicated", async () => {
    const auth = await writeSettings("auth", { allowedDomains: ["@Solakon.DE", " solakon.de ", "Example.com", ""] }, SYSTEM);
    expect(auth.allowedDomains).toEqual(["solakon.de", "example.com"]);
    await expect(writeSettings("auth", { allowedDomains: ["not a domain"] }, SYSTEM)).rejects.toBeInstanceOf(ZodError);
    await expect(writeSettings("auth", { allowedDomains: ["*.solakon.de"] }, SYSTEM)).rejects.toBeInstanceOf(ZodError);
  });

  test("ranges", async () => {
    await expect(writeSettings("auth", { sessionDays: 401 }, SYSTEM)).rejects.toBeInstanceOf(ZodError);
    await expect(writeSettings("auth", { inviteDays: 0 }, SYSTEM)).rejects.toBeInstanceOf(ZodError);
    await expect(writeSettings("security", { trustedProxyHops: 6 }, SYSTEM)).rejects.toBeInstanceOf(ZodError);
    await expect(writeSettings("general", { termsUrl: "javascript:alert(1)" }, SYSTEM)).rejects.toBeInstanceOf(ZodError);
    await expect(writeSettings("auth", { sessionDays: 400, inviteDays: 90 }, SYSTEM)).resolves.toMatchObject({ sessionDays: 400 });
  });

  test("the default role must not open the admin area", async () => {
    await expect(writeSettings("auth", { defaultRoleKey: "owner" }, SYSTEM)).rejects.toMatchObject({ status: 400 });
    await expect(writeSettings("auth", { defaultRoleKey: "admin" }, SYSTEM)).rejects.toMatchObject({ status: 400 });
    await expect(writeSettings("auth", { defaultRoleKey: "nope" }, SYSTEM)).rejects.toMatchObject({ status: 400 });
    await expect(writeSettings("auth", { defaultRoleKey: "member" }, SYSTEM)).resolves.toMatchObject({ defaultRoleKey: "member" });
  });

  test("terms consent needs a terms link", async () => {
    await expect(writeSettings("billing", { requireTermsConsent: true }, SYSTEM)).rejects.toMatchObject({ status: 400 });
    await writeSettings("general", { termsUrl: "https://example.com/terms" }, SYSTEM);
    await expect(writeSettings("billing", { requireTermsConsent: true }, SYSTEM)).resolves.toMatchObject({ requireTermsConsent: true });
  });

  test("SMTP needs a server and a sender", async () => {
    await expect(writeSettings("email", { transport: "smtp" }, SYSTEM)).rejects.toMatchObject({ status: 400 });
  });

  test("a save without changes writes no audit entry", async () => {
    await writeSettings("general", { appName: "Godmode Cloud" }, SYSTEM);
    expect(await auditRows("settings.update")).toHaveLength(0);
  });

  test("setup state is internal and not audited", async () => {
    await updateSetupState({ emailDone: true });
    expect((await getSettings("setup")).emailDone).toBe(true);
    expect(await auditRows("settings.update")).toHaveLength(0);
  });
});

describe("effects of a save", () => {
  test("removing a domain signs out its non-owners", async () => {
    const owner = await makeUser({ role: "owner", email: "boss@gmail.com" });
    const inside = await makeUser({ email: "a@solakon.de" });
    const outside = await makeUser({ email: "b@gmail.com" });
    await updateSettings("auth", { allowedDomains: ["solakon.de"] }, owner);
    expect(await listSessions(outside.user.id)).toHaveLength(0);
    expect(await listSessions(inside.user.id)).toHaveLength(1);
    expect(await listSessions(owner.user.id)).toHaveLength(1);
    const [entry] = await auditRows("settings.update");
    expect(entry!.meta).toEqual({ group: "auth", fields: ["allowedDomains"], sessionsRevoked: 1 });
  });

  test("an empty domain list signs nobody out", async () => {
    const outside = await makeUser({ email: "b@gmail.com" });
    await writeSettings("auth", { allowedDomains: [] , inviteOnly: false }, SYSTEM);
    expect(await listSessions(outside.user.id)).toHaveLength(1);
  });

  test("the cache is cleared on write", async () => {
    expect((await getSettings("general")).appName).toBe("Godmode Cloud");
    await writeSettings("general", { appName: "Acme" }, SYSTEM);
    expect((await getSettings("general")).appName).toBe("Acme");
  });

  test("the proxy trust flag follows the security settings", async () => {
    const h = { get: (n: string) => (n === "x-forwarded-for" ? "198.51.100.7" : null) };
    await getSettings("security");
    expect(clientIp(h, "172.18.0.2")).toBe("198.51.100.7");
    await writeSettings("security", { trustProxy: false }, SYSTEM);
    expect(clientIp(h, "172.18.0.2")).toBe("172.18.0.2");
  });
});

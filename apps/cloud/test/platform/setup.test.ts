import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { validateSessionToken } from "@/server/auth/sessions";
import { ensureDefaultPlans } from "@/server/billing/plans";
import { config } from "@/server/config";
import { db, pool, roles, settings, users } from "@/server/db";
import { getSettingsWithSecrets } from "@/server/settings";
import {
  bootstrapData,
  claimSetup,
  ensureSetupCode,
  finishSetup,
  isSetupComplete,
  markSetupStep,
  publicUrlCheck,
  setupGate,
  setupStartedBy,
} from "@/server/setup";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, makeUser, META } from "./fixtures";

vi.mock("@/server/billing/plans", () => ({ ensureDefaultPlans: vi.fn(async () => {}) }));

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await bootstrapData();
});
afterAll(closeDatabase);

const codeFile = () => path.join(config().dataDir, "setup-code.txt");

describe("bootstrapData", () => {
  test("seeds roles, settings and plans, and can run again", async () => {
    await bootstrapData();
    expect((await db.select().from(roles)).map((r) => r.key).sort()).toEqual(["admin", "billing", "member", "owner"]);
    expect(await db.select().from(settings)).toHaveLength(7);
    expect(ensureDefaultPlans).toHaveBeenCalled();
  });
});

describe("setup code", () => {
  test("is created only while nobody has an account", async () => {
    const code = await ensureSetupCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(readFileSync(codeFile(), "utf8").trim()).toBe(code);
    expect(statSync(codeFile()).mode & 0o777).toBe(0o600);
    const { codeHash } = await getSettingsWithSecrets("setup");
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash).not.toContain(code!);
    await makeUser({ role: "owner" });
    expect(await ensureSetupCode()).toBeNull();
    expect(existsSync(codeFile())).toBe(false);
    expect((await getSettingsWithSecrets("setup")).codeHash).toBeNull();
  });

  test("a new code replaces the old one", async () => {
    const first = await ensureSetupCode();
    await ensureSetupCode();
    await expect(claimSetup({ code: first!, email: "o@example.com", name: "O" }, META)).rejects.toMatchObject({ code: "wrong_setup_code" });
  });
});

describe("claimSetup", () => {
  test("needs the code, creates the owner and signs them in, once", async () => {
    const code = await ensureSetupCode();
    expect(await setupGate()).toBe("claim");
    await expect(claimSetup({ code: "AAAA-BBBB-CCCC", email: "o@example.com", name: "Owner" }, META)).rejects.toMatchObject({ code: "wrong_setup_code" });
    await expect(claimSetup({ code: "", email: "o@example.com", name: "Owner" }, META)).rejects.toMatchObject({ code: "wrong_setup_code" });
    const typed = code!.toLowerCase().replace(/-/g, " ");
    const result = await claimSetup({ code: typed, email: "Owner@Example.com", name: "Owner" }, META);
    expect(result.user).toMatchObject({ email: "owner@example.com", roleId: "role_owner", name: "Owner" });
    expect((await validateSessionToken(result.sessionToken))?.role.key).toBe("owner");
    expect((await getSettingsWithSecrets("setup")).codeHash).toBeNull();
    expect(existsSync(codeFile())).toBe(false);
    expect(await setupGate()).toBe("wizard");
    expect(await setupStartedBy()).toBe("o••••@example.com");
    await expect(claimSetup({ code: code!, email: "x@example.com", name: "X" }, META)).rejects.toMatchObject({ status: 409 });
    expect(await auditRows("setup.claim")).toHaveLength(1);
  });

  test("claims at the same moment give exactly one owner", async () => {
    const code = (await ensureSetupCode())!;
    // Lock the users table from another connection so every claim is waiting at the same point, then let go.
    const blocker = await pool().connect();
    await blocker.query("begin");
    await blocker.query("lock table users in access exclusive mode");
    const pending = Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => claimSetup({ code, email: `o${n}@example.com`, name: `O${n}` }, { ...META, ip: `198.51.100.${n}` })),
    );
    await new Promise((r) => setTimeout(r, 150));
    await blocker.query("commit");
    blocker.release();
    const results = await pending;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.roleId, "role_owner"))).toHaveLength(1);
  });

  test("is rate limited per address", async () => {
    await ensureSetupCode();
    for (let i = 0; i < 10; i++) {
      await expect(claimSetup({ code: "AAAA-BBBB-CCCC", email: "o@example.com", name: "O" }, META)).rejects.toMatchObject({ status: 400 });
    }
    await expect(claimSetup({ code: "AAAA-BBBB-CCCC", email: "o@example.com", name: "O" }, META)).rejects.toMatchObject({ status: 429 });
  });
});

describe("wizard steps", () => {
  test("need an owner", async () => {
    const owner = await makeUser({ role: "owner" });
    const admin = await makeUser({ role: "admin" });
    await expect(markSetupStep("email", admin)).rejects.toMatchObject({ status: 403 });
    await expect(finishSetup(admin)).rejects.toMatchObject({ status: 403 });
    await markSetupStep("email", owner);
    await markSetupStep("billing", owner);
    const state = await getSettingsWithSecrets("setup");
    expect(state).toMatchObject({ emailDone: true, accessDone: false, billingDone: true, completedAt: null });
    expect(await isSetupComplete()).toBe(false);
    await finishSetup(owner);
    expect(await isSetupComplete()).toBe(true);
    expect(await setupGate()).toBe("done");
    expect(await auditRows("setup.finish")).toHaveLength(1);
  });
});

describe("publicUrlCheck", () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });

  test("compares the address the request came in on", () => {
    expect(publicUrlCheck(headers({ host: "localhost:3210" }))).toEqual({
      ok: true,
      requestOrigin: "http://localhost:3210",
      publicUrl: "http://localhost:3210",
      configured: true,
      https: false,
    });
    expect(publicUrlCheck(headers({ "x-forwarded-proto": "https", "x-forwarded-host": "cloud-abc.sslip.io", host: "10.0.0.5:3000" }))).toMatchObject({
      ok: false,
      requestOrigin: "https://cloud-abc.sslip.io",
    });
    expect(publicUrlCheck(headers({ host: "127.0.0.1:3210" })).ok).toBe(false);
    expect(publicUrlCheck(headers({})).ok).toBe(false);
  });
});

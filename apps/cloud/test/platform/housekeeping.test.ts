import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SYSTEM, audit, AUDIT_ACTIONS, listAudit, pruneAudit } from "@/server/audit";
import { newId } from "@/server/crypto";
import { auditLog, db, linkRequests, loginTokens, sessions, stripeEvents } from "@/server/db";
import { runHousekeeping } from "@/server/housekeeping";
import { registerRelayHub, type RelayHubApi } from "@/server/relay-bridge";
import { writeSettings } from "@/server/settings";
import { getSystemStatus } from "@/server/system";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { makeUser, seed } from "./fixtures";
import pkg from "../../package.json";

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterEach(() => registerRelayHub(null));
afterAll(closeDatabase);

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

describe("runHousekeeping", () => {
  test("deletes what is old enough and keeps the rest", async () => {
    const { user, session: current } = await makeUser();
    const login = (id: string, expiresAt: Date) => ({ id, email: "a@example.com", tokenHash: id, expiresAt });
    await db.insert(loginTokens).values([login("lgn_old", ago(2)), login("lgn_recent", ago(0.5)), login("lgn_live", ago(-0.01))]);
    const link = (id: string, expiresAt: Date) => ({ id, userCode: id, secretHash: "x", instanceId: "gm_1", name: "Mac", expiresAt });
    await db.insert(linkRequests).values([link("lnk_old", ago(2)), link("lnk_recent", ago(0.5))]);
    const session = (id: string, expiresAt: Date, revokedAt: Date | null) => ({ id, userId: user.id, tokenHash: id, expiresAt, revokedAt });
    await db.insert(sessions).values([
      session("ses_expired_long", ago(31), null),
      session("ses_revoked_long", ago(-300), ago(31)),
      session("ses_revoked_recent", ago(-300), ago(1)),
      session("ses_expired_recent", ago(1), null),
    ]);
    await db.insert(stripeEvents).values([
      { id: "evt_old", type: "invoice.paid", receivedAt: ago(31) },
      { id: "evt_new", type: "invoice.paid", receivedAt: ago(1) },
    ]);
    await db.insert(auditLog).values([
      { actor: "system", action: "logout", at: ago(400) },
      { actor: "system", action: "logout", at: ago(10) },
    ]);
    await runHousekeeping();
    expect((await db.select().from(loginTokens)).map((r) => r.id).sort()).toEqual(["lgn_live", "lgn_recent"]);
    expect((await db.select().from(linkRequests)).map((r) => r.id)).toEqual(["lnk_recent"]);
    expect((await db.select().from(sessions)).map((r) => r.id).sort()).toEqual([current.id, "ses_expired_recent", "ses_revoked_recent"].sort());
    expect((await db.select().from(stripeEvents)).map((r) => r.id)).toEqual(["evt_new"]);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  test("audit retention 0 keeps everything", async () => {
    await writeSettings("security", { auditRetentionDays: 0 }, SYSTEM);
    await db.insert(auditLog).values({ actor: "system", action: "logout", at: ago(4000) });
    expect(await pruneAudit()).toBe(0);
    await writeSettings("security", { auditRetentionDays: 30 }, SYSTEM);
    expect(await pruneAudit()).toBe(1);
  });
});

describe("audit", () => {
  test("lists with filters and search, newest first", async () => {
    const actor = { id: "usr_a", label: "alice@example.com", ip: "203.0.113.1" };
    await audit(actor, "user.role", { type: "user", id: "usr_b" }, { from: "role_member", to: "role_admin" });
    await audit(actor, "invite.create", { type: "invite", id: "inv_1" });
    await audit(SYSTEM, "mail.failed", null, { kind: "login" });
    expect((await listAudit({})).total).toBe(3);
    expect((await listAudit({})).rows[0]!.action).toBe("mail.failed");
    expect((await listAudit({ action: "user.role" })).rows[0]!.ip).toBe("203.0.113.1");
    expect((await listAudit({ actorId: "usr_a" })).total).toBe(2);
    expect((await listAudit({ targetId: "usr_b" })).total).toBe(1);
    expect((await listAudit({ search: "ALICE" })).total).toBe(2);
    expect((await listAudit({ search: "100%" })).total).toBe(0);
    expect((await listAudit({ pageSize: 2, page: 2 })).rows).toHaveLength(1);
  });

  test("never throws and names every action once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(audit({ id: null, label: "x".repeat(10) }, "made.up", { type: "x", id: "y" }, { big: 1n as unknown as number })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
    const names = AUDIT_ACTIONS.map((a) => a.action);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("login.denied");
    expect(names).toContain("billing.webhook");
  });
});

describe("getSystemStatus", () => {
  test("reports each part", async () => {
    const hub = {
      isOnline: () => false,
      info: () => null,
      online: () => [],
      disconnect: () => {},
      notify: () => {},
      notifyUser: () => {},
      stats: () => ({ links: 3, streams: 7, sockets: 1, bytesIn: 0, bytesOut: 0, startedAt: new Date().toISOString() }),
    } satisfies RelayHubApi;
    registerRelayHub(hub);
    await db.insert(stripeEvents).values({ id: "evt_" + newId("x"), type: "invoice.paid", receivedAt: ago(1) });
    await writeSettings("billing", { stripeSecretKey: "sk_test_1", livemode: false }, SYSTEM);
    const status = await getSystemStatus();
    expect(status).toMatchObject({
      version: pkg.version,
      publicUrl: "http://localhost:3210",
      publicUrlConfigured: true,
      database: true,
      email: { transport: "log", lastFailure: null },
      stripe: { connected: true, livemode: false },
      relay: { links: 3, streams: 7 },
    });
    expect(typeof status.uiBuild).toBe("boolean");
    expect(status.stripe.lastEventAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

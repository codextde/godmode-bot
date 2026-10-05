import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { CloudClose, cloudBearer, type CloudInvoice } from "@godmode/shared";
import { SYSTEM } from "@/server/audit";
import { validateSessionToken } from "@/server/auth/sessions";
import { sha256 } from "@/server/crypto";
import { auditLog, db, devices, linkRequests, roles, users } from "@/server/db";
import { listDeviceAccess, shareDevice, unshareDevice } from "@/server/devices/access";
import {
  adminListDevices,
  authenticateDevice,
  getDeviceForUser,
  listDevicesFor,
  removeDevice,
  renameDevice,
  setDeviceStatus,
} from "@/server/devices";
import { approveLink, denyLink, getPendingLink, pollLink, startLink } from "@/server/devices/link";
import { AppError } from "@/server/errors";
import { registerRelayHub, relayHub, type RelayHubApi } from "@/server/relay-bridge";
import { writeSettings } from "@/server/settings";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { baseline, makeDevice, makeUser, type TestUser } from "./harness";

const stripeInvoice: CloudInvoice = {
  id: "in_123",
  number: "GM-0001",
  date: "2026-09-01T00:00:00.000Z",
  total: 1000,
  currency: "usd",
  status: "paid",
  url: "https://invoice.stripe.com/i/acct_1/test_abc",
  pdf: "https://pay.stripe.com/invoice/acct_1/test_abc/pdf",
};

const billingCalls = vi.hoisted(() => ({ cancel: [] as unknown[][], resume: [] as unknown[][] }));

vi.mock("@/server/billing/subscriptions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/billing/subscriptions")>();
  return {
    ...original,
    listInvoices: async () => [stripeInvoice],
    cancelSubscription: async (...args: unknown[]) => {
      billingCalls.cancel.push(args);
      return null;
    },
    resumeSubscription: async (...args: unknown[]) => {
      billingCalls.resume.push(args);
      return null;
    },
  };
});

const { POST: startRoute } = await import("@/app/api/link/v1/start/route");
const { POST: pollRoute } = await import("@/app/api/link/v1/poll/route");
const { GET: meRoute } = await import("@/app/api/device/v1/me/route");
const { GET: billingRoute } = await import("@/app/api/device/v1/billing/route");
const { POST: cancelRoute } = await import("@/app/api/device/v1/billing/cancel/route");
const { POST: resumeRoute } = await import("@/app/api/device/v1/billing/resume/route");
const { DELETE: selfRoute } = await import("@/app/api/device/v1/self/route");

/** Records what services ask of the relay; `online` decides isOnline. */
function fakeHub(online = new Set<string>()) {
  const disconnects: [string, number, string][] = [];
  const hub: RelayHubApi = {
    isOnline: (id) => online.has(id),
    info: () => null,
    online: () => [],
    disconnect: (id, code, reason) => void disconnects.push([id, code, reason]),
    notify: () => {},
    notifyUser: () => {},
    stats: () => ({ links: 0, streams: 0, sockets: 0, bytesIn: 0, bytesOut: 0, startedAt: new Date().toISOString() }),
  };
  registerRelayHub(hub);
  return { disconnects, online };
}

function linkBody(secret: string, instanceId = "gm_instance_1") {
  return { instanceId, name: "Studio Mac", platform: "darwin", version: "0.1.0", secretHash: sha256(secret) };
}

const newSecret = () => `gml_${randomBytes(32).toString("base64url")}`;

async function ctxOf(user: TestUser) {
  const ctx = await validateSessionToken(user.token);
  if (!ctx) throw new Error("no session");
  return ctx;
}

async function auditActions(): Promise<string[]> {
  return (await db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action);
}

async function expectAppError(promise: Promise<unknown>, status: number, code?: string): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (code) expect((err as AppError).code).toBe(code);
  return err as AppError;
}

let owner: TestUser;

beforeAll(resetDatabase);
afterAll(closeDatabase);

beforeEach(async () => {
  await truncateAll();
  await baseline();
  billingCalls.cancel.length = 0;
  billingCalls.resume.length = 0;
  owner = await makeUser("owner@example.com", "role_owner");
});

describe("linking", () => {
  test("start, poll, approve: the computer gets its device id and account", async () => {
    const secret = newSecret();
    const started = await startLink(linkBody(secret), "198.51.100.1");
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.verifyUrl).toBe(`http://localhost:3210/link?code=${started.userCode}`);
    expect(started.interval).toBeGreaterThan(0);
    expect(new Date(started.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(await pollLink(started.requestId, secret)).toEqual({ status: "pending" });

    const pending = await getPendingLink(started.userCode.toLowerCase().replace("-", " "));
    expect(pending).toMatchObject({ id: started.requestId, name: "Studio Mac", ip: "198.51.100.1" });

    const { device } = await approveLink(started.userCode, await ctxOf(owner));
    expect(device).toMatchObject({ userId: owner.id, name: "Studio Mac", instanceId: "gm_instance_1", platform: "darwin" });
    expect(await pollLink(started.requestId, secret)).toEqual({
      status: "approved",
      deviceId: device.id,
      account: { email: "owner@example.com", name: "owner" },
    });
    expect((await authenticateDevice(cloudBearer(device.id, secret)))?.id).toBe(device.id);
    expect(await authenticateDevice(`Bearer ${cloudBearer(device.id, secret)}`)).not.toBeNull();
    expect(await authenticateDevice(cloudBearer(device.id, newSecret()))).toBeNull();
    expect(await auditActions()).toContain("device.link");
    // Used once: the code is gone.
    expect(await getPendingLink(started.userCode)).toBeNull();
    await expectAppError(approveLink(started.userCode, await ctxOf(owner)), 404, "link_not_found");
  });

  test("poll needs the secret behind the hash", async () => {
    const secret = newSecret();
    const started = await startLink(linkBody(secret), "198.51.100.1");
    await expectAppError(pollLink(started.requestId, newSecret()), 401);
    await expectAppError(pollLink("lnk_doesnotexist0000", secret), 401);
  });

  test("deny and expiry", async () => {
    const a = newSecret();
    const denied = await startLink(linkBody(a), "198.51.100.1");
    await denyLink(denied.userCode, await ctxOf(owner));
    expect(await pollLink(denied.requestId, a)).toEqual({ status: "denied" });
    expect(await auditActions()).toContain("device.link_denied");

    const b = newSecret();
    const expired = await startLink(linkBody(b, "gm_other"), "198.51.100.1");
    await db.update(linkRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(linkRequests.id, expired.requestId));
    expect(await pollLink(expired.requestId, b)).toEqual({ status: "expired" });
    expect(await getPendingLink(expired.userCode)).toBeNull();
    await expectAppError(approveLink(expired.userCode, await ctxOf(owner)), 404);
  });

  test("start validates its input and is rate limited per address", async () => {
    await expectAppError(startLink({ name: "x" }, "198.51.100.2"), 400);
    for (let i = 0; i < 10; i++) await startLink(linkBody(newSecret(), `gm_${i}`), "198.51.100.3");
    await expectAppError(startLink(linkBody(newSecret()), "198.51.100.3"), 429);
    await startLink(linkBody(newSecret()), "198.51.100.4");
  });

  test("approving needs devices.link", async () => {
    await db.insert(roles).values({ id: "role_readonly", key: "readonly", name: "Read only", permissions: [] });
    const reader = await makeUser("reader@example.com", "role_readonly");
    const started = await startLink(linkBody(newSecret()), "198.51.100.1");
    await expectAppError(approveLink(started.userCode, await ctxOf(reader)), 403);
  });

  test("the same computer again becomes a new computer without the old shares, but not while it is online", async () => {
    const first = newSecret();
    const a = await startLink(linkBody(first), "198.51.100.1");
    const { device } = await approveLink(a.userCode, await ctxOf(owner));
    const friend = await makeUser("friend@example.com");
    await shareDevice(device.id, "friend@example.com", "operator", await ctxOf(owner));

    const hub = fakeHub(new Set([device.id]));
    const second = newSecret();
    const b = await startLink(linkBody(second), "198.51.100.1");
    const refused = await expectAppError(approveLink(b.userCode, await ctxOf(owner)), 409, "device_online");
    expect(refused.message).toContain("Unlink it on the computer first.");

    // Whoever knows the instance id (the gateway's health check names it) gets a fresh computer, not the old one.
    hub.online.clear();
    const { device: again } = await approveLink(b.userCode, await ctxOf(owner));
    expect(again.id).not.toBe(device.id);
    expect(again.instanceId).toBe(device.instanceId);
    expect(await authenticateDevice(cloudBearer(device.id, first))).toBeNull();
    expect(await authenticateDevice(cloudBearer(again.id, second))).not.toBeNull();
    expect(await getDeviceForUser(again.id, friend.id)).toBeNull();
    expect(await getDeviceForUser(device.id, friend.id)).toBeNull();
    expect((await db.select().from(devices).where(eq(devices.userId, owner.id))).map((d) => d.id)).toEqual([again.id]);
    expect(hub.disconnects).toEqual([[device.id, CloudClose.BadCredential, "Linked again as a new computer"]]);
  });

  test("the plan's computer limit refuses with a sentence and plan_limit", async () => {
    await writeSettings("billing", { enabled: true, stripeSecretKey: "sk_test_fake" }, SYSTEM);
    const member = await makeUser("member@example.com");
    await makeDevice(member.id);
    const started = await startLink(linkBody(newSecret(), "gm_new"), "198.51.100.1");
    const err = await expectAppError(approveLink(started.userCode, await ctxOf(member)), 402, "plan_limit");
    expect(err.message).toBe("Your plan includes 1 computer, and it is linked. Remove one or choose a bigger plan to link this computer.");
  });
});

describe("computers", () => {
  test("access: owner, shared roles, strangers", async () => {
    const device = await makeDevice(owner.id);
    const friend = await makeUser("friend@example.com");
    const stranger = await makeUser("stranger@example.com");
    await shareDevice(device.id, "  Friend@Example.com ", "viewer", await ctxOf(owner));
    expect(await getDeviceForUser(device.id, owner.id)).toMatchObject({ role: "owner" });
    expect(await getDeviceForUser(device.id, friend.id)).toMatchObject({ role: "viewer" });
    expect(await getDeviceForUser(device.id, stranger.id)).toBeNull();
    expect(await listDeviceAccess(device.id)).toEqual([{ user: { id: friend.id, email: "friend@example.com", name: "friend" }, role: "viewer" }]);
    const mine = await listDevicesFor(friend.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ role: "viewer", owner: { email: "owner@example.com" } });

    await shareDevice(device.id, "friend@example.com", "operator", await ctxOf(owner));
    expect(await getDeviceForUser(device.id, friend.id)).toMatchObject({ role: "operator" });
    await expectAppError(shareDevice(device.id, "nobody@example.com", "viewer", await ctxOf(owner)), 400);
    await expectAppError(shareDevice(device.id, "owner@example.com", "viewer", await ctxOf(owner)), 400);
    await expectAppError(shareDevice(device.id, "friend@example.com", "viewer", await ctxOf(stranger)), 404);
    await expectAppError(unshareDevice(device.id, friend.id, await ctxOf(stranger)), 404);

    // The person it was shared with may leave.
    await unshareDevice(device.id, friend.id, await ctxOf(friend));
    expect(await getDeviceForUser(device.id, friend.id)).toBeNull();
    expect(await auditActions()).toEqual(expect.arrayContaining(["device.share", "device.unshare"]));
  });

  test("sharing needs the setting and a plan with sharing", async () => {
    await makeUser("friend@example.com");
    const ownDevice = await makeDevice(owner.id);
    await writeSettings("relay", { sharing: false }, SYSTEM);
    await expectAppError(shareDevice(ownDevice.id, "friend@example.com", "viewer", await ctxOf(owner)), 403);
    await writeSettings("relay", { sharing: true }, SYSTEM);
    await writeSettings("billing", { enabled: true, stripeSecretKey: "sk_test_fake" }, SYSTEM);
    const member = await makeUser("member@example.com");
    const memberDevice = await makeDevice(member.id);
    await expectAppError(shareDevice(memberDevice.id, "friend@example.com", "viewer", await ctxOf(member)), 403, "plan_limit");
  });

  test("rename, turn off and remove; admins with devices.manage may turn off and remove", async () => {
    const hub = fakeHub();
    const device = await makeDevice(owner.id);
    expect((await renameDevice(device.id, "  Office   iMac ", await ctxOf(owner))).name).toBe("Office iMac");
    await expectAppError(renameDevice(device.id, "   ", await ctxOf(owner)), 400);

    const stranger = await makeUser("stranger@example.com");
    await expectAppError(setDeviceStatus(device.id, "disabled", await ctxOf(stranger)), 404);
    await expectAppError(removeDevice(device.id, await ctxOf(stranger)), 404);

    const admin = await makeUser("admin@example.com", "role_admin");
    expect((await setDeviceStatus(device.id, "disabled", await ctxOf(admin))).status).toBe("disabled");
    expect(hub.disconnects).toEqual([[device.id, CloudClose.Disabled, "Turned off in the cloud"]]);
    await setDeviceStatus(device.id, "active", await ctxOf(owner));

    await removeDevice(device.id, await ctxOf(owner));
    expect(await db.select().from(devices).where(eq(devices.id, device.id))).toHaveLength(0);
    expect(hub.disconnects.at(-1)).toEqual([device.id, CloudClose.BadCredential, "Removed"]);
    expect(await auditActions()).toEqual(expect.arrayContaining(["device.rename", "device.disable", "device.enable", "device.remove"]));
  });

  test("admin list with search and paging", async () => {
    const member = await makeUser("member@example.com");
    await makeDevice(owner.id, { name: "Studio Mac" });
    await makeDevice(member.id, { name: "Laptop" });
    const all = await adminListDevices({});
    expect(all.total).toBe(2);
    const byEmail = await adminListDevices({ search: "member@" });
    expect(byEmail.rows.map((r) => r.name)).toEqual(["Laptop"]);
    expect(byEmail.rows[0]!.owner.email).toBe("member@example.com");
    expect((await adminListDevices({ search: "studio" })).total).toBe(1);
    expect((await adminListDevices({ search: "%" })).total).toBe(0);
    expect((await adminListDevices({ pageSize: 1, page: 2 })).rows).toHaveLength(1);
  });
});

describe("routes", () => {
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }) as RequestInit;

  test("link start and poll", async () => {
    const secret = newSecret();
    const started = await startRoute(new Request("http://cloud.local/api/link/v1/start", json(linkBody(secret))));
    expect(started.status).toBe(200);
    const body = (await started.json()) as { requestId: string; userCode: string };
    expect(body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const bad = await startRoute(new Request("http://cloud.local/api/link/v1/start", { method: "POST", body: "nope" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "bad_request" });

    const poll = await pollRoute(new Request("http://cloud.local/api/link/v1/poll", json({ requestId: body.requestId }, { authorization: `Bearer ${secret}` })));
    expect(await poll.json()).toEqual({ status: "pending" });
    const wrong = await pollRoute(new Request("http://cloud.local/api/link/v1/poll", json({ requestId: body.requestId }, { authorization: "Bearer gml_x" })));
    expect(wrong.status).toBe(401);
  });

  test("the device API needs the device bearer", async () => {
    const device = await makeDevice(owner.id);
    const get = (route: (r: Request) => Promise<Response>, authorization?: string) =>
      route(new Request("http://cloud.local/api/device/v1/me", { headers: authorization ? { authorization } : {} }));

    const me = await get(meRoute, `Bearer ${device.bearer}`);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      deviceId: device.id,
      name: "Studio Mac",
      account: { email: "owner@example.com", name: "owner" },
      plan: expect.objectContaining({ id: "unlimited" }),
      publicUrl: "http://localhost:3210",
    });
    for (const auth of [undefined, "Bearer nope", `Bearer ${cloudBearer(device.id, newSecret())}`]) {
      const res = await get(meRoute, auth);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "unauthorized" });
    }
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, owner.id));
    expect((await get(meRoute, `Bearer ${device.bearer}`)).status).toBe(403);
  });

  test("billing for a computer: invoices link to the cloud, never to Stripe", async () => {
    const device = await makeDevice(owner.id);
    const res = await billingRoute(new Request("http://cloud.local/api/device/v1/billing", { headers: { authorization: `Bearer ${device.bearer}` } }));
    expect(res.status).toBe(200);
    const billing = (await res.json()) as { invoices: CloudInvoice[]; urls: { billing: string } };
    expect(billing.invoices).toEqual([{ ...stripeInvoice, url: "http://localhost:3210/billing?invoice=in_123", pdf: null }]);
    expect(JSON.stringify(billing)).not.toContain("stripe.com");
    expect(billing.urls.billing).toBe("http://localhost:3210/billing");
  });

  test("cancel and resume act for the owner, audited as the computer", async () => {
    const device = await makeDevice(owner.id);
    const init = { method: "POST", headers: { authorization: `Bearer ${device.bearer}` } };
    const cancel = await cancelRoute(new Request("http://cloud.local/api/device/v1/billing/cancel", init));
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { invoices: CloudInvoice[] }).invoices[0]!.pdf).toBeNull();
    expect(billingCalls.cancel).toHaveLength(1);
    expect(billingCalls.cancel[0]![0]).toMatchObject({ id: owner.id });
    expect(billingCalls.cancel[0]![1]).toMatchObject({ id: null, label: `device:${device.id}` });
    expect((await resumeRoute(new Request("http://cloud.local/api/device/v1/billing/resume", init))).status).toBe(200);
    expect(billingCalls.resume).toHaveLength(1);
    expect((await cancelRoute(new Request("http://cloud.local/api/device/v1/billing/cancel", { method: "POST" }))).status).toBe(401);
  });

  test("a computer turned off in the cloud can't use the device API, but can still unlink itself", async () => {
    fakeHub();
    const device = await makeDevice(owner.id, { status: "disabled" });
    const auth = { authorization: `Bearer ${device.bearer}` };
    const me = await meRoute(new Request("http://cloud.local/api/device/v1/me", { headers: auth }));
    expect(me.status).toBe(403);
    expect(await me.json()).toEqual({ error: "This computer is turned off in Godmode Cloud.", code: "device_disabled" });
    expect((await billingRoute(new Request("http://cloud.local/api/device/v1/billing", { headers: auth }))).status).toBe(403);
    expect((await cancelRoute(new Request("http://cloud.local/api/device/v1/billing/cancel", { method: "POST", headers: auth }))).status).toBe(403);
    expect((await resumeRoute(new Request("http://cloud.local/api/device/v1/billing/resume", { method: "POST", headers: auth }))).status).toBe(403);
    expect(billingCalls.cancel).toHaveLength(0);
    expect(billingCalls.resume).toHaveLength(0);
    const self = await selfRoute(new Request("http://cloud.local/api/device/v1/self", { method: "DELETE", headers: auth }));
    expect(self.status).toBe(200);
    expect(await db.select().from(devices).where(eq(devices.id, device.id))).toHaveLength(0);
  });

  test("a computer unlinks itself", async () => {
    const hub = fakeHub();
    const device = await makeDevice(owner.id);
    const res = await selfRoute(new Request("http://cloud.local/api/device/v1/self", { method: "DELETE", headers: { authorization: `Bearer ${device.bearer}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await db.select().from(devices).where(and(eq(devices.id, device.id)))).toHaveLength(0);
    expect(hub.disconnects).toEqual([[device.id, CloudClose.BadCredential, "Unlinked"]]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "device.unlink"));
    expect(entry).toMatchObject({ actor: `device:${device.id}`, targetId: device.id });
    expect(relayHub()).toBeDefined();
  });
});

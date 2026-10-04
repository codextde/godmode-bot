import { CloudClose } from "@godmode/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loginPolicy } from "@/server/auth/policy";
import { listSessions, validateSessionToken, createSession } from "@/server/auth/sessions";
import { cancelNow } from "@/server/billing/subscriptions";
import { db, devices, users } from "@/server/db";
import { AppError } from "@/server/errors";
import { registerRelayHub, type RelayHubApi } from "@/server/relay-bridge";
import {
  countUsers,
  deleteAccount,
  deleteOwnAccount,
  getUser,
  listUsers,
  setUserStatus,
  signOutUser,
  signupSeries,
  updateProfile,
} from "@/server/users";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, makeDevice, makeUser, META, seed } from "./fixtures";

vi.mock("@/server/billing/subscriptions", () => ({ cancelNow: vi.fn(async () => {}) }));

const disconnect = vi.fn<RelayHubApi["disconnect"]>();
const hub: RelayHubApi = {
  isOnline: () => false,
  info: () => null,
  online: () => [],
  disconnect,
  notify: () => {},
  notifyUser: () => {},
  stats: () => ({ links: 0, streams: 0, sockets: 0, bytesIn: 0, bytesOut: 0, startedAt: new Date().toISOString() }),
};

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
  registerRelayHub(hub);
  disconnect.mockClear();
  vi.mocked(cancelNow).mockReset();
  vi.mocked(cancelNow).mockResolvedValue(undefined);
});
afterEach(() => registerRelayHub(null));
afterAll(closeDatabase);

describe("listing", () => {
  test("search, filters, computer counts, totals", async () => {
    const a = await makeUser({ email: "alice@solakon.de", name: "Alice" });
    await makeUser({ email: "bob@example.com", role: "admin" });
    await makeUser({ email: "carol@example.com", status: "suspended" });
    await makeDevice(a.user.id);
    await makeDevice(a.user.id);
    const all = await listUsers({});
    expect(all.total).toBe(3);
    expect(all.rows.find((r) => r.id === a.user.id)?.deviceCount).toBe(2);
    expect(all.rows.find((r) => r.id === a.user.id)?.role.key).toBe("member");
    expect((await listUsers({ search: "alic" })).rows.map((r) => r.email)).toEqual(["alice@solakon.de"]);
    expect((await listUsers({ search: "SOLAKON" })).total).toBe(1);
    expect((await listUsers({ roleId: "role_admin" })).rows.map((r) => r.email)).toEqual(["bob@example.com"]);
    expect((await listUsers({ status: "suspended" })).rows.map((r) => r.email)).toEqual(["carol@example.com"]);
    expect((await listUsers({ pageSize: 2, page: 2 })).rows).toHaveLength(1);
    expect(await countUsers()).toBe(3);
    expect((await getUser(a.user.id))?.role.key).toBe("member");
    expect(await getUser("usr_missing")).toBeNull();
  });

  test("sign-ups per day include days without any", async () => {
    await makeUser();
    await makeUser();
    const old = await makeUser();
    await db.update(users).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(users.id, old.user.id));
    const series = await signupSeries(7);
    expect(series).toHaveLength(7);
    expect(series.at(-1)!.count).toBe(2);
    expect(series.at(-3)!.count).toBe(1);
    expect(series.reduce((n, d) => n + d.count, 0)).toBe(3);
    expect(series.at(-1)!.day).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("profile", () => {
  test("updates the name", async () => {
    const me = await makeUser();
    expect((await updateProfile(me.user.id, { name: "  Dana  " })).name).toBe("Dana");
    expect((await updateProfile(me.user.id, { name: "" })).name).toBeNull();
    await expect(updateProfile(me.user.id, { name: "x".repeat(81) })).rejects.toBeInstanceOf(AppError);
    expect(await auditRows("user.profile")).toHaveLength(2);
  });
});

describe("suspending", () => {
  test("signs the person out everywhere and disconnects their computers", async () => {
    const admin = await makeUser({ role: "admin" });
    const person = await makeUser({ email: "p@example.com" });
    const extra = await createSession(person.user.id, META);
    const d1 = await makeDevice(person.user.id);
    const d2 = await makeDevice(person.user.id);
    await setUserStatus(person.user.id, "suspended", admin);
    expect(await listSessions(person.user.id)).toHaveLength(0);
    expect(await validateSessionToken(extra.token)).toBeNull();
    expect(disconnect.mock.calls.map((c) => c[0]).sort()).toEqual([d1, d2].sort());
    expect(disconnect.mock.calls.every((c) => c[1] === CloudClose.Disabled)).toBe(true);
    expect(await loginPolicy("p@example.com")).toEqual({ allowed: false, reason: "suspended" });
    const [entry] = await auditRows("user.suspend");
    expect(entry!.meta).toMatchObject({ sessionsRevoked: 2 });
    await setUserStatus(person.user.id, "active", admin);
    expect((await loginPolicy("p@example.com")).allowed).toBe(true);
    expect(await auditRows("user.activate")).toHaveLength(1);
  });

  test("nobody suspends themselves; members cannot suspend", async () => {
    const admin = await makeUser({ role: "admin" });
    const member = await makeUser();
    await expect(setUserStatus(admin.user.id, "suspended", admin)).rejects.toMatchObject({ status: 403 });
    await expect(setUserStatus(admin.user.id, "suspended", member)).rejects.toMatchObject({ status: 403 });
  });

  test("signing someone out", async () => {
    const admin = await makeUser({ role: "admin" });
    const person = await makeUser();
    await createSession(person.user.id, META);
    expect(await signOutUser(person.user.id, admin)).toBe(2);
    expect(await listSessions(person.user.id)).toHaveLength(0);
  });
});

describe("deleting", () => {
  test("cancels billing, deletes the account and disconnects its computers", async () => {
    const admin = await makeUser({ role: "admin" });
    const person = await makeUser({ email: "gone@example.com" });
    const device = await makeDevice(person.user.id);
    await deleteAccount(person.user.id, admin);
    expect(cancelNow).toHaveBeenCalledWith(person.user.id, expect.objectContaining({ id: admin.user.id, label: admin.user.email }));
    expect(await getUser(person.user.id)).toBeNull();
    expect(await db.select().from(devices).where(eq(devices.id, device))).toHaveLength(0);
    expect(disconnect).toHaveBeenCalledWith(device, CloudClose.BadCredential, "Removed");
    const [entry] = await auditRows("user.delete");
    expect(entry!.meta).toMatchObject({ email: "gone@example.com", computers: 1 });
  });

  test("when Stripe refuses, nothing is deleted", async () => {
    const admin = await makeUser({ role: "admin" });
    const person = await makeUser();
    await makeDevice(person.user.id);
    vi.mocked(cancelNow).mockRejectedValueOnce(new AppError("Stripe could not cancel the subscription. Try again in a minute.", "stripe_error", 502));
    await expect(deleteAccount(person.user.id, admin)).rejects.toThrow("Stripe could not cancel");
    expect(await getUser(person.user.id)).not.toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
    expect(await auditRows("user.delete")).toHaveLength(0);
  });

  test("the admin area cannot delete the own account", async () => {
    const admin = await makeUser({ role: "admin" });
    await expect(deleteAccount(admin.user.id, admin)).rejects.toMatchObject({ status: 403 });
    expect(cancelNow).not.toHaveBeenCalled();
  });

  test("deleting the own account needs the address typed and is refused for the last owner", async () => {
    const member = await makeUser({ email: "me@example.com" });
    await expect(deleteOwnAccount(member, "other@example.com")).rejects.toMatchObject({ status: 400 });
    await deleteOwnAccount(member, " ME@example.com ");
    expect(await getUser(member.user.id)).toBeNull();
    const owner = await makeUser({ role: "owner" });
    await expect(deleteOwnAccount(owner, owner.user.email)).rejects.toThrow("at least one active owner");
    expect(cancelNow).toHaveBeenCalledTimes(1);
    const second = await makeUser({ role: "owner" });
    await deleteOwnAccount(owner, owner.user.email);
    expect(await getUser(owner.user.id)).toBeNull();
    expect(await getUser(second.user.id)).not.toBeNull();
  });
});

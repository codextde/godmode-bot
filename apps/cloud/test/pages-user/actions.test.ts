/**
 * The user area's server actions, run against a real database with Next's request APIs replaced: every action must
 * authorise by itself (someone else's computer looks like it does not exist, a viewer can't manage, signed out is
 * refused) and validate its input before the service runs.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SYSTEM } from "@/server/audit";
import { createSession, listSessions, validateSessionToken, type SessionContext } from "@/server/auth/sessions";
import { ensureDefaultPlans } from "@/server/billing/plans";
import { newId, sha256 } from "@/server/crypto";
import { db, devices, roles, users } from "@/server/db";
import { listDeviceAccess } from "@/server/devices/access";
import { pollLink, startLink } from "@/server/devices/link";
import { writeSettings } from "@/server/settings";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { makeDevice, makeUser, META, seed } from "../platform/fixtures";

/* ------------------------------------------------------------------ */
/* Next's request APIs, replaced                                        */
/* ------------------------------------------------------------------ */

const state = vi.hoisted(() => ({ token: null as string | null, redirects: [] as string[], revalidated: [] as string[] }));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name.endsWith("gmc_session") && state.token ? { name, value: state.token } : undefined),
    set: () => {},
  }),
  headers: async () => new Headers({ "user-agent": META.userAgent, "x-godmode-peer": META.ip }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirects.push(url);
    throw new RedirectSignal(url);
  },
  forbidden: () => {
    throw new Error("NEXT_FORBIDDEN");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof RedirectSignal) throw err;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => void state.revalidated.push(path),
}));

const deviceActions = await import("@/app/(app)/devices/actions");
const linkActions = await import("@/app/(app)/link/actions");
const billingActions = await import("@/app/(app)/billing/actions");
const accountActions = await import("@/app/(app)/account/actions");

/** Signs the test's "browser" in as this person (a fresh session of theirs). */
async function signIn(ctx: SessionContext): Promise<string> {
  const { token } = await createSession(ctx.user.id, META);
  state.token = token;
  return token;
}

function signOut(): void {
  state.token = null;
}

function linkBody(secret: string, instanceId = "gm_instance_1") {
  return { instanceId, name: "Studio Mac", platform: "darwin", version: "1.8.0", secretHash: sha256(secret) };
}

beforeAll(resetDatabase);
afterAll(closeDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
  signOut();
  state.redirects = [];
  state.revalidated = [];
});

/* ------------------------------------------------------------------ */
/* Computers                                                            */
/* ------------------------------------------------------------------ */

describe("computer actions", () => {
  test("signed out is refused before anything runs", async () => {
    const owner = await makeUser();
    const id = await makeDevice(owner.user.id);
    const result = await deviceActions.renameDeviceAction(id, "New name");
    expect(result).toEqual({ ok: false, error: "Your session has ended. Sign in again." });
    const [row] = await db.select().from(devices).where(eq(devices.id, id));
    expect(row!.name).toBe("Test Mac");
  });

  test("the owner renames; someone else's computer looks like it does not exist", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const id = await makeDevice(owner.user.id);

    await signIn(other);
    const refused = await deviceActions.renameDeviceAction(id, "Mine now");
    expect(refused).toEqual({ ok: false, error: "This computer does not exist any more." });

    await signIn(owner);
    const empty = await deviceActions.renameDeviceAction(id, "   ");
    expect(empty).toEqual({ ok: false, error: "Give the computer a name." });
    const ok = await deviceActions.renameDeviceAction(id, "  Studio   Mac ");
    expect(ok).toEqual({ ok: true, data: undefined });
    const [row] = await db.select().from(devices).where(eq(devices.id, id));
    expect(row!.name).toBe("Studio Mac");
    expect(state.revalidated).toContain("/");
  });

  test("a viewer can neither rename, turn off, remove nor share", async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const id = await makeDevice(owner.user.id);
    await signIn(owner);
    expect(await deviceActions.shareDeviceAction(id, viewer.user.email, "viewer")).toEqual({ ok: true, data: undefined });

    await signIn(viewer);
    const refusedRename = await deviceActions.renameDeviceAction(id, "Taken");
    const refusedStatus = await deviceActions.setDeviceStatusAction(id, "disabled");
    const refusedRemove = await deviceActions.removeDeviceAction(id);
    const refusedShare = await deviceActions.shareDeviceAction(id, owner.user.email, "operator");
    for (const result of [refusedRename, refusedStatus, refusedRemove, refusedShare]) {
      expect(result).toEqual({ ok: false, error: "This computer does not exist any more." });
    }
    const [row] = await db.select().from(devices).where(eq(devices.id, id));
    expect(row).toMatchObject({ name: "Test Mac", status: "active" });
  });

  test("the owner turns a computer off and on and removes it", async () => {
    const owner = await makeUser();
    const id = await makeDevice(owner.user.id);
    await signIn(owner);
    expect(await deviceActions.setDeviceStatusAction(id, "disabled")).toEqual({ ok: true, data: undefined });
    expect((await db.select().from(devices).where(eq(devices.id, id)))[0]!.status).toBe("disabled");
    expect(await deviceActions.setDeviceStatusAction(id, "paused" as "active")).toEqual({ ok: false, error: "Choose on or off.", fields: { form: "Choose on or off." } });
    expect(await deviceActions.setDeviceStatusAction(id, "active")).toEqual({ ok: true, data: undefined });
    expect(await deviceActions.removeDeviceAction(id)).toEqual({ ok: true, data: undefined });
    expect(await db.select().from(devices).where(eq(devices.id, id))).toHaveLength(0);
  });

  test("sharing validates the input, and only the owner or the person themselves can end it", async () => {
    const owner = await makeUser();
    const friend = await makeUser();
    const stranger = await makeUser();
    const id = await makeDevice(owner.user.id);
    await signIn(owner);
    expect(await deviceActions.shareDeviceAction(id, "", "viewer")).toEqual({ ok: false, error: "Enter their e-mail address.", fields: { email: "Enter their e-mail address." } });
    expect(await deviceActions.shareDeviceAction(id, friend.user.email, "admin" as "viewer")).toEqual({
      ok: false,
      error: "Choose what they may do on this computer.",
      fields: { role: "Choose what they may do on this computer." },
    });
    expect(await deviceActions.shareDeviceAction(id, "nobody@example.com", "viewer")).toEqual({
      ok: false,
      error: "There is no account with that address on this cloud. Invite them first.",
    });
    expect(await deviceActions.shareDeviceAction(id, friend.user.email.toUpperCase(), "operator")).toEqual({ ok: true, data: undefined });
    expect(await listDeviceAccess(id)).toEqual([{ user: { id: friend.user.id, email: friend.user.email, name: null }, role: "operator" }]);

    await signIn(stranger);
    expect(await deviceActions.unshareDeviceAction(id, friend.user.id)).toEqual({ ok: false, error: "This computer does not exist any more." });
    expect(await listDeviceAccess(id)).toHaveLength(1);

    await signIn(friend);
    expect(await deviceActions.unshareDeviceAction(id, friend.user.id)).toEqual({ ok: true, data: undefined });
    expect(await listDeviceAccess(id)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Linking                                                              */
/* ------------------------------------------------------------------ */

describe("link actions", () => {
  test("approving links the computer to the signed-in account; the code is single use", async () => {
    const person = await makeUser();
    const started = await startLink(linkBody("secret-1"), "198.51.100.1");
    expect(await linkActions.approveLinkAction(started.userCode)).toEqual({ ok: false, error: "Your session has ended. Sign in again." });

    await signIn(person);
    const result = await linkActions.approveLinkAction(started.userCode.toLowerCase().replace("-", " "));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Studio Mac");
    const [row] = await db.select().from(devices).where(eq(devices.id, result.data.deviceId));
    expect(row).toMatchObject({ userId: person.user.id, instanceId: "gm_instance_1", secretHash: sha256("secret-1") });
    expect(await pollLink(started.requestId, "secret-1")).toMatchObject({ status: "approved", deviceId: result.data.deviceId });

    const again = await linkActions.approveLinkAction(started.userCode);
    expect(again).toEqual({ ok: false, error: "This code has expired or was already used. Start linking again on the computer." });
    expect(await linkActions.approveLinkAction("nope")).toEqual({ ok: false, error: "Enter the code shown in Godmode.", fields: { form: "Enter the code shown in Godmode." } });
    expect(await linkActions.approveLinkAction("ZZZZ-ZZZZ")).toMatchObject({ ok: false });
  });

  test("denying answers the computer with denied", async () => {
    const person = await makeUser();
    const started = await startLink(linkBody("secret-2"), "198.51.100.1");
    await signIn(person);
    expect(await linkActions.denyLinkAction(started.userCode)).toEqual({ ok: true, data: undefined });
    expect(await pollLink(started.requestId, "secret-2")).toEqual({ status: "denied" });
    expect(await db.select().from(devices)).toHaveLength(0);
  });

  test("over the plan's computer limit the answer says so and points to billing", async () => {
    await writeSettings("billing", { enabled: true, stripeSecretKey: "sk_test_fake" }, SYSTEM);
    await ensureDefaultPlans(); // the free plan allows one computer
    const person = await makeUser();
    await makeDevice(person.user.id);
    const started = await startLink(linkBody("secret-3", "gm_instance_2"), "198.51.100.1");
    await signIn(person);
    const result = await linkActions.approveLinkAction(started.userCode);
    expect(result).toEqual({
      ok: false,
      error: "Your plan includes 1 computer, and it is linked. Remove one or choose a bigger plan to link this computer.",
      planLimit: true,
    });
    expect(await pollLink(started.requestId, "secret-3")).toEqual({ status: "pending" });
  });
});

/* ------------------------------------------------------------------ */
/* Billing                                                              */
/* ------------------------------------------------------------------ */

describe("billing actions", () => {
  test("checkout needs billing.self and a plan_prices id", async () => {
    const [memberRole] = await db.select().from(roles).where(eq(roles.key, "member"));
    const [readOnly] = await db
      .insert(roles)
      .values({ id: newId("role"), key: "readonly", name: "Read only", permissions: ["devices.link"] })
      .returning();
    const [user] = await db.insert(users).values({ id: newId("usr"), email: "ro@example.com", roleId: readOnly!.id }).returning();
    await signIn({ user: user!, role: readOnly!, session: (await createSession(user!.id, META)).session });
    expect(await billingActions.checkoutAction("price_abc")).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(await billingActions.portalAction()).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(await billingActions.cancelSubscriptionAction()).toEqual({ ok: false, error: "You don't have permission to do that." });

    const member = await makeUser();
    expect(memberRole!.permissions).toContain("billing.self");
    await signIn(member);
    expect(await billingActions.checkoutAction("price_123; drop table")).toEqual({ ok: false, error: "Choose a plan.", fields: { form: "Choose a plan." } });
    expect(await billingActions.changePlanAction("")).toEqual({ ok: false, error: "Choose a plan.", fields: { form: "Choose a plan." } });
    // Billing is off on a fresh cloud: a well-formed id reaches the service, which refuses without touching Stripe.
    expect(await billingActions.checkoutAction("price_0123456789abcdef")).toEqual({
      ok: false,
      error: "Billing is turned off on this cloud, so everything is already included.",
    });
    expect(await billingActions.portalAction()).toEqual({ ok: false, error: "Stripe is not connected. Add the secret key under Settings → Billing." });
  });
});

/* ------------------------------------------------------------------ */
/* Account                                                              */
/* ------------------------------------------------------------------ */

describe("account actions", () => {
  test("name changes are saved for the signed-in person only", async () => {
    const person = await makeUser();
    expect(await accountActions.updateNameAction("Ada")).toEqual({ ok: false, error: "Your session has ended. Sign in again." });
    await signIn(person);
    expect(await accountActions.updateNameAction("x".repeat(81))).toEqual({
      ok: false,
      error: "Keep your name under 80 characters.",
      fields: { form: "Keep your name under 80 characters." },
    });
    expect(await accountActions.updateNameAction("  Ada Lovelace ")).toEqual({ ok: true, data: undefined });
    const [row] = await db.select().from(users).where(eq(users.id, person.user.id));
    expect(row!.name).toBe("Ada Lovelace");
  });

  test("signing out browsers never reaches another account's sessions", async () => {
    const person = await makeUser();
    const other = await makeUser();
    const mine = await signIn(person);
    const { token: myOther, session: myOtherSession } = await createSession(person.user.id, META);

    expect(await accountActions.revokeSessionAction(other.session.id)).toEqual({ ok: true, data: undefined });
    expect(await listSessions(other.user.id)).toHaveLength(1);

    const current = (await validateSessionToken(mine))!.session.id;
    expect(await accountActions.revokeSessionAction(current)).toEqual({ ok: false, error: "This is the browser you are using. Use “Sign out” to end it." });

    expect(await accountActions.revokeSessionAction(myOtherSession.id)).toEqual({ ok: true, data: undefined });
    expect(await validateSessionToken(myOther)).toBeNull();
    expect(await validateSessionToken(mine)).not.toBeNull();

    await createSession(person.user.id, META);
    await createSession(person.user.id, META);
    // Two just made plus the one makeUser created.
    expect(await accountActions.revokeOtherSessionsAction()).toEqual({ ok: true, data: { count: 3 } });
    expect(await listSessions(person.user.id)).toHaveLength(1);
    expect(await listSessions(other.user.id)).toHaveLength(1);
  });

  test("deleting the own account needs the typed address, refuses the last owner, then signs out", async () => {
    const owner = await makeUser({ role: "owner" });
    await signIn(owner);
    expect(await accountActions.deleteOwnAccountAction("wrong@example.com")).toEqual({ ok: false, error: "Type your e-mail address exactly as shown to confirm." });
    const lastOwner = await accountActions.deleteOwnAccountAction(owner.user.email);
    expect(lastOwner.ok).toBe(false);
    expect(await db.select().from(users).where(eq(users.id, owner.user.id))).toHaveLength(1);

    const member = await makeUser();
    await makeDevice(member.user.id);
    await signIn(member);
    await expect(accountActions.deleteOwnAccountAction(member.user.email.toUpperCase())).rejects.toBeInstanceOf(RedirectSignal);
    expect(state.redirects).toEqual(["/login?deleted=1"]);
    expect(await db.select().from(users).where(eq(users.id, member.user.id))).toHaveLength(0);
    expect(await db.select().from(devices)).toHaveLength(0);
  });
});

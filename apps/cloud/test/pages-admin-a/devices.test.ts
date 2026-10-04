import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { removeDeviceAction, setDeviceStatusAction } from "@/app/(app)/admin/devices/actions";
import { newId } from "@/server/crypto";
import { db, devices } from "@/server/db";
import { registerRelayHub, type RelayHubApi } from "@/server/relay-bridge";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { person, seed } from "./helpers";

const state = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", async () => (await import("./helpers")).nextHeadersMock(state));
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

const actAs = (token: string | null) => {
  state.token = token;
};

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

async function computer(userId: string): Promise<string> {
  const id = `dvc_${newId("x").slice(2)}`;
  await db.insert(devices).values({ id, userId, name: "Test Mac", instanceId: newId("gm"), secretHash: "0".repeat(64) });
  return id;
}

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
  actAs(null);
  registerRelayHub(hub);
  disconnect.mockClear();
});
afterEach(() => registerRelayHub(null));
afterAll(closeDatabase);

describe("permission checks", () => {
  test("devices.manage is required, also for the actor's own computers", async () => {
    const member = await person();
    const billing = await person({ role: "billing" });
    const own = await computer(member.ctx.user.id);
    expect(await setDeviceStatusAction(own, "disabled")).toMatchObject({ ok: false, error: /session has ended/ });
    actAs(member.token);
    expect(await setDeviceStatusAction(own, "disabled")).toMatchObject({ ok: false, error: /permission/ });
    expect(await removeDeviceAction(own)).toMatchObject({ ok: false, error: /permission/ });
    actAs(billing.token);
    expect(await removeDeviceAction(own)).toMatchObject({ ok: false, error: /permission/ });
    expect(await db.select().from(devices).where(eq(devices.id, own))).toHaveLength(1);
  });
});

describe("admins", () => {
  test("turn any computer off and on, and remove it", async () => {
    const admin = await person({ role: "admin" });
    const member = await person();
    const id = await computer(member.ctx.user.id);
    actAs(admin.token);

    expect(await setDeviceStatusAction(id, "disabled")).toEqual({ ok: true, data: undefined });
    expect((await db.select().from(devices).where(eq(devices.id, id)))[0]?.status).toBe("disabled");
    expect(disconnect).toHaveBeenCalledWith(id, expect.any(Number), expect.any(String));

    expect(await setDeviceStatusAction(id, "active")).toEqual({ ok: true, data: undefined });
    expect((await db.select().from(devices).where(eq(devices.id, id)))[0]?.status).toBe("active");

    expect(await removeDeviceAction(id)).toEqual({ ok: true, data: undefined });
    expect(await db.select().from(devices).where(eq(devices.id, id))).toHaveLength(0);
    expect(await removeDeviceAction(id)).toMatchObject({ ok: false, error: /no longer exists/ });
    // @ts-expect-error a status outside the union
    expect(await setDeviceStatusAction(id, "paused")).toMatchObject({ ok: false });
  });
});

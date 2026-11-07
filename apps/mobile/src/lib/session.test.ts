import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Connection } from "./session";

mock.module("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

const { giveUp, useSession } = await import("./session");

const pairing = (token: string, id: string): Connection => ({
  token,
  deviceId: `dev_${token}`,
  deviceName: "Phone",
  instance: { id, name: id, version: "1" } as Connection["instance"],
  urls: [`http://${id}`],
  activeUrl: `http://${id}`,
  peers: [],
  activeInstanceId: id,
  preferredInstanceId: null,
  pairedAt: "2026-11-07T00:00:00.000Z",
});

describe("a computer refuses the phone's key", () => {
  beforeEach(async () => {
    await useSession.getState().disconnect();
  });

  test("the current key: the phone was removed", async () => {
    await useSession.getState().connect(pairing("current", "gm_a"));
    expect(await useSession.getState().refused("current")).toBe(true);
    expect(useSession.getState().connection).toBeNull();
    expect(useSession.getState().endedBecause).toBe("removed");
  });

  test("a key from before pairing again: the new pairing stays", async () => {
    await useSession.getState().connect(pairing("old", "gm_a"));
    await useSession.getState().connect(pairing("new", "gm_b"));
    expect(await useSession.getState().refused("old")).toBe(false);
    expect(useSession.getState().connection?.token).toBe("new");
    expect(useSession.getState().endedBecause).toBeNull();
  });

  test("the key the phone is giving up itself: no message, it leaves on its own", async () => {
    await useSession.getState().connect(pairing("leaving", "gm_a"));
    giveUp("leaving");
    expect(await useSession.getState().refused("leaving")).toBe(false);
    expect(useSession.getState().connection?.token).toBe("leaving");
    await useSession.getState().connect(pairing("next", "gm_b"));
    expect(useSession.getState().endedBecause).toBeNull();
  });
});

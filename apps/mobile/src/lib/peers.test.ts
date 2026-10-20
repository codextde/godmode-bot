import { describe, expect, test } from "bun:test";
import { isPhoneUrlAllowed, type MobileInstance, type MobilePeer } from "@godmode/shared";
import { accepts, candidateOrder, computerOf, removedBy, withDefaults, withGroup, type Computers } from "./peers";

const instance = (id: string): MobileInstance => ({ id, name: `Mac ${id}`, version: "0.2.20", platform: "darwin" });
const peer = (id: string, role: MobilePeer["role"], urls: string[]): MobilePeer => ({ instance: instance(id), urls, role });

const HOME = ["http://home.tail1.ts.net:7787", "http://100.64.0.1:7787"];
const A = ["http://a.tail1.ts.net:7787", "http://100.64.0.2:7787"];
const C = ["http://c.tail1.ts.net:7787"];

/** Paired with "home", a secondary of A's group with C. */
function grouped(active: string, activeUrl: string): Computers {
  return {
    instance: instance("home"),
    urls: HOME,
    activeUrl,
    activeInstanceId: active,
    peers: [peer("a", "primary", A), peer("home", "secondary", HOME), peer("c", "secondary", C)],
  };
}

const order = (c: Computers) => candidateOrder(c).map(({ base, instanceId }) => `${instanceId} ${base}`);

describe("candidateOrder", () => {
  test("alone: the address that answered last, then the others", () => {
    const c: Computers = { instance: instance("home"), urls: HOME, activeUrl: `${HOME[1]}/`, activeInstanceId: "home", peers: [] };
    expect(order(c)).toEqual([`home ${HOME[1]}`, `home ${HOME[0]}`]);
  });

  test("the active computer first, then the primary, then the others", () => {
    expect(order(grouped("home", HOME[0]!))).toEqual([...HOME.map((u) => `home ${u}`), ...A.map((u) => `a ${u}`), `c ${C[0]}`]);
  });

  test("on another computer of the group: its address that answered first, then its others", () => {
    expect(order(grouped("c", "http://100.64.0.3:7787"))).toEqual([
      "c http://100.64.0.3:7787",
      `c ${C[0]}`,
      ...A.map((u) => `a ${u}`),
      ...HOME.map((u) => `home ${u}`),
    ]);
  });

  test("on the primary: then the paired computer, then the others", () => {
    expect(order(grouped("a", A[1]!))).toEqual([`a ${A[1]}`, `a ${A[0]}`, ...HOME.map((u) => `home ${u}`), `c ${C[0]}`]);
  });

  test("the paired computer as the primary comes right after the active one", () => {
    const c = grouped("c", C[0]!);
    c.peers = [peer("a", "secondary", A), peer("home", "primary", HOME), peer("c", "secondary", C)];
    expect(order(c)).toEqual([`c ${C[0]}`, ...HOME.map((u) => `home ${u}`), ...A.map((u) => `a ${u}`)]);
  });

  test("an active computer that left the group falls back to the paired one", () => {
    expect(order(grouped("gone", HOME[0]!))[0]).toBe(`home ${HOME[0]}`);
  });

  test("an address listed twice is tried once, for the computer listed first", () => {
    const c = grouped("home", HOME[0]!);
    c.peers = [peer("a", "primary", [HOME[0]!, ...A])];
    expect(order(c)).toEqual([...HOME.map((u) => `home ${u}`), ...A.map((u) => `a ${u}`)]);
  });
});

describe("accepts", () => {
  test("the paired computer and every computer of its group", () => {
    const c = grouped("home", HOME[0]!);
    expect(["home", "a", "c"].map((id) => accepts(c, id))).toEqual([true, true, true]);
  });

  test("no other Godmode, and no answer without an id", () => {
    const c = grouped("home", HOME[0]!);
    expect(accepts(c, "stranger")).toBe(false);
    expect(accepts(c, undefined)).toBe(false);
    expect(accepts(c, "")).toBe(false);
  });

  test("alone: only the paired computer", () => {
    const c: Computers = { instance: instance("home"), urls: HOME, activeUrl: HOME[0]!, activeInstanceId: "home", peers: [] };
    expect(accepts(c, "home")).toBe(true);
    expect(accepts(c, "a")).toBe(false);
  });
});

describe("removedBy", () => {
  test("the paired computer and the primary say the phone was removed", () => {
    const c = grouped("c", C[0]!);
    expect(removedBy(c, "home")).toBe(true);
    expect(removedBy(c, "a")).toBe(true);
  });

  test("another secondary only may not have the key yet", () => {
    expect(removedBy(grouped("c", C[0]!), "c")).toBe(false);
  });

  test("the primary as listed now", () => {
    const c = grouped("home", HOME[0]!);
    c.peers = [peer("a", "secondary", A), peer("home", "secondary", HOME), peer("c", "primary", C)];
    expect(removedBy(c, "a")).toBe(false);
    expect(removedBy(c, "c")).toBe(true);
  });

  test("alone: the paired computer", () => {
    const c: Computers = { instance: instance("home"), urls: HOME, activeUrl: HOME[0]!, activeInstanceId: "home", peers: [] };
    expect(removedBy(c, "home")).toBe(true);
    expect(removedBy(c, "a")).toBe(false);
  });
});

describe("withGroup", () => {
  test("computers no longer listed are dropped, the paired one stays", () => {
    const next = withGroup(grouped("home", HOME[0]!), [peer("a", "primary", A), peer("home", "secondary", HOME)], isPhoneUrlAllowed);
    expect(next.peers.map((p) => p.instance.id)).toEqual(["a", "home"]);
    expect(accepts(next, "c")).toBe(false);
    expect(accepts(next, "home")).toBe(true);
    expect(next.instance.id).toBe("home");
  });

  test("addresses the key may not go to are left out; the rest without trailing slashes, once", () => {
    const next = withGroup(grouped("home", HOME[0]!), [peer("a", "primary", ["http://192.168.1.5:7787", `${A[0]}/`, A[0]!, "https://cloud.example/gw/a"])], isPhoneUrlAllowed);
    expect(next.peers[0]!.urls).toEqual([A[0]!, "https://cloud.example/gw/a"]);
  });

  test("the active computer stays while listed", () => {
    const next = withGroup(grouped("c", C[0]!), [peer("a", "primary", A), peer("c", "secondary", C)], isPhoneUrlAllowed);
    expect(next.activeInstanceId).toBe("c");
    expect(next.activeUrl).toBe(C[0]!);
  });

  test("an active computer that is dropped hands back to the paired one", () => {
    const next = withGroup(grouped("c", C[0]!), [peer("a", "primary", A)], isPhoneUrlAllowed);
    expect(next.activeInstanceId).toBe("home");
    expect(next.activeUrl).toBe(HOME[0]!);
  });

  test("no group (an older Godmode, or not in one): only the paired computer", () => {
    const next = withGroup(grouped("home", HOME[1]!), undefined, isPhoneUrlAllowed);
    expect(next.peers).toEqual([]);
    expect(next.activeUrl).toBe(HOME[1]!);
    expect(order(next)).toEqual([`home ${HOME[1]}`, `home ${HOME[0]}`]);
  });

  test("entries without an id are skipped, a repeated one counts once, an unknown role is a secondary", () => {
    const next = withGroup(
      grouped("home", HOME[0]!),
      [null, { urls: A }, { instance: instance("a"), urls: A, role: "boss" }, peer("a", "primary", A)],
      isPhoneUrlAllowed,
    );
    expect(next.peers.map((p) => `${p.instance.id} ${p.role}`)).toEqual(["a secondary"]);
  });

  test("a computer listed without a name is still one of the group", () => {
    const next = withGroup(grouped("home", HOME[0]!), [{ instance: { id: "a" }, urls: A, role: "primary" }], isPhoneUrlAllowed);
    expect(next.peers[0]!.instance.name).toBe("Godmode");
    expect(accepts(next, "a")).toBe(true);
  });
});

describe("withDefaults", () => {
  test("a pairing stored before device groups", () => {
    const stored = { token: "gmd_x", instance: instance("home"), urls: HOME, activeUrl: HOME[0]! };
    const c = withDefaults(stored);
    expect(c.peers).toEqual([]);
    expect(c.activeInstanceId).toBe("home");
    expect(c.token).toBe("gmd_x");
  });

  test("a stored group stays", () => {
    const c = withDefaults(grouped("c", C[0]!));
    expect(c.activeInstanceId).toBe("c");
    expect(c.peers).toHaveLength(3);
  });
});

test("computerOf falls back to the paired computer", () => {
  const c = grouped("home", HOME[0]!);
  expect(computerOf(c, "a").role).toBe("primary");
  expect(computerOf(c, "home").role).toBe("secondary");
  expect(computerOf(c, "gone").instance.id).toBe("home");
  expect(computerOf(c, null).instance.id).toBe("home");
});

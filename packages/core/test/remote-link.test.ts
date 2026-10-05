import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { parseRunnerCode, parseRunnerOffer, type RunnerPairingCode, type ServerEvent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, all, getMeta, openDb, setMeta } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { generateKeyPair } from "../src/remote/crypto";
import { RemoteLink, type LinkState } from "../src/remote/linkClient";
import { forgetController, startLinkServer, stopLinkServer } from "../src/remote/linkServer";
import { setTailscaleOverride } from "../src/mobile/tailscale";
import { cancelOffer, createOffer, createRunnerCode, deliverCode, offerAddresses } from "../src/remote/pairing";
import { getAccessToken } from "../src/server/auth";
import { websocketHandler } from "../src/server/ws";
import { HttpError, sleep } from "../src/util";

let dataDir: string;
let port: number;
const app = new Hono();
const controller = generateKeyPair();
let code: RunnerPairingCode;
const links: RemoteLink[] = [];

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as 400);
  return c.json({ error: String(err) }, 500);
});
app.get("/api/echo", (c) => c.json({ query: c.req.query("q") ?? null, auth: c.req.header("authorization") === `Bearer ${getAccessToken()}`, cookie: c.req.header("cookie") ?? null }));
app.post("/api/echo", async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  let sum = 0;
  for (const b of bytes) sum = (sum + b) % 65521;
  return c.json({ length: bytes.length, sum, type: c.req.header("content-type") ?? null });
});
app.get("/api/slow", async (c) => {
  await sleep(3_000);
  return c.json({ ok: true });
});
app.get("/api/missing", () => {
  throw new HttpError(404, "Nothing here", "not_found");
});

async function until(cond: () => boolean, timeoutMs = 10_000, what = "condition") {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

function session(identity = controller, events: ServerEvent[] = [], states: LinkState[] = []): RemoteLink {
  const link = new RemoteLink({
    identity,
    runnerKey: code.key,
    addresses: ["127.0.0.1"],
    port,
    name: "Test runner",
    ownName: "Test controller",
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
  });
  links.push(link);
  link.start();
  return link;
}

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-link-"));
  loadConfig({ dataDir, role: "runner" });
  openDb(join(dataDir, "godmode.db"));
  setMeta("link.port", "0");
  port = startLinkServer({ app, websocket: websocketHandler })!;
  expect(port).toBeGreaterThan(0);
  code = { ...parseRunnerCode((await createRunnerCode()).code)!, addresses: ["127.0.0.1"] };
});

afterAll(() => {
  for (const l of links) l.stop();
  stopLinkServer();
  cancelOffer();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("pairing", () => {
  test("the listener writes the port it got back, and the code carries it", () => {
    expect(Number(getMeta("link.port"))).toBe(port);
    expect(code.port).toBe(port);
  });

  test("a code pairs this computer once", async () => {
    const result = await RemoteLink.pair({ identity: controller, code, name: "Test controller" });
    expect(result.address).toBe("127.0.0.1");
    expect(result.info.protocol).toBe(1);
    const rows = all<{ name: string; public_key: string }>("SELECT name, public_key FROM link_controllers");
    expect(rows).toEqual([{ name: "Test controller", public_key: controller.publicKey }]);
    expect(getMeta("link.pairing")).toBeNull();

    const again = RemoteLink.pair({ identity: generateKeyPair(), code, name: "Someone else" });
    await expect(again).rejects.toMatchObject({ code: "pairing_invalid" });
    expect(all("SELECT id FROM link_controllers")).toHaveLength(1);
  });

  test("an expired code is refused before dialing", async () => {
    const fresh = { ...parseRunnerCode((await createRunnerCode()).code)!, addresses: ["127.0.0.1"], exp: Math.floor(Date.now() / 1000) - 1 };
    await expect(RemoteLink.pair({ identity: generateKeyPair(), code: fresh, name: "Late" })).rejects.toMatchObject({ code: "pairing_expired" });
  });

  test("a code whose time ran out on the runner is refused by the runner", async () => {
    const fresh = { ...parseRunnerCode((await createRunnerCode()).code)!, addresses: ["127.0.0.1"] };
    const stored = JSON.parse(getMeta("link.pairing")!) as { exp: number };
    setMeta("link.pairing", JSON.stringify({ ...stored, exp: Date.now() - 1 }));
    await expect(RemoteLink.pair({ identity: generateKeyPair(), code: fresh, name: "Late" })).rejects.toMatchObject({ code: "pairing_invalid" });
  });
});

describe("a session", () => {
  const events: ServerEvent[] = [];
  const states: LinkState[] = [];
  let link: RemoteLink;

  beforeAll(async () => {
    link = session(controller, events, states);
    await until(() => link.state.state === "online", 10_000, "online");
  });

  test("carries a GET with its query into the runner's API, with the runner's own token", async () => {
    const res = await link.request("GET", "/api/echo?q=hello", { headers: { authorization: "Bearer stolen", cookie: "gm_session=x" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(Buffer.from(res.body).toString())).toEqual({ query: "hello", auth: true, cookie: null });
  });

  test("carries a 3 MiB body intact", async () => {
    const body = new Uint8Array(3 * 1024 * 1024);
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      body[i] = (i * 31) & 255;
      sum = (sum + body[i]!) % 65521;
    }
    const answer = await link.json<{ length: number; sum: number }>("POST", "/api/echo", undefined).catch(() => null);
    expect(answer?.length).toBe(0);
    const res = await link.request("POST", "/api/echo", { body, headers: { "content-type": "application/octet-stream" } });
    expect(JSON.parse(Buffer.from(res.body).toString())).toEqual({ length: body.length, sum, type: "application/octet-stream" });
  });

  test("an error of the runner comes back as its own status, message and code", async () => {
    const err = await link.json("GET", "/api/missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 404, message: "Nothing here", code: "not_found" });
  });

  test("only the API is reachable, and never its sign-in routes", async () => {
    expect((await link.request("GET", "/index.html")).status).toBe(400);
    expect((await link.request("POST", "/api/auth/login")).status).toBe(400);
    // The same routes, spelled so that a plain prefix check would miss them.
    for (const path of ["/api/../api/auth/login", "/api/%61uth/login", "/api/echo/../auth/login", "//evil.example/api/echo", "http://evil.example/api/echo"]) {
      expect((await link.request("POST", path)).status).toBe(400);
    }
    expect((await link.request("GET", "/api/echo?q=still%20fine")).status).toBe(200);
  });

  test("events of the runner reach the controller, and the controller's client events reach the runner's hub", async () => {
    expect(events.some((e) => e.type === "hello")).toBe(true);
    bus.emit({ type: "entity.changed", entity: "runs" });
    await until(() => events.some((e) => e.type === "entity.changed"), 5_000, "entity.changed");
    link.sendClientEvent({ type: "ping" });
    await until(() => events.some((e) => (e as { type: string }).type === "pong"), 5_000, "pong");
  });

  test("an event larger than a frame arrives whole", async () => {
    const big = "x".repeat(1_500_000);
    bus.emit({ type: "notification", notification: { id: "ntf_big", kind: "info", title: "Big", body: big, link: null, read: false, createdAt: new Date().toISOString() } });
    await until(() => events.some((e) => e.type === "notification" && e.notification.id === "ntf_big"), 10_000, "big event");
    const got = events.find((e) => e.type === "notification" && e.notification.id === "ntf_big");
    expect(got?.type === "notification" && got.notification.body.length).toBe(big.length);
  });

  test("the link measures how long the runner takes to answer", async () => {
    await until(() => link.state.latencyMs !== null, 5_000, "latency");
    expect(link.state.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("a controller the runner doesn't know is refused", async () => {
    const stranger = session(generateKeyPair());
    await until(() => stranger.state.error !== null, 10_000, "refusal");
    expect(stranger.state.state).toBe("offline");
    expect(stranger.state.error).toContain("doesn't know this computer");
    stranger.stop();
  });

  test("when the runner goes away, waiting requests fail as offline and the link comes back with it", async () => {
    const slow = link.request("GET", "/api/slow");
    await sleep(100);
    stopLinkServer();
    await expect(slow).rejects.toMatchObject({ code: "runner_offline" });
    await until(() => link.state.state !== "online", 5_000, "offline");
    await expect(link.request("GET", "/api/echo")).rejects.toMatchObject({ code: "runner_offline" });

    expect(startLinkServer({ app, websocket: websocketHandler })).toBe(port);
    await until(() => link.state.state === "online", 15_000, "back online");
    expect((await link.request("GET", "/api/echo")).status).toBe(200);
  });

  test("a controller the runner forgot can't come back", async () => {
    const id = all<{ id: string }>("SELECT id FROM link_controllers")[0]!.id;
    forgetController(id);
    await until(() => link.state.state !== "online", 5_000, "dropped");
    await until(() => link.state.error?.includes("doesn't know this computer") ?? false, 10_000, "refused");
  });
});

describe("pairing offers", () => {
  test("the runner delivers its code sealed; a wrong token gets nothing; the listener stops afterwards", async () => {
    const received: string[] = [];
    const offer = await createOffer(async (c) => {
      received.push(c);
      return { name: "Controller" };
    });
    const payload = parseRunnerOffer(/GODMODE_PAIR=(\S+)/.exec(offer.websiteCommand)![1]!)!;
    expect(payload.urls).toEqual(offer.urls);
    const loopback = offer.urls.filter((u) => u.startsWith("http://127.0.0.1:"));
    expect(loopback).toHaveLength(1);
    const { code: runnerCode } = await createRunnerCode();

    const forged = await deliverCode({ ...payload, urls: loopback, token: Buffer.alloc(32, 7).toString("base64url") }, runnerCode);
    expect(forged.ok).toBe(false);
    expect(received).toHaveLength(0);

    const ok = await deliverCode({ ...payload, urls: loopback }, runnerCode);
    expect(ok).toEqual({ ok: true, name: "Controller" });
    expect(received).toEqual([runnerCode]);

    const after = await deliverCode({ ...payload, urls: loopback }, runnerCode);
    expect(after.ok).toBe(false);
    expect(received).toHaveLength(1);
  });

  test("the offer lists this computer's networks, Tailscale with its MagicDNS name, and the code arrives through any of them", async () => {
    const ts = { installed: true, running: true, ip: "100.101.102.103", dnsName: "studio.tail1234.ts.net", tailnet: "me@example.com", detail: null };
    const nic = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null });
    const routes = offerAddresses(ts, {
      lo0: [nic("127.0.0.1", true)],
      utun4: [nic("100.101.102.103")],
      bridge100: [nic("192.168.64.1")],
      en0: [nic("192.168.68.56"), nic("169.254.10.2")],
    });
    expect(routes).toEqual([
      { network: "lan", address: "192.168.68.56", detail: "en0" },
      { network: "vm", address: "192.168.64.1", detail: "bridge100" },
      { network: "tailscale", address: "100.101.102.103", detail: "studio.tail1234.ts.net" },
    ]);
    expect(offerAddresses(ts, { en0: [nic("10.0.0.4")] }).at(-1)).toEqual({ network: "tailscale", address: "100.101.102.103", detail: "studio.tail1234.ts.net" });
    expect(offerAddresses({ ...ts, running: false, ip: null }, { en0: [nic("10.0.0.4")] })).toHaveLength(1);

    setTailscaleOverride(ts);
    try {
      const from: (string | null)[] = [];
      const offer = await createOffer(async (_c, via) => {
        from.push(via);
        return { name: "Controller" };
      });
      expect(offer.tailscale.dnsName).toBe("studio.tail1234.ts.net");
      expect(offer.routes.at(-1)).toMatchObject({ network: "tailscale", address: "100.101.102.103", detail: "studio.tail1234.ts.net" });
      expect(offer.routes.map((r) => r.url)).toEqual(offer.urls.slice(0, offer.routes.length));
      const payload = parseRunnerOffer(/GODMODE_PAIR=(\S+)/.exec(offer.websiteCommand)![1]!)!;
      const { code: runnerCode } = await createRunnerCode();
      expect(await deliverCode({ ...payload, urls: offer.urls.filter((u) => u.startsWith("http://127.0.0.1:")) }, runnerCode)).toEqual({ ok: true, name: "Controller" });
      expect(from).toEqual(["127.0.0.1"]);
    } finally {
      setTailscaleOverride(null);
      cancelOffer();
    }
  });

  test("an expired offer is not delivered", async () => {
    const offer = await createOffer(async () => ({ name: "Controller" }));
    const payload = parseRunnerOffer(/GODMODE_PAIR=(\S+)/.exec(offer.websiteCommand)![1]!)!;
    const result = await deliverCode({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 }, "gmr1.x");
    expect(result.ok).toBe(false);
    cancelOffer();
  });

  test("outside a compiled build there is no self-hosted install command, the website one is always there", async () => {
    const offer = await createOffer(async () => ({ name: "Controller" }));
    expect(offer.command).toBeNull();
    expect(offer.websiteCommand).toStartWith("curl -fsSL https://usegodmode.com/runner.sh | GODMODE_LICENSE=");
    cancelOffer();
  });
});

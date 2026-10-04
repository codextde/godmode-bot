import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeRunnerCode,
  encodeRunnerOffer,
  parseRunnerCode,
  parseRunnerOffer,
  parseRunnerView,
  RUNNER_CODE_PREFIX,
  RUNNER_OFFER_PREFIX,
  runnerView,
  type RunnerPairingCode,
  type RunnerPairingOfferPayload,
} from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";

const CODE: RunnerPairingCode = {
  v: 1,
  name: "Büro Mac mini ✨",
  hostname: "mac-mini",
  addresses: ["192.168.1.20", "100.101.102.103", "mac-mini.local"],
  port: 7788,
  key: "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA",
  id: "pair_3fA9xQ2LmT7c",
  secret: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I",
  exp: 1_790_000_000,
};

const OFFER: RunnerPairingOfferPayload = {
  v: 1,
  id: "offer_8Hq2ZpK4wN1d",
  token: "dG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG8",
  urls: ["http://192.168.1.10:51234", "http://100.64.0.7:51234"],
  name: "Daniels MacBook Pro",
  exp: 1_790_000_600,
};

/** A payload the encoders would never produce, in the same wire format. */
const raw = (prefix: string, payload: unknown) => prefix + Buffer.from(JSON.stringify(payload)).toString("base64url");

/** The way a terminal or a chat app hands a long code back: indented, wrapped, with a trailing line break. */
const wrapped = (text: string) => `  ${text.replace(/(.{40})/g, "$1\r\n   ")} \n`;

describe("pairing codes", () => {
  test("round-trip, including names that aren't ASCII", () => {
    const text = encodeRunnerCode(CODE);
    expect(text.startsWith(RUNNER_CODE_PREFIX)).toBe(true);
    expect(text).toBe(raw(RUNNER_CODE_PREFIX, CODE));
    expect(parseRunnerCode(text)).toEqual(CODE);
  });

  test("are read with the spaces and line breaks a paste adds", () => {
    const text = wrapped(encodeRunnerCode(CODE));
    expect(text).toContain("\r\n");
    expect(parseRunnerCode(text)).toEqual(CODE);
  });

  test("keep only the fields of a code", () => {
    expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, { ...CODE, extra: "x" }))).toEqual(CODE);
  });

  test("reject junk, another prefix and another version", () => {
    expect(parseRunnerCode("")).toBeNull();
    expect(parseRunnerCode("hello")).toBeNull();
    expect(parseRunnerCode(RUNNER_CODE_PREFIX)).toBeNull();
    expect(parseRunnerCode(`${RUNNER_CODE_PREFIX}not base64url!`)).toBeNull();
    expect(parseRunnerCode(`${RUNNER_CODE_PREFIX}${Buffer.from("not json").toString("base64url")}`)).toBeNull();
    expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, [CODE]))).toBeNull();
    expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, null))).toBeNull();
    expect(parseRunnerCode(encodeRunnerOffer(OFFER))).toBeNull();
    expect(parseRunnerCode(raw("gmr2.", CODE))).toBeNull();
    expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, { ...CODE, v: 2 }))).toBeNull();
    expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, { ...CODE, v: "1" }))).toBeNull();
  });

  test("reject a code with a missing or mistyped field", () => {
    for (const field of Object.keys(CODE) as (keyof RunnerPairingCode)[]) {
      const { [field]: _dropped, ...rest } = CODE;
      expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, rest))).toBeNull();
    }
    const bad: Record<string, unknown>[] = [
      { name: "" },
      { name: 7 },
      { hostname: "" },
      { addresses: "192.168.1.20" },
      { addresses: ["192.168.1.20", 5] },
      { addresses: [""] },
      { port: 0 },
      { port: 65536 },
      { port: 7788.5 },
      { port: "7788" },
      { key: "" },
      { key: null },
      { id: "" },
      { secret: "" },
      { exp: "1790000000" },
      { exp: null },
    ];
    for (const change of bad) expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, { ...CODE, ...change }))).toBeNull();
    expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, { ...CODE, port: 1 }))?.port).toBe(1);
    expect(parseRunnerCode(raw(RUNNER_CODE_PREFIX, { ...CODE, port: 65535 }))?.port).toBe(65535);
  });
});

describe("pairing offers", () => {
  test("round-trip", () => {
    const text = encodeRunnerOffer(OFFER);
    expect(text.startsWith(RUNNER_OFFER_PREFIX)).toBe(true);
    expect(text).toBe(raw(RUNNER_OFFER_PREFIX, OFFER));
    expect(parseRunnerOffer(text)).toEqual(OFFER);
  });

  test("are read with the spaces and line breaks a paste adds", () => {
    expect(parseRunnerOffer(wrapped(encodeRunnerOffer(OFFER)))).toEqual(OFFER);
  });

  test("reject junk, another prefix and another version", () => {
    expect(parseRunnerOffer("")).toBeNull();
    expect(parseRunnerOffer("gmo1")).toBeNull();
    expect(parseRunnerOffer(`${RUNNER_OFFER_PREFIX}%%%`)).toBeNull();
    expect(parseRunnerOffer(`${RUNNER_OFFER_PREFIX}${Buffer.from("{").toString("base64url")}`)).toBeNull();
    expect(parseRunnerOffer(encodeRunnerCode(CODE))).toBeNull();
    expect(parseRunnerOffer(raw(RUNNER_OFFER_PREFIX, { ...OFFER, v: 2 }))).toBeNull();
  });

  test("reject an offer with a missing or mistyped field", () => {
    for (const field of Object.keys(OFFER) as (keyof RunnerPairingOfferPayload)[]) {
      const { [field]: _dropped, ...rest } = OFFER;
      expect(parseRunnerOffer(raw(RUNNER_OFFER_PREFIX, rest))).toBeNull();
    }
    const bad: Record<string, unknown>[] = [
      { id: "" },
      { token: "" },
      { token: 1 },
      { urls: "http://192.168.1.10:51234" },
      { urls: [null] },
      { name: "" },
      { exp: "soon" },
    ];
    for (const change of bad) expect(parseRunnerOffer(raw(RUNNER_OFFER_PREFIX, { ...OFFER, ...change }))).toBeNull();
  });
});

describe("runner views", () => {
  test("carry the runner and its own view name", () => {
    expect(runnerView("rnr_abc", "display:1")).toBe("runner:rnr_abc:display:1");
    expect(parseRunnerView(runnerView("rnr_abc", "display:1"))).toEqual({ runnerId: "rnr_abc", view: "display:1" });
    expect(parseRunnerView(runnerView("rnr_abc", "window:812:4711"))).toEqual({ runnerId: "rnr_abc", view: "window:812:4711" });
  });

  test("a local view is not a runner's", () => {
    expect(parseRunnerView("display:1")).toBeNull();
    expect(parseRunnerView("window:812:4711")).toBeNull();
    expect(parseRunnerView("runner:")).toBeNull();
    expect(parseRunnerView("runner:rnr_abc")).toBeNull();
    expect(parseRunnerView("runner:rnr_abc:")).toBeNull();
    expect(parseRunnerView("runner::display:1")).toBeNull();
  });
});

describe("a fresh installation", () => {
  let dir: string;
  let db: Database;
  const role = process.env.GODMODE_ROLE;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "godmode-remote-contract-test-"));
    loadConfig({ dataDir: dir, token: "test-token" });
    db = openDb(join(dir, "test.db"));
  });

  afterAll(() => {
    if (role === undefined) delete process.env.GODMODE_ROLE;
    else process.env.GODMODE_ROLE = role;
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const columns = (table: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  test("has the tables for runners, controllers and synced memory", () => {
    expect(columns("runners")).toEqual([
      "id",
      "name",
      "hostname",
      "public_key",
      "addresses",
      "port",
      "platform",
      "arch",
      "version",
      "sync_browser",
      "last_address",
      "last_seen_at",
      "synced_at",
      "sync_digest",
      "sync_error",
      "created_at",
      "updated_at",
    ]);
    expect(columns("link_controllers")).toEqual(["id", "name", "public_key", "last_seen_at", "last_address", "created_at"]);
    expect(columns("runner_memory")).toEqual(["runner_id", "agent_id", "digest", "snapshot", "updated_at"]);
    expect(db.query<{ id: number; name: string }, []>("SELECT id, name FROM _migrations WHERE name = 'runners'").get()).toEqual({ id: 60, name: "runners" });
  });

  test("remembers for every chat which runner it works on", () => {
    const names = columns("conversations");
    for (const column of ["runner_id", "runner_state", "runner_tools_id"]) expect(names).toContain(column);
    const indexes = db.query<{ name: string }, []>("PRAGMA index_list(conversations)").all().map((i) => i.name);
    expect(indexes).toContain("idx_conversations_runner");
  });

  test("is the main Godmode unless it is started as a runner", () => {
    delete process.env.GODMODE_ROLE;
    expect(loadConfig({ dataDir: dir }).role).toBe("main");
    expect(loadConfig({ dataDir: dir, role: "runner" }).role).toBe("runner");
    process.env.GODMODE_ROLE = "runner";
    expect(loadConfig({ dataDir: dir }).role).toBe("runner");
    process.env.GODMODE_ROLE = "something";
    expect(loadConfig({ dataDir: dir }).role).toBe("main");
  });
});

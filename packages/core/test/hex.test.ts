import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { findHex, hexLanguage, hexStatus, prepareHex, stopHex } from "../src/voice/hex";
import { canInstallHex, managedHex } from "../src/voice/hexInstall";
import { transcribe } from "../src/voice/voice";
import { HttpError } from "../src/util";

const SERVICE = "http://127.0.0.1:59999";
let dir: string;
let fake: string;
let installed = true;
const realFetch = globalThis.fetch;
const calls: { url: URL; auth: string | null; type: string | null; bytes: number }[] = [];

function wav(): Blob {
  const out = new DataView(new ArrayBuffer(44 + 3200));
  [..."RIFF"].forEach((c, i) => out.setUint8(i, c.charCodeAt(0)));
  [..."WAVE"].forEach((c, i) => out.setUint8(8 + i, c.charCodeAt(0)));
  return new Blob([out.buffer], { type: "audio/wav" });
}

async function httpError(fn: () => unknown): Promise<HttpError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

beforeAll(() => {
  setLogLevel("error");
  dir = mkdtempSync(join(tmpdir(), "godmode-hex-"));
  loadConfig({ dataDir: dir });
  openDb(join(dir, "test.db"));
  resetSettingsCache();
  mkdirSync(join(dir, "Hex.app", "Contents", "MacOS"), { recursive: true });
  fake = join(dir, "Hex.app", "Contents", "MacOS", "hex");
  writeFileSync(fake, `#!/bin/sh\necho '{"type":"ready","url":"${SERVICE}","token":"tok","apiVersion":"2","pid":'$$'}'\ncat >/dev/null\n`);
  chmodSync(fake, 0o755);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    calls.push({ url, auth: req.headers.get("authorization"), type: req.headers.get("content-type"), bytes: (await req.arrayBuffer()).byteLength });
    if (url.hostname === "github.com") return new Response("not the real hex", { headers: { "content-length": "16" } });
    if (url.pathname === "/models") return Response.json([{ id: "parakeet_v3", installed, downloadBytes: 739508576, languages: ["en", "de"] }]);
    if (url.pathname === "/health") return Response.json({ version: "3.0.0", apiVersion: "2" });
    if (url.pathname === "/models/parakeet_v3/prepare") {
      return new Response('data: {"type":"loading"}\n\n: keep-alive\n\ndata: {"type":"ok"}\n\n', { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/transcriptions") return Response.json({ transcript: " Hallo Welt ", durationMs: 120 });
    return new Response("unmocked", { status: 500 });
  }) as typeof fetch;
});

beforeEach(async () => {
  await stopHex();
  calls.length = 0;
  installed = true;
  updateSettings({ voice: { sttProvider: "hex", hexPath: join(dir, "Hex.app"), hexModel: "parakeet_v3", language: "de-DE" } });
});

afterAll(async () => {
  await stopHex();
  globalThis.fetch = realFetch;
  closeDb();
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("hex", () => {
  test("languages are English or German", () => {
    expect(hexLanguage("de-DE")).toBe("de");
    expect(hexLanguage("en_GB")).toBe("en");
    expect(hexLanguage("fr-FR")).toBe("en");
    expect(hexLanguage("")).toBe("en");
  });

  test("a Hex.app or its program is found, anything else is not", () => {
    expect(findHex(join(dir, "Hex.app"))).toBe(fake);
    expect(findHex(fake)).toBe(fake);
    expect(findHex(join(dir, "missing"))).toBeNull();
  });

  test("dictation goes to the local Hex service with the token, model and language", async () => {
    expect(await transcribe(wav(), { language: "de-DE" })).toEqual({ text: "Hallo Welt" });
    const prepare = calls.find((c) => c.url.pathname.endsWith("/prepare"))!;
    expect(prepare.url.searchParams.get("language")).toBe("de");
    const sent = calls.find((c) => c.url.pathname === "/transcriptions")!;
    expect(sent.auth).toBe("Bearer tok");
    expect(sent.type).toBe("audio/wav");
    expect(sent.bytes).toBe(3244);
    expect(Object.fromEntries(sent.url.searchParams)).toEqual({ model: "parakeet_v3", language: "de" });
    calls.length = 0;
    await transcribe(wav(), { language: "de-DE" });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/transcriptions"]);
  });

  test("a missing model starts its download, a wrong location and other audio are explained", async () => {
    installed = false;
    const missing = await httpError(() => transcribe(wav()));
    expect(missing.status).toBe(503);
    expect(missing.code).toBe("hex_preparing");
    await Bun.sleep(20);
    expect(calls.some((c) => c.url.pathname.endsWith("/prepare"))).toBe(true);
    expect(calls.some((c) => c.url.pathname === "/transcriptions")).toBe(false);
    expect((await httpError(() => transcribe(new Blob(["not audio at all"], { type: "audio/webm" })))).message).toContain("WAV");
    updateSettings({ voice: { hexPath: join(dir, "nowhere") } });
    expect((await httpError(() => transcribe(wav()))).message).toContain("Hex wasn't found at");
    expect(await hexStatus()).toMatchObject({ path: null, canInstall: false });
  });

  test("status reports the app, its version and the model", async () => {
    installed = false;
    expect(await hexStatus()).toMatchObject({ path: fake, version: "3.0.0", model: "parakeet_v3", installed: false, downloadBytes: 739508576, canInstall: false, progress: null, error: null });
  });

  test("without Hex, Godmode offers to install it and refuses a download that fails its checksum", async () => {
    updateSettings({ voice: { hexPath: "" } });
    if (findHex()) return;
    const status = await hexStatus();
    expect(status.canInstall).toBe(canInstallHex());
    if (!status.canInstall) return;
    expect(status.appBytes).toBeGreaterThan(0);
    await expect(prepareHex()).rejects.toThrow("checksum");
    expect(calls.some((c) => c.url.hostname === "github.com")).toBe(true);
    expect(managedHex()).toBeNull();
    expect((await hexStatus()).error).toContain("checksum");
  });
});

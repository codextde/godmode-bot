/**
 * End-to-end: the browser-use MCP server Godmode configures for an agent must drive Godmode's managed
 * Chromium (via cdp_url), not a browser of its own, and that browser only starts on the first browser tool call.
 * Needs uvx, a Chromium-family browser and network access
 * (downloads browser-use on first run and opens https://example.com), so it only runs with GODMODE_E2E=1:
 *
 *   GODMODE_E2E=1 bun test test/browser-mcp.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { config, loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { findChrome } from "../src/browser/chrome";
import { listPages } from "../src/browser/cdp";
import { getRunning } from "../src/browser/state";
import { resolveUvx } from "../src/services/doctor";
import * as manager from "../src/browser/manager";
import { createApp } from "../src/server/app";

const enabled = process.env.GODMODE_E2E === "1" && !!findChrome() && !!resolveUvx();
const suite = enabled ? describe : describe.skip;

/** Minimal newline-delimited JSON-RPC client for an MCP stdio server. */
class StdioMcp {
  private buffer = "";
  private waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  private nextId = 1;
  stderr = "";

  constructor(private proc: ReturnType<typeof Bun.spawn>) {
    void this.pump();
    void (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderr = (this.stderr + dec.decode(value)).slice(-8000);
      }
    })();
  }

  private async pump() {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (typeof msg.id === "number") this.waiters.get(msg.id)?.(msg);
        } catch {
          /* non-JSON noise on stdout */
        }
      }
    }
  }

  private write(obj: unknown) {
    const sink = this.proc.stdin as import("bun").FileSink;
    sink.write(JSON.stringify(obj) + "\n");
    sink.flush();
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr:\n${this.stderr}`)), timeoutMs);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(msg);
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }
}

suite("browser-use MCP drives the managed Chromium", () => {
  let dataDir = "";
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let http: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "godmode-mcp-e2e-"));
    const cfg = loadConfig({ dataDir });
    openDb(cfg.dbPath);
    manager.ensureDefaultProfile();
    const app = createApp();
    http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => app.fetch(req, { server: srv }) });
    config().port = http.port!;
  });

  afterAll(async () => {
    try {
      proc?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await manager.shutdownBrowsers();
    http?.stop(true);
    closeDb();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  test("initialize → tools/list → browser_navigate lands in OUR browser", async () => {
    const agent = {
      id: "agt_e2e",
      workspaceId: null,
      repoPath: join(dataDir, "agents", "e2e"),
      browser: { profileId: null, enabled: true, headless: true },
    } as unknown as Agent;

    const server = await manager.browserMcpServer(agent);
    expect(server).not.toBeNull();
    if (!server || !("command" in server)) throw new Error("expected a stdio server");
    expect(server.args).toEqual(["--from", "browser-use==0.13.10", "browser-use", "--mcp"]);
    const env = server.env!;
    expect(env.ANONYMIZED_TELEMETRY).toBe("false");
    const profile = manager.resolveProfileForAgent(agent);
    expect(getRunning(profile.id)).toBeNull();

    const configJson = JSON.parse(readFileSync(join(env.BROWSER_USE_CONFIG_DIR!, "config.json"), "utf8"));
    const entry = Object.values(configJson.browser_profile)[0] as Record<string, unknown>;
    expect(entry.cdp_url).toStartWith(`http://127.0.0.1:${http!.port}/cdp/`);
    expect(entry.default).toBe(true);

    // Spawn with ONLY the env Godmode provides (as a strict MCP client would).
    proc = Bun.spawn([server.command, ...(server.args ?? [])], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const mcp = new StdioMcp(proc);

    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "godmode-e2e", version: "0.1.0" },
    });
    const initResult = init.result as { serverInfo: { name: string }; protocolVersion: string };
    expect(initResult.serverInfo.name).toBeTruthy();
    mcp.notify("notifications/initialized");

    const list = await mcp.request("tools/list", {});
    const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toContain("browser_navigate");
    expect(tools).toContain("browser_get_state");
    expect(getRunning(profile.id)).toBeNull();

    const nav = await mcp.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }, 180_000);
    expect(nav.error).toBeUndefined();
    const rb = getRunning(profile.id)!;
    expect(rb).toBeTruthy();
    const navText = ((nav.result as { content: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");

    const pagesAfter = await listPages(rb.client);
    const onExample = pagesAfter.filter((p) => p.url.startsWith("https://example.com"));
    console.log(
      JSON.stringify(
        {
          serverInfo: initResult.serverInfo,
          protocolVersion: initResult.protocolVersion,
          toolCount: tools.length,
          tools,
          navigateResult: navText.slice(0, 200),
          managedBrowserCdp: rb.httpUrl,
          pagesAfter: pagesAfter.map((p) => p.url),
        },
        null,
        2,
      ),
    );
    expect(onExample.length).toBeGreaterThan(0);

    const state = await mcp.request("tools/call", { name: "browser_get_state", arguments: {} }, 120_000);
    const stateText = ((state.result as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
    expect(stateText).toContain("example.com");

    // Ending the MCP server must not take our browser down.
    proc.kill("SIGTERM");
    await proc.exited;
    proc = null;
    await Bun.sleep(500);
    expect(manager.getProfile(profile.id).running).toBe(true);
    expect((await fetch(`${rb.httpUrl}/json/version`)).ok).toBe(true);
  }, 300_000);
});

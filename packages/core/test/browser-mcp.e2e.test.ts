/**
 * End-to-end: the browser-use MCP server Godmode configures for an agent must drive Godmode's managed
 * Chromium (via cdp_url), not a browser of its own, and that browser only starts on the first browser tool call.
 * Needs uvx, a Chromium-family browser and network access (downloads browser-use on first run and opens
 * https://example.com), so it only runs with GODMODE_E2E=1:
 *
 *   GODMODE_E2E=1 bun test test/browser-mcp.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { findChrome } from "../src/browser/chrome";
import { listPages } from "../src/browser/cdp";
import { getRunning } from "../src/browser/state";
import { resolveUvx } from "../src/services/doctor";
import * as manager from "../src/browser/manager";

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
  const procs: ReturnType<typeof Bun.spawn>[] = [];

  const agent = (id: string) =>
    ({
      id,
      workspaceId: null,
      repoPath: join(dataDir, "agents", id),
      browser: { profileId: null, enabled: true, headless: true },
    }) as unknown as Agent;

  /** Spawn browser-use the way Claude Code does: only the env Godmode provides. */
  async function start(a: Agent, run: { runId: string; conversationId: string }) {
    const server = await manager.browserMcpServer(a, run);
    if (!server || !("command" in server)) throw new Error("expected a stdio server");
    const proc = Bun.spawn([server.command, ...(server.args ?? [])], { env: server.env!, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    procs.push(proc);
    const mcp = new StdioMcp(proc);
    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "godmode-e2e", version: "0.1.0" },
    });
    mcp.notify("notifications/initialized");
    return { server, proc, mcp, init: init.result as { serverInfo: { name: string }; protocolVersion: string } };
  }

  const text = (res: Record<string, unknown>) =>
    ((res.result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "godmode-mcp-e2e-"));
    const cfg = loadConfig({ dataDir });
    openDb(cfg.dbPath);
    manager.ensureDefaultProfile();
  });

  afterAll(async () => {
    for (const proc of procs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    await manager.shutdownBrowsers();
    closeDb();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  test("initialize → tools/list → browser_navigate lands in OUR browser, in the chat's own tab", async () => {
    const a = agent("agt_e2e");
    const { server, proc, mcp, init } = await start(a, { runId: "run_e2e", conversationId: "cnv_e2e" });
    expect(server.args).toEqual(["--from", "browser-use==0.13.10", "browser-use", "--mcp"]);
    const env = server.env!;
    expect(env.ANONYMIZED_TELEMETRY).toBe("false");
    const profile = manager.resolveProfileForAgent(a);
    expect(getRunning(profile.id)).toBeNull();

    // browser-use reaches the browser through the run's own endpoint, configured in a file of its own.
    expect(env.BROWSER_USE_CONFIG_PATH).toBe(join(env.BROWSER_USE_CONFIG_DIR!, "runs", "run_e2e", "config.json"));
    const configJson = JSON.parse(readFileSync(env.BROWSER_USE_CONFIG_PATH!, "utf8"));
    const entry = Object.values(configJson.browser_profile)[0] as Record<string, unknown>;
    expect(entry.cdp_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
    expect(entry.default).toBe(true);
    expect(init.serverInfo.name).toBeTruthy();

    const list = await mcp.request("tools/list", {});
    const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toContain("browser_navigate");
    expect(tools).toContain("browser_get_state");
    expect(getRunning(profile.id)).toBeNull();

    const nav = await mcp.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }, 180_000);
    expect(nav.error).toBeUndefined();
    const rb = getRunning(profile.id)!;
    expect(rb).toBeTruthy();
    const pagesAfter = await listPages(rb.client);
    console.log(JSON.stringify({ serverInfo: init.serverInfo, toolCount: tools.length, navigateResult: text(nav).slice(0, 200), pagesAfter: pagesAfter.map((p) => p.url) }, null, 2));
    expect(rb.tabs.currentPage("cnv_e2e")?.url).toStartWith("https://example.com");

    const state = await mcp.request("tools/call", { name: "browser_get_state", arguments: {} }, 120_000);
    expect(text(state)).toContain("example.com");

    // Ending the MCP server must not take our browser down; ending the run ends its endpoint.
    proc.kill("SIGTERM");
    await proc.exited;
    await Bun.sleep(500);
    expect(manager.getProfile(profile.id).running).toBe(true);
    expect((await fetch(`${rb.httpUrl}/json/version`)).ok).toBe(true);
    manager.releaseChatBrowser("run_e2e");
    expect((await fetch(`${entry.cdp_url}/json/version`)).status).toBe(404);
    expect(existsSync(env.BROWSER_USE_CONFIG_PATH!)).toBe(false);
  }, 300_000);

  test("two chats browse in parallel in one profile without seeing each other's tabs", async () => {
    // Same agent in two chats (the harder case: one browser-use config dir) plus another agent.
    const [one, two] = await Promise.all([
      start(agent("agt_e2e"), { runId: "run_one", conversationId: "cnv_one" }),
      start(agent("agt_e2e"), { runId: "run_two", conversationId: "cnv_two" }),
    ]);
    const [navOne, navTwo] = await Promise.all([
      one.mcp.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }, 180_000),
      two.mcp.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.org" } }, 180_000),
    ]);
    expect(navOne.error).toBeUndefined();
    expect(navTwo.error).toBeUndefined();

    const rb = getRunning(manager.resolveProfileForAgent(agent("agt_e2e")).id)!;
    expect(rb.tabs.currentPage("cnv_one")?.url).toStartWith("https://example.com");
    expect(rb.tabs.currentPage("cnv_two")?.url).toStartWith("https://example.org");
    expect(rb.tabs.currentPage("cnv_one")?.targetId).not.toBe(rb.tabs.currentPage("cnv_two")?.targetId);

    const [tabsOne, tabsTwo] = await Promise.all([
      one.mcp.request("tools/call", { name: "browser_list_tabs", arguments: {} }),
      two.mcp.request("tools/call", { name: "browser_list_tabs", arguments: {} }),
    ]);
    console.log(JSON.stringify({ tabsOne: text(tabsOne), tabsTwo: text(tabsTwo), pages: (await listPages(rb.client)).map((p) => p.url) }, null, 2));
    expect(text(tabsOne)).toContain("example.com");
    expect(text(tabsOne)).not.toContain("example.org");
    expect(text(tabsTwo)).toContain("example.org");
    expect(text(tabsTwo)).not.toContain("example.com");

    // A new tab opened by one chat stays that chat's.
    const opened = await one.mcp.request("tools/call", { name: "browser_navigate", arguments: { url: "https://www.iana.org/help/example-domains", new_tab: true } }, 180_000);
    expect(opened.error).toBeUndefined();
    expect(rb.tabs.pagesOf("cnv_one").map((p) => p.url).join(" ")).toContain("iana.org");
    const stateTwo = JSON.parse(text(await two.mcp.request("tools/call", { name: "browser_get_state", arguments: {} }, 120_000))) as {
      url: string;
      tabs: { url: string }[];
    };
    expect(stateTwo.url).toStartWith("https://example.org");
    expect(stateTwo.tabs.map((t) => t.url)).toEqual(["https://example.org/"]);
    const tabsTwoAfter = await two.mcp.request("tools/call", { name: "browser_list_tabs", arguments: {} });
    expect(text(tabsTwoAfter)).not.toContain("iana.org");

    manager.releaseChatBrowser("run_one");
    manager.releaseChatBrowser("run_two");
  }, 300_000);
});

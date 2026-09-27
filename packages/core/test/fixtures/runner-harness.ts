/**
 * Shared setup for runner / MCP / conversation tests: temp data dir + DB, the real HTTP app on a random
 * loopback port (so the MCP gateway is reachable by the fake claude), and the fake claude CLI.
 *
 * The browser manager is mocked with pass-through wrappers: only agents created through `makeAgent`
 * (and the fake profile) are intercepted, everything else reaches the real implementation — so the
 * mock is harmless for other test files even without `bun test --isolate`.
 */
import { mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentInput, BrowserProfile, ServerEvent } from "@godmode/shared";
import * as browserManager from "../../src/browser/manager";
import { loadConfig, config } from "../../src/config";
import { openDb, closeDb } from "../../src/db";
import { setLogLevel } from "../../src/log";
import { resetSettingsCache, updateSettings } from "../../src/services/settings";
import { createApp } from "../../src/server/app";
import { createAgent } from "../../src/agents/service";
import { bus } from "../../src/events/bus";
import { __setClaudeBinaryForTests, cancelRun, listActiveRuns, waitForRun } from "../../src/runner/runner";

type BrowserModule = typeof browserManager;
// Copy the real exports before mocking (mock.module replaces the module's exports in place).
const realBrowser: BrowserModule = { ...browserManager };

export const FAKE_PROFILE_ID = "prof_runner_test";
export const testAgentIds = new Set<string>();
export const fills: { profileId: string; text: string; kind?: string; selector?: string; submit?: boolean }[] = [];
/** When set, the fake fill fails with an error message that echoes the typed text (leak test). */
export const fillFailure = { echoText: false };

const fakeProfile: BrowserProfile = {
  id: FAKE_PROFILE_ID,
  workspaceId: null,
  name: "Test profile",
  userDataDir: "/nonexistent",
  isDefault: true,
  importedFrom: null,
  importedAt: null,
  cookieCount: 0,
  running: false,
  cdpUrl: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

mock.module("../../src/browser/manager", () => ({
  ...realBrowser,
  resolveProfileForAgent: (agent: Agent) => (testAgentIds.has(agent.id) ? fakeProfile : realBrowser.resolveProfileForAgent(agent)),
  browserMcpServer: async (agent: Agent) => (testAgentIds.has(agent.id) ? null : realBrowser.browserMcpServer(agent)),
  fillIntoPage: async (profileId: string, opts: Parameters<BrowserModule["fillIntoPage"]>[1]) => {
    if (profileId !== FAKE_PROFILE_ID) return realBrowser.fillIntoPage(profileId, opts);
    fills.push({ profileId, text: opts.text, kind: opts.kind, selector: opts.selector, submit: opts.submit });
    if (fillFailure.echoText) return { ok: false, url: "https://example.com/login", detail: `Typing failed near "${opts.text}"` };
    return { ok: true, url: "https://example.com/login", detail: "filled" };
  },
  currentPage: async (profileId: string) =>
    profileId === FAKE_PROFILE_ID ? { url: "https://app.example.com/login", title: "Login" } : realBrowser.currentPage(profileId),
}));

export const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");

export interface TestEnv {
  dataDir: string;
  stateDir: string;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function setupEnv(prefix = "godmode-runner-"): Promise<TestEnv> {
  setLogLevel("error");
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  loadConfig({ dataDir, host: "127.0.0.1" });
  openDb(join(dataDir, "godmode.db"));
  resetSettingsCache();
  updateSettings({ memory: { autoCommit: false }, runner: { maxConcurrentRuns: 3, runTimeoutMinutes: 60 } });
  const app = createApp();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => app.fetch(req, { server: srv }) });
  config().port = server.port!;
  const stateDir = join(dataDir, "fake-claude");
  process.env.FAKE_CLAUDE_STATE = stateDir;
  __setClaudeBinaryForTests([process.execPath, FAKE_CLAUDE]);
  return {
    dataDir,
    stateDir,
    baseUrl: `http://127.0.0.1:${server.port}`,
    close: async () => {
      for (const r of listActiveRuns()) {
        await cancelRun(r.runId);
        await waitForRun(r.runId, 10_000);
      }
      __setClaudeBinaryForTests(null);
      server.stop(true);
      closeDb();
      resetSettingsCache();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function makeAgent(input: Partial<AgentInput> & { name: string }): Promise<Agent> {
  const agent = await createAgent({ ...input, browser: { enabled: false, ...input.browser } });
  testAgentIds.add(agent.id);
  return agent;
}

export interface Invocation {
  args: string[];
  prompt: string;
  cwd: string;
  env: { ANTHROPIC_API_KEY: string | null; GODMODE_TOKEN: string | null };
}

export function invocations(env: TestEnv): Invocation[] {
  const file = join(env.stateDir, "invocations.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Invocation);
}

export function argValue(inv: Invocation, flag: string): string | null {
  const i = inv.args.indexOf(flag);
  return i >= 0 ? (inv.args[i + 1] ?? null) : null;
}

export function captureEvents(): { events: ServerEvent[]; stop: () => void } {
  const events: ServerEvent[] = [];
  const stop = bus.on((e) => events.push(e));
  return { events, stop };
}

export async function until(cond: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

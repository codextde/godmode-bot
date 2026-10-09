import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { issueRunToken } from "../src/mcp/tokens";
import { registerBrowser, unregisterBrowser, type RunningBrowser } from "../src/browser/state";
import { foreignBrowserCall, foreignBrowserUse, guardedText, RUN_CDP_ENV } from "../src/browser/cdpGuard";
import { buildSystemPrompt } from "../src/runner/prompt";
import { getSettings } from "../src/services/settings";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { startChat } from "../src/services/conversations";
import { waitForRun } from "../src/runner/runner";

let env: TestEnv;
const fake = { profileId: "bpr_other", port: 61275, stopping: false, client: { closed: false } } as unknown as RunningBrowser;

beforeAll(async () => {
  env = await setupEnv("godmode-cdp-guard-");
  registerBrowser(fake);
});

afterAll(async () => {
  unregisterBrowser(fake);
  await env.close();
});

describe("foreign browser use", () => {
  test("looking for DevTools ports is refused", () => {
    expect(foreignBrowserUse("ps aux | grep -o 'remote-debugging-port=[0-9]*' | sort -u")).toContain("DevTools ports");
    expect(foreignBrowserUse("cat ~/Library/Chrome/DevToolsActivePort")).toContain("DevTools ports");
  });

  test("a running Godmode browser's raw port is refused in commands and files", () => {
    expect(foreignBrowserUse("node -e \"chromium.connectOverCDP('http://127.0.0.1:61275')\"")).toContain("61275");
    expect(foreignBrowserUse("const b = await chromium.connectOverCDP(`http://localhost:61275`);")).toContain("61275");
  });

  test("Godmode's profile folders are off limits", () => {
    expect(foreignBrowserUse(`ls ${join(config().browserDir, "bpr_other")}`)).toContain("profile folders");
  });

  test("working on code that mentions DevTools ports passes", () => {
    expect(foreignBrowserUse("grep -rn remote-debugging-port packages/core/src")).toBeNull();
    expect(foreignBrowserUse("const args = [`--remote-debugging-port=${port}`]; const tab = tabs.find((t) => t.ps);")).toBeNull();
    expect(foreignBrowserCall("Bash", { command: "git add src/browser/chrome.ts && sed -n 1,40p src/browser/chrome.ts" }, process.cwd())).toBeNull();
    expect(foreignBrowserUse(`ls ${config().browserDir}-use/x/files/downloads`)).toBeNull();
  });

  test("ordinary work passes", () => {
    expect(foreignBrowserUse("curl -s http://127.0.0.1:3000/healthz && pnpm test")).toBeNull();
    expect(foreignBrowserUse(`node shot.mjs # connects to process.env.${RUN_CDP_ENV}`)).toBeNull();
    expect(foreignBrowserUse("grep -rn TODO src")).toBeNull();
  });

  test("a script that finds a DevTools port itself is refused when run", () => {
    const dir = mkdtempSync(join(tmpdir(), "godmode-cdp-scripts-"));
    writeFileSync(join(dir, "cdp.mjs"), "const port = execSync(\"ps aux | grep -o 'remote-debugging-port=[0-9]*'\").toString();");
    writeFileSync(join(dir, "ok.mjs"), `const b = await chromium.connectOverCDP(process.env.${RUN_CDP_ENV});`);
    expect(foreignBrowserCall("Bash", { command: "node cdp.mjs upload" }, dir)).toContain("the script it runs");
    expect(foreignBrowserCall("Bash", { command: `cd /x && node ${join(dir, "cdp.mjs")}` })).toContain("the script it runs");
    expect(foreignBrowserCall("Bash", { command: `cd ${dir} && MATCH=x node cdp.mjs` }, "/")).toContain("the script it runs");
    expect(foreignBrowserCall("Bash", { command: "CDP_PORT=61275 node run.mjs" }, dir)).toContain("61275");
    expect(foreignBrowserCall("Bash", { command: "node ok.mjs" }, dir)).toBeNull();
    expect(foreignBrowserCall("Bash", { command: "node missing.mjs" }, dir)).toBeNull();
  });

  test("only shell commands and file writes are looked at", () => {
    expect(guardedText("Bash", { command: "ls" })).toEqual({ text: "ls", kind: "command" });
    expect(guardedText("MultiEdit", { edits: [{ new_string: "a" }, { new_string: "b" }] })).toEqual({ text: "a\nb", kind: "file" });
    expect(guardedText("Read", { file_path: "/x" })).toBeNull();
  });
});

describe("pre-tool-use hook", () => {
  const call = (token: string, body: unknown) =>
    fetch(`${env.baseUrl}/mcp/hooks/pre-tool-use`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const token = () => issueRunToken({ runId: "run_guard", agentId: "agt_x", conversationId: "cnv_x", workspaceId: null, depth: 0 });

  test("needs the run's token", async () => {
    expect((await call("nope", {})).status).toBe(401);
  });

  test("denies a command that reaches another browser", async () => {
    const res = await call(token(), { tool_name: "Bash", tool_input: { command: "ps aux | grep remote-debugging-port" } });
    const out = (await res.json()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("other browser profiles");
  });

  test("lets everything else through", async () => {
    expect((await call(token(), { tool_name: "Bash", tool_input: { command: "pnpm build" } })).status).toBe(204);
    expect((await call(token(), { tool_name: "Read", tool_input: { file_path: "/etc/hosts" } })).status).toBe(204);
  });
});

describe("runs", () => {
  test("every chat run asks the hook before shell commands and file writes", async () => {
    const agent = await makeAgent({ name: "Guarded" });
    const started = await startChat({ agentId: agent.id, content: "hello" });
    await waitForRun(started.run.id, 20_000);
    const inv = invocations(env).at(-1)!;
    expect(argValue(inv, "--settings")).not.toBeNull();
    const settings = inv.settings as { hooks: { PreToolUse: { matcher: string; hooks: { url: string }[] }[] } };
    expect(settings.hooks.PreToolUse[0]!.matcher).toBe("Bash|Write|Edit|MultiEdit");
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.url).toEndWith("/mcp/hooks/pre-tool-use");
  });

  test("the prompt points scripts at the run's own endpoint", async () => {
    const agent = await makeAgent({ name: "Browsing" });
    const prompt = buildSystemPrompt({ agent, settings: getSettings(), peers: [], browserAvailable: true, browserCdpEnv: RUN_CDP_ENV });
    expect(prompt).toContain(`connectOverCDP(process.env.${RUN_CDP_ENV})`);
    expect(prompt).toContain("Never look for or connect to any other Chrome DevTools port");
    expect(buildSystemPrompt({ agent, settings: getSettings(), peers: [], browserAvailable: true })).not.toContain(RUN_CDP_ENV);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { issueRunToken } from "../src/mcp/tokens";
import { sweepingKill } from "../src/runner/killGuard";
import { startChat } from "../src/services/conversations";
import { waitForRun } from "../src/runner/runner";
import { invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";

describe("options after the pattern", () => {
  test.each([
    'pkill -f "next-server" -n',
    'pkill -f "next dev" -n 2>/dev/null; pgrep -fl next-server | sort',
    'pkill -f "next-server" -u $USER -n',
    "cd app && pkill -f 'a b' -n && ls",
    "pkill node -9",
    "sudo pkill -f x -n",
    "pgrep -f x -n | xargs kill",
    "pkill -TERM -f x -n",
    "pkill -u me -f x -n",
    "if true; then pkill -f x -n; fi",
    "ls\npkill -f x -n",
    "pkill -f x \\\n  -n",
    `node -e "execSync('pkill -f x -n')"`,
    `$(pkill -f x -n)`,
  ])("refused: %s", (command) => {
    expect(sweepingKill(command)).toContain("Put the options first");
  });

  test.each([
    'pkill -f "next start -p 3121"',
    'pkill -n -f "next-server" 2>/dev/null',
    'pkill -fn "next-server"',
    'pkill -u $USER -n -f "next-server"',
    "pkill -uroot -f x",
    "pkill -9 -f x",
    "pkill -KILL node",
    "pkill --signal TERM -f x",
    "pkill -F /tmp/pidfile",
    "pkill -f -- -n",
    "pkill -f x # not -n",
    "pkill -f x; ls -la",
    "pkill -f x && ls -la",
    "pkill -f x | wc -l",
    "pkill -f x\nls -la",
    "pgrep -fl next-server | head -5",
    'git commit -m "Stop writing pkill -f x -n"',
    "grep -rn pkill src -n",
    "sed -n 1,5p pkill.sh",
    "kill -9 123",
  ])("passes: %s", (command) => {
    expect(sweepingKill(command)).toBeNull();
  });

  test("only strings are looked at", () => {
    expect(sweepingKill(undefined)).toBeNull();
  });
});

describe("runs", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await setupEnv("godmode-kill-guard-");
  });

  afterAll(async () => {
    await env.close();
  });

  const hook = (command: string) =>
    fetch(`${env.baseUrl}/mcp/hooks/pre-tool-use`, {
      method: "POST",
      headers: { Authorization: `Bearer ${issueRunToken({ runId: "run_kill", agentId: "agt_x", conversationId: "cnv_x", workspaceId: null, depth: 0 })}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    });

  test("the hook denies the command and tells how to write it", async () => {
    const out = (await (await hook('pkill -f "next-server" -n')).json()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('pkill -n -f "pattern"');
    expect((await hook('pkill -n -f "next-server"')).status).toBe(204);
  });

  test("the system prompt stays off the command line, where `pkill -f` would match it", async () => {
    const agent = await makeAgent({ name: "KEEP_OFF_ARGV" });
    const started = await startChat({ agentId: agent.id, content: "hello" });
    await waitForRun(started.run.id, 20_000);
    const inv = invocations(env).at(-1)!;
    expect(inv.args).toContain("--append-system-prompt-file");
    expect(inv.args.join(" ")).not.toContain("KEEP_OFF_ARGV");
    expect(inv.systemPrompt).toContain("KEEP_OFF_ARGV");
  });
});

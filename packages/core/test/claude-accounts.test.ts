import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_CLAUDE_ACCOUNT, type Agent } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { getMeta, insert, run as sql } from "../src/db";
import { updateAgent } from "../src/agents/service";
import { getConversation, startChat } from "../src/services/conversations";
import { listNotifications } from "../src/services/notifications";
import { startPauses, stopPauses } from "../src/services/pauses";
import { updateSettings } from "../src/services/settings";
import { createWorkspace, getWorkspace, updateWorkspace } from "../src/services/workspaces";
import { accountForRun, cleanWorkspaceAccounts, listClaudeAccounts, refreshClaudeUsage, removeClaudeAccount, setDefaultClaudeAccount } from "../src/services/claudeAccounts";
import { getRun, waitForRun } from "../src/runner/runner";

let env: TestEnv;
let agent: Agent;
const realFetch = globalThis.fetch;
/** Usage the fake usage endpoint reports, by access token. */
const usageByToken = new Map<string, number>();

function addAccount(id: string, email: string, token: string, expiresAt = Date.now() + 8 * 3600_000) {
  insert("claude_accounts", { id, email, name: null, organization: null, plan: "max", limited_until: null, needs_sign_in: 0, last_used_at: null, created_at: new Date().toISOString() });
  vault.setAppSecret(`claude_account:${id}`, JSON.stringify({ accessToken: token, refreshToken: `refresh-${token}`, expiresAt, subscriptionType: "max" }));
}

const lastInvocation = () => invocations(env).at(-1)!;

beforeAll(async () => {
  env = await setupEnv("godmode-claude-accounts-");
  await vault.setup("correct horse battery staple", false);
  agent = await makeAgent({ name: "Accounts Bot" });
  startPauses();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.anthropic.com/api/oauth/usage")) {
      const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
      const percent = usageByToken.get(token) ?? 99;
      return Response.json({ five_hour: { utilization: percent, resets_at: new Date(Date.now() + 3600_000).toISOString() }, seven_day: { utilization: 5, resets_at: null } });
    }
    if (url.startsWith("https://platform.claude.com/v1/oauth/token")) {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      if (body.refresh_token === "refresh-revoked") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `${body.refresh_token}-fresh`, refresh_token: `${body.refresh_token}-next`, expires_in: 28_800 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  stopPauses();
  await env.close();
});

afterEach(() => {
  for (const f of ["limit", "limit-token"]) rmSync(join(env.stateDir, f), { force: true });
  for (const a of listClaudeAccounts()) if (!a.system) removeClaudeAccount(a.id);
  sql("DELETE FROM meta WHERE key LIKE 'claude.accounts.%'");
  usageByToken.clear();
  updateSettings({ runner: { accountAutoSwitch: true, accountSwitchPercent: 90 } });
});

async function chat(content: string, as: Agent = agent) {
  const started = await startChat({ agentId: as.id, content });
  return { started, done: await waitForRun(started.run.id, 20_000) };
}

describe("Claude accounts", () => {
  test("with only the system login, runs start exactly as before", async () => {
    expect(listClaudeAccounts().map((a) => a.id)).toEqual([SYSTEM_CLAUDE_ACCOUNT]);
    expect(await accountForRun(null)).toBeNull();
    const { done } = await chat("hello");
    expect(done.status).toBe("succeeded");
    expect(lastInvocation().env.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
  });

  test("the default account's token reaches the run and wins over the vault's API key", async () => {
    addAccount("cla_work", "work@example.com", "tok-work");
    vault.setAppSecret("anthropic_api_key", "sk-ant-test");
    try {
      setDefaultClaudeAccount("cla_work");
      expect(listClaudeAccounts().find((a) => a.isDefault)?.email).toBe("work@example.com");
      const { done } = await chat("hello");
      expect(done.status).toBe("succeeded");
      expect(lastInvocation().env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-work");
      expect(lastInvocation().env.ANTHROPIC_API_KEY).toBeNull();
    } finally {
      vault.setAppSecret("anthropic_api_key", null);
    }
  });

  test("a token about to run out is refreshed first, and the new refresh token is kept", async () => {
    addAccount("cla_old", "old@example.com", "tok-old", Date.now() + 10 * 60_000);
    setDefaultClaudeAccount("cla_old");
    const picked = await accountForRun(null);
    expect(picked?.token).toBe("refresh-tok-old-fresh");
    const kept = JSON.parse(vault.getAppSecret("claude_account:cla_old")!) as { refreshToken: string; expiresAt: number };
    expect(kept.refreshToken).toBe("refresh-tok-old-next");
    expect(kept.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600_000);
  });

  test("a revoked sign-in is marked and runs move on to another account", async () => {
    addAccount("cla_gone", "gone@example.com", "revoked", Date.now() + 60_000);
    vault.setAppSecret("claude_account:cla_gone", JSON.stringify({ accessToken: "revoked", refreshToken: "refresh-revoked", expiresAt: Date.now() + 30_000 }));
    setDefaultClaudeAccount("cla_gone");
    const picked = await accountForRun(null);
    expect(picked?.id).toBe(SYSTEM_CLAUDE_ACCOUNT);
    expect(listClaudeAccounts().find((a) => a.id === "cla_gone")?.needsSignIn).toBe(true);
    expect(listNotifications().some((n) => n.title === "Sign in to gone@example.com again")).toBe(true);
  });

  test("auto-switch starts work on the account with the most room once the default is at the threshold", async () => {
    addAccount("cla_a", "a@example.com", "tok-a");
    addAccount("cla_b", "b@example.com", "tok-b");
    addAccount("cla_c", "c@example.com", "tok-c");
    usageByToken.set("tok-a", 95).set("tok-b", 60).set("tok-c", 20);
    setDefaultClaudeAccount("cla_a");
    await refreshClaudeUsage();
    expect((await accountForRun(null))?.id).toBe("cla_c");

    updateSettings({ runner: { accountAutoSwitch: false } });
    expect((await accountForRun(null))?.id).toBe("cla_a");
    updateSettings({ runner: { accountAutoSwitch: true, accountSwitchPercent: 96 } });
    expect((await accountForRun(null))?.id).toBe("cla_a");
  });

  test("a workspace uses only its own accounts, starting with its default", async () => {
    addAccount("cla_a", "a@example.com", "tok-a");
    addAccount("cla_b", "b@example.com", "tok-b");
    setDefaultClaudeAccount("cla_a");
    const ws = createWorkspace({ name: "Client work", claudeAccounts: { ids: ["cla_b", SYSTEM_CLAUDE_ACCOUNT, "cla_missing"], defaultId: "cla_b" } });
    expect(ws.claudeAccounts).toEqual({ ids: ["cla_b", SYSTEM_CLAUDE_ACCOUNT], defaultId: "cla_b" });
    const member = await makeAgent({ name: "Workspace Bot", workspaceId: ws.id });
    const { done } = await chat("hello", member);
    expect(done.status).toBe("succeeded");
    expect(lastInvocation().env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");

    // Removing its default leaves the rest of its choice.
    removeClaudeAccount("cla_b");
    expect(getWorkspace(ws.id).claudeAccounts).toEqual({ ids: [SYSTEM_CLAUDE_ACCOUNT], defaultId: SYSTEM_CLAUDE_ACCOUNT });
    expect(updateWorkspace(ws.id, { claudeAccounts: null }).claudeAccounts).toBeNull();
    await updateAgent(member.id, { enabled: false });
  });

  test("a run that hits a limit goes on right away on another account, without the limit notice", async () => {
    addAccount("cla_spare", "spare@example.com", "tok-spare");
    // Only the limit moves it: the threshold never does.
    updateSettings({ runner: { accountSwitchPercent: 100 } });
    writeFileSync(join(env.stateDir, "limit"), String(Math.floor(Date.now() / 1000) + 3600));
    writeFileSync(join(env.stateDir, "limit-token"), "system");
    const before = listNotifications().length;
    const started = await startChat({ agentId: agent.id, content: "LIMIT_HIT write the report" });
    const done = await waitForRun(started.run.id, 20_000);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("back after the limit");
    const calls = invocations(env).filter((i) => i.prompt.includes("LIMIT_HIT write the report"));
    expect(calls.map((c) => c.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([null, "tok-spare"]);
    const notices = getConversation(started.conversation.id)
      .messages.flatMap((m) => m.blocks)
      .filter((b) => b.type === "notice")
      .map((b) => (b as { text: string }).text);
    expect(notices.some((t) => t.includes("reached its session limit. Switching to spare@example.com"))).toBe(true);
    expect(listNotifications().slice(0, listNotifications().length - before).some((n) => n.title.includes("limit is reached"))).toBe(false);
    expect(getMeta("claude.accounts.system_limited")).toBeTruthy();
    // The limited account stays aside until its reset.
    expect((await accountForRun(null))?.id).toBe("cla_spare");
  });

  test("with auto-switch off, a limit waits for the reset as before", async () => {
    addAccount("cla_spare", "spare@example.com", "tok-spare");
    updateSettings({ runner: { accountAutoSwitch: false } });
    writeFileSync(join(env.stateDir, "limit"), String(Math.floor(Date.now() / 1000) + 3600));
    writeFileSync(join(env.stateDir, "limit-token"), "system");
    const started = await startChat({ agentId: agent.id, content: "LIMIT_HIT later please" });
    await until(() => getRun(started.run.id).status === "paused", 15_000, "the run to pause");
    const paused = getConversation(started.conversation.id).paused!;
    expect(Date.parse(paused.resumeAt!)).toBeGreaterThan(Date.now() + 50 * 60_000);
    rmSync(join(env.stateDir, "limit"));
    sql("UPDATE paused_runs SET resume_at = ? WHERE run_id = ?", new Date(Date.now() - 1000).toISOString(), started.run.id);
    const { sweep } = await import("../src/services/pauses");
    sweep();
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
  });

  test("a workspace choice is cleaned of unknown accounts", () => {
    expect(cleanWorkspaceAccounts({ ids: [], defaultId: "x" })).toBeNull();
    expect(cleanWorkspaceAccounts({ ids: ["nope"], defaultId: "nope" })).toBeNull();
    expect(cleanWorkspaceAccounts({ ids: [SYSTEM_CLAUDE_ACCOUNT, SYSTEM_CLAUDE_ACCOUNT], defaultId: "gone" })).toEqual({ ids: [SYSTEM_CLAUDE_ACCOUNT], defaultId: SYSTEM_CLAUDE_ACCOUNT });
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { all, get } from "../src/db";
import { getRun, waitForRun } from "../src/runner/runner";
import { openQuestionOf, listQuestions } from "../src/services/questions";
import * as vault from "../src/vault/vault";
import { issueGrant } from "../src/server/grants";
import { createApp } from "../src/server/app";
import { splitMessage, toPlainText, toSlackMrkdwn, toTelegramHtml, fromSlackText } from "../src/messaging/format";
import {
  createConnection,
  deleteConnection,
  listChats,
  listConnections,
  listUsers,
  setUserOwner,
  setUserStatus,
  startMessaging,
  stopMessaging,
  syncMessaging,
  updateConnection,
} from "../src/messaging/service";
import { teamsAppPackage, verifyBotToken, normalizePublicUrl } from "../src/messaging/teams";

const PASSPHRASE = "correct horse battery staple";
const TG_TOKEN = "123456789:AAEexampleexampleexampleexample1234";

/* ------------------------------ fetch mock ------------------------------ */

interface Call {
  method: string;
  url: URL;
  body: Record<string, unknown>;
  headers: Headers;
}

type Handler = (call: Call) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
const calls: Call[] = [];
const handlers = new Map<string, Handler>();

function onHost(host: string, handler: Handler) {
  handlers.set(host, handler);
}

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const handler = handlers.get(url.host);
    if (!handler) return realFetch(input as RequestInfo, init);
    const text = req.method === "GET" ? "" : await req.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = Object.fromEntries(new URLSearchParams(text));
      }
    }
    const call = { method: req.method, url, body, headers: req.headers };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

/* ---------------------------- fake Telegram ----------------------------- */

const updates: unknown[] = [];
let updateId = 100;
let messageId = 1;

function tgMethod(call: Call): string {
  return call.url.pathname.split("/").pop()!;
}

const tgCalls = (method: string) => calls.filter((c) => c.url.host === "api.telegram.org" && tgMethod(c) === method);

function fakeTelegram() {
  onHost("api.telegram.org", async (call) => {
    const method = tgMethod(call);
    const ok = (result: unknown) => Response.json({ ok: true, result });
    switch (method) {
      case "getMe":
        return ok({ id: 4242, is_bot: true, first_name: "Godmode", username: "godmode_test_bot" });
      case "getWebhookInfo":
        return ok({ url: "" });
      case "getUpdates": {
        const offset = Number(call.body.offset ?? 0);
        for (let i = 0; i < 20 && !updates.some((u) => (u as { update_id: number }).update_id >= offset); i++) await Bun.sleep(10);
        return ok(updates.filter((u) => (u as { update_id: number }).update_id >= offset));
      }
      case "sendMessage":
        if (String(call.body.text ?? "").includes("<b>BROKEN")) return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 });
        return ok({ message_id: messageId++ });
      default:
        return ok(true);
    }
  });
}

function tgMessage(from: { id: number; first_name: string; username?: string }, text: string, chat?: { id: number; type: string; title?: string }) {
  updates.push({
    update_id: updateId++,
    message: {
      message_id: messageId++,
      from: { is_bot: false, ...from },
      chat: chat ?? { id: from.id, type: "private", first_name: from.first_name },
      text,
    },
  });
}

const sentTexts = () => tgCalls("sendMessage").map((c) => String(c.body.text));

/* -------------------------------- setup --------------------------------- */

let env: TestEnv;
let helper: Agent;
let researcher: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-messaging-");
  vault.lock();
  await vault.setup(PASSPHRASE, false);
  helper = await makeAgent({ name: "Helper", avatar: "🧭", description: "Answers questions" });
  researcher = await makeAgent({ name: "Researcher", avatar: "🔎", description: "Digs into things" });
  installFetchMock();
  fakeTelegram();
  startMessaging();
});

afterAll(async () => {
  await stopMessaging();
  globalThis.fetch = realFetch;
  await env.close();
});

/* ------------------------------ formatting ------------------------------ */

describe("formatting", () => {
  test("Markdown becomes Telegram HTML", () => {
    const html = toTelegramHtml("# Plan\n**Bold** and *it* with `a<b>` and [link](https://x.dev/a_b_c)\n- one\n> quoted\n```ts\nconst a = 1 < 2;\n```");
    expect(html).toContain("<b>Plan</b>");
    expect(html).toContain("<b>Bold</b> and <i>it</i>");
    expect(html).toContain("<code>a&lt;b&gt;</code>");
    expect(html).toContain('<a href="https://x.dev/a_b_c">link</a>');
    expect(html).toContain("• one");
    expect(html).toContain("<blockquote>quoted</blockquote>");
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
  });

  test("snake_case and URLs keep their underscores", () => {
    expect(toTelegramHtml("use my_var_name")).toBe("use my_var_name");
    expect(toSlackMrkdwn("use my_var_name")).toBe("use my_var_name");
  });

  test("Markdown becomes Slack mrkdwn", () => {
    const text = toSlackMrkdwn("## Title\n**bold** *it* ~~gone~~ [docs](https://x.dev) a < b\n| a | b |\n|---|---|");
    expect(text).toContain("*Title*");
    expect(text).toContain("*bold* _it_ ~gone~ <https://x.dev|docs> a &lt; b");
    expect(text).toContain("```\n| a | b |");
    expect(fromSlackText("<@U1> see <https://x.dev|docs> &amp; <#C1|general>")).toBe("<@U1> see docs (https://x.dev) & #general");
  });

  test("long answers split at boundaries with balanced code fences", () => {
    const code = Array.from({ length: 80 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const chunks = splitMessage(`Intro\n\n\`\`\`py\n${code}\n\`\`\`\n\nOutro`, 1000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith("```py")).toBe(true);
    expect(chunks.join("\n")).toContain("line 79");
  });

  test("fences reopen with their own marker; links keep parentheses; empty code is skipped", () => {
    const body = Array.from({ length: 60 }, (_, i) => `row ${i} ${"y".repeat(30)}`).join("\n");
    const chunks = splitMessage(`~~~\n${body}\n~~~`, 600);
    expect(chunks[0]!.endsWith("\n~~~")).toBe(true);
    expect(chunks[1]!.startsWith("~~~\n")).toBe(true);
    expect(toTelegramHtml("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</a>');
    expect(toTelegramHtml("```\n\n```")).toBe("");
  });

  test("plain text fallback drops markup", () => {
    expect(toPlainText("**Hi** [there](https://x.dev)\n- a")).toBe("Hi there (https://x.dev)\n• a");
  });
});

/* ------------------------------- Telegram ------------------------------- */

describe("Telegram bot", () => {
  let connectionId: string;
  const alice = { id: 7001, first_name: "Alice", username: "alice" };

  test("connecting verifies the token and starts polling", async () => {
    const conn = await createConnection({ credentials: { provider: "telegram", botToken: TG_TOKEN }, agentIds: [helper.id, researcher.id] });
    connectionId = conn.id;
    expect(conn.bot).toMatchObject({ id: "4242", username: "godmode_test_bot", url: "https://t.me/godmode_test_bot" });
    expect(conn.name).toBe("Godmode");
    expect(conn.defaultAgentId).toBe(helper.id);
    expect(conn.access).toBe("approved");
    await until(() => listConnections()[0]?.status.state === "connected", 5000, "connected");
    expect(tgCalls("setMyCommands").length).toBe(1);
    // The token is sealed, never stored in plain text.
    const row = get<{ secrets_enc: string }>("SELECT secrets_enc FROM messaging_connections WHERE id = ?", conn.id)!;
    expect(row.secrets_enc).not.toContain(TG_TOKEN);
  });

  test("the same bot can't be connected twice", async () => {
    await expect(createConnection({ credentials: { provider: "telegram", botToken: TG_TOKEN }, agentIds: [helper.id] })).rejects.toThrow(/already connected/);
  });

  test("strangers ask for access instead of reaching an agent", async () => {
    tgMessage(alice, "hi there");
    await until(() => sentTexts().some((t) => t.includes("This bot is private")), 5000, "access notice");
    const users = listUsers(connectionId);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ name: "Alice", username: "alice", status: "pending" });
    expect(listConnections()[0]!.pendingUsers).toBe(1);
    expect(all("SELECT id FROM runs")).toHaveLength(0);
    const note = get<{ title: string }>("SELECT title FROM notifications ORDER BY created_at DESC LIMIT 1");
    expect(note?.title).toContain("Alice wants to talk");
  });

  test("approving someone welcomes them in their chat", async () => {
    const before = sentTexts().length;
    await setUserStatus(connectionId, listUsers(connectionId)[0]!.id, "approved");
    await until(() => sentTexts().length > before, 5000, "welcome");
    expect(sentTexts().at(-1)).toContain("You're in!");
    expect(sentTexts().at(-1)).toContain("🧭 Helper");
  });

  test("a message runs the chat's agent and the answer comes back formatted", async () => {
    const before = sentTexts().length;
    tgMessage(alice, "Say hello");
    await until(() => sentTexts().length > before, 10_000, "answer");
    expect(sentTexts().at(-1)).toBe("Hello, nice to meet you!");
    expect(tgCalls("sendMessage").at(-1)!.body.parse_mode).toBe("HTML");
    expect(tgCalls("sendChatAction").length).toBeGreaterThan(0);
    const chats = listChats(connectionId);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ kind: "direct", title: "Alice", agentId: helper.id });
    const conv = get<{ origin: string; agent_id: string; instructions: string }>("SELECT origin, agent_id, instructions FROM conversations WHERE id = ?", chats[0]!.conversationId!)!;
    expect(conv).toMatchObject({ origin: "telegram", agent_id: helper.id });
    expect(conv.instructions).toContain('chatting on Telegram with the person who calls themselves "Alice" (@alice)');
    expect(conv.instructions).toContain("not verified");
  });

  test("follow-ups continue the same conversation", async () => {
    const conversationId = listChats(connectionId)[0]!.conversationId;
    const before = sentTexts().length;
    tgMessage(alice, "And again");
    await until(() => sentTexts().length > before, 10_000, "second answer");
    expect(listChats(connectionId)[0]!.conversationId).toBe(conversationId);
    expect(get<{ c: number }>("SELECT COUNT(*) AS c FROM runs WHERE conversation_id = ?", conversationId!)?.c).toBe(2);
  });

  test("only the owner answers what an agent asks; everyone else hears it is being checked", async () => {
    const conversationId = listChats(connectionId)[0]!.conversationId!;
    const alicesId = listUsers(connectionId).find((u) => u.name === "Alice")!.id;
    expect(listUsers(connectionId).find((u) => u.id === alicesId)!.isOwner).toBe(false);

    let before = sentTexts().length;
    tgMessage(alice, "ASK_HUMAN about the header");
    await until(() => openQuestionOf(conversationId) !== null && sentTexts().length > before, 15_000, "the question to be asked");
    const question = openQuestionOf(conversationId)!;
    expect(sentTexts().at(-1)).toContain("I need to check something with the owner first");
    expect(sentTexts().join("\n")).not.toContain("Which color should the header be?");

    // An approved person who isn't the owner can't answer: the message waits behind the question.
    before = sentTexts().length;
    tgMessage(alice, "2");
    await until(() => sentTexts().length > before, 10_000, "the waiting note");
    expect(openQuestionOf(conversationId)?.id).toBe(question.id);

    const owner = await setUserOwner(connectionId, alicesId, true);
    expect(owner).toMatchObject({ isOwner: true, status: "approved" });
    expect(all("SELECT id FROM audit_log WHERE action = 'messaging.user.owner'")).toHaveLength(1);

    tgMessage(alice, "2");
    await until(() => listQuestions({ status: "answered" }).some((q) => q.id === question.id), 10_000, "the owner's answer");
    expect(listQuestions({ status: "answered" }).find((q) => q.id === question.id)!.answer).toMatchObject({ optionId: "2", text: "Blue", via: "telegram" });
    await waitForRun(question.runId, 20_000);
    await until(() => sentTexts().includes("CONTINUED"), 10_000, "the continued answer");
    expect(getRun(question.runId).status).toBe("succeeded");

    // Now the owner gets the question itself, with how to answer.
    before = sentTexts().length;
    tgMessage(alice, "ASK_APPROVAL for the reminder");
    await until(() => sentTexts().slice(before).some((t) => t.includes("needs an OK")), 15_000, "the approval request");
    const posted = sentTexts().slice(before).find((t) => t.includes("needs an OK"))!;
    expect(posted).toContain("Send the payment reminder to billing@acme.com");
    expect(posted).toContain("approve");
    const approval = openQuestionOf(conversationId)!;
    tgMessage(alice, "approve");
    await until(() => listQuestions({ status: "approved" }).some((q) => q.id === approval.id), 10_000, "the approval");
    await waitForRun(approval.runId, 20_000);
    await setUserOwner(connectionId, alicesId, false);
    await until(() => !all<{ id: string }>("SELECT id FROM runs WHERE status IN ('queued', 'running', 'paused')").length, 20_000, "the chat to settle");
  }, 60_000);

  test("/agents lists the bot's agents and /agent switches", async () => {
    let before = sentTexts().length;
    tgMessage(alice, "/agents");
    await until(() => sentTexts().length > before, 5000, "agents list");
    expect(sentTexts().at(-1)).toContain("🔎 Researcher");
    expect(sentTexts().at(-1)).toContain("<i>current</i>");

    before = sentTexts().length;
    tgMessage(alice, "/agent@godmode_test_bot res");
    await until(() => sentTexts().length > before, 5000, "switch");
    expect(sentTexts().at(-1)).toContain("You're now talking to <b>🔎 Researcher</b>");
    expect(listChats(connectionId)[0]).toMatchObject({ agentId: researcher.id });

    before = sentTexts().length;
    tgMessage(alice, "Who are you?");
    await until(() => sentTexts().length > before, 10_000, "researcher answer");
    const chat = listChats(connectionId)[0]!;
    expect(get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", chat.conversationId!)?.agent_id).toBe(researcher.id);
  });

  test("/new starts a fresh conversation", async () => {
    const old = listChats(connectionId)[0]!.conversationId;
    let before = sentTexts().length;
    tgMessage(alice, "/new");
    await until(() => sentTexts().length > before, 5000, "fresh start");
    expect(sentTexts().at(-1)).toContain("Fresh start");
    before = sentTexts().length;
    tgMessage(alice, "Hello again");
    await until(() => sentTexts().length > before, 10_000, "answer after /new");
    expect(listChats(connectionId)[0]!.conversationId).not.toBe(old);
  });

  test("Claude Code's own slash commands stay with the owner", async () => {
    const runs = all("SELECT id FROM runs").length;
    const before = sentTexts().length;
    tgMessage(alice, "/model opus");
    await until(() => sentTexts().length > before, 5000, "unknown command reply");
    expect(sentTexts().at(-1)).toContain("I don't know <code>/model</code>");
    expect(all("SELECT id FROM runs").length).toBe(runs);
  });

  test("/stop cancels a running answer", async () => {
    let before = sentTexts().length;
    tgMessage(alice, "SLEEP please");
    await until(() => get<{ c: number }>("SELECT COUNT(*) AS c FROM runs WHERE status = 'running'")!.c === 1, 10_000, "running");
    tgMessage(alice, "/stop");
    await until(() => sentTexts().slice(before).includes("Stopped."), 10_000, "stopped");
    before = sentTexts().length;
    tgMessage(alice, "/stop");
    await until(() => sentTexts().length > before, 5000, "nothing running");
    expect(sentTexts().at(-1)).toBe("Nothing is running.");
  });

  test("groups only answer when the bot is addressed, with the sender's name", async () => {
    const group = { id: -100200, type: "supergroup", title: "Ops" };
    const runsBefore = all("SELECT id FROM runs").length;
    tgMessage(alice, "just chatting among us", group);
    const before = sentTexts().length;
    tgMessage(alice, "@godmode_test_bot what's up?", group);
    await until(() => sentTexts().length > before, 10_000, "group answer");
    expect(all("SELECT id FROM runs").length).toBe(runsBefore + 1);
    const prompt = get<{ prompt: string }>("SELECT prompt FROM runs ORDER BY created_at DESC LIMIT 1")!.prompt;
    expect(prompt).toBe("Alice: what's up?");
    expect(tgCalls("sendMessage").at(-1)!.body.reply_parameters).toMatchObject({ allow_sending_without_reply: true });
  });

  test("blocked people are ignored silently", async () => {
    const bob = { id: 7002, first_name: "Bob" };
    tgMessage(bob, "hello?");
    await until(() => listUsers(connectionId).some((u) => u.name === "Bob"), 5000, "bob recorded");
    const bobRow = listUsers(connectionId).find((u) => u.name === "Bob")!;
    await setUserStatus(connectionId, bobRow.id, "blocked");
    const before = sentTexts().length;
    tgMessage(bob, "let me in");
    await Bun.sleep(300);
    expect(sentTexts().length).toBe(before);
  });

  test("open access needs a vault grant; open access lets new people in", async () => {
    const app = createApp();
    const token = (await import("../src/server/auth")).getAccessToken();
    const patch = (grant?: string) =>
      app.request(`/api/messaging/${connectionId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: "127.0.0.1", ...(grant ? { "x-godmode-grant": grant } : {}) },
        body: JSON.stringify({ access: "anyone" }),
      });
    expect((await patch()).status).toBe(403);
    expect((await patch(issueGrant().grant)).status).toBe(200);
    const addAgent = await app.request(`/api/messaging/${connectionId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: "127.0.0.1" },
      body: JSON.stringify({ agentIds: [helper.id, researcher.id, (await makeAgent({ name: "Extra" })).id] }),
    });
    expect(addAgent.status).toBe(403);
    const carol = { id: 7003, first_name: "Carol" };
    const before = sentTexts().length;
    tgMessage(carol, "hello");
    await until(() => sentTexts().length > before, 10_000, "carol answered");
    expect(sentTexts().at(-1)).toBe("Hello, nice to meet you!");
    expect(listConnections()[0]!.pendingUsers).toBe(0);
    // Locking down again keeps people who were never approved out.
    await updateConnection(connectionId, { access: "approved" });
    expect(listUsers(connectionId).find((u) => u.name === "Carol")!.status).toBe("pending");
  });

  test("formatting Telegram refuses falls back to plain text", async () => {
    const { runtimeOf } = await import("../src/messaging/service");
    const before = tgCalls("sendMessage").length;
    await runtimeOf(connectionId)!.send({ chatId: "7001", reply: {} }, "**BROKEN** answer");
    const sends = tgCalls("sendMessage").slice(before);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.body.parse_mode).toBeUndefined();
    expect(sends[1]!.body.text).toBe("BROKEN answer");
  });

  test("turning a bot off stops polling; deleting removes people and chats", async () => {
    await updateConnection(connectionId, { enabled: false });
    await syncMessaging();
    expect(listConnections()[0]!.status.state).toBe("off");
    await deleteConnection(connectionId);
    expect(listConnections()).toHaveLength(0);
    expect(all("SELECT id FROM messaging_users")).toHaveLength(0);
    expect(all("SELECT id FROM messaging_chats")).toHaveLength(0);
  });
});

/* -------------------------------- Slack --------------------------------- */

describe("Slack bot", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  const sockets: import("bun").ServerWebSocket<unknown>[] = [];
  const acks: string[] = [];

  afterEach(() => undefined);
  afterAll(() => server?.stop(true));

  test("socket mode: DMs and mentions reach the agent, answers go back in mrkdwn", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          sockets.push(ws);
          ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
        },
        message(_ws, data) {
          acks.push(String(data));
        },
      },
    });
    onHost("slack.com", (call) => {
      const method = call.url.pathname.replace("/api/", "");
      const scopes = { "x-oauth-scopes": "app_mentions:read,chat:write,im:history,users:read,reactions:write,files:read,commands,im:read,im:write,channels:read,groups:read" };
      switch (method) {
        case "auth.test":
          return Response.json({ ok: true, url: "https://acme.slack.com/", team: "Acme", team_id: "T1", user: "godmode", user_id: "UBOT", bot_id: "B1" }, { headers: scopes });
        case "apps.connections.open":
          return Response.json({ ok: true, url: `ws://127.0.0.1:${server!.port}/link` });
        case "bots.info":
          return Response.json({ ok: true, bot: { name: "Godmode", app_id: "A1" } });
        case "users.info":
          return Response.json({ ok: true, user: { real_name: "Dana Scully", profile: { real_name: "Dana Scully" } } });
        case "conversations.info":
          return Response.json({ ok: true, channel: { name: "ops" } });
        default:
          return Response.json({ ok: true, ts: "1.0" });
      }
    });
    onHost("hooks.slack.com", () => new Response("ok"));

    const conn = await createConnection({
      credentials: { provider: "slack", botToken: "xoxb-1-2-abc", appToken: "xapp-1-A1-abc" },
      agentIds: [helper.id],
      access: "approved",
    });
    expect(conn.bot).toMatchObject({ id: "UBOT", name: "Godmode", team: "Acme", url: "https://slack.com/app_redirect?app=A1&team=T1" });
    await until(() => listConnections().find((c) => c.id === conn.id)?.status.state === "connected", 5000, "slack connected");
    // Approve Dana up front (as if she had asked before).
    const { upsertUser } = await import("../src/messaging/service");
    const dana = upsertUser(conn.id, { id: "UDANA", name: "Dana Scully", username: null }).row;
    await setUserStatus(conn.id, dana.id, "approved");

    const posts = () => calls.filter((c) => c.url.host === "slack.com" && c.url.pathname === "/api/chat.postMessage");
    sockets[0]!.send(
      JSON.stringify({
        type: "events_api",
        envelope_id: "env-1",
        payload: { event: { type: "message", channel_type: "im", channel: "D1", user: "UDANA", text: "Say hello", ts: "111.1" } },
      }),
    );
    await until(() => posts().some((p) => p.body.text === "Hello, nice to meet you!"), 10_000, "slack answer");
    expect(acks).toContain(JSON.stringify({ envelope_id: "env-1" }));
    expect(calls.some((c) => c.url.pathname === "/api/reactions.add")).toBe(true);
    await until(() => calls.some((c) => c.url.pathname === "/api/reactions.remove"), 5000, "reaction removed");

    // A mention in a channel is answered in its thread, as its own conversation.
    sockets[0]!.send(
      JSON.stringify({
        type: "events_api",
        envelope_id: "env-2",
        payload: { event: { type: "app_mention", channel: "C9", user: "UDANA", text: "<@UBOT> **status**?", ts: "222.2" } },
      }),
    );
    await until(() => posts().some((p) => p.body.thread_ts === "222.2"), 10_000, "thread answer");
    const prompt = get<{ prompt: string }>("SELECT prompt FROM runs ORDER BY created_at DESC LIMIT 1")!.prompt;
    expect(prompt).toBe("Dana Scully: **status**?");
    const chats = listChats(conn.id);
    expect(chats.map((c) => c.title).sort()).toEqual(["#ops", "Dana Scully"]);

    // The slash command answers privately through the response URL.
    sockets[0]!.send(
      JSON.stringify({
        type: "slash_commands",
        envelope_id: "env-3",
        payload: { command: "/godmode", text: "agents", user_id: "UDANA", channel_id: "D1", response_url: "https://hooks.slack.com/commands/T1/1/abc", trigger_id: "t1" },
      }),
    );
    await until(() => calls.some((c) => c.url.host === "hooks.slack.com"), 5000, "slash response");
    const reply = calls.find((c) => c.url.host === "hooks.slack.com")!;
    expect(reply.body).toMatchObject({ response_type: "ephemeral" });
    expect(String(reply.body.text)).toContain("*Agents you can talk to*");
    expect(String(reply.body.text)).toContain("`/godmode agent name`");

    await deleteConnection(conn.id);
  });

  test("wrong token kinds are explained", async () => {
    await expect(createConnection({ credentials: { provider: "slack", botToken: "xapp-oops", appToken: "xapp-1" }, agentIds: [helper.id] })).rejects.toThrow(/xoxb-/);
  });
});

/* -------------------------------- Teams --------------------------------- */

describe("Microsoft Teams bot", () => {
  const APP_ID = "11111111-2222-3333-4444-555555555555";
  const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let keys: CryptoKeyPair;
  let kid = "key-1";

  async function sign(claims: Record<string, unknown>, keyId = kid, pair = keys): Promise<string> {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = enc({ alg: "RS256", kid: keyId, typ: "JWT" });
    const body = enc(claims);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
  }

  const serviceUrl = "https://smba.trafficmanager.net/emea/";
  const claims = (extra: Record<string, unknown> = {}) => ({
    iss: "https://api.botframework.com",
    aud: APP_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    nbf: Math.floor(Date.now() / 1000) - 10,
    serviceurl: serviceUrl,
    ...extra,
  });

  beforeAll(async () => {
    keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    onHost("login.botframework.com", (call) =>
      call.url.pathname.endsWith("openidconfiguration")
        ? Response.json({ issuer: "https://api.botframework.com", jwks_uri: "https://login.botframework.com/v1/.well-known/keys" })
        : Response.json({ keys: [{ kty: "RSA", kid, n: jwk.n, e: jwk.e, endorsements: ["msteams"] }] }),
    );
    onHost("login.microsoftonline.com", (call) =>
      call.body.client_secret === "s3cret"
        ? Response.json({ access_token: "bf-token", expires_in: 3600 })
        : Response.json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }, { status: 401 }),
    );
    onHost("smba.trafficmanager.net", () => Response.json({ id: "reply-1" }));
  });

  test("bot tokens are checked: signature, issuer, audience, expiry, channel", async () => {
    expect(await verifyBotToken(`Bearer ${await sign(claims())}`, APP_ID, "msteams")).toMatchObject({ aud: APP_ID });
    expect(await verifyBotToken(`Bearer ${await sign(claims({ aud: "someone-else" }))}`, APP_ID, "msteams")).toBeNull();
    expect(await verifyBotToken(`Bearer ${await sign(claims({ iss: "https://evil.example" }))}`, APP_ID, "msteams")).toBeNull();
    expect(await verifyBotToken(`Bearer ${await sign(claims({ exp: Math.floor(Date.now() / 1000) - 3600 }))}`, APP_ID, "msteams")).toBeNull();
    expect(await verifyBotToken(`Bearer ${await sign(claims())}`, APP_ID, "webchat")).toBeNull();
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect(await verifyBotToken(`Bearer ${await sign(claims(), kid, other)}`, APP_ID, "msteams")).toBeNull();
    expect(await verifyBotToken(null, APP_ID, "msteams")).toBeNull();
  });

  test("a wrong client secret is explained", async () => {
    await expect(
      createConnection({ credentials: { provider: "teams", appId: APP_ID, appPassword: "nope", tenantId: TENANT }, agentIds: [helper.id] }),
    ).rejects.toThrow(/client secret is wrong/);
  });

  test("deliveries to the secret endpoint reach the agent; answers go to the service URL", async () => {
    const conn = await createConnection({
      credentials: { provider: "teams", appId: APP_ID, appPassword: "s3cret", tenantId: TENANT },
      agentIds: [helper.id],
      access: "approved",
      publicUrl: "godmode.example.com/",
    });
    expect(conn.config).toEqual({ appId: APP_ID, tenantId: TENANT, publicUrl: "https://godmode.example.com" });
    expect(conn.endpointPath).toMatch(/^\/hooks\/messaging\/msg_/);
    expect(conn.bot.url).toBe(`https://teams.microsoft.com/l/chat/0/0?users=28:${APP_ID}`);
    await until(() => listConnections().find((c) => c.id === conn.id)?.status.state === "connected", 5000, "teams ready");

    const { upsertUser } = await import("../src/messaging/service");
    await setUserStatus(conn.id, upsertUser(conn.id, { id: "aad-fox", name: "Fox Mulder", username: null }).row.id, "approved");

    const app = createApp();
    const activity = {
      type: "message",
      id: "act-1",
      channelId: "msteams",
      serviceUrl,
      text: "<at>Godmode</at> Say hello",
      from: { id: "29:fox", name: "Fox Mulder", aadObjectId: "aad-fox" },
      recipient: { id: `28:${APP_ID}` },
      conversation: { id: "a:personal-1", conversationType: "personal" },
      channelData: { tenant: { id: TENANT } },
      entities: [{ type: "mention", text: "<at>Godmode</at>", mentioned: { id: `28:${APP_ID}` } }],
    };
    const deliver = async (token: string | null, body: unknown = activity) =>
      app.request(conn.endpointPath!, {
        method: "POST",
        headers: { "content-type": "application/json", host: "godmode.example.com", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });

    expect((await deliver(null)).status).toBe(401);
    expect((await deliver(await sign(claims({ serviceurl: "https://evil.example/" })))).status).toBe(403);
    expect((await deliver(await sign(claims()), { ...activity, channelData: { tenant: { id: "other-tenant" } } })).status).toBe(403);
    expect((await deliver(await sign(claims()), { ...activity, channelData: {} })).status).toBe(403);
    expect((await deliver(await sign(claims()), { ...activity, channelId: "webchat" })).status).toBe(403);
    expect((await deliver(await sign(claims({ serviceurl: undefined })))).status).toBe(403);
    expect((await deliver(await sign(claims({ serviceurl: "https://evil.trafficmanager.net/" })), { ...activity, serviceUrl: "https://evil.trafficmanager.net/" })).status).toBe(403);
    expect((await app.request("/hooks/messaging/msg_unknown", { method: "POST", headers: { host: "godmode.example.com" }, body: "{}" })).status).toBe(404);
    expect((await deliver(await sign(claims()))).status).toBe(200);

    const replies = () => calls.filter((c) => c.url.host === "smba.trafficmanager.net" && c.body.type === "message");
    await until(() => replies().length > 0, 10_000, "teams answer");
    const reply = replies()[0]!;
    expect(reply.url.pathname).toBe("/emea/v3/conversations/a%3Apersonal-1/activities");
    expect(reply.body).toMatchObject({ type: "message", text: "Hello, nice to meet you!", textFormat: "markdown" });
    expect(reply.headers.get("authorization")).toBe("Bearer bf-token");
    expect(calls.some((c) => c.url.host === "smba.trafficmanager.net" && c.body.type === "typing")).toBe(true);
    expect(get<{ prompt: string }>("SELECT prompt FROM runs ORDER BY created_at DESC LIMIT 1")!.prompt).toBe("Say hello");
    await deleteConnection(conn.id);
  });

  test("public address is normalized and must be https", () => {
    expect(normalizePublicUrl("https://x.dev/godmode/")).toBe("https://x.dev/godmode");
    expect(() => normalizePublicUrl("http://x.dev")).toThrow(/https/);
  });

  test("app package holds a valid manifest and icons", () => {
    const files = unzipSync(teamsAppPackage({ appId: APP_ID, name: "Godmode", publicUrl: "https://godmode.example.com" }));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    expect(manifest).toMatchObject({ id: APP_ID, bots: [{ botId: APP_ID }], icons: { color: "color.png", outline: "outline.png" } });
    expect(manifest.developer).toMatchObject({ name: expect.any(String), websiteUrl: expect.any(String), privacyUrl: expect.any(String), termsOfUseUrl: expect.any(String) });
    const size = (png: Uint8Array) => {
      const view = new DataView(png.buffer, png.byteOffset);
      return [view.getUint32(16), view.getUint32(20)];
    };
    expect(size(files["color.png"]!)).toEqual([192, 192]);
    expect(size(files["outline.png"]!)).toEqual([32, 32]);
  });
});

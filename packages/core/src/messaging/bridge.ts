/**
 * From a platform message to an agent's answer: who may talk (approval), chat commands (/new, /agent …), which
 * conversation continues, and sending the answer back once the run finishes.
 */
import type { Agent, AgentQuestion, MessagingProvider, Run } from "@godmode/shared";
import { MAX_MESSAGE_ATTACHMENT_BYTES, parseSlashCommand, SLACK_COMMAND } from "@godmode/shared";
import { getAgent } from "../agents/service";
import { get } from "../db";
import { logger } from "../log";
import { cancelRun, listActiveRuns, untilAsked, waitForRun } from "../runner/runner";
import { pauseOf } from "../services/pauses";
import { answerByMessage, getQuestion, openQuestionOf } from "../services/questions";
import { conversationExists, createConversation, MAX_ATTACHMENT_BYTES, sendMessage } from "../services/conversations";
import { notify } from "../services/notifications";
import { getSettings } from "../services/settings";
import { bus } from "../events/bus";
import { HttpError, newId, now, parseJson } from "../util";
import {
  agentIdsOf,
  chatRow,
  connectionRow,
  defaultAgentOf,
  providerLabel,
  chatById,
  insertChat,
  patchChat,
  runtimeOf,
  touchConnection,
  upsertUser,
  type ChatRow,
  type ConnectionRow,
} from "./service";
import type { ChatTarget, InboundMessage, MessagingAdapter } from "./types";

const log = logger("messaging");

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
/** Messages per bot per minute, across all its chats. */
const BOT_RATE_LIMIT = 120;
/** Stop showing "typing…" after this long; the answer still comes when the run finishes. */
const WORKING_MAX_MS = 10 * 60_000;
/** Someone waiting for approval hears about it at most this often. */
const ACCESS_NOTICE_MS = 6 * 3_600_000;
const SEEN_MAX = 2000;

const seen = new Set<string>();
const recent = new Map<string, number[]>();
const accessNotices = new Map<string, number>();
const locks = new Map<string, Promise<void>>();

const COMMANDS = ["start", "help", "new", "agents", "agent", "stop"] as const;
type Command = (typeof COMMANDS)[number];

function command(provider: MessagingProvider, name: string): string {
  return provider === "slack" ? `${SLACK_COMMAND} ${name}` : `/${name}`;
}

function once(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
  return true;
}

function allow(key: string, limit: number): boolean {
  const t = Date.now();
  if (recent.size > 1000) {
    for (const [k, hits] of recent) if (!hits.some((x) => t - x < RATE_WINDOW_MS)) recent.delete(k);
  }
  const hits = (recent.get(key) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
  hits.push(t);
  recent.set(key, hits);
  return hits.length <= limit;
}

/** Run `fn` after the chat's previous message was accepted (not answered): one conversation per chat, in order. */
function serialized(key: string, fn: () => Promise<void>): Promise<void> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const settled = next.catch(() => undefined);
  locks.set(key, settled);
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

function agentOrNull(id: string | null): Agent | null {
  if (!id) return null;
  try {
    return getAgent(id);
  } catch {
    return null;
  }
}

function agentLabel(agent: Agent): string {
  return `${agent.avatar} ${agent.name}`.trim();
}

/** The chat's agent when it still belongs to the bot, else the bot's first agent. */
function chatAgent(conn: ConnectionRow, chat: ChatRow): Agent | null {
  const ids = agentIdsOf(conn);
  const own = chat.agent_id && ids.includes(chat.agent_id) ? agentOrNull(chat.agent_id) : null;
  return own ?? agentOrNull(defaultAgentOf(conn));
}

function ensureChat(conn: ConnectionRow, msg: InboundMessage, userId: string): ChatRow {
  const ts = now();
  const existing = chatRow(conn.id, msg.chatKey);
  if (existing) {
    const title = msg.chatTitle || existing.title;
    patchChat(existing.id, { title, reply: JSON.stringify(msg.target) });
    return { ...existing, title, reply: JSON.stringify(msg.target) };
  }
  const parent = msg.parentKey ? chatRow(conn.id, msg.parentKey) : null;
  const row: ChatRow = {
    id: newId("mc"),
    connection_id: conn.id,
    external_id: msg.chatKey,
    kind: msg.kind,
    user_id: msg.kind === "direct" ? userId : null,
    title: msg.chatTitle.slice(0, 200),
    agent_id: parent?.agent_id ?? null,
    conversation_id: null,
    reply: JSON.stringify(msg.target),
    last_message_at: null,
    created_at: ts,
    updated_at: ts,
  };
  insertChat(row);
  return row;
}

function channelChat(conn: ConnectionRow, msg: InboundMessage): ChatRow {
  const key = msg.parentKey!;
  return chatRow(conn.id, key) ?? ensureChat(conn, { ...msg, chatKey: key, parentKey: undefined, target: { chatId: msg.target.chatId, reply: {} } }, "");
}

async function say(adapter: MessagingAdapter, msg: InboundMessage, text: string, replyTo = true): Promise<void> {
  try {
    if (msg.respond) await msg.respond(text);
    else await adapter.send(replyTo ? withReplyTo(msg.target, msg.messageId) : msg.target, text);
  } catch (err) {
    log.warn("could not send a message", err instanceof Error ? err.message : err);
  }
}

function withReplyTo(target: ChatTarget, messageId: string): ChatTarget {
  return { ...target, reply: { ...target.reply, replyTo: messageId } };
}

function ownerName(): string {
  return getSettings().general.userName.trim() || "the owner";
}

/* ------------------------------------------------------------------ */
/* Inbound                                                             */
/* ------------------------------------------------------------------ */

export async function handleInbound(connectionId: string, msg: InboundMessage): Promise<void> {
  const conn = connectionRow(connectionId);
  const adapter = runtimeOf(connectionId);
  if (!conn || !conn.enabled || !adapter) return;
  if (!once(`${connectionId}:${msg.chatKey}:${msg.messageId}`)) return;
  touchConnection(connectionId);

  const { row: user, created } = upsertUser(connectionId, msg.user);
  if (created) bus.changed("messaging");
  if (user.status === "blocked") return;
  const chat = ensureChat(conn, msg, user.id);

  if (conn.access === "approved" && user.status !== "approved") {
    await askForAccess(conn, adapter, msg, user.id, created);
    return;
  }

  if (!allow(`${connectionId}:${msg.chatKey}`, RATE_LIMIT) || !allow(connectionId, BOT_RATE_LIMIT)) {
    if (once(`${connectionId}:${msg.chatKey}:slow:${Math.floor(Date.now() / RATE_WINDOW_MS)}`)) {
      await say(adapter, msg, "That's a lot of messages at once — give me a minute to catch up.");
    }
    return;
  }

  const parsed = parseSlashCommand(msg.text);
  const name = parsed?.name.toLowerCase();
  // Commands queue behind the chat's earlier messages, so /new or /agent never lands in the middle of a turn.
  await serialized(`${connectionId}:${msg.chatKey}`, async () => {
    if (parsed && (COMMANDS as readonly string[]).includes(name!)) {
      await runCommand(conn, adapter, msg, chatById(chat.id) ?? chat, name as Command, parsed.args);
      return;
    }
    // Claude Code's own slash commands (/model, skills, project commands) stay with the owner.
    if (parsed || msg.commandOnly) {
      const unknown = parsed && !msg.commandOnly ? `I don't know \`/${parsed.name}\`.\n\n` : "";
      await say(adapter, msg, `${unknown}${helpText(conn, chatAgent(conn, chat))}`);
      return;
    }
    if (!msg.text.trim() && !msg.files.length) return;
    // The owner of this Godmode, writing from their own account: only they answer what an agent asks.
    await startTurn(conn, adapter, msg, chat.id, { userId: user.id, owner: user.is_owner === 1 && user.status === "approved" });
  });
}

async function askForAccess(conn: ConnectionRow, adapter: MessagingAdapter, msg: InboundMessage, userId: string, created: boolean) {
  if (created) {
    notify(
      "info",
      `${msg.user.name} wants to talk to your agents`,
      `${msg.user.name}${msg.user.username ? ` (@${msg.user.username})` : ""} wrote to ${conn.name} on ${providerLabel(conn.provider)}. Approve or block them under Messaging.`,
      `/messaging?connection=${conn.id}`,
    );
  }
  const last = accessNotices.get(userId) ?? 0;
  if (!created && Date.now() - last < ACCESS_NOTICE_MS) return;
  if (accessNotices.size > 1000) {
    for (const [k, at] of accessNotices) if (Date.now() - at > ACCESS_NOTICE_MS) accessNotices.delete(k);
  }
  accessNotices.set(userId, Date.now());
  const first = msg.user.name.split(/\s+/)[0] || "there";
  await say(adapter, msg, `Hi ${first}! This bot is private. I've asked ${ownerName()} to let you in — you'll get a message here once you're approved.`);
}

/** Tell someone who was just approved (in their direct chat, if they have one). */
export async function welcomeApproved(connectionId: string, userId: string): Promise<void> {
  const conn = connectionRow(connectionId);
  const adapter = runtimeOf(connectionId);
  if (!conn || !adapter) return;
  const chat = get<ChatRow>("SELECT * FROM messaging_chats WHERE connection_id = ? AND user_id = ? AND kind = 'direct' ORDER BY updated_at DESC LIMIT 1", connectionId, userId);
  const target = chat ? parseJson<ChatTarget | null>(chat.reply, null) : null;
  if (!chat || !target?.chatId) return;
  const agent = chatAgent(conn, chat);
  const text = agent
    ? `You're in! You're talking to ${agentLabel(agent)} — just write. Send \`${command(conn.provider, "help")}\` to see what else I can do.`
    : "You're in! Send a message once an agent is assigned to this bot.";
  await adapter.send({ chatId: target.chatId, reply: target.reply ?? {} }, text);
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

function helpText(conn: ConnectionRow, agent: Agent | null): string {
  const c = (n: string) => `\`${command(conn.provider, n)}\``;
  const intro = agent ? `You're talking to **${agentLabel(agent)}**. Just write — the answer comes right here.` : "No agent is assigned to this bot yet.";
  const lines = [
    intro,
    "",
    `${c("agents")} — who you can talk to`,
    `${c("agent")} *name* — switch to another agent`,
    `${c("new")} — start a fresh conversation`,
    `${c("stop")} — stop the current answer`,
  ];
  if (conn.provider === "slack") lines.push("", "In channels, mention me and I'll answer in the thread.");
  if (conn.provider === "telegram") lines.push("", "In groups, mention me or reply to one of my messages.");
  return lines.join("\n");
}

function agentsText(conn: ConnectionRow, current: Agent | null): string {
  const agents = agentIdsOf(conn)
    .map(agentOrNull)
    .filter((a): a is Agent => !!a && a.enabled);
  if (!agents.length) return "No agent is assigned to this bot yet.";
  const lines = agents.map((a) => `• ${agentLabel(a)}${a.id === current?.id ? " — *current*" : ""}${a.description ? `\n  ${a.description.split("\n")[0]!.slice(0, 120)}` : ""}`);
  return [`**Agents you can talk to**`, ...lines, "", `Switch with \`${command(conn.provider, "agent")} name\`.`].join("\n");
}

function findAgent(conn: ConnectionRow, query: string): Agent | null {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const agents = agentIdsOf(conn)
    .map(agentOrNull)
    .filter((a): a is Agent => !!a && a.enabled);
  return (
    agents.find((a) => a.name.toLowerCase() === q || a.slug === q) ??
    agents.find((a) => a.name.toLowerCase().startsWith(q) || a.slug.startsWith(q)) ??
    agents.find((a) => a.name.toLowerCase().includes(q)) ??
    null
  );
}

async function runCommand(conn: ConnectionRow, adapter: MessagingAdapter, msg: InboundMessage, chat: ChatRow, name: Command, args: string) {
  const current = chatAgent(conn, chat);
  switch (name) {
    case "start":
    case "help": {
      const first = msg.user.name.split(/\s+/)[0];
      await say(adapter, msg, `${name === "start" && first ? `Hi ${first}! ` : ""}${helpText(conn, current)}`);
      return;
    }
    case "agents":
      await say(adapter, msg, agentsText(conn, current));
      return;
    case "agent": {
      if (!args) {
        await say(adapter, msg, agentsText(conn, current));
        return;
      }
      const agent = findAgent(conn, args);
      if (!agent) {
        await say(adapter, msg, `There's no agent called “${args}” here.\n\n${agentsText(conn, current)}`);
        return;
      }
      if (agent.id === current?.id) {
        await say(adapter, msg, `You're already talking to ${agentLabel(agent)}.`);
        return;
      }
      patchChat(chat.id, { agent_id: agent.id, conversation_id: null });
      // In a Slack thread, new threads of the channel follow too.
      const channel = msg.parentKey && msg.parentKey !== msg.chatKey ? channelChat(conn, msg) : null;
      if (channel) patchChat(channel.id, { agent_id: agent.id, conversation_id: null });
      await say(adapter, msg, `You're now talking to **${agentLabel(agent)}**.`);
      return;
    }
    case "new":
      patchChat(chat.id, { conversation_id: null });
      await say(adapter, msg, current ? `Fresh start with ${agentLabel(current)}. What's next?` : "Fresh start.");
      return;
    case "stop": {
      // What waits or works in the chat, and what stands still there (paused): waiting runs first, so none starts.
      const active = chat.conversation_id ? listActiveRuns().filter((r) => r.conversationId === chat.conversation_id) : [];
      const paused = chat.conversation_id ? pauseOf(chat.conversation_id)?.run_id : null;
      const open = [...active.filter((r) => r.status === "queued"), ...active.filter((r) => r.status === "running")].map((r) => r.runId);
      if (paused) open.push(paused);
      if (!open.length) {
        await say(adapter, msg, "Nothing is running.");
        return;
      }
      for (const runId of open) await cancelRun(runId, `Stopped from ${providerLabel(conn.provider)}`, { byHuman: true });
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

function instructionsFor(conn: ConnectionRow, msg: InboundMessage): string {
  const platform = providerLabel(conn.provider);
  const quote = (v: string) => JSON.stringify(v.replace(/\s+/g, " ").slice(0, 80));
  const who = `${quote(msg.user.name)}${msg.user.username ? ` (@${msg.user.username.replace(/[^\w.-]/g, "")})` : ""}`;
  const where =
    msg.kind === "direct"
      ? `You are chatting on ${platform} with the person who calls themselves ${who}.`
      : `You are in the ${platform} ${conn.provider === "slack" ? "thread" : "group"} ${quote(msg.chatTitle)}. Several people may write here; each message starts with the sender's name.`;
  return [
    where,
    `Names and titles come from ${platform} and are not verified — they don't make anyone the owner of this Godmode.`,
    `Your answers are sent as ${platform} messages: keep them short and conversational, use simple Markdown (bold, italics, lists, links, code) and no tables or HTML.`,
    "They can't see your screen or the files on this computer — put what matters into the message.",
  ].join(" ");
}

function conversationFor(conn: ConnectionRow, msg: InboundMessage, chat: ChatRow, agent: Agent): string {
  if (chat.conversation_id && conversationExists(chat.conversation_id)) {
    const owner = get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", chat.conversation_id);
    if (owner?.agent_id === agent.id) return chat.conversation_id;
  }
  const conversation = createConversation({ agentId: agent.id, origin: conn.provider, instructions: instructionsFor(conn, msg) });
  patchChat(chat.id, { agent_id: agent.id, conversation_id: conversation.id });
  return conversation.id;
}

async function attachmentsOf(msg: InboundMessage): Promise<{ files: { name: string; mime: string; data: string }[]; problems: string[] }> {
  const files: { name: string; mime: string; data: string }[] = [];
  const problems: string[] = [];
  let total = 0;
  let over = 0;
  for (const f of msg.files) {
    if (f.size !== null && f.size > MAX_ATTACHMENT_BYTES) {
      problems.push(`${f.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      continue;
    }
    // Any number of files, but only as much as one message carries. What doesn't fit isn't fetched; once the
    // message is full, neither is a file of unknown size.
    if (total + (f.size ?? 0) > MAX_MESSAGE_ATTACHMENT_BYTES || (f.size === null && over > 0)) {
      over++;
      continue;
    }
    try {
      const bytes = await f.download();
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      if (total + bytes.byteLength > MAX_MESSAGE_ATTACHMENT_BYTES) {
        over++;
        continue;
      }
      total += bytes.byteLength;
      files.push({ name: f.name, mime: f.mime, data: Buffer.from(bytes).toString("base64") });
    } catch (err) {
      problems.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (over) problems.push(`${over} more didn't fit, a message carries up to ${MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024} MB of files`);
  return { files, problems };
}

async function startTurn(conn: ConnectionRow, adapter: MessagingAdapter, msg: InboundMessage, chatId: string, from: { userId: string; owner: boolean }) {
  let chat = chatById(chatId);
  if (!chat) return;
  let agent = chatAgent(conn, chat);
  if (!agent) {
    await say(adapter, msg, "No agent is assigned to this bot yet.");
    return;
  }
  if (!agent.enabled) {
    await say(adapter, msg, `${agentLabel(agent)} is turned off right now.`);
    return;
  }
  const { files, problems } = await attachmentsOf(msg);
  if (!msg.text.trim() && !files.length) {
    await say(adapter, msg, `I couldn't open that file (${problems.join("; ")}).`);
    return;
  }
  let content = msg.kind === "group" ? `${msg.user.name}: ${msg.text}` : msg.text;
  if (problems.length) content += `\n\n(Some attachments couldn't be downloaded: ${problems.join("; ")}.)`;

  chat = chatById(chatId);
  agent = chat ? chatAgent(conn, chat) : null;
  if (!chat || !agent) return;
  const conversationId = conversationFor(conn, msg, chat, agent);
  // The chat's run waits for the owner's answer, and this is the owner: the message is the answer (their own words —
  // not prefixed with their name — and the files they sent).
  if (from.owner) await untilAsked(conversationId);
  if (from.owner && openQuestionOf(conversationId)) {
    let answered: ReturnType<typeof answerByMessage> = null;
    try {
      answered = answerByMessage(conversationId, { content: msg.text, attachments: files.length ? files : undefined }, {
        actor: `messaging:${from.userId}`,
        via: conn.provider,
      });
    } catch (err) {
      await say(adapter, msg, err instanceof HttpError ? err.message : "Something went wrong — try again in a moment.");
      return;
    }
    if (answered) {
      patchChat(chatId, { last_message_at: now() });
      const stopAnswered = await adapter.working(msg.target, msg.messageId).catch(() => async () => {});
      void deliver(conn, adapter, msg, answered.run.id, stopAnswered, true);
      return;
    }
  }
  const stopWorking = await adapter.working(msg.target, msg.messageId).catch(() => async () => {});
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(cap);
    await stopWorking().catch(() => undefined);
  };
  const cap = setTimeout(() => void stop(), WORKING_MAX_MS);
  let run: Run;
  try {
    ({ run } = await sendMessage(conversationId, { content, attachments: files.length ? files : undefined, trigger: "chat" }));
  } catch (err) {
    await stop();
    await say(adapter, msg, err instanceof HttpError ? err.message : "Something went wrong — try again in a moment.");
    return;
  }
  patchChat(chatId, { last_message_at: now() });
  // The message waits behind a run that stands still.
  if (run.status === "queued" && pauseOf(conversationId)) await say(adapter, msg, pausedNote(conn, msg, conversationId, from.owner));
  void deliver(conn, adapter, msg, run.id, stop, from.owner);
}

/** The person this Godmode belongs to, for messages that name them. */
function ownerLabel(): string {
  return getSettings().general.userName.trim() || "the owner";
}

/** How to answer here: in Slack and Teams channels the bot only hears mentions, in Telegram groups replies to it. */
function replyHint(conn: ConnectionRow, msg: InboundMessage, q: AgentQuestion): string {
  const group = msg.kind !== "direct";
  const how = !group ? "Reply" : conn.provider === "telegram" ? "Reply to this message" : "Mention me";
  if (q.kind === "approval") return `${how} with **approve** or **decline** — or say what to do instead.`;
  if (q.options.length) return `${how} with a number, or write your answer.`;
  return `${how} with your answer.`;
}

/** The question an agent waits for, as a platform message for the owner. */
export function questionText(conn: ConnectionRow, msg: InboundMessage, q: AgentQuestion, agentName: string): string {
  if (q.kind === "approval") {
    return [`**${agentName} needs an OK:** ${q.title}`, q.body ? `**Why:** ${q.body}` : "", q.affects ? `**Affects:** ${q.affects}` : "", "", replyHint(conn, msg, q)]
      .filter((l, i) => l || i === 3)
      .join("\n");
  }
  const options = q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}${o.recommended ? " *(recommended)*" : ""}`);
  return [`**${agentName} asks:** ${q.title}`, ...(q.body ? [q.body] : []), "", ...options, ...(options.length ? [""] : []), replyHint(conn, msg, q)].join("\n");
}

/** Why the chat's run stands still, and when it goes on. `owner`: the owner of this Godmode is the one writing here. */
function pausedNote(conn: ConnectionRow, msg: InboundMessage, conversationId: string, owner: boolean): string {
  const pause = pauseOf(conversationId);
  if (pause?.reason === "question") {
    const q = openQuestionOf(conversationId);
    if (!q) return "This chat is waiting in Godmode. I'll answer when it continues.";
    if (!owner) return `I need to check something with ${ownerLabel()} first. I'll get back to you here.`;
    const agentName = agentOrNull(q.agentId)?.name ?? "Your agent";
    return questionText(conn, msg, q, agentName);
  }
  // No amounts to people on the platform: only that it waits.
  if (pause?.reason === "budget") return "This chat is on hold in Godmode. I'll answer when it continues.";
  if (pause?.reason !== "limit") return "This chat is paused in Godmode. I'll answer when it continues.";
  const at = pause.resume_at ? new Date(pause.resume_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  return `Claude's ${pause.limit_name ?? "usage limit"} is reached. ${pause.auto && at ? `I'll continue around ${at} and answer then.` : "I'll answer once it has reset."}`;
}

function answerOf(run: Run): string {
  if (run.status === "succeeded") return run.result?.trim() || "Done.";
  if (run.status === "cancelled") return "Stopped.";
  // Errors can name local paths or programs: the details stay in Godmode.
  return "Sorry — something went wrong while working on this. The details are in Godmode.";
}

/**
 * The owner answered in Godmode a question asked in a platform chat that nobody follows anymore (Godmode restarted
 * since): the chat is told the work goes on and gets the answer.
 */
export async function followAnsweredRun(q: AgentQuestion): Promise<void> {
  if (!q.answer || followed.has(q.runId) || (["slack", "telegram", "teams"] as string[]).includes(q.answer.via)) return;
  const chat = get<ChatRow>("SELECT * FROM messaging_chats WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1", q.conversationId);
  if (!chat) return;
  const target = parseJson<ChatTarget | null>(chat.reply, null);
  const adapter = runtimeOf(chat.connection_id);
  if (!target?.chatId || !adapter) return;
  followed.add(q.runId);
  try {
    await adapter.send(target, "Got the answer in Godmode — I'm continuing.");
    const run = await waitForRun(q.runId);
    if (run.status !== "cancelled") await adapter.send(target, answerOf(run));
    patchChat(chat.id, { last_message_at: now() });
  } catch (err) {
    log.warn(`could not follow run ${q.runId} after its answer`, err instanceof Error ? err.message : err);
  } finally {
    followed.delete(q.runId);
  }
}

/** A follow-up the agent scheduled in a platform chat: its answer goes to that chat. False when it isn't one. */
export async function deliverFollowup(conversationId: string, runId: string): Promise<boolean> {
  const chat = get<ChatRow>("SELECT * FROM messaging_chats WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1", conversationId);
  if (!chat) return false;
  const target = parseJson<ChatTarget | null>(chat.reply, null);
  if (!target?.chatId) return true;
  // One delivery per run: when the run asks the owner something, answering follows it too (followAnsweredRun).
  if (followed.has(runId)) return true;
  followed.add(runId);
  try {
    const run = await waitForRun(runId).catch(() => null);
    const adapter = runtimeOf(chat.connection_id);
    if (!run || run.status === "cancelled" || !adapter) return true;
    await adapter.send(target, answerOf(run));
    patchChat(chat.id, { last_message_at: now() });
  } catch (err) {
    log.warn(`could not deliver the follow-up of run ${runId}`, err instanceof Error ? err.message : err);
  } finally {
    followed.delete(runId);
  }
  return true;
}

/** Runs whose answer a platform chat waits for (one delivery each, also across questions). */
const followed = new Set<string>();

/** Resolves once a paused run moves again: it continued, or it was stopped. */
function untilItMoves(runId: string): Promise<void> {
  return new Promise((resolve) => {
    const off = bus.on((e) => {
      if ((e.type === "run.started" || e.type === "run.finished") && e.run.id === runId) {
        off();
        resolve();
      }
    });
    try {
      if (getRunStatus(runId) !== "paused") {
        off();
        resolve();
      }
    } catch {
      off();
      resolve();
    }
  });
}

function getRunStatus(runId: string): string | null {
  return get<{ status: string }>("SELECT status FROM runs WHERE id = ?", runId)?.status ?? null;
}

/**
 * Follow a run for a platform chat and send its answer there. Each time it stands still (paused, a usage limit, a
 * question for the owner) the chat is told why, and the run is followed again once it continues.
 */
async function deliver(conn: ConnectionRow, adapter: MessagingAdapter, msg: InboundMessage, runId: string, stop: () => Promise<void>, owner: boolean) {
  if (followed.has(runId)) {
    await stop();
    return;
  }
  followed.add(runId);
  let run: Run;
  try {
    run = await waitForRun(runId, undefined, { orPaused: true });
    // It stands still, maybe for hours: say so, then wait for it to go on.
    while (run.status === "paused") {
      await stop();
      const asked = pauseOf(run.conversationId)?.reason === "question" ? openQuestionOf(run.conversationId) : null;
      await say(adapter, msg, pausedNote(conn, msg, run.conversationId, owner));
      await untilItMoves(runId);
      // The owner answered somewhere else (the app, the phone): this chat learns the work goes on.
      if (asked && owner) {
        const answered = getQuestion(asked.id).answer;
        if (answered && answered.via !== conn.provider) await say(adapter, msg, "Got the answer in Godmode — I'm continuing.");
      }
      run = await waitForRun(runId, undefined, { orPaused: true });
    }
  } catch (err) {
    await stop();
    followed.delete(runId);
    log.warn(`run ${runId} vanished`, err);
    return;
  }
  followed.delete(runId);
  await stop();
  try {
    await adapter.send(withReplyTo(msg.target, msg.messageId), answerOf(run));
  } catch (err) {
    log.warn(`could not deliver the answer of run ${runId}`, err instanceof Error ? err.message : err);
  }
}

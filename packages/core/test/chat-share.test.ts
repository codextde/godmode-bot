import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { CHAT_SHARE_CODE_PREFIX } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { addMessage, createConversation, getConversationSummary, listMessages } from "../src/services/conversations";
import { exportChat, importSharedChat, previewSharedChat, shareCode } from "../src/services/chatShare";
import { claudeConfigDir } from "../src/services/claudeUpdate";
import { run as sql } from "../src/db";

let env: TestEnv;
let from: Agent;
let to: Agent;
let chatId: string;
const SESSION = "11111111-2222-3333-4444-555555555555";

beforeAll(async () => {
  env = await setupEnv("godmode-chat-share-");
  from = await makeAgent({ name: "Sender" });
  to = await makeAgent({ name: "Colleague" });
  chatId = createConversation({ agentId: from.id, title: "Plenty bug" }).id;
  const dir = join(from.repoPath, "workspace", "uploads", "2026-11-04");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "log.txt"), "stack trace");
  writeFileSync(join(from.repoPath, "secret.txt"), "nope");
  addMessage({
    conversationId: chatId,
    role: "user",
    content: "Why does the sync fail?",
    attachments: [
      { name: "log.txt", mime: "text/plain", path: "workspace/uploads/2026-11-04/log.txt", size: 11 },
      { name: "secret.txt", mime: "text/plain", path: "secret.txt", size: 4 },
    ],
  });
  addMessage({ conversationId: chatId, role: "assistant", content: "Because of X.", blocks: [{ type: "text", text: "Because of X." }] });
  const projects = join(claudeConfigDir(), "projects", "-some-dir");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${SESSION}.jsonl`), `${JSON.stringify({ type: "user", sessionId: SESSION, message: "hi" })}\n`);
  sql("UPDATE conversations SET claude_session_id = ? WHERE id = ?", SESSION, chatId);
});

afterAll(async () => {
  await env.close();
});

test("a chat travels as a file into another agent, with its files and Claude session", () => {
  const file = exportChat(chatId, { context: true, files: true });
  expect(file.fileName).toBe("Plenty bug.godmode-chat");
  const data = file.bytes.toString("base64");
  expect(previewSharedChat(data)).toMatchObject({ title: "Plenty bug", agentName: "Sender", messages: 2, files: 1, withContext: true });

  const chat = importSharedChat({ data, agentId: to.id });
  expect(chat.agentId).toBe(to.id);
  expect(chat.title).toBe("Plenty bug");
  const messages = listMessages(chat.id);
  expect(messages.map((m) => m.content)).toEqual(["Why does the sync fail?", "Because of X."]);
  expect(messages[0]!.attachments).toHaveLength(1);
  expect(readFileSync(join(to.repoPath, messages[0]!.attachments[0]!.path), "utf8")).toBe("stack trace");

  const sessionId = getConversationSummary(chat.id).claudeSessionId!;
  expect(sessionId).not.toBe(SESSION);
  const dir = join(claudeConfigDir(), "projects", realpathSync(to.workingDirectory ?? to.repoPath).replace(/[^A-Za-z0-9]/g, "-"));
  expect(readFileSync(join(dir, `${sessionId}.jsonl`), "utf8")).toContain(`"sessionId":"${sessionId}"`);
});

test("a share code imports the same way and refuses what isn't a chat", () => {
  const { code } = shareCode(chatId);
  expect(code.startsWith(CHAT_SHARE_CODE_PREFIX)).toBe(true);
  const chat = importSharedChat({ data: `  ${code}\n`, agentId: to.id });
  expect(listMessages(chat.id)).toHaveLength(2);
  expect(() => previewSharedChat("hello")).toThrow();
  expect(() => previewSharedChat(Buffer.from(JSON.stringify({ format: "godmode.chat", version: 99, messages: [] })).toString("base64"))).toThrow(/newer/);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { CHAT_SHARE_CODE_PREFIX } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { addMessage, createConversation, getConversationSummary, listMessages } from "../src/services/conversations";
import { importSharedChat, previewSharedChat, shareChat, slimSession } from "../src/services/chatShare";
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

test("a chat travels as one code into another agent, with its files and Claude session", () => {
  const share = shareChat(chatId, { context: true, files: true, screenshots: false });
  expect(share.fileName).toBe("Plenty bug.godmode-chat");
  expect(share.code.startsWith(CHAT_SHARE_CODE_PREFIX)).toBe(true);
  expect(previewSharedChat(share.code)).toMatchObject({ title: "Plenty bug", agentName: "Sender", messages: 2, files: 1, withContext: true });
  expect(previewSharedChat(Buffer.from(share.code).toString("base64"))).toMatchObject({ messages: 2 });

  const chat = importSharedChat({ data: `  ${share.code}\n`, agentId: to.id });
  expect(chat.agentId).toBe(to.id);
  expect(chat.title).toBe("Plenty bug");
  const messages = listMessages(chat.id);
  expect(messages.map((m) => m.content)).toEqual(["Why does the sync fail?", "Because of X."]);
  expect(messages[0]!.attachments).toHaveLength(1);
  expect(readFileSync(join(to.repoPath, messages[0]!.attachments[0]!.path), "utf8")).toBe("stack trace");

  const sessionId = getConversationSummary(chat.id).claudeSessionId!;
  expect(sessionId).not.toBe(SESSION);
  const cwd = realpathSync(to.workingDirectory ?? to.repoPath);
  const lines = readFileSync(join(claudeConfigDir(), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ type: "user", sessionId, cwd, message: "hi" });
});

test("a slim session keeps the turns, relinks them past what it drops and leaves screenshots and long output behind", () => {
  const big = "x".repeat(20_000);
  const jsonl = [
    { type: "user", uuid: "u1", parentUuid: null, cwd: "/a", message: { role: "user", content: "hello" } },
    { type: "attachment", uuid: "a1", parentUuid: "u1", attachment: { content: "lots of context" } },
    { type: "assistant", uuid: "t1", parentUuid: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "sig" }] } },
    { type: "assistant", uuid: "x1", parentUuid: "t1", requestId: "r", message: { role: "assistant", content: [{ type: "tool_use", id: "tu", name: "Bash", input: {} }] } },
    {
      type: "user",
      uuid: "r1",
      parentUuid: "x1",
      toolUseResult: { stdout: big },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu", content: [{ type: "text", text: big }, { type: "image", source: { type: "base64", data: "AAAA" } }] }] },
    },
    { type: "queue-operation", operation: "enqueue" },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const out = slimSession(jsonl, false)
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(out.map((e) => e.uuid)).toEqual(["u1", "x1", "r1"]);
  expect(out[1].parentUuid).toBe("u1");
  expect(out[1].requestId).toBeUndefined();
  expect(out[2].toolUseResult).toBeUndefined();
  const [text, image] = out[2].message.content[0].content;
  expect(text.text.length).toBeLessThan(9_000);
  expect(image).toEqual({ type: "text", text: "[screenshot not shared]" });
});

test("what isn't a chat is refused", () => {
  expect(() => previewSharedChat("hello")).toThrow();
  expect(() => previewSharedChat(`${CHAT_SHARE_CODE_PREFIX}AAAA`)).toThrow();
});

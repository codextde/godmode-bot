import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { chatAttachmentImage, createConversation } from "../src/services/conversations";

let env: TestEnv;
let agent: Agent;
let chatId: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeAll(async () => {
  env = await setupEnv("godmode-chat-attach-");
  agent = await makeAgent({ name: "Attachment Bot" });
  chatId = createConversation({ agentId: agent.id }).id;
  const dir = join(agent.repoPath, "workspace", "uploads", "2026-11-01");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shot.png"), PNG);
  writeFileSync(join(dir, "notes.txt"), "hello");
  writeFileSync(join(agent.repoPath, "workspace", "outside.png"), PNG);
});

afterAll(async () => {
  await env.close();
});

test("serves a picture from the chat agent's uploads", () => {
  const { mime, data } = chatAttachmentImage(chatId, "workspace/uploads/2026-11-01/shot.png");
  expect(mime).toBe("image/png");
  expect(data.length).toBe(PNG.length);
});

test("refuses files that aren't pictures or live outside uploads", () => {
  expect(() => chatAttachmentImage(chatId, "workspace/uploads/2026-11-01/notes.txt")).toThrow();
  expect(() => chatAttachmentImage(chatId, "workspace/outside.png")).toThrow();
  expect(() => chatAttachmentImage(chatId, "workspace/uploads/../outside.png")).toThrow();
  expect(() => chatAttachmentImage(chatId, "../../etc/passwd")).toThrow();
  expect(() => chatAttachmentImage(chatId, "workspace/uploads/2026-11-01/missing.png")).toThrow();
});

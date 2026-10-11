import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { run as sql } from "../src/db";
import { createConversation, transcriptPath } from "../src/services/conversations";
import { parseHandover, readHandover, writeSession, writeTranscript } from "../src/remote/handover";
import { HttpError } from "../src/util";

let env: TestEnv;
let agent: Agent;
let claudeDir: string;
const saved = process.env.CLAUDE_CONFIG_DIR;

beforeAll(async () => {
  env = await setupEnv("godmode-handover-");
  agent = await makeAgent({ name: "Handover Bot" });
  claudeDir = mkdtempSync(join(tmpdir(), "godmode-handover-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

afterAll(async () => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(claudeDir, { recursive: true, force: true });
  await env.close();
});

describe("what a runner's chat takes along", () => {
  test("its session, found in any project folder, and its transcript", () => {
    const chat = createConversation({ agentId: agent.id, title: "Moving" });
    sql("UPDATE conversations SET claude_session_id = ? WHERE id = ?", "sess-123", chat.id);
    mkdirSync(join(claudeDir, "projects", "-Users-runner-agents-bot"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "-Users-runner-agents-bot", "sess-123.jsonl"), '{"type":"user"}\n');
    writeTranscript(transcriptPath(agent, chat.id), "# Moving\n");
    expect(readHandover(chat.id)).toEqual({ sessionId: "sess-123", session: '{"type":"user"}\n', transcript: "# Moving\n" });
  });

  test("nothing but the id when the session file is gone, and nothing at all for a chat without a session", () => {
    const gone = createConversation({ agentId: agent.id, title: "Gone" });
    sql("UPDATE conversations SET claude_session_id = ? WHERE id = ?", "sess-gone", gone.id);
    expect(readHandover(gone.id)).toEqual({ sessionId: "sess-gone", session: null, transcript: null });
    const fresh = createConversation({ agentId: agent.id, title: "Fresh" });
    expect(readHandover(fresh.id)).toEqual({ sessionId: null, session: null, transcript: null });
  });

  test("an unknown chat is not found", () => {
    expect(() => readHandover("cnv_nothere")).toThrow(HttpError);
  });

  test("an answer is read field by field: a session needs an id that can be a file name", () => {
    expect(parseHandover({ sessionId: "../../etc/passwd", session: "x", transcript: "t" })).toEqual({ sessionId: null, session: null, transcript: "t" });
    expect(parseHandover({ sessionId: "abc", session: 42, transcript: null })).toEqual({ sessionId: "abc", session: null, transcript: null });
    expect(parseHandover({ sessionId: "abc", session: '{"type":"user"}\nnot json\n', transcript: null })?.session).toBeNull();
    expect(parseHandover({ sessionId: "abc", session: '{"type":"user"}\n\n[1]\n', transcript: null })?.session).toBeNull();
    expect(parseHandover({ sessionId: "abc", session: '{"type":"user"}\n{"type":"assistant"}\n', transcript: null })?.session).toBe('{"type":"user"}\n{"type":"assistant"}\n');
    expect(parseHandover("nope")).toBeNull();
  });
});

describe("keeping it on this computer", () => {
  test("the session goes into the folder Claude Code uses for the working directory, and is never overwritten", () => {
    const cwd = mkdtempSync(join(tmpdir(), "godmode-handover-cwd."));
    const project = join(claudeDir, "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
    expect(writeSession(cwd, "sess-abc", "first\n")).toBe(true);
    expect(readFileSync(join(project, "sess-abc.jsonl"), "utf8")).toBe("first\n");
    expect(writeSession(cwd, "sess-abc", "second\n")).toBe(true);
    expect(readFileSync(join(project, "sess-abc.jsonl"), "utf8")).toBe("first\n");
    expect(writeSession(cwd, "../escape", "x")).toBe(false);
    expect(existsSync(join(claudeDir, "projects", "escape.jsonl"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("a transcript this computer already keeps stays as it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "godmode-handover-t-"));
    const path = join(dir, "conversations", "cnv_x.md");
    writeTranscript(path, "from the runner\n");
    writeTranscript(path, "again\n");
    expect(readFileSync(path, "utf8")).toBe("from the runner\n");
    rmSync(dir, { recursive: true, force: true });
  });
});

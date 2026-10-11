/**
 * What a chat takes along when it moves from a runner to this computer (owner: remote): its Claude session, so the
 * agent resumes with the whole conversation instead of a recap, and its transcript in the agent's repository.
 *
 * Claude Code keeps a session as `<config dir>/projects/<working directory, every character but letters and digits a
 * dash>/<session id>.jsonl`. The runner looks the file up by id in every project folder; this computer puts it into the
 * folder of the directory the chat's runs work in here.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgent } from "../agents/service";
import { get } from "../db";
import { claudeConfigDir } from "../services/claudeUpdate";
import { transcriptPath } from "../services/conversations";
import { notFound } from "../util";

/** A larger session stays behind: the chat's next turn here starts a new one with a recap (runner/runner.ts). */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/** Also a file name here, and `--resume <id>` on a command line. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** Claude Code shortens longer folder names with a hash of its own. */
const MAX_PROJECT_NAME = 200;

export interface ChatHandover {
  sessionId: string | null;
  session: string | null;
  transcript: string | null;
}

function projectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

function readUpTo(path: string, max: number): string | null {
  try {
    return statSync(path).size <= max ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function findSession(sessionId: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir());
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const path = join(projectsDir(), dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** On the runner: what one of its chats takes along. */
export function readHandover(conversationId: string): ChatHandover {
  const row = get<{ agent_id: string; claude_session_id: string | null }>("SELECT agent_id, claude_session_id FROM conversations WHERE id = ?", conversationId);
  if (!row) throw notFound("Conversation");
  const sessionId = row.claude_session_id && SESSION_ID.test(row.claude_session_id) ? row.claude_session_id : null;
  const file = sessionId ? findSession(sessionId) : null;
  let transcript: string | null = null;
  try {
    transcript = readUpTo(transcriptPath(getAgent(row.agent_id), conversationId), MAX_TRANSCRIPT_BYTES);
  } catch {
    transcript = null;
  }
  return { sessionId, session: file ? readUpTo(file, MAX_SESSION_BYTES) : null, transcript };
}

/** What the runner answered, read field by field. */
export function parseHandover(v: unknown): ChatHandover | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const h = v as Record<string, unknown>;
  const sessionId = typeof h.sessionId === "string" && SESSION_ID.test(h.sessionId) ? h.sessionId : null;
  const session = sessionId && typeof h.session === "string" && h.session.length <= MAX_SESSION_BYTES ? h.session : null;
  const transcript = typeof h.transcript === "string" && h.transcript.length <= MAX_TRANSCRIPT_BYTES ? h.transcript : null;
  return { sessionId, session, transcript };
}

function projectDir(cwd: string): string | null {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* not there yet: Claude Code would see the same path */
  }
  const name = real.replace(/[^A-Za-z0-9]/g, "-");
  return name.length <= MAX_PROJECT_NAME ? join(projectsDir(), name) : null;
}

/** On this computer: the session goes where Claude Code finds it when the chat's next run resumes it in `cwd`. */
export function writeSession(cwd: string, sessionId: string, jsonl: string): boolean {
  const dir = SESSION_ID.test(sessionId) ? projectDir(cwd) : null;
  if (!dir) return false;
  const path = join(dir, `${sessionId}.jsonl`);
  if (existsSync(path)) return true;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, jsonl, { mode: 0o600 });
  return true;
}

/** The runner's transcript of the chat, unless this computer already keeps one. */
export function writeTranscript(path: string, text: string): void {
  if (existsSync(path)) return;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

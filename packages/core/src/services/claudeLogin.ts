/**
 * One-click Claude sign-in: runs `claude auth login` in the background. The CLI opens the browser and finishes by
 * itself once the person approves; when the browser can't open (server, Docker) the UI shows the sign-in link and
 * takes the code the page shows.
 */
import type { ClaudeLoginStatus } from "@godmode/shared";
import { logger } from "../log";
import { childEnv } from "../util";
import { resetDoctorCache, resolveClaudeBinary, stripAnsi, toolPath } from "./doctor";

const log = logger("claude-login");

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_RE = /https:\/\/\S+/;

interface Session {
  proc: ReturnType<typeof Bun.spawn>;
  timer: ReturnType<typeof setTimeout>;
  output: string;
}

let session: Session | null = null;
let status: ClaudeLoginStatus = { state: "idle", url: null, message: null };
let endedAt = 0;

export function claudeLoginStatus(): ClaudeLoginStatus {
  // A finished sign-in is only news for a minute; after that a new "not logged in" (logout) starts fresh.
  if (!session && status.state !== "idle" && Date.now() - endedAt > 60_000) status = { state: "idle", url: null, message: null };
  return status;
}

export function startClaudeLogin(): ClaudeLoginStatus {
  if (session) return status;
  const bin = resolveClaudeBinary();
  if (!bin) {
    endedAt = Date.now();
    status = { state: "failed", url: null, message: "Claude Code is not installed yet. Install it first, then sign in." };
    return status;
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "auth", "login"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv({ PATH: toolPath() }) as Record<string, string>,
      windowsHide: true,
    } as Parameters<typeof Bun.spawn>[1]);
  } catch (err) {
    endedAt = Date.now();
    status = { state: "failed", url: null, message: err instanceof Error ? err.message : String(err) };
    return status;
  }
  const current: Session = {
    proc,
    output: "",
    timer: setTimeout(() => finish(current, null, "The sign-in timed out. Try again."), LOGIN_TIMEOUT_MS),
  };
  session = current;
  status = { state: "waiting", url: null, message: null };
  log.info("claude auth login started");

  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        current.output = (current.output + decoder.decode(value, { stream: true })).slice(-20_000);
        if (session === current && !status.url) {
          const url = stripAnsi(current.output).match(URL_RE)?.[0];
          if (url) status = { ...status, url };
        }
      }
    } catch {
      /* stream closed */
    }
  };
  void Promise.all([read(proc.stdout as ReadableStream<Uint8Array>), read(proc.stderr as ReadableStream<Uint8Array>)]).then(async () => {
    finish(current, await proc.exited.catch(() => null));
  });
  return status;
}

function finish(s: Session, code: number | null, message?: string) {
  if (session !== s) return;
  session = null;
  endedAt = Date.now();
  clearTimeout(s.timer);
  try {
    s.proc.kill();
  } catch {
    /* already gone */
  }
  resetDoctorCache();
  if (code === 0 && !message) {
    log.info("claude auth login succeeded");
    status = { state: "done", url: null, message: null };
    return;
  }
  const tail = stripAnsi(s.output)
    .split("\n")
    .map((l) => l.replace(/^Paste code here[^>]*>/i, "").trim())
    .filter((l) => l && !URL_RE.test(l) && !/^Opening browser/i.test(l))
    .slice(-3)
    .join(" ");
  log.warn(`claude auth login ended (${code ?? "killed"})`);
  status = { state: "failed", url: null, message: message ?? (tail || "The sign-in did not finish. Try again.") };
}

/** The code the sign-in page shows when the browser could not hand the login back by itself. */
export function submitClaudeLoginCode(code: string): ClaudeLoginStatus {
  const s = session;
  const value = code.trim();
  if (!s || !value) return status;
  const stdin = s.proc.stdin as { write(data: string): unknown; flush?(): unknown } | undefined;
  stdin?.write(`${value}\n`);
  stdin?.flush?.();
  return status;
}

export function cancelClaudeLogin(): ClaudeLoginStatus {
  if (session) finish(session, null, "Cancelled.");
  status = { state: "idle", url: null, message: null };
  return status;
}

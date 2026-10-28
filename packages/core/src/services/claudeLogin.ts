/**
 * One-click Claude sign-in: runs `claude auth login` in the background. The CLI opens the browser and finishes by
 * itself once the person approves; when the browser can't open (server, Docker, a phone) the UI shows the sign-in link
 * and takes the code the page shows.
 *
 * A run that finds Claude Code signed out marks it here: `claude auth status` still says "logged in" when the stored
 * sign-in ran out, so the mark is what the doctor, the banner and the chats go by until a sign-in or a run that works.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeLoginStatus } from "@godmode/shared";
import { config } from "../config";
import { deleteMeta, getMeta, setMeta } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { computerName } from "../mobile/devices";
import { childEnv, now, parseJson } from "../util";
import { resetDoctorCache, resolveClaudeBinary, runCommand, stripAnsi, toolPath } from "./doctor";
import { notify } from "./notifications";

const log = logger("claude-login");

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_RE = /https:\/\/\S+/;

interface Session {
  proc: ReturnType<typeof Bun.spawn>;
  timer: ReturnType<typeof setTimeout>;
  output: string;
}

interface SignedOut {
  at: string;
  apiKey: boolean;
  /** Claude Code's stored credentials when the run found it signed out; a sign-in in a terminal changes them. */
  stamp: string;
}

const SIGNED_OUT_META = "claude.signed_out";
const RECHECK_MS = 10_000;

let session: Session | null = null;
let status: ClaudeLoginStatus = { state: "idle", url: null, message: null };
let endedAt = 0;
let signedOut: SignedOut | null | undefined;
let signedInAt: string | null = null;
let recheckedAt = 0;
/** Counts the moments Claude was seen working: a failure that started reporting before one of them is old news. */
let works = 0;
/** performance.now() of the last sign-in (by Godmode, or new credentials found). */
let signedInPerf = Number.NEGATIVE_INFINITY;

export function claudeLoginStatus(): ClaudeLoginStatus {
  // A finished sign-in is only news for a minute; after that a new "not logged in" (logout) starts fresh.
  if (!session && status.state !== "idle" && Date.now() - endedAt > 60_000) status = { state: "idle", url: null, message: null };
  const out = claudeSignedOut();
  return { ...status, signedOut: out && { at: out.at, apiKey: out.apiKey }, signedInAt };
}

/** Set while runs find Claude Code signed out (kept across restarts). */
export function claudeSignedOut(): SignedOut | null {
  if (signedOut === undefined) {
    try {
      signedOut = parseJson<SignedOut | null>(getMeta(SIGNED_OUT_META), null);
    } catch {
      return null;
    }
  }
  return signedOut;
}

function changed() {
  bus.emit({ type: "claude.login", status: claudeLoginStatus() });
}

function setSignedOut(next: SignedOut | null) {
  signedOut = next;
  try {
    if (next) setMeta(SIGNED_OUT_META, JSON.stringify(next));
    else deleteMeta(SIGNED_OUT_META);
  } catch (err) {
    log.warn("could not store the Claude sign-in state", err);
  }
  resetDoctorCache();
  changed();
}

/** Changes whenever Claude Code writes its credentials (a sign-in, or a refresh that worked). */
async function credentialsStamp(): Promise<string> {
  const parts: string[] = [];
  try {
    parts.push(String(statSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json")).mtimeMs));
  } catch {
    /* none on disk */
  }
  if (process.platform === "darwin") {
    const res = await runCommand(["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials"], { timeoutMs: 10_000 }).catch(() => null);
    const mdat = res?.code === 0 ? res.stdout.match(/"mdat"<timedate>=\S+/)?.[0] : undefined;
    if (mdat) parts.push(mdat);
  }
  return parts.join("|");
}

/**
 * A run ended because Claude Code is signed out (or its API key was refused): say so until it works again.
 * `apiKey`: the run had an Anthropic API key · `since`: performance.now() when its Claude Code started.
 */
export async function noteClaudeSignedOut({ apiKey, since }: { apiKey: boolean; since?: number }): Promise<void> {
  if (claudeSignedOut() || session) return;
  // It started before the last sign-in: it still had the old one.
  if (since !== undefined && since < signedInPerf) return;
  const seen = works;
  const stamp = await credentialsStamp();
  if (claudeSignedOut() || session || works !== seen) return;
  log.warn(`a run found Claude Code signed out${apiKey ? " (Anthropic API key refused)" : ""}`);
  setSignedOut({ at: now(), apiKey, stamp });
  // One notice for the whole outage, the runner's too (it reaches the computer it works for): runs fail until it's over.
  const on = config().role === "runner" ? ` on ${computerName()}` : "";
  if (apiKey) notify("error", `Claude refused the API key${on}`, "Your agents and scheduled automations fail until the Anthropic API key works again.", "/integrations?tab=api-keys");
  else {
    notify(
      "error",
      `Claude is signed out${on}`,
      "Your agents and scheduled automations fail until you sign in again: run `claude` in a terminal and type /login, or sign in from Godmode with one click. Automations that failed meanwhile get one more run then, unless they are due again soon.",
      "/settings/system",
    );
  }
}

/** Claude answered a run: whatever found it signed out is over. */
export function noteClaudeWorks(): void {
  works++;
  if (claudeSignedOut()) setSignedOut(null);
}

/** The Anthropic API key was changed or removed: a refusal of the old one is no news any more. */
export function noteAnthropicKeyChanged(): void {
  if (claudeSignedOut()?.apiKey) setSignedOut(null);
}

function signedIn() {
  works++;
  signedInPerf = performance.now();
}

/** Clears the mark when Claude Code's credentials changed since (signed in from a terminal, or refreshed by itself). */
export async function recheckClaudeSignedOut(): Promise<void> {
  const out = claudeSignedOut();
  if (!out || session || Date.now() - recheckedAt < RECHECK_MS) return;
  recheckedAt = Date.now();
  const stamp = await credentialsStamp();
  if (!stamp || stamp === out.stamp || claudeSignedOut() !== out) return;
  log.info("Claude Code's credentials changed since a run found it signed out");
  signedIn();
  setSignedOut(null);
}

export function startClaudeLogin(): ClaudeLoginStatus {
  if (session) return claudeLoginStatus();
  const bin = resolveClaudeBinary();
  if (!bin) {
    endedAt = Date.now();
    status = { state: "failed", url: null, message: "Claude Code is not installed yet. Install it first, then sign in." };
    changed();
    return claudeLoginStatus();
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
    changed();
    return claudeLoginStatus();
  }
  const current: Session = {
    proc,
    output: "",
    timer: setTimeout(() => finish(current, null, "The sign-in timed out. Try again."), LOGIN_TIMEOUT_MS),
  };
  session = current;
  status = { state: "waiting", url: null, message: null };
  log.info("claude auth login started");
  changed();

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
          if (url) {
            status = { ...status, url };
            changed();
          }
        }
      }
    } catch {
      /* stream closed */
    }
  };
  void Promise.all([read(proc.stdout as ReadableStream<Uint8Array>), read(proc.stderr as ReadableStream<Uint8Array>)]).then(async () => {
    finish(current, await proc.exited.catch(() => null));
  });
  return claudeLoginStatus();
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
    signedInAt = now();
    signedIn();
    if (claudeSignedOut()) setSignedOut(null);
    else changed();
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
  changed();
}

/** The code the sign-in page shows when the browser could not hand the login back by itself. */
export function submitClaudeLoginCode(code: string): ClaudeLoginStatus {
  const s = session;
  const value = code.trim();
  if (!s || !value) return claudeLoginStatus();
  const stdin = s.proc.stdin as { write(data: string): unknown; flush?(): unknown } | undefined;
  stdin?.write(`${value}\n`);
  stdin?.flush?.();
  return claudeLoginStatus();
}

const CLIPBOARD: string[][] =
  process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
      ? [["clip"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

/** Puts the waiting sign-in's link on this computer's clipboard: the desktop webview may only write it during a click. */
export async function copyClaudeLoginLink(): Promise<{ ok: boolean }> {
  const url = session ? status.url : null;
  if (!url) return { ok: false };
  for (const [name, ...args] of CLIPBOARD) {
    const bin = Bun.which(name!, { PATH: process.env.PATH ?? process.env.Path ?? "" });
    if (!bin) continue;
    try {
      const proc = Bun.spawn([bin, ...args], { stdin: new Blob([url]), stdout: "ignore", stderr: "ignore", windowsHide: true } as Parameters<typeof Bun.spawn>[1]);
      const timer = setTimeout(() => proc.kill(), 5_000);
      const code = await proc.exited;
      clearTimeout(timer);
      if (code === 0) return { ok: true };
    } catch {
      /* not installed */
    }
  }
  return { ok: false };
}

export function cancelClaudeLogin(): ClaudeLoginStatus {
  if (session) finish(session, null, "Cancelled.");
  status = { state: "idle", url: null, message: null };
  changed();
  return claudeLoginStatus();
}

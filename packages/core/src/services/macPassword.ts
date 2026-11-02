/**
 * This Mac's password (owner: vault). Saved once, sealed with the vault key, and used by Godmode itself: an agent asks
 * with `mac_password`, the human approves that one command or dialog, and the agent's next call with the same arguments
 * does it. Agents have no way to read it: the password only goes to osascript's stdin (never an argument) and straight
 * into the focused field of a macOS dialog, and it is masked in every result.
 *
 * Commands run through `do shell script ... with administrator privileges`, not sudo: sudo can't take a password from
 * stdin where Touch ID is set up for it. A dialog is only filled when it is macOS's own password prompt: a web page, a
 * terminal, a dialog an agent made with osascript or a field in an app's settings could pass the password on.
 */
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import type { Agent, MacPasswordStatus, MacPasswordUse } from "@godmode/shared";
import { getAgent } from "../agents/service";
import { getHelper } from "../computer/helper";
import { config } from "../config";
import { get, insert, run as sql } from "../db";
import { logger } from "../log";
import { errorMessage } from "../computer/engine";
import { shellQuote } from "../ssh/client";
import type { RunContext } from "../types";
import { HttpError, childEnv, now, sleep } from "../util";
import { isUnlocked, open, redact, rememberSecret, seal } from "../vault/vault";
import { audit, listAudit } from "./audit";
import { closeHumanTask, createAgentHumanTask, listHumanTasks } from "./humanTasks";
import { MAC_PASSWORD_FILL, MAC_PASSWORD_RUN, askQuestion, clean } from "./questions";
import { getSettings } from "./settings";

const log = logger("mac-password");

const SEAL_CONTEXT = "mac_password";
const SAVE_TASK_TITLE = "Save your Mac password in Godmode";
/** The run continues as soon as the human approves, so this only matters when it had to wait for something. */
const APPROVAL_VALID_MS = 30 * 60_000;
const VERIFY_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_OUTPUT = 30_000;
const KEEP_GRANTS_MS = 7 * 24 * 60 * 60_000;
const DIALOG_SETTLE_MS = 500;
const DIALOG_SETTLE_TRIES = 16;
const MASK = "••••••••";
/** Control characters (a line break and a tab are fine, they show) and what turns text around on screen. */
const HIDES_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/**
 * macOS's own password prompts: the system volume is read-only, so nothing else can sit at these paths. Not their host
 * apps: a field inside System Settings or Installer can belong to a VPN, a mail account or an installer plugin, and those
 * apps' administrator prompts come through SecurityAgent anyway.
 */
const SYSTEM_DIALOGS: RegExp[] = [
  /^\/System\/Library\/Frameworks\/Security\.framework\/.*\/SecurityAgent$/,
  /^\/System\/Library\/Frameworks\/LocalAuthentication\.framework\/.*\/coreautha(?:gent)?$/,
  /^\/System\/Library\/CoreServices\/CoreAuthUI\.app\//,
];

export function isSystemDialog(path: string): boolean {
  return SYSTEM_DIALOGS.some((re) => re.test(path));
}

export interface PasswordPrompt {
  pid?: number;
  app?: string;
  path?: string;
  /** A password field has the focus. */
  secure: boolean;
  window?: boolean;
  texts?: string[];
  buttons?: string[];
}

/** What it takes to do the work: swapped in tests. */
export const macPasswordDeps = {
  osascript: "/usr/bin/osascript",
  username: () => userInfo().username,
  prompt: async (): Promise<PasswordPrompt> => (await getHelper()).call<PasswordPrompt>("passwordPrompt"),
  fill: async (pid: number, password: string): Promise<void> => {
    await (await getHelper()).call("passwordFill", { pid, password, submit: true });
  },
  settleMs: DIALOG_SETTLE_MS,
  settleTries: DIALOG_SETTLE_TRIES,
};

export function macPasswordSupported(): boolean {
  return process.platform === "darwin" && config().role !== "runner";
}

interface PasswordRow {
  username: string;
  password_enc: string;
  saved_at: string;
  last_used_at: string | null;
}

function savedRow(): PasswordRow | null {
  return get<PasswordRow>("SELECT username, password_enc, saved_at, last_used_at FROM mac_password WHERE id = 1");
}

function recentUses(): MacPasswordUse[] {
  return listAudit(5, "mac_password.use").map((e) => {
    const d = e.details as { kind?: "run" | "fill"; what?: string; agentId?: string; ok?: boolean };
    let agent = "";
    try {
      agent = d.agentId ? getAgent(d.agentId).name : "";
    } catch {
      /* agent gone */
    }
    return { at: e.ts, kind: d.kind ?? "run", what: d.what ?? "", agent, ok: d.ok !== false };
  });
}

export function macPasswordStatus(): MacPasswordStatus {
  const row = savedRow();
  return {
    supported: macPasswordSupported(),
    saved: !!row,
    username: row?.username ?? (macPasswordSupported() ? macPasswordDeps.username() : null),
    savedAt: row?.saved_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
    recent: row ? recentUses() : [],
  };
}

/* ------------------------------------------------------------------ */
/* Running as administrator                                             */
/* ------------------------------------------------------------------ */

const asString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The script osascript reads from stdin. */
export function adminScript(command: string, username: string, password: string): string {
  return `do shell script ${asString(command)} user name ${asString(username)} password ${asString(password)} with administrator privileges without altering line endings`;
}

export type AdminResult =
  | { status: "done"; exitCode: number; output: string }
  | { status: "rejected" }
  | { status: "timeout" }
  | { status: "failed"; error: string };

export async function runAsAdmin(password: string, command: string, opts: { username: string; cwd?: string; timeoutMs: number }): Promise<AdminResult> {
  const mark = `godmode-exit-${randomBytes(8).toString("hex")}:`;
  const inner = opts.cwd ? `cd -- ${shellQuote(opts.cwd)} || exit\n${command}` : command;
  const wrapped = `/bin/zsh -c ${shellQuote(inner)} 2>&1; printf '\\n${mark}%s' "$?"`;
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([macPasswordDeps.osascript, "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: childEnv() as Record<string, string> });
    proc.stdin.write(adminScript(wrapped, opts.username, password));
    await proc.stdin.end();
  } catch (err) {
    return { status: "failed", error: errorMessage(err) };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.timeoutMs);
  });
  const res = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  if (!res) {
    proc.kill();
    return { status: "timeout" };
  }
  const [stdout, stderr] = res;
  const at = stdout.lastIndexOf(mark);
  if (at >= 0) {
    return { status: "done", exitCode: Number(stdout.slice(at + mark.length).trim()) || 0, output: stdout.slice(0, at).replace(/\n+$/, "") };
  }
  if (/\(-60005\)|\(-60007\)/.test(stderr)) return { status: "rejected" };
  return { status: "failed", error: stderr.trim().replace(/^\d+:\d+: execution error: /, "") || "macOS refused without saying why." };
}

/* ------------------------------------------------------------------ */
/* Saving                                                               */
/* ------------------------------------------------------------------ */

/** The password checks out against macOS first: a typo found here doesn't cost an agent's job later. */
export async function saveMacPassword(password: string): Promise<MacPasswordStatus> {
  if (!macPasswordSupported()) throw new HttpError(409, "A Mac password can only be saved on a Mac.", "mac_password_unsupported");
  if (!isUnlocked()) throw new HttpError(423, "Unlock the vault first.", "vault_locked");
  const username = macPasswordDeps.username();
  const check = await runAsAdmin(password, "/usr/bin/true", { username, timeoutMs: VERIFY_TIMEOUT_MS });
  if (check.status === "rejected") {
    throw new HttpError(422, `macOS didn't accept that password for ${username}. It has to be the password of an administrator of this Mac.`, "mac_password_wrong");
  }
  if (check.status !== "done") {
    throw new HttpError(502, `Godmode couldn't check the password with macOS${check.status === "failed" ? `: ${check.error}` : ""}.`, "mac_password_unchecked");
  }
  const ts = now();
  sql(
    `INSERT INTO mac_password (id, username, password_enc, saved_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_enc = excluded.password_enc, saved_at = excluded.saved_at`,
    username,
    seal(password, SEAL_CONTEXT),
    ts,
  );
  rememberSecret(password);
  audit("user", "mac_password.save", username);
  for (const task of listHumanTasks({ status: "active" })) {
    if (task.title !== SAVE_TASK_TITLE) continue;
    closeHumanTask(task.id, { outcome: "done", note: "The Mac password is saved. Call mac_password again." }).catch((err) =>
      log.warn("could not close the task to save the Mac password", { id: task.id, error: errorMessage(err) }),
    );
  }
  return macPasswordStatus();
}

export function removeMacPassword(): MacPasswordStatus {
  sql("DELETE FROM mac_password WHERE id = 1");
  sql("DELETE FROM mac_password_grants");
  audit("user", "mac_password.remove");
  return macPasswordStatus();
}

/* ------------------------------------------------------------------ */
/* Approvals                                                            */
/* ------------------------------------------------------------------ */

type UseKind = "run" | "fill";

interface GrantRow {
  question_id: string;
  used_at: string | null;
  status: string;
  run_id: string;
  answered_at: string | null;
  answer: string | null;
}

interface Who {
  agentId: string;
  ctx: Pick<RunContext, "runId" | "conversationId" | "workspaceId">;
}

/** The newest ask for exactly this command or dialog, in this chat by this agent. Only the human can approve the question. */
function latestAsk(who: Who, kind: UseKind, subject: string): GrantRow | null {
  return get<GrantRow>(
    `SELECT g.question_id, g.used_at, q.status, q.run_id, q.answered_at, q.answer FROM mac_password_grants g JOIN questions q ON q.id = g.question_id
       WHERE g.conversation_id = ? AND g.agent_id = ? AND g.kind = ? AND g.subject = ? ORDER BY g.created_at DESC, g.rowid DESC LIMIT 1`,
    who.ctx.conversationId,
    who.agentId,
    kind,
    subject,
  );
}

function valid(g: GrantRow): boolean {
  return g.status === "approved" && !g.used_at && !!g.answered_at && Date.now() - Date.parse(g.answered_at) < APPROVAL_VALID_MS;
}

function humanName(): string {
  return getSettings().general.userName.trim() || "the human";
}

/** An approval is good for one use: of two calls at once, one gets it. */
function consume(questionId: string): boolean {
  return sql("UPDATE mac_password_grants SET used_at = ? WHERE question_id = ? AND used_at IS NULL", now(), questionId).changes === 1;
}

function ask(who: Who, kind: UseKind, subject: string, question: { action: string; reason: string; affects: string }): UseOutput {
  const out = askQuestion(who.ctx, { kind: "approval", ...question });
  if (!out.ok || !out.id) return { text: out.text, isError: true };
  const ts = now();
  sql("DELETE FROM mac_password_grants WHERE created_at < ?", new Date(Date.now() - KEEP_GRANTS_MS).toISOString());
  insert("mac_password_grants", {
    question_id: out.id,
    conversation_id: who.ctx.conversationId,
    agent_id: who.agentId,
    kind,
    subject,
    created_at: ts,
  });
  return { text: `${out.text} Once it is approved, call mac_password again with the same arguments: that call does it.` };
}

function declined(g: GrantRow, who: Who): UseOutput | null {
  if (g.status !== "declined" || g.run_id !== who.ctx.runId) return null;
  return { text: `${humanName()} declined this${g.answer ? `: ${g.answer}` : ""}. Don't do it, and don't get the same effect another way.`, isError: true };
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export interface UseOutput {
  text: string;
  isError?: boolean;
}

export interface UseArgs {
  action: UseKind;
  reason: string;
  command?: string;
  cwd?: string;
  timeout_seconds?: number;
}

/** Nothing saved, or macOS turned the saved one down: a task for the human, and this chat continues when it is saved. */
function askToSave(agent: Agent, ctx: Who["ctx"], why: string): UseOutput {
  const human = humanName();
  try {
    createAgentHumanTask(
      { agentId: agent.id, conversationId: ctx.conversationId, runId: ctx.runId, workspaceId: ctx.workspaceId },
      {
        title: SAVE_TASK_TITLE,
        body: `${why} Open Passwords → Mac password in Godmode and save it. You approve every use, and agents never see it.`,
      },
    );
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 409) throw err;
  }
  return { text: `${why} ${human} has a task to save it in Godmode, and this chat continues when they did. Finish what doesn't depend on it, then end your turn.`, isError: true };
}

function masked(text: string, password: string): string {
  return redact(text.split(password).join(MASK));
}

function noted(who: Who, kind: UseKind, what: string, ok: boolean): void {
  sql("UPDATE mac_password SET last_used_at = ? WHERE id = 1", now());
  audit(`agent:${who.agentId}`, "mac_password.use", null, { kind, what: what.slice(0, 300), ok, agentId: who.agentId, runId: who.ctx.runId, conversationId: who.ctx.conversationId });
}

async function useForCommand(who: Who, row: PasswordRow, agent: Agent, args: UseArgs): Promise<UseOutput> {
  const command = args.command?.trim();
  if (!command) return { text: 'action "run" needs a command.', isError: true };
  const affects = `${command}${args.cwd ? `\n(in ${args.cwd})` : ""}`;
  // The human approves what they read, so what they read has to be all of it.
  if (HIDES_TEXT.test(affects) || clean(affects, 1000) !== affects) {
    return { text: "Godmode can't show this command exactly as it would run, so it can't ask for it: it holds control characters, a saved secret or `<godmode` text. Write it without those.", isError: true };
  }
  const subject = JSON.stringify([args.cwd ?? "", command]);
  const latest = latestAsk(who, "run", subject);
  const refused = latest && declined(latest, who);
  if (refused) return refused;
  if (!latest || !valid(latest)) {
    return ask(who, "run", subject, {
      action: MAC_PASSWORD_RUN,
      reason: args.reason,
      affects,
    });
  }
  if (!consume(latest.question_id)) return { text: "This approval was used already. Call mac_password again to ask for a new one.", isError: true };

  const password = open(row.password_enc, SEAL_CONTEXT);
  const seconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_S;
  const res = await runAsAdmin(password, command, { username: row.username, cwd: args.cwd, timeoutMs: seconds * 1000 });
  noted(who, "run", command, res.status === "done" && res.exitCode === 0);
  switch (res.status) {
    case "rejected":
      return askToSave(agent, who.ctx, "macOS didn't accept the saved Mac password, so it probably changed.");
    case "timeout":
      return { text: `Timed out after ${seconds} s. The command runs as administrator, so it may still be running: check with ps.`, isError: true };
    case "failed":
      return { text: masked(`macOS couldn't run it: ${res.error}`, password), isError: true };
    case "done": {
      const output = masked(res.output, password);
      const clipped = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n… (output cut)` : output;
      return { text: `Exit code: ${res.exitCode}\n${clipped || "(no output)"}`, isError: res.exitCode !== 0 };
    }
  }
}

/**
 * What macOS made of it: the dialog closes when it takes the password. While it checks, the field has no focus; when it
 * says no, the same dialog hands the focus back to the field.
 */
async function dialogVerdict(pid: number): Promise<"closed" | "rejected" | "unknown"> {
  let last: PasswordPrompt = { secure: true };
  let checked = false;
  for (let i = 0; i < macPasswordDeps.settleTries; i++) {
    await sleep(macPasswordDeps.settleMs);
    const now = await macPasswordDeps.prompt().catch((): PasswordPrompt => ({ secure: false }));
    if (now.pid !== pid || !now.window) return "closed";
    if (checked && now.secure) return "rejected";
    if (!now.secure) checked = true;
    last = now;
  }
  return last.secure ? "rejected" : "unknown";
}

function dialogSubject(p: PasswordPrompt): string {
  return `${p.path}\n${(p.texts ?? []).join("\n")}`;
}

async function useForDialog(who: Who, row: PasswordRow, agent: Agent, args: UseArgs): Promise<UseOutput> {
  let prompt: PasswordPrompt;
  try {
    prompt = await macPasswordDeps.prompt();
  } catch (err) {
    return { text: `Godmode can't read the screen's dialogs: ${errorMessage(err)}`, isError: true };
  }
  if (!prompt.secure || !prompt.pid || !prompt.path) {
    return {
      text: `No password field has the focus at the front of this Mac${prompt.app ? ` (${prompt.app} is at the front)` : ""}. Open the dialog, click its password field and call this again. An approval you already have stays good for ${APPROVAL_VALID_MS / 60_000} minutes.`,
      isError: true,
    };
  }
  if (!isSystemDialog(prompt.path)) {
    return { text: `${prompt.app || "This app"} isn't one of macOS's own password prompts, so Godmode won't enter the Mac password there.`, isError: true };
  }
  const subject = dialogSubject(prompt);
  const latest = latestAsk(who, "fill", subject);
  const refused = latest && declined(latest, who);
  if (refused) return refused;
  if (!latest || !valid(latest)) {
    return ask(who, "fill", subject, {
      action: MAC_PASSWORD_FILL,
      reason: args.reason,
      affects: `Godmode can't see what this unlocks: only approve if you expect this dialog. It says: ${(prompt.texts ?? []).join(" ")}`.slice(0, 1000),
    });
  }
  if (!consume(latest.question_id)) return { text: "This approval was used already. Call mac_password again to ask for a new one.", isError: true };

  const password = open(row.password_enc, SEAL_CONTEXT);
  try {
    await macPasswordDeps.fill(prompt.pid, password);
  } catch (err) {
    noted(who, "fill", prompt.app ?? "", false);
    return { text: masked(`Godmode couldn't enter the password: ${errorMessage(err)}`, password), isError: true };
  }
  const verdict = await dialogVerdict(prompt.pid);
  noted(who, "fill", prompt.app ?? "", verdict !== "rejected");
  if (verdict === "rejected") return askToSave(agent, who.ctx, "macOS didn't accept the saved Mac password in the dialog, so it probably changed.");
  if (verdict === "closed") return { text: "Godmode entered the password and the dialog closed. Check on the screen that the step went through." };
  return { text: "Godmode entered the password, and macOS is still working on it. Check on the screen whether the step went through." };
}

export async function useMacPassword(agent: Agent, ctx: Who["ctx"], args: UseArgs): Promise<UseOutput> {
  if (!macPasswordSupported()) return { text: "This isn't a Mac Godmode has a password for.", isError: true };
  if (!isUnlocked()) return { text: `The vault is locked, so the Mac password can't be used. ${humanName()} has to unlock it.`, isError: true };
  const row = savedRow();
  if (!row) return askToSave(agent, ctx, "No Mac password is saved on this computer yet.");
  const who: Who = { agentId: agent.id, ctx };
  return args.action === "fill" ? useForDialog(who, row, agent, args) : useForCommand(who, row, agent, args);
}

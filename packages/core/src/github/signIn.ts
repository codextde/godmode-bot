/**
 * Lets an agent renew this computer's GitHub login itself: runs `gh auth login --web` in the background and approves
 * its one-time code in the agent's browser. The code is only ever the one gh printed here, so a page or a message can't
 * talk an agent into approving someone else's device.
 */
import { resolveGh, runCommand, stripAnsi, toolPath } from "../services/doctor";
import { sleep, childEnv } from "../util";
import { logger } from "../log";
import { forgetGithubToken } from "./pullRequests";

const log = logger("github-sign-in");

export const DEVICE_URL = "https://github.com/login/device?skip_account_picker=true";
const LOGIN_ARGS = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key", "--scopes", "repo,read:org,workflow"];
/** gh prints the code in a moment; GitHub lets it live for 15 minutes. */
const CODE_TIMEOUT_MS = 15_000;
const FLOW_MS = 14 * 60_000;
const IDLE_TAKEOVER_MS = 2 * 60_000;
const PAGE_MS = 45_000;
const STUCK_MS = 12_000;
/** gh polls GitHub every few seconds, so it notices an approval shortly after the page does. */
const APPROVED_MS = 30_000;

let ghOverride: string | undefined;
let timing = { pageMs: PAGE_MS, stuckMs: STUCK_MS, approvedMs: APPROVED_MS, tickMs: 500 };

export function __setSignInForTests(opts: { gh?: string; timing?: Partial<typeof timing> } | null) {
  ghOverride = opts?.gh;
  timing = { pageMs: PAGE_MS, stuckMs: STUCK_MS, approvedMs: APPROVED_MS, tickMs: 500, ...opts?.timing };
  flow?.stop();
  flow = null;
}

function env() {
  const { GH_TOKEN: _token, GITHUB_TOKEN: _github, ...rest } = childEnv({ PATH: toolPath(), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });
  return rest;
}

function ghBin(): string | null {
  return ghOverride ?? resolveGh();
}

export interface GithubLogin {
  ok: boolean;
  account: string | null;
  /** gh answered at all; false: not installed or it couldn't run. */
  known: boolean;
}

/** Whether gh's login on this computer works right now, and for which account. */
export async function githubLogin(): Promise<GithubLogin> {
  const bin = ghBin();
  if (!bin) return { ok: false, account: null, known: false };
  const res = await runCommand([bin, "auth", "status", "--hostname", "github.com"], { env: env(), timeoutMs: 20_000 });
  if (res.code === null) return { ok: false, account: null, known: false };
  const text = stripAnsi(`${res.stdout}\n${res.stderr}`);
  const account = /(?:Logged in to|Failed to log in to) \S+ (?:account|as) (\S+)/.exec(text)?.[1] ?? null;
  return { ok: res.code === 0, account, known: true };
}

export type SignInEnd = { ok: true; account: string | null } | { ok: false; detail: string };

interface Flow {
  runId: string;
  code: string;
  previous: string | null;
  touchedAt: number;
  end: SignInEnd | null;
  done: Promise<SignInEnd>;
  stop: () => void;
}

let flow: Flow | null = null;

async function readInto(stream: ReadableStream<Uint8Array>, onText: (text: string) => void) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }));
}

async function afterApproval(bin: string): Promise<SignInEnd> {
  forgetGithubToken();
  // Without this git keeps asking the keychain, where the old token may still be.
  const setup = await runCommand([bin, "auth", "setup-git", "--hostname", "github.com"], { env: env(), timeoutMs: 20_000 });
  if (setup.code !== 0) log.warn(`gh auth setup-git failed: ${stripAnsi(setup.stderr).trim()}`);
  const login = await githubLogin();
  return login.ok ? { ok: true, account: login.account } : { ok: false, detail: "gh finished, but its login still doesn't work." };
}

async function start(bin: string, runId: string, previous: string | null, args = [...LOGIN_ARGS, "--clipboard=false"]): Promise<Flow> {
  const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env() as Record<string, string> });
  let output = "";
  let onOutput = () => {};
  const collect = (text: string) => {
    output += text;
    onOutput();
  };
  void readInto(proc.stdout as ReadableStream<Uint8Array>, collect).catch(() => {});
  void readInto(proc.stderr as ReadableStream<Uint8Array>, collect).catch(() => {});
  const codeIn = () => /one-time code\W+([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(stripAnsi(output))?.[1] ?? null;
  const code = await Promise.race([
    new Promise<string>((resolve) => {
      onOutput = () => {
        const found = codeIn();
        if (found) resolve(found);
      };
      onOutput();
    }),
    proc.exited.then(async () => {
      await sleep(50);
      return codeIn();
    }),
    sleep(CODE_TIMEOUT_MS).then(() => null),
  ]);
  onOutput = () => {};
  if (!code) {
    const said = stripAnsi(output).trim();
    proc.kill();
    // Older versions of gh don't know the flag that keeps the code off the human's clipboard.
    if (/unknown flag.*clipboard/i.test(said) && args.includes("--clipboard=false")) return start(bin, runId, previous, LOGIN_ARGS);
    throw new Error(said ? `gh couldn't start the sign-in: ${said.slice(-400)}` : "gh didn't print a sign-in code.");
  }
  const timer = setTimeout(() => proc.kill(), FLOW_MS);
  timer.unref?.();
  const self: Flow = {
    runId,
    code,
    previous,
    touchedAt: Date.now(),
    end: null,
    stop: () => {
      clearTimeout(timer);
      proc.kill();
    },
    done: proc.exited.then(async (status) => {
      clearTimeout(timer);
      const end: SignInEnd =
        status === 0
          ? await afterApproval(bin)
          : { ok: false, detail: `The sign-in ended without an approval: ${stripAnsi(output).trim().slice(-300) || `gh exited with ${status}`}` };
      self.end = end;
      return end;
    }),
  };
  return self;
}

/** The running sign-in of this run, a new one, or null while another run is busy with its own. */
export async function ensureSignIn(runId: string, previous: string | null): Promise<Flow | null> {
  const bin = ghBin();
  if (!bin) throw new Error("The GitHub CLI (gh) isn't installed on this computer. Install it first (brew install gh on a Mac), then call this again.");
  if (flow && !flow.end) {
    if (flow.runId === runId) {
      flow.touchedAt = Date.now();
      return flow;
    }
    if (Date.now() - flow.touchedAt < IDLE_TAKEOVER_MS) return null;
    flow.stop();
    await flow.done.catch(() => {});
  }
  flow = await start(bin, runId, previous);
  return flow;
}

/** What a run sees of another run's sign-in once it waited for it a little. */
export async function otherRunsSignIn(waitMs: number): Promise<SignInEnd | null> {
  if (!flow) return null;
  return flow.end ?? (await Promise.race([flow.done, sleep(waitMs).then(() => null)]));
}

/* ------------------------------------------------------------------ */
/* The device page                                                      */
/* ------------------------------------------------------------------ */

export interface DevicePage {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string, opts?: { timeoutMs?: number }): Promise<T>;
  insertText(text: string): Promise<unknown>;
  click(x: number, y: number): Promise<unknown>;
}

type Point = { x: number; y: number };

export interface DeviceState {
  host: string;
  url: string;
  boxes: number;
  password: boolean;
  otp: boolean;
  success: boolean;
  codeRejected: boolean;
  authorize: (Point & { disabled: boolean }) | null;
  authenticator: Point | null;
  proceed: Point | null;
  text: string;
}

/** The form's hyphen is an input of its own, named like the boxes. */
const CODE_BOXES = `[...document.querySelectorAll('input[name^="user-code-"]')].filter((el) => el.maxLength === 1)`;

const STATE = `(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const all = (s) => [...document.querySelectorAll(s)].filter(seen);
  const at = (el) => { if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const label = (el) => (el.innerText || el.value || "").trim();
  const text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ");
  const authorize = all('button[name="authorize"][value="1"]')[0];
  const buttons = all('button, input[type="submit"], a');
  return {
    host: location.hostname,
    url: location.origin + location.pathname,
    boxes: ${CODE_BOXES}.filter(seen).length,
    password: all('input[type="password"]').length > 0,
    otp: all('input[name="otp"], input[name="app_otp"], input[autocomplete="one-time-code"], input#app_totp').length > 0,
    success: /congratulations|you're all set|device (is )?now connected/i.test(text),
    codeRejected: location.pathname.endsWith("/failure") || /(code|token).{0,60}(expired|invalid|incorrect|not found|try again)/i.test(text),
    authorize: authorize ? { ...at(authorize), disabled: authorize.disabled } : null,
    authenticator: at(buttons.find((el) => /authenticator/i.test(label(el)))),
    proceed: at(all('input[type="submit"], button[type="submit"]').find((el) => /^(continue|weiter)$/i.test(label(el)))),
    text: text.slice(0, 300),
  };
})()`;

export type PageResult =
  | { step: "approved" }
  | { step: "password" | "otp" | "wrong-site" | "code-rejected" | "stuck"; url: string; text: string };

async function typeCode(page: DevicePage, code: string, boxes: number) {
  const chars = code.replace(/-/g, "").split("");
  if (boxes !== chars.length) throw new Error(`GitHub's code form has ${boxes} boxes, expected ${chars.length}.`);
  for (let i = 0; i < chars.length; i++) {
    await page.evaluate(`${CODE_BOXES}[${i}].focus()`);
    await page.insertText(chars[i]!);
  }
}

/** Moves the open GitHub page on until the code is approved or it needs something this code can't give it. */
export async function approveOnPage(page: DevicePage, code: string, approved: () => boolean): Promise<PageResult> {
  const deadline = Date.now() + timing.pageMs;
  let last = "";
  let changedAt = Date.now();
  let typed = 0;
  let state: DeviceState | null = null;
  // GitHub keeps Authorize disabled while its page has no focus; this gives it focus without raising the window.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  while (Date.now() < deadline) {
    if (approved()) return { step: "approved" };
    state = await page.evaluate<DeviceState>(STATE, { timeoutMs: 5000 }).catch(() => null);
    if (!state) {
      await sleep(timing.tickMs);
      continue;
    }
    const where = { url: state.url, text: state.text };
    if (state.host !== "github.com") return { step: "wrong-site", ...where };
    if (state.success) return { step: "approved" };
    if (state.password) return { step: "password", ...where };
    if (state.otp) return { step: "otp", ...where };
    if (state.codeRejected) return { step: "code-rejected", ...where };
    const shape = `${state.url}|${state.boxes}|${!!state.authorize}|${!!state.authenticator}|${!!state.proceed}`;
    if (shape !== last) {
      last = shape;
      changedAt = Date.now();
    } else if (Date.now() - changedAt > timing.stuckMs) {
      return { step: "stuck", ...where };
    }
    if (state.authorize) {
      if (!state.authorize.disabled) await page.click(state.authorize.x, state.authorize.y);
    } else if (state.boxes > 0) {
      if (typed >= 2) return { step: "code-rejected", ...where };
      await typeCode(page, code, state.boxes);
      typed++;
      if (state.proceed) await page.click(state.proceed.x, state.proceed.y);
    } else if (state.authenticator) {
      await page.click(state.authenticator.x, state.authenticator.y);
    } else if (state.proceed) {
      await page.click(state.proceed.x, state.proceed.y);
    }
    await sleep(timing.tickMs);
  }
  return { step: "stuck", url: state?.url ?? "", text: state?.text ?? "" };
}

/** Waits for gh to notice the approval. */
export async function signInEnd(f: Flow): Promise<SignInEnd | null> {
  return f.end ?? (await Promise.race([f.done, sleep(timing.approvedMs).then(() => null)]));
}

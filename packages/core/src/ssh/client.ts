/**
 * SSH connections with ssh2 (pure JavaScript, so it works in the compiled core on every platform). One pooled
 * connection per server is shared by every run and the human's "Run command"; it closes after a few idle minutes or
 * when the server's settings change. The host key is pinned on the first connection (like OpenSSH's
 * `StrictHostKeyChecking=accept-new`): a server that later presents another key is refused.
 */
import { posix } from "node:path";
import { Client, type ConnectConfig, type SFTPWrapper, type Stats } from "ssh2";
import type { SshAuthMethod, SshHostKey, SshTestStage } from "@godmode/shared";
import { logger } from "../log";
import { blobType, fingerprintOf } from "./keys";

const log = logger("ssh");

const READY_TIMEOUT_MS = 20_000;
const IDLE_CLOSE_MS = 3 * 60_000;
/** OpenSSH allows 10 sessions per connection by default; stay below it. */
const MAX_CHANNELS = 6;
/** Per stream, what a command's output keeps in memory: the start and the end. */
const CAPTURE_BYTES = 512 * 1024;

export interface ConnectTarget {
  host: string;
  port: number;
  username: string;
  auth: SshAuthMethod;
  password: string | null;
  privateKey: string | null;
  passphrase: string | null;
  /** Pinned host key; null = trust the first one the server presents. */
  hostKey: SshHostKey | null;
}

/** A connection problem in words for the human, with the step that failed. */
export class SshError extends Error {
  constructor(
    message: string,
    readonly stage: SshTestStage,
    readonly hostKey: SshHostKey | null = null,
    readonly hostKeyChanged = false,
  ) {
    super(message);
  }
}

export interface Session {
  client: Client;
  /** The key the server presented. */
  hostKey: SshHostKey;
  /** Connect, handshake and sign-in. */
  latencyMs: number;
}

export function addressOf(t: Pick<ConnectTarget, "host" | "port">): string {
  return t.port === 22 ? t.host : `${t.host}:${t.port}`;
}

function translate(err: unknown, t: ConnectTarget, seen: SshHostKey | null, changed: boolean): SshError {
  const e = err as Error & { code?: string; level?: string };
  const where = addressOf(t);
  if (changed && t.hostKey && seen) {
    return new SshError(
      `The host key of ${where} changed: Godmode trusts ${t.hostKey.fingerprint}, the server now shows ${seen.fingerprint}. ` +
        "That happens when a server is reinstalled — or when someone intercepts the connection. If the change is expected, forget the saved host key in SSH servers and connect again.",
      "host-key",
      seen,
      true,
    );
  }
  switch (e.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new SshError(`Can't find the host "${t.host}" — check the name (the DNS lookup failed).`, "connect");
    case "ECONNREFUSED":
      return new SshError(`${where} refused the connection — is SSH running on port ${t.port}?`, "connect");
    case "ETIMEDOUT":
      return new SshError(`No answer from ${where} — check the address, the port and the firewall.`, "connect");
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new SshError(`${where} can't be reached from this computer (no route to the host).`, "connect");
    case "ECONNRESET":
      return new SshError(`${where} closed the connection before the sign-in — it may block this computer, or not speak SSH on port ${t.port}.`, "connect");
  }
  const message = e.message || String(err);
  if (/timed out while waiting for handshake/i.test(message)) {
    return new SshError(`No SSH answer from ${where} within ${READY_TIMEOUT_MS / 1000} seconds — check the address, the port and the firewall.`, "connect");
  }
  if (/all configured authentication methods failed/i.test(message)) {
    return new SshError(
      t.auth === "key"
        ? `${where} didn't accept the key for "${t.username}". Check the user name, and that the public key is in ~/.ssh/authorized_keys on the server.`
        : `${where} didn't accept the password for "${t.username}".`,
      "auth",
      seen,
    );
  }
  if (/privateKey|passphrase/i.test(message)) return new SshError(`The saved private key can't be used: ${message.replace(/^Cannot parse privateKey: /i, "")}`, "config", seen);
  if (e.level === "client-socket") return new SshError(`The connection to ${where} failed: ${message}`, "connect");
  return new SshError(`SSH to ${where} failed: ${message}`, seen ? "auth" : "connect", seen);
}

/** Connect and sign in. */
export function connect(target: ConnectTarget, signal?: AbortSignal): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    if (signal?.aborted) return reject(new SshError("Cancelled", "connect"));
    const client = new Client();
    client.setMaxListeners(4 * MAX_CHANNELS + 10);
    const started = performance.now();
    let seen: SshHostKey | null = null;
    let changed = false;
    let settled = false;
    const onAbort = () => fail(new SshError("Cancelled", "connect"));
    const fail = (err: SshError) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      client.end();
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    client.on("ready", () => {
      if (settled) return void client.end();
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ client, hostKey: seen!, latencyMs: Math.round(performance.now() - started) });
    });
    client.on("error", (err) => fail(translate(err, target, seen, changed)));
    client.on("close", () => fail(new SshError(`The connection to ${addressOf(target)} closed during the sign-in.`, seen ? "auth" : "connect", seen)));
    // Servers that ask for the password through keyboard-interactive (PAM) get it for password prompts only.
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map((p) => (target.password && /pass(?:word|code|phrase)?|kennwort|mot de passe|contraseña/i.test(p.prompt) ? target.password : "")));
    });
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      hostVerifier: (key: Buffer) => {
        seen = { type: blobType(key), fingerprint: fingerprintOf(key) };
        changed = !!target.hostKey && target.hostKey.fingerprint !== seen.fingerprint;
        return !changed;
      },
    };
    if (target.auth === "key") {
      config.privateKey = target.privateKey ?? "";
      if (target.passphrase) config.passphrase = target.passphrase;
    } else {
      config.password = target.password ?? "";
      config.tryKeyboard = true;
    }
    try {
      client.connect(config);
    } catch (err) {
      fail(translate(err, target, seen, changed));
    }
  });
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

/** Keeps the start and the end of a stream (the middle of huge output is dropped). */
class Capture {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;

  constructor(private readonly max = CAPTURE_BYTES) {}

  push(chunk: Buffer) {
    this.total += chunk.length;
    if (this.headBytes < this.max) {
      const take = chunk.subarray(0, this.max - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (!chunk.length) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes - (this.tail[0]?.length ?? 0) >= this.max) this.tailBytes -= this.tail.shift()!.length;
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    if (!this.tail.length) return head;
    const tail = Buffer.concat(this.tail);
    const dropped = this.total - this.headBytes - tail.length;
    return dropped > 0 ? `${head}\n\n… [${dropped.toLocaleString("en-US")} bytes omitted] …\n\n${tail.toString("utf8")}` : head + tail.toString("utf8");
  }
}

export interface ExecOptions {
  stdin?: string | Buffer | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Answer a prompt the command prints to stderr (sudo's, with this marker as its prompt) — only once it is asked for,
   * so the answer never ends up as input for the command itself. stdin follows the answer, or goes out right away
   * when the command prints output first or `waitMs` passes without a prompt.
   */
  prompt?: { marker: string; answer: string; waitMs: number };
}

export interface ExecOutcome {
  exitCode: number | null;
  /** Set when the command was ended by a signal. */
  exitSignal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** The connection dropped while the command ran. */
  lost: boolean;
  /** How often the `prompt` marker appeared (more than once: the answer was rejected). */
  prompts: number;
  durationMs: number;
}

/** POSIX shell quoting (`~` and `~/…` keep pointing at the home folder). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shellPath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shellQuote(path.slice(2))}`;
  return shellQuote(path);
}

/** Run one command (in the user's shell, like `ssh host command`); stdin is sent and closed. */
export function execOn(client: Client, command: string, opts: ExecOptions): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve, reject) => {
    const started = performance.now();
    if (opts.signal?.aborted) {
      return resolve({ exitCode: null, exitSignal: null, stdout: "", stderr: "", timedOut: false, cancelled: true, lost: false, prompts: 0, durationMs: 0 });
    }
    client.exec(command, (err, stream) => {
      if (err) return reject(new SshError(`The command couldn't start: ${err.message}`, "command"));
      const out = new Capture();
      const errOut = new Capture();
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let timedOut = false;
      let cancelled = false;
      let lost = false;
      let done = false;
      let prompts = 0;
      let inputSent = false;
      let promptTail = "";
      let promptTimer: ReturnType<typeof setTimeout> | null = null;
      const sendInput = (answer?: string) => {
        if (inputSent) return;
        inputSent = true;
        if (promptTimer) clearTimeout(promptTimer);
        try {
          if (answer !== undefined) stream.write(`${answer}\n`);
          stream.end(opts.stdin ?? "");
        } catch {
          /* the command already ended */
        }
      };
      const stop = () => {
        try {
          stream.signal("KILL");
        } catch {
          /* not supported by every server */
        }
        stream.close();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, opts.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        stop();
      };
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (promptTimer) clearTimeout(promptTimer);
        opts.signal?.removeEventListener("abort", onAbort);
        client.removeListener("close", onLost);
        const stderr = opts.prompt ? errOut.text().split(opts.prompt.marker).join("") : errOut.text();
        resolve({ exitCode, exitSignal, stdout: out.text(), stderr, timedOut, cancelled, lost, prompts, durationMs: Math.round(performance.now() - started) });
      };
      const onLost = () => {
        lost = exitCode === null && exitSignal === null;
        finish();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      client.once("close", onLost);
      const prompt = opts.prompt;
      stream.on("data", (d: Buffer) => {
        out.push(d);
        // Output before any prompt: nothing will be asked.
        if (prompt) sendInput();
      });
      stream.stderr.on("data", (d: Buffer) => {
        errOut.push(d);
        if (!prompt) return;
        const seen = promptTail + d.toString("utf8");
        const found = seen.split(prompt.marker).length - 1;
        promptTail = seen.slice(-prompt.marker.length);
        if (!found) return;
        prompts += found;
        // Only the first prompt is answered: a second one means the answer was wrong.
        if (prompts === found) sendInput(prompt.answer);
        else sendInput();
      });
      stream.on("exit", (code: number | null, sig?: string) => {
        exitCode = typeof code === "number" ? code : null;
        exitSignal = sig ?? null;
      });
      stream.on("close", finish);
      stream.on("error", finish);
      if (prompt) {
        promptTimer = setTimeout(() => sendInput(), prompt.waitMs);
        promptTimer.unref?.();
      } else sendInput();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Pool                                                                 */
/* ------------------------------------------------------------------ */

export interface PoolOptions {
  /** Changes whenever the server's settings change; a connection made for other settings isn't reused. */
  version: string;
  target: () => ConnectTarget;
  /** A new connection signed in to `target` (pin the host key, remember when). */
  onConnect?: (session: Session, target: ConnectTarget) => void;
  onError?: (err: SshError) => void;
}

class Pooled {
  users = 0;
  channels = 0;
  waiting: (() => void)[] = [];
  idle: ReturnType<typeof setTimeout> | null = null;
  retired = false;
  closed = false;
  private sftpSession: Promise<SFTPWrapper> | null = null;

  constructor(
    readonly id: string,
    readonly version: string,
    readonly session: Promise<Session>,
  ) {}

  async channel<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const { client } = await this.session;
    while (this.channels >= MAX_CHANNELS) await new Promise<void>((r) => this.waiting.push(r));
    this.channels++;
    try {
      return await fn(client);
    } finally {
      this.channels--;
      this.waiting.shift()?.();
    }
  }

  async sftp(): Promise<SFTPWrapper> {
    const { client } = await this.session;
    this.sftpSession ??= new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((err, sftp) => {
        if (err) return reject(new SshError(`SFTP isn't available on this server (${err.message}).`, "command"));
        sftp.on("close", () => (this.sftpSession = null));
        resolve(sftp);
      }),
    );
    this.sftpSession.catch(() => (this.sftpSession = null));
    return this.sftpSession;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    this.session.then((s) => s.client.end()).catch(() => undefined);
  }
}

const pool = new Map<string, Pooled>();

function retire(entry: Pooled) {
  entry.retired = true;
  if (pool.get(entry.id) === entry) pool.delete(entry.id);
  if (entry.users === 0) entry.close();
}

function open(id: string, opts: PoolOptions): Pooled {
  const target = opts.target();
  const session = connect(target);
  const entry = new Pooled(id, opts.version, session);
  pool.set(id, entry);
  session.then(
    (s) => {
      log.debug("connected", { server: id, ms: s.latencyMs });
      s.client.on("close", () => {
        entry.closed = true;
        if (pool.get(id) === entry) pool.delete(id);
      });
      s.client.on("error", (err) => log.debug("connection error", { server: id, error: err.message }));
      opts.onConnect?.(s, target);
    },
    (err: unknown) => {
      if (pool.get(id) === entry) pool.delete(id);
      entry.closed = true;
      if (err instanceof SshError) opts.onError?.(err);
    },
  );
  return entry;
}

/** A connection to the server (pooled), for the duration of `fn`. */
export async function withConnection<T>(id: string, opts: PoolOptions, fn: (conn: Connection) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let entry = pool.get(id);
  if (entry && (entry.version !== opts.version || entry.closed)) {
    retire(entry);
    entry = undefined;
  }
  entry ??= open(id, opts);
  entry.users++;
  if (entry.idle) {
    clearTimeout(entry.idle);
    entry.idle = null;
  }
  const current = entry;
  try {
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new SshError("Cancelled", "connect"));
        const onAbort = () => reject(new SshError("Cancelled", "connect"));
        signal.addEventListener("abort", onAbort, { once: true });
        current.session.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (err) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    } else await current.session;
    return await fn(new Connection(current, signal));
  } finally {
    current.users--;
    if (current.users === 0) {
      if (current.retired || current.closed) current.close();
      else {
        current.idle = setTimeout(() => retire(current), IDLE_CLOSE_MS);
        current.idle.unref?.();
      }
    }
  }
}

/** Close the server's pooled connection (settings changed, server deleted); commands still running finish first. */
export function dropConnection(id: string): void {
  const entry = pool.get(id);
  if (entry) retire(entry);
}

export function closeAllConnections(): void {
  for (const entry of [...pool.values()]) {
    retire(entry);
    entry.close();
  }
}

/* ------------------------------------------------------------------ */
/* Files (SFTP)                                                         */
/* ------------------------------------------------------------------ */

/** SFTP resolves relative paths against the home folder; `~/x` means the same. */
export function sftpPath(path: string): string {
  const p = path.trim();
  if (p === "~") return ".";
  if (p.startsWith("~/")) return p.slice(2) || ".";
  return p;
}

const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

/** An SFTP failure in words for the model. */
export class RemoteFileError extends Error {}

function fileError(err: unknown, path: string, verb: string): RemoteFileError {
  const code = (err as { code?: number }).code;
  if (code === SFTP_NO_SUCH_FILE) return new RemoteFileError(`No such file or folder: ${path}`);
  if (code === SFTP_PERMISSION_DENIED) {
    return new RemoteFileError(`Permission denied: can't ${verb} ${path}. For files owned by root, use shell with sudo: true (e.g. \`cat\`, or \`tee\` with stdin).`);
  }
  return new RemoteFileError(`Couldn't ${verb} ${path}: ${err instanceof Error ? err.message : String(err)}`);
}

function stat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.stat(path, (err, st) => (err ? reject(err) : resolve(st))));
}

async function mkdirp(sftp: SFTPWrapper, dir: string): Promise<void> {
  if (!dir || dir === "." || dir === "/") return;
  try {
    const st = await stat(sftp, dir);
    if (st.isDirectory()) return;
    throw new RemoteFileError(`${dir} exists but isn't a folder.`);
  } catch (err) {
    if (err instanceof RemoteFileError) throw err;
    if ((err as { code?: number }).code !== SFTP_NO_SUCH_FILE) throw fileError(err, dir, "open");
  }
  await mkdirp(sftp, posix.dirname(dir));
  await new Promise<void>((resolve, reject) =>
    sftp.mkdir(dir, (err) => {
      if (!err) return resolve();
      stat(sftp, dir).then(
        (st) => (st.isDirectory() ? resolve() : reject(fileError(err, dir, "create"))),
        () => reject(fileError(err, dir, "create")),
      );
    }),
  );
}

/** One signed-in connection to a server, for the duration of `withConnection`. */
export class Connection {
  constructor(
    private readonly entry: Pooled,
    readonly signal?: AbortSignal,
  ) {}

  async hostKey(): Promise<SshHostKey> {
    return (await this.entry.session).hostKey;
  }

  exec(command: string, opts: Omit<ExecOptions, "signal">): Promise<ExecOutcome> {
    return this.entry.channel((client) => execOn(client, command, { ...opts, signal: this.signal }));
  }

  private sftpCall<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const cancelled = () => {
      if (this.signal?.aborted) throw new SshError("Cancelled", "command");
    };
    cancelled();
    return this.entry.channel(async () => {
      cancelled();
      return fn(await this.entry.sftp());
    });
  }

  /** SFTP works on this server (some turn the subsystem off). */
  async hasSftp(): Promise<boolean> {
    try {
      await this.entry.sftp();
      return true;
    } catch {
      return false;
    }
  }

  readFile(path: string, maxBytes: number): Promise<Buffer> {
    const p = sftpPath(path);
    return this.sftpCall(async (sftp) => {
      let st: Stats;
      try {
        st = await stat(sftp, p);
      } catch (err) {
        throw fileError(err, path, "read");
      }
      if (st.isDirectory()) throw new RemoteFileError(`${path} is a folder. List it with shell (ls -la).`);
      if (st.size > maxBytes) throw new RemoteFileError(`${path} is too large to read (${st.size.toLocaleString("en-US")} bytes). Look at parts of it with shell (head, tail, grep, sed -n) or download it.`);
      return new Promise<Buffer>((resolve, reject) => sftp.readFile(p, (err, data) => (err ? reject(fileError(err, path, "read")) : resolve(data))));
    });
  }

  writeFile(path: string, data: string | Buffer): Promise<void> {
    const p = sftpPath(path);
    return this.sftpCall(async (sftp) => {
      await mkdirp(sftp, posix.dirname(p));
      await new Promise<void>((resolve, reject) => sftp.writeFile(p, data, (err) => (err ? reject(fileError(err, path, "write")) : resolve())));
    });
  }

  /** Size of a remote file (null when it doesn't exist); throws for folders. */
  fileSize(path: string): Promise<number | null> {
    const p = sftpPath(path);
    return this.sftpCall(async (sftp) => {
      try {
        const st = await stat(sftp, p);
        if (st.isDirectory()) throw new RemoteFileError(`${path} is a folder.`);
        return st.size;
      } catch (err) {
        if (err instanceof RemoteFileError) throw err;
        if ((err as { code?: number }).code === SFTP_NO_SUCH_FILE) return null;
        throw fileError(err, path, "open");
      }
    });
  }

  isDirectory(path: string): Promise<boolean> {
    const p = sftpPath(path);
    return this.sftpCall(async (sftp) => {
      try {
        return (await stat(sftp, p)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  download(remote: string, local: string): Promise<void> {
    const p = sftpPath(remote);
    return this.sftpCall(
      (sftp) => new Promise<void>((resolve, reject) => sftp.fastGet(p, local, (err) => (err ? reject(fileError(err, remote, "download")) : resolve()))),
    );
  }

  upload(local: string, remote: string): Promise<void> {
    const p = sftpPath(remote);
    return this.sftpCall(async (sftp) => {
      await mkdirp(sftp, posix.dirname(p));
      await new Promise<void>((resolve, reject) => sftp.fastPut(local, p, (err) => (err ? reject(fileError(err, remote, "write")) : resolve())));
    });
  }
}

/* ------------------------------------------------------------------ */
/* Operating system                                                     */
/* ------------------------------------------------------------------ */

export const OS_PROBE =
  'uname -srm 2>/dev/null; if [ -r /etc/os-release ]; then . /etc/os-release; echo "$PRETTY_NAME"; elif command -v sw_vers >/dev/null 2>&1; then echo "$(sw_vers -productName) $(sw_vers -productVersion)"; fi';

/** "Ubuntu 24.04.1 LTS · Linux 6.8.0-45-generic x86_64" from the output of OS_PROBE. */
export function describeOs(stdout: string): string | null {
  const [kernel, pretty] = stdout.split("\n").map((l) => l.trim());
  const parts = [pretty, kernel].filter((p): p is string => !!p && p.length < 150);
  return parts.length ? parts.join(" · ") : null;
}

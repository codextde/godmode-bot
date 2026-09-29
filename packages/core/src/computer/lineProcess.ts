/**
 * A long-lived child process that speaks newline-delimited JSON on stdin/stdout — the transport of Godmode's native
 * computer helper and of stdio MCP servers (Cua Driver). Requests are matched to responses by `id`.
 */
import type { Subprocess } from "bun";
import { logger } from "../log";

const log = logger("computer");

export class ProcessGoneError extends Error {}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LineProcessOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Name for logs, e.g. "cua-driver". */
  name: string;
  /** Messages without a matching pending id (notifications, the helper's ready line). */
  onMessage?: (msg: Record<string, unknown>) => void;
}

export class LineProcess {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private pending = new Map<number | string, Pending>();
  private nextId = 1;
  private closedError: Error | null = null;
  private stderrTail: string[] = [];
  readonly exited: Promise<number>;

  constructor(private opts: LineProcessOptions) {
    this.proc = Bun.spawn([opts.command, ...opts.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
      cwd: opts.cwd,
      windowsHide: true,
    } as Parameters<typeof Bun.spawn>[1]) as Subprocess<"pipe", "pipe", "pipe">;
    this.exited = this.proc.exited.then((code) => {
      this.fail(new ProcessGoneError(`${opts.name} exited (code ${code})${this.stderrHint()}`));
      return code;
    });
    void this.readStdout();
    void this.readStderr();
  }

  get pid(): number {
    return this.proc.pid;
  }

  get alive(): boolean {
    return !this.closedError;
  }

  private stderrHint(): string {
    const tail = this.stderrTail.join("\n").trim();
    return tail ? `: ${tail.slice(-400)}` : "";
  }

  private async readStdout() {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) this.onLine(line);
        }
      }
    } catch {
      /* process gone */
    }
  }

  private async readStderr() {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
          log.debug(`${this.opts.name}: ${line.slice(0, 500)}`);
        }
      }
    } catch {
      /* process gone */
    }
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      log.debug(`${this.opts.name}: non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    const id = msg.id as number | string | undefined;
    // A message with a method is a request/notification from the other side, never the answer to ours.
    const p = id !== undefined && id !== null && !("method" in msg) ? this.pending.get(id) : undefined;
    if (p) {
      this.pending.delete(id!);
      clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    this.opts.onMessage?.(msg);
  }

  /** Send a message with a fresh numeric id and wait for the message carrying the same id. */
  request(message: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.opts.name} did not answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ ...message, id });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fire-and-forget message (e.g. an MCP notification). */
  notify(message: Record<string, unknown>) {
    if (this.closedError) return;
    try {
      this.write(message);
    } catch {
      /* gone */
    }
  }

  private write(message: Record<string, unknown>) {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    this.proc.stdin.flush();
  }

  private fail(err: Error) {
    if (this.closedError) return;
    this.closedError = err;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** Close stdin (servers exit on EOF), then kill if it lingers. */
  async close(graceMs = 2000): Promise<void> {
    this.fail(new ProcessGoneError(`${this.opts.name} was stopped`));
    try {
      this.proc.stdin.end();
    } catch {
      /* already closed */
    }
    const done = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
    if (!done) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

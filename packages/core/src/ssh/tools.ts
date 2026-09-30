/**
 * The `ssh` MCP server (POST /mcp/ssh, per-run bearer token): shell, file and transfer tools on the SSH servers a run
 * may use — its chat's and its agent's, re-read on every call so a server taken away stops working at once. Godmode
 * signs in with the saved password or key and answers sudo's prompt itself; the secrets are masked in every result.
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { z } from "zod";
import { getAgent } from "../agents/service";
import { logger } from "../log";
import { audit } from "../services/audit";
import type { RunContext } from "../types";
import { HttpError } from "../util";
import { runSshServerIds } from "./assignments";
import { RemoteFileError, SshError, shellPath, shellQuote, type Connection } from "./client";
import { promptServers, serverSecrets, sshRun, sudoPassword, useServer, type PromptSshServer } from "./service";

const log = logger("ssh");

export interface SshToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const MAX_OUTPUT = 30_000;
const MAX_READ_BYTES = 2_000_000;
const DEFAULT_READ_LINES = 2000;

export const SSH_INSTRUCTIONS =
  "Tools for the SSH servers this task may use: run shell commands, read, write and edit files, and copy files between this computer and a server. " +
  "Godmode signs in (and answers sudo) for you — you never see passwords or keys. Pass `server` (its name or id) when more than one server is available.";

function text(t: string, isError = false): SshToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 3);
  return `${s.slice(0, head)}\n\n… [${(s.length - max).toLocaleString("en-US")} characters omitted] …\n\n${s.slice(-(max - head))}`;
}

/** Whatever a command prints, the server's saved secrets are masked before it reaches the model. */
function mask(s: string, secrets: string[]): string {
  let out = s;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("••••••••");
  return out;
}

interface ToolEnv {
  server: PromptSshServer;
  conn: Connection;
  runId: string;
  agentId: string;
  folders: string[];
}

interface SshTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never, env: ToolEnv) => Promise<SshToolResult>;
}

function defineTool<S extends z.ZodType>(def: { name: string; description: string; schema: S; run: (args: z.infer<S>, env: ToolEnv) => Promise<SshToolResult> }): SshTool {
  return def as unknown as SshTool;
}

const serverArg = z.string().max(200).optional().describe("Server name or id (optional when only one server is available)");

/* ------------------------------------------------------------------ */
/* Local paths (uploads and downloads)                                  */
/* ------------------------------------------------------------------ */

function inside(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** The real path, also for one that doesn't exist yet (its nearest existing folder resolved). */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // A link that points nowhere would be followed when the file is created.
    let link = false;
    try {
      link = lstatSync(path).isSymbolicLink();
    } catch {
      /* doesn't exist */
    }
    if (link) throw new RemoteFileError(`${path} is a link to a file that doesn't exist; use another path.`);
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

/** Settings and hooks there would run programs on this computer (Claude Code's own file tools can't edit them either). */
const PROTECTED_DIRS = new Set([".git", ".claude"]);

/**
 * A path on this computer inside the run's folders (relative ones are relative to the first, the run's working
 * directory). Symlinks can't lead out of them; files are never written into a .git or .claude folder.
 */
function localPath(input: string, folders: string[], mode: "read" | "write"): string {
  if (!folders.length) throw new RemoteFileError("This run has no folders on this computer to copy files from or to.");
  const real = realPath(resolve(folders[0]!, input.replace(/^~(?=$|[\\/])/, homedir())));
  const folder = folders.map(realPath).find((f) => inside(real, f));
  if (!folder) {
    throw new RemoteFileError(`${input} is outside the folders of this run. Use a path in ${folders.map((f) => `\`${f}\``).join(", ")}.`);
  }
  if (mode === "write" && relative(folder, real).split(/[\\/]/).some((part) => PROTECTED_DIRS.has(part))) {
    throw new RemoteFileError(`Godmode doesn't write files into .git or .claude folders on this computer. Use another path.`);
  }
  if (mode === "read" && !existsSync(real)) throw new RemoteFileError(`No such file on this computer: ${input}`);
  return real;
}

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

/** A failed `cd` stops there, whatever the command is made of. */
function commandScript(command: string, cwd: string | undefined): string {
  return cwd ? `cd -- ${shellPath(cwd)} || exit\n${command}` : command;
}

async function runShell(
  env: ToolEnv,
  args: { command: string; cwd?: string; stdin?: string; sudo?: boolean; timeout_seconds?: number },
): Promise<SshToolResult> {
  const timeoutMs = (args.timeout_seconds ?? 120) * 1000;
  const script = commandScript(args.command, args.cwd);
  let command = script;
  let prompt: { marker: string; answer: string; waitMs: number } | undefined;
  if (args.sudo && env.server.username !== "root") {
    // The same shell as without sudo: the user's login shell.
    const asRoot = `-- "\${SHELL:-/bin/sh}" -c ${shellQuote(script)}`;
    const probe = await env.conn.exec("sudo -n true", { timeoutMs: 15_000 });
    if (probe.exitCode === 127) return text(`sudo isn't installed on ${env.server.name}.`, true);
    if (probe.exitCode === 0) command = `sudo -n ${asRoot}`;
    else {
      const password = sudoPassword(env.server.id);
      if (!password) {
        return text(
          `sudo on ${env.server.name} asks for a password, and none is saved for this server. Ask the human to add it in SSH servers → ${env.server.name} → Edit ("Password for sudo").`,
          true,
        );
      }
      // The password only goes out when sudo prints this prompt (-k: it always asks when it needs one).
      const marker = `godmode-sudo-${randomBytes(8).toString("hex")}:`;
      command = `sudo -S -k -p ${shellQuote(marker)} ${asRoot}`;
      prompt = { marker, answer: password, waitMs: 10_000 };
      audit(`agent:${env.agentId}`, "ssh.sudo", env.server.id, { runId: env.runId });
    }
  }
  const res = await env.conn.exec(command, { timeoutMs, stdin: args.stdin ?? "", prompt });
  const stdout = res.stdout;
  let stderr = res.stderr;
  if (res.prompts > 1) stderr += `\nsudo rejected the saved password. Ask the human to check the password saved for ${env.server.name}.`;
  const status = res.timedOut
    ? `Timed out after ${args.timeout_seconds ?? 120} s. Godmode closed the session; a command that ignores that may still be running on the server (check with ps).`
    : res.cancelled
      ? "Cancelled."
      : res.lost
        ? `The connection to ${env.server.name} was lost while the command ran.`
        : res.exitSignal
          ? `Killed by signal ${res.exitSignal}`
          : `Exit code: ${res.exitCode}`;
  const parts = [status];
  if (stdout) parts.push(clip(stdout.replace(/\s+$/, "")));
  if (stderr.trim()) parts.push(`[stderr]\n${clip(stderr.replace(/\s+$/, ""), MAX_OUTPUT / 2)}`);
  if (!stdout && !stderr.trim()) parts.push("(no output)");
  return text(parts.join("\n"), res.timedOut || res.cancelled || res.lost || res.exitCode !== 0);
}

/** A file's text via SFTP, or `cat` when the server has no SFTP. */
async function readText(env: ToolEnv, path: string): Promise<string> {
  if (await env.conn.hasSftp()) return (await env.conn.readFile(path, MAX_READ_BYTES)).toString("utf8");
  const script = `f=${shellPath(path)}; if [ -d "$f" ]; then echo "$f is a folder" >&2; exit 21; fi; [ -f "$f" ] || { echo "No such file: $f" >&2; exit 2; }; s=$(wc -c < "$f" | tr -d ' '); if [ "$s" -gt ${MAX_READ_BYTES} ]; then echo "$f is too large to read ($s bytes)" >&2; exit 27; fi; cat -- "$f"`;
  const res = await env.conn.exec(script, { timeoutMs: 60_000 });
  if (res.exitCode !== 0) throw new RemoteFileError(res.stderr.trim() || `Couldn't read ${path} (exit ${res.exitCode})`);
  return res.stdout;
}

async function writeText(env: ToolEnv, path: string, content: string): Promise<void> {
  if (await env.conn.hasSftp()) return env.conn.writeFile(path, content);
  const res = await env.conn.exec(`f=${shellPath(path)}; mkdir -p "$(dirname "$f")" && cat > "$f"`, { timeoutMs: 60_000, stdin: content });
  if (res.exitCode !== 0) throw new RemoteFileError(res.stderr.trim() || `Couldn't write ${path} (exit ${res.exitCode})`);
}

const NO_SFTP = "This server doesn't offer SFTP, so files can't be copied. Move small text files with read_file / write_file instead.";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Answered without a connection. */
const LIST_TOOL = {
  name: "list_servers",
  description: "The SSH servers this task may use: name, id, address, operating system, what they are for, and whether sudo can be answered.",
  schema: z.object({}),
};

const TOOLS: SshTool[] = [
  defineTool({
    name: "shell",
    description:
      "Run a shell command on an SSH server (in the user's login shell, like `ssh host 'command'`). Returns the exit code, stdout and stderr. " +
      "Each call is a new session: pass cwd instead of relying on an earlier cd. Commands must not wait for input — use non-interactive flags (-y, --no-pager, DEBIAN_FRONTEND=noninteractive). " +
      "Start long-running processes in the background with nohup and redirect their output to a file. " +
      "sudo: true runs the command as root — Godmode answers sudo's password prompt, so never put a password into the command. stdin is passed to the command's standard input (e.g. file content for `tee`).",
    schema: z.object({
      server: serverArg,
      command: z.string().min(1).max(100_000).describe("Shell command(s) to run"),
      cwd: z.string().max(4096).optional().describe("Directory to run in (absolute, ~/… or relative to the home folder)"),
      stdin: z.string().max(5_000_000).optional().describe("Text for the command's standard input"),
      sudo: z.boolean().optional().describe("Run as root with sudo (Godmode enters the password)"),
      timeout_seconds: z.number().int().min(1).max(3600).optional().describe("Stop the command after this many seconds (default 120, max 3600)"),
    }),
    run: (args, env) => runShell(env, args),
  }),
  defineTool({
    name: "read_file",
    description: "Read a text file on an SSH server. Returns numbered lines (like cat -n). Use offset/limit for long files. Files only root can read: use shell with sudo: true.",
    schema: z.object({
      server: serverArg,
      path: z.string().min(1).max(4096).describe("File path on the server (absolute, ~/… or relative to the home folder)"),
      offset: z.number().int().min(1).optional().describe("First line to return (1-based)"),
      limit: z.number().int().min(1).max(20_000).optional().describe(`Number of lines (default ${DEFAULT_READ_LINES})`),
    }),
    run: async (args, env) => {
      const content = await readText(env, args.path);
      if (content.includes("\u0000")) return text(`${args.path} is a binary file. Inspect it with shell (file, xxd, …) or download it.`, true);
      if (!content) return text(`${args.path} is empty.`);
      const lines = content.replace(/\n$/, "").split("\n");
      const start = (args.offset ?? 1) - 1;
      const slice = lines.slice(start, start + (args.limit ?? DEFAULT_READ_LINES));
      const width = String(start + slice.length).length;
      const body = slice.map((l, i) => `${String(start + i + 1).padStart(width, " ")}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join("\n");
      const more = start + slice.length < lines.length ? `\n… ${lines.length - start - slice.length} more lines (use offset ${start + slice.length + 1})` : "";
      return text(clip(body + more, 200_000));
    },
  }),
  defineTool({
    name: "write_file",
    description: "Create or overwrite a file on an SSH server (parent folders are created). For files owned by root, use shell with sudo: true and `tee <path>` with the content as stdin.",
    schema: z.object({
      server: serverArg,
      path: z.string().min(1).max(4096).describe("File path on the server"),
      content: z.string().max(5_000_000).describe("The complete new file content"),
    }),
    run: async (args, env) => {
      await writeText(env, args.path, args.content);
      return text(`Wrote ${Buffer.byteLength(args.content, "utf8").toLocaleString("en-US")} bytes to ${args.path} on ${env.server.name}.`);
    },
  }),
  defineTool({
    name: "edit_file",
    description: "Replace text in a file on an SSH server. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. Read the file first.",
    schema: z.object({
      server: serverArg,
      path: z.string().min(1).max(4096),
      old_string: z.string().min(1).max(1_000_000),
      new_string: z.string().max(1_000_000),
      replace_all: z.boolean().optional(),
    }),
    run: async (args, env) => {
      if (args.old_string === args.new_string) return text("old_string and new_string are the same — nothing to change.", true);
      const content = await readText(env, args.path);
      if (content.includes("\u0000") || content.includes("�")) return text(`${args.path} isn't UTF-8 text; edit it with shell tools (sed, perl, …) instead.`, true);
      const count = content.split(args.old_string).length - 1;
      if (count === 0) return text(`old_string was not found in ${args.path}. Read the file and copy the text exactly.`, true);
      if (count > 1 && !args.replace_all) return text(`old_string occurs ${count} times in ${args.path}. Add surrounding context to make it unique, or set replace_all.`, true);
      const next = args.replace_all ? content.split(args.old_string).join(args.new_string) : content.replace(args.old_string, () => args.new_string);
      await writeText(env, args.path, next);
      return text(`Edited ${args.path} on ${env.server.name} (${args.replace_all ? `${count} replacement${count === 1 ? "" : "s"}` : "1 replacement"}).`);
    },
  }),
  defineTool({
    name: "upload",
    description:
      "Copy a file from this computer to an SSH server (any size, binary too). local_path must be in your working directory, your repository or the other folders of this run; " +
      "remote_path defaults to the file's name in the home folder. Parent folders are created; an existing file is replaced.",
    schema: z.object({
      server: serverArg,
      local_path: z.string().min(1).max(4096).describe("File on this computer (relative to your working directory, or absolute)"),
      remote_path: z.string().max(4096).optional().describe("Where to put it on the server (a folder that exists keeps the file's name)"),
    }),
    run: async (args, env) => {
      const local = localPath(args.local_path, env.folders, "read");
      if (!statSync(local).isFile()) return text(`${args.local_path} isn't a file. Upload files one at a time (pack a folder with tar first).`, true);
      if (!(await env.conn.hasSftp())) return text(NO_SFTP, true);
      let remote = args.remote_path?.trim() || basename(local);
      if (remote.endsWith("/") || (await env.conn.isDirectory(remote))) remote = posix.join(remote, basename(local));
      await env.conn.upload(local, remote);
      return text(`Uploaded ${basename(local)} (${formatBytes(statSync(local).size)}) to ${remote} on ${env.server.name}.`);
    },
  }),
  defineTool({
    name: "download",
    description:
      "Copy a file from an SSH server to this computer (any size, binary too). local_path defaults to workspace/downloads/<name> in your repository; " +
      "it must be in your working directory, your repository or the other folders of this run. An existing file is replaced.",
    schema: z.object({
      server: serverArg,
      remote_path: z.string().min(1).max(4096).describe("File on the server"),
      local_path: z.string().max(4096).optional().describe("Where to save it on this computer (relative to your working directory, or absolute)"),
    }),
    run: async (args, env) => {
      if (!(await env.conn.hasSftp())) return text(NO_SFTP, true);
      const size = await env.conn.fileSize(args.remote_path);
      if (size === null) return text(`No such file on ${env.server.name}: ${args.remote_path}`, true);
      const name = posix.basename(args.remote_path.replace(/\/+$/, "")) || "download";
      const target = args.local_path?.trim() || join(getAgent(env.agentId).repoPath, "workspace", "downloads", name);
      let local = localPath(target, env.folders, "write");
      if (existsSync(local) && statSync(local).isDirectory()) local = localPath(join(local, name), env.folders, "write");
      mkdirSync(dirname(local), { recursive: true });
      // Into a new file next to the target, then renamed over it: nothing is written through a link.
      const partial = join(dirname(local), `.${basename(local)}.${randomBytes(4).toString("hex")}.part`);
      try {
        await env.conn.download(args.remote_path, partial);
        renameSync(partial, local);
      } finally {
        rmSync(partial, { force: true });
      }
      return text(`Downloaded ${args.remote_path} (${formatBytes(size)}) from ${env.server.name} to ${local}.`);
    },
  }),
];

/* ------------------------------------------------------------------ */
/* Server                                                               */
/* ------------------------------------------------------------------ */

const schemaCache = new Map<string, Record<string, unknown>>();

function jsonSchema(name: string, schema: z.ZodType): Record<string, unknown> {
  let s = schemaCache.get(name);
  if (!s) {
    s = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete s.$schema;
    schemaCache.set(name, s);
  }
  return s;
}

function serversOf(ctx: RunContext): PromptSshServer[] {
  return promptServers(runSshServerIds(ctx.conversationId, ctx.agentId));
}

export function listSshTools(ctx: RunContext): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  if (!sshRun(ctx.runId)) return [];
  return [LIST_TOOL, ...TOOLS].map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.name, t.schema) }));
}

export class UnknownSshToolError extends Error {}

function pickServer(servers: PromptSshServer[], wanted: string | undefined): PromptSshServer | string {
  const names = servers.map((s) => `"${s.name}"`).join(", ");
  if (!servers.length) return "No SSH servers are available to this task anymore — the human removed them.";
  const key = wanted?.trim();
  if (!key) return servers.length === 1 ? servers[0]! : `Several servers are available (${names}): pass server.`;
  const byId = servers.find((s) => s.id === key);
  if (byId) return byId;
  const k = key.toLowerCase();
  // The exact name first, then a unique shorter form: "web-1" for "web-1 (staging)", the host, or user@host.
  for (const matches of [
    (s: PromptSshServer) => s.name.toLowerCase() === k,
    (s: PromptSshServer) => s.name.toLowerCase().startsWith(k) || s.address.toLowerCase() === k || s.address.toLowerCase().split("@")[1]?.replace(/:\d+$/, "") === k,
  ]) {
    const found = servers.filter(matches);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return `"${key}" matches several servers (${found.map((s) => `"${s.name}" = ${s.id}`).join(", ")}): pass the id.`;
  }
  return `No server "${key}" is available to this task. Available: ${names}.`;
}

function describeServers(servers: PromptSshServer[]): string {
  return JSON.stringify(
    servers.map((s) => ({
      name: s.name,
      id: s.id,
      address: s.address,
      os: s.os,
      description: s.description || null,
      sudo: s.sudoPassword ? "password saved — sudo: true works" : "no password saved — sudo: true only works without a password (NOPASSWD)",
    })),
    null,
    2,
  );
}

const audited = new Set<string>();

export async function callSshTool(ctx: RunContext, name: string, args: unknown): Promise<SshToolResult> {
  const run = sshRun(ctx.runId);
  if (!run) return text("This run has no SSH servers.", true);
  const servers = serversOf(ctx);
  if (name === LIST_TOOL.name) return servers.length ? text(describeServers(servers)) : text("No SSH servers are available to this task anymore.", true);
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new UnknownSshToolError(`Unknown tool: ${name}`);
  let label = name;
  try {
    const parsed = tool.schema.parse(args ?? {}) as { server?: string };
    const server = pickServer(servers, parsed.server);
    if (typeof server === "string") return text(server, true);
    label = `${name} on ${server.name}`;
    const key = `${ctx.runId}:${server.id}`;
    if (!audited.has(key)) {
      audited.add(key);
      setTimeout(() => audited.delete(key), 6 * 3600_000).unref?.();
      audit(`agent:${ctx.agentId}`, "ssh.use", server.id, { runId: ctx.runId });
    }
    const secrets = serverSecrets(server.id);
    try {
      const result = await useServer(
        server.id,
        (conn) => tool.run(parsed as never, { server, conn, runId: ctx.runId, agentId: ctx.agentId, folders: run.folders }),
        run.signal,
      );
      return { ...result, content: result.content.map((c) => ({ ...c, text: mask(c.text, secrets) })) };
    } catch (err) {
      if (err instanceof Error) err.message = mask(err.message, secrets);
      throw err;
    }
  } catch (err) {
    if (err instanceof z.ZodError) return text(`Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, true);
    if (err instanceof SshError) return text(err.message === "Cancelled" ? "Cancelled." : `Couldn't connect: ${err.message}`, true);
    if (err instanceof RemoteFileError) return text(err.message, true);
    if (err instanceof HttpError) return text(err.status === 423 ? "The vault is locked; ask the human to unlock Godmode." : err.message, true);
    log.warn(`ssh tool ${label} failed`, err);
    return text(`The SSH tool failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/**
 * Runners on SSH servers. A project folder on a server (a workspace source of kind "remote") moves the chats there onto
 * a headless Godmode on that server: Godmode signs in with the saved SSH server, installs `godmode` (~/.local/bin) when
 * it is missing, starts `godmode runner serve` on loopback (or finds the one it started before), pairs with a one-time
 * code printed over SSH and reaches its link through an SSH tunnel. No port on the server is opened. The runner gets
 * the setup without secrets (snapshot `lean`) and works with its own Claude Code login.
 */
import { createServer, type Server, type Socket } from "node:net";
import { parseRunnerCode, type RunnerPairingCode } from "@godmode/shared";
import { VERSION } from "../config";
import { all, get } from "../db";
import { logger } from "../log";
import { badRequest } from "../util";
import { execOn, shellQuote, type Session } from "../ssh/client";
import { connectServer, getServer } from "../ssh/service";

const log = logger("ssh-runners");

const LAUNCH_TIMEOUT_MS = 10 * 60_000;
const CODE_TIMEOUT_MS = 60_000;
const INSTALL_URL = "https://usegodmode.com/install.sh";

export interface RemoteFolder {
  serverId: string;
  path: string;
}

/** The first remote folder of the project, else of the workspace: the chats there run on its server. */
export function remoteFolderFor(owner: { projectId?: string | null; workspaceId?: string | null }): RemoteFolder | null {
  const pick = (sql: string, id: string) => get<{ server_id: string | null; path: string }>(sql, id);
  const row =
    (owner.projectId ? pick("SELECT server_id, path FROM workspace_sources WHERE project_id = ? AND kind = 'remote' ORDER BY position, created_at LIMIT 1", owner.projectId) : null) ??
    (owner.workspaceId ? pick("SELECT server_id, path FROM workspace_sources WHERE workspace_id = ? AND project_id IS NULL AND kind = 'remote' ORDER BY position, created_at LIMIT 1", owner.workspaceId) : null);
  return row?.server_id ? { serverId: row.server_id, path: row.path } : null;
}

/** A folder on the server as the runner there names it: `~` is its home folder. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
  return path;
}

/* ------------------------------------------------------------------ */
/* The script that installs and starts the runner                       */
/* ------------------------------------------------------------------ */

/**
 * Run with `sh -l -s` (a login shell, so PATH is the one the human's own SSH sessions get). Prints `home:<dir>` and
 * `port:<link port>` once the runner serves; progress and errors go to stderr.
 */
export function launchScript(version: string): string {
  return `set -u
umask 077
BIN="$HOME/.local/bin/godmode"
DATA="\${GODMODE_RUNNER_HOME:-$HOME/.godmode-runner}"
echo "home:$HOME"
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"; else echo "curl or wget is needed to install Godmode" >&2; return 1; fi; }
if [ ! -x "$BIN" ]; then
  echo "Installing Godmode on this server…" >&2
  fetch ${shellQuote(INSTALL_URL)} > "\${TMPDIR:-/tmp}/godmode-install.$$.sh" || exit 3
  GODMODE_VERSION=${shellQuote(`v${version}`)} GODMODE_INSTALL_DIR="$HOME/.local/bin" sh "\${TMPDIR:-/tmp}/godmode-install.$$.sh" >&2 ||
    GODMODE_INSTALL_DIR="$HOME/.local/bin" sh "\${TMPDIR:-/tmp}/godmode-install.$$.sh" >&2 || { rm -f "\${TMPDIR:-/tmp}/godmode-install.$$.sh"; exit 3; }
  rm -f "\${TMPDIR:-/tmp}/godmode-install.$$.sh"
fi
field() { sed -n "s/.*\\"$1\\": *\\([0-9][0-9]*\\).*/\\1/p" "$DATA/runner.json" 2>/dev/null | head -n 1; }
serving() { pid=$(field pid); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -n "$(field linkPort)" ]; }
if ! serving; then
  mkdir -p "$DATA/logs"
  GODMODE_RUNNER_LEAN=1 nohup "$BIN" runner serve --link-host 127.0.0.1 --link-port 0 >> "$DATA/logs/ssh-serve.log" 2>&1 < /dev/null &
  i=0
  while [ $i -lt 120 ]; do
    serving && break
    sleep 1
    i=$((i + 1))
  done
  if ! serving; then
    echo "Godmode didn't start on this server. Its log: $DATA/logs/ssh-serve.log" >&2
    tail -n 20 "$DATA/logs/ssh-serve.log" >&2 2>/dev/null
    exit 4
  fi
fi
echo "port:$(field linkPort)"
`;
}

export function parseLaunchOutput(stdout: string): { home: string; port: number } | null {
  const home = /^home:(\/.*)$/m.exec(stdout)?.[1]?.trim();
  const port = Number(/^port:(\d+)$/m.exec(stdout)?.[1]);
  return home && Number.isInteger(port) && port > 0 && port < 65536 ? { home, port } : null;
}

const PAIRING_SCRIPT = `BIN="$HOME/.local/bin/godmode"; "$BIN" runner pairing-code`;

/* ------------------------------------------------------------------ */
/* Tunnels                                                              */
/* ------------------------------------------------------------------ */

/** One signed-in SSH connection per server: it runs the scripts and carries the link (127.0.0.1:<local> → the runner's link port). */
class Tunnel {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  localPort = 0;
  remotePort = 0;
  home = "";
  closed = false;

  constructor(
    readonly serverId: string,
    readonly session: Session,
  ) {
    session.client.on("close", () => this.close());
    session.client.on("error", (err) => log.debug("tunnel connection error", { server: serverId, error: err.message }));
  }

  async exec(script: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const res = await execOn(this.session.client, "sh -l -s", { stdin: script, timeoutMs });
    if (res.lost) throw new Error("The SSH connection dropped.");
    if (res.timedOut) throw new Error("The server took too long to answer.");
    return { stdout: res.stdout, stderr: res.stderr, code: res.exitCode };
  }

  async launch(): Promise<void> {
    const res = await this.exec(launchScript(VERSION), LAUNCH_TIMEOUT_MS);
    const parsed = parseLaunchOutput(res.stdout);
    if (res.code !== 0 || !parsed) {
      const said = res.stderr.trim().split("\n").slice(-6).join(" ").slice(0, 600);
      throw new Error(said ? `Godmode couldn't be started on the server: ${said}` : "Godmode couldn't be started on the server.");
    }
    this.home = parsed.home;
    this.remotePort = parsed.port;
    await this.listen();
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.forward(socket));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        this.localPort = typeof address === "object" && address ? address.port : 0;
        this.server = server;
        resolve();
      });
    });
  }

  private forward(socket: Socket) {
    if (this.closed) return socket.destroy();
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    this.session.client.forwardOut("127.0.0.1", 0, "127.0.0.1", this.remotePort, (err, channel) => {
      if (err) {
        log.debug("tunnel forward refused", { server: this.serverId, error: err.message });
        return socket.destroy();
      }
      socket.pipe(channel).pipe(socket);
      channel.on("error", () => socket.destroy());
      socket.on("error", () => channel.close());
      channel.on("close", () => socket.destroy());
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = null;
    try {
      this.session.client.end();
    } catch {
      /* already closed */
    }
    if (tunnels.get(this.serverId) === this) tunnels.delete(this.serverId);
  }
}

const tunnels = new Map<string, Tunnel>();
const opening = new Map<string, Promise<Tunnel>>();

/** The server's tunnel with the runner started: opened (and the runner launched) when there is none. */
export function tunnelTo(serverId: string): Promise<Tunnel> {
  const open = tunnels.get(serverId);
  if (open && !open.closed) return Promise.resolve(open);
  let pending = opening.get(serverId);
  if (!pending) {
    pending = (async () => {
      const session = await connectServer(serverId);
      const tunnel = new Tunnel(serverId, session);
      try {
        await tunnel.launch();
      } catch (err) {
        tunnel.close();
        throw err;
      }
      tunnels.set(serverId, tunnel);
      return tunnel;
    })().finally(() => opening.delete(serverId));
    opening.set(serverId, pending);
  }
  return pending;
}

/** Where the link dials an SSH runner: its tunnel, opened (and the runner started again) when needed. */
export async function sshLinkTarget(serverId: string): Promise<{ addresses: string[]; port: number }> {
  const fresh = !tunnels.get(serverId) || tunnels.get(serverId)!.closed;
  const tunnel = await tunnelTo(serverId);
  // Every dial after the first looks again: the runner may have restarted (an update) on another port, or stopped.
  if (!fresh) await tunnel.launch();
  return { addresses: ["127.0.0.1"], port: tunnel.localPort };
}

/** The home folder on the server (known once a tunnel was opened). */
export async function serverHome(serverId: string): Promise<string> {
  return (await tunnelTo(serverId)).home;
}

/** A pairing code from the runner on the server, pointed at the tunnel. */
export async function pairingCodeVia(serverId: string): Promise<{ code: RunnerPairingCode; name: string }> {
  const tunnel = await tunnelTo(serverId);
  const res = await tunnel.exec(PAIRING_SCRIPT, CODE_TIMEOUT_MS);
  const text = res.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("gmr1."));
  const code = text ? parseRunnerCode(text) : null;
  if (!code) throw new Error(`The runner on the server gave no pairing code${res.stderr.trim() ? `: ${res.stderr.trim().slice(0, 300)}` : "."}`);
  return { code: { ...code, addresses: ["127.0.0.1"], port: tunnel.localPort }, name: getServer(serverId).name };
}

export const STOP_SCRIPT = `pid=$(sed -n 's/.*"pid": *\\([0-9][0-9]*\\).*/\\1/p' "\${GODMODE_RUNNER_HOME:-$HOME/.godmode-runner}/runner.json" 2>/dev/null | head -n 1); [ -n "$pid" ] && kill "$pid" 2>/dev/null; true`;

/** Stop the runner Godmode started on the server (its data stays) and close the tunnel. */
export async function stopSshRunner(serverId: string): Promise<void> {
  const tunnel = tunnels.get(serverId);
  try {
    if (tunnel && !tunnel.closed) await tunnel.exec(STOP_SCRIPT, 15_000);
    else {
      const session = await connectServer(serverId);
      try {
        await execOn(session.client, "sh -l -s", { stdin: STOP_SCRIPT, timeoutMs: 15_000 });
      } finally {
        session.client.end();
      }
    }
  } catch (err) {
    log.warn(`could not stop the runner on SSH server ${serverId}`, err);
  }
  tunnel?.close();
}

export function closeSshTunnel(serverId: string): void {
  tunnels.get(serverId)?.close();
}

export function closeAllSshTunnels(): void {
  for (const t of [...tunnels.values()]) t.close();
}

/** Runner rows that work on SSH servers. */
export function sshRunnerIds(): { id: string; serverId: string }[] {
  return all<{ id: string; ssh_server_id: string }>("SELECT id, ssh_server_id FROM runners WHERE kind = 'ssh' AND ssh_server_id IS NOT NULL").map((r) => ({
    id: r.id,
    serverId: r.ssh_server_id,
  }));
}

export function sshRunnerFor(serverId: string): string | null {
  return get<{ id: string }>("SELECT id FROM runners WHERE kind = 'ssh' AND ssh_server_id = ?", serverId)?.id ?? null;
}

export function assertServer(serverId: string): void {
  try {
    getServer(serverId);
  } catch {
    throw badRequest("The remote folder's SSH server was deleted. Pick the folder again in the project's settings.");
  }
}

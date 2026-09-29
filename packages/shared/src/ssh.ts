/**
 * SSH servers: remote machines agents sign in to and control (shell commands, files, transfers). The password or
 * private key is sealed in the vault — Godmode signs in, agents never see it. A server is assigned to agents (every
 * run of the agent) and to chats (runs in that chat); a run gets both.
 */
import type { ID, ISODate } from "./models";

export type SshAuthMethod = "password" | "key";

/** What a server is assigned to. */
export type SshAssignmentKind = "agent" | "conversation";

export interface SshAssignment {
  kind: SshAssignmentKind;
  id: ID;
  name: string;
}

export interface SshHostKey {
  /** e.g. "ssh-ed25519" */
  type: string;
  /** OpenSSH style, e.g. "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s" */
  fingerprint: string;
}

export interface SshKeyInfo {
  /** e.g. "ssh-ed25519", "ssh-rsa" */
  type: string;
  fingerprint: string;
  /** One line for the server's ~/.ssh/authorized_keys. */
  publicKey: string;
  /** The key is protected with a passphrase (saved too). */
  encrypted: boolean;
}

export interface SshServer {
  id: ID;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuthMethod;
  /** A password is saved: the login password, or for key logins the password sudo asks for. */
  hasPassword: boolean;
  /** Key logins: the saved private key (never the key itself). */
  key: SshKeyInfo | null;
  /** What the server is for; agents read it, e.g. "Production web server — nginx and Postgres". */
  description: string;
  /** Host key pinned on the first connection; a server that presents another key is refused. */
  hostKey: SshHostKey | null;
  /** Operating system seen on the last connection, e.g. "Ubuntu 24.04.1 LTS · Linux 6.8.0 x86_64". */
  os: string | null;
  lastConnectedAt: ISODate | null;
  /** Why the last connection failed (cleared by the next successful one). */
  lastError: string | null;
  /** Agents and chats that use the server. */
  assignments: SshAssignment[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface SshServerInput {
  name: string;
  host: string;
  /** Default 22. */
  port?: number;
  username: string;
  auth: SshAuthMethod;
  /** Password logins: the password. Key logins: the password sudo asks for (optional). undefined = keep, "" = remove. */
  password?: string;
  /** Private key (OpenSSH, PEM or PuTTY format). undefined = keep the saved one. */
  privateKey?: string;
  /** Import a private key from this computer instead: a `path` from GET /api/ssh/local-keys. */
  privateKeyPath?: string;
  /** Passphrase of an encrypted private key. undefined = keep, "" = none. */
  passphrase?: string;
  description?: string;
  /**
   * Pin this host key (as seen by a connection test); null = forget the pinned one, the next connection pins again.
   * undefined = keep it — unless the host or port changes, which forgets it.
   */
  hostKey?: SshHostKey | null;
}

export type SshServerPatch = Partial<SshServerInput>;

/** POST /api/ssh/test: try a connection before saving. With `id`, secrets the input leaves out come from that server. */
export interface SshTestInput extends SshServerInput {
  id?: ID;
}

/** Where a connection attempt stopped. */
export type SshTestStage = "config" | "connect" | "host-key" | "auth" | "command";

export interface SshTestResult {
  ok: boolean;
  /** Human-readable reason when the test failed. */
  error: string | null;
  stage: SshTestStage | null;
  /** The key the server presented (also when the test failed after the handshake). */
  hostKey: SshHostKey | null;
  /** The server presented a different key than the pinned one. */
  hostKeyChanged: boolean;
  os: string | null;
  /** Connect, handshake and sign-in. */
  latencyMs: number | null;
}

/** A private key found in ~/.ssh on the computer running Godmode (GET /api/ssh/local-keys). */
export interface SshLocalKey {
  path: string;
  name: string;
  type: string;
  fingerprint: string;
  encrypted: boolean;
  comment: string;
}

/** POST /api/ssh/keys: a new Ed25519 key pair. */
export interface SshGeneratedKey {
  privateKey: string;
  publicKey: string;
  type: string;
  fingerprint: string;
}

/** POST /api/ssh/servers/:id/exec */
export interface SshExecInput {
  command: string;
  timeoutSeconds?: number;
}

export interface SshExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** POST /api/ssh/servers/:id/assign */
export interface SshAssignInput {
  kind: SshAssignmentKind;
  id: ID;
  /** false = remove the assignment. */
  assigned: boolean;
}

/** `ssh -p <port> user@host` for a terminal (the port only when it isn't 22). */
export function sshCommand(server: Pick<SshServer, "host" | "port" | "username">): string {
  return `ssh ${server.port !== 22 ? `-p ${server.port} ` : ""}${server.username}@${server.host}`;
}

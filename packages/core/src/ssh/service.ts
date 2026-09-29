/**
 * SSH servers (owner: ssh): records with their password, private key and passphrase sealed in the vault, connection
 * tests, the human's "Run command", and the runs that may use them (their folders on this computer and an abort
 * signal for their in-flight calls).
 */
import type {
  SshAssignInput,
  SshAuthMethod,
  SshExecInput,
  SshExecResult,
  SshHostKey,
  SshKeyInfo,
  SshServer,
  SshServerInput,
  SshServerPatch,
  SshTestInput,
  SshTestResult,
} from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getAgent, updateAgent } from "../agents/service";
import { audit } from "../services/audit";
import { getConversationSummary, updateConversation } from "../services/conversations";
import { HttpError, badRequest, newId, notFound, now, parseJson } from "../util";
import { open, openOptional, seal } from "../vault/vault";
import { removeServerEverywhere, sshAssignments } from "./assignments";
import { OS_PROBE, SshError, addressOf, connect, describeOs, dropConnection, execOn, withConnection, type Connection, type ConnectTarget } from "./client";
import { SshKeyError, parsePrivateKey, readLocalKey } from "./keys";

const log = logger("ssh");

const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_EXEC_OUTPUT = 200_000;

interface SshServerRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuthMethod;
  description: string;
  password_enc: string | null;
  private_key_enc: string | null;
  passphrase_enc: string | null;
  key_info: string | null;
  host_key_type: string | null;
  host_key_fingerprint: string | null;
  os: string | null;
  last_connected_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const context = (field: "password" | "private_key" | "passphrase", id: string) => `ssh_servers.${field}:${id}`;

function hostKeyOf(r: SshServerRow): SshHostKey | null {
  return r.host_key_fingerprint ? { type: r.host_key_type ?? "unknown", fingerprint: r.host_key_fingerprint } : null;
}

function toServer(r: SshServerRow): SshServer {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    auth: r.auth === "key" ? "key" : "password",
    hasPassword: !!r.password_enc,
    key: r.auth === "key" ? parseJson<SshKeyInfo | null>(r.key_info, null) : null,
    description: r.description,
    hostKey: hostKeyOf(r),
    os: r.os,
    lastConnectedAt: r.last_connected_at,
    lastError: r.last_error,
    assignments: sshAssignments(r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function row(id: string): SshServerRow | null {
  return get<SshServerRow>("SELECT * FROM ssh_servers WHERE id = ?", id);
}

function requireRow(id: string): SshServerRow {
  const r = row(id);
  if (!r) throw notFound("SSH server");
  return r;
}

export function listServers(): SshServer[] {
  return all<SshServerRow>("SELECT * FROM ssh_servers ORDER BY name COLLATE NOCASE, created_at").map(toServer);
}

export function getServer(id: string): SshServer {
  return toServer(requireRow(id));
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

function normalizeName(v: string | undefined): string {
  const name = (v ?? "").trim();
  if (!name) throw badRequest("Give the server a name");
  return name.slice(0, 100);
}

/** A host name or an IP address (IPv6 with or without brackets); no user, port or path. */
function normalizeHost(v: string | undefined): string {
  let host = (v ?? "").trim();
  if (/^\[.*\]$/.test(host)) host = host.slice(1, -1);
  if (!host || host.length > 253 || /[\s@/\\?#]/.test(host) || /[\u0000-\u001f]/.test(host)) {
    throw badRequest("Enter the server's host name or IP address — without user@, a port or a path");
  }
  return host;
}

function normalizePort(v: number | undefined): number {
  const port = v ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("The port must be a number from 1 to 65535");
  return port;
}

function normalizeUsername(v: string | undefined): string {
  const user = (v ?? "").trim();
  if (!user || user.length > 100 || /[\s\u0000-\u001f]/.test(user)) throw badRequest("Enter the user name to sign in with");
  return user;
}

function normalizeHostKey(v: SshHostKey | null | undefined): SshHostKey | null | undefined {
  if (v === undefined || v === null) return v;
  if (!HOST_KEY_FINGERPRINT.test(v.fingerprint)) throw badRequest("That host key fingerprint isn't valid (expected SHA256:…)");
  return { type: (v.type || "unknown").slice(0, 60), fingerprint: v.fingerprint };
}

function keyProblem(err: unknown): never {
  if (err instanceof SshKeyError) throw new HttpError(400, err.message, err.code === "invalid" ? "bad_request" : err.code);
  throw err;
}

interface Secrets {
  password: string | null;
  privateKey: string | null;
  passphrase: string | null;
  keyInfo: SshKeyInfo | null;
}

/**
 * The secrets a server ends up with after `input` (undefined fields keep what `current` has). Throws with a message
 * for the human when something required is missing or the key can't be used.
 */
function resolveSecrets(auth: SshAuthMethod, input: SshServerPatch, current: Secrets | null): Secrets {
  const password = input.password === undefined ? (current?.password ?? null) : input.password || null;
  if (auth === "password") {
    if (!password) throw badRequest("Enter the password");
    return { password, privateKey: null, passphrase: null, keyInfo: null };
  }
  let text: string | null = null;
  try {
    if (input.privateKeyPath) text = readLocalKey(input.privateKeyPath);
    else if (input.privateKey?.trim()) text = input.privateKey;
  } catch (err) {
    keyProblem(err);
  }
  const passphrase = input.passphrase === undefined ? (current?.passphrase ?? null) : input.passphrase || null;
  const keyText = text ?? current?.privateKey ?? null;
  if (!keyText) throw badRequest("Add the private key: paste it, load a file or generate a new one");
  if (!text && input.passphrase === undefined && current?.keyInfo) {
    return { password, privateKey: keyText, passphrase, keyInfo: current.keyInfo };
  }
  let info: SshKeyInfo;
  try {
    info = parsePrivateKey(keyText, passphrase).info;
  } catch (err) {
    keyProblem(err);
  }
  return { password, privateKey: `${keyText.trim()}\n`, passphrase: info.encrypted ? passphrase : null, keyInfo: info };
}

function secretsOf(r: SshServerRow): Secrets {
  return {
    password: openOptional(r.password_enc, context("password", r.id)),
    privateKey: openOptional(r.private_key_enc, context("private_key", r.id)),
    passphrase: openOptional(r.passphrase_enc, context("passphrase", r.id)),
    keyInfo: parseJson<SshKeyInfo | null>(r.key_info, null),
  };
}

function sealed(id: string, s: Secrets) {
  return {
    password_enc: s.password ? seal(s.password, context("password", id)) : null,
    private_key_enc: s.privateKey ? seal(s.privateKey, context("private_key", id)) : null,
    passphrase_enc: s.passphrase ? seal(s.passphrase, context("passphrase", id)) : null,
    key_info: s.keyInfo ? JSON.stringify(s.keyInfo) : null,
  };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

export function createServer(input: SshServerInput): SshServer {
  const auth: SshAuthMethod = input.auth === "key" ? "key" : "password";
  const fields = {
    name: normalizeName(input.name),
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    username: normalizeUsername(input.username),
  };
  const hostKey = normalizeHostKey(input.hostKey) ?? null;
  const secrets = resolveSecrets(auth, input, null);
  const id = newId("ssh");
  const ts = now();
  insert("ssh_servers", {
    id,
    ...fields,
    auth,
    description: (input.description ?? "").trim().slice(0, 4000),
    ...sealed(id, secrets),
    host_key_type: hostKey?.type ?? null,
    host_key_fingerprint: hostKey?.fingerprint ?? null,
    created_at: ts,
    updated_at: ts,
  });
  log.info("SSH server added", { server: id, host: addressOf(fields), auth });
  audit("user", "ssh.create", id, { name: fields.name, host: addressOf(fields), username: fields.username, auth });
  bus.changed("ssh-servers");
  return getServer(id);
}

export function updateServer(id: string, patch: SshServerPatch): SshServer {
  const current = requireRow(id);
  const auth: SshAuthMethod = patch.auth === undefined ? current.auth : patch.auth === "key" ? "key" : "password";
  const host = patch.host === undefined ? current.host : normalizeHost(patch.host);
  const port = patch.port === undefined ? current.port : normalizePort(patch.port);
  const touchesSecrets =
    patch.auth !== undefined || patch.password !== undefined || patch.privateKey !== undefined || patch.privateKeyPath !== undefined || patch.passphrase !== undefined;
  const secrets = touchesSecrets ? resolveSecrets(auth, patch, secretsOf(current)) : null;
  // Another machine answers at a new address: the old host key means nothing there.
  const moved = host !== current.host || port !== current.port;
  const hostKey = patch.hostKey !== undefined ? normalizeHostKey(patch.hostKey) : moved ? null : undefined;
  update("ssh_servers", id, {
    name: patch.name === undefined ? undefined : normalizeName(patch.name),
    host,
    port,
    username: patch.username === undefined ? undefined : normalizeUsername(patch.username),
    auth,
    description: patch.description === undefined ? undefined : patch.description.trim().slice(0, 4000),
    ...(secrets ? sealed(id, secrets) : {}),
    ...(hostKey === undefined ? {} : { host_key_type: hostKey?.type ?? null, host_key_fingerprint: hostKey?.fingerprint ?? null }),
    ...(moved || secrets ? { last_error: null } : {}),
    ...(moved ? { os: null } : {}),
    updated_at: now(),
  });
  dropConnection(id);
  audit("user", "ssh.update", id, {
    name: patch.name ?? current.name,
    ...(moved ? { host: addressOf({ host, port }) } : {}),
    ...(secrets ? { secrets: true } : {}),
    ...(hostKey !== undefined ? { hostKey: hostKey?.fingerprint ?? null } : {}),
  });
  bus.changed("ssh-servers");
  return getServer(id);
}

export function deleteServer(id: string): void {
  const current = requireRow(id);
  const removed = tx(() => {
    run("DELETE FROM ssh_servers WHERE id = ?", id);
    return removeServerEverywhere(id);
  });
  dropConnection(id);
  log.info("SSH server deleted", { server: id });
  audit("user", "ssh.delete", id, { name: current.name });
  bus.changed("ssh-servers");
  if (removed.agents.length) bus.changed("agents");
}

/** Give an agent or a chat the server, or take it away (human-only). */
export async function assignServer(id: string, input: SshAssignInput): Promise<SshServer> {
  requireRow(id);
  const toggle = (ids: string[]) => (input.assigned ? [...new Set([...ids, id])] : ids.filter((x) => x !== id));
  if (input.kind === "agent") {
    const agent = getAgent(input.id);
    await updateAgent(agent.id, { sshServerIds: toggle(agent.sshServerIds) });
  } else {
    const conversation = getConversationSummary(input.id);
    updateConversation(conversation.id, { sshServerIds: toggle(conversation.sshServerIds) });
  }
  audit("user", input.assigned ? "ssh.assign" : "ssh.unassign", id, { kind: input.kind, target: input.id });
  return getServer(id);
}

/* ------------------------------------------------------------------ */
/* Connections                                                          */
/* ------------------------------------------------------------------ */

function targetOf(r: SshServerRow, secrets = secretsOf(r)): ConnectTarget {
  return {
    host: r.host,
    port: r.port,
    username: r.username,
    auth: r.auth,
    password: secrets.password,
    privateKey: secrets.privateKey,
    passphrase: secrets.passphrase,
    hostKey: hostKeyOf(r),
  };
}

/** Remember a successful connection: pin the host key the first time, clear the last error. */
function recordConnected(id: string, hostKey: SshHostKey, os?: string | null): void {
  const r = row(id);
  if (!r) return;
  update("ssh_servers", id, {
    ...(r.host_key_fingerprint ? {} : { host_key_type: hostKey.type, host_key_fingerprint: hostKey.fingerprint }),
    ...(os ? { os } : {}),
    last_connected_at: now(),
    last_error: null,
  });
  bus.changed("ssh-servers");
}

function recordFailure(id: string, message: string): void {
  if (!row(id)) return;
  update("ssh_servers", id, { last_error: message });
  bus.changed("ssh-servers");
}

const osProbed = new Set<string>();

async function probeOs(conn: Connection): Promise<string | null> {
  try {
    const res = await conn.exec(OS_PROBE, { timeoutMs: 10_000 });
    return describeOs(res.stdout);
  } catch {
    return null;
  }
}

/** A signed-in connection to the server (pooled) for the duration of `fn`. */
export async function useServer<T>(id: string, fn: (conn: Connection) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const r = requireRow(id);
  let connected = false;
  return withConnection(
    id,
    {
      version: r.updated_at,
      target: () => targetOf(requireRow(id)),
      onConnect: (session) => {
        connected = true;
        recordConnected(id, session.hostKey);
      },
      onError: (err) => recordFailure(id, err.message),
    },
    async (conn) => {
      if (connected && !r.os && !osProbed.has(id)) {
        osProbed.add(id);
        void useServer(id, probeOs).then((os) => os && update("ssh_servers", id, { os }), () => undefined);
      }
      return fn(conn);
    },
    signal,
  );
}

async function probe(target: ConnectTarget): Promise<SshTestResult> {
  let session: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    session = await connect(target);
    const res = await execOn(session.client, OS_PROBE, { timeoutMs: 10_000 }).catch(() => null);
    return { ok: true, error: null, stage: null, hostKey: session.hostKey, hostKeyChanged: false, os: res ? describeOs(res.stdout) : null, latencyMs: session.latencyMs };
  } catch (err) {
    if (!(err instanceof SshError)) throw err;
    return { ok: false, error: err.message, stage: err.stage, hostKey: err.hostKey, hostKeyChanged: err.hostKeyChanged, os: null, latencyMs: null };
  } finally {
    session?.client.end();
  }
}

/** Sign in to a saved server; the first successful test pins its host key. */
export async function testServer(id: string): Promise<SshTestResult> {
  const r = requireRow(id);
  const result = await probe(targetOf(r));
  if (result.ok && result.hostKey) recordConnected(id, result.hostKey, result.os);
  else if (result.error) recordFailure(id, result.error);
  return result;
}

/** Try settings before they are saved (secrets the input leaves out come from the saved server `id`). Records nothing. */
export async function tryServer(input: SshTestInput): Promise<SshTestResult> {
  const fail = (error: string): SshTestResult => ({ ok: false, error, stage: "config", hostKey: null, hostKeyChanged: false, os: null, latencyMs: null });
  const current = input.id ? requireRow(input.id) : null;
  let target: ConnectTarget;
  try {
    const auth: SshAuthMethod = input.auth === "key" ? "key" : input.auth === "password" ? "password" : (current?.auth ?? "password");
    const host = normalizeHost(input.host ?? current?.host);
    const port = normalizePort(input.port ?? current?.port);
    const secrets = resolveSecrets(auth, input, current ? secretsOf(current) : null);
    const moved = !!current && (host !== current.host || port !== current.port);
    const pinned = input.hostKey !== undefined ? normalizeHostKey(input.hostKey) : current && !moved ? hostKeyOf(current) : null;
    target = {
      host,
      port,
      username: normalizeUsername(input.username ?? current?.username),
      auth,
      password: secrets.password,
      privateKey: secrets.privateKey,
      passphrase: secrets.passphrase,
      hostKey: pinned ?? null,
    };
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return fail(err.message);
    throw err;
  }
  return probe(target);
}

function clipOutput(s: string): string {
  return s.length > MAX_EXEC_OUTPUT ? `${s.slice(0, MAX_EXEC_OUTPUT / 2)}\n\n… [output shortened] …\n\n${s.slice(-MAX_EXEC_OUTPUT / 2)}` : s;
}

/** The human's "Run command" on a server. */
export async function execForHuman(id: string, input: SshExecInput): Promise<SshExecResult> {
  const timeoutMs = Math.min(Math.max(input.timeoutSeconds ?? 120, 1), 600) * 1000;
  try {
    const res = await useServer(id, (conn) => conn.exec(input.command, { timeoutMs }));
    const stderr = res.lost ? `${res.stderr}\nThe connection was lost while the command ran.` : res.stderr;
    return { exitCode: res.exitCode, stdout: clipOutput(res.stdout), stderr: clipOutput(stderr), timedOut: res.timedOut, durationMs: res.durationMs };
  } catch (err) {
    if (err instanceof SshError) throw new HttpError(502, err.message, `ssh_${err.stage.replace("-", "_")}`);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Runs                                                                 */
/* ------------------------------------------------------------------ */

/** A server as the run's system prompt describes it. */
export interface PromptSshServer {
  id: string;
  name: string;
  username: string;
  /** user@host, with :port when it isn't 22 */
  address: string;
  os: string | null;
  description: string;
  /** A password is saved, so `sudo: true` can answer sudo's prompt. */
  sudoPassword: boolean;
}

export function promptServers(ids: string[]): PromptSshServer[] {
  return ids.flatMap((id) => {
    const r = row(id);
    return r
      ? [
          {
            id: r.id,
            name: r.name,
            username: r.username,
            address: `${r.username}@${addressOf(r)}`,
            os: r.os,
            description: r.description,
            sudoPassword: !!r.password_enc,
          },
        ]
      : [];
  });
}

/** The secrets of a server that must never reach the model (masked in tool results). */
export function serverSecrets(id: string): string[] {
  const r = row(id);
  if (!r) return [];
  const s = secretsOf(r);
  return [s.password, s.passphrase].filter((v): v is string => !!v && v.length >= 4);
}

/** The password sudo asks for, when one is saved. */
export function sudoPassword(id: string): string | null {
  const r = row(id);
  return r?.password_enc ? open(r.password_enc, context("password", id)) : null;
}

interface RunSsh {
  /** Folders on this computer the run works with (uploads come from and downloads go to these). */
  folders: string[];
  abort: AbortController;
}

const runs = new Map<string, RunSsh>();

/** The run may use SSH servers: its tools work until `detachSsh`. */
export function attachSsh(runId: string, folders: string[]): void {
  runs.set(runId, { folders, abort: new AbortController() });
}

/** The run ended: its in-flight SSH calls are cancelled. */
export function detachSsh(runId: string): void {
  const entry = runs.get(runId);
  if (!entry) return;
  runs.delete(runId);
  entry.abort.abort();
}

export function sshRun(runId: string): { folders: string[]; signal: AbortSignal } | null {
  const entry = runs.get(runId);
  return entry ? { folders: entry.folders, signal: entry.abort.signal } : null;
}

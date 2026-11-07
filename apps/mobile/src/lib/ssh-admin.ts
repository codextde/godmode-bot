import type {
  SshAssignInput,
  SshExecResult,
  SshGeneratedKey,
  SshLocalKey,
  SshServer,
  SshServerInput,
  SshServerPatch,
  SshTestInput,
  SshTestResult,
} from "@godmode/shared";
import { request } from "./api";
import { ik } from "./integrations";
import { queryClient } from "./query";

/**
 * SSH servers as the desktop app edits them (full-access phones only). Passwords, private keys and passphrases are
 * write-only: the computer seals them in the vault and sends back only that one is saved (and a key's fingerprint).
 */
const enc = encodeURIComponent;

export const sshAdmin = {
  create: (input: SshServerInput) => request<SshServer>("POST", "/api/ssh/servers", input, 30_000),
  update: (id: string, patch: SshServerPatch) => request<SshServer>("PATCH", `/api/ssh/servers/${enc(id)}`, patch, 30_000),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/ssh/servers/${enc(id)}`),
  test: (id: string) => request<SshTestResult>("POST", `/api/ssh/servers/${enc(id)}/test`, {}, 45_000),
  /** Tries the form before it is saved; with `id`, secrets the form leaves out come from that server. */
  try: (input: SshTestInput) => request<SshTestResult>("POST", "/api/ssh/test", input, 45_000),
  /** Private keys in ~/.ssh on the computer (their paths and fingerprints, never the keys). */
  localKeys: () => request<SshLocalKey[]>("GET", "/api/ssh/local-keys"),
  generateKey: (comment: string) => request<SshGeneratedKey>("POST", "/api/ssh/keys", { comment }, 30_000),
  installGodmode: (id: string) => request<{ ok: true }>("POST", `/api/ssh/servers/${enc(id)}/godmode`, {}),
  /** Runs one command as the server's user, like the desktop's command box (up to two minutes). */
  exec: (id: string, command: string) => request<SshExecResult>("POST", `/api/ssh/servers/${enc(id)}/exec`, { command, timeoutSeconds: 120 }, 130_000),
  assign: (id: string, input: SshAssignInput) => request<SshServer>("POST", `/api/ssh/servers/${enc(id)}/assign`, input),
};

export const sk = {
  localKeys: ["ssh-local-keys"],
} as const;

export const refreshServers = () => void queryClient.invalidateQueries({ queryKey: ik.sshServers });

/** The saved server, put into the list at once (the computer's change event follows). */
export function putServer(server: SshServer) {
  queryClient.setQueryData<SshServer[]>(ik.sshServers, (old) => (old ? (old.some((s) => s.id === server.id) ? old.map((s) => (s.id === server.id ? server : s)) : [...old, server]) : old));
}

/** "ssh-ed25519" → "ED25519", "ecdsa-sha2-nistp256" → "ECDSA", "ssh-rsa" → "RSA". */
export function keyTypeLabel(type: string): string {
  const hw = /^sk-/i.test(type) ? "-SK" : "";
  if (/ed25519/i.test(type)) return `ED25519${hw}`;
  if (/ecdsa/i.test(type)) return `ECDSA${hw}`;
  if (/rsa/i.test(type)) return "RSA";
  if (/dss|dsa/i.test(type)) return "DSA";
  return type.replace(/^ssh-/i, "").toUpperCase();
}

export function shortFingerprint(fingerprint: string, length = 18): string {
  return fingerprint.length > length ? `${fingerprint.slice(0, length)}…` : fingerprint;
}

export function looksLikePublicKey(text: string): boolean {
  const t = text.trim();
  return /^(ssh-|ecdsa-|sk-)\S+\s+AAAA/.test(t) || /BEGIN (SSH2 )?PUBLIC KEY/.test(t);
}

/** `user@host:port`, `ssh -p 2222 user@host` or `host:port` typed or pasted into the host field. */
export function parseSshTarget(text: string): { host: string; username?: string; port?: number } | null {
  const m = text.trim().match(/^(?:ssh\s+)?(?:-p\s*(\d{1,5})\s+)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^\s:@/]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const [, flagPort, username, rawHost, suffixPort] = m;
  if (!username && !flagPort && !suffixPort) return null;
  const port = Number(flagPort ?? suffixPort);
  return { host: rawHost!.replace(/^\[|\]$/g, ""), username, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined };
}

/** "deploy@web-1.example.com", with the port only when it isn't 22. */
export function sshAddress(server: Pick<SshServer, "host" | "port" | "username">): string {
  if (server.port === 22) return `${server.username}@${server.host}`;
  const host = server.host.includes(":") ? `[${server.host}]` : server.host;
  return `${server.username}@${host}:${server.port}`;
}

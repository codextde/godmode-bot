/**
 * The SSH keys in ~/.ssh on the computer running Godmode: what is there, new and imported keys, renames that follow
 * into ~/.ssh/config, parking a key in ~/.ssh/disabled, deleting to the Trash, and the running ssh-agent. Works on the
 * files themselves and never hands out a private key.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { utils } from "ssh2";
import type { SshKeyChange, SshKeyGenerateInput, SshKeyImportInput, SshKeyInstallResult, SshKeyPatch, SshKeysOverview, SshManagedKey } from "@godmode/shared";
import { bus } from "../events/bus";
import { audit } from "../services/audit";
import { getSettings } from "../services/settings";
import { HttpError } from "../util";
import { shellQuote } from "./client";
import { fingerprintOf, generateEd25519, NOT_KEYS, openSshPublicBlob, parsePrivateKey, SshKeyError, sshDir } from "./keys";
import { execForHuman, getServer, listServers } from "./service";

const run = promisify(execFile);

const DISABLED_DIR = "disabled";
const TRASH_DIR = "trash";
const MAX_KEY_FILE = 256 * 1024;
const RESERVED = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys", "environment", "rc", DISABLED_DIR, TRASH_DIR]);
const PRIVATE_FIRST_LINE = /^\s*(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|PuTTY-User-Key-File-\d+:)/;
const PUBLIC_LINE = /^(ssh-[\w.@-]+|ecdsa-sha2-[\w.@-]+|sk-[\w.@-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/;

const httpError = (status: number, message: string, code: string) => new HttpError(status, message, code);

/** The human turned the module off: the API and the agents' tools leave ~/.ssh alone. */
export function requireSshKeysOn(): void {
  if (!getSettings().sshKeys.enabled) throw httpError(403, "SSH keys are turned off in Settings.", "ssh_keys_off");
}

const homeDir = () => process.env.HOME || homedir();

/* ------------------------------------------------------------------ */
/* ~/.ssh/config                                                        */
/* ------------------------------------------------------------------ */

function configLine(line: string): { keyword: string; arg: string; argAt: number } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const m = /^([^\s=]+)[\s=]+(.*)$/.exec(trimmed);
  if (!m?.[1] || m[2] === undefined) return null;
  return { keyword: m[1].toLowerCase(), arg: m[2], argAt: line.indexOf(trimmed) + trimmed.length - m[2].length };
}

const firstToken = (arg: string) => /^(?:"[^"]*"|\S+)/.exec(arg)?.[0] ?? "";
const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

/** Where an IdentityFile argument points, the way ssh expands it. */
function identityPath(token: string, home: string, dir: string): string {
  const expanded = unquote(token).replaceAll("%d", home);
  if (expanded === "~") return home;
  if (expanded.startsWith("~/")) return join(home, expanded.slice(2));
  return isAbsolute(expanded) ? expanded : join(dir, expanded);
}

/** Host entries whose IdentityFile is this key. */
export function hostsUsing(config: string, home: string, dir: string, keyPath: string): string[] {
  let hosts = ["*"];
  const found = new Set<string>();
  for (const line of config.split(/\r?\n/)) {
    const parsed = configLine(line);
    if (!parsed) continue;
    if (parsed.keyword === "host") {
      hosts = parsed.arg.split(/\s+/).filter((h) => h && !h.startsWith("!"));
      const comment = hosts.findIndex((h) => h.startsWith("#"));
      if (comment >= 0) hosts = hosts.slice(0, comment);
      hosts = hosts.map(unquote);
    } else if (parsed.keyword === "match") {
      hosts = [`Match ${parsed.arg}`];
    } else if (parsed.keyword === "identityfile" && identityPath(firstToken(parsed.arg), home, dir) === keyPath) {
      for (const host of hosts) found.add(host);
    }
  }
  return [...found];
}

/** The config with every IdentityFile of the old key pointing at the new name, in the human's own notation; null when none does. */
export function renameIdentity(config: string, home: string, dir: string, oldName: string, newName: string): string | null {
  const oldPath = join(dir, oldName);
  let changed = false;
  const out = config.split(/(?<=\n)/).map((line) => {
    const body = line.replace(/[\r\n]+$/, "");
    const parsed = configLine(body);
    if (parsed?.keyword !== "identityfile") return line;
    const token = firstToken(parsed.arg);
    if (identityPath(token, home, dir) !== oldPath) return line;
    const inner = unquote(token);
    const renamed = inner.endsWith(oldName) ? inner.slice(0, inner.length - oldName.length) + newName : join(dir, newName);
    changed = true;
    return body.slice(0, parsed.argAt) + (token.startsWith('"') ? `"${renamed}"` : renamed) + line.slice(parsed.argAt + token.length);
  });
  return changed ? out.join("") : null;
}

function expandInclude(token: string, home: string, dir: string): string[] {
  const path = identityPath(token, home, dir);
  const name = basename(path);
  if (!/[*?]/.test(name)) return [path];
  const pattern = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  try {
    return readdirSync(dirname(path)).filter((f) => pattern.test(f)).sort().map((f) => join(dirname(path), f));
  } catch {
    return [];
  }
}

/** ~/.ssh/config and every file it pulls in through Include. */
function configFiles(): { path: string; text: string }[] {
  const dir = sshDir();
  const home = homeDir();
  const seen = new Set<string>();
  const files: { path: string; text: string }[] = [];
  const visit = (path: string, depth: number) => {
    if (depth > 8 || seen.has(path)) return;
    seen.add(path);
    const text = readSmall(path);
    if (text === null) return;
    files.push({ path, text });
    for (const line of text.split(/\r?\n/)) {
      const parsed = configLine(line);
      if (parsed?.keyword !== "include") continue;
      for (const token of parsed.arg.match(/"[^"]*"|[^\s"]+/g) ?? []) {
        if (token.startsWith("#")) break;
        for (const match of expandInclude(token, home, dir)) visit(match, depth + 1);
      }
    }
  };
  visit(join(dir, "config"), 0);
  return files;
}

function hostsAcross(configs: string[], name: string): string[] {
  const dir = sshDir();
  return [...new Set(configs.flatMap((config) => hostsUsing(config, homeDir(), dir, join(dir, name))))];
}

/** Keeps the old file next to it and swaps in the new one in one step (through a symlink, so dotfile setups survive). */
function replaceConfig(file: string, next: string): void {
  const path = realpathSync(file);
  let backup = join(dirname(path), `${basename(path)}.godmode-${Date.now()}.bak`);
  for (let n = 2; existsOrLink(backup); n++) backup = join(dirname(path), `${basename(path)}.godmode-${Date.now()}-${n}.bak`);
  writeNew(backup, readFileSync(path), 0o600);
  const temp = `${path}.godmode-${randomBytes(4).toString("hex")}`;
  writeNew(temp, Buffer.from(next), 0o600);
  try {
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Reading keys                                                         */
/* ------------------------------------------------------------------ */

function readSmall(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_KEY_FILE) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function publicLine(text: string | null): { type: string; data: string; comment: string; blob: Buffer } | null {
  const m = text ? PUBLIC_LINE.exec(text.trim().split(/\r?\n/)[0]?.trim() ?? "") : null;
  if (!m?.[1] || !m[2]) return null;
  const blob = Buffer.from(m[2], "base64");
  if (blob.length < 4 + m[1].length + 8 || blob.readUInt32BE(0) !== m[1].length || blob.subarray(4, 4 + m[1].length).toString("latin1") !== m[1]) return null;
  return { type: m[1], data: m[2], comment: m[3]?.trim() ?? "", blob };
}

/** A PuTTY file keeps its public half and comment in the clear, also when the key is encrypted. */
function puttyPublic(text: string): { type: string; data: string; comment: string; blob: Buffer } | null {
  const m = /^PuTTY-User-Key-File-\d+:\s*(\S+)/.exec(text);
  const lines = /^Public-Lines:\s*(\d+)\r?\n/m.exec(text);
  if (!m?.[1] || !lines?.[1]) return null;
  const data = text.slice(lines.index + lines[0].length).split(/\r?\n/).slice(0, Number(lines[1])).join("");
  return { type: m[1], data, comment: /^Comment:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? "", blob: Buffer.from(data, "base64") };
}

function keyNamesIn(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const file of entries) {
    if (file.startsWith(".") || RESERVED.has(file)) continue;
    const path = join(dir, file);
    if (file.endsWith(".pub")) {
      const stem = file.slice(0, -4);
      if (stem && !stem.startsWith(".") && publicLine(readSmall(path))) names.add(stem);
    } else if (!NOT_KEYS.test(file) && PRIVATE_FIRST_LINE.test(readSmall(path) ?? "")) {
      names.add(file);
    }
  }
  return [...names];
}

interface Located {
  name: string;
  dir: string;
  enabled: boolean;
  privatePath: string | null;
  publicPath: string | null;
}

function locateIn(dir: string, name: string, enabled: boolean): Located {
  const privatePath = join(dir, name);
  const publicPath = `${privatePath}.pub`;
  return {
    name,
    dir,
    enabled,
    privatePath: PRIVATE_FIRST_LINE.test(readSmall(privatePath) ?? "") ? privatePath : null,
    publicPath: existsSync(publicPath) ? publicPath : null,
  };
}

function locate(name: string): Located {
  const notFound = () => httpError(404, `There is no key named ${name}.`, "ssh_key_not_found");
  // Only names the scan itself finds: nothing from outside ~/.ssh can be reached through one.
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) throw notFound();
  const root = sshDir();
  const parked = join(root, DISABLED_DIR);
  if (keyNamesIn(root).includes(name)) return locateIn(root, name, true);
  if (keyNamesIn(parked).includes(name)) return locateIn(parked, name, false);
  throw notFound();
}

function keyBits(type: string, blob: Buffer): number | null {
  if (type === "ssh-ed25519" || type.startsWith("sk-ssh-ed25519")) return 256;
  if (type === "ssh-dss") return 1024;
  const curve = /nistp(\d+)/.exec(type);
  if (curve?.[1]) return Number(curve[1]);
  if (type !== "ssh-rsa") return null;
  try {
    let off = 0;
    const next = () => {
      const len = blob.readUInt32BE(off);
      off += 4;
      const part = blob.subarray(off, off + len);
      off += len;
      return part;
    };
    next();
    next();
    const n = next();
    const start = n[0] === 0 ? 1 : 0;
    const top = n[start] ?? 0;
    return (n.length - start - 1) * 8 + (top ? 32 - Math.clz32(top) : 0);
  } catch {
    return null;
  }
}

function algorithmOf(type: string): string {
  if (type === "ssh-ed25519") return "ed25519";
  if (type === "ssh-rsa") return "rsa";
  if (type === "ssh-dss") return "dsa";
  if (type.startsWith("ecdsa-")) return "ecdsa";
  if (type.startsWith("sk-ssh-ed25519")) return "ed25519-sk";
  if (type.startsWith("sk-ecdsa")) return "ecdsa-sk";
  return "unknown";
}

/** The picture `ssh-keygen -lv` draws of a key (the "drunken bishop"). */
export function randomart(blob: Buffer, algorithm: string, bits: number | null): string {
  const WIDTH = 17;
  const HEIGHT = 9;
  const SYMBOLS = " .o+=*BOX@%&#/^SE";
  const field = Array.from({ length: WIDTH }, () => new Array<number>(HEIGHT).fill(0));
  let x = WIDTH >> 1;
  let y = HEIGHT >> 1;
  for (const byte of createHash("sha256").update(blob).digest()) {
    let input = byte;
    for (let step = 0; step < 4; step++) {
      x = Math.min(Math.max(x + (input & 1 ? 1 : -1), 0), WIDTH - 1);
      y = Math.min(Math.max(y + (input & 2 ? 1 : -1), 0), HEIGHT - 1);
      const column = field[x]!;
      if (column[y]! < SYMBOLS.length - 3) column[y]!++;
      input >>= 2;
    }
  }
  field[WIDTH >> 1]![HEIGHT >> 1] = SYMBOLS.length - 2;
  field[x]![y] = SYMBOLS.length - 1;
  const framed = (label: string) => {
    const left = (WIDTH - label.length) >> 1;
    return `+${"-".repeat(left)}${label}${"-".repeat(WIDTH - left - label.length)}+`;
  };
  const rows: string[] = [framed(`[${algorithm.toUpperCase()}${bits ? ` ${bits}` : ""}]`.slice(0, WIDTH))];
  for (let row = 0; row < HEIGHT; row++) rows.push(`|${field.map((column) => SYMBOLS[column[row]!]).join("")}|`);
  rows.push(framed("[SHA256]"));
  return rows.join("\n");
}

function describe(at: Located, agentKeys: Set<string>, configs: string[], servers: { id: string; name: string; fingerprint: string }[]): SshManagedKey {
  const text = at.privatePath ? readSmall(at.privatePath) : null;
  const format = !text ? "none" : text.includes("BEGIN OPENSSH PRIVATE KEY") ? "openssh" : text.trimStart().startsWith("PuTTY") ? "putty" : "pem";
  let encrypted = false;
  let derived: { line: string; comment: string } | null = null;
  if (text) {
    try {
      const { info, key } = parsePrivateKey(text);
      derived = { line: info.publicKey, comment: key.comment };
    } catch (err) {
      if (err instanceof SshKeyError && err.code === "passphrase_required") encrypted = true;
    }
  }
  if (format === "putty") encrypted = !/^Encryption:\s*none\s*$/m.test(text ?? "");
  const pubFile = publicLine(at.publicPath ? readSmall(at.publicPath) : null);
  let pub = pubFile ?? publicLine(derived?.line ?? null) ?? (format === "putty" && text ? puttyPublic(text) : null);
  if (!pub && text) {
    const blob = openSshPublicBlob(text);
    const type = blob && blob.length >= 4 ? blob.subarray(4, 4 + blob.readUInt32BE(0)).toString("latin1") : "";
    if (blob && type) pub = { type, data: blob.toString("base64"), comment: "", blob };
  }
  const algorithm = pub ? algorithmOf(pub.type) : /BEGIN RSA/.test(text ?? "") ? "rsa" : /BEGIN EC /.test(text ?? "") ? "ecdsa" : /BEGIN DSA/.test(text ?? "") ? "dsa" : "unknown";
  const bits = pub ? keyBits(pub.type, pub.blob) : null;
  const fingerprint = pub ? fingerprintOf(pub.blob) : null;
  const comment = pubFile ? pubFile.comment : pub?.comment || derived?.comment || "";
  const file = at.privatePath ?? at.publicPath;
  const st = file ? statSync(file) : null;
  return {
    name: at.name,
    path: at.privatePath,
    algorithm,
    bits,
    fingerprint,
    randomart: pub ? randomart(pub.blob, algorithm, bits) : null,
    comment,
    publicKey: pub ? `${pub.type} ${pub.data}${comment ? ` ${comment}` : ""}` : null,
    encrypted,
    enabled: at.enabled,
    inAgent: !!fingerprint && agentKeys.has(fingerprint),
    hasPrivate: !!at.privatePath,
    format,
    looseMode: !!at.privatePath && (statSync(at.privatePath).mode & 0o077) !== 0,
    hosts: hostsAcross(configs, at.name),
    servers: fingerprint ? servers.filter((s) => s.fingerprint === fingerprint).map(({ id, name }) => ({ id, name })) : [],
    modifiedAt: st ? st.mtime.toISOString() : null,
  };
}

/* ------------------------------------------------------------------ */
/* ssh-agent                                                            */
/* ------------------------------------------------------------------ */

async function agentStatus(): Promise<{ available: boolean; keys: Set<string> }> {
  try {
    const { stdout } = await run("ssh-add", ["-l", "-E", "sha256"], { timeout: 5000 });
    const keys = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((part): part is string => !!part?.startsWith("SHA256:"));
    return { available: true, keys: new Set(keys) };
  } catch (err) {
    // 1 = the agent answered and holds no keys; anything else = no agent to talk to.
    return { available: (err as { code?: unknown }).code === 1, keys: new Set() };
  }
}

const configTexts = () => configFiles().map((f) => f.text);

function serverFingerprints(): { id: string; name: string; fingerprint: string }[] {
  if (!getSettings().ssh.enabled) return [];
  return listServers().flatMap((s) => (s.key ? [{ id: s.id, name: s.name, fingerprint: s.key.fingerprint }] : []));
}

export async function listSshKeys(): Promise<SshKeysOverview> {
  const dir = sshDir();
  const agent = await agentStatus();
  const configs = configTexts();
  const servers = serverFingerprints();
  const seen = new Set<string>();
  const keys: SshManagedKey[] = [];
  for (const [folder, enabled] of [[dir, true], [join(dir, DISABLED_DIR), false]] as const) {
    for (const name of keyNamesIn(folder)) {
      if (seen.has(name)) continue;
      seen.add(name);
      keys.push(describe(locateIn(folder, name, enabled), agent.keys, configs, servers));
    }
  }
  keys.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { dir, agent: { available: agent.available, loaded: agent.keys.size }, keys };
}

async function describeOne(name: string): Promise<SshManagedKey> {
  const agent = await agentStatus();
  return describe(locate(name), agent.keys, configTexts(), serverFingerprints());
}

/* ------------------------------------------------------------------ */
/* Writing                                                              */
/* ------------------------------------------------------------------ */

function ensurePrivateDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** A new file with exactly these permissions from the start; an existing one is never overwritten. */
function writeNew(path: string, data: Buffer, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

function validateNewName(name: string): void {
  const refuse = (why: string) => httpError(422, why, "ssh_key_bad_name");
  if (!name) throw refuse("Give the key a name.");
  if (name.length > 100) throw refuse("That name is too long.");
  if (!/^[A-Za-z0-9._@+-]+$/.test(name) || /^[.-]/.test(name)) throw refuse("A key name can use letters, digits and . _ @ + - and can't start with . or -.");
  if (/\.pub$/i.test(name)) throw refuse("A key name can't end in .pub.");
  if (RESERVED.has(name.toLowerCase()) || NOT_KEYS.test(name)) throw refuse(`A key can't be called ${name}: ssh or Godmode would take it for something else.`);
}

function ensureNameFree(name: string): void {
  validateNewName(name);
  const root = sshDir();
  for (const dir of [root, join(root, DISABLED_DIR)]) {
    for (const candidate of [join(dir, name), join(dir, `${name}.pub`)]) {
      if (existsOrLink(candidate)) throw httpError(409, `There already is a key named ${name}.`, "ssh_key_exists");
    }
  }
}

function existsOrLink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function cleanComment(comment: string): string {
  const clean = comment.trim();
  if (/[\r\n]/.test(clean)) throw httpError(422, "A key comment has to be one line.", "ssh_key_bad_comment");
  return clean;
}

function install(name: string, privateText: string | null, publicText: string | null): void {
  const dir = sshDir();
  ensurePrivateDir(dir);
  const privatePath = join(dir, name);
  if (privateText !== null) writeNew(privatePath, Buffer.from(privateText.endsWith("\n") ? privateText : `${privateText}\n`), 0o600);
  if (publicText === null) return;
  try {
    writeNew(`${privatePath}.pub`, Buffer.from(`${publicText.trim()}\n`), 0o644);
  } catch (err) {
    if (privateText !== null) rmSync(privatePath, { force: true });
    throw err;
  }
}

export async function generateSshKey(input: SshKeyGenerateInput, actor = "user"): Promise<SshManagedKey> {
  ensureNameFree(input.name);
  const algorithm = input.algorithm ?? "ed25519";
  const comment = cleanComment(input.comment ?? "") || `${userInfo().username}@${hostname().replace(/\.local$/, "")}`;
  const lock = input.passphrase ? { passphrase: input.passphrase, cipher: "aes256-ctr", rounds: 16 } : {};
  let pair: utils.KeyPairReturn;
  if (algorithm === "ed25519") {
    pair = generateEd25519({ comment, ...lock });
  } else if (algorithm === "rsa") {
    const bits = input.bits ?? 4096;
    if (![2048, 3072, 4096].includes(bits)) throw httpError(422, "RSA keys can have 2048, 3072 or 4096 bits.", "ssh_key_bad_bits");
    pair = await new Promise((resolve, reject) => {
      utils.generateKeyPair("rsa", { bits, comment, ...lock }, (err, out) => (err ? reject(err) : resolve(out)));
    });
  } else {
    const bits = input.bits ?? 256;
    if (bits !== 256 && bits !== 384 && bits !== 521) throw httpError(422, "ECDSA keys can have 256, 384 or 521 bits.", "ssh_key_bad_bits");
    pair = utils.generateKeyPairSync("ecdsa", { bits, comment, ...lock });
  }
  install(input.name, pair.private, pair.public);
  audit(actor, "ssh_key.generate", input.name, { algorithm });
  bus.changed("ssh-keys");
  return describeOne(input.name);
}

/** A private key, or a public key line for a key that lives elsewhere. PuTTY keys are refused: ssh can't read them. */
export async function importSshKey(input: SshKeyImportInput): Promise<SshManagedKey> {
  ensureNameFree(input.name);
  const text = input.key.trim();
  const pub = publicLine(text);
  if (pub) {
    install(input.name, null, text.split(/\r?\n/)[0] ?? "");
  } else {
    if (text.startsWith("PuTTY-User-Key-File")) throw httpError(422, "ssh can't use PuTTY keys. Export it as an OpenSSH key in PuTTYgen first.", "ssh_key_putty");
    if (!PRIVATE_FIRST_LINE.test(text)) throw httpError(422, "This doesn't look like an SSH key.", "ssh_key_invalid");
    let publicText: string | null = null;
    try {
      publicText = parsePrivateKey(text).info.publicKey;
    } catch (err) {
      if (!(err instanceof SshKeyError) || err.code !== "passphrase_required") {
        // An unusual key type ssh2 can't read still works with ssh.
        const blob = openSshPublicBlob(text);
        if (!blob) throw httpError(422, err instanceof Error ? err.message : "This doesn't look like an SSH key.", "ssh_key_invalid");
      }
    }
    install(input.name, text.replace(/\r\n?/g, "\n"), publicText);
  }
  audit("user", "ssh_key.import", input.name, { publicOnly: !!pub });
  bus.changed("ssh-keys");
  return describeOne(input.name);
}

function moveAll(moves: [string, string][]): void {
  for (const [, to] of moves) if (existsOrLink(to)) throw httpError(409, `${to} already exists.`, "ssh_key_exists");
  moves.forEach(([from, to], i) => {
    try {
      renameSync(from, to);
    } catch (err) {
      for (const [undoFrom, undoTo] of moves.slice(0, i).reverse()) renameSync(undoTo, undoFrom);
      throw err;
    }
  });
}

const filesOf = (at: Located) => [at.privatePath, at.publicPath].filter((p): p is string => !!p);

async function unloadQuietly(at: Located): Promise<void> {
  try {
    const key = describe(at, (await agentStatus()).keys, [], []);
    if (key.inAgent && key.publicKey) await removeFromAgent(key.publicKey);
  } catch {
    /* the key stays loaded until the agent restarts */
  }
}

async function setEnabled(name: string, enabled: boolean): Promise<void> {
  const at = locate(name);
  if (at.enabled === enabled) return;
  if (filesOf(at).some((file) => lstatSync(file).isSymbolicLink())) throw httpError(409, "This key is a link to a file elsewhere, so it can't be parked here.", "ssh_key_link");
  const root = sshDir();
  const target = enabled ? root : join(root, DISABLED_DIR);
  if (!enabled) {
    await unloadQuietly(at);
    ensurePrivateDir(target);
  }
  moveAll(filesOf(at).map((from) => [from, join(target, from.slice(at.dir.length + 1))]));
}

function setComment(name: string, comment: string): void {
  const at = locate(name);
  const clean = cleanComment(comment);
  const current = describe(at, new Set(), [], []);
  if (!current.publicKey) throw httpError(409, "This key's public half can't be read, so it has no comment to change.", "ssh_key_no_public");
  const [type, data] = current.publicKey.split(/\s+/);
  const path = at.publicPath ?? `${join(at.dir, name)}.pub`;
  const temp = `${path}.godmode-${randomBytes(4).toString("hex")}`;
  writeNew(temp, Buffer.from(`${type} ${data}${clean ? ` ${clean}` : ""}\n`), 0o644);
  renameSync(temp, path);
}

function rename(name: string, next: string): string[] {
  const at = locate(name);
  ensureNameFree(next);
  const moves: [string, string][] = [];
  if (at.privatePath) moves.push([at.privatePath, join(at.dir, next)]);
  if (at.publicPath) moves.push([at.publicPath, join(at.dir, `${next}.pub`)]);
  const dir = sshDir();
  const files = configFiles();
  const hosts = hostsAcross(files.map((f) => f.text), name);
  const edits = files.flatMap((file) => {
    const rewritten = renameIdentity(file.text, homeDir(), dir, name, next);
    return rewritten === null ? [] : [{ ...file, rewritten }];
  });
  moveAll(moves);
  const done: typeof edits = [];
  try {
    for (const edit of edits) {
      replaceConfig(edit.path, edit.rewritten);
      done.push(edit);
    }
  } catch (err) {
    // Half a rename is worse than none: ssh would quietly stop finding the key.
    for (const edit of done) replaceConfig(edit.path, edit.text);
    for (const [from, to] of [...moves].reverse()) renameSync(to, from);
    throw err;
  }
  return edits.length ? hosts : [];
}

export async function updateSshKey(name: string, patch: SshKeyPatch, actor = "user"): Promise<SshKeyChange> {
  locate(name);
  if (patch.comment !== undefined) cleanComment(patch.comment);
  if (patch.name !== undefined && patch.name !== name) ensureNameFree(patch.name);
  let current = name;
  let configHosts: string[] = [];
  if (patch.comment !== undefined) setComment(current, patch.comment);
  if (patch.enabled !== undefined) await setEnabled(current, patch.enabled);
  if (patch.fixPermissions) {
    const at = locate(current);
    if (at.privatePath) chmodSync(at.privatePath, 0o600);
  }
  if (patch.name !== undefined && patch.name !== current) {
    configHosts = rename(current, patch.name);
    current = patch.name;
  }
  audit(actor, "ssh_key.update", name, { ...patch });
  bus.changed("ssh-keys");
  return { key: await describeOne(current), configHosts };
}

/** The real Trash when the system has a command for it; otherwise (and for a borrowed HOME) a private folder next to the keys. */
async function moveToTrash(files: string[]): Promise<void> {
  if (process.env.HOME === userInfo().homedir && existsSync("/usr/bin/trash")) {
    try {
      await run("/usr/bin/trash", files, { timeout: 15_000 });
      return;
    } catch {
      /* falls through to the folder */
    }
  }
  const folder = join(sshDir(), TRASH_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  moveAll(files.map((from) => [from, join(folder, from.slice(from.lastIndexOf("/") + 1))]));
}

export async function deleteSshKey(name: string, actor = "user"): Promise<void> {
  const at = locate(name);
  await unloadQuietly(at);
  await moveToTrash(filesOf(at));
  audit(actor, "ssh_key.delete", name);
  bus.changed("ssh-keys");
}

/* ------------------------------------------------------------------ */
/* Loading into ssh-agent                                               */
/* ------------------------------------------------------------------ */

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "godmode-ssh-"));
  chmodSync(dir, 0o700);
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function removeFromAgent(publicKey: string): Promise<void> {
  await withTempDir(async (dir) => {
    const path = join(dir, "key.pub");
    writeFileSync(path, `${publicKey}\n`, { mode: 0o600 });
    await run("ssh-add", ["-d", path], { timeout: 5000 });
  });
}

/**
 * ssh-add asks a helper for the passphrase. The helper hands it out once and removes it, so a wrong one makes ssh-add
 * give up instead of asking again; it never sits in an environment or on a command line.
 */
async function addToAgent(path: string, encrypted: boolean, passphrase: string | undefined): Promise<void> {
  await withTempDir(async (dir) => {
    const secret = join(dir, "once");
    const helper = join(dir, "askpass");
    writeFileSync(helper, `#!/bin/sh\n[ -f '${secret}' ] || exit 1\ncat '${secret}'\nrm -f '${secret}'\necho\n`, { mode: 0o700 });
    if (passphrase) writeFileSync(secret, passphrase, { mode: 0o600 });
    try {
      await run("ssh-add", [path], {
        timeout: 20_000,
        env: { ...process.env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || ":0" },
      });
    } catch (err) {
      if (!encrypted) {
        const said = String((err as { stderr?: unknown }).stderr ?? "").split("\n").map((l) => l.replace(/@+/g, "").trim()).find(Boolean);
        throw httpError(422, said || "ssh-add refused this key.", "ssh_key_refused");
      }
      if (!passphrase) throw httpError(409, "This key needs its passphrase.", "ssh_key_passphrase_required");
      throw httpError(422, "That passphrase doesn't unlock this key.", "ssh_key_bad_passphrase");
    }
  });
}

export async function setSshKeyLoaded(name: string, loaded: boolean, passphrase?: string, actor = "user"): Promise<SshManagedKey> {
  const at = locate(name);
  const key = await describeOne(name);
  if (loaded) {
    if (!at.enabled) throw httpError(409, "Turn this key on first.", "ssh_key_disabled");
    if (!at.privatePath) throw httpError(409, "Only the public half of this key is here.", "ssh_key_no_private");
    if (key.format === "putty") throw httpError(409, "ssh-agent can't use PuTTY keys.", "ssh_key_putty");
    if (key.looseMode) throw httpError(409, "ssh refuses this key because others can read it. Fix its permissions first.", "ssh_key_loose");
    if (!(await agentStatus()).available) throw httpError(409, "ssh-agent isn't running on this computer.", "ssh_agent_unavailable");
    await addToAgent(at.privatePath, key.encrypted, passphrase);
  } else if (key.inAgent && key.publicKey) {
    await removeFromAgent(key.publicKey);
  }
  audit(actor, loaded ? "ssh_key.agent_load" : "ssh_key.agent_unload", name);
  bus.changed("ssh-keys");
  return describeOne(name);
}

/* ------------------------------------------------------------------ */
/* Saved SSH servers                                                    */
/* ------------------------------------------------------------------ */

/** Adds the public key to the server's authorized_keys, once. */
export async function installSshKeyOnServer(name: string, serverId: string, actor = "user"): Promise<SshKeyInstallResult> {
  if (!getSettings().ssh.enabled) throw httpError(403, "SSH servers are turned off in Settings.", "ssh_off");
  const { publicKey } = await describeOne(name);
  const server = getServer(serverId);
  if (!publicKey) throw httpError(409, "This key's public half can't be read.", "ssh_key_no_public");
  const blob = publicKey.split(/\s+/)[1] ?? "";
  const file = "~/.ssh/authorized_keys";
  const present = `awk -v k=${shellQuote(blob)} '!/^[[:space:]]*#/ { for (i = 1; i <= NF; i++) if ($i == k) found = 1 } END { exit !found }' ${file}`;
  const command = [
    "umask 077",
    "mkdir -p ~/.ssh",
    `touch ${file}`,
    `chmod 700 ~/.ssh`,
    `chmod 600 ${file}`,
    `if ${present}; then echo present; else { [ -z "$(tail -c1 ${file})" ] || echo >> ${file}; } && printf '%s\\n' ${shellQuote(publicKey)} >> ${file} && echo added; fi`,
  ].join(" && ");
  const result = await execForHuman(serverId, { command, timeoutSeconds: 30 });
  if (result.exitCode !== 0) throw httpError(502, result.stderr.trim() || `${server.name} refused the key.`, "ssh_key_install_failed");
  audit(actor, "ssh_key.install", name, { server: server.name });
  return { server: server.name, alreadyThere: result.stdout.includes("present") };
}

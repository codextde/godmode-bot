import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { startSshServer, type TestSshServer } from "./fixtures/ssh-server";
import type { Agent, SshKeysOverview, SshManagedKey, SshServer } from "@godmode/shared";
import { insert } from "../src/db";
import { getAccessToken } from "../src/server/auth";
import { DEFAULT_SETTINGS, updateSettings } from "../src/services/settings";
import { callTool, listToolsFor } from "../src/mcp/tools";
import { closeAllConnections } from "../src/ssh/client";
import { hostsUsing, renameIdentity } from "../src/ssh/keyManager";
import { assignServer, createServer } from "../src/ssh/service";
import { listAudit } from "../src/services/audit";
import * as vault from "../src/vault/vault";
import { newId, now } from "../src/util";

let env: TestEnv;
let home: string;
let ssh: string;
let realHome: string | undefined;
let agentSock: string | undefined;
let agentPid: string | undefined;

const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> => {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
};
const overview = async () => (await api<SshKeysOverview>("GET", "/api/ssh/key-manager")).data;
const keyOf = async (name: string) => (await overview()).keys.find((k) => k.name === name);
const keygen = (path: string, ...args: string[]) => execFileSync("ssh-keygen", ["-q", "-f", path, ...args], { stdio: "pipe" });

beforeAll(async () => {
  env = await setupEnv("godmode-ssh-keys-");
  updateSettings({ sshKeys: { enabled: true } });
  realHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "gm-keys-home-")));
  ssh = join(home, ".ssh");
  process.env.HOME = home;
  const started = execFileSync("ssh-agent", ["-s", "-a", join(home, "agent.sock")]).toString();
  agentSock = /SSH_AUTH_SOCK=([^;]+)/.exec(started)?.[1];
  agentPid = /SSH_AGENT_PID=(\d+)/.exec(started)?.[1];
  process.env.SSH_AUTH_SOCK = agentSock;
});

afterAll(async () => {
  if (agentPid) process.kill(Number(agentPid));
  closeAllConnections();
  await env.close();
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(ssh, { recursive: true, force: true });
  mkdirSync(ssh, { mode: 0o700 });
  spawnSync("ssh-add", ["-D"], { stdio: "pipe" });
});

describe("what is listed", () => {
  test("the module starts off", () => {
    expect(DEFAULT_SETTINGS.sshKeys.enabled).toBe(false);
  });

  test("keys with their facts match ssh-keygen; files that aren't keys stay out", async () => {
    keygen(join(ssh, "id_ed25519"), "-t", "ed25519", "-N", "", "-C", "me@mac");
    keygen(join(ssh, "work_rsa"), "-t", "rsa", "-b", "3072", "-N", "secret-phrase", "-C", "me@work");
    rmSync(join(ssh, "work_rsa.pub"));
    keygen(join(ssh, "legacy"), "-t", "ecdsa", "-b", "384", "-N", "", "-m", "PEM");
    writeFileSync(join(ssh, "config"), "Host github.com gh\n  IdentityFile ~/.ssh/id_ed25519\n");
    writeFileSync(join(ssh, "known_hosts"), "x\n");
    writeFileSync(join(ssh, "notes.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    writeFileSync(join(ssh, "Archive.zip"), "PK");
    mkdirSync(join(ssh, "agent"));

    const { keys, agent, dir } = await overview();
    expect(dir).toBe(ssh);
    expect(agent).toEqual({ available: true, loaded: 0 });
    expect(keys.map((k) => k.name)).toEqual(["id_ed25519", "legacy", "work_rsa"]);

    const ed = keys[0]!;
    const printed = execFileSync("ssh-keygen", ["-lv", "-f", join(ssh, "id_ed25519.pub")]).toString().split("\n");
    expect(ed.fingerprint).toBe(printed[0]!.split(" ")[1]!);
    expect(ed.randomart).toBe(printed.slice(1).join("\n").trim());
    expect(ed).toMatchObject({ algorithm: "ed25519", bits: 256, comment: "me@mac", encrypted: false, enabled: true, format: "openssh", hosts: ["github.com", "gh"], hasPrivate: true, looseMode: false });
    expect(ed.publicKey).toBe(readFileSync(join(ssh, "id_ed25519.pub"), "utf8").trim());

    // Encrypted and without a .pub: the public half still comes from the file.
    const rsa = keys[2]!;
    expect(rsa).toMatchObject({ algorithm: "rsa", bits: 3072, encrypted: true });
    expect(rsa.fingerprint).toStartWith("SHA256:");
    expect(rsa.publicKey).toStartWith("ssh-rsa AAAA");

    expect(keys[1]).toMatchObject({ algorithm: "ecdsa", bits: 384, format: "pem" });
    expect(JSON.stringify(keys)).not.toContain("PRIVATE KEY");
  });

  test("a PuTTY file shows its public half, also when encrypted", async () => {
    keygen(join(ssh, "real"), "-t", "ed25519", "-N", "", "-C", "x");
    const [, data] = readFileSync(join(ssh, "real.pub"), "utf8").split(" ");
    const lines = data!.match(/.{1,64}/g)!;
    writeFileSync(join(ssh, "putty.ppk"), `PuTTY-User-Key-File-2: ssh-ed25519\nEncryption: aes256-cbc\nComment: from-putty\nPublic-Lines: ${lines.length}\n${lines.join("\n")}\nPrivate-Lines: 1\nAAAA\nPrivate-MAC: 00\n`, { mode: 0o600 });
    const key = await keyOf("putty.ppk");
    expect(key).toMatchObject({ format: "putty", algorithm: "ed25519", comment: "from-putty", encrypted: true });
    expect(key?.publicKey).toBe(`ssh-ed25519 ${data} from-putty`);
  });

  test("a loose private key is flagged and one switch fixes it", async () => {
    keygen(join(ssh, "open"), "-t", "ed25519", "-N", "");
    chmodSync(join(ssh, "open"), 0o644);
    expect((await keyOf("open"))?.looseMode).toBe(true);
    await api("PATCH", "/api/ssh/key-manager/open", { fixPermissions: true });
    expect(statSync(join(ssh, "open")).mode & 0o777).toBe(0o600);
    expect((await keyOf("open"))?.looseMode).toBe(false);
  });
});

describe("generate", () => {
  test.each([
    ["ed25519", undefined, "ED25519", 256],
    ["rsa", 2048, "RSA", 2048],
    ["ecdsa", 384, "ECDSA", 384],
  ] as const)("%s works with ssh-keygen, also with a passphrase", async (algorithm, bits, label, size) => {
    const made = await api<SshManagedKey>("POST", "/api/ssh/key-manager", { name: "fresh", algorithm, bits, comment: "c@d", passphrase: "open sesame" });
    expect(made.status).toBe(201);
    expect(made.data).toMatchObject({ name: "fresh", bits: size, encrypted: true, comment: "c@d" });
    const path = join(ssh, "fresh");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.pub`).mode & 0o777).toBe(0o644);
    expect(execFileSync("ssh-keygen", ["-lf", path]).toString()).toContain(`(${label})`);
    expect(execFileSync("ssh-keygen", ["-y", "-P", "open sesame", "-f", path]).toString().trim().split(" ")[1]).toBe(made.data.publicKey!.split(" ")[1]!);
    expect(spawnSync("ssh-keygen", ["-y", "-P", "wrong", "-f", path]).status).not.toBe(0);
  });

  test("never overwrites, and refuses names that leave the folder", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "taken" });
    const before = readFileSync(join(ssh, "taken"), "utf8");
    expect((await api("POST", "/api/ssh/key-manager", { name: "taken" })).status).toBe(409);
    expect(readFileSync(join(ssh, "taken"), "utf8")).toBe(before);
    for (const name of ["../evil", "a/b", ".hidden", "-oProxy", "config", "known_hosts", "x.pub"]) {
      expect((await api("POST", "/api/ssh/key-manager", { name })).status).toBe(422);
    }
    expect(existsSync(join(home, "evil"))).toBe(false);
    expect((await api("PATCH", "/api/ssh/key-manager/..%2Fetc", { comment: "x" })).status).toBe(404);
  });
});

describe("import", () => {
  test("a private key, with or without a passphrase, and a public key alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-keys-src-"));
    keygen(join(dir, "plain"), "-t", "ed25519", "-N", "", "-C", "src@x");
    keygen(join(dir, "locked"), "-t", "ed25519", "-N", "pp", "-C", "src@y");
    const plain = await api<SshManagedKey>("POST", "/api/ssh/key-manager/import", { name: "plain", key: readFileSync(join(dir, "plain"), "utf8") });
    expect(plain.data).toMatchObject({ comment: "src@x", encrypted: false });
    expect(plain.data.fingerprint).toBe(execFileSync("ssh-keygen", ["-lf", join(dir, "plain.pub")]).toString().split(" ")[1]!);
    expect(statSync(join(ssh, "plain")).mode & 0o777).toBe(0o600);
    const locked = await api<SshManagedKey>("POST", "/api/ssh/key-manager/import", { name: "locked", key: readFileSync(join(dir, "locked"), "utf8") });
    expect(locked.data.encrypted).toBe(true);
    expect(locked.data.fingerprint).toBe(execFileSync("ssh-keygen", ["-lf", join(dir, "locked.pub")]).toString().split(" ")[1]!);
    const pub = await api<SshManagedKey>("POST", "/api/ssh/key-manager/import", { name: "colleague", key: readFileSync(join(dir, "plain.pub"), "utf8") });
    expect(pub.data).toMatchObject({ hasPrivate: false, format: "none", path: null });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a name ssh or the list would ignore is refused up front", async () => {
    for (const name of ["work.old", "work.bak", "notes.txt"]) {
      expect((await api("POST", "/api/ssh/key-manager", { name })).status).toBe(422);
    }
  });

  test("a public key has to be a real one", async () => {
    expect((await api("POST", "/api/ssh/key-manager/import", { name: "x", key: "ssh-ed25519 AAAA" })).status).toBe(422);
    expect(existsSync(join(ssh, "x.pub"))).toBe(false);
  });

  test("Windows line endings are cleaned up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-keys-src-"));
    keygen(join(dir, "k"), "-t", "ed25519", "-N", "");
    await api("POST", "/api/ssh/key-manager/import", { name: "win", key: readFileSync(join(dir, "k"), "utf8").replace(/\n/g, "\r\n") });
    expect(readFileSync(join(ssh, "win"), "utf8")).not.toContain("\r");
    expect(execFileSync("ssh-keygen", ["-lf", join(ssh, "win")]).toString()).toContain("ED25519");
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses what isn't an OpenSSH or PEM key", async () => {
    expect((await api("POST", "/api/ssh/key-manager/import", { name: "x", key: "hello" })).status).toBe(422);
    expect((await api<{ error: string }>("POST", "/api/ssh/key-manager/import", { name: "x", key: "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n" })).status).toBe(422);
    expect(existsSync(join(ssh, "x"))).toBe(false);
  });
});

describe("rename", () => {
  const config = 'Host a\n  IdentityFile ~/.ssh/old\n\nHost b\r\n  IdentityFile "%d/.ssh/old" # note\r\nHost c\n  IdentityFile ~/.ssh/old2\n';

  test("the config parser keeps the human's notation", () => {
    const dir = "/h/.ssh";
    expect(hostsUsing(config, "/h", dir, "/h/.ssh/old")).toEqual(["a", "b"]);
    expect(renameIdentity(config, "/h", dir, "old", "new")).toBe('Host a\n  IdentityFile ~/.ssh/new\n\nHost b\r\n  IdentityFile "%d/.ssh/new" # note\r\nHost c\n  IdentityFile ~/.ssh/old2\n');
    expect(renameIdentity(config, "/h", dir, "nope", "new")).toBeNull();
  });

  test("moves both files, follows into the config and keeps a backup", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "old" });
    writeFileSync(join(ssh, "config"), config, { mode: 0o600 });
    const { data } = await api<{ key: SshManagedKey; configHosts: string[] }>("PATCH", "/api/ssh/key-manager/old", { name: "new" });
    expect(data.key.name).toBe("new");
    expect(data.configHosts).toEqual(["a", "b"]);
    expect(existsSync(join(ssh, "old"))).toBe(false);
    expect(existsSync(join(ssh, "new.pub"))).toBe(true);
    expect(readFileSync(join(ssh, "config"), "utf8")).toContain("~/.ssh/new\n");
    const backup = readdirSync(ssh).find((f) => f.startsWith("config.godmode-"));
    expect(readFileSync(join(ssh, backup!), "utf8")).toBe(config);
    expect(data.key.hosts).toEqual(["a", "b"]);
  });

  test("a symlinked config stays a symlink", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "old" });
    const real = join(home, "dotfiles-config");
    writeFileSync(real, "Host a\n  IdentityFile ~/.ssh/old\n");
    symlinkSync(real, join(ssh, "config"));
    await api("PATCH", "/api/ssh/key-manager/old", { name: "new" });
    expect(readFileSync(real, "utf8")).toContain("~/.ssh/new");
    expect(realpathSync(join(ssh, "config"))).toBe(real);
    rmSync(real);
  });

  test("hosts in an included config count, and follow a rename", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "old" });
    mkdirSync(join(ssh, "config.d"));
    writeFileSync(join(ssh, "config"), "Include config.d/*\nHost main\n  User me\n");
    writeFileSync(join(ssh, "config.d", "work"), "Host deep\n  IdentityFile ~/.ssh/old\n");
    expect((await keyOf("old"))?.hosts).toEqual(["deep"]);
    const { data } = await api<{ key: SshManagedKey; configHosts: string[] }>("PATCH", "/api/ssh/key-manager/old", { name: "new" });
    expect(data.configHosts).toEqual(["deep"]);
    expect(readFileSync(join(ssh, "config.d", "work"), "utf8")).toContain("~/.ssh/new");
    expect(readFileSync(join(ssh, "config"), "utf8")).toStartWith("Include config.d/*");
    expect(readdirSync(join(ssh, "config.d")).some((f) => f.endsWith(".bak"))).toBe(true);
    expect((await keyOf("new"))?.hosts).toEqual(["deep"]);
  });

  test("an edit that can't finish changes nothing", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "one", comment: "first" });
    expect((await api("PATCH", "/api/ssh/key-manager/one", { comment: "second", name: "config" })).status).toBe(422);
    expect((await keyOf("one"))?.comment).toBe("first");
  });

  test("a taken name changes nothing", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "one" });
    await api("POST", "/api/ssh/key-manager", { name: "two" });
    expect((await api("PATCH", "/api/ssh/key-manager/one", { name: "two" })).status).toBe(409);
    expect(existsSync(join(ssh, "one"))).toBe(true);
  });
});

describe("on and off, comment, delete", () => {
  test("off parks the key in ~/.ssh/disabled and takes it out of the agent", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "k" });
    await api("POST", "/api/ssh/key-manager/k/agent", { loaded: true });
    expect((await keyOf("k"))?.inAgent).toBe(true);
    const off = await api<{ key: SshManagedKey }>("PATCH", "/api/ssh/key-manager/k", { enabled: false });
    expect(off.data.key).toMatchObject({ enabled: false, inAgent: false });
    expect(existsSync(join(ssh, "k"))).toBe(false);
    expect(existsSync(join(ssh, "disabled", "k.pub"))).toBe(true);
    expect(statSync(join(ssh, "disabled")).mode & 0o777).toBe(0o700);
    expect((await api("POST", "/api/ssh/key-manager/k/agent", { loaded: true })).status).toBe(409);
    await api("PATCH", "/api/ssh/key-manager/k", { enabled: true });
    expect(existsSync(join(ssh, "k"))).toBe(true);
  });

  test("a key that is a link stays where it is", async () => {
    const elsewhere = join(home, "dot");
    mkdirSync(elsewhere, { recursive: true });
    keygen(join(elsewhere, "lnk"), "-t", "ed25519", "-N", "");
    symlinkSync("../dot/lnk", join(ssh, "lnk"));
    expect((await api("PATCH", "/api/ssh/key-manager/lnk", { enabled: false })).status).toBe(409);
    expect((await keyOf("lnk"))?.enabled).toBe(true);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("a cleared comment stays cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-keys-src-"));
    keygen(join(dir, "k"), "-t", "ed25519", "-N", "", "-C", "inside-private");
    await api("POST", "/api/ssh/key-manager/import", { name: "k", key: readFileSync(join(dir, "k"), "utf8") });
    const { data } = await api<{ key: SshManagedKey }>("PATCH", "/api/ssh/key-manager/k", { comment: "" });
    expect(data.key.comment).toBe("");
    expect(data.key.publicKey).not.toContain("inside-private");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the comment changes in the .pub file only", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "k", comment: "first" });
    const before = readFileSync(join(ssh, "k"));
    const { data } = await api<{ key: SshManagedKey }>("PATCH", "/api/ssh/key-manager/k", { comment: "second" });
    expect(data.key.comment).toBe("second");
    expect(readFileSync(join(ssh, "k.pub"), "utf8")).toEndWith(" second\n");
    expect(readFileSync(join(ssh, "k")).equals(before)).toBe(true);
    expect((await api("PATCH", "/api/ssh/key-manager/k", { comment: "two\nlines" })).status).toBe(422);
  });

  test("delete leaves ~/.ssh and the agent, and the key can be found again", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "k" });
    await api("POST", "/api/ssh/key-manager/k/agent", { loaded: true });
    expect((await api("DELETE", "/api/ssh/key-manager/k")).status).toBe(200);
    expect(existsSync(join(ssh, "k"))).toBe(false);
    expect((await overview()).agent.loaded).toBe(0);
    const trash = join(ssh, "trash");
    expect(readdirSync(join(trash, readdirSync(trash)[0]!)).sort()).toEqual(["k", "k.pub"]);
    expect((await overview()).keys).toEqual([]);
    expect((await api("DELETE", "/api/ssh/key-manager/k")).status).toBe(404);
  });
});

describe("ssh-agent", () => {
  test("a passphrase is asked for, a wrong one is refused, the right one loads it", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "locked", passphrase: "right one" });
    const asked = await api<{ code: string }>("POST", "/api/ssh/key-manager/locked/agent", { loaded: true });
    expect(asked.status).toBe(409);
    expect(JSON.stringify(asked.data)).toContain("ssh_key_passphrase_required");
    const wrong = await api("POST", "/api/ssh/key-manager/locked/agent", { loaded: true, passphrase: "nope" });
    expect(wrong.status).toBe(422);
    expect(JSON.stringify(wrong.data)).toContain("ssh_key_bad_passphrase");
    const right = await api<SshManagedKey>("POST", "/api/ssh/key-manager/locked/agent", { loaded: true, passphrase: "right one" });
    expect(right.data.inAgent).toBe(true);
    expect((await overview()).agent.loaded).toBe(1);
    const out = await api<SshManagedKey>("POST", "/api/ssh/key-manager/locked/agent", { loaded: false });
    expect(out.data.inAgent).toBe(false);
  });

  test("no agent running is said plainly", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "k" });
    process.env.SSH_AUTH_SOCK = join(home, "gone.sock");
    expect((await overview()).agent.available).toBe(false);
    const res = await api("POST", "/api/ssh/key-manager/k/agent", { loaded: true });
    process.env.SSH_AUTH_SOCK = agentSock;
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.data)).toContain("ssh_agent_unavailable");
  });
});

describe("saved servers", () => {
  let sshd: TestSshServer;
  let server: SshServer;

  beforeAll(async () => {
    updateSettings({ ssh: { enabled: true } });
    await vault.setup("correct horse battery staple", false);
    sshd = await startSshServer({ password: "hunter2-login" });
    server = createServer({ name: "web", host: "127.0.0.1", port: sshd.port, username: sshd.username, auth: "password", password: "hunter2-login" });
  });

  afterAll(async () => {
    await sshd.close();
  });

  test("the public key lands in authorized_keys once, without gluing onto a line", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "k", comment: "it's me" });
    mkdirSync(join(sshd.home, ".ssh"), { recursive: true });
    const file = join(sshd.home, ".ssh", "authorized_keys");
    writeFileSync(file, "ssh-ed25519 AAAAexisting no-newline");
    expect((await api("POST", "/api/ssh/key-manager/k/install", { serverId: server.id })).data).toEqual({ server: "web", alreadyThere: false });
    expect((await api("POST", "/api/ssh/key-manager/k/install", { serverId: server.id })).data).toEqual({ server: "web", alreadyThere: true });
    const pub = (await keyOf("k"))!.publicKey!;
    expect(readFileSync(file, "utf8")).toBe(`ssh-ed25519 AAAAexisting no-newline\n${pub}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a commented-out key doesn't count as there, and a failed write isn't reported as added", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "revoked" });
    const pub = (await keyOf("revoked"))!.publicKey!;
    const file = join(sshd.home, ".ssh", "authorized_keys");
    writeFileSync(file, `# ${pub}\n`);
    expect((await api("POST", "/api/ssh/key-manager/revoked/install", { serverId: server.id })).data).toEqual({ server: "web", alreadyThere: false });
    expect(readFileSync(file, "utf8")).toBe(`# ${pub}\n${pub}\n`);
    rmSync(file);
    mkdirSync(file);
    const refused = await api("POST", "/api/ssh/key-manager/revoked/install", { serverId: server.id });
    rmSync(file, { recursive: true });
    expect(refused.status).toBe(502);
  });

  test("an agent only reaches servers of its own run", async () => {
    await api("POST", "/api/ssh/key-manager", { name: "agentkey" });
    const agent = await makeAgent({ name: "Installer" });
    const conversationId = newId("cnv");
    insert("conversations", { id: conversationId, agent_id: agent.id, title: "x", origin: "chat", created_at: now(), updated_at: now() });
    const runId = newId("run");
    insert("runs", { id: runId, agent_id: agent.id, conversation_id: conversationId, trigger: "chat", status: "running", prompt: "x", created_at: now() });
    const ctx = { runId, agentId: agent.id, conversationId, workspaceId: null, depth: 0 };
    const file = join(sshd.home, ".ssh", "authorized_keys");
    writeFileSync(file, "");
    const refused = await callTool(ctx, "ssh_key_install_on_server", { name: "agentkey", server: server.id });
    expect(refused.isError).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("");
    const listed = await callTool(ctx, "ssh_keys_list", {});
    expect(listed.content[0]?.text).not.toContain(server.id);
    await assignServer(server.id, { kind: "agent", id: agent.id, assigned: true });
    const allowed = await callTool(ctx, "ssh_key_install_on_server", { name: "agentkey", server: "web" });
    expect(allowed.isError).toBeFalsy();
    expect(readFileSync(file, "utf8")).toContain("ssh-ed25519");
    expect(listAudit(1, "ssh_key.install")[0]?.actor).toBe(`agent:${agent.id}`);
    await callTool(ctx, "ssh_key_update", { name: "agentkey", in_agent: true });
    expect(listAudit(1, "ssh_key.agent_load")[0]?.actor).toBe(`agent:${agent.id}`);
  });

  test("a saved server signing in with the same key is listed", async () => {
    const made = await api<SshManagedKey>("POST", "/api/ssh/key-manager/import", { name: "shared", key: sshd.userKey });
    expect(made.data.servers).toEqual([]);
    const keyed = createServer({ name: "keyed", host: "127.0.0.1", port: sshd.port, username: sshd.username, auth: "key", privateKey: sshd.userKey });
    expect((await keyOf("shared"))?.servers).toEqual([{ id: keyed.id, name: "keyed" }]);
  });
});

describe("the switch", () => {
  const chat = (agent: Agent) => {
    const conversationId = newId("cnv");
    insert("conversations", { id: conversationId, agent_id: agent.id, title: "x", origin: "chat", created_at: now(), updated_at: now() });
    const runId = newId("run");
    insert("runs", { id: runId, agent_id: agent.id, conversation_id: conversationId, trigger: "chat", status: "running", prompt: "x", created_at: now() });
    return { runId, agentId: agent.id, conversationId, workspaceId: null, depth: 0 };
  };

  test("off closes the API and the agents' tools", async () => {
    const agent = await makeAgent({ name: "Boss" });
    const names = () => listToolsFor(agent, chat(agent)).map((t) => t.name).filter((n) => n.startsWith("ssh_key"));
    expect(names()).toContain("ssh_key_generate");
    updateSettings({ sshKeys: { enabled: false } });
    expect(names()).toEqual([]);
    for (const [method, path, body] of [
      ["GET", "/api/ssh/key-manager"],
      ["POST", "/api/ssh/key-manager", { name: "x" }],
      ["POST", "/api/ssh/key-manager/import", { name: "x", key: "y" }],
      ["PATCH", "/api/ssh/key-manager/x", {}],
      ["DELETE", "/api/ssh/key-manager/x"],
      ["POST", "/api/ssh/key-manager/x/agent", { loaded: true }],
      ["POST", "/api/ssh/key-manager/x/install", { serverId: "s" }],
    ] as const) {
      expect((await api(method, path, body)).status).toBe(403);
    }
    expect(existsSync(join(ssh, "x"))).toBe(false);
    updateSettings({ sshKeys: { enabled: true } });
  });
});

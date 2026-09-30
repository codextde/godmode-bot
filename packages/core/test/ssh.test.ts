import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, SshServer } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { startSshServer, type TestSshServer } from "./fixtures/ssh-server";
import * as vault from "../src/vault/vault";
import { getAgent, updateAgent } from "../src/agents/service";
import { createConversation, getConversationSummary, sendMessage, startChat, updateConversation } from "../src/services/conversations";
import { waitForRun } from "../src/runner/runner";
import { issueRunToken, revokeRunToken } from "../src/mcp/tokens";
import { listAudit } from "../src/services/audit";
import { get } from "../src/db";
import { assignServer, attachSsh, createServer, deleteServer, detachSsh, execForHuman, getServer, listServers, testServer, tryServer, updateServer } from "../src/ssh/service";
import { closeAllConnections } from "../src/ssh/client";
import { generateEd25519, generateKeyPair, listLocalKeys } from "../src/ssh/keys";

const PASSPHRASE = "correct horse battery staple";

let env: TestEnv;
let sshd: TestSshServer;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-ssh-");
  await vault.setup(PASSPHRASE, false);
  sshd = await startSshServer({ password: "hunter2-login" });
  agent = await makeAgent({ name: "Operator" });
});

afterAll(async () => {
  closeAllConnections();
  await sshd.close();
  await env.close();
});

function passwordServer(extra: Partial<Parameters<typeof createServer>[0]> = {}): SshServer {
  return createServer({ name: "Web", host: "127.0.0.1", port: sshd.port, username: sshd.username, auth: "password", password: sshd.password, ...extra });
}

describe("servers", () => {
  test("secrets are sealed and never returned", () => {
    const server = passwordServer({ description: "  Production web  " });
    expect(server).toMatchObject({ name: "Web", host: "127.0.0.1", port: sshd.port, auth: "password", hasPassword: true, key: null, description: "Production web", hostKey: null });
    expect(JSON.stringify(server)).not.toContain(sshd.password);
    const row = get<{ password_enc: string }>("SELECT password_enc FROM ssh_servers WHERE id = ?", server.id)!;
    expect(row.password_enc).not.toContain(sshd.password);
    expect(vault.redact(`the password is ${sshd.password}`)).not.toContain(sshd.password);
    deleteServer(server.id);
  });

  test("validates the address and requires a secret", () => {
    expect(() => passwordServer({ host: "deploy@example.com" })).toThrow(/host name or IP address/);
    expect(() => passwordServer({ port: 70000 })).toThrow(/port/);
    expect(() => passwordServer({ username: "two words" })).toThrow(/user name/);
    expect(() => passwordServer({ password: "" })).toThrow(/Enter the password/);
    expect(() => createServer({ name: "K", host: "example.com", username: "root", auth: "key" })).toThrow(/private key/);
    expect(passwordServer({ host: "[::1]" }).host).toBe("::1");
  });

  test("keys: public keys are refused, a passphrase is required and checked", () => {
    const encrypted = generateEd25519({ passphrase: "open sesame", cipher: "aes256-ctr", rounds: 4 });
    const base = { name: "Keyed", host: "example.com", username: "root", auth: "key" as const };
    expect(() => createServer({ ...base, privateKey: sshd.userPublicKey })).toThrow(/public key/);
    expect(() => createServer({ ...base, privateKey: encrypted.private })).toThrow(/passphrase/);
    expect(() => createServer({ ...base, privateKey: encrypted.private, passphrase: "wrong" })).toThrow(/doesn't unlock/);
    const server = createServer({ ...base, privateKey: encrypted.private, passphrase: "open sesame", password: "sudo-secret-1" });
    expect(server.key).toMatchObject({ type: "ssh-ed25519", encrypted: true });
    expect(server.key!.publicKey.startsWith("ssh-ed25519 AAAA")).toBe(true);
    expect(server.hasPassword).toBe(true);
    // Only the sudo password changes: the key stays.
    const updated = updateServer(server.id, { password: "sudo-secret-2" });
    expect(updated.key).toEqual(server.key);
    // Switching to a password login drops the key.
    expect(updateServer(server.id, { auth: "password" }).key).toBeNull();
    deleteServer(server.id);
  });

  test("generated keys can always be read back (ssh2 alone drops a leading zero byte of 1 public key in 256)", () => {
    for (let i = 0; i < 1500; i++) expect(generateKeyPair().publicKey).toMatch(/^ssh-ed25519 AAAA\S+ godmode$/);
  });

  test("moving a server forgets its host key", () => {
    const server = passwordServer({ hostKey: { type: "ssh-ed25519", fingerprint: sshd.hostKeyFingerprint } });
    expect(server.hostKey?.fingerprint).toBe(sshd.hostKeyFingerprint);
    expect(updateServer(server.id, { name: "Renamed" }).hostKey).not.toBeNull();
    expect(updateServer(server.id, { host: "localhost" }).hostKey).toBeNull();
    expect(() => updateServer(server.id, { hostKey: { type: "x", fingerprint: "MD5:nope" } })).toThrow(/fingerprint/);
    deleteServer(server.id);
  });

  test("keys from ~/.ssh can be listed and imported", () => {
    const home = mkdtempSync(join(tmpdir(), "godmode-home-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, ".ssh"));
      writeFileSync(join(home, ".ssh", "id_ed25519"), sshd.userKey);
      writeFileSync(join(home, ".ssh", "id_ed25519.pub"), sshd.userPublicKey);
      writeFileSync(join(home, ".ssh", "known_hosts"), "example.com ssh-ed25519 AAAA\n");
      writeFileSync(join(home, ".ssh", "config"), "Host *\n");
      const keys = listLocalKeys();
      expect(keys.map((k) => k.name)).toEqual(["id_ed25519"]);
      expect(keys[0]).toMatchObject({ type: "ssh-ed25519", encrypted: false, comment: "test@godmode" });
      const server = createServer({ name: "Imported", host: "127.0.0.1", port: sshd.port, username: sshd.username, auth: "key", privateKeyPath: keys[0]!.path });
      expect(server.key?.fingerprint).toBe(keys[0]!.fingerprint);
      expect(() => createServer({ name: "Nope", host: "h", username: "u", auth: "key", privateKeyPath: "/etc/hosts" })).toThrow(/~\/.ssh/);
      deleteServer(server.id);
    } finally {
      process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("connections", () => {
  test("a test signs in, pins the host key and reads the OS", async () => {
    const server = passwordServer();
    const result = await testServer(server.id);
    expect(result).toMatchObject({ ok: true, error: null, stage: null, hostKeyChanged: false });
    expect(result.hostKey?.fingerprint).toBe(sshd.hostKeyFingerprint);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const saved = getServer(server.id);
    expect(saved.hostKey?.fingerprint).toBe(sshd.hostKeyFingerprint);
    expect(saved.lastConnectedAt).not.toBeNull();
    expect(saved.os).toBeTruthy();
    deleteServer(server.id);
  });

  test("key sign-in works; a wrong password, a changed host key and a closed port are explained", async () => {
    const keyed = createServer({ name: "Key login", host: "127.0.0.1", port: sshd.port, username: sshd.username, auth: "key", privateKey: sshd.userKey });
    expect((await testServer(keyed.id)).ok).toBe(true);

    const wrong = passwordServer({ password: "not-the-password" });
    const denied = await testServer(wrong.id);
    expect(denied).toMatchObject({ ok: false, stage: "auth" });
    expect(denied.error).toContain(`didn't accept the password for "${sshd.username}"`);
    expect(getServer(wrong.id).lastError).toBe(denied.error);

    const pinned = passwordServer({ hostKey: { type: "ssh-ed25519", fingerprint: `SHA256:${"A".repeat(43)}` } });
    const changed = await testServer(pinned.id);
    expect(changed).toMatchObject({ ok: false, stage: "host-key", hostKeyChanged: true });
    expect(changed.hostKey?.fingerprint).toBe(sshd.hostKeyFingerprint);
    expect(changed.error).toContain("host key");
    // Forgetting the key lets the next connection pin the real one.
    updateServer(pinned.id, { hostKey: null });
    expect((await testServer(pinned.id)).ok).toBe(true);

    const closed = await tryServer({ name: "Closed", host: "127.0.0.1", port: 1, username: "x", auth: "password", password: "p" });
    expect(closed).toMatchObject({ ok: false, stage: "connect" });
    expect(closed.error).toContain("refused");

    for (const s of [keyed, wrong, pinned]) deleteServer(s.id);
  });

  test("trying settings uses the saved secrets and records nothing", async () => {
    const server = passwordServer();
    const result = await tryServer({ id: server.id, name: "Web", host: "127.0.0.1", port: sshd.port, username: sshd.username, auth: "password" });
    expect(result.ok).toBe(true);
    expect(getServer(server.id)).toMatchObject({ hostKey: null, lastConnectedAt: null });
    const bad = await tryServer({ name: "x", host: "bad host", username: "u", auth: "password", password: "p" });
    expect(bad).toMatchObject({ ok: false, stage: "config" });
    deleteServer(server.id);
  });

  test("the human can run a command; timeouts stop it", async () => {
    const server = passwordServer();
    const res = await execForHuman(server.id, { command: "echo hi; echo err >&2; exit 3" });
    expect(res).toMatchObject({ exitCode: 3, stdout: "hi\n", stderr: "err\n", timedOut: false });
    const slow = await execForHuman(server.id, { command: "sleep 5; echo late", timeoutSeconds: 1 });
    expect(slow.timedOut).toBe(true);
    expect(slow.stdout).not.toContain("late");
    deleteServer(server.id);
  });
});

describe("ssh MCP tools", () => {
  let web: SshServer;
  let db: SshServer;
  let folder: string;

  async function rpc(token: string, method: string, params?: unknown) {
    const res = await fetch(`${env.baseUrl}/mcp/ssh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
    });
    return (await res.json()) as { result: { content: { text: string }[]; isError?: boolean; tools?: { name: string }[] } };
  }

  async function call(token: string, name: string, args: Record<string, unknown> = {}) {
    const r = await rpc(token, "tools/call", { name, arguments: args });
    return { text: r.result.content[0]!.text, isError: !!r.result.isError };
  }

  function runWith(sshServerIds: string[], folders: string[] = [folder]) {
    const conv = createConversation({ agentId: agent.id, sshServerIds });
    const runId = `run_ssh_${Math.random().toString(36).slice(2)}`;
    attachSsh(runId, folders);
    const token = issueRunToken({ runId, agentId: agent.id, conversationId: conv.id, workspaceId: null, depth: 0 });
    return { token, conv, done: () => (revokeRunToken(token), detachSsh(runId)) };
  }

  beforeAll(() => {
    web = passwordServer({ name: "web", description: "nginx" });
    db = createServer({ name: "db", host: "127.0.0.1", port: sshd.port, username: sshd.username, auth: "key", privateKey: sshd.userKey });
    folder = mkdtempSync(join(tmpdir(), "godmode-ssh-run-"));
  });

  afterAll(() => {
    deleteServer(web.id);
    deleteServer(db.id);
    rmSync(folder, { recursive: true, force: true });
  });

  test("shell, files and sudo on the chat's server", async () => {
    const run = runWith([web.id]);
    try {
      const list = await rpc(run.token, "tools/list");
      expect(list.result.tools!.map((t) => t.name)).toEqual(["list_servers", "shell", "read_file", "write_file", "edit_file", "upload", "download"]);
      expect(JSON.parse((await call(run.token, "list_servers")).text)[0]).toMatchObject({ name: "web", address: `${sshd.username}@127.0.0.1:${sshd.port}`, description: "nginx" });

      const shell = await call(run.token, "shell", { command: "echo hello; echo oops >&2; exit 3" });
      expect(shell.isError).toBe(true);
      expect(shell.text).toBe("Exit code: 3\nhello\n[stderr]\noops");
      mkdirSync(join(sshd.home, "app"));
      expect((await call(run.token, "shell", { command: "pwd", cwd: "app" })).text).toBe(`Exit code: 0\n${realpathSync(join(sshd.home, "app"))}`);
      expect((await call(run.token, "shell", { command: "cat", stdin: "piped input" })).text).toBe("Exit code: 0\npiped input");
      const missing = await call(run.token, "shell", { command: "echo first; echo second", cwd: "no-such-dir" });
      expect(missing.isError).toBe(true);
      expect(missing.text).not.toContain("second");

      expect(await call(run.token, "write_file", { path: "app/config.ini", content: "port=80\nhost=a\n" })).toEqual({ text: "Wrote 15 bytes to app/config.ini on web.", isError: false });
      expect((await call(run.token, "edit_file", { path: "~/app/config.ini", old_string: "port=80", new_string: "port=8080" })).isError).toBe(false);
      expect((await call(run.token, "read_file", { path: "app/config.ini" })).text).toBe("1\tport=8080\n2\thost=a");
      expect(readFileSync(join(sshd.home, "app", "config.ini"), "utf8")).toBe("port=8080\nhost=a\n");
      expect((await call(run.token, "read_file", { path: "app/missing.txt" })).text).toContain("No such file");

      // sudo: Godmode answers the prompt; the password never shows up in what the model gets.
      const sudo = await call(run.token, "shell", { command: "echo root=$FAKE_ROOT; cat", sudo: true, stdin: "after the password" });
      expect(sudo).toEqual({ text: "Exit code: 0\nroot=1\nafter the password", isError: false });
      expect((await call(run.token, "shell", { command: `echo ${sshd.password}` })).text).toBe("Exit code: 0\n••••••••");
      writeFileSync(join(sshd.home, "leak.txt"), `pw=${sshd.password}\n`);
      expect((await call(run.token, "read_file", { path: "leak.txt" })).text).toBe("1\tpw=••••••••");
      expect(listAudit(50, "ssh.").map((a) => a.action)).toEqual(expect.arrayContaining(["ssh.use", "ssh.sudo"]));
    } finally {
      run.done();
    }
  });

  test("the agent's servers join the chat's; server picks the one to use", async () => {
    await updateAgent(agent.id, { sshServerIds: [db.id] });
    const run = runWith([web.id]);
    try {
      expect((await call(run.token, "shell", { command: "true" })).text).toContain('Several servers are available ("web", "db")');
      expect((await call(run.token, "shell", { server: "DB", command: "echo key-login" })).text).toBe("Exit code: 0\nkey-login");
      expect((await call(run.token, "shell", { server: db.id, command: "true" })).isError).toBe(false);
      expect((await call(run.token, "shell", { server: "nope", command: "true" })).text).toContain('No server "nope"');
      expect((await call(run.token, "shell", { server: "we", command: "echo prefix" })).text).toBe("Exit code: 0\nprefix");
      expect((await call(run.token, "shell", { server: "127.0.0.1", command: "true" })).text).toContain("matches several servers");
      // sudo without a saved password only works when sudo asks for none.
      expect((await call(run.token, "shell", { server: "db", command: "id", sudo: true })).text).toContain("none is saved for this server");

      // Taking a server away applies to the running run at once.
      updateConversation(run.conv.id, { sshServerIds: [] });
      expect((await call(run.token, "shell", { server: "web", command: "true" })).text).toContain('No server "web"');
    } finally {
      run.done();
      await updateAgent(agent.id, { sshServerIds: [] });
    }
  });

  test("uploads and downloads stay within the run's folders", async () => {
    const run = runWith([web.id]);
    try {
      const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
      writeFileSync(join(folder, "build.bin"), bytes);
      expect((await call(run.token, "upload", { local_path: "build.bin", remote_path: "releases/" })).text).toBe("Uploaded build.bin (6 bytes) to releases/build.bin on web.");
      expect(readFileSync(join(sshd.home, "releases", "build.bin"))).toEqual(bytes);
      const down = await call(run.token, "download", { remote_path: "releases/build.bin", local_path: "copies/build.bin" });
      expect(down.isError).toBe(false);
      expect(readFileSync(join(folder, "copies", "build.bin"))).toEqual(bytes);
      expect((await call(run.token, "download", { remote_path: "releases/build.bin", local_path: "/tmp/elsewhere.bin" })).text).toContain("outside the folders of this run");
      expect((await call(run.token, "upload", { local_path: "../../etc/hosts" })).text).toContain("outside the folders of this run");
      expect(existsSync("/tmp/elsewhere.bin")).toBe(false);
    } finally {
      run.done();
    }
  });

  test("sudo: the password only answers sudo's own prompt, and a rejected one is reported", async () => {
    const partial = await startSshServer({ sudoNopasswdSome: true });
    const strict = await startSshServer({ sudoPassword: "not-the-login-password" });
    const a = createServer({ name: "partial", host: "127.0.0.1", port: partial.port, username: partial.username, auth: "password", password: partial.password });
    const b = createServer({ name: "strict", host: "127.0.0.1", port: strict.port, username: strict.username, auth: "password", password: strict.password });
    const run = runWith([a.id, b.id]);
    try {
      // The probe fails, yet sudo doesn't ask for this command: the saved password must not become its input.
      expect(await call(run.token, "shell", { server: "partial", command: "echo root=$FAKE_ROOT; cat", sudo: true, stdin: "only stdin" })).toEqual({
        text: "Exit code: 0\nroot=1\nonly stdin",
        isError: false,
      });
      const rejected = await call(run.token, "shell", { server: "strict", command: "id", sudo: true });
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain("sudo rejected the saved password");
      expect(rejected.text).not.toContain("godmode-sudo-");
    } finally {
      run.done();
      deleteServer(a.id);
      deleteServer(b.id);
      await partial.close();
      await strict.close();
    }
  });

  test("downloads never follow dangling links or write into .git and .claude", async () => {
    const run = runWith([web.id]);
    try {
      writeFileSync(join(sshd.home, "payload.txt"), "data\n");
      const outside = join(tmpdir(), `godmode-outside-${Date.now()}.txt`);
      symlinkSync(outside, join(folder, "dangling.txt"));
      expect((await call(run.token, "download", { remote_path: "payload.txt", local_path: "dangling.txt" })).text).toContain("link to a file that doesn't exist");
      expect(existsSync(outside)).toBe(false);
      for (const target of [".git/hooks/pre-commit", ".claude/settings.json", "sub/.git/config"]) {
        expect((await call(run.token, "download", { remote_path: "payload.txt", local_path: target })).text).toContain(".git or .claude");
      }
      writeFileSync(join(folder, "payload.txt"), "old\n");
      expect((await call(run.token, "download", { remote_path: "payload.txt", local_path: "payload.txt" })).isError).toBe(false);
      expect(readFileSync(join(folder, "payload.txt"), "utf8")).toBe("data\n");
      expect(readdirSync(folder).filter((f) => f.endsWith(".part"))).toEqual([]);
    } finally {
      run.done();
    }
  });

  test("the saved key is masked in results, line by line", async () => {
    const run = runWith([db.id]);
    try {
      writeFileSync(join(sshd.home, "copied-key"), sshd.userKey);
      const read = await call(run.token, "read_file", { path: "copied-key" });
      const lines = sshd.userKey.split("\n").filter((l) => l.length >= 20 && !l.startsWith("-----"));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(read.text).not.toContain(line);
      expect(read.text).toContain("••••••••");
    } finally {
      run.done();
    }
  });

  test("runs without SSH servers get no tools", async () => {
    const conv = createConversation({ agentId: agent.id });
    const token = issueRunToken({ runId: "run_ssh_none", agentId: agent.id, conversationId: conv.id, workspaceId: null, depth: 0 });
    try {
      expect((await rpc(token, "tools/list")).result.tools).toEqual([]);
      expect((await call(token, "shell", { command: "true" })).text).toBe("This run has no SSH servers.");
    } finally {
      revokeRunToken(token);
    }
  });

  test("servers without SFTP: text files go through the shell", async () => {
    const plain = await startSshServer({ sftp: false, sudoPassword: null });
    const server = createServer({ name: "no-sftp", host: "127.0.0.1", port: plain.port, username: plain.username, auth: "password", password: plain.password });
    const run = runWith([server.id]);
    try {
      expect((await call(run.token, "write_file", { path: "notes/a.txt", content: "one\n" })).isError).toBe(false);
      expect((await call(run.token, "read_file", { path: "notes/a.txt" })).text).toBe("1\tone");
      expect((await call(run.token, "upload", { local_path: "build.bin" })).text).toContain("doesn't offer SFTP");
      expect((await call(run.token, "shell", { command: "echo root=$FAKE_ROOT", sudo: true })).text).toBe("Exit code: 0\nroot=1");
    } finally {
      run.done();
      deleteServer(server.id);
      await plain.close();
    }
  });
});

describe("assignments and runs", () => {
  test("a chat's servers reach the run: MCP config, system prompt and resumed turns", async () => {
    const server = passwordServer({ name: "prod-web", description: "Production web server" });
    const worker = await makeAgent({ name: "SSH Runner" });
    const first = await startChat({ agentId: worker.id, content: "CALL_SSH", sshServerIds: [server.id] });
    expect(first.conversation.sshServerIds).toEqual([server.id]);
    const done = await waitForRun(first.run.id, 60_000);
    expect(done.error).toBeNull();
    const summary = JSON.parse(done.result!.replace(/^SSH /, ""));
    expect(summary.server).toBe("ssh");
    expect(summary.sameToken).toBe(true);
    expect(summary.shell.text).toContain("Exit code: 3");
    expect(summary.read.text).toBe("1\talpha\n2\tgamma");
    expect(summary.sudo.text).toBe("Exit code: 0\nroot=1");

    const inv = invocations(env).filter((i) => i.prompt.includes("CALL_SSH")).pop()!;
    const prompt = argValue(inv, "--append-system-prompt")!;
    expect(prompt).toContain("### SSH servers");
    expect(prompt).toContain(`**prod-web** — \`${sshd.username}@127.0.0.1:${sshd.port}\``);
    expect(prompt).toContain("Production web server");
    expect(prompt).not.toContain(sshd.password);

    const again = await waitForRun((await sendMessage(first.conversation.id, { content: "hello again" })).run.id, 30_000);
    expect(again.status).toBe("succeeded");
    expect(invocations(env).filter((i) => i.prompt.includes("hello again")).pop()!.prompt).toContain("SSH servers you may use with the `ssh` MCP tools");

    // Without servers there's no ssh MCP server.
    const plain = await startChat({ agentId: worker.id, content: "CALL_SSH" });
    expect((await waitForRun(plain.run.id, 30_000)).result).toBe("no ssh server");
    deleteServer(server.id);
  });

  test("assigning, agents can't grant themselves servers, deleting removes everywhere", async () => {
    const server = passwordServer({ name: "shared" });
    const worker = await makeAgent({ name: "Assignee" });
    const conv = createConversation({ agentId: worker.id });
    await assignServer(server.id, { kind: "agent", id: worker.id, assigned: true });
    const assigned = await assignServer(server.id, { kind: "conversation", id: conv.id, assigned: true });
    expect(assigned.assignments.map((a) => a.kind).sort()).toEqual(["agent", "conversation"]);
    expect(getAgent(worker.id).sshServerIds).toEqual([server.id]);

    const other = passwordServer({ name: "other" });
    await updateAgent(worker.id, { sshServerIds: [server.id, other.id] }, `agent:${worker.id}`);
    expect(getAgent(worker.id).sshServerIds).toEqual([server.id]);
    // A server deleted meanwhile is dropped instead of blocking the change.
    expect((await updateAgent(worker.id, { sshServerIds: ["ssh_missing", server.id] })).sshServerIds).toEqual([server.id]);

    deleteServer(server.id);
    expect(getAgent(worker.id).sshServerIds).toEqual([]);
    expect(getConversationSummary(conv.id).sshServerIds).toEqual([]);
    expect(listServers().map((s) => s.id)).toEqual(expect.not.arrayContaining([server.id]));
    deleteServer(other.id);
  });
});

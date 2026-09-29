/**
 * An SSH server for tests, built on ssh2's server side: password and public key sign-in, commands run with `sh` in a
 * temporary home folder, SFTP on the real file system (relative paths from that home), and a fake `sudo` on the PATH
 * that checks the password it reads from stdin (or needs none with `nopasswd`) and marks root with FAKE_ROOT=1.
 */
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync, writeSync, chmodSync, renameSync, unlinkSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Server, utils, type Attributes, type ParsedKey } from "ssh2";
import { fingerprintOf } from "../../src/ssh/keys";

export interface TestSshServerOptions {
  username?: string;
  password?: string;
  /** Password sudo expects; null = sudo needs none (NOPASSWD). Default: the login password. */
  sudoPassword?: string | null;
  /** sudo needs no password for anything but \`true\` (so a \`sudo -n true\` probe fails). */
  sudoNopasswdSome?: boolean;
  /** OpenSSH private host key; default: a new Ed25519 key. */
  hostKey?: string;
  /** Offer the SFTP subsystem (default true). */
  sftp?: boolean;
  port?: number;
}

export interface TestSshServer {
  port: number;
  home: string;
  username: string;
  password: string;
  hostKey: string;
  hostKeyFingerprint: string;
  /** Private key (OpenSSH) whose public key may sign in. */
  userKey: string;
  userPublicKey: string;
  commands: string[];
  close: () => Promise<void>;
}

const FAKE_SUDO = `#!/bin/sh
nopass=""; stdin_pw=""; prompt="Password:"
while [ $# -gt 0 ]; do
  case "$1" in
    -n) nopass=1; shift;;
    -S) stdin_pw=1; shift;;
    -k) shift;;
    -p) prompt="$2"; shift 2;;
    --) shift; break;;
    *) break;;
  esac
done
if [ "$SUDO_MODE" = "nopasswd" ]; then FAKE_ROOT=1 exec "$@"; fi
# NOPASSWD for everything but \`true\`: the probe fails, the command itself runs without asking.
if [ "$SUDO_MODE" = "nopasswd-some" ] && [ "$1" != "true" ]; then FAKE_ROOT=1 exec "$@"; fi
if [ -n "$nopass" ]; then echo "sudo: a password is required" >&2; exit 1; fi
if [ -n "$stdin_pw" ]; then
  printf '%s' "$prompt" >&2
  IFS= read -r pw
  if [ "$pw" = "$SUDO_EXPECT" ]; then FAKE_ROOT=1 exec "$@"; fi
  echo "Sorry, try again." >&2
  printf '%s' "$prompt" >&2
  IFS= read -r pw || { echo "sudo: no password was provided" >&2; exit 1; }
  echo "sudo: 2 incorrect password attempts" >&2
  exit 1
fi
exit 1
`;

function attrsOf(st: Stats): Attributes {
  return { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

export async function startSshServer(opts: TestSshServerOptions = {}): Promise<TestSshServer> {
  const username = opts.username ?? "deploy";
  const password = opts.password ?? "hunter2-login";
  const sudoPassword = opts.sudoPassword === undefined ? password : opts.sudoPassword;
  const hostKey = opts.hostKey ?? utils.generateKeyPairSync("ed25519").private;
  const user = utils.generateKeyPairSync("ed25519", { comment: "test@godmode" });
  const allowed = utils.parseKey(user.public) as ParsedKey;
  const hostParsed = utils.parseKey(hostKey) as ParsedKey;
  const root = mkdtempSync(join(tmpdir(), "godmode-sshd-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "sudo"), FAKE_SUDO);
  chmodSync(join(bin, "sudo"), 0o755);
  const commands: string[] = [];
  const clients = new Set<{ end: () => void }>();
  const resolvePath = (p: string) => (isAbsolute(p) ? p : join(home, p));

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.username !== username) return ctx.reject(["password", "publickey"]);
      if (ctx.method === "password" && ctx.password === password) return ctx.accept();
      if (ctx.method === "publickey" && ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0) {
        if (!ctx.signature || !ctx.blob) return ctx.accept();
        if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("error", () => undefined);
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        let kill: (() => void) | null = null;
        session.on("signal", (accept) => {
          accept?.();
          kill?.();
        });
        session.on("exec", (accept, _reject, info) => {
          const stream = accept();
          commands.push(info.command);
          const child = Bun.spawn(["sh", "-c", info.command], {
            cwd: home,
            env: {
              HOME: home,
              PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
              SUDO_EXPECT: sudoPassword ?? "",
              SUDO_MODE: sudoPassword === null ? "nopasswd" : opts.sudoNopasswdSome ? "nopasswd-some" : "password",
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          kill = () => child.kill("SIGKILL");
          stream.on("data", (d: Buffer) => {
            try {
              child.stdin.write(d);
            } catch {
              /* exited */
            }
          });
          stream.on("end", () => void child.stdin.end());
          stream.on("close", () => child.kill("SIGKILL"));
          const pump = async (from: ReadableStream<Uint8Array>, to: (b: Buffer) => void) => {
            const reader = from.getReader();
            for (let r = await reader.read(); !r.done; r = await reader.read()) to(Buffer.from(r.value));
          };
          void Promise.all([pump(child.stdout, (b) => stream.write(b)), pump(child.stderr, (b) => stream.stderr.write(b)), child.exited]).then(([, , code]) => {
            try {
              if (child.signalCode) stream.exit(child.signalCode.replace(/^SIG/, ""), false, "");
              else stream.exit(code);
              stream.end();
            } catch {
              /* channel closed */
            }
          });
        });
        session.on("sftp", (accept, reject) => {
          if (opts.sftp === false) return reject();
          const sftp = accept();
          const STATUS = utils.sftp.STATUS_CODE;
          const handles = new Map<number, { fd: number }>();
          let next = 1;
          const handleOf = (buf: Buffer) => handles.get(buf.readUInt32BE(0));
          const fail = (reqid: number, err: unknown) => {
            const code = (err as { code?: string }).code;
            sftp.status(reqid, code === "ENOENT" ? STATUS.NO_SUCH_FILE : code === "EACCES" || code === "EPERM" ? STATUS.PERMISSION_DENIED : STATUS.FAILURE);
          };
          sftp.on("OPEN", (reqid, filename, flags, attrs) => {
            try {
              const fd = openSync(resolvePath(filename), utils.sftp.flagsToString(flags) ?? "r", attrs?.mode ? attrs.mode & 0o777 : 0o644);
              const id = next++;
              handles.set(id, { fd });
              const buf = Buffer.alloc(4);
              buf.writeUInt32BE(id);
              sftp.handle(reqid, buf);
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on("READ", (reqid, handle, offset, length) => {
            const h = handleOf(handle);
            if (!h) return sftp.status(reqid, STATUS.FAILURE);
            const buf = Buffer.alloc(length);
            const n = readSync(h.fd, buf, 0, length, offset);
            if (n === 0) return sftp.status(reqid, STATUS.EOF);
            sftp.data(reqid, buf.subarray(0, n));
          });
          sftp.on("WRITE", (reqid, handle, offset, data) => {
            const h = handleOf(handle);
            if (!h) return sftp.status(reqid, STATUS.FAILURE);
            writeSync(h.fd, data, 0, data.length, offset);
            sftp.status(reqid, STATUS.OK);
          });
          sftp.on("CLOSE", (reqid, handle) => {
            const id = handle.readUInt32BE(0);
            const h = handles.get(id);
            if (h) closeSync(h.fd);
            handles.delete(id);
            sftp.status(reqid, STATUS.OK);
          });
          sftp.on("FSTAT", (reqid, handle) => {
            const h = handleOf(handle);
            if (!h) return sftp.status(reqid, STATUS.FAILURE);
            sftp.attrs(reqid, attrsOf(fstatSync(h.fd)));
          });
          const statReq = (reqid: number, path: string) => {
            try {
              sftp.attrs(reqid, attrsOf(statSync(resolvePath(path))));
            } catch (err) {
              fail(reqid, err);
            }
          };
          sftp.on("STAT", statReq);
          sftp.on("LSTAT", statReq);
          sftp.on("MKDIR", (reqid, path) => {
            try {
              mkdirSync(resolvePath(path));
              sftp.status(reqid, STATUS.OK);
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on("REALPATH", (reqid, path) => sftp.name(reqid, [{ filename: resolvePath(path), longname: "", attrs: {} as Attributes }]));
          sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS.OK));
          sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS.OK));
          sftp.on("REMOVE", (reqid, path) => {
            try {
              unlinkSync(resolvePath(path));
              sftp.status(reqid, STATUS.OK);
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on("RENAME", (reqid, from, to) => {
            try {
              renameSync(resolvePath(from), resolvePath(to));
              sftp.status(reqid, STATUS.OK);
            } catch (err) {
              fail(reqid, err);
            }
          });
        });
      });
    });
  });

  const port = await new Promise<number>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return {
    port,
    home,
    username,
    password,
    hostKey,
    hostKeyFingerprint: fingerprintOf(hostParsed.getPublicSSH()),
    userKey: user.private,
    userPublicKey: user.public,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(root, { recursive: true, force: true });
          resolve();
        });
        // Open connections would keep the server from closing.
        for (const client of clients) client.end();
      }),
  };
}

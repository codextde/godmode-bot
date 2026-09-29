/** Git repositories served over git's "smart" HTTP protocol (`git http-backend`), so tests can clone and push. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SmartGitServer {
  /** Create a repository with one commit on `main`; returns its clone URL and bare directory. */
  create: (name: string) => { url: string; bare: string };
  close: () => void;
}

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

function indexOfBlankLine(bytes: Uint8Array): { at: number; length: number } {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { at: i, length: 2 };
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return { at: i, length: 4 };
  }
  return { at: bytes.length, length: 0 };
}

export function startSmartGitServer(): SmartGitServer {
  const root = mkdtempSync(join(tmpdir(), "godmode-smart-git-"));
  const served = join(root, "srv");
  mkdirSync(served);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;
      const proc = Bun.spawn(["git", "http-backend"], {
        env: {
          PATH: process.env.PATH ?? "",
          GIT_PROJECT_ROOT: served,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: decodeURIComponent(u.pathname),
          QUERY_STRING: u.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers.get("content-type") ?? "",
          CONTENT_LENGTH: body ? String(body.length) : "",
          HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
          GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
          REMOTE_ADDR: "127.0.0.1",
        },
        stdin: body ?? "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      await proc.exited;
      const { at, length } = indexOfBlankLine(out);
      const headers = new Headers();
      let status = 200;
      for (const line of new TextDecoder().decode(out.slice(0, at)).split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]) || 200;
        else headers.set(key, value);
      }
      return new Response(out.slice(at + length), { status, headers });
    },
  });

  return {
    create(name) {
      const work = join(root, "work", name);
      const bare = join(served, `${name}.git`);
      mkdirSync(work, { recursive: true });
      git(work, "init", "--quiet");
      writeFileSync(join(work, "README.md"), `# ${name}\n`);
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", "init");
      git(root, "clone", "--quiet", "--bare", work, bare);
      git(bare, "config", "http.receivepack", "true");
      return { url: `http://127.0.0.1:${server.port}/${name}.git`, bare };
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

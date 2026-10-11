/** A git repository served over git's "dumb" HTTP protocol from a temp dir, for clone and update tests. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

export interface GitServer {
  /** Clone URL of the repository ("http://127.0.0.1:<port>/app.git"). */
  url: string;
  /** Commit a file in the origin and publish it; returns the new short commit. */
  commit: (file: string, content: string) => string;
  /** Commit several files (paths with folders too) at once and publish them; returns the new full commit. */
  commitFiles: (files: Record<string, string>) => string;
  /** Commit a symbolic link `file` → `target` and publish it. */
  commitLink: (file: string, target: string) => string;
  /** Put an annotated tag on the newest commit and publish it. */
  tag: (name: string) => void;
  /** Delay every response by this many milliseconds (a slow network). */
  delayMs: number;
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

export function startGitServer(): GitServer {
  const root = mkdtempSync(join(tmpdir(), "godmode-git-server-"));
  const work = join(root, "work");
  const bare = join(root, "srv", "app.git");
  git(root, "init", "--quiet", work);
  writeFileSync(join(work, "README.md"), "# App\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "Initial commit");
  git(root, "clone", "--quiet", "--bare", work, bare);
  git(bare, "update-server-info");
  git(work, "remote", "add", "origin", bare);

  const served = join(root, "srv");
  const state = { delayMs: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (state.delayMs) await Bun.sleep(state.delayMs);
      const path = normalize(join(served, decodeURIComponent(new URL(req.url).pathname)));
      if (!path.startsWith(served) || !existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/app.git`,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(ms: number) {
      state.delayMs = ms;
    },
    commitFiles(files) {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(work, file)), { recursive: true });
        writeFileSync(join(work, file), content);
      }
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", `Update ${Object.keys(files).length} file(s)`);
      git(work, "push", "--quiet", "origin", "main");
      git(bare, "update-server-info");
      return git(work, "rev-parse", "HEAD");
    },
    commitLink(file, target) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      rmSync(join(work, file), { force: true });
      symlinkSync(target, join(work, file));
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", `Link ${file}`);
      git(work, "push", "--quiet", "origin", "main");
      git(bare, "update-server-info");
      return git(work, "rev-parse", "HEAD");
    },
    tag(name) {
      git(work, "tag", "-a", name, "-m", name);
      git(work, "push", "--quiet", "origin", name);
      git(bare, "update-server-info");
    },
    commit(file, content) {
      writeFileSync(join(work, file), content);
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", `Update ${file}`);
      git(work, "push", "--quiet", "origin", "main");
      git(bare, "update-server-info");
      return git(work, "rev-parse", "--short", "HEAD");
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

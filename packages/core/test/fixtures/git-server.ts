/** A git repository served over git's "dumb" HTTP protocol from a temp dir, for clone and update tests. */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

export interface GitServer {
  /** Clone URL of the repository ("http://127.0.0.1:<port>/app.git"). */
  url: string;
  /** Commit a file in the origin and publish it; returns the new short commit. */
  commit: (file: string, content: string) => string;
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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = normalize(join(served, decodeURIComponent(new URL(req.url).pathname)));
      if (!path.startsWith(served) || !existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/app.git`,
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

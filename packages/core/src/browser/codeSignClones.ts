/**
 * Chrome on macOS runs from a copy-on-write clone of its app, made at every launch in
 * `/var/folders/…/X/<bundle id>.code_sign_clone/code_sign_clone.XXXXXX`, and removes it only when it quits the orderly
 * way. A browser that was killed leaves its clone behind until the Mac restarts, and clones of an older version keep that
 * version's files on disk.
 *
 * A clone is born within a second or so of the browser that made it. One born within the hour after a browser of the same
 * name that still runs started may be that browser's own and stays; so does everything when processes can't be listed.
 */
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const CLONE = /^code_sign_clone\.[A-Za-z0-9._-]{6}$/;
/** How long after its browser started a clone may be born and still count as that browser's (measured: about 1 s). */
const BORN_WITHIN = 60 * 60_000;
const CLOCK_SLACK = 5_000;

export interface LeftoverClone {
  path: string;
  /** "Google Chrome" */
  app: string;
  bornAt: number;
}

export interface StartedProcess {
  /** Executable name ("Google Chrome"), as started or as the kernel knows it (16 characters at most). */
  name: string;
  startedAt: number;
}

let root: () => Promise<string | null> = cloneRoot;
let processes: () => Promise<StartedProcess[] | null> = runningProcesses;

/** Tests: look in `dir` (null = the real folder) and take `list` as the running processes (default: the real ones). */
export function __setCodeSignClonesForTests(opts: { dir: string; list?: () => Promise<StartedProcess[] | null> } | null) {
  root = opts ? async () => opts.dir : cloneRoot;
  processes = opts?.list ?? runningProcesses;
}

let userTemp: string | null = null;

/** The per-user folder macOS empties only at startup: the sibling `X` of the per-user temp folder. */
async function cloneRoot(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  if (!userTemp) {
    const temp = (await output(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]))?.trim() ?? "";
    if (!/^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/T\/?$/.test(temp)) return null;
    userTemp = temp;
  }
  return join(userTemp, "..", "X");
}

async function output(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" } });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  } catch {
    return null;
  }
}

/** "[[dd-]hh:]mm:ss" → seconds. */
export function elapsedSeconds(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** Every process twice: by the path it was started as (a symlink, say) and by the file the kernel ran. */
async function runningProcesses(): Promise<StartedProcess[] | null> {
  // Read first: a late clock would make processes look younger than they are.
  const now = Date.now();
  const [asStarted, asRun] = await Promise.all([output(["/bin/ps", "-axww", "-o", "etime=,comm="]), output(["/bin/ps", "-axww", "-o", "etime=,ucomm="])]);
  if (!asStarted || !asRun) return null;
  const list: StartedProcess[] = [];
  for (const [text, name] of [
    [asStarted, basename],
    [asRun, (s: string) => s],
  ] as const) {
    for (const line of text.split("\n")) {
      const m = /^\s*(\S+)\s+(.+)$/.exec(line);
      const secs = m ? elapsedSeconds(m[1]!) : null;
      if (m && secs !== null) list.push({ name: name(m[2]!.trim()), startedAt: now - secs * 1000 });
    }
  }
  return list.length ? list : null;
}

function sameExecutable(executable: string, name: string): boolean {
  const a = executable.toLowerCase();
  const b = name.toLowerCase();
  return a === b || a.slice(0, 16) === b;
}

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

/** Clones older than `minAgeMs` that no running browser may own. */
export async function leftoverClones(now: number, minAgeMs: number): Promise<LeftoverClone[]> {
  const dir = await root();
  if (!dir) return [];
  const found: (LeftoverClone & { executables: string[] })[] = [];
  for (const group of await names(dir)) {
    if (!group.endsWith(".code_sign_clone") || !(await lstat(join(dir, group)).catch(() => null))?.isDirectory()) continue;
    for (const name of await names(join(dir, group))) {
      if (!CLONE.test(name)) continue;
      const path = join(dir, group, name);
      const st = await lstat(path).catch(() => null);
      if (!st?.isDirectory() || (process.getuid && st.uid !== process.getuid())) continue;
      // Chrome fills the folder once, right after making it: its last change is its birth where birth times are missing.
      const bornAt = Math.min(st.birthtimeMs > 0 ? st.birthtimeMs : Infinity, st.mtimeMs);
      if (now - bornAt < minAgeMs) continue;
      const bundle = (await names(path)).find((n) => !n.startsWith("."));
      const executables = bundle ? await names(join(path, bundle, "Contents", "MacOS")) : [];
      const app = bundle?.replace(/(\.app)?(\.bundle)?$/, "") || group.replace(/\.code_sign_clone$/, "");
      found.push({ path, app, bornAt, executables });
    }
  }
  if (!found.length) return [];
  const running = await processes();
  if (!running) return [];
  return found
    .filter(
      (c) =>
        !running.some(
          (p) =>
            (!c.executables.length || c.executables.some((e) => sameExecutable(e, p.name))) &&
            p.startedAt <= c.bornAt + CLOCK_SLACK &&
            c.bornAt - p.startedAt <= BORN_WITHIN,
        ),
    )
    .map(({ path, app, bornAt }) => ({ path, app, bornAt }));
}

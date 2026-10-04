/**
 * Checking a mod with Claude Code's own validator (`claude plugin validate --json`): it reads the manifest and the
 * hooks module the way the engine will, and says what the module hooks and calls and everything the engine would
 * refuse. A run that loads a mod the engine refuses gets no word about it, so Godmode checks before it loads one.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import type { ModCheck, ModHook, ModProblem } from "@godmode/shared";
import { logger } from "../log";
import { claudeEnv, resolveClaudeCommand } from "../runner/claude";
import { runCommand, stripAnsi, versionFrom } from "../services/doctor";
import { now } from "../util";
import { startsPrograms } from "./manifest";

const log = logger("mods");
const CHECK_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Which Claude Code would check (and load) a mod: a report from another one is stale. null = not installed. */
export function claudeStamp(): string | null {
  const cmd = resolveClaudeCommand();
  if (!cmd) return null;
  return cmd
    .map((part) => {
      try {
        const s = statSync(part);
        return `${part}:${s.size}:${Math.round(s.mtimeMs)}`;
      } catch {
        return part;
      }
    })
    .join("|");
}

export function filesDigest(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path]}\0`);
  return hash.digest("hex");
}

const versions = new Map<string, string | null>();

async function claudeVersion(cmd: string[], stamp: string): Promise<string | null> {
  if (versions.has(stamp)) return versions.get(stamp)!;
  const res = await runCommand([...cmd, "--version"], { timeoutMs: 20_000, env: claudeEnv() });
  const version = res.code === 0 ? versionFrom(res.stdout) : null;
  versions.set(stamp, version);
  return version;
}

export function writeModFiles(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content, { mode: 0o600 });
  }
}

/** Split a list at its commas, leaving alone the ones inside braces or parentheses ("a{x=1, y=2}", "$.fs.read (via a, b)"). */
function splitList(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "{" || ch === "(") depth++;
    else if (ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      items.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(list.slice(start).trim());
  return items.filter(Boolean);
}

/** "session.start, tool.call{tool=Bash}" → hooks; a module that registers none says "nothing". */
function parseHooks(list: string): ModHook[] {
  return splitList(list)
    .filter((item) => item !== "nothing")
    .map((item) => {
      const m = /^([^{]+)(?:\{(.*)\})?$/.exec(item);
      return { event: (m?.[1] ?? item).trim(), matcher: m?.[2]?.trim() || null };
    });
}

/** "$.ui.log, $.http.fetch (via send)" → the calls themselves: one made through a helper function is still the mod's. */
function parseCalls(list: string): string[] {
  return splitList(list)
    .map((item) => item.replace(/\s*\(via [^)]*\)$/, ""))
    .filter((call) => call.startsWith("$."));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `where` is a file of the mod: for a problem in a hooks module ("modules../register.ts" in hooks.json) the module itself. */
function problems(list: unknown, file: string, files: Record<string, string>, clean: (s: string) => string): ModProblem[] {
  if (!Array.isArray(list)) return [];
  const out: ModProblem[] = [];
  for (const item of list) {
    if (!isObj(item) || typeof item.message !== "string") continue;
    const path = typeof item.path === "string" ? item.path : "";
    const module = /^modules\.(.+)$/.exec(path)?.[1];
    const moduleFile = module ? normalize(join(dirname(file), module)).split(sep).join("/") : null;
    // The validator starts a module's problems with "<plugin>: <file>, ": `where` says that already.
    if (moduleFile && Object.hasOwn(files, moduleFile)) {
      out.push({ where: moduleFile, message: clean(item.message).replace(new RegExp(`^[\\w-]+: ${escapeRegExp(moduleFile)}, `), "") });
    } else out.push({ where: file, message: path ? `${path}: ${clean(item.message)}` : clean(item.message) });
  }
  return out;
}

/** The validator's JSON report as a ModCheck; null when the output isn't one. */
export function parseReport(stdout: string, dir: string, files: Record<string, string>, claudeVersion: string | null): ModCheck | null {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObj(report) || typeof report.success !== "boolean") return null;
  const roots = [dir];
  try {
    roots.push(realpathSync(dir));
  } catch {
    /* the folder is gone: the plain path is all there is */
  }
  // The longer spelling first: /private/var/… holds /var/….
  roots.sort((a, b) => b.length - a.length);
  const clean = (text: string) => roots.reduce((t, root) => t.split(`${root}/`).join("").split(root).join("."), stripAnsi(text));
  const relative = (file: unknown) => (typeof file === "string" ? clean(file) : "plugin");

  const errors: ModProblem[] = [];
  const warnings: ModProblem[] = [];
  const hooks: ModHook[] = [];
  const calls = new Set<string>();
  const manifest = isObj(report.manifest) ? report.manifest : {};
  errors.push(...problems(manifest.errors, relative(manifest.file), files, clean));
  // Nobody publishes a mod from here: a missing author is no problem.
  const authorless = (list: unknown) => (Array.isArray(list) ? list.filter((w) => !(isObj(w) && w.path === "author")) : []);
  warnings.push(...problems(authorless(manifest.warnings), relative(manifest.file), files, clean));
  for (const part of Array.isArray(report.contents) ? report.contents : []) {
    if (!isObj(part)) continue;
    const file = relative(part.file);
    errors.push(...problems(part.errors, file, files, clean));
    warnings.push(...problems(part.warnings, file, files, clean));
    for (const note of Array.isArray(part.notes) ? part.notes : []) {
      if (typeof note !== "string") continue;
      const hooked = /\shooks: (.*)$/.exec(note);
      if (hooked) hooks.push(...parseHooks(hooked[1]!));
      const called = /\scalls: (.*)$/.exec(note);
      if (called) for (const call of parseCalls(called[1]!)) calls.add(call);
    }
  }
  return {
    ok: report.success && errors.length === 0,
    errors,
    warnings,
    hooks,
    calls: [...calls].sort(),
    startsPrograms: startsPrograms(files),
    claudeVersion,
    checkedAt: now(),
  };
}

export interface CheckResult {
  /** null: Claude Code isn't installed, so nothing can be said. */
  check: ModCheck | null;
  /** The validator gave no report this time (it timed out): what is said isn't about the code, so ask again later. */
  retry: boolean;
}

async function validate(name: string, files: Record<string, string>, cmd: string[], stamp: string): Promise<CheckResult> {
  const work = mkdtempSync(join(tmpdir(), "godmode-mod-"));
  const dir = join(work, name);
  try {
    writeModFiles(dir, files);
    const [res, version] = await Promise.all([
      runCommand([...cmd, "plugin", "validate", dir, "--json"], { timeoutMs: CHECK_TIMEOUT_MS, env: claudeEnv(), cwd: work }),
      claudeVersion(cmd, stamp),
    ]);
    const report = parseReport(res.stdout, dir, files, version);
    if (report) return { check: report, retry: false };
    const said = stripAnsi(res.stderr || res.stdout).trim().slice(0, 400);
    log.warn("the mod check gave no report", { timedOut: res.timedOut, code: res.code, said });
    return {
      check: {
        ok: false,
        errors: [
          {
            where: "Claude Code",
            message: res.timedOut
              ? "Claude Code took too long to check this mod. Check it again."
              : `This Claude Code can't check mods${said ? ` (${said})` : ""}. Update Claude Code under Settings → System and check again.`,
          },
        ],
        warnings: [],
        hooks: [],
        calls: [],
        startsPrograms: startsPrograms(files),
        claudeVersion: version,
        checkedAt: now(),
      },
      retry: res.timedOut,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Checks under way, by the code and the Claude Code they are about: runs that start together ask once. */
const inFlight = new Map<string, Promise<CheckResult>>();

/** Run the validator over `files`. */
export function checkMod(name: string, files: Record<string, string>): Promise<CheckResult> {
  const cmd = resolveClaudeCommand();
  const stamp = claudeStamp();
  if (!cmd || !stamp) return Promise.resolve({ check: null, retry: false });
  const key = `${name}\0${filesDigest(files)}\0${stamp}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = validate(name, files, cmd, stamp).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

export async function checkModFiles(name: string, files: Record<string, string>): Promise<ModCheck | null> {
  return (await checkMod(name, files)).check;
}

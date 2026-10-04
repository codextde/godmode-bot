/**
 * Checking a mod with Claude Code's own validator (`claude plugin validate --json`): it reads the manifest and the
 * hooks module the way the engine will, and says what the module hooks and calls and everything the engine would
 * refuse. A run that loads a mod the engine refuses gets no word about it, so Godmode checks before it loads one.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import type { ModCheck, ModHook, ModProblem } from "@godmode/shared";
import { logger } from "../log";
import { claudeEnv, resolveClaudeCommand } from "../runner/claude";
import { runCommand, stripAnsi, versionFrom } from "../services/doctor";
import { now } from "../util";
import { hasCommandHooks } from "./manifest";

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

/** "a, b{tool=Bash}, c{component=Pane, requestId=x}" → one entry per hook (commas inside braces belong to a matcher). */
function splitHooks(list: string): ModHook[] {
  const hooks: ModHook[] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const item = list.slice(start, end).trim();
    if (!item) return;
    const m = /^([^{]+)(?:\{(.*)\})?$/.exec(item);
    hooks.push({ event: (m?.[1] ?? item).trim(), matcher: m?.[2]?.trim() || null });
  };
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(list.length);
  return hooks;
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
    if (moduleFile && moduleFile in files) out.push({ where: moduleFile, message: clean(item.message).replace(new RegExp(`^[\\w-]+: ${escapeRegExp(moduleFile)}, `), "") });
    else out.push({ where: file, message: path ? `${path}: ${clean(item.message)}` : clean(item.message) });
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
      if (hooked) hooks.push(...splitHooks(hooked[1]!));
      const called = /\scalls: (.*)$/.exec(note);
      if (called) for (const call of called[1]!.split(",")) if (call.trim().startsWith("$.")) calls.add(call.trim());
    }
  }
  return {
    ok: report.success && errors.length === 0,
    errors,
    warnings,
    hooks,
    calls: [...calls].sort(),
    commandHooks: hasCommandHooks(files),
    claudeVersion,
    checkedAt: now(),
  };
}

/** Run the validator over `files`. null: Claude Code isn't installed, so nothing can be said. */
export async function checkModFiles(name: string, files: Record<string, string>): Promise<ModCheck | null> {
  const cmd = resolveClaudeCommand();
  const stamp = claudeStamp();
  if (!cmd || !stamp) return null;
  const work = mkdtempSync(join(tmpdir(), "godmode-mod-"));
  const dir = join(work, name);
  try {
    writeModFiles(dir, files);
    const [res, version] = await Promise.all([
      runCommand([...cmd, "plugin", "validate", dir, "--json"], { timeoutMs: CHECK_TIMEOUT_MS, env: claudeEnv(), cwd: work }),
      claudeVersion(cmd, stamp),
    ]);
    const report = parseReport(res.stdout, dir, files, version);
    if (report) return report;
    const said = stripAnsi(res.stderr || res.stdout).trim().slice(0, 400);
    log.warn("the mod check gave no report", { timedOut: res.timedOut, code: res.code, said });
    return {
      ok: false,
      errors: [
        {
          where: "Claude Code",
          message: res.timedOut
            ? "Claude Code took too long to check this mod. Try again."
            : `This Claude Code can't check mods${said ? ` (${said})` : ""}. Update Claude Code under Settings → System and check again.`,
        },
      ],
      warnings: [],
      hooks: [],
      calls: [],
      commandHooks: hasCommandHooks(files),
      claudeVersion: version,
      checkedAt: now(),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

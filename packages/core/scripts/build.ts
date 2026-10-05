#!/usr/bin/env bun
/**
 * Compiles the core daemon into a standalone executable (`bun build --compile`).
 *
 *   bun run scripts/build.ts                     standalone server for this machine, web UI embedded → bin/godmode
 *   bun run scripts/build.ts --target=bun-linux-arm64         → bin/godmode-linux-arm64
 *   bun run scripts/build.ts --all                            → bin/godmode-<os>-<arch>[.exe] for every release target
 *   bun run scripts/build.ts --sidecar                        → apps/desktop/src-tauri/binaries/godmode-core-<rust triple>
 *   bun run scripts/build.ts --sidecar --target=bun-darwin-x64
 *
 * Options:
 *   --target=bun-<os>-<arch>[-baseline|-modern][-musl]   cross-compile (default: host)
 *   --sidecar        desktop sidecar without UI, named for Tauri's externalBin
 *   --all            every release target (server: SERVER_TARGETS, sidecar: SIDECAR_TARGETS)
 *   --ui=<dir>       web UI to embed (default: apps/desktop/dist)
 *   --no-bytecode    skip the JSC bytecode cache
 *   --smoke          run the host binary: `version`, and for server builds `serve` + fetch `/` and an asset
 *
 * Embedded UI files are named `bin/.embed/ui/<path>`; server/static.ts serves every embedded file whose name
 * contains "ui/". macOS targets also embed the computer helper (`bin/.embed/native/godmode-computer`).
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const coreDir = resolve(import.meta.dir, "..");
const repoDir = resolve(coreDir, "../..");
const binDir = join(coreDir, "bin");
const sidecarDir = join(repoDir, "apps/desktop/src-tauri/binaries");
const embedDir = join(binDir, ".embed");

const SERVER_TARGETS = [
  "bun-linux-x64",
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
];
const SIDECAR_TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64", "bun-windows-x64"];

interface Target {
  bun: string;
  os: "darwin" | "linux" | "windows";
  arch: "x64" | "arm64";
  /** "-baseline", "-musl", … as given */
  variant: string;
}

const RUST_TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "windows-x64": "x86_64-pc-windows-msvc",
  "windows-arm64": "aarch64-pc-windows-msvc",
};

class BuildError extends Error {}

/** "<commit>[+changes] <date>" of the checkout that is built; "unknown" outside a git checkout. */
function buildStamp(): string {
  const git = (...args: string[]) => {
    // Without git installed (the Docker build stage) spawning throws instead of failing.
    try {
      const res = Bun.spawnSync(["git", ...args], { cwd: repoDir, stdout: "pipe", stderr: "ignore" });
      return res.exitCode === 0 ? res.stdout.toString().trim() : null;
    } catch {
      return null;
    }
  };
  const commit = git("rev-parse", "--short", "HEAD");
  if (!commit) return "unknown";
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  return `${commit}${dirty ? "+changes" : ""} ${new Date().toISOString().slice(0, 10)}`;
}

function fail(message: string): never {
  throw new BuildError(message);
}

function parseTarget(bun: string): Target {
  const m = /^bun-(darwin|linux|windows)-(x64|arm64)((?:-(?:baseline|modern|musl))*)$/.exec(bun);
  if (!m) fail(`unsupported target "${bun}" (expected bun-<darwin|linux|windows>-<x64|arm64>[-baseline|-modern][-musl])`);
  return { bun, os: m[1] as Target["os"], arch: m[2] as Target["arch"], variant: m[3] ?? "" };
}

function hostTarget(): Target {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch;
  if (!["darwin", "linux", "windows"].includes(os) || !["x64", "arm64"].includes(arch)) {
    fail(`unsupported host ${process.platform}/${process.arch}`);
  }
  return parseTarget(`bun-${os}-${arch}`);
}

function isHost(t: Target): boolean {
  const h = hostTarget();
  return t.os === h.os && t.arch === h.arch && !t.variant.includes("musl");
}

function rustTriple(t: Target, explicit: boolean): string {
  // Without --target, trust rustc so the name always matches what `cargo`/`tauri build` expect on this machine.
  if (!explicit) {
    const rustc = Bun.spawnSync(["rustc", "--print", "host-tuple"], { stdout: "pipe", stderr: "ignore" });
    const triple = rustc.exitCode === 0 ? rustc.stdout.toString().trim() : "";
    if (triple) return triple;
  }
  const base = RUST_TRIPLES[`${t.os}-${t.arch}`];
  if (!base) fail(`no Rust target triple known for ${t.bun}`);
  return t.variant.includes("musl") ? base.replace("-gnu", "-musl") : base;
}

function outputPath(t: Target, sidecar: boolean, explicit: boolean): string {
  const exe = t.os === "windows" ? ".exe" : "";
  if (sidecar) return join(sidecarDir, `godmode-core-${rustTriple(t, explicit)}${exe}`);
  if (!explicit) return join(binDir, `godmode${exe}`);
  return join(binDir, `godmode-${t.os}-${t.arch}${t.variant}${exe}`);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

/** Copies the UI into bin/.embed/ui and returns the `import … with { type: "file" }` lines that embed every file. */
function stageUi(uiDir: string): string[] {
  if (!existsSync(join(uiDir, "index.html"))) {
    fail(`no web UI at ${uiDir} — build it first: pnpm --filter @godmode/desktop build`);
  }
  const stagedUi = join(embedDir, "ui");
  const imports: string[] = [];
  for (const file of listFiles(uiDir)) {
    const rel = relative(uiDir, file);
    const dest = join(stagedUi, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(file));
    imports.push(`import ${JSON.stringify("./ui/" + rel.split(sep).join("/"))} with { type: "file" };`);
  }
  return imports;
}

/**
 * Compiles the macOS computer helper (native/macos/GodmodeComputer.swift) as a universal binary (arm64 + x86_64)
 * into bin/.embed/native and returns its import line. The core extracts it on first use (src/computer/helper.ts).
 * Needs macOS with the Xcode Command Line Tools; elsewhere the macOS build ships without it.
 */
function stageHelper(): string | null {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/xcrun")) {
    console.warn("  ! macOS targets are built without the computer helper (it needs macOS + Xcode Command Line Tools)");
    return null;
  }
  const source = join(coreDir, "native/macos/GodmodeComputer.swift");
  const out = join(embedDir, "native", "godmode-computer");
  mkdirSync(dirname(out), { recursive: true });
  const slices: string[] = [];
  for (const arch of ["arm64", "x86_64"]) {
    const slice = `${out}-${arch}`;
    const res = Bun.spawnSync(
      ["/usr/bin/xcrun", "swiftc", "-O", "-swift-version", "5", "-target", `${arch}-apple-macos13.0`, source, "-o", slice],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (res.exitCode !== 0) fail(`computer helper build failed (${arch}):\n${res.stderr.toString()}`);
    slices.push(slice);
  }
  const lipo = Bun.spawnSync(["/usr/bin/xcrun", "lipo", "-create", "-output", out, ...slices], { stdout: "pipe", stderr: "pipe" });
  if (lipo.exitCode !== 0) fail(`lipo failed: ${lipo.stderr.toString()}`);
  for (const slice of slices) rmSync(slice, { force: true });
  console.log(`Embedding the computer helper (${(statSync(out).size / 1024).toFixed(0)} KB, universal)`);
  return `import "./native/godmode-computer" with { type: "file" };`;
}

/** Entry module that embeds files, then starts the core. */
function writeEntry(name: string, imports: string[]): string {
  const entry = join(embedDir, name);
  const core = "./" + relative(embedDir, join(coreDir, "src/index.ts")).split(sep).join("/");
  mkdirSync(embedDir, { recursive: true });
  writeFileSync(entry, `// Generated by scripts/build.ts: embeds files, then starts the core.\n${imports.join("\n")}\nimport ${JSON.stringify(core)};\n`);
  return entry;
}

async function compile(opts: {
  target: Target;
  entry: string;
  outfile: string;
  sidecar: boolean;
  bytecode: boolean;
  version: string;
}): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  mkdirSync(dirname(opts.outfile), { recursive: true });
  const windows =
    opts.target.os === "windows" && process.platform === "win32"
      ? {
          title: "Godmode Bot",
          publisher: "Codext GmbH",
          version: `${opts.version}.0`,
          description: opts.sidecar ? "Godmode Bot core" : "Godmode Bot server",
          copyright: "© 2026 Codext GmbH",
          icon: join(repoDir, "apps/desktop/src-tauri/icons/icon.ico"),
        }
      : undefined;
  let result: Bun.BuildOutput;
  try {
    result = await Bun.build({
      entrypoints: [opts.entry],
      root: coreDir,
      compile: {
        target: opts.target.bun as Bun.Build.CompileTarget,
        outfile: opts.outfile,
        // The sidecar starts in the user's home: never pick up a stray .env or bunfig.toml there.
        autoloadDotenv: !opts.sidecar,
        autoloadBunfig: false,
        ...(windows ? { windows } : {}),
      },
      format: "esm",
      // ssh2's optional native helper (never built): ssh2 loads it in a try/catch and uses pure JavaScript without it.
      external: ["cpu-features"],
      minify: true,
      sourcemap: "linked",
      bytecode: opts.bytecode,
      naming: { asset: "[dir]/[name].[ext]" },
      // GODMODE_BUILD: which commit this binary is (every build of a version says the same number otherwise).
      define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env.GODMODE_BUILD": JSON.stringify(buildStamp()) },
      throw: false,
    });
  } catch (err) {
    // Older Bun versions throw an AggregateError instead of returning the logs.
    const errors = err instanceof AggregateError ? err.errors : [err];
    return { ok: false, errors: errors.map(String) };
  }
  // The source map is embedded in the executable; the copy on disk is not needed.
  for (const out of result.outputs) if (out.path.endsWith(".map")) rmSync(out.path, { force: true });
  if (!result.success) return { ok: false, errors: result.logs.map(String) };
  return { ok: true };
}

function smokeVersion(bin: string, version: string) {
  const res = Bun.spawnSync([bin, "version"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const out = res.stdout.toString().trim();
  if (res.exitCode !== 0 || out !== version) {
    fail(`smoke test failed: \`${bin} version\` → exit ${res.exitCode}, "${out}" ${res.stderr.toString()}`);
  }
  console.log(`  ✓ ${relative(repoDir, bin)} version → ${out}`);
}

async function smokeServe(bin: string) {
  const home = mkdtempSync(join(tmpdir(), "godmode-smoke-"));
  const proc = Bun.spawn([bin, "serve", "--port", "0"], {
    env: { ...process.env, GODMODE_HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let url: string | null = null;
    const deadline = Date.now() + 30_000;
    while (!url && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
      if (!chunk || chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const line = buffered.split("\n").find((l) => l.startsWith("GODMODE_READY "));
      if (line) url = JSON.parse(line.slice("GODMODE_READY ".length)).url;
    }
    reader.releaseLock();
    if (!url) fail(`smoke test failed: ${bin} serve never printed GODMODE_READY`);

    const index = await fetch(`${url}/`);
    const html = await index.text();
    if (!index.ok || !html.includes('<div id="root">')) fail(`smoke test failed: GET / → ${index.status}`);
    const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html)?.[1];
    if (asset) {
      const res = await fetch(url + asset);
      if (!res.ok || (await res.arrayBuffer()).byteLength === 0) fail(`smoke test failed: GET ${asset} → ${res.status}`);
      console.log(`  ✓ serve: GET / (${html.length} B) and ${asset} (${res.headers.get("content-type")})`);
    } else {
      console.log(`  ✓ serve: GET / (${html.length} B)`);
    }
  } finally {
    proc.stdin.end();
    proc.kill("SIGTERM");
    await Promise.race([proc.exited, Bun.sleep(5_000)]);
    if (proc.exitCode === null) proc.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      target: { type: "string" },
      sidecar: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      ui: { type: "string" },
      "no-bytecode": { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
    },
  });
  if (values.all && values.target) fail("use either --all or --target");

  const version = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")).version as string;
  const sidecar = values.sidecar;
  const explicit = Boolean(values.target || values.all);
  const targets = values.all
    ? (sidecar ? SIDECAR_TARGETS : SERVER_TARGETS).map(parseTarget)
    : [values.target ? parseTarget(values.target) : hostTarget()];

  rmSync(embedDir, { recursive: true, force: true });
  const uiImports: string[] = [];
  if (!sidecar) {
    const uiDir = resolve(values.ui ?? join(repoDir, "apps/desktop/dist"));
    uiImports.push(...stageUi(uiDir));
    console.log(`Embedding ${uiImports.length} UI files from ${relative(repoDir, uiDir)}`);
  }
  const helper = targets.some((t) => t.os === "darwin") ? stageHelper() : null;
  const plainEntry = uiImports.length ? writeEntry("entry.ts", uiImports) : join(coreDir, "src/index.ts");
  const darwinEntry = helper ? writeEntry("entry-darwin.ts", [...uiImports, helper]) : plainEntry;

  try {
    for (const target of targets) {
      const outfile = outputPath(target, sidecar, explicit);
      const started = performance.now();
      let bytecode = !values["no-bytecode"];
      const entry = target.os === "darwin" ? darwinEntry : plainEntry;
      let res = await compile({ target, entry, outfile, sidecar, bytecode, version });
      if (!res.ok && bytecode) {
        const first = res.errors;
        bytecode = false;
        res = await compile({ target, entry, outfile, sidecar, bytecode, version });
        if (res.ok) console.warn(`  ! bytecode build failed for ${target.bun}, built without it:\n    ${first.join("\n    ")}`);
      }
      if (!res.ok) {
        for (const error of res.errors) console.error(error);
        fail(`build failed for ${target.bun}`);
      }
      const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`✓ ${target.bun.padEnd(24)} → ${relative(repoDir, outfile)} (${mb} MB, ${secs}s${bytecode ? ", bytecode" : ""})`);

      if (values.smoke && isHost(target)) {
        smokeVersion(outfile, version);
        if (!sidecar) await smokeServe(outfile);
      }
    }
  } finally {
    rmSync(embedDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(`\n✖ ${err instanceof BuildError ? err.message : err instanceof Error ? (err.stack ?? err.message) : err}\n`);
  process.exit(1);
}

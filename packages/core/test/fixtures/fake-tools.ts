/**
 * Fake `claude`, `uv`, `uvx` and browser for the system upkeep tests (permissions, updates, maintenance). Their
 * state lives in files next to them: `claude-version`, `uv-version`, `*-target` (what an update installs),
 * `uv-offline` (the updater can't reach its server), `browser-use-ready` (the pinned browser-use is "downloaded"),
 * `browser-use-broken` / `browser-use-noop` (its download fails / "succeeds" without leaving anything),
 * `playwright-dry-run` / `playwright-location` (what the newest Playwright would install, and where), `logged-out`,
 * `calls.log` (every update/install) and `probes.log` (every look at what the newest Playwright has).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLAUDE = `#!/bin/sh
DIR="$(dirname "$0")"
case "$1" in
  --version) echo "$(cat "$DIR/claude-version") (Claude Code)" ;;
  auth) if [ -f "$DIR/logged-out" ]; then echo '{"loggedIn": false}'; else echo '{"loggedIn": true, "authMethod": "claude.ai"}'; fi ;;
  update)
    echo "claude update" >> "$DIR/calls.log"
    if [ -f "$DIR/claude-target" ]; then cp "$DIR/claude-target" "$DIR/claude-version"; echo "Successfully updated"; else echo "Update failed"; exit 1; fi ;;
esac
`;

const UV = `#!/bin/sh
DIR="$(dirname "$0")"
case "$1 $2" in
  "--version "*) echo "uv $(cat "$DIR/uv-version")" ;;
  "self update")
    echo "uv self update" >> "$DIR/calls.log"
    if [ -f "$DIR/uv-offline" ]; then echo "error: could not reach github.com" >&2; exit 2; fi
    if [ -f "$DIR/uv-target" ]; then cp "$DIR/uv-target" "$DIR/uv-version"; echo "Updated uv to $(cat "$DIR/uv-version")"
    else echo "error: Self-update is only available for uv binaries installed via the standalone installation scripts." >&2; exit 2; fi ;;
  *) echo "fake uv: unsupported: $*" >&2; exit 2 ;;
esac
`;

const UVX = `#!/bin/sh
DIR="$(dirname "$0")"
if [ "$1" = "--version" ]; then echo "uvx $(cat "$DIR/uv-version")"; exit 0; fi
OFFLINE=0
if [ "$1" = "--offline" ]; then OFFLINE=1; shift; fi
case "$1 $2" in
  "--from browser-use=="*)
    if [ "$OFFLINE" = 1 ]; then
      if [ -f "$DIR/browser-use-ready" ]; then exit 0; fi
      echo "error: browser-use was not found in the cache" >&2; exit 1
    fi
    echo "uvx $2" >> "$DIR/calls.log"
    if [ -f "$DIR/browser-use-broken" ]; then echo "error: Failed to fetch $2" >&2; exit 1; fi
    if [ -f "$DIR/browser-use-noop" ]; then echo "browser-use ready"; exit 0; fi
    touch "$DIR/browser-use-ready"; echo "browser-use ready"; exit 0 ;;
  "playwright@latest install")
    if [ "$5" = "--dry-run" ]; then echo "playwright dry-run" >> "$DIR/probes.log"; cat "$DIR/playwright-dry-run"; exit 0; fi
    echo "uvx playwright install" >> "$DIR/calls.log"
    LOCATION="$(cat "$DIR/playwright-location")"
    mkdir -p "$LOCATION"; touch "$LOCATION/INSTALLATION_COMPLETE"; echo "Downloaded"; exit 0 ;;
  *) echo "fake uvx: unsupported: $*" >&2; exit 2 ;;
esac
`;

const BROWSER = `#!/bin/sh
echo "Chromium 141.0.0.0"
`;

export interface FakeTools {
  dir: string;
  claude: string;
  uv: string;
  uvx: string;
  browser: string;
  set(name: string, value: string | null): void;
  /** Every update/install the fakes were asked to do, in order. */
  calls(): string[];
  /** Every time the newest Playwright was asked what it would install. */
  probes(): string[];
}

export function fakeTools(dir: string): FakeTools {
  mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  };
  const lines = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean) : []);
  const tools: FakeTools = {
    dir,
    claude: script("claude", CLAUDE),
    uv: script("uv", UV),
    uvx: script("uvx", UVX),
    browser: script("chromium", BROWSER),
    set(name, value) {
      if (value === null) rmSync(join(dir, name), { force: true });
      else writeFileSync(join(dir, name), value);
    },
    calls: () => lines("calls.log"),
    probes: () => lines("probes.log"),
  };
  tools.set("claude-version", "2.1.274");
  tools.set("uv-version", "0.9.0");
  return tools;
}

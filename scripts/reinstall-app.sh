#!/usr/bin/env bash
# Rebuilds the Godmode Bot desktop app and reinstalls it on macOS:
# builds a fresh release .app, quits the running app, replaces the installed copy and starts it.
#
#   scripts/reinstall-app.sh            (or: pnpm reinstall:app)
#
# The build runs before the running app is quit, so a failed build leaves it untouched.
#
# Environment:
#   GODMODE_APP_DIR   install directory (default: /Applications)
set -euo pipefail

APP_NAME="Godmode Bot"
BUNDLE_ID="dev.codext.godmode"
APP_BINARY="$APP_NAME.app/Contents/MacOS/godmode-bot"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILT_APP="$REPO_DIR/apps/desktop/src-tauri/target/release/bundle/macos/$APP_NAME.app"
INSTALL_DIR="${GODMODE_APP_DIR:-/Applications}"
INSTALLED_APP="$INSTALL_DIR/$APP_NAME.app"

say() { printf '==> %s\n' "$*"; }
err() { printf 'reinstall-app: %s\n' "$*" >&2; exit 1; }

# True while any of the given pids is still running.
alive() {
  local pid
  for pid in "$@"; do kill -0 "$pid" 2>/dev/null && return 0; done
  return 1
}

# Waits up to $1 seconds for the remaining pids to exit.
wait_exit() {
  local deadline=$((SECONDS + $1))
  shift
  while alive "$@"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.2
  done
}

# Quits every running Godmode Bot (installed, release or debug bundle). A regular quit lets the app stop its
# core daemon cleanly (up to 6s); whatever is left after that is terminated, then killed.
quit_app() {
  local pids children pid
  pids=$(pgrep -f "$APP_BINARY" || true)
  if [ -z "$pids" ]; then
    say "$APP_NAME is not running"
    return
  fi
  # The core runs as a direct child of the app, in its own process group.
  children=$(for pid in $pids; do pgrep -P "$pid" || true; done)

  say "Quitting $APP_NAME"
  # shellcheck disable=SC2086 # pid lists are meant to be split
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || kill -TERM $pids 2>/dev/null || true
  # shellcheck disable=SC2086
  wait_exit 12 $pids $children && return

  say "$APP_NAME did not quit in time, terminating it"
  # shellcheck disable=SC2086
  kill -TERM $pids $children 2>/dev/null || true
  # shellcheck disable=SC2086
  wait_exit 4 $pids $children && return

  say "Killing $APP_NAME"
  for pid in $children; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  # shellcheck disable=SC2086
  kill -KILL $pids $children 2>/dev/null || true
  # shellcheck disable=SC2086
  wait_exit 2 $pids $children || err "could not stop $APP_NAME, quit it manually and run again"
}

[ "$(uname -s)" = Darwin ] || err "macOS only"
[ -d "$INSTALL_DIR" ] || err "install directory $INSTALL_DIR does not exist"
[ -w "$INSTALL_DIR" ] || err "$INSTALL_DIR is not writable (set GODMODE_APP_DIR, e.g. ~/Applications)"

cd "$REPO_DIR"

say "Building core sidecar"
pnpm build:sidecar

say "Building $APP_NAME.app (release)"
# The bundler runs `xattr -crs`; Homebrew's Python `xattr` (often first on PATH) has no -r, so use Apple's.
XATTR_SHIM="$(mktemp -d)"
trap 'rm -rf "$XATTR_SHIM"' EXIT
ln -s /usr/bin/xattr "$XATTR_SHIM/xattr"
PATH="$XATTR_SHIM:$PATH" pnpm --filter @godmode/desktop tauri build --bundles app
[ -d "$BUILT_APP" ] || err "build finished but $BUILT_APP is missing"

quit_app

say "Installing to $INSTALLED_APP"
rm -rf "$INSTALLED_APP"
ditto "$BUILT_APP" "$INSTALLED_APP"

say "Starting $APP_NAME"
open "$INSTALLED_APP"

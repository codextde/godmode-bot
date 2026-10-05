#!/bin/sh
# Sets this computer up as a Godmode runner: installs the standalone `godmode` binary (macOS or Linux) and starts
# the runner, which then works for the Godmode on your own computer — also while that one sleeps.
#
#   curl -fsSL https://usegodmode.com/runner.sh | GODMODE_LICENSE=GM-XXXXX-XXXXX-XXXXX-XXXXX GODMODE_PAIR=gmo1.… sh
#
# Environment:
#   GODMODE_LICENSE       your license key (welcome page, invoice or billing portal) — required
#   GODMODE_PAIR          pairing offer from Godmode → Runners → Add runner (pairs right after the install)
#   GODMODE_VERSION       release tag to install, e.g. v0.2.0 (default: latest)
#   GODMODE_INSTALL_DIR   target directory (default: ~/.local/bin)
#
# This is scripts/install.sh plus the last step. The two share nothing by sourcing: each is piped to `sh` on its own.
set -eu

SITE="https://usegodmode.com"
LICENSE_KEY="${GODMODE_LICENSE:-}"
VERSION="${GODMODE_VERSION:-latest}"
INSTALL_DIR="${GODMODE_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
err() { printf 'godmode runner install: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

download() { # url dest
  if has curl; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
  elif has wget; then
    wget --https-only -q -O "$2" "$1"
  else
    err "curl or wget is required"
  fi
}

sha256() {
  if has sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ""
  fi
}

os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) err "on Windows, download the headless server from $SITE/download" ;;
  *) err "unsupported operating system: $os" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "unsupported CPU architecture: $arch" ;;
esac

# An x64 shell under Rosetta 2 on Apple Silicon: install the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

if [ "$os" = linux ]; then
  if ldd --version 2>&1 | grep -qi musl; then
    err "musl-based distributions (e.g. Alpine) are not supported; use the Docker image"
  fi
  # CPUs without AVX2 need the baseline build.
  if [ "$arch" = x64 ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
    arch=x64-baseline
  fi
fi

[ -n "$LICENSE_KEY" ] || err "set GODMODE_LICENSE to your license key — get one at $SITE"

asset="godmode-$os-$arch"
case "$VERSION" in latest | v*) ;; *) VERSION="v$VERSION" ;; esac
query="key=$LICENSE_KEY&version=$VERSION"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t godmode)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset ($VERSION)…"
download "$SITE/download/file/$asset?$query" "$tmp/godmode" || err "download failed — check your license key ($SITE/download)"

if download "$SITE/download/file/$asset.sha256?$query" "$tmp/godmode.sha256" 2>/dev/null; then
  expected=$(cut -d' ' -f1 < "$tmp/godmode.sha256")
  actual=$(sha256 "$tmp/godmode")
  if [ -z "$actual" ]; then
    say "warning: no sha256sum/shasum found, skipping checksum verification"
  elif [ "$expected" != "$actual" ]; then
    err "checksum mismatch for $asset (expected $expected, got $actual)"
  fi
else
  say "warning: no checksum published for $asset, skipping verification"
fi

chmod 755 "$tmp/godmode"
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$tmp/godmode" 2>/dev/null || true
fi

mkdir -p "$INSTALL_DIR"
mv -f "$tmp/godmode" "$INSTALL_DIR/godmode"

installed=$("$INSTALL_DIR/godmode" version 2>/dev/null) || err "the installed binary does not run: $INSTALL_DIR/godmode"
say "Installed Godmode Bot $installed → $INSTALL_DIR/godmode"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "$INSTALL_DIR is not on your PATH. Add it, e.g.:"
    say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile"
    ;;
esac

say ""
say "Setting up the runner…"
# stdin is this script while it is piped to sh: keep it away from the binary.
"$INSTALL_DIR/godmode" runner install ${GODMODE_PAIR:+--pair "$GODMODE_PAIR"} < /dev/null \
  || err "the runner could not be set up — see above, then run: $INSTALL_DIR/godmode runner install"

say ""
say "Check on it any time:"
say "  godmode runner status               # service, link port and health checks"

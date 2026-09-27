#!/bin/sh
# Installs the standalone Godmode Bot server (`godmode`) on Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/codextde/godmode-bot/main/scripts/install.sh | sh
#
# Environment:
#   GODMODE_VERSION       release tag to install, e.g. v0.2.0 (default: latest)
#   GODMODE_INSTALL_DIR   target directory (default: ~/.local/bin)
#
# Then: `godmode doctor` to check dependencies and `godmode serve --host 0.0.0.0` for the web dashboard.
set -eu

REPO="codextde/godmode-bot"
VERSION="${GODMODE_VERSION:-latest}"
INSTALL_DIR="${GODMODE_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
err() { printf 'godmode install: %s\n' "$*" >&2; exit 1; }
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
  MINGW* | MSYS* | CYGWIN*) err "on Windows, download godmode-windows-x64.exe from https://github.com/$REPO/releases" ;;
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
    err "musl-based distributions (e.g. Alpine) are not supported; use the Docker image ghcr.io/$REPO"
  fi
  # CPUs without AVX2 need the baseline build.
  if [ "$arch" = x64 ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
    arch=x64-baseline
  fi
fi

asset="godmode-$os-$arch"
if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t godmode)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset ($VERSION)…"
download "$base/$asset" "$tmp/godmode" || err "download failed: $base/$asset"

if download "$base/$asset.sha256" "$tmp/godmode.sha256" 2>/dev/null; then
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
say "Next steps:"
say "  godmode doctor                      # check Claude Code, uv, Chrome and git"
say "  godmode serve --host 0.0.0.0        # start the web dashboard on port 7777"
say "  godmode token                       # print the dashboard access token"

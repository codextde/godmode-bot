#!/usr/bin/env bash
# linuxdeploy sets an rpath on every ELF file in the AppDir. On arm64 that rewrite makes the Bun-compiled sidecar
# segfault (and ldd fail, which aborts the AppImage build). The sidecar only links libc, so it needs no rpath.
set -euo pipefail
if [ "${1:-}" = "--set-rpath" ] && [[ "${!#}" == */godmode-core ]]; then
  exit 0
fi
exec /usr/bin/patchelf "$@"

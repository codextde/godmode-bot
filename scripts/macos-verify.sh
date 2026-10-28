#!/usr/bin/env bash
# Fails unless every given macOS download opens without a Gatekeeper prompt: signed with the Developer ID of
# Codext GmbH, hardened runtime, secure timestamp, and (apps and DMGs) notarized with a stapled ticket.
#
#   scripts/macos-verify.sh <file.dmg | file.app | file.app.tar.gz | binary>...
#
# APPLE_TEAM_ID (default STSYBH724K) is the team the signature must belong to; CERT_WARN_DAYS (default 45) warns
# when the signing certificate runs out soon, and the check fails once it has.
set -euo pipefail

TEAM="${APPLE_TEAM_ID:-STSYBH724K}"
WARN_DAYS="${CERT_WARN_DAYS:-45}"
WORK="$(mktemp -d)"
MOUNTS=()
cleanup() {
  for m in "${MOUNTS[@]:-}"; do [ -n "$m" ] && hdiutil detach "$m" -quiet -force 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "::error::$*"
  exit 1
}

signer() {
  local path="$1" kind="${2:-code}" info
  info="$(codesign -dvv "$path" 2>&1)" || fail "$path is not signed"
  grep -q "^Authority=Developer ID Application: .*($TEAM)$" <<<"$info" ||
    fail "$path is not signed with a Developer ID of team $TEAM ($(grep -m1 -E '^(Authority|Signature)=' <<<"$info" || echo unsigned))"
  grep -q "^TeamIdentifier=$TEAM$" <<<"$info" || fail "$path has another team identifier"
  [ "$kind" = disk ] || grep -q "flags=.*runtime" <<<"$info" || fail "$path is signed without the hardened runtime (notarization needs it)"
  grep -q "^Timestamp=" <<<"$info" || fail "$path has no secure timestamp"
  codesign --verify --strict --verbose=2 "$path"
  certificate "$path"
  echo "  signed: $(grep -m1 '^Authority=' <<<"$info" | cut -d= -f2-)"
}

certificate() {
  local dir="$WORK/certs-$RANDOM"
  mkdir -p "$dir"
  (cd "$dir" && codesign -d --extract-certificates "$1" 2>/dev/null)
  local leaf="$dir/codesign0"
  [ -f "$leaf" ] || fail "could not read the signing certificate of $1"
  local until
  until="$(openssl x509 -inform DER -in "$leaf" -noout -enddate | cut -d= -f2)"
  # The signatures stay valid after expiry thanks to the timestamp, but new releases can no longer be signed.
  openssl x509 -inform DER -in "$leaf" -noout -checkend 0 >/dev/null || fail "the Developer ID certificate expired on $until: create a new one (see the top of release.yml)"
  if ! openssl x509 -inform DER -in "$leaf" -noout -checkend $((WARN_DAYS * 86400)) >/dev/null; then
    echo "::warning::the Developer ID certificate expires on $until: renew it and update APPLE_CERTIFICATE before then"
  fi
}

gatekeeper() {
  local out
  out="$(spctl --assess --verbose=2 "$@" 2>&1)" || fail "Gatekeeper rejects ${*: -1}: $out"
  grep -q "source=Notarized Developer ID" <<<"$out" || fail "${*: -1} is not notarized: $out"
}

app() {
  local path="$1"
  echo "app: $path"
  signer "$path"
  codesign --verify --deep --strict --verbose=2 "$path"
  xcrun stapler validate "$path" >/dev/null || fail "$path has no stapled notarization ticket"
  gatekeeper --type execute "$path"
  if command -v syspolicy_check >/dev/null; then
    syspolicy_check distribution "$path" || fail "syspolicy_check rejects $path"
  fi
}

dmg() {
  local path="$1" mnt
  echo "dmg: $path"
  signer "$path" disk
  xcrun stapler validate "$path" >/dev/null || fail "$path has no stapled notarization ticket"
  gatekeeper --type open --context context:primary-signature "$path"
  mnt="$WORK/mnt-$RANDOM"
  mkdir -p "$mnt"
  # The DMG carries a licence agreement: `yes` accepts it like a click on Agree.
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$path" < <(yes) >/dev/null || fail "could not open $path"
  MOUNTS+=("$mnt")
  local found=0
  for a in "$mnt"/*.app; do
    [ -d "$a" ] || continue
    found=1
    app "$a"
  done
  [ "$found" = 1 ] || fail "$path contains no app"
}

tarball() {
  local path="$1" dir="$WORK/tar-$RANDOM"
  echo "update bundle: $path"
  mkdir -p "$dir"
  tar -xzf "$path" -C "$dir"
  local found=0
  for a in "$dir"/*.app; do
    [ -d "$a" ] || continue
    found=1
    app "$a"
  done
  [ "$found" = 1 ] || fail "$path contains no app"
}

[ $# -gt 0 ] || fail "usage: $0 <file.dmg|file.app|file.app.tar.gz|binary>..."
for target in "$@"; do
  [ -e "$target" ] || fail "$target does not exist"
  case "$target" in
    *.dmg) dmg "$target" ;;
    *.app) app "$target" ;;
    *.tar.gz) tarball "$target" ;;
    *)
      # A command-line binary: Gatekeeper checks its notarization online (a ticket can't be stapled to it).
      echo "binary: $target"
      signer "$target"
      ;;
  esac
done
echo "All macOS downloads pass Gatekeeper."

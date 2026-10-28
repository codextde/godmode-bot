#!/usr/bin/env bash
# Signs standalone macOS binaries with the Developer ID (hardened runtime, timestamp) and notarizes them, so a
# browser download opens without "can't be opened, move to the Trash". A bare binary can't carry a stapled ticket:
# Gatekeeper looks the notarization up online.
#
#   scripts/macos-sign-binaries.sh <binary>...
#
# Env: APPLE_CERTIFICATE (base64 .p12), APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,
#      APPLE_API_KEY_PATH (.p8), APPLE_API_KEY (key id), APPLE_API_ISSUER.
set -euo pipefail

for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_API_KEY_PATH APPLE_API_KEY APPLE_API_ISSUER; do
  [ -n "${!name:-}" ] || { echo "::error::$name is not set"; exit 1; }
done

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
keychain="$work/signing.keychain-db"
pass="$(openssl rand -hex 16)"
old_keychains=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line#\"}"
  line="${line%\"}"
  [ -n "$line" ] && old_keychains+=("$line")
done < <(security list-keychains -d user)
cleanup() {
  security list-keychains -d user -s "${old_keychains[@]}" >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$work/cert.p12"
security create-keychain -p "$pass" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$pass" "$keychain"
security import "$work/cert.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${old_keychains[@]}"

for bin in "$@"; do
  codesign --force --options runtime --timestamp --entitlements "$here/macos/binary.entitlements" \
    --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" "$bin"
  zip="$work/$(basename "$bin").zip"
  ditto -c -k --keepParent "$bin" "$zip"
  result="$(xcrun notarytool submit "$zip" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
    --wait --timeout 30m --output-format json)"
  status="$(plutil -extract status raw -o - - <<<"$result" 2>/dev/null || echo unknown)"
  if [ "$status" != "Accepted" ]; then
    id="$(plutil -extract id raw -o - - <<<"$result" 2>/dev/null || true)"
    echo "::error::notarization of $bin: $status"
    [ -n "$id" ] && xcrun notarytool log "$id" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" || true
    exit 1
  fi
  echo "signed and notarized: $bin"
done

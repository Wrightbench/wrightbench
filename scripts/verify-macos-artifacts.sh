#!/usr/bin/env bash
# Verify the signed, notarized macOS release artifacts for one architecture.
#
#   bash scripts/verify-macos-artifacts.sh <version> <arm64|x64>
#
# Runs on macOS only. Checks the actual shipped artifacts (the DMG and the
# ZIP), mounting/extracting them into a temporary directory — not the
# prepackaged working directory. Fails when signing, notarization, or
# stapling is missing, so an unsigned or unnotarized build can never be
# published under a production tag.
set -euo pipefail

VERSION="${1:?usage: verify-macos-artifacts.sh <version> <arm64|x64>}"
ARCH="${2:?usage: verify-macos-artifacts.sh <version> <arm64|x64>}"

case "$ARCH" in
  arm64) LIPO_ARCH="arm64" ;;
  x64) LIPO_ARCH="x86_64" ;;
  *) echo "error: unknown arch '$ARCH'" >&2; exit 1 ;;
esac

DMG="release/Wrightbench-$VERSION-mac-$ARCH.dmg"
ZIP="release/Wrightbench-$VERSION-mac-$ARCH.zip"

fail() { echo "error: $*" >&2; exit 1; }

[ -f "$DMG" ] || fail "missing expected artifact: $DMG"
[ -f "$ZIP" ] || fail "missing expected artifact: $ZIP"

WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wb-verify-XXXXXX")"
MOUNTPOINT="$WORK/mnt"
MOUNTED=0

cleanup() {
  # Always detach the disk image, even on failure.
  if [ "$MOUNTED" = 1 ]; then
    hdiutil detach "$MOUNTPOINT" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

require_line() { # require_line <label> <needle> <haystack-file>
  grep -qF -- "$2" "$3" || { echo "--- output was:"; cat "$3"; fail "$1: expected '$2'"; }
}

verify_app() { # verify_app <path-to-.app> <origin label>
  local app="$1" label="$2" out="$WORK/codesign-info.txt" spctl_out="$WORK/spctl.txt"
  echo "== verifying app from $label: $app"

  codesign --verify --deep --strict --verbose=4 "$app" \
    || fail "$label: codesign --verify --deep --strict failed"

  codesign -dv --verbose=4 "$app" >"$out" 2>&1 || fail "$label: codesign -dv failed"
  require_line "$label app signature" "Authority=Developer ID Application" "$out"
  require_line "$label app hardened runtime" "(runtime)" "$out"
  require_line "$label app secure timestamp" "Timestamp=" "$out"

  xcrun stapler validate "$app" || fail "$label: notarization ticket is not stapled to the app"

  spctl --assess --type execute --verbose=4 "$app" >"$spctl_out" 2>&1 \
    || { cat "$spctl_out"; fail "$label: Gatekeeper rejected the app"; }
  cat "$spctl_out"
  if grep -q "Unnotarized" "$spctl_out"; then
    fail "$label: Gatekeeper reports Unnotarized Developer ID"
  fi
  require_line "$label Gatekeeper assessment" "accepted" "$spctl_out"
  require_line "$label Gatekeeper source" "source=Notarized Developer ID" "$spctl_out"

  local exe="$app/Contents/MacOS/Wrightbench"
  [ -f "$exe" ] || fail "$label: main executable missing at $exe"
  local archs
  archs="$(lipo -archs "$exe")"
  [ "$archs" = "$LIPO_ARCH" ] || fail "$label: main executable archs '$archs' != expected '$LIPO_ARCH'"

  # better-sqlite3 13.x ships prebuilds for every platform and its loader
  # picks prebuilds/darwin-<arch>.node at runtime — verify exactly the
  # binary this build will load (the foreign-platform prebuilds are inert).
  local native="$app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-$ARCH.node"
  [ -f "$native" ] || fail "$label: better-sqlite3 native module not found at $native"
  archs="$(lipo -archs "$native")"
  [ "$archs" = "$LIPO_ARCH" ] || fail "$label: better-sqlite3 native module archs '$archs' != expected '$LIPO_ARCH'"
  echo "== $label app OK (arch $archs, native module $native)"
}

echo "== DMG integrity: $DMG"
hdiutil verify "$DMG" || fail "hdiutil verify failed for $DMG"

echo "== DMG outer signature"
codesign --verify --verbose=4 "$DMG" || fail "the DMG has no usable code signature"
codesign -dv --verbose=4 "$DMG" >"$WORK/dmg-info.txt" 2>&1 || fail "codesign -dv failed for the DMG"
require_line "DMG signature" "Authority=Developer ID Application" "$WORK/dmg-info.txt"
require_line "DMG secure timestamp" "Timestamp=" "$WORK/dmg-info.txt"

echo "== DMG notarization"
xcrun stapler validate "$DMG" || fail "notarization ticket is not stapled to the DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG" \
  >"$WORK/dmg-spctl.txt" 2>&1 || { cat "$WORK/dmg-spctl.txt"; fail "Gatekeeper rejected the DMG"; }
cat "$WORK/dmg-spctl.txt"
if grep -q "Unnotarized" "$WORK/dmg-spctl.txt"; then
  fail "Gatekeeper reports the DMG as Unnotarized Developer ID"
fi
require_line "DMG Gatekeeper assessment" "accepted" "$WORK/dmg-spctl.txt"
require_line "DMG Gatekeeper source" "source=Notarized Developer ID" "$WORK/dmg-spctl.txt"

echo "== mounting DMG"
mkdir -p "$MOUNTPOINT"
hdiutil attach "$DMG" -nobrowse -readonly -noautoopen -mountpoint "$MOUNTPOINT" >/dev/null
MOUNTED=1
[ -d "$MOUNTPOINT/Wrightbench.app" ] || fail "Wrightbench.app not found inside the mounted DMG"
verify_app "$MOUNTPOINT/Wrightbench.app" "DMG"
hdiutil detach "$MOUNTPOINT" >/dev/null
MOUNTED=0

echo "== ZIP integrity: $ZIP"
unzip -tqq "$ZIP" || fail "unzip -t failed for $ZIP"
mkdir -p "$WORK/zip"
# ditto preserves the app bundle's symlinks and permissions, unlike unzip
ditto -x -k "$ZIP" "$WORK/zip"
[ -d "$WORK/zip/Wrightbench.app" ] || fail "Wrightbench.app not found inside the ZIP"
verify_app "$WORK/zip/Wrightbench.app" "ZIP"

echo "macOS $ARCH artifacts verified: signed, notarized, stapled, Gatekeeper-accepted."

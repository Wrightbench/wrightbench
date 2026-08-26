#!/usr/bin/env bash
# Validate the staging directory assembled from the per-platform build
# artifacts before anything is published.
#
#   bash scripts/verify-release-staging.sh <version> <staging-dir>
#
# Requires exactly the expected set of release files — nothing missing,
# nothing unexpected (no blockmaps, updater metadata, builder debug files,
# or unpacked directories) — and re-runs basic format/integrity checks with
# portable tooling. Deep platform verification (codesign/spctl/stapler,
# Get-AuthenticodeSignature, dpkg-deb) already ran on the native builders;
# file permissions are not preserved by workflow artifacts, so the AppImage
# executable bit is asserted there, not here.
set -euo pipefail

VERSION="${1:?usage: verify-release-staging.sh <version> <staging-dir>}"
DIR="${2:?usage: verify-release-staging.sh <version> <staging-dir>}"

fail() { echo "error: $*" >&2; exit 1; }

[ -d "$DIR" ] || fail "staging directory '$DIR' does not exist"

EXPECTED=(
  "Wrightbench-$VERSION-mac-arm64.dmg"
  "Wrightbench-$VERSION-mac-arm64.zip"
  "Wrightbench-$VERSION-mac-x64.dmg"
  "Wrightbench-$VERSION-mac-x64.zip"
  "Wrightbench-Setup-$VERSION-win-x64.exe"
  "Wrightbench-$VERSION-linux-x86_64.AppImage"
  "wrightbench_${VERSION}_amd64.deb"
)

echo "== staging directory contents"
ls -la "$DIR"

for f in "${EXPECTED[@]}"; do
  [ -f "$DIR/$f" ] || fail "missing expected release file: $f"
done

while IFS= read -r -d '' path; do
  name="$(basename "$path")"
  found=0
  for f in "${EXPECTED[@]}"; do
    if [ "$name" = "$f" ]; then found=1; break; fi
  done
  [ "$found" = 1 ] || fail "unexpected file in staging directory: $name (refusing to publish)"
done < <(find "$DIR" -mindepth 1 -print0)

count="$(find "$DIR" -mindepth 1 | wc -l | tr -d ' ')"
[ "$count" = "${#EXPECTED[@]}" ] || fail "expected ${#EXPECTED[@]} files, found $count"

magic() { # magic <file> <skip-bytes> <count-bytes>
  dd if="$1" bs=1 skip="$2" count="$3" 2>/dev/null | od -An -tx1 | tr -d ' \n'
}

check_min_size() { # 10 MB floor guards against truncated uploads
  local size
  size="$(wc -c <"$1" | tr -d ' ')"
  [ "$size" -ge 10000000 ] || fail "$(basename "$1") is implausibly small ($size bytes)"
}

echo "== basic format checks"
for f in "${EXPECTED[@]}"; do
  path="$DIR/$f"
  check_min_size "$path"
  case "$f" in
    *.dmg)
      # UDIF disk images end with a 512-byte 'koly' trailer
      trailer="$(tail -c 512 "$path" | head -c 4)"
      [ "$trailer" = "koly" ] || fail "$f does not look like a UDIF disk image (no koly trailer)"
      ;;
    *.zip)
      [ "$(magic "$path" 0 2)" = "504b" ] || fail "$f is not a ZIP archive"
      unzip -tqq "$path" || fail "unzip -t failed for $f"
      ;;
    *.exe)
      [ "$(magic "$path" 0 2)" = "4d5a" ] || fail "$f is not a PE executable (no MZ header)"
      ;;
    *.AppImage)
      [ "$(magic "$path" 0 4)" = "7f454c46" ] || fail "$f is not an ELF binary"
      [ "$(magic "$path" 8 3)" = "414902" ] || fail "$f is missing the AppImage type-2 magic"
      ;;
    *.deb)
      [ "$(head -c 7 "$path")" = "!<arch>" ] || fail "$f is not an ar archive"
      dpkg-deb --info "$path" >/dev/null || fail "dpkg-deb --info failed for $f"
      ;;
    *) fail "no format check implemented for $f" ;;
  esac
  echo "ok  $f"
done

echo "Staging directory verified: ${#EXPECTED[@]} release files, formats OK."

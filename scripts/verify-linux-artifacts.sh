#!/usr/bin/env bash
# Structural verification of the Linux release artifacts.
#
#   bash scripts/verify-linux-artifacts.sh <version>
#
# Checks the AppImage (executable bit, magic bytes, extractable metadata,
# desktop entry, icon) and the Debian package (dpkg-deb info/contents,
# package identity, desktop entry and icons at conventional paths). Linux
# artifacts are not code-signed; they are covered by the release checksums
# and GitHub provenance attestations instead.
set -euo pipefail

VERSION="${1:?usage: verify-linux-artifacts.sh <version>}"

APPIMAGE="release/Wrightbench-$VERSION-linux-x86_64.AppImage"
DEB="release/wrightbench_${VERSION}_amd64.deb"

fail() { echo "error: $*" >&2; exit 1; }

[ -f "$APPIMAGE" ] || fail "missing expected artifact: $APPIMAGE"
[ -f "$DEB" ] || fail "missing expected artifact: $DEB"

WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wb-linux-verify-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== AppImage: $APPIMAGE"
[ -x "$APPIMAGE" ] || fail "AppImage is not executable"

magic="$(head -c 4 "$APPIMAGE" | od -An -tx1 | tr -d ' \n')"
[ "$magic" = "7f454c46" ] || fail "AppImage is not an ELF binary (magic $magic)"
aimagic="$(dd if="$APPIMAGE" bs=1 skip=8 count=3 2>/dev/null | od -An -tx1 | tr -d ' \n')"
[ "$aimagic" = "414902" ] || fail "missing AppImage type-2 magic at offset 8 (found $aimagic)"

# Inspect the embedded metadata without FUSE by using the runtime's
# built-in extractor.
APPIMAGE_ABS="$(cd "$(dirname "$APPIMAGE")" && pwd)/$(basename "$APPIMAGE")"
(cd "$WORK" && "$APPIMAGE_ABS" --appimage-extract >/dev/null) \
  || fail "AppImage --appimage-extract failed; metadata cannot be inspected"

ROOT="$WORK/squashfs-root"
[ -e "$ROOT/AppRun" ] || fail "AppImage payload has no AppRun"
desktop="$(find "$ROOT" -maxdepth 1 -name '*.desktop' -print -quit)"
[ -n "$desktop" ] || fail "AppImage payload has no top-level .desktop entry"
grep -q '^Name=Wrightbench$' "$desktop" || fail "AppImage desktop entry Name is not Wrightbench"
grep -q '^Categories=.*Development' "$desktop" || fail "AppImage desktop entry lacks the Development category"
grep -q '^Exec=' "$desktop" || fail "AppImage desktop entry has no Exec line"
icon="$(find "$ROOT" -maxdepth 1 \( -name '*.png' -o -name '*.svg' \) -print -quit)"
[ -n "$icon" ] || fail "AppImage payload has no top-level icon"
echo "AppImage OK: desktop entry $(basename "$desktop"), icon $(basename "$icon")"

echo "== Debian package: $DEB"
info="$WORK/deb-info.txt"
dpkg-deb --info "$DEB" >"$info" || fail "dpkg-deb --info failed"
cat "$info"
grep -q "^ Package: wrightbench$" "$info" || fail "deb Package is not 'wrightbench'"
grep -q "^ Version: $VERSION$" "$info" || fail "deb Version is not '$VERSION'"
grep -q "^ Architecture: amd64$" "$info" || fail "deb Architecture is not amd64"
grep -q "^ Maintainer: .*@" "$info" || fail "deb Maintainer is missing"

contents="$WORK/deb-contents.txt"
dpkg-deb --contents "$DEB" >"$contents" || fail "dpkg-deb --contents failed"
grep -q "usr/share/applications/.*\.desktop" "$contents" \
  || fail "deb does not install a desktop entry under /usr/share/applications"
grep -q "usr/share/icons/hicolor/.*/apps/.*\.png" "$contents" \
  || fail "deb does not install hicolor icons"
grep -Eq "opt/Wrightbench/" "$contents" || fail "deb does not install the app under /opt/Wrightbench"
grep -Eq "wrightbench$" "$contents" || fail "deb does not contain the wrightbench executable"

deb_desktop="$(grep -o "\./usr/share/applications/[^ ]*\.desktop" "$contents" | head -1)"
[ -n "$deb_desktop" ] || fail "could not locate the deb desktop entry path"
dpkg-deb --fsys-tarfile "$DEB" | tar -xOf - "$deb_desktop" >"$WORK/deb.desktop" \
  || fail "could not extract the deb desktop entry"
grep -q '^Name=Wrightbench$' "$WORK/deb.desktop" || fail "deb desktop entry Name is not Wrightbench"
grep -q '^Categories=.*Development' "$WORK/deb.desktop" || fail "deb desktop entry lacks the Development category"

echo "Linux artifacts verified: AppImage and deb are structurally sound."

#!/usr/bin/env bash
# Packs the built plugin as dist/<id>-<version>.oiplugin, the file
# Settings › Plugins › “Install Plugin from Package File…” takes.
#
#   ./build.sh && ./package.sh
#
# The package is a zip with the manifest at its root: plugin.toml, the
# component, page and icon it names, plus the licences. dist/package/ is the
# same contents unzipped, for “Install Plugin from Disk…” (it takes a folder).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

field() {
  sed -n "s/^$1 *= *\"\([^\"]*\)\".*/\1/p" plugin.toml | head -n 1
}

id=$(field id)
version=$(field version)
wasm=$(field wasm)
web=$(field web)
icon=$(field icon)
icon_dark=$(field icon-dark)
[ -n "$id" ] && [ -n "$version" ] || { echo "plugin.toml: no id or version" >&2; exit 1; }

# The manifest names the files; refuse to pack a build that is missing them.
for f in "$wasm" "$web" LICENSE THIRD-PARTY-NOTICES.md; do
  [ -e "$f" ] || { echo "missing $f — run ./build.sh first" >&2; exit 1; }
done
for f in "$icon" "$icon_dark"; do
  [ -z "$f" ] || [ -e "$f" ] || { echo "missing $f — run ./build.sh first" >&2; exit 1; }
done

stage=dist/package
rm -rf "$stage"
mkdir -p "$stage/$(dirname "$wasm")"
cp plugin.toml LICENSE THIRD-PARTY-NOTICES.md "$stage"/
cp "$wasm" "$stage/$wasm"
cp -R "$(dirname "$web")" "$stage/$(dirname "$web")"
for f in "$icon" "$icon_dark"; do
  [ -n "$f" ] || continue
  mkdir -p "$stage/$(dirname "$f")"
  cp "$f" "$stage/$f"
done
find "$stage" -name .DS_Store -delete

out="dist/$id-$version.oiplugin"
rm -f "$out"
(cd "$stage" && zip -qr -X "../$(basename "$out")" .)

echo "$out ($(du -h "$out" | cut -f1), $(unzip -Z1 "$out" | wc -l | tr -d ' ') files)"

#!/usr/bin/env bash
# Packs the built plugin as dist/<id>-<version>.oiplugin, the file
# Settings › Plugins › “Install Plugin from Package File…” takes.
#
#   ./build.sh && ./package.sh
#
# The package is a zip with the manifest at its root: plugin.toml, the
# component and page it names, and the licence. dist/package/ is the same
# contents unzipped, for “Install Plugin from Disk…” (it takes a folder).
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
[ -n "$id" ] && [ -n "$version" ] || { echo "plugin.toml: no id or version" >&2; exit 1; }

# The manifest names the files; refuse to pack a build that is missing them.
for f in "$wasm" "$web" LICENSE; do
  [ -e "$f" ] || { echo "missing $f — run ./build.sh first" >&2; exit 1; }
done

stage=dist/package
rm -rf "$stage"
mkdir -p "$stage/$(dirname "$wasm")"
cp plugin.toml LICENSE "$stage"/
cp "$wasm" "$stage/$wasm"
cp -R "$(dirname "$web")" "$stage/$(dirname "$web")"
find "$stage" -name .DS_Store -delete

out="dist/$id-$version.oiplugin"
rm -f "$out"
(cd "$stage" && zip -qr -X "../$(basename "$out")" .)

echo "$out ($(du -h "$out" | cut -f1), $(unzip -Z1 "$out" | wc -l | tr -d ' ') files)"

#!/usr/bin/env bash
# Builds the plugin: the Wasm component into dist/plugin.wasm and the page into
# web/ (both needed to install or link the folder).
#
#   ./build.sh              the whole plugin
#   ./build.sh --skip-web   only the component (the page is unchanged)
#
# Requires rustup (the wasm32-wasip2 target is installed if missing), cargo's
# network access for the SDK, and pnpm for the page.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

rustup target list --installed | grep -qx wasm32-wasip2 || rustup target add wasm32-wasip2

echo "== component =="
cargo build --release --target wasm32-wasip2
mkdir -p dist
cp target/wasm32-wasip2/release/openidea_pdfviewer.wasm dist/plugin.wasm
echo "   dist/plugin.wasm ($(wc -c <dist/plugin.wasm | tr -d ' ') bytes)"

if [ "${1:-}" = "--skip-web" ]; then
  exit 0
fi

echo "== page =="
pnpm --dir web-src install --frozen-lockfile --silent
pnpm --dir web-src run build
echo "   web/ ($(du -sh web | cut -f1))"

echo
echo "done: run 'openidea-plugin check' in this folder, then 'openidea-plugin link'"
echo "      (Settings › Plugins › Reload) to load it into the IDE."
echo "      Or ./package.sh for an installable .oiplugin."

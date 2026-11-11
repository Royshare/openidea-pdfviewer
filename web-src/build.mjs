/**
 * Builds the page into ../web, the directory `plugin.toml` declares as the
 * web view's root: everything under it ships in the package and is loaded by
 * relative URL from the IDE's own URL scheme.
 *
 *   web/index.html        the shell
 *   web/viewer.js         this plugin's UI + pdf.js, one bundle
 *   web/viewer.css        pdf.js's viewer styles and ours
 *   web/pdf.worker.mjs    pdf.js's parser worker
 *   web/cmaps/            character maps (CJK text)
 *   web/standard_fonts/   the 14 standard fonts, for PDFs that use them
 *   web/wasm/             JBIG2 / JPEG 2000 / colour decoders
 *   web/iccs/             colour profiles
 *
 * Run: pnpm build (or npm run build).
 */

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const out = path.resolve(here, "../web");
const pdfjs = path.resolve(here, "node_modules/pdfjs-dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(here, "src/main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  outfile: path.join(out, "viewer.js"),
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // pdf.js's viewer styles reference its toolbar/editor icons; inline them so
  // the page needs no other file (and no network) to look right.
  loader: { ".svg": "dataurl", ".png": "dataurl", ".gif": "dataurl", ".webp": "dataurl" },
  logLevel: "info",
});

// The shell carries the relative script tag; the page must not fetch anything
// it does not ship.
const html = await readFile(path.join(here, "index.html"), "utf8");
if (!html.includes('src="./viewer.js"')) {
  throw new Error("index.html must load ./viewer.js");
}
await writeFile(path.join(out, "index.html"), html);

/** pdf.js assets the page loads at run time. */
const assets = [
  ["build/pdf.worker.min.mjs", "pdf.worker.mjs"],
  ["cmaps", "cmaps"],
  ["standard_fonts", "standard_fonts"],
  ["wasm", "wasm"],
  ["iccs", "iccs"],
];
for (const [from, to] of assets) {
  const source = path.join(pdfjs, from);
  if (!existsSync(source)) {
    throw new Error(`pdfjs-dist is missing ${from}: run pnpm install`);
  }
  await cp(source, path.join(out, to), { recursive: true });
}

const bytes = async (dir) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("du", ["-sh", dir]);
  return stdout.split("\t")[0];
};

console.log(`web/ built: ${await bytes(out)}`);

/**
 * A real-browser smoke test for the page, run outside the IDE.
 *
 * It serves `web/` and opens the page the way OpenIDEA does: inside an
 * `<iframe sandbox="allow-scripts">`, which is an opaque origin with no
 * storage and — the point of the exercise — a frame that cannot start a
 * Worker from the page's own URL scheme. The IDE's bridge (`window.openidea`)
 * is replaced by a stub that speaks the same protocol as the plugin's code
 * (a Map standing in for files in the plugin's own directory), and stubs API
 * 1.5 `document.bytes()` plus the plugin's project.read-bytes fallback.
 *
 *   pnpm test        # needs a Chromium: Playwright's, or set CHROME=…
 *
 * What it checks: direct document bytes, project fallback, document text,
 * cache, and user-picking paths; that pdf.js draws, the text layer, outline,
 * search, navigation, and the three page-layout modes.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "../..");
const pdf = await readFile(path.join(root, "fixtures/sample.pdf"));
const pdfBase64 = pdf.toString("base64");
const pdfText = pdf.toString("utf8");

/* ------------------------------------------------------------------ server */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".pfb": "application/octet-stream",
  ".bcmap": "application/octet-stream",
  ".icc": "application/octet-stream",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const target = path.join(root, decodeURIComponent(url.pathname));
  if (!target.startsWith(root) || !existsSync(target) || !(await stat(target)).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  const body = await readFile(target);
  // The frame is an opaque origin: module scripts and fonts are fetched in
  // CORS mode, exactly as the IDE's `openidea-plugin` scheme allows.
  response
    .writeHead(200, {
      "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
      "access-control-allow-origin": "*",
    })
    .end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const harness = `${origin}/web-src/test/harness.html`;

/* --------------------------------------------------------------- the stub */

/**
 * `window.openidea` as the IDE would provide it, plus the plugin code's
 * storage bridge, all in the page: `mode` decides what the document and the
 * open dialog offer.
 */
function stub(options) {
  const store = new Map(Object.entries(options.store ?? {}));
  const listeners = [];
  const callbacks = [];
  const files = options.picked ? [{ name: "sample.pdf", data: options.picked }] : [];
  window.__store = () => Object.fromEntries(store);
  window.__framesSeen = [];
  window.__readCalls = 0;
  window.openidea = {
    postMessage(text) {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const reply = (payload) => queueMicrotask(() => listeners.forEach((fn) => fn(JSON.stringify(payload))));
      const id = String(message.id);
      if (message.op === "info") reply({ op: "info", id, path: options.path ?? "/papers/sample.pdf" });
      else if (message.op === "read" && options.readable) {
        window.__readCalls++;
        // Two parts on purpose: the page has to put them back together.
        const binary = atob(options.readable);
        const cut = Math.ceil(binary.length / 2);
        reply({ op: "bytes", id, part: 0, parts: 2, data: btoa(binary.slice(0, cut)) });
        reply({ op: "bytes", id, part: 1, parts: 2, data: btoa(binary.slice(cut)) });
      } else if (message.op === "read") {
        window.__readCalls++;
        reply({ op: "none", id, reason: "denied: project.read" });
      }
      else if (message.op === "get") reply({ op: "value", id, key: message.key, value: store.get(message.key) ?? null });
      else if (message.op === "set") {
        store.set(message.key, message.value);
        reply({ op: "ok", id, key: message.key });
      } else if (message.op === "del") {
        store.delete(message.key);
        reply({ op: "ok", id, key: message.key });
      } else if (message.op === "keys") {
        const prefix = message.prefix ?? "";
        reply({ op: "keys", id, prefix, keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort() });
      } else if (message.op === "ping") reply({ op: "pong", id });
      else reply({ op: "error", id, message: "unknown" });
    },
    onMessage(fn) {
      listeners.push(fn);
      callbacks.push(fn);
    },
    theme: { dark: true, vars: {} },
    onThemeChange() {},
    document: {
      get: async () => ({ version: 0, text: options.documentText ?? "", readOnly: true, name: options.documentName ?? "sample.pdf" }),
      bytes: async () => {
        if (!options.documentBytes) {
          throw new Error(options.documentBytesError ?? "document bytes unavailable");
        }
        return new Uint8Array(options.documentBytes);
      },
      onChange() {},
      edit: async () => ({ version: 0 }),
      replace: async () => ({ version: 0 }),
    },
    openFile: async () => {
      if (!files.length) {
        return null;
      }
      const file = files.shift();
      return { name: file.name, data: new Uint8Array(file.data) };
    },
    saveFile: async () => null,
  };
}

/* --------------------------------------------------------------- the test */

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures++;
  }
}

const executablePath = process.env.CHROME ?? findChrome() ?? chromium.executablePath();
const browser = await chromium.launch({ executablePath, headless: true });

async function openPage(stubOptions, seedStore) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  page.on("pageerror", (error) => check("no page error", false, error.message));
  await page.addInitScript(stub, { ...stubOptions, store: seedStore ?? {} });
  await page.goto(harness, { waitUntil: "load" });
  const frame = page.frames().find((f) => f.url().endsWith("/web/index.html"));
  if (!frame) {
    throw new Error("the viewer frame did not load");
  }
  return { page, frame };
}

async function pageState(frame) {
  return frame.evaluate(() => {
    const pages = document.querySelectorAll(".pdfViewer .page").length;
    const canvas = document.querySelector(".pdfViewer .page canvas");
    let painted = 0;
    if (canvas) {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const data = context?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (data) {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
            painted++;
          }
        }
      }
    }
    return {
      pages,
      painted,
      text: document.querySelectorAll(".textLayer span").length,
      chooser: document.getElementById("overlay")?.hidden === false,
      pageCount: document.querySelector(".page-count")?.textContent ?? "",
      status: document.getElementById("status")?.textContent ?? "",
      sidebar: document.getElementById("sidebar")?.hidden === false,
    };
  });
}

const waitFor = async (frame, predicate, timeout = 15_000) => {
  const started = Date.now();
  for (;;) {
    const state = await pageState(frame);
    if (predicate(state)) {
      return state;
    }
    if (Date.now() - started > timeout) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

/* 1. the document text is the PDF (a PDF made only of text) --------------- */
{
  const { page, frame } = await openPage({ documentText: pdfText });
  const state = await waitFor(frame, (s) => s.pages === 3 && s.painted > 500);
  check("document text path: 3 pages drawn", state.pages === 3 && state.painted > 500, JSON.stringify(state).slice(0, 120));
  check("document text path: text layer present", state.text > 0, `${state.text} spans`);
  check("document text path: no chooser", !state.chooser);

  const ctrlWheel = await frame.evaluate(() => {
    const event = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    document.querySelector(".pdfViewer .page")?.dispatchEvent(event);
    return { prevented: event.defaultPrevented, scale: document.querySelector(".scale-label")?.textContent ?? "" };
  });
  check("Ctrl+wheel zooms the PDF and prevents browser zoom", ctrlWheel.prevented && ctrlWheel.scale.endsWith("%"), JSON.stringify(ctrlWheel));
  const metaWheel = await frame.evaluate(() => {
    const before = document.querySelector(".scale-label")?.textContent ?? "";
    const event = new WheelEvent("wheel", { deltaY: -100, metaKey: true, bubbles: true, cancelable: true });
    document.querySelector(".pdfViewer .page")?.dispatchEvent(event);
    return { prevented: event.defaultPrevented, before, after: document.querySelector(".scale-label")?.textContent ?? "" };
  });
  check("Cmd+wheel zooms the PDF", metaWheel.prevented && metaWheel.after !== metaWheel.before, JSON.stringify(metaWheel));
  const wheelOut = await frame.evaluate(() => {
    const before = document.querySelector(".scale-label")?.textContent ?? "";
    const event = new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
    document.querySelector(".pdfViewer .page")?.dispatchEvent(event);
    return { prevented: event.defaultPrevented, before, after: document.querySelector(".scale-label")?.textContent ?? "" };
  });
  check("modifier+wheel down zooms out", wheelOut.prevented && Number.parseFloat(wheelOut.after) < Number.parseFloat(wheelOut.before), JSON.stringify(wheelOut));

  check("continuous layout is selected by default", await frame.inputValue(".view-select") === "continuous");
  await frame.selectOption(".view-select", "single");
  await frame.waitForFunction(() => document.querySelectorAll("#viewer > .page").length === 1);
  check("single-page layout shows one page", await frame.locator("#viewer > .page").count() === 1);
  await frame.selectOption(".view-select", "spread");
  await frame.waitForFunction(() => document.querySelectorAll("#viewer > .spread").length === 2);
  const spreads = await frame.$$eval("#viewer > .spread", (nodes) => nodes.map((node) => node.querySelectorAll(":scope > .page").length));
  check("side-by-side layout leaves a cover then pairs pages", spreads.length === 2 && spreads[0] === 1 && spreads[1] === 2, JSON.stringify(spreads));
  await frame.selectOption(".view-select", "continuous");
  await frame.waitForFunction(() => document.querySelectorAll("#viewer > .spread").length === 0);
  check("continuous layout restores the vertical page list", await frame.locator("#viewer > .page").count() === 3);

  await frame.click(".icon-button[title='Outline and pages']");
  await frame.waitForSelector(".outline-row", { timeout: 5000 }).catch(() => {});
  const outline = await frame.$$eval(".outline-row", (rows) => rows.map((r) => r.textContent?.trim() ?? ""));
  check("outline lists both bookmarks", outline.length === 2 && outline[0].startsWith("Chapter One"), JSON.stringify(outline));
  await frame.click(".outline-row:nth-of-type(2)");
  const afterJump = await waitFor(frame, (s) => s.status.includes("Page 3"), 5000);
  check("a bookmark jumps to its page", afterJump.status.includes("Page 3"), afterJump.status);

  await frame.fill(".search-input", "brown fox");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const count = (await frame.textContent(".search-count"))?.trim() ?? "null";
  // Two hits, on page 1 and page 3; the search has already moved to one of them.
  const [, at = "", total = ""] = /^(\d+)\/(\d+)$/.exec(count) ?? [];
  check("search finds the text", total === "2" && at !== "", count);
  await frame.click(".icon-button[title='Next match (Enter)']");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const next = (await frame.textContent(".search-count"))?.trim() ?? "null";
  check("next match moves through the hits", /^\d\/2$/.test(next), next);

  await frame.click(".sidebar-tab:nth-of-type(2)");
  await frame.waitForSelector(".thumb canvas", { timeout: 8000 }).catch(() => {});
  const thumbs = await frame.$$eval(".thumb canvas", (canvases) => canvases.length);
  check("thumbnails render", thumbs >= 1, `${thumbs} canvases`);

  await page.close();
}

/* 2. the user picks the file, and it is remembered ----------------------- */
let cached = {};
{
  const { page, frame } = await openPage({ documentText: "", picked: [...pdf] });
  const chooser = await waitFor(frame, (s) => s.chooser);
  check("binary document shows the chooser", chooser.chooser);
  await frame.click(".button.primary");
  const state = await waitFor(frame, (s) => s.pages === 3 && s.painted > 500);
  check("picked path: 3 pages drawn", state.pages === 3, `${state.pages} pages`);
  await new Promise((resolve) => setTimeout(resolve, 600)); // let the cache write settle
  cached = await frame.evaluate(() => window.__store());
  check("picked path: bytes were cached", Object.keys(cached).length > 1, `${Object.keys(cached).length} keys`);
  // The cache is filed under the tab's path (`info`), not under a bare name.
  const keyedByPath = `pdfviewer/pdf/${keyId("/papers/sample.pdf")}/0`;
  check("picked path: the cache is keyed by the tab's path", Object.hasOwn(cached, keyedByPath), Object.keys(cached).join(", "));
  await page.close();
}

/* 3. the cache serves the next open, with no dialog ---------------------- */
{
  const { page, frame } = await openPage({ documentText: "", picked: [] }, cached);
  const state = await waitFor(frame, (s) => s.pages === 3 || s.chooser);
  check("cache path: 3 pages drawn", state.pages === 3, `${state.pages} pages`);
  check("cache path: no dialog", !state.chooser);
  await page.close();
}

/* 4. API 1.5 document.bytes() reads the opened file directly -------------- */
{
  const { page, frame } = await openPage({ documentText: "", documentBytes: [...pdf] });
  const state = await waitFor(frame, (s) => s.pages === 3 || s.chooser);
  check("document.bytes: 3 pages drawn", state.pages === 3, JSON.stringify(state).slice(0, 120));
  check("document.bytes: no dialog", !state.chooser);
  const readCalls = await frame.evaluate(() => window.__readCalls);
  check("document.bytes: skips plugin read fallback", readCalls === 0, `${readCalls} read calls`);
  const stored = await frame.evaluate(() => Object.keys(window.__store()));
  check("document.bytes: nothing copied into cache", stored.length === 0, stored.join(", "));
  await page.close();
}

/* 5. API 1.5 project.read-bytes is the fallback ------------------------- */
{
  const { page, frame } = await openPage({ documentText: "", readable: pdfBase64 });
  const state = await waitFor(frame, (s) => s.pages === 3 || s.chooser);
  check("project.read-bytes fallback: 3 pages drawn", state.pages === 3, JSON.stringify(state).slice(0, 120));
  check("project.read-bytes fallback: no dialog", !state.chooser);
  const readCalls = await frame.evaluate(() => window.__readCalls);
  check("project.read-bytes fallback: requested once", readCalls === 1, `${readCalls} read calls`);
  const stored = await frame.evaluate(() => Object.keys(window.__store()));
  check("project.read-bytes: nothing copied into cache", stored.length === 0, stored.join(", "));
  await page.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

/* ----------------------------------------------------------------- helpers */

/** The page's file id: 32-bit FNV-1a, hex (see `web-src/src/cache.ts`). */
function keyId(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];
  const cached = path.join(
    process.env.HOME ?? "",
    "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );
  candidates.unshift(cached);
  return candidates.find((candidate) => existsSync(candidate));
}

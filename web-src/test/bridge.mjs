/**
 * Multi-frame test for `CodeBridge` (src/code.ts), run in Node with no browser.
 *
 * The IDE delivers every reply of the plugin's code to every frame of the
 * view, and each frame has its own `CodeBridge` counting from zero. This
 * models that: several bridges share one broadcast channel, the fake code
 * answers requests in the order we choose (out of order, multipart), and every
 * bridge must end up with its own answers only.
 *
 *   pnpm test:bridge
 */

import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(path.join(tmpdir(), "pdfviewer-bridge-"));
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures++;
  }
}

try {
  const out = path.join(dir, "code.mjs");
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "../src/code.ts")],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { CodeBridge } = await import(pathToFileURL(out).href);

  /**
   * One shared channel: `frame()` makes a bridge whose posts go to `requests`
   * (what the plugin's code would receive) and whose listener hears every
   * broadcast, like each frame of the view does.
   */
  function channel() {
    const listeners = [];
    const requests = [];
    return {
      requests,
      broadcast: (payload) => listeners.forEach((fn) => fn(JSON.stringify(payload))),
      frame: () =>
        new CodeBridge(
          (text) => requests.push(JSON.parse(text)),
          (fn) => listeners.push(fn),
        ),
    };
  }

  const b64 = (text) => Buffer.from(text).toString("base64");
  const text = (bytes) => Buffer.from(bytes).toString();

  /* Two tabs, both with a `read` pending: the ids must differ, and replies
   * arriving out of order (B's first, then A's, in two parts each, interleaved)
   * must each land on the tab that asked. */
  {
    const net = channel();
    const a = net.frame();
    const b = net.frame();
    const readA = a.read();
    const readB = b.read();
    const [reqA, reqB] = net.requests;
    check("concurrent frames use different request ids", reqA.id !== reqB.id, `${reqA.id} vs ${reqB.id}`);
    check("ids stay within the code's 64-character limit", reqA.id.length <= 64 && reqB.id.length <= 64);

    net.broadcast({ op: "bytes", id: reqB.id, part: 0, parts: 2, data: b64("%PDF-B: fi") });
    net.broadcast({ op: "bytes", id: reqA.id, part: 1, parts: 2, data: b64("le A") });
    net.broadcast({ op: "bytes", id: reqA.id, part: 0, parts: 2, data: b64("%PDF-A: fi") });
    net.broadcast({ op: "bytes", id: reqB.id, part: 1, parts: 2, data: b64("le B") });

    const [gotA, gotB] = await Promise.all([readA, readB]);
    check("tab A gets file A", gotA && text(gotA.bytes) === "%PDF-A: file A", gotA && text(gotA.bytes));
    check("tab B gets file B", gotB && text(gotB.bytes) === "%PDF-B: file B", gotB && text(gotB.bytes));
  }

  /* Same, with the first request of every frame (the counter alone would give
   * both "1"), across `info`, `get` and `ping`, answered in reverse order. */
  {
    const net = channel();
    const a = net.frame();
    const b = net.frame();
    const infoA = a.info();
    const infoB = b.info();
    const getA = a.get("k");
    const getB = b.get("k");
    const [reqInfoA, reqInfoB, reqGetA, reqGetB] = net.requests;
    net.broadcast({ op: "value", id: reqGetB.id, key: "k", value: "from B" });
    net.broadcast({ op: "info", id: reqInfoB.id, path: "/b.pdf" });
    net.broadcast({ op: "value", id: reqGetA.id, key: "k", value: "from A" });
    net.broadcast({ op: "info", id: reqInfoA.id, path: "/a.pdf" });
    check("info answers reach the asking tab", (await infoA) === "/a.pdf" && (await infoB) === "/b.pdf");
    check("get answers reach the asking tab", (await getA) === "from A" && (await getB) === "from B");
  }

  /* An answer to someone else's request is ignored, and does not disturb a
   * request of ours that is still waiting. */
  {
    const net = channel();
    const a = net.frame();
    const b = net.frame();
    const pending = a.get("k");
    const [req] = net.requests;
    const foreign = b.get("k");
    const reqForeign = net.requests[1];
    net.broadcast({ op: "value", id: reqForeign.id, key: "k", value: "for B" });
    net.broadcast({ op: "value", id: req.id, key: "k", value: "for A" });
    check("foreign answers are ignored", (await pending) === "for A" && (await foreign) === "for B");
  }

  /* Many frames, the same sequence number in each, all answered backwards. */
  {
    const net = channel();
    const frames = Array.from({ length: 8 }, () => net.frame());
    const calls = frames.map((frame) => frame.get("k"));
    const seqs = new Set(net.requests.map((request) => request.id));
    check("eight frames, eight distinct ids", seqs.size === 8, `${seqs.size} distinct`);
    [...net.requests].reverse().forEach((request) => {
      const frameIndex = net.requests.indexOf(request);
      net.broadcast({ op: "value", id: request.id, key: "k", value: `frame ${frameIndex}` });
    });
    const values = await Promise.all(calls);
    check(
      "each of eight frames gets its own answer",
      values.every((value, i) => value === `frame ${i}`),
      values.join(", "),
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

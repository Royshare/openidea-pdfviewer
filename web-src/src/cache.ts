/**
 * The viewer's cache of PDF bytes, kept by the plugin's code as files in the
 * plugin's own directory.
 *
 * A frame has no storage of its own (it is an opaque origin), and the plugin
 * API cannot hand a plugin the bytes of a project file, so a PDF the user
 * picked once would otherwise have to be picked again every time the tab is
 * reopened. The bytes are kept by the code instead: API 1.3's
 * `host::fs::plugin_dir` is private to this plugin, needs no capability, and
 * has no 64 MiB ceiling like the key-value store, so a large or scanned PDF is
 * remembered too. One file per chunk, named after the key.
 *
 * A file is identified by its path in the IDE (from `info`) *and* its name:
 * `a/paper.pdf` and `b/paper.pdf` are different entries, and a PDF the user
 * picked for a tab that shows another file is not served back for it.
 *
 * Everything is best effort: a failed write, a full disk, or code that does
 * not answer simply means the next open asks for the file again.
 */

import { fromBase64, toBase64 } from "./base64";
import type { CodeBridge } from "./code";

/** File bytes per stored value (base64 grows this by a third: under 4 MiB). */
export const CHUNK_RAW = 2 << 20;
/** Files kept at most. */
export const MAX_ENTRIES = 8;
/** File bytes kept across all entries. */
export const MAX_TOTAL = 256 << 20;

const INDEX_KEY = "pdfviewer/index";
const KEY_ROOT = "pdfviewer/pdf";

interface Entry {
  /** Stable key for the file's identity (the id in the store's keys). */
  id: string;
  /** The file's name, as the tab and the picked file show it. */
  name: string;
  size: number;
  chunks: number;
  /** When it was last used (ms), for the LRU. */
  at: number;
}

/** A 32-bit FNV-1a of `text`, hex: a store key that survives any file name. */
export function keyId(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function chunkKey(id: string, index: number): string {
  return `${KEY_ROOT}/${id}/${index}`;
}

async function readIndex(code: CodeBridge): Promise<Entry[]> {
  try {
    const raw = await code.get(INDEX_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (e): e is Entry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as Entry).id === "string" &&
        typeof (e as Entry).name === "string" &&
        Number.isInteger((e as Entry).size) &&
        Number.isInteger((e as Entry).chunks),
    );
  } catch {
    return [];
  }
}

async function writeIndex(code: CodeBridge, entries: readonly Entry[]): Promise<void> {
  try {
    await code.set(INDEX_KEY, JSON.stringify(entries));
  } catch {
    // The cache is an optimisation: without an index nothing is served.
  }
}

/** Drops `entry`'s values; the index must be rewritten by the caller. */
async function drop(code: CodeBridge, entry: Entry): Promise<void> {
  for (let i = 0; i < entry.chunks; i++) {
    try {
      await code.delete(chunkKey(entry.id, i));
    } catch {
      // Gone already, or the store is refusing: nothing else to do.
    }
  }
}

/**
 * The cached bytes of the file `identity` names as `name`, or `null`. A hit is
 * marked as used.
 */
export async function loadCached(code: CodeBridge, identity: string, name: string): Promise<Uint8Array | null> {
  const entries = await readIndex(code);
  const id = keyId(identity);
  const entry = entries.find((e) => e.id === id && e.name === name);
  if (!entry) {
    return null;
  }
  try {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < entry.chunks; i++) {
      const value = await code.get(chunkKey(entry.id, i));
      if (value === null) {
        // Partially evicted (another window, a failed write): start over.
        await drop(code, entry);
        await writeIndex(
          code,
          entries.filter((e) => e !== entry),
        );
        return null;
      }
      parts.push(fromBase64(value));
    }
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    if (bytes.length !== entry.size) {
      return null;
    }
    entry.at = Date.now();
    await writeIndex(code, [entry, ...entries.filter((e) => e !== entry)]);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Keeps `bytes` for the file `identity` names as `name`, evicting the least
 * recently used files to stay inside {@link MAX_ENTRIES} and {@link MAX_TOTAL}.
 */
export async function saveCached(
  code: CodeBridge,
  identity: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.length === 0 || bytes.length > MAX_TOTAL) {
    return;
  }
  const entries = await readIndex(code);
  const id = keyId(identity);
  const same = (e: Entry): boolean => e.id === id && e.name === name;
  const existing = entries.find(same);
  if (existing) {
    await drop(code, existing);
  }
  const kept = entries.filter((e) => !same(e));
  // Oldest first, so eviction takes from the front.
  kept.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  let total = kept.reduce((n, e) => n + e.size, 0);
  while (kept.length >= MAX_ENTRIES || total + bytes.length > MAX_TOTAL) {
    const victim = kept.pop();
    if (!victim) {
      break;
    }
    total -= victim.size;
    await drop(code, victim);
  }

  const entry: Entry = {
    id,
    name,
    size: bytes.length,
    chunks: Math.max(1, Math.ceil(bytes.length / CHUNK_RAW)),
    at: Date.now(),
  };
  try {
    for (let i = 0; i < entry.chunks; i++) {
      const slice = bytes.subarray(i * CHUNK_RAW, (i + 1) * CHUNK_RAW);
      await code.set(chunkKey(entry.id, i), toBase64(slice));
    }
  } catch {
    // Full disk, or a value over the limit: drop the half-written file
    // rather than leave a broken entry behind.
    await drop(code, entry);
    await writeIndex(code, kept);
    return;
  }
  await writeIndex(code, [entry, ...kept]);
}

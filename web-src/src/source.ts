/**
 * Where the PDF bytes come from, in preference order:
 *
 * 1. `document.bytes()` (API 1.5): the bytes of this custom editor's own file,
 *    sent directly to the page, up to 64 MiB;
 * 2. `project.read-bytes` through the plugin code: project-confined and up to
 *    16 MiB, as a fallback if the web bridge cannot provide the bytes;
 * 3. the text document or the plugin's private cache;
 * 4. the user: the IDE's open dialog (`openFile`), or a dropped file.
 */

import { PDF_FILTERS, bridge } from "./bridge";
import { loadCached } from "./cache";
import type { CodeBridge } from "./code";

export type Origin = "document-bytes" | "document-text" | "project" | "cache" | "picked" | "dropped";

/** Why the IDE could not provide the tab's bytes directly (for the chooser). */
let inPlaceReason: string | null = null;

export function inPlaceHint(): string | null {
  return inPlaceReason;
}

export interface Opened {
  name: string;
  /** What the cache files it under: the tab's path, else its name. */
  identity: string;
  bytes: Uint8Array;
  origin: Origin;
}

/** `%PDF-` within the first KiB (the format allows leading junk). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024) - 5;
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

/** A UTF-8-only PDF from `document.get().text`; binary PDFs need bytes(). */
export function bytesFromDocumentText(text: string): Uint8Array | null {
  if (!text || !text.startsWith("%PDF-") || text.includes("\uFFFD")) {
    return null;
  }
  const bytes = new TextEncoder().encode(text);
  return looksLikePdf(bytes) ? bytes : null;
}

/**
 * Tries the custom editor's direct bytes API first, then the project-scoped
 * `read-bytes` fallback, then document text and the private cache. `null` means
 * the user needs to choose a file.
 */
export async function findBytes(
  code: CodeBridge,
  identity: string,
  name: string,
  text: string,
  documentBytes?: () => Promise<Uint8Array>,
): Promise<Opened | null> {
  if (documentBytes) {
    try {
      const bytes = await documentBytes();
      if (looksLikePdf(bytes)) {
        return { name, identity, bytes, origin: "document-bytes" };
      }
      inPlaceReason = "The opened file did not contain a PDF.";
    } catch (error) {
      inPlaceReason = error instanceof Error ? error.message : String(error);
    }
  }

  try {
    const read = await code.read();
    if (read && "bytes" in read && looksLikePdf(read.bytes)) {
      return { name, identity, bytes: read.bytes, origin: "project" };
    }
    if (read && "reason" in read) {
      inPlaceReason = read.reason;
    }
  } catch {
    // No plugin code or project.read grant: continue to the text/cache paths.
  }

  const fromText = bytesFromDocumentText(text);
  if (fromText) {
    return { name, identity, bytes: fromText, origin: "document-text" };
  }

  try {
    const cached = await loadCached(code, identity, name);
    if (cached && looksLikePdf(cached)) {
      return { name, identity, bytes: cached, origin: "cache" };
    }
  } catch {
    // No store, no code: the dialog still works.
  }
  return null;
}

/** The IDE's open dialog. `null` when the user cancelled. */
export async function pickWithDialog(identity: string): Promise<Opened | null> {
  const openidea = bridge();
  if (!openidea) {
    return null;
  }
  const picked = await openidea.openFile({ filters: PDF_FILTERS });
  if (!picked) {
    return null;
  }
  const bytes = picked.data instanceof Uint8Array ? picked.data : new Uint8Array(picked.data as ArrayBuffer);
  return { name: picked.name || "document.pdf", identity, bytes, origin: "picked" };
}

/** A file dropped on the page, or chosen through the browser's own dialog. */
export async function fileToOpened(file: File, identity: string): Promise<Opened> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name || "document.pdf", identity, bytes, origin: "dropped" };
}

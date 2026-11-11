/**
 * The IDE's frame bridge (`window.openidea`), injected before this page's
 * scripts run (see the OpenIDEA plugin guide, "Web views"). Types mirror the
 * API the IDE documents; the page uses a small part of it.
 *
 * In this plugin the page is a custom editor showing a PDF. API 1.5 adds
 * `document.bytes()` for the bytes of the tab's own file (up to 64 MiB), which
 * is preferred to any plugin-side read; `document.get()` remains the text view
 * and is useful only as a fallback for text-only PDFs.
 */

export interface OpenideaDocumentState {
  version: number;
  /** The file's name, without its directory. */
  name: string;
  text: string;
  readOnly: boolean;
}

export interface OpenideaTheme {
  dark: boolean;
  vars: Readonly<Record<string, string>>;
}

export interface OpenideaTextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface OpenideaFileFilter {
  name: string;
  extensions: string[];
}

export interface OpenideaBridge {
  postMessage(text: string): void;
  onMessage(fn: (text: string) => void): void;
  readonly theme: OpenideaTheme | null;
  onThemeChange(fn: (theme: OpenideaTheme) => void): void;
  document: {
    get(): Promise<OpenideaDocumentState>;
    /** API 1.5: bytes of this custom editor's file, read-only, up to 64 MiB. */
    bytes(): Promise<Uint8Array>;
    onChange(fn: (state: { version: number; text: string }) => void): void;
    edit(version: number, edits: OpenideaTextEdit[]): Promise<{ version: number }>;
    replace(version: number, text: string): Promise<{ version: number }>;
  };
  saveFile(options: {
    name: string;
    data: string | Uint8Array | ArrayBuffer | Blob;
    filters?: OpenideaFileFilter[];
  }): Promise<string | null>;
  openFile(options?: { filters?: OpenideaFileFilter[] }): Promise<{ name: string; data: Uint8Array } | null>;
}

declare global {
  interface Window {
    openidea?: OpenideaBridge;
  }
}

/** The bridge, or `undefined` when the page runs outside OpenIDEA. */
export function bridge(): OpenideaBridge | undefined {
  return window.openidea;
}

export const PDF_FILTERS: OpenideaFileFilter[] = [{ name: "PDF", extensions: ["pdf"] }];

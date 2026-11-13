/**
 * The page: it ties the IDE bridge, the byte sources, pdf.js and the chrome
 * together, and it owns the states a reader has — waiting for a file, reading,
 * and the explanation when something is wrong.
 */

import { bridge, type OpenideaBridge } from "./bridge";
import { saveCached } from "./cache";
import { CodeBridge } from "./code";
import { Reader, type OutlineNode, type ViewMode } from "./reader";
import { fileToOpened, findBytes, inPlaceHint, looksLikePdf, pickWithDialog, type Opened } from "./source";
import { bytesLabel, Overlay, Sidebar, StatusBar, Toolbar } from "./ui";
import "pdfjs-dist/web/pdf_viewer.css";
import "./style.css";

/** The last segment of a path, on either separator. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`the page is missing #${id}`);
  }
  return node as T;
}

/* ------------------------------------------------------------------- state */

const openidea: OpenideaBridge | undefined = bridge();
const overlay = new Overlay(byId("overlay"));
const status = new StatusBar(byId("status"));
let code: CodeBridge | null = null;
/** What the cache files the open file under: the tab's path, else its name. */
let identity = "document.pdf";
let pages = 0;
let page = 1;
let zoom = "Fit width";

/* ------------------------------------------------------------------ pieces */

const reader = new Reader(byId<HTMLDivElement>("viewer-container"), byId<HTMLDivElement>("viewer"), {
  page: (current, total) => {
    page = current;
    pages = total;
    toolbar.setPage(current);
    sidebar.setCurrentPage(current);
    paintStatus();
  },
  scale: (label) => {
    zoom = label;
    toolbar.setScale(label);
    paintStatus();
  },
  search: (current, total, pending) => toolbar.setSearch(current, total, pending),
  ready: (total) => {
    pages = total;
    toolbar.setPages(total);
    toolbar.setEnabled(true);
    paintStatus();
  },
  error: (error) => showError(error),
});

const sidebar = new Sidebar(byId("sidebar"), { goToPage: (target) => reader.goToPage(target) });

const toolbar = new Toolbar(byId("toolbar"), {
  toggleSidebar: () => sidebar.toggle(),
  step: (delta) => reader.goToPage(reader.pageNumber + delta),
  goToPage: (target) => reader.goToPage(target),
  zoom: (factor) => reader.zoomBy(factor),
  fit: (mode) => reader.setScale(mode === "width" ? "page-width" : "page-fit"),
  setViewMode: (mode: ViewMode) => reader.setViewMode(mode),
  rotate: () => {
    reader.rotate();
    void reflow();
  },
  search: (query) => (query ? reader.find(query) : reader.stopFind()),
  findAgain: (back) => reader.findAgain(back),
  reload: () => void chooseThroughIde(),
});

function paintStatus(): void {
  status.setRight(pages ? `Page ${page} / ${pages} · ${zoom}` : "");
}

/* -------------------------------------------------------------- presenting */

async function outlineOf(): Promise<OutlineNode[] | null> {
  try {
    return await reader.outline();
  } catch {
    return null;
  }
}

/** Re-reads the outline and rebuilds the sidebar (after opening or rotating). */
async function reflow(): Promise<void> {
  const outline = await outlineOf();
  sidebar.reset(outline, reader.pagesCount, (thumbPage, width) => reader.thumbnail(thumbPage, width));
}

/** Shows `opened`, remembers it, and rebuilds the chrome for it. */
async function present(opened: Opened): Promise<void> {
  if (!looksLikePdf(opened.bytes)) {
    showError(new Error(`${opened.name} is not a PDF.`), "The file does not start with %PDF.");
    return;
  }
  overlay.hide();
  toolbar.setEnabled(false);
  document.title = opened.name;
  status.setLeft(`${opened.name} · ${bytesLabel(opened.bytes.length)}`);

  // Keep a copy before pdf.js takes the buffer (it transfers it), so files
  // handed in through a dialog or a drop are remembered. Project bytes are
  // read directly again next time; rewriting them to the cache would be wasted work.
  if (code && (opened.origin === "picked" || opened.origin === "dropped")) {
    const copy = opened.bytes.slice();
    void saveCached(code, opened.identity, opened.name, copy).catch(() => {});
  }

  if (!(await reader.open(opened.bytes))) {
    return; // the error overlay is up; the toolbar stays disabled
  }
  await reflow();
  toolbar.setEnabled(true);
}

function showError(error: Error, detail?: string): void {
  toolbar.setEnabled(false);
  overlay.show({
    title: "This document could not be opened",
    body: error.message,
    detail,
    actions: [{ label: "Choose another file…", primary: true, run: () => void chooseThroughIde() }],
  });
}

/* ---------------------------------------------------------------- choosing */

/** The IDE's open dialog; the way in for a PDF the plugin may not read. */
async function chooseThroughIde(): Promise<void> {
  try {
    const picked = await pickWithDialog(identity);
    if (picked) {
      await present(picked);
    }
  } catch (error) {
    showError(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The browser's own file dialog: no IDE bridge involved, always available. */
function chooseFromDisk(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/pdf,.pdf";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) {
      void fileToOpened(file, identity).then(present);
    }
  });
  input.click();
}

/** A sentence for why the IDE could not provide the tab's bytes. */
function whyAsked(): string | null {
  const reason = inPlaceHint();
  if (!reason) {
    return null;
  }
  if (reason.includes("project.read")) {
    return "Reading the project file needs the plugin's project.read permission.";
  }
  if (reason.includes("MiB")) {
    return "The IDE's direct byte bridge supports files up to 64 MiB, and project.read-bytes supports up to 16 MiB.";
  }
  if (reason.includes("no open project")) {
    return "This tab is not in an open project.";
  }
  return null;
}

/** The empty state: the user picks the PDF once. */
function showChooser(name: string): void {
  const why = whyAsked();
  overlay.show({
    title: "Open the PDF",
    body: why
      ? `${why} “${name}” is asked for once and kept in the plugin's own folder afterwards, so this tab opens straight away next time.`
      : `OpenIDEA's plugin API cannot hand a plugin the bytes of this PDF, so “${name}” is asked for once. ` +
        "It is kept in the plugin's own folder afterwards, and this tab opens straight away.",
    actions: [
      { label: "Choose the PDF…", primary: true, run: () => void chooseThroughIde() },
      { label: "From disk…", run: chooseFromDisk },
    ],
    drop: true,
  });
}

/* ------------------------------------------------------------------- theme */

function followTheme(): void {
  const apply = (theme: { dark: boolean } | null | undefined): void => {
    const dark = theme ? theme.dark : window.matchMedia?.("(prefers-color-scheme: dark)").matches !== false;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };
  apply(openidea?.theme);
  openidea?.onThemeChange(apply);
}

/* ------------------------------------------------------------------- input */

function wireWheelZoom(): void {
  const container = byId<HTMLDivElement>("viewer-container");
  container.addEventListener(
    "wheel",
    (event) => {
      if ((!event.ctrlKey && !event.metaKey) || !reader.document || event.deltaY === 0) {
        return;
      }
      // The modifier-wheel gesture is reserved for the PDF, not the browser's
      // page zoom. Scale proportionally so trackpads and mouse wheels both work.
      event.preventDefault();
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * container.clientHeight
            : event.deltaY;
      const boundedDelta = Math.max(-200, Math.min(200, delta));
      reader.zoomBy(Math.exp(-boundedDelta * 0.0015));
    },
    { passive: false },
  );
}

function wireKeys(): void {
  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      toolbar.focusSearch();
      return;
    }
    // Plain keys only: Cmd/Ctrl/Alt combinations belong to the IDE (Cmd+R must
    // not rotate the page), and Shift would change what the key means.
    if (typing || mod || event.altKey) {
      return;
    }
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        reader.goToPage(reader.pageNumber - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        reader.goToPage(reader.pageNumber + 1);
        break;
      case "+":
      case "=":
        event.preventDefault();
        reader.zoomBy(1.15);
        break;
      case "-":
        event.preventDefault();
        reader.zoomBy(1 / 1.15);
        break;
      case "0":
        event.preventDefault();
        reader.setScale("page-width");
        break;
      case "9":
        event.preventDefault();
        reader.setScale("page-fit");
        break;
      case "r":
      case "R":
        reader.rotate();
        void reflow();
        break;
      case "Escape":
        reader.stopFind();
        break;
      default:
        break;
    }
  });
}

function wireDrop(): void {
  const swallow = (event: DragEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("dragover", (event) => {
    swallow(event);
    document.body.classList.add("dropping");
  });
  document.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) {
      document.body.classList.remove("dropping");
    }
  });
  document.addEventListener("drop", (event) => {
    swallow(event);
    document.body.classList.remove("dropping");
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void fileToOpened(file, identity).then(present);
    }
  });
}

/* -------------------------------------------------------------------- boot */

async function main(): Promise<void> {
  followTheme();
  wireKeys();
  wireWheelZoom();
  wireDrop();
  paintStatus();
  // Nothing to navigate or zoom until a file is in.
  toolbar.setEnabled(false);

  if (!openidea) {
    overlay.show({
      title: "PDF Viewer",
      body: "This page is part of an OpenIDEA plugin and only works inside the IDE.",
    });
    return;
  }

  code = new CodeBridge(
    (text) => openidea.postMessage(text),
    (listener) => openidea.onMessage(listener),
  );

  let documentName = "document.pdf";
  let documentText = "";
  try {
    const state = await openidea.document.get();
    documentName = state.name || documentName;
    documentText = state.text ?? "";
  } catch {
    // No document (a tool window rather than an editor tab): the dialog below
    // is the only way in.
  }
  document.title = documentName;

  // API 1.5: the tab's absolute path, so cached picks for two files of the
  // same name stay separate. It is only a cache identity; document.bytes()
  // itself is scoped by the custom editor to its own file.
  const path = await code.info();
  identity = path && baseName(path) === documentName ? path : documentName;

  const opened = await findBytes(code, identity, documentName, documentText, () => openidea.document.bytes());
  if (opened) {
    await present(opened);
    return;
  }
  showChooser(documentName);
}

void main().catch((error: unknown) => {
  showError(error instanceof Error ? error : new Error(String(error)));
});

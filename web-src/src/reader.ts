/**
 * The reading surface: pdf.js's own viewer components (continuous scroll,
 * text layer for selection, annotations and links, the find controller),
 * wrapped in this plugin's toolbar and sidebars.
 *
 * pdf.js runs its parser in a Worker. The frame is an opaque origin, so a
 * worker script from the `openidea-plugin` scheme is cross-origin and cannot
 * be constructed; pdf.js falls back to a main-thread ("fake") worker by
 * itself, which is what happens here. Rendering is asked to stay on the main
 * thread too (`disableWorkerRendering`), so nothing else tries to spawn one.
 */

import {
  AbortException,
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist";
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";

/** `TextLayerMode.ENABLE` / `AnnotationMode.ENABLE_FORMS`, as numbers: the
 * enums live in pdf.js's internal build. */
const TEXT_LAYER_ENABLE = 1;
const ANNOTATION_FORMS = 2;

/** Where the page's own assets are (all relative to it). */
const ASSETS = {
  worker: "./pdf.worker.mjs",
  cmaps: "./cmaps/",
  standardFonts: "./standard_fonts/",
  wasm: "./wasm/",
  icc: "./iccs/",
};

GlobalWorkerOptions.workerSrc = new URL(ASSETS.worker, document.baseURI).href;

export interface OutlineNode {
  title: string;
  page: number | null;
  children: OutlineNode[];
}

export type ViewMode = "single" | "continuous" | "spread";

export interface ReaderEvents {
  /** The page in view changed. */
  page(page: number, pages: number): void;
  /** Zoom changed: `label` is what the toolbar shows. */
  scale(label: string): void;
  /** Find results changed; `pending` while pdf.js is still searching. */
  search(current: number, total: number, pending: boolean): void;
  /** The document is loaded: its pages and title. */
  ready(pages: number): void;
  /** Loading or rendering failed. */
  error(error: Error): void;
}

/** pdf.js `FindState` values this page cares about. */
const FIND_NOT_FOUND = 1;
const FIND_PENDING = 3;

export class Reader {
  #eventBus = new EventBus();
  #linkService: PDFLinkService;
  #findController: PDFFindController;
  #viewer: PDFViewer;
  #doc: PDFDocumentProxy | null = null;
  #task: PDFDocumentLoadingTask | null = null;
  #query = "";
  #destroyed = false;
  /** The fit mode to re-apply when the reading area changes size, if any. */
  #preset: "page-width" | "page-fit" | null = "page-width";
  #resize: ResizeObserver;

  constructor(
    container: HTMLDivElement,
    viewer: HTMLDivElement,
    private readonly events: ReaderEvents,
  ) {
    this.#linkService = new PDFLinkService({ eventBus: this.#eventBus, externalLinkRel: "noopener noreferrer" });
    this.#findController = new PDFFindController({ eventBus: this.#eventBus, linkService: this.#linkService });
    this.#viewer = new PDFViewer({
      container,
      viewer,
      eventBus: this.#eventBus,
      linkService: this.#linkService,
      findController: this.#findController,
      textLayerMode: TEXT_LAYER_ENABLE,
      annotationMode: ANNOTATION_FORMS,
    });
    this.#linkService.setViewer(this.#viewer);
    this.#listen();
    // The sidebar, the status line and the frame's own width all change the
    // reading area; pdf.js reloads a *fit* scale only for its own resize
    // events, which a scrollbar appearing does not always raise.
    this.#resize = new ResizeObserver(() => this.#refit());
    this.#resize.observe(container);
  }

  #listen(): void {
    const bus = this.#eventBus;
    bus.on("pagesinit", () => {
      // Start at a width that fits: the usual way to read a paper.
      this.setScale("page-width");
    });
    bus.on("pagechanging", (event: { pageNumber: number }) => {
      this.events.page(event.pageNumber, this.#viewer.pagesCount);
    });
    bus.on("scalechanging", () => {
      this.events.scale(this.#scaleLabel());
    });
    bus.on("updatefindmatchescount", (event: { matchesCount: { current: number; total: number } }) => {
      this.events.search(event.matchesCount.current, event.matchesCount.total, false);
    });
    bus.on("updatefindcontrolstate", (event: { state: number; matchesCount: { current: number; total: number } }) => {
      const pending = event.state === FIND_PENDING;
      const total = event.state === FIND_NOT_FOUND ? 0 : event.matchesCount.total;
      this.events.search(event.state === FIND_NOT_FOUND ? 0 : event.matchesCount.current, total, pending);
    });
  }

  get pagesCount(): number {
    return this.#viewer.pagesCount;
  }

  get pageNumber(): number {
    return this.#viewer.currentPageNumber;
  }

  get document(): PDFDocumentProxy | null {
    return this.#doc;
  }

  /** Opens `bytes` as the document shown. Replaces whatever was shown.
   * `false` when it could not be opened (the error has been reported). */
  async open(bytes: Uint8Array): Promise<boolean> {
    this.#destroyed = false;
    try {
      const task = getDocument({
        // pdf.js takes ownership of the buffer; callers hand over one they
        // do not need afterwards (the cache keeps its own copy).
        data: bytes,
        cMapUrl: new URL(ASSETS.cmaps, document.baseURI).href,
        cMapPacked: true,
        standardFontDataUrl: new URL(ASSETS.standardFonts, document.baseURI).href,
        wasmUrl: new URL(ASSETS.wasm, document.baseURI).href,
        iccUrl: new URL(ASSETS.icc, document.baseURI).href,
        // Nothing is fetched: every file is in the package.
        useWorkerFetch: true,
        // Drawing happens on this thread: the frame cannot start the second
        // worker pdf.js would use for rendering.
        disableWorkerRendering: true,
      });
      this.#task = task;
      const doc = await task.promise;
      if (this.#destroyed) {
        await task.destroy();
        return false;
      }
      this.#doc = doc;
      this.#viewer.setDocument(doc);
      this.#linkService.setDocument(doc, null);
      // The find controller is not wired by the viewer: without this it waits
      // for a document forever and every search stays pending.
      this.#findController.setDocument(doc);
      this.#query = "";
      this.events.ready(doc.numPages);
      this.events.page(1, doc.numPages);
      return true;
    } catch (error) {
      if (error instanceof AbortException) {
        return false; // superseded by another open
      }
      this.events.error(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  goToPage(page: number): void {
    const clamped = Math.min(Math.max(1, Math.floor(page) || 1), Math.max(1, this.#viewer.pagesCount));
    if (clamped !== this.#viewer.currentPageNumber) {
      this.#viewer.currentPageNumber = clamped;
    }
  }

  /** Change how pages are arranged without losing the current page or zoom. */
  setViewMode(mode: ViewMode): void {
    // These numeric values are pdf.js's exported ScrollMode / SpreadMode
    // constants (the constants themselves are not declared in its type file).
    const scrollMode = mode === "single" ? 3 : 0; // PAGE : VERTICAL
    const spreadMode = mode === "spread" ? 2 : 0; // EVEN : NONE (leave page 1 as a cover)
    this.#viewer.spreadMode = spreadMode;
    this.#viewer.scrollMode = scrollMode;
  }

  /** `"page-width"`, `"page-fit"`, `"auto"`, or a number (1 = 100%). */
  setScale(value: string | number): void {
    this.#preset = value === "page-width" ? "page-width" : value === "page-fit" ? "page-fit" : null;
    this.#viewer.currentScaleValue = String(value);
    this.events.scale(this.#scaleLabel());
  }

  zoomBy(factor: number): void {
    const scale = this.#viewer.currentScale * factor;
    this.#preset = null;
    this.#viewer.currentScale = Math.min(Math.max(scale, 0.1), 8);
    this.events.scale(this.#scaleLabel());
  }

  /** Re-applies a fit mode after the reading area changed size. */
  #refit(): void {
    const preset = this.#preset;
    if (!preset || this.#viewer.pagesCount === 0) {
      return;
    }
    requestAnimationFrame(() => {
      if (this.#preset === preset) {
        this.#viewer.currentScaleValue = preset;
      }
    });
  }

  /** The current zoom as a percentage. */
  get zoom(): number {
    return this.#viewer.currentScale;
  }

  rotate(): void {
    this.#viewer.pagesRotation = (this.#viewer.pagesRotation + 90) % 360;
  }

  get rotation(): number {
    return this.#viewer.pagesRotation;
  }

  #scaleLabel(): string {
    const preset = this.#viewer.currentScaleValue;
    if (preset === "page-width") {
      return "Fit width";
    }
    if (preset === "page-fit") {
      return "Fit page";
    }
    return `${Math.round(this.#viewer.currentScale * 100)}%`;
  }

  /** Searches the whole document, highlighting every match. */
  find(query: string): void {
    this.#query = query;
    if (!query) {
      this.stopFind();
      return;
    }
    this.events.search(0, 0, true);
    this.#dispatchFind("");
  }

  /** The next match (`back`: the previous one). */
  findAgain(back = false): void {
    if (!this.#query) {
      return;
    }
    this.#dispatchFind("again", back);
  }

  #dispatchFind(type: "" | "again", back = false): void {
    this.#eventBus.dispatch("find", {
      source: null,
      type,
      query: this.#query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: back,
      matchDiacritics: false,
      phraseSearch: true,
    });
  }

  stopFind(): void {
    this.#query = "";
    this.#eventBus.dispatch("findbarclose", { source: null });
    this.events.search(0, 0, false);
  }

  /** The outline (bookmarks), or `null` when the document has none. */
  async outline(): Promise<OutlineNode[] | null> {
    const doc = this.#doc;
    if (!doc) {
      return null;
    }
    const items = await doc.getOutline();
    if (!items || items.length === 0) {
      return null;
    }
    const resolve = async (item: { title: string; dest: string | unknown[] | null; items?: unknown[] }): Promise<OutlineNode> => {
      const children = await Promise.all((item.items ?? []).map((child) => resolve(child as never)));
      return { title: item.title, page: await this.#pageOf(item.dest), children };
    };
    return Promise.all(items.map((item) => resolve(item as never)));
  }

  async #pageOf(dest: string | unknown[] | null): Promise<number | null> {
    const doc = this.#doc;
    if (!doc || !dest) {
      return null;
    }
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) {
        return null;
      }
      const ref = explicit[0];
      if (typeof ref === "number") {
        return ref + 1;
      }
      return (await doc.getPageIndex(ref as never)) + 1;
    } catch {
      return null;
    }
  }

  /** A page rendered small, for the thumbnails sidebar. */
  async thumbnail(pageNumber: number, width: number): Promise<HTMLCanvasElement | null> {
    const doc = this.#doc;
    if (!doc) {
      return null;
    }
    const page: PDFPageProxy = await doc.getPage(pageNumber);
    const rotation = this.#viewer.pagesRotation;
    const base = page.getViewport({ scale: 1, rotation });
    // Draw at device resolution, show at CSS resolution: a thumbnail stays
    // sharp on a retina screen.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (width / base.width) * ratio, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
    canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
    await page.render({ canvas, viewport }).promise;
    return canvas;
  }

  /** Releases the document (the page is going away). */
  destroy(): void {
    this.#destroyed = true;
    this.#resize.disconnect();
    void this.#task?.destroy();
    this.#task = null;
    this.#doc = null;
  }
}

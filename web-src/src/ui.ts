/**
 * The viewer's chrome: toolbar, outline/thumbnail sidebar, status line and the
 * overlay the page shows while it waits for a file or explains a failure.
 *
 * Plain DOM and the IDE's theme variables — no framework, so the bundle stays
 * small and nothing re-renders while pdf.js draws.
 */

import type { OutlineNode, ViewMode } from "./reader";

/* ------------------------------------------------------------------ icons */

const SVG = (body: string): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  sidebar: SVG('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M6.25 2.75v10.5"/>'),
  prev: SVG('<path d="M9.75 3.5 5.25 8l4.5 4.5"/>'),
  next: SVG('<path d="M6.25 3.5 10.75 8l-4.5 4.5"/>'),
  first: SVG('<path d="M6.5 3.5 2.5 8l4 4.5"/><path d="M10.5 3.5 6.5 8l4 4.5"/>'),
  zoomOut: SVG('<path d="M3.5 8h9"/>'),
  zoomIn: SVG('<path d="M3.5 8h9"/><path d="M8 3.5v9"/>'),
  fitWidth: SVG('<path d="M1.75 8h12.5"/><path d="M4.5 5.5 2 8l2.5 2.5"/><path d="M11.5 5.5 14 8l-2.5 2.5"/>'),
  fitPage: SVG('<rect x="3.25" y="2.25" width="9.5" height="11.5" rx="1"/>'),
  rotate: SVG('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.25 2.5v2.75h-2.75"/>'),
  search: SVG('<circle cx="7.25" cy="7.25" r="4"/><path d="m10.25 10.25 3 3"/>'),
  reload: SVG('<path d="M2.75 8a5.25 5.25 0 1 1 1.7 3.9"/><path d="M2.5 13.25V10.5h2.75"/>'),
  outline: SVG('<path d="M2.5 4h1.5"/><path d="M2.5 8h1.5"/><path d="M2.5 12h1.5"/><path d="M6.5 4h7"/><path d="M6.5 8h7"/><path d="M6.5 12h7"/>'),
  pages: SVG('<rect x="2.5" y="2.5" width="6" height="7.5" rx="1"/><rect x="7.5" y="6" width="6" height="7.5" rx="1"/>'),
};

/* ------------------------------------------------------------------ helpers */

type Props = {
  class?: string;
  text?: string;
  title?: string;
  html?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: never) => void>>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) {
    node.className = props.class;
  }
  if (props.text !== undefined) {
    node.textContent = props.text;
  }
  if (props.html !== undefined) {
    node.innerHTML = props.html;
  }
  if (props.title) {
    node.title = props.title;
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(type, handler as EventListener);
  }
  if (children.length > 0) {
    node.append(...children);
  }
  return node;
}

function iconButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", { class: "icon-button", title, html: icon, on: { click: onClick } });
  button.type = "button";
  button.setAttribute("aria-label", title);
  return button;
}

/* ------------------------------------------------------------------ toolbar */

export interface ToolbarActions {
  toggleSidebar(): void;
  step(delta: number): void;
  goToPage(page: number): void;
  zoom(factor: number): void;
  fit(mode: "width" | "page"): void;
  rotate(): void;
  setViewMode(mode: ViewMode): void;
  search(query: string): void;
  findAgain(back: boolean): void;
  reload(): void;
}

export class Toolbar {
  #pageInput: HTMLInputElement;
  #pageCount: HTMLElement;
  #scaleLabel: HTMLElement;
  #searchInput: HTMLInputElement;
  #searchCount: HTMLElement;
  #viewSelect: HTMLSelectElement;
  #root: HTMLElement;

  constructor(root: HTMLElement, actions: ToolbarActions) {
    this.#root = root;
    const group = (name: string, ...children: (HTMLElement | string)[]): HTMLElement => {
      const node = el("div", { class: `group ${name}` });
      for (const child of children) {
        node.append(child);
      }
      return node;
    };

    this.#pageInput = el("input", {
      class: "page-number",
      attrs: { type: "text", inputmode: "numeric", "aria-label": "Page number", value: "1", spellcheck: "false" },
      on: {
        keydown: (event: KeyboardEvent) => {
          if (event.key === "Enter") {
            actions.goToPage(Number(this.#pageInput.value));
            this.#pageInput.blur();
          } else if (event.key === "Escape") {
            this.#pageInput.blur();
          }
        },
        focus: () => this.#pageInput.select(),
        blur: () => {
          // Typing a page and clicking away: go there, like Enter.
          const page = Number(this.#pageInput.value);
          if (Number.isFinite(page) && page >= 1) {
            actions.goToPage(page);
          }
        },
      },
    });
    this.#pageCount = el("span", { class: "page-count", text: "" });
    this.#scaleLabel = el("span", { class: "scale-label", text: "—" });
    this.#searchCount = el("span", { class: "search-count", text: "" });
    this.#viewSelect = el(
      "select",
      {
        class: "view-select",
        title: "Page layout",
        attrs: { "aria-label": "Page layout" },
        on: { change: () => actions.setViewMode(this.#viewSelect.value as ViewMode) },
      },
      el("option", { text: "Single page", attrs: { value: "single" } }),
      el("option", { text: "Continuous", attrs: { value: "continuous" } }),
      el("option", { text: "Side by side", attrs: { value: "spread" } }),
    );
    this.#viewSelect.value = "continuous";

    this.#searchInput = el("input", {
      class: "search-input",
      attrs: { type: "search", placeholder: "Search", "aria-label": "Search the document", spellcheck: "false" },
      on: {
        input: () => actions.search(this.#searchInput.value),
        keydown: (event: KeyboardEvent) => {
          if (event.key === "Enter") {
            event.preventDefault();
            actions.findAgain(event.shiftKey);
          } else if (event.key === "Escape") {
            this.#searchInput.value = "";
            actions.search("");
            this.#searchInput.blur();
          }
        },
      },
    });

    root.append(
      group("left", iconButton(ICONS.sidebar, "Outline and pages", actions.toggleSidebar)),
      group(
        "page",
        iconButton(ICONS.prev, "Previous page", () => actions.step(-1)),
        this.#pageInput,
        this.#pageCount,
        iconButton(ICONS.next, "Next page", () => actions.step(1)),
      ),
      group("layout", el("label", { class: "view-control" }, el("span", { text: "View" }), this.#viewSelect)),
      group(
        "zoom",
        iconButton(ICONS.zoomOut, "Zoom out", () => actions.zoom(1 / 1.15)),
        this.#scaleLabel,
        iconButton(ICONS.zoomIn, "Zoom in", () => actions.zoom(1.15)),
        iconButton(ICONS.fitWidth, "Fit width", () => actions.fit("width")),
        iconButton(ICONS.fitPage, "Fit page", () => actions.fit("page")),
        iconButton(ICONS.rotate, "Rotate clockwise", actions.rotate),
      ),
      group(
        "search",
        el("span", { class: "search-wrap" }, el("span", { class: "search-icon", html: ICONS.search }), this.#searchInput),
        this.#searchCount,
        iconButton(ICONS.prev, "Previous match (Shift+Enter)", () => actions.findAgain(true)),
        iconButton(ICONS.next, "Next match (Enter)", () => actions.findAgain(false)),
      ),
      group("right", iconButton(ICONS.reload, "Open the file again", actions.reload)),
    );
  }

  setEnabled(enabled: boolean): void {
    for (const button of this.#root.querySelectorAll("button")) {
      if (button.title !== "Open the file again") {
        button.disabled = !enabled;
      }
    }
    this.#pageInput.disabled = !enabled;
    this.#viewSelect.disabled = !enabled;
    this.#searchInput.disabled = !enabled;
  }

  setPages(pages: number): void {
    this.#pageCount.textContent = pages > 0 ? `/ ${pages}` : "";
    this.#pageInput.setAttribute("max", String(pages));
  }

  setPage(page: number): void {
    if (document.activeElement !== this.#pageInput) {
      this.#pageInput.value = String(page);
    }
  }

  setScale(label: string): void {
    this.#scaleLabel.textContent = label;
  }

  setSearch(current: number, total: number, pending: boolean): void {
    if (!this.#searchInput.value) {
      this.#searchCount.textContent = "";
      this.#searchCount.classList.remove("empty");
      return;
    }
    this.#searchCount.textContent = pending && total === 0 ? "…" : total === 0 ? "no results" : `${current}/${total}`;
    this.#searchCount.classList.toggle("empty", total === 0 && !pending);
  }

  focusSearch(): void {
    this.#searchInput.focus();
    this.#searchInput.select();
  }

  get searching(): boolean {
    return this.#searchInput.value.length > 0;
  }
}

/* ------------------------------------------------------------------ sidebar */

export interface SidebarActions {
  goToPage(page: number): void;
}

type Tab = "outline" | "pages";

export class Sidebar {
  #outlineTab: HTMLButtonElement;
  #pagesTab: HTMLButtonElement;
  #body: HTMLElement;
  #tab: Tab = "outline";
  #outline: OutlineNode[] | null = null;
  #render: ((page: number, width: number) => Promise<HTMLCanvasElement | null>) | null = null;
  #pages = 0;
  #root: HTMLElement;
  #current = 1;

  constructor(root: HTMLElement, private readonly actions: SidebarActions) {
    this.#root = root;
    this.#outlineTab = el("button", { class: "sidebar-tab", text: "Outline", on: { click: () => this.setTab("outline") } });
    this.#pagesTab = el("button", { class: "sidebar-tab", text: "Pages", on: { click: () => this.setTab("pages") } });
    this.#body = el("div", { class: "sidebar-body" });
    root.append(el("div", { class: "sidebar-tabs" }, this.#outlineTab, this.#pagesTab), this.#body);
  }

  get visible(): boolean {
    return !this.#root.hidden;
  }

  setVisible(visible: boolean): void {
    this.#root.hidden = !visible;
    if (visible) {
      this.#paint();
    }
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  /** A new document: its outline (or `null`) and a page renderer. */
  reset(outline: OutlineNode[] | null, pages: number, render: (page: number, width: number) => Promise<HTMLCanvasElement | null>): void {
    this.#outline = outline;
    this.#pages = pages;
    this.#render = render;
    this.#current = 1;
    this.#outlineTab.disabled = !outline;
    if (!outline && this.#tab === "outline") {
      this.#tab = "pages";
    }
    if (this.visible) {
      this.#paint();
    }
  }

  setCurrentPage(page: number): void {
    this.#current = page;
    if (this.visible && this.#tab === "pages") {
      for (const item of this.#body.querySelectorAll<HTMLElement>(".thumb")) {
        item.classList.toggle("current", Number(item.dataset.page) === page);
      }
    }
  }

  setTab(tab: Tab): void {
    if (tab === "outline" && !this.#outline) {
      tab = "pages";
    }
    this.#tab = tab;
    if (this.visible) {
      this.#paint();
    }
  }

  #paint(): void {
    this.#outlineTab.classList.toggle("active", this.#tab === "outline");
    this.#pagesTab.classList.toggle("active", this.#tab === "pages");
    this.#body.replaceChildren();
    if (this.#tab === "outline" && this.#outline) {
      this.#paintOutline(this.#outline, this.#body, 0);
    } else {
      this.#paintThumbs();
    }
  }

  #paintOutline(nodes: OutlineNode[], parent: HTMLElement, depth: number): void {
    const list = el("div", { class: "outline-list" });
    for (const node of nodes) {
      const row = el("button", {
        class: "outline-row",
        title: node.title,
        on: {
          click: () => {
            if (node.page) {
              this.actions.goToPage(node.page);
            }
          },
        },
      });
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.append(el("span", { class: "outline-title", text: node.title }));
      if (node.page) {
        row.append(el("span", { class: "outline-page", text: String(node.page) }));
      }
      row.disabled = !node.page;
      list.append(row);
      if (node.children.length) {
        this.#paintOutline(node.children, list, depth + 1);
      }
    }
    parent.append(list);
  }

  #paintThumbs(): void {
    const grid = el("div", { class: "thumbs" });
    this.#body.append(grid);
    const render = this.#render;
    if (!render) {
      return;
    }
    // Only the pages that come into view are rendered: a 900-page scan would
    // otherwise draw 900 canvases.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const thumb = entry.target as HTMLElement;
          observer.unobserve(thumb);
          const page = Number(thumb.dataset.page);
          void render(page, 108).then(
            (canvas) => {
              if (canvas) {
                thumb.querySelector(".thumb-sheet")?.replaceChildren(canvas);
              }
              thumb.classList.remove("loading");
            },
            () => thumb.classList.remove("loading"),
          );
        }
      },
      { root: this.#body, rootMargin: "160px" },
    );
    for (let page = 1; page <= this.#pages; page++) {
      const thumb = el("button", { class: "thumb loading", attrs: { "data-page": String(page) }, on: { click: () => this.actions.goToPage(page) } });
      thumb.classList.toggle("current", page === this.#current);
      thumb.append(
        el("span", { class: "thumb-sheet" }),
        el("span", { class: "thumb-number", text: String(page) }),
      );
      grid.append(thumb);
      observer.observe(thumb);
    }
  }
}

/* ------------------------------------------------------------------ status */

export class StatusBar {
  #left: HTMLElement;
  #right: HTMLElement;

  constructor(root: HTMLElement) {
    this.#left = el("span", { class: "status-left" });
    this.#right = el("span", { class: "status-right" });
    root.append(this.#left, this.#right);
  }

  setLeft(text: string): void {
    this.#left.textContent = text;
  }

  setRight(text: string): void {
    this.#right.textContent = text;
  }
}

/* ------------------------------------------------------------------ overlay */

export interface OverlayAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

/**
 * A card over the reading area: the empty state before a file is chosen, and
 * the explanation when something failed. `body` is plain text (never HTML:
 * file names and error messages come from outside this page).
 */
export class Overlay {
  #root: HTMLElement;

  constructor(root: HTMLElement) {
    this.#root = root;
  }

  show(options: { title: string; body: string; detail?: string; actions?: OverlayAction[]; drop?: boolean }): void {
    const card = el("div", { class: "card" });
    card.append(el("h2", { text: options.title }), el("p", { text: options.body }));
    if (options.detail) {
      card.append(el("pre", { class: "detail", text: options.detail }));
    }
    const actions = el("div", { class: "actions" });
    for (const action of options.actions ?? []) {
      const button = el("button", { class: `button${action.primary ? " primary" : ""}`, text: action.label, on: { click: action.run } });
      button.type = "button";
      actions.append(button);
    }
    if (actions.childElementCount > 0) {
      card.append(actions);
    }
    if (options.drop) {
      card.append(el("p", { class: "hint", text: "You can also drop a PDF here." }));
    }
    this.#root.replaceChildren(card);
    this.#root.hidden = false;
  }

  hide(): void {
    this.#root.hidden = true;
    this.#root.replaceChildren();
  }
}

/** Formats a byte count for the status line. */
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

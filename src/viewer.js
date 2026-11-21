// Thin wrapper around the pdf.js viewer components: rendering, text selection, links,
// search, forms and annotation editing all come from pdf.js.
import { pdfjsLib } from "./pdfjs-global.js";
import {
  EventBus, PDFViewer, PDFLinkService, PDFFindController,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

const { AnnotationEditorType, AnnotationEditorParamsType, PasswordResponses } = pdfjsLib;

export const Param = AnnotationEditorParamsType;

// pdf.js's default highlighter palette; it needs the names to label highlights.
export const HIGHLIGHT_COLORS = {
  yellow: "#FFFF98", green: "#53FFBC", blue: "#80EBFF", pink: "#FFCBE6", red: "#FF4F5F",
};

export const Tool = {
  SELECT: AnnotationEditorType.NONE,
  HIGHLIGHT: AnnotationEditorType.HIGHLIGHT,
  DRAW: AnnotationEditorType.INK,
  TEXT: AnnotationEditorType.FREETEXT,
  IMAGE: AnnotationEditorType.STAMP,
};

// Absolute, because pdf.js may fetch these from inside its worker.
const ASSETS = new URL("pdfjs/", document.baseURI).href;

export class CancelledError extends Error {}

/** Start loading a PDF with the asset URLs pdf.js needs. */
export function loadPdf(bytes) {
  return pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js transfers (detaches) the buffer it is given
    cMapUrl: ASSETS + "cmaps/",
    standardFontDataUrl: ASSETS + "standard_fonts/",
    wasmUrl: ASSETS + "wasm/",
    iccUrl: ASSETS + "iccs/",
  });
}

const MODE_SWITCH_TIMEOUT_MS = 5000;

/** @param {HTMLElement} container absolutely positioned, with a `.pdfViewer` child */
export function createViewer(container, { askPassword }) {
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({
    container, eventBus, linkService, findController,
    annotationEditorMode: AnnotationEditorType.NONE,
    annotationEditorHighlightColors: Object.entries(HIGHLIGHT_COLORS)
      .map(([name, hex]) => `${name}=${hex}`).join(","),
  });
  linkService.setViewer(viewer);

  let doc = null;
  // The tool the user picked. It is re-applied whenever a document's editor becomes ready,
  // so a click made while a tab is still loading is not lost.
  let tool = AnnotationEditorType.NONE;
  let uiManager = null; // pdf.js editor manager for the current document, once ready
  const applyTool = () => {
    if (!doc || !uiManager || viewer.annotationEditorMode === tool) return;
    viewer.annotationEditorMode = { mode: tool };
  };
  // Pen/text/highlight styles the user picked; pdf.js keeps them per editor type, and we
  // resend them whenever editing turns on so every document gets them.
  const styles = new Map();
  const sendStyle = (type, value) =>
    eventBus.dispatch("switchannotationeditorparams", { source: viewer, type, value });
  eventBus.on("annotationeditoruimanager", (e) => {
    uiManager = e.uiManager;
    setTimeout(applyTool, 0); // let pdf.js finish setDocument first
  });
  // whether pdf.js has annotation steps of its own to undo/redo for the open document
  let editorHistory = { undo: false, redo: false };
  eventBus.on("editingstateschanged", ({ details }) => {
    editorHistory = { undo: details.hasSomethingToUndo ?? editorHistory.undo, redo: details.hasSomethingToRedo ?? editorHistory.redo };
  });
  eventBus.on("annotationeditormodechanged", ({ mode }) => {
    if (mode !== AnnotationEditorType.NONE) for (const [t, v] of styles) sendStyle(t, v);
  });

  /** Switch pdf.js into `mode` and wait until it is really there. */
  function enterMode(mode) {
    tool = mode;
    if (viewer.annotationEditorMode === mode) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (e) => {
        if (e.mode !== mode) return;
        eventBus.off("annotationeditormodechanged", done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        eventBus.off("annotationeditormodechanged", done);
        reject(new Error("Couldn't switch editing mode — try again."));
      }, MODE_SWITCH_TIMEOUT_MS);
      eventBus.on("annotationeditormodechanged", done);
      viewer.annotationEditorMode = { mode };
    });
  }
  // Ink strokes live in an open "drawing session" until it ends; only then are they in the
  // document. End it before anyone asks whether there are edits.
  const flushDrawing = () => uiManager?.endCurrentEditing();
  let modified = false; // edits since open or last save
  let restoreView = null;
  eventBus.on("pagesinit", () => {
    viewer.currentScaleValue = restoreView?.scale ?? "page-width";
    if (restoreView) viewer.currentPageNumber = Math.min(restoreView.page, viewer.pagesCount);
    restoreView = null;
  });

  async function open(bytes, { keepView = false } = {}) {
    let cancelled = false;
    const task = loadPdf(bytes);
    task.onPassword = async (update, reason) => {
      const pw = await askPassword(reason === PasswordResponses.INCORRECT_PASSWORD);
      if (pw == null) { cancelled = true; task.destroy(); } else update(pw);
    };
    let next;
    try {
      next = await task.promise;
    } catch (err) {
      throw cancelled ? new CancelledError() : err;
    }
    restoreView = keepView && doc
      ? { scale: viewer.currentScaleValue, page: viewer.currentPageNumber } : null;
    const prev = doc;
    doc = next;
    uiManager = null;
    editorHistory = { undo: false, redo: false };
    modified = false;
    next.annotationStorage.onSetModified = () => { modified = true; };
    next.annotationStorage.onResetModified = () => { modified = false; };
    viewer.setDocument(next);
    linkService.setDocument(next);
    await prev?.loadingTask.destroy();
    return next;
  }

  async function close() {
    const prev = doc;
    doc = null;
    uiManager = null;
    modified = false;
    viewer.setDocument(null);
    linkService.setDocument(null);
    await prev?.loadingTask.destroy();
  }

  const hasEdits = () => {
    flushDrawing();
    return Boolean(doc && doc.annotationStorage.size > 0);
  };

  return {
    eventBus,
    open,
    close,
    hasEdits,
    /** True when there are annotation/form edits the user hasn't saved yet. */
    isModified: () => { flushDrawing(); return modified; },
    markSaved: () => doc?.annotationStorage.resetModified(),
    /** Bytes including any form input and annotations. */
    currentBytes: async (fallback) => (hasEdits() ? doc.saveDocument() : fallback),
    setTool: (mode) => { tool = mode; applyTool(); },
    /** Set a default style (Param.*) for new drawings; also restyles the selected ones. */
    setStyle: (type, value) => {
      styles.set(type, value);
      if (uiManager) sendStyle(type, value);
    },
    /** Place an image (e.g. a signature) as a movable, resizable annotation on the visible page. */
    addImage: async (file) => {
      if (!doc || !uiManager) throw new Error("The document is still loading — try again in a moment.");
      await enterMode(AnnotationEditorType.STAMP);
      await uiManager.currentLayer.pasteEditor({ mode: AnnotationEditorType.STAMP }, { bitmapFile: file });
    },
    canUndo: () => editorHistory.undo,
    canRedo: () => editorHistory.redo,
    undo: () => eventBus.dispatch("editingaction", { source: viewer, name: "undo" }),
    redo: () => eventBus.dispatch("editingaction", { source: viewer, name: "redo" }),
    find: (query, { again = false, previous = false } = {}) =>
      eventBus.dispatch("find", {
        source: null, type: again ? "again" : "", query, caseSensitive: false,
        entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false,
      }),
    zoomIn: () => viewer.increaseScale(),
    zoomOut: () => viewer.decreaseScale(),
    /** Zoom by a factor, keeping the point under `origin` (client x,y) in place. */
    zoomBy: (scaleFactor, origin) => viewer.updateScale({ scaleFactor, origin, drawingDelay: 400 }),
    fitWidth: () => { viewer.currentScaleValue = "page-width"; },
    /** Whether the zoom follows the width of the view (so it should re-fit when the view narrows). */
    get fitsWidth() { return viewer.currentScaleValue === "page-width"; },
    goToPage: (n) => { viewer.currentPageNumber = n; },
    get pageCount() { return viewer.pagesCount; },
    /** pdf.js's view of page `n` (1-based): its `div` and current `viewport`. */
    pageView: (n) => viewer.getPageView(n - 1),
    /** The PDF user-space point under a pointer event on a `.page` element. */
    pdfPoint(pageDiv, e) {
      const { viewport } = viewer.getPageView(Number(pageDiv.dataset.pageNumber) - 1);
      const box = pageDiv.getBoundingClientRect();
      // clientWidth excludes the page border; the ratio also covers CSS-scaled pages mid-zoom
      const k = viewport.width / pageDiv.clientWidth;
      return viewport.convertToPdfPoint(
        (e.clientX - box.left - pageDiv.clientLeft) * k, (e.clientY - box.top - pageDiv.clientTop) * k);
    },
    /** Position `el` (a child of the page div) over a PDF user-space rect, in % so zoom keeps it in place. */
    placeOnPage(el, pageNumber, rect) {
      const { viewport } = viewer.getPageView(pageNumber - 1);
      const [x0, y0] = viewport.convertToViewportPoint(rect[0], rect[1]);
      const [x1, y1] = viewport.convertToViewportPoint(rect[2], rect[3]);
      Object.assign(el.style, {
        left: `${(Math.min(x0, x1) / viewport.width) * 100}%`,
        top: `${(Math.min(y0, y1) / viewport.height) * 100}%`,
        width: `${(Math.abs(x1 - x0) / viewport.width) * 100}%`,
        height: `${(Math.abs(y1 - y0) / viewport.height) * 100}%`,
      });
    },
    get scale() { return viewer.currentScale; },
  };
}

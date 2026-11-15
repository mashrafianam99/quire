// Thin wrapper around the pdf.js viewer components: rendering, text selection, links,
// search, forms and annotation editing all come from pdf.js.
import { pdfjsLib } from "./pdfjs-global.js";
import {
  EventBus, PDFViewer, PDFLinkService, PDFFindController,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

const { AnnotationEditorType, PasswordResponses } = pdfjsLib;

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

/** @param {HTMLElement} container absolutely positioned, with a `.pdfViewer` child */
export function createViewer(container, { askPassword }) {
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({
    container, eventBus, linkService, findController,
    annotationEditorMode: AnnotationEditorType.NONE,
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
  eventBus.on("annotationeditoruimanager", (e) => {
    uiManager = e.uiManager;
    setTimeout(applyTool, 0); // let pdf.js finish setDocument first
  });
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
    const task = pdfjsLib.getDocument({
      data: bytes.slice(), // pdf.js transfers (detaches) the buffer it is given
      cMapUrl: ASSETS + "cmaps/",
      standardFontDataUrl: ASSETS + "standard_fonts/",
      wasmUrl: ASSETS + "wasm/",
      iccUrl: ASSETS + "iccs/",
    });
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
    find: (query, { again = false, previous = false } = {}) =>
      eventBus.dispatch("find", {
        source: null, type: again ? "again" : "", query, caseSensitive: false,
        entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false,
      }),
    zoomIn: () => viewer.increaseScale(),
    zoomOut: () => viewer.decreaseScale(),
    fitWidth: () => { viewer.currentScaleValue = "page-width"; },
    goToPage: (n) => { viewer.currentPageNumber = n; },
    get pageCount() { return viewer.pagesCount; },
  };
}

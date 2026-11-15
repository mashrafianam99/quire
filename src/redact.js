// Redact mode: the user drags boxes over the pages. Marks are kept in PDF coordinates and
// redrawn whenever pdf.js re-renders a page, so they stay put while zooming.
// Applying them is done by redact-pdf.js (MuPDF), loaded only when needed.

const MIN_DRAG_PX = 4;

/**
 * @param {ReturnType<import("./viewer.js").createViewer>} viewer
 * @param {HTMLElement} container the scrolling viewer element
 * @param {() => void} onChange called when the mode or the marks change
 */
export function createRedactor(viewer, container, onChange) {
  let active = false;
  let marks = []; // {page: 0-based, rect: [x0,y0,x1,y1] in PDF user space}

  function draw(pageNumber) {
    const view = viewer.pageView(pageNumber);
    if (!view?.div) return;
    for (const old of view.div.querySelectorAll(".redact-mark")) old.remove();
    marks.forEach((mark, i) => {
      if (mark.page !== pageNumber - 1) return;
      const el = document.createElement("button");
      el.className = "redact-mark";
      el.dataset.index = i;
      el.setAttribute("aria-label", "Redaction area (click to remove)");
      viewer.placeOnPage(el, pageNumber, mark.rect);
      view.div.append(el);
    });
  }

  function setMarks(next, pageNumbers) {
    marks = next;
    for (const n of pageNumbers) draw(n);
    onChange();
  }

  container.addEventListener("pointerdown", (e) => {
    if (!active || e.button !== 0) return;
    const pageDiv = e.target.closest?.(".page");
    if (!pageDiv) return;
    e.preventDefault(); // no text selection or pdf.js editing while marking
    e.stopPropagation();
    const pageNumber = Number(pageDiv.dataset.pageNumber);

    const hit = e.target.closest(".redact-mark");
    if (hit) {
      const i = Number(hit.dataset.index);
      setMarks(marks.filter((_, j) => j !== i), [pageNumber]);
      return;
    }

    const start = viewer.pdfPoint(pageDiv, e);
    const ghost = document.createElement("div");
    ghost.className = "redact-mark drawing";
    pageDiv.append(ghost);
    const rectTo = (end) => [Math.min(start[0], end[0]), Math.min(start[1], end[1]),
      Math.max(start[0], end[0]), Math.max(start[1], end[1])];

    const move = (ev) => viewer.placeOnPage(ghost, pageNumber, rectTo(viewer.pdfPoint(pageDiv, ev)));
    const up = (ev) => {
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerup", up);
      container.removeEventListener("pointercancel", up);
      ghost.remove();
      const rect = rectTo(viewer.pdfPoint(pageDiv, ev));
      const minPdf = MIN_DRAG_PX / viewer.scale; // PDF points per screen pixel at this zoom
      if (ev.type === "pointercancel" || rect[2] - rect[0] < minPdf || rect[3] - rect[1] < minPdf) return;
      setMarks([...marks, { page: pageNumber - 1, rect }], [pageNumber]);
    };
    container.setPointerCapture(e.pointerId);
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerup", up);
    container.addEventListener("pointercancel", up);
  }, { capture: true });

  // pdf.js clears unknown children of a page when it re-renders it
  viewer.eventBus.on("pagerendered", ({ pageNumber }) => { if (marks.length) draw(pageNumber); });

  return {
    get active() { return active; },
    get marks() { return marks; },
    start() {
      active = true;
      container.classList.add("redacting");
      onChange();
    },
    /** Leave redact mode, discarding marks that weren't applied. */
    stop() {
      if (!active && !marks.length) return;
      const pages = new Set(marks.map((m) => m.page + 1));
      active = false;
      container.classList.remove("redacting");
      setMarks([], pages);
    },
  };
}

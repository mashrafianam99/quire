// Edit-text mode: click a line of real PDF text, change it in a box drawn over the line,
// Enter (or clicking elsewhere) applies it, Esc cancels. The PDF work happens in
// textedit-pdf.js, reached through the `find` and `commit` callbacks.

const FAMILY = { serif: "Times New Roman, serif", mono: "Courier New, monospace", sans: "Arial, Helvetica, sans-serif" };
// "Lexend-Bold" -> "Lexend": used first, so the box matches when that font is installed
const familyName = (name) => name.replace(/[-,].*$/, "").replace(/(MT|PS)$/, "").replace(/"/g, "");

const cssColor = (c) => {
  if (c.length === 1) return `rgb(${c[0] * 255} ${c[0] * 255} ${c[0] * 255})`;
  if (c.length === 4) { // naive CMYK preview; the PDF keeps the real CMYK value
    const [C, M, Y, K] = c;
    return `rgb(${255 * (1 - C) * (1 - K)} ${255 * (1 - M) * (1 - K)} ${255 * (1 - Y) * (1 - K)})`;
  }
  return `rgb(${c[0] * 255} ${c[1] * 255} ${c[2] * 255})`;
};

/**
 * @param {ReturnType<import("./viewer.js").createViewer>} viewer
 * @param {HTMLElement} container the scrolling viewer element
 * @param {{find: (pageIndex: number, point: number[]) => Promise<object|null>,
 *          commit: (line: object, text: string) => Promise<void>,
 *          onChange: () => void}} hooks
 */
export function createTextEditor(viewer, container, { find, commit, onChange }) {
  let active = false;
  let editing = null; // {line, pageNumber, box}

  function place() {
    const { line, pageNumber, box } = editing;
    const view = viewer.pageView(pageNumber);
    if (!view?.div) return;
    if (box.parentElement !== view.div) view.div.append(box);
    viewer.placeOnPage(box, pageNumber, line.rect);
    // field-sizing grows the box with the text; the original line's width is the minimum
    box.style.minWidth = box.style.width;
    box.style.width = "";
    const k = view.viewport.scale; // CSS px per PDF point
    box.style.fontSize = `${line.size * k}px`;
  }

  function close() {
    const box = editing?.box;
    editing = null; // first, so the box's blur handler sees nothing to apply
    box?.remove();
  }

  async function finish(apply) {
    if (!editing) return;
    const { line, box } = editing;
    close();
    if (apply && box.value !== line.text) await commit(line, box.value);
  }

  function open(line, pageNumber) {
    const box = document.createElement("input");
    box.className = "text-edit-box";
    box.value = line.text;
    box.spellcheck = false;
    box.setAttribute("aria-label", "Edit this line of text");
    Object.assign(box.style, {
      fontFamily: `"${familyName(line.font.name)}", ${FAMILY[line.font.family]}`,
      fontWeight: line.font.bold ? "700" : "400",
      fontStyle: line.font.italic ? "italic" : "normal",
      color: cssColor(line.color),
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    // Clicking elsewhere applies; but pdf.js detaching the box mid-zoom must not.
    box.addEventListener("blur", () => setTimeout(() => {
      if (box.isConnected && document.activeElement !== box && editing?.box === box) finish(true);
    }, 0));
    editing = { line, pageNumber, box };
    place();
    box.focus();
    box.setSelectionRange(line.caret, line.caret);
  }

  container.addEventListener("pointerdown", async (e) => {
    if (!active || e.button !== 0 || e.target.closest?.(".text-edit-box")) return;
    const pageDiv = e.target.closest?.(".page");
    if (!pageDiv) return;
    e.preventDefault(); // no text selection while picking a line
    e.stopPropagation();
    const pageNumber = Number(pageDiv.dataset.pageNumber);
    const point = viewer.pdfPoint(pageDiv, e);
    await finish(true); // clicking another line applies the open edit first
    const line = await find(pageNumber - 1, point);
    if (line && active) open(line, pageNumber);
  }, { capture: true });

  // pdf.js removes unknown children of a page when it re-renders it (e.g. on zoom)
  viewer.eventBus.on("pagerendered", ({ pageNumber }) => {
    if (editing?.pageNumber === pageNumber) { place(); editing.box.focus(); }
  });

  return {
    get active() { return active; },
    start() {
      active = true;
      container.classList.add("text-editing");
      onChange();
    },
    /** Leave the mode; an open edit is discarded. */
    stop() {
      if (!active) return;
      active = false;
      close();
      container.classList.remove("text-editing");
      onChange();
    },
  };
}

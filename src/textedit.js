// Edit-text mode: click any line of real PDF text and its whole paragraph opens in a box
// drawn over it, as wide as its column. Enter (or clicking elsewhere) applies, Shift+Enter
// adds a line break, Esc cancels. The PDF work happens in textedit-pdf.js, reached through
// the `find` and `commit` callbacks.

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
 *          commit: (para: object, text: string, opts: {force: boolean}) => Promise<{overflowLines?: number}|undefined>,
 *          onChange: () => void}} hooks
 */
export function createTextEditor(viewer, container, { find, commit, onChange }) {
  let active = false;
  let editing = null; // {para, pageNumber, box}

  function place() {
    const { para, pageNumber, box } = editing;
    const view = viewer.pageView(pageNumber);
    if (!view?.div) return;
    if (box.parentElement !== view.div) view.div.append(box);
    viewer.placeOnPage(box, pageNumber, para.rect);
    // the column's width stays fixed; the height grows with the text (field-sizing)
    box.style.minHeight = box.style.height;
    box.style.height = "";
    box.style.fontSize = `${para.size * view.viewport.scale}px`; // viewport.scale = CSS px per PDF point
    box.style.lineHeight = String(para.layout.leading / para.size);
  }

  function close() {
    const box = editing?.box;
    editing = null; // first, so the box's blur handler sees nothing to apply
    box?.remove();
  }

  async function finish(apply) {
    if (!editing) return;
    const { para, pageNumber, box } = editing;
    const text = box.value;
    close();
    if (!apply || text === para.text) return;
    // A second apply of the same too-long text means "place it anyway".
    const result = await commit(para, text, { force: para.refusedText === text });
    if (result?.overflowLines && active && !editing) {
      open({ ...para, refusedText: text }, pageNumber, text);
    }
  }

  function open(para, pageNumber, text = para.text) {
    const box = document.createElement("textarea");
    box.className = "text-edit-box";
    box.value = text;
    box.spellcheck = false;
    box.setAttribute("aria-label", "Edit this paragraph. Enter applies, Shift+Enter adds a line break, Escape cancels.");
    Object.assign(box.style, {
      fontFamily: `"${familyName(para.font.name)}", ${FAMILY[para.font.family]}`,
      fontWeight: para.font.bold ? "700" : "400",
      fontStyle: para.font.italic ? "italic" : "normal",
      color: cssColor(para.color),
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    // Clicking elsewhere applies; but pdf.js detaching the box mid-zoom must not.
    box.addEventListener("blur", () => setTimeout(() => {
      if (box.isConnected && document.activeElement !== box && editing?.box === box) finish(true);
    }, 0));
    editing = { para, pageNumber, box };
    place();
    box.focus();
    const caret = text === para.text ? para.caret : text.length;
    box.setSelectionRange(caret, caret);
  }

  container.addEventListener("pointerdown", async (e) => {
    if (!active || e.button !== 0 || e.target.closest?.(".text-edit-box")) return;
    const pageDiv = e.target.closest?.(".page");
    if (!pageDiv) return;
    e.preventDefault(); // no text selection while picking a paragraph
    e.stopPropagation();
    const pageNumber = Number(pageDiv.dataset.pageNumber);
    const point = viewer.pdfPoint(pageDiv, e);
    await finish(true); // clicking another paragraph applies the open edit first
    if (editing) return; // that edit didn't fit and was reopened; settle it first
    const para = await find(pageNumber - 1, point);
    if (para && active) open(para, pageNumber);
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

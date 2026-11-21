// Edit-text mode: click any line of real PDF text and its whole paragraph opens in a box
// drawn over it, as wide as its column, showing its bold, italic and underlined words, with a style
// bar above it (B, I, U, colour). Enter (or clicking
// elsewhere) applies, Shift+Enter adds a line break, Ctrl+B / Ctrl+I / Ctrl+U toggle bold / italic / underline,
// Esc cancels. The PDF work happens in textedit-pdf.js, reached through the `find` and
// `commit` callbacks; the box hands back runs [{text, style, bold, italic, underline, color?}].

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

const fontCss = (font) => `"${familyName(font.name)}", ${FAMILY[font.family]}`;
const rgbOf = (css) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Math.round(Number(v)));
const toCss = (c) => `rgb(${c.map((v) => v * 255).join(" ")})`;

/** Fill the box with one span per run; a span's data-style says which PDF style it came from. */
function fill(box, para, runs) {
  box.replaceChildren(...runs.map(({ text, style, bold, italic, underline, color }) => {
    const s = para.styles[style] ?? para.styles[0];
    const span = document.createElement("span");
    span.dataset.style = String(style);
    span.textContent = text;
    Object.assign(span.style, {
      fontFamily: fontCss(s.font),
      fontWeight: (bold ?? s.font.bold) ? "700" : "400",
      fontStyle: (italic ?? s.font.italic) ? "italic" : "normal",
      fontSize: `${s.size / para.size}em`,
      color: color ? toCss(color) : cssColor(s.color),
      textDecorationLine: underline ? "underline" : "none",
    });
    return span;
  }));
}

/** Whether `el` is drawn underlined: text-decoration isn't inherited, so look up to the box. */
function underlined(el, box) {
  for (let at = el; at && at !== box.parentElement; at = at.parentElement) {
    if (getComputedStyle(at).textDecorationLine.includes("underline")) return true;
  }
  return false;
}

/**
 * Read the box back as runs. Text keeps the PDF style of the span it sits in (typing inherits
 * it); bold/italic/underline/colour come from what the user sees, so Ctrl+B / Ctrl+I / Ctrl+U and
 * the toolbar's markup of any shape works. A colour is only sent when it differs from the style's
 * own, so a CMYK or grey style keeps its exact colour.
 */
function readRuns(box, para) {
  const runs = [];
  const add = (text, el) => {
    const css = getComputedStyle(el);
    const style = Number(el.closest("[data-style]")?.dataset.style ?? 0);
    const seen = rgbOf(css.color);
    const own = rgbOf(cssColor((para.styles[style] ?? para.styles[0]).color));
    const run = {
      text, style,
      bold: Number(css.fontWeight) >= 600,
      italic: css.fontStyle !== "normal",
      underline: underlined(el, box),
      color: seen.join() === own.join() ? undefined : seen.map((v) => v / 255),
    };
    const last = runs.at(-1);
    const same = (a, b) => a.style === b.style && a.bold === b.bold && a.italic === b.italic
      && a.underline === b.underline && a.color?.join() === b.color?.join();
    if (last && same(last, run)) last.text += text;
    else runs.push(run);
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) add(child.data, node);
      else if (child.nodeName === "BR") add("\n", node);
      else {
        // a block the browser made for a new line starts on its own line
        if (/^(DIV|P)$/.test(child.nodeName) && child.previousSibling) add("\n", node);
        walk(child);
      }
    }
  };
  walk(box);
  return runs;
}

/** Put the caret `offset` characters into the box. */
function placeCaret(box, offset) {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(), left = offset; node; node = walker.nextNode()) {
    if (left <= node.length) {
      getSelection().collapse(node, left);
      return;
    }
    left -= node.length;
  }
  getSelection().collapse(box, box.childNodes.length);
}

/**
 * The bar above the box: bold, italic, underline and a text colour. Its buttons never take the
 * focus, so the box keeps its selection; the colour input does, so the selection is saved first.
 */
function makeToolbar(box, startColor) {
  const bar = document.createElement("div");
  bar.className = "text-edit-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Text style");
  const button = (label, title, command, css) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title });
    b.setAttribute("aria-label", title);
    Object.assign(b.style, css);
    b.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the focus in the box
    b.addEventListener("click", () => { document.execCommand(command); box.focus(); });
    return b;
  };
  const color = Object.assign(document.createElement("input"), { type: "color", title: "Text colour",
    value: `#${rgbOf(startColor).map((v) => v.toString(16).padStart(2, "0")).join("")}` });
  color.setAttribute("aria-label", "Text colour");
  let saved = null;
  color.addEventListener("pointerdown", () => {
    const sel = getSelection();
    saved = sel.rangeCount && box.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  });
  color.addEventListener("change", () => {
    box.focus();
    if (saved) getSelection().removeAllRanges(), getSelection().addRange(saved);
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("foreColor", false, color.value);
  });
  bar.append(
    button("B", "Bold (Ctrl+B)", "bold", { fontWeight: "700" }),
    button("I", "Italic (Ctrl+I)", "italic", { fontStyle: "italic" }),
    button("U", "Underline (Ctrl+U)", "underline", { textDecoration: "underline" }),
    color,
  );
  return bar;
}

/**
 * @param {ReturnType<import("./viewer.js").createViewer>} viewer
 * @param {HTMLElement} container the scrolling viewer element
 * @param {{find: (pageIndex: number, point: number[]) => Promise<object|null>,
 *          commit: (para: object, runs: object[], opts: {force: boolean}) => Promise<{overflowLines?: number}|undefined>,
 *          onChange: () => void}} hooks
 */
export function createTextEditor(viewer, container, { find, commit, onChange }) {
  let active = false;
  let editing = null; // {para, pageNumber, box, original: the runs as opened, to spot "no change"}

  function place() {
    const { para, pageNumber, box, bar } = editing;
    const view = viewer.pageView(pageNumber);
    if (!view?.div) return;
    if (box.parentElement !== view.div) view.div.append(box, bar);
    viewer.placeOnPage(box, pageNumber, para.rect);
    Object.assign(bar.style, { left: box.style.left, top: box.style.top });
    // the column's width stays fixed; the height grows with the text (field-sizing)
    box.style.minHeight = box.style.height;
    box.style.height = "";
    box.style.fontSize = `${para.size * view.viewport.scale}px`; // viewport.scale = CSS px per PDF point
    box.style.lineHeight = String(para.layout.leading / para.size);
  }

  function close() {
    const { box, bar } = editing ?? {};
    editing = null; // first, so the box's blur handler sees nothing to apply
    box?.remove();
    bar?.remove();
  }

  async function finish(apply) {
    if (!editing) return;
    const { para, pageNumber, box, original } = editing;
    const runs = readRuns(box, para);
    const key = JSON.stringify(runs);
    close();
    if (!apply || key === original) return;
    // A second apply of the same too-long text means "place it anyway".
    const result = await commit(para, runs, { force: para.refusedKey === key });
    if (result?.overflowLines && active && !editing) {
      open({ ...para, refusedKey: key }, pageNumber, runs);
    }
  }

  function open(para, pageNumber, runs = para.runs) {
    const box = document.createElement("div");
    box.className = "text-edit-box";
    box.contentEditable = "true";
    box.spellcheck = false;
    box.setAttribute("role", "textbox");
    box.setAttribute("aria-multiline", "true");
    box.setAttribute("aria-label", "Edit this paragraph. Enter applies, Shift+Enter adds a line break, "
      + "Control+B, Control+I and Control+U toggle bold, italic and underline, Escape cancels.");
    Object.assign(box.style, { fontFamily: fontCss(para.font), color: cssColor(para.color) });
    fill(box, para, para.runs);
    const bar = makeToolbar(box, cssColor(para.color));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
      else if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertText", false, "\n"); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      // Chrome's Ctrl+U is "view source", not underline, so do it here
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") { e.preventDefault(); document.execCommand("underline"); }
    });
    // only plain text comes in; its style is the one around the caret
    box.addEventListener("paste", (e) => {
      e.preventDefault();
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    });
    box.addEventListener("drop", (e) => e.preventDefault());
    // Clicking elsewhere applies; but pdf.js detaching the box mid-zoom, or picking a colour, must not.
    const away = () => setTimeout(() => {
      const at = document.activeElement;
      if (box.isConnected && at !== box && !bar.contains(at) && editing?.box === box) finish(true);
    }, 0);
    box.addEventListener("blur", away);
    bar.addEventListener("focusout", away);
    editing = { para, pageNumber, box, bar, original: null };
    place();
    // read back once as opened from the PDF (computed styles need the box on the page)
    editing.original = JSON.stringify(readRuns(box, para));
    if (runs !== para.runs) fill(box, para, runs); // reopened with text that didn't fit
    box.focus();
    placeCaret(box, runs === para.runs ? para.caret : Infinity);
  }

  container.addEventListener("pointerdown", async (e) => {
    if (!active || e.button !== 0 || e.target.closest?.(".text-edit-box, .text-edit-bar")) return;
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

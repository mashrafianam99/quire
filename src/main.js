import "./styles.css";
import { createViewer, Tool, Param, HIGHLIGHT_COLORS, CancelledError } from "./viewer.js";
import { renderThumbs } from "./thumbs.js";
import { askForSignature } from "./signature.js";
import { printPdf } from "./print.js";
import { createRedactor } from "./redact.js";
import { createTextEditor } from "./textedit.js";
import { createDefiner } from "./define.js";
import {
  applyPageOrder, deletePages, rotatePages, extractPages, mergePdfs,
} from "./pageops.js";

const $ = (sel) => document.querySelector(sel);
const app = $("#app");
const tabStrip = $("#tabs");
const thumbList = $("#thumbs");
const searchInput = $("#search");
const searchCount = $("#search-count");
const pageInput = $("#page-num");
const pageTotal = $("#page-total");
const zoomLabel = $("#zoom-label");

/** @type {{id:number, name:string, bytes:Uint8Array, dirty:boolean, undoStack?:Uint8Array[], redoStack?:Uint8Array[]}[]} */
const tabs = [];
let active = null; // the tab whose document the viewer shows
let nextId = 1;
let thumbs = null;

const viewer = createViewer($("#viewer"), { askPassword });

// ---------- feedback ----------
let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function askPassword(wasWrong) {
  const dialog = $("#password-dialog");
  const input = dialog.querySelector("input");
  dialog.querySelector(".dialog-error").hidden = !wasWrong;
  input.value = "";
  dialog.returnValue = ""; // Escape keeps the previous value otherwise
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok" ? input.value : null);
    }, { once: true });
  });
}

// ---------- one-at-a-time queue ----------
// Every action that reads or replaces the viewer's document (tab switches, page edits,
// save, close) runs here in order, so `active` and the viewer's document never disagree.
let queue = Promise.resolve();
let pending = 0;
function serial(task) {
  pending++;
  thumbList.inert = true; // page indices on screen may be stale until the queue drains
  queue = queue
    .then(task)
    .catch((err) => toast(err.message))
    .finally(() => { if (--pending === 0) thumbList.inert = false; });
  return queue;
}

// ---------- tabs ----------
function renderTabs() {
  tabStrip.replaceChildren(...tabs.map((tab) => {
    const el = document.createElement("div");
    el.className = "tab" + (tab === active ? " active" : "");
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(tab === active));
    el.innerHTML = `<button class="tab-name"></button>
      <button class="tab-close" aria-label="Close">×</button>`;
    el.querySelector(".tab-name").textContent = (tab.dirty ? "● " : "") + tab.name;
    el.querySelector(".tab-name").title = tab.name;
    el.querySelector(".tab-name").onclick = () => serial(() => activateNow(tab));
    el.querySelector(".tab-close").onclick = () => serial(() => closeTabNow(tab));
    return el;
  }));
  app.classList.toggle("empty", tabs.length === 0);
}

/** Keep annotations/form input when leaving a tab. */
async function stashActive() {
  if (!active || !viewer.hasEdits()) return;
  if (viewer.isModified()) active.dirty = true; // read first: saving resets pdf.js's flag
  active.bytes = await viewer.currentBytes(active.bytes);
}

async function activateNow(tab, { keepView = false } = {}) {
  redactor.stop(); // marks and open edits belong to the document being replaced
  textEditor.stop();
  if (active && active !== tab) await stashActive();
  active = tab;
  renderTabs();
  thumbs?.destroy();
  thumbs = null;
  try {
    const doc = await viewer.open(tab.bytes, { keepView });
    thumbs = renderThumbs(thumbList, doc, pageHandlers);
    pageTotal.textContent = `/ ${doc.numPages}`;
    pageInput.max = doc.numPages;
    pageInput.value = 1;
    if (searchInput.value) viewer.find(searchInput.value);
  } catch (err) {
    if (!(err instanceof CancelledError)) toast(`Couldn't open “${tab.name}”: ${err.message}`);
    await removeTabNow(tab);
  }
}

async function addTabNow(name, bytes, { dirty = false } = {}) {
  const tab = { id: nextId++, name, bytes, dirty };
  tabs.push(tab);
  await activateNow(tab);
}

async function removeTabNow(tab) {
  const i = tabs.indexOf(tab);
  if (i !== -1) tabs.splice(i, 1);
  if (active === tab) {
    active = null;
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) await activateNow(next);
    else { thumbs?.destroy(); thumbs = null; await viewer.close(); }
  }
  renderTabs();
}

async function closeTabNow(tab) {
  const unsaved = tab.dirty || (tab === active && viewer.isModified());
  if (unsaved && !confirm(`Close “${tab.name}” without saving?`)) return;
  await removeTabNow(tab);
}

// ---------- files ----------
const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isWord = (f) => /\.docx$/i.test(f.name)
  || f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const PICTURE = /\.(jpe?g|png|webp|gif|bmp|heic|heif|svg)$/i;
const isImage = (f) => /^image\/(jpeg|png|webp|gif|bmp|heic|heif|svg\+xml)$/.test(f.type) || PICTURE.test(f.name);

/** All pictures picked together, as one PDF with a page each, named after the first. */
async function picturesToPdf(pictures) {
  const { imagesToPdf, pictureFromFile } = await import("./image-to-pdf.js");
  const bytes = await imagesToPdf(await Promise.all(pictures.map(pictureFromFile)));
  return { name: pictures[0].name.replace(/\.[^.]+$/, ".pdf"), bytes, converted: true };
}

/** PDFs as they are; Word files and pictures converted to PDF (marked `converted`, as they aren't saved yet). */
async function readFiles(fileList) {
  const all = [...fileList];
  const usable = all.filter((f) => isPdf(f) || isWord(f));
  const pictures = all.filter(isImage);
  if (usable.length + pictures.length < all.length) toast("Only PDF, Word (.docx) and picture files can be opened.");
  const read = await Promise.allSettled([...usable.map(async (f) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isPdf(f)) return { name: f.name, bytes };
    const { docxToPdf } = await import("./convert.js"); // MuPDF is large; load only when used
    return { name: f.name.replace(/\.docx$/i, ".pdf"), bytes: await docxToPdf(bytes), converted: true };
  }), ...(pictures.length ? [picturesToPdf(pictures)] : [])]);
  for (const r of read) if (r.status === "rejected") toast(r.reason.message);
  return read.filter((r) => r.status === "fulfilled").map((r) => r.value);
}

async function openFiles(fileList) {
  for (const { name, bytes, converted } of await readFiles(fileList)) {
    serial(() => addTabNow(name, bytes, { dirty: !!converted }));
  }
}

const saveActive = () => serial(async () => {
  if (!active) return;
  const bytes = await viewer.currentBytes(active.bytes);
  if (!(await saveBytes(bytes, active.name))) return;
  active.bytes = bytes;
  active.dirty = false;
  viewer.markSaved();
  renderTabs();
  toast("Saved.");
});

const PDF_FILE = { description: "PDF document", type: "application/pdf", extension: ".pdf" };
const WORD_FILE = { description: "Word document", extension: ".docx",
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

// shortcut: browser save = download or Chromium's file picker; the Tauri shell will write files directly.
async function saveBytes(bytes, name, file = PDF_FILE) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: file.description, accept: { [file.type]: [file.extension] } }],
      });
      const out = await handle.createWritable();
      await out.write(bytes);
      await out.close();
      return true;
    } catch (err) {
      if (err.name === "AbortError") return false;
      throw new Error(`Save failed: ${err.message}`);
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: file.type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

// ---------- document history (undo/redo for changes that rewrite the file) ----------
const HISTORY_LIMIT = 20; // whole-file snapshots, so keep memory bounded on big PDFs

/** Give a tab new document bytes, remembering `before` so Undo can bring it back. */
function changeBytes(tab, before, after) {
  tab.undoStack = [...(tab.undoStack ?? []), before].slice(-HISTORY_LIMIT);
  tab.redoStack = [];
  tab.bytes = after;
  tab.dirty = true;
}

/** Undo (back) or redo: pdf.js's own annotation steps first, then whole-document changes. */
const stepHistory = (back) => serial(async () => {
  if (!active) return;
  const tab = active;
  const [from, to] = back ? ["undoStack", "redoStack"] : ["redoStack", "undoStack"];
  if ((back ? viewer.canUndo() : viewer.canRedo()) || !tab[from]?.length) {
    if (back) viewer.undo(); else viewer.redo();
    return;
  }
  const wasEditingText = textEditor.active;
  tab[to] = [...(tab[to] ?? []), await viewer.currentBytes(tab.bytes)];
  tab.bytes = tab[from].at(-1);
  tab[from] = tab[from].slice(0, -1);
  tab.dirty = true;
  await activateNow(tab, { keepView: true });
  if (wasEditingText) textEditor.start(); // reopening ended the mode
});

// ---------- page operations ----------
const editPages = (op) => serial(async () => {
  if (!active) return;
  const tab = active;
  const bytes = await viewer.currentBytes(tab.bytes);
  changeBytes(tab, bytes, await op(bytes));
  await activateNow(tab, { keepView: true });
});

const baseName = (name) => name.replace(/\.pdf$/i, "");

const pageHandlers = {
  onSelect: (i) => viewer.goToPage(i + 1),
  onRotate: (i) => editPages((b) => rotatePages(b, [i], 90)),
  onDelete: (i) => editPages((b) => deletePages(b, [i])),
  onMove: (from, to) => editPages((b) => {
    const order = [...Array(viewer.pageCount).keys()];
    order.splice(to, 0, order.splice(from, 1)[0]);
    return applyPageOrder(b, order);
  }),
  onExtract: (i) => serial(async () => {
    if (!active) return;
    const bytes = await extractPages(await viewer.currentBytes(active.bytes), [i]);
    await addTabNow(`${baseName(active.name)} – page ${i + 1}.pdf`, bytes, { dirty: true });
  }),
};

async function combineWith(fileList) {
  const files = await readFiles(fileList);
  if (!files.length) return;
  if (!tabs.length) return openFiles(fileList);
  await editPages((b) => mergePdfs([b, ...files.map((f) => f.bytes)]));
}

// ---------- tools, search, zoom, paging ----------
function setTool(mode) {
  redactor.stop();
  textEditor.stop();
  viewer.setTool(mode);
  markTool(mode);
}
let currentTool = Tool.SELECT;
function markTool(mode) {
  currentTool = mode;
  for (const b of document.querySelectorAll("[data-tool]")) {
    b.setAttribute("aria-pressed", String(Tool[b.dataset.tool] === mode));
  }
  renderStyleBar(Object.keys(Tool).find((name) => Tool[name] === mode));
  syncSelectButton();
}

// ---------- pen / text / highlight style ----------
const PEN_COLORS = ["#000000", "#1d4ed8", "#dc2626", "#15803d", "#ea580c", "#7c3aed"];
let toolStyles = {
  DRAW: { colors: PEN_COLORS, color: "#000000", colorParam: Param.INK_COLOR,
    sizeParam: Param.INK_THICKNESS, min: 1, max: 20, size: 3 },
  TEXT: { colors: PEN_COLORS, color: "#000000", colorParam: Param.FREETEXT_COLOR,
    sizeParam: Param.FREETEXT_SIZE, min: 8, max: 72, size: 14 },
  HIGHLIGHT: { colors: Object.values(HIGHLIGHT_COLORS), color: HIGHLIGHT_COLORS.yellow,
    colorParam: Param.HIGHLIGHT_COLOR },
};
for (const s of Object.values(toolStyles)) {
  viewer.setStyle(s.colorParam, s.color);
  if (s.sizeParam) viewer.setStyle(s.sizeParam, s.size);
}

const styleBar = $("#style-bar");
const sizeInput = $("#style-size");
let styledTool = null;

function updateStyle(name, change) {
  toolStyles = { ...toolStyles, [name]: { ...toolStyles[name], ...change } };
  const s = toolStyles[name];
  if ("color" in change) viewer.setStyle(s.colorParam, s.color);
  if ("size" in change) viewer.setStyle(s.sizeParam, s.size);
  renderStyleBar(name);
}

function renderStyleBar(name) {
  styledTool = name;
  const s = toolStyles[name];
  styleBar.hidden = !s;
  if (!s) return;
  styleBar.querySelector(".swatches").replaceChildren(...s.colors.map((color) => {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = color;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(color === s.color));
    b.setAttribute("aria-label", `Color ${color}`);
    b.onclick = () => updateStyle(name, { color });
    return b;
  }));
  sizeInput.parentElement.hidden = !s.sizeParam;
  if (s.sizeParam) Object.assign(sizeInput, { min: s.min, max: s.max, value: s.size });
}
sizeInput.oninput = () => {
  if (toolStyles[styledTool]?.sizeParam) updateStyle(styledTool, { size: Number(sizeInput.value) });
};

// ---------- sign & print ----------
async function signDocument() {
  if (!active) return;
  const file = await askForSignature();
  if (file) serial(() => viewer.addImage(file));
}

const recognizeText = () => serial(async () => {
  if (!active) return;
  const tab = active;
  const { ocrPdf } = await import("./ocr.js"); // large; load only when used
  const bytes = await viewer.currentBytes(tab.bytes);
  const result = await ocrPdf(bytes, (n, total) => toast(`Recognizing text… page ${n} of ${total}`));
  if (!result.bytes) { toast("This PDF already has selectable text on every page."); return; }
  changeBytes(tab, bytes, result.bytes);
  await activateNow(tab, { keepView: true });
  const plural = (n) => `${n} page${n === 1 ? "" : "s"}`;
  toast(`Text recognized on ${plural(result.recognized)}.`
    + (result.skipped ? ` ${plural(result.skipped)} already had text.` : ""));
});

const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const compressDocument = () => serial(async () => {
  if (!active) return;
  const tab = active;
  const { compressPdf } = await import("./compress-pdf.js"); // MuPDF is large; load only when used
  const bytes = await viewer.currentBytes(tab.bytes);
  const result = compressPdf(bytes);
  if (!result.bytes) { toast("This PDF is already as small as Quire can make it."); return; }
  changeBytes(tab, bytes, result.bytes);
  await activateNow(tab, { keepView: true });
  const saved = Math.round((1 - result.after / result.before) * 100);
  toast(`Compressed ${kb(result.before)} → ${kb(result.after)} (${saved}% smaller). Save to keep it.`);
});

const exportWord = () => serial(async () => {
  if (!active) return;
  const tab = active;
  toast("Converting to Word…");
  const { pdfToDocx } = await import("./pdf-to-docx.js"); // MuPDF and docx are large; load only when used
  const docx = await pdfToDocx(await viewer.currentBytes(tab.bytes));
  if (await saveBytes(docx, `${baseName(tab.name)}.docx`, WORD_FILE)) toast("Saved as a Word document.");
});

// ---------- redaction ----------
const redactBar = $("#redact-bar");
const redactor = createRedactor(viewer, $("#viewer"), () => {
  const n = redactor.marks.length;
  $("#redact").setAttribute("aria-pressed", String(redactor.active));
  redactBar.hidden = !redactor.active;
  $("#redact-hint").textContent = n
    ? `${n} area${n === 1 ? "" : "s"} marked · click one to unmark`
    : "Drag over anything you want removed";
  $("#redact-apply").disabled = !n;
  syncSelectButton();
});

function startRedacting() {
  if (!active) return;
  setTool(Tool.SELECT);
  redactor.start();
}

const applyRedaction = () => serial(async () => {
  const marks = redactor.marks;
  if (!active || !marks.length) return;
  const tab = active;
  toast("Removing marked content…");
  const { redactPdf } = await import("./redact-pdf.js"); // MuPDF is large; load only when used
  const before = await viewer.currentBytes(tab.bytes);
  changeBytes(tab, before, redactPdf(before, marks));
  await activateNow(tab, { keepView: true });
  toast(`Permanently removed ${marks.length} area${marks.length === 1 ? "" : "s"}. Save to keep the result.`);
});

// ---------- edit text ----------
const loadTextEdit = () => import("./textedit-pdf.js"); // MuPDF is large; load only when used
const textEditor = createTextEditor(viewer, $("#viewer"), {
  async find(pageIndex, point) {
    let found = null;
    await serial(async () => {
      if (!active) return;
      const tab = active;
      const bytes = await viewer.currentBytes(tab.bytes);
      const para = (await loadTextEdit()).findParagraph(bytes, pageIndex, point);
      if (!para) { toast("No text there. Click on a line of text."); return; }
      found = { ...para, tab, bytes }; // replace exactly what was read
    });
    return found;
  },
  commit: (para, text, { force }) => serial(async () => {
    if (para.tab !== active) return undefined; // the tab changed meanwhile; drop the edit
    const result = await (await loadTextEdit()).replaceParagraph(para.bytes, para, text, { allowOverflow: force });
    if (!result.bytes) {
      const n = result.overflowLines;
      toast(`This needs about ${n} more line${n === 1 ? "" : "s"} than there's room for, and it can't continue on a new page here (it's inside a box, or the page is turned). `
        + "Shorten it, or press Enter again to place it anyway (it will overlap the text below).");
      return { overflowLines: n };
    }
    changeBytes(para.tab, para.bytes, result.bytes);
    await activateNow(para.tab, { keepView: true });
    textEditor.start(); // reopening the document ended the mode; stay in it for the next paragraph
    const notes = [];
    if (result.newPage !== null) notes.push(`It didn't all fit, so the rest continues on a new page ${result.newPage + 1}.`);
    if (result.overflows) notes.push("The paragraph grew and may now overlap the text below it.");
    if (!result.usedOwnFont) notes.push("This document's font couldn't be reused, so a similar standard font was used.");
    else if (result.fallbackChars.length) {
      notes.push(`The document's font has no “${result.fallbackChars.join(" ")}”, so a similar font was used for ${result.fallbackChars.length === 1 ? "it" : "them"}.`);
    }
    if (notes.length) toast(notes.join(" "));
    return undefined;
  }),
  onChange: () => { $("#edit-text").setAttribute("aria-pressed", String(textEditor.active)); syncSelectButton(); },
});

// Double-click a word while reading (Select tool, no edit mode) to look it up offline.
createDefiner($("#viewer"), $(".workspace"), () => currentTool === Tool.SELECT && !redactor.active && !textEditor.active,
  () => { if (viewer.fitsWidth) viewer.fitWidth(); }); // the page re-fits when the panel narrows the view

// Redact and Edit text are modes of their own, so Select shouldn't look pressed during them.
function syncSelectButton() {
  if (redactor.active || textEditor.active) $('[data-tool="SELECT"]').setAttribute("aria-pressed", "false");
}

function startTextEditing() {
  if (!active) return;
  setTool(Tool.SELECT);
  textEditor.start();
  toast("Click any text to edit its paragraph. Enter applies, Shift+Enter adds a line break, "
    + "Ctrl+B / Ctrl+I / Ctrl+U or the bar above the box: bold, italic, underline, colour. Esc cancels.");
}

const printActive = () => serial(async () => {
  if (!active) return;
  toast("Preparing to print…");
  await printPdf(await viewer.currentBytes(active.bytes));
});

viewer.eventBus.on("pagechanging", ({ pageNumber }) => {
  pageInput.value = pageNumber;
  thumbs?.setActive(pageNumber);
});
// pdf.js can change mode itself (e.g. double-clicking an existing drawing); mirror it.
viewer.eventBus.on("annotationeditormodechanged", ({ mode }) => markTool(mode));
viewer.eventBus.on("scalechanging", ({ scale }) => {
  zoomLabel.textContent = `${Math.round(scale * 100)}%`;
});
const showMatches = ({ matchesCount }) => {
  if (!searchInput.value || !matchesCount) { searchCount.textContent = ""; return; }
  searchCount.textContent = matchesCount.total
    ? `${matchesCount.current} / ${matchesCount.total}` : "No matches";
};
viewer.eventBus.on("updatefindmatchescount", showMatches);
viewer.eventBus.on("updatefindcontrolstate", showMatches);

// ---------- wiring ----------
const openInput = $("#open-input");
const combineInput = $("#combine-input");
openInput.onchange = () => { openFiles(openInput.files); openInput.value = ""; };
combineInput.onchange = () => { combineWith(combineInput.files); combineInput.value = ""; };
for (const b of document.querySelectorAll("[data-open]")) b.onclick = () => openInput.click();
$("#combine").onclick = () => combineInput.click();
$("#save").onclick = saveActive;
$("#print").onclick = printActive;
$("#ocr").onclick = recognizeText;
$("#compress").onclick = compressDocument;
$("#to-word").onclick = exportWord;
$("#sign").onclick = signDocument;
$("#redact").onclick = () => (redactor.active ? redactor.stop() : startRedacting());
$("#edit-text").onclick = () => (textEditor.active ? textEditor.stop() : startTextEditing());
$("#redact-apply").onclick = applyRedaction;
$("#redact-cancel").onclick = () => redactor.stop();
const imageInput = $("#image-input");
$("#add-image").onclick = () => active && imageInput.click();
imageInput.onchange = () => {
  const [file] = imageInput.files;
  imageInput.value = "";
  if (file) serial(() => viewer.addImage(file));
};
$("#undo").onclick = () => stepHistory(true);
$("#redo").onclick = () => stepHistory(false);
$("#zoom-in").onclick = () => viewer.zoomIn();
$("#zoom-out").onclick = () => viewer.zoomOut();
$("#zoom-label").onclick = () => viewer.fitWidth();
for (const b of document.querySelectorAll("[data-tool]")) b.onclick = () => setTool(Tool[b.dataset.tool]);

pageInput.onchange = () => {
  const n = Number(pageInput.value);
  if (Number.isInteger(n) && n >= 1 && n <= viewer.pageCount) viewer.goToPage(n);
};
searchInput.oninput = () => viewer.find(searchInput.value);
searchInput.onkeydown = (e) => {
  if (e.key === "Enter") viewer.find(searchInput.value, { again: true, previous: e.shiftKey });
  if (e.key === "Escape") { searchInput.value = ""; viewer.find(""); searchInput.blur(); }
};

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.matches?.("input, textarea") || e.target.isContentEditable;
  const key = e.key.toLowerCase();
  if (mod && !typing && (key === "z" || key === "y")) {
    e.preventDefault();
    e.stopPropagation(); // ours alone: pdf.js's own Ctrl+Z on window would undo twice
    stepHistory(key === "z" && !e.shiftKey);
    return;
  }
  if (mod && e.key === "o") { e.preventDefault(); openInput.click(); }
  else if (mod && e.key === "s") { e.preventDefault(); saveActive(); }
  else if (mod && e.key === "p") { e.preventDefault(); printActive(); }
  else if (mod && e.key === "f") { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); viewer.zoomIn(); }
  else if (mod && e.key === "-") { e.preventDefault(); viewer.zoomOut(); }
  else if (e.key === "Escape" && document.activeElement === document.body) setTool(Tool.SELECT);
  // pdf.js editor shortcuts listen on window and would eat Backspace/arrows typed into our inputs.
  if (e.target.matches?.("input, textarea, .text-edit-box, .text-edit-bar *")) e.stopPropagation();
});

// Ctrl+wheel and touchpad pinch zoom the document, never the whole app.
const ZOOM_SPEED = 0.002; // ~20% per mouse-wheel notch (deltaY 100); pinch sends small deltas
document.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (active && e.target.closest?.("#viewer")) viewer.zoomBy(Math.exp(-e.deltaY * ZOOM_SPEED), [e.clientX, e.clientY]);
}, { passive: false });

// Drop PDFs anywhere: opens them as new tabs.
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); app.classList.add("dropping"); }
});
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) app.classList.remove("dropping"); });
window.addEventListener("drop", (e) => {
  app.classList.remove("dropping");
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  openFiles(e.dataTransfer.files);
});

window.addEventListener("beforeunload", (e) => {
  if (tabs.some((t) => t.dirty) || viewer.isModified()) e.preventDefault();
});

renderTabs();

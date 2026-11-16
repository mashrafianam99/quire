import "./styles.css";
import { createViewer, Tool, Param, HIGHLIGHT_COLORS, CancelledError } from "./viewer.js";
import { renderThumbs } from "./thumbs.js";
import { askForSignature } from "./signature.js";
import { printPdf } from "./print.js";
import { createRedactor } from "./redact.js";
import { createTextEditor } from "./textedit.js";
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

/** @type {{id:number, name:string, bytes:Uint8Array, dirty:boolean}[]} */
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
async function readFiles(fileList) {
  const pdfs = [...fileList].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (pdfs.length < fileList.length) toast("Only PDF files can be opened.");
  return Promise.all(pdfs.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

async function openFiles(fileList) {
  for (const { name, bytes } of await readFiles(fileList)) serial(() => addTabNow(name, bytes));
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

// shortcut: browser save = download or Chromium's file picker; the Tauri shell will write files directly.
async function saveBytes(bytes, name) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
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
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

// ---------- page operations ----------
const editPages = (op) => serial(async () => {
  if (!active) return;
  const tab = active;
  const bytes = await viewer.currentBytes(tab.bytes);
  tab.bytes = await op(bytes);
  tab.dirty = true;
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
function markTool(mode) {
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
  tab.bytes = result.bytes;
  tab.dirty = true;
  await activateNow(tab, { keepView: true });
  const plural = (n) => `${n} page${n === 1 ? "" : "s"}`;
  toast(`Text recognized on ${plural(result.recognized)}.`
    + (result.skipped ? ` ${plural(result.skipped)} already had text.` : ""));
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
  tab.bytes = redactPdf(await viewer.currentBytes(tab.bytes), marks);
  tab.dirty = true;
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
      toast(`This needs about ${n} more line${n === 1 ? "" : "s"} than there's room for on this page. `
        + "Shorten it, or press Enter again to place it anyway (it will overlap the text below).");
      return { overflowLines: n };
    }
    para.tab.bytes = result.bytes;
    para.tab.dirty = true;
    await activateNow(para.tab, { keepView: true });
    textEditor.start(); // reopening the document ended the mode; stay in it for the next paragraph
    const notes = [];
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

// Redact and Edit text are modes of their own, so Select shouldn't look pressed during them.
function syncSelectButton() {
  if (redactor.active || textEditor.active) $('[data-tool="SELECT"]').setAttribute("aria-pressed", "false");
}

function startTextEditing() {
  if (!active) return;
  setTool(Tool.SELECT);
  textEditor.start();
  toast("Click any text to edit its paragraph. Enter applies, Shift+Enter adds a line break, Esc cancels.");
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
$("#undo").onclick = () => viewer.undo();
$("#redo").onclick = () => viewer.redo();
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
  if (mod && e.key === "o") { e.preventDefault(); openInput.click(); }
  else if (mod && e.key === "s") { e.preventDefault(); saveActive(); }
  else if (mod && e.key === "p") { e.preventDefault(); printActive(); }
  else if (mod && e.key === "f") { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); viewer.zoomIn(); }
  else if (mod && e.key === "-") { e.preventDefault(); viewer.zoomOut(); }
  else if (e.key === "Escape" && document.activeElement === document.body) setTool(Tool.SELECT);
  // pdf.js editor shortcuts listen on window and would eat Backspace/arrows typed into our inputs.
  if (e.target.matches?.("input, textarea")) e.stopPropagation();
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

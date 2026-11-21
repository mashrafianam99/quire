// Compare two versions of a PDF, on the device. The words of the whole document are diffed (so
// text that only moved to another page isn't a change), each side's removed / added words are
// boxed where they are, pages are paired by the words they share, and changes that aren't text
// (a picture, a drawing, a colour) are found by comparing the pages' pixels away from any text.
// buildReport() turns the result into a PDF: a summary page, then the two versions side by side.
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ---------- the word diff ----------

const EXACT_LIMIT = 4_000_000; // compare exactly (a full LCS table) up to this many word pairs

/** Longest common subsequence of a[a0,a1) and b[b0,b1), exactly; appends the edit script. */
function exact(a, a0, a1, b, b0, b1, out) {
  const [n, m] = [a1 - a0, b1 - b0];
  const L = new Uint32Array((n + 1) * (m + 1)); // L[i][j] = LCS of a[i..], b[j..]
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[at(i, j)] = a[a0 + i] === b[b0 + j] ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
    }
  }
  let [i, j] = [0, 0];
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) out.push({ op: "=", a: a0 + i++, b: b0 + j++ });
    else if (L[at(i + 1, j)] >= L[at(i, j + 1)]) out.push({ op: "-", a: a0 + i++ });
    else out.push({ op: "+", b: b0 + j++ });
  }
  while (i < n) out.push({ op: "-", a: a0 + i++ });
  while (j < m) out.push({ op: "+", b: b0 + j++ });
}

/** Words that occur exactly once in each range, as [i, j] pairs in order on both sides (patience). */
function anchors(a, a0, a1, b, b0, b1) {
  const count = (arr, s, e) => {
    const c = new Map();
    for (let k = s; k < e; k++) c.set(arr[k], (c.get(arr[k]) ?? 0) + 1);
    return c;
  };
  const [ca, cb] = [count(a, a0, a1), count(b, b0, b1)];
  const where = new Map();
  for (let j = b0; j < b1; j++) if (cb.get(b[j]) === 1 && ca.get(b[j]) === 1) where.set(b[j], j);
  const pairs = [];
  for (let i = a0; i < a1; i++) if (where.has(a[i])) pairs.push([i, where.get(a[i])]);
  // the longest run of pairs increasing in j too (patience sorting)
  const tails = [], prev = new Array(pairs.length);
  pairs.forEach(([, j], k) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < j) lo = mid + 1; else hi = mid; }
    prev[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  });
  const run = [];
  for (let k = tails.at(-1) ?? -1; k !== -1; k = prev[k]) run.unshift(pairs[k]);
  return run;
}

function diffRange(a, a0, a1, b, b0, b1, out) {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push({ op: "=", a: a0++, b: b0++ });
  const tail = [];
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) tail.unshift({ op: "=", a: --a1, b: --b1 });
  if (a0 === a1 || b0 === b1 || (a1 - a0) * (b1 - b0) <= EXACT_LIMIT) exact(a, a0, a1, b, b0, b1, out);
  else {
    const fixed = anchors(a, a0, a1, b, b0, b1);
    if (!fixed.length) {
      // shortcut: a huge rewrite with no word shared once on each side counts as all removed, all added
      for (let i = a0; i < a1; i++) out.push({ op: "-", a: i });
      for (let j = b0; j < b1; j++) out.push({ op: "+", b: j });
    } else {
      let [pa, pb] = [a0, b0];
      for (const [i, j] of fixed) {
        diffRange(a, pa, i, b, pb, j, out);
        out.push({ op: "=", a: i, b: j });
        [pa, pb] = [i + 1, j + 1];
      }
      diffRange(a, pa, a1, b, pb, b1, out);
    }
  }
  out.push(...tail);
}

/**
 * The edit script turning word list `a` into `b`: [{op: "=", a, b} | {op: "-", a} | {op: "+", b}],
 * indices into the lists, in order.
 */
export function diffWords(a, b) {
  const out = [];
  diffRange(a, 0, a.length, b, 0, b.length, out);
  return out;
}

// ---------- words and pages ----------

const union = (r, q) => [Math.min(r[0], q[0]), Math.min(r[1], q[1]), Math.max(r[2], q[2]), Math.max(r[3], q[3])];

const SAME_ROW = 3; // pt: blocks or lines whose tops differ less than this are on one row (left to right)
const byPosition = (p, q) => (Math.abs(p.bbox[1] - q.bbox[1]) < SAME_ROW ? p.bbox[0] - q.bbox[0] : p.bbox[1] - q.bbox[1]);

/**
 * Every word of the document with its page and box (page space: y down from the top), in reading
 * order by position: text is handed over in the order it was drawn, and an edited paragraph is
 * drawn last, so drawing order would make it look moved.
 */
function readWords(doc) {
  const words = [], sizes = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    const [x0, y0, x1, y1] = page.getBounds();
    sizes.push([x1 - x0, y1 - y0, x0, y0]);
    const blocks = [];
    let block = null, line = null, word = null;
    const end = () => { if (word) line.words.push(word); word = null; };
    page.toStructuredText("preserve-ligatures").walk({
      beginTextBlock(bbox) { block = { bbox, lines: [] }; blocks.push(block); },
      beginLine(bbox) { line = { bbox, words: [] }; (block ?? (block = { bbox, lines: [] }, blocks.push(block), block)).lines.push(line); },
      onChar(c, origin, font, size, q) {
        if (!c.trim()) return end();
        const box = [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])];
        if (word) { word.text += c; word.rect = union(word.rect, box); } else word = { text: c, page: p, rect: box };
      },
      endLine: end,
      endTextBlock() { block = null; },
    });
    for (const b of blocks.sort(byPosition)) for (const l of b.lines.sort(byPosition)) words.push(...l.words);
  }
  // what's compared: ligatures as their letters ("ﬁ" = "fi"), so a font change isn't a text change
  return { words, keys: words.map((w) => w.text.normalize("NFKC")), sizes };
}

/** Boxes of neighbouring changed words on one line, joined into one. */
function joinBoxes(rects) {
  const out = [];
  for (const r of [...rects].sort((p, q) => p[1] - q[1] || p[0] - q[0])) {
    const last = out.at(-1);
    const h = last ? Math.min(last[3] - last[1], r[3] - r[1]) : 0;
    const sameLine = last && Math.min(last[3], r[3]) - Math.max(last[1], r[1]) > h / 2;
    if (sameLine && r[0] - last[2] < h * 1.5) out[out.length - 1] = union(last, r);
    else out.push(r);
  }
  return out;
}

/** Old and new pages side by side: each new page with the old page it shares most words with, in order. */
function pairPages(diff, A, B) {
  const shared = B.sizes.map(() => new Map());
  const usedOld = new Set();
  for (const d of diff) {
    if (d.op !== "=") continue;
    const [o, n] = [A.words[d.a].page, B.words[d.b].page];
    shared[n].set(o, (shared[n].get(o) ?? 0) + 1);
    usedOld.add(o);
  }
  const pairs = [];
  let last = -1;
  const oldAlone = (until) => { while (last + 1 < until) pairs.push([++last, null]); };
  shared.forEach((counts, n) => {
    let best = null;
    for (const [o, c] of counts) if (o > last && (best === null || c > counts.get(best))) best = o;
    // a page with no shared words (a picture page) pairs with the next old page no new page claims
    if (best === null && last + 1 < A.sizes.length && !usedOld.has(last + 1) && !counts.size
      && !B.words.some((w) => w.page === n)) best = last + 1;
    if (best === null) { pairs.push([null, n]); return; }
    oldAlone(best);
    pairs.push([best, n]);
    last = best;
  });
  oldAlone(A.sizes.length);
  return pairs;
}

// ---------- changes that aren't text ----------

const PIXEL_SCALE = 0.5; // pages are compared at 36 dpi...
const CELL = 6;          // ...in cells of 6 px (12 pt)
const CELL_CHANGE = 6;   // a cell changed if its pixels differ by this much on average (0–255)
const TEXT_MARGIN = 2;   // pt around every word that pixel changes are ignored in (text is diffed as words)

function grey(page) {
  const pix = page.toPixmap(mupdf.Matrix.scale(PIXEL_SCALE, PIXEL_SCALE), mupdf.ColorSpace.DeviceGray, false);
  try {
    return { w: pix.getWidth(), h: pix.getHeight(), px: Uint8Array.from(pix.getPixels()) };
  } finally {
    pix.destroy();
  }
}

/** Which cells of a cols × rows grid any of the boxes (page space) touch, with a margin. */
function cellsUnder(boxes, cols, rows, [x0, y0]) {
  const marked = new Uint8Array(cols * rows);
  const s = PIXEL_SCALE / CELL;
  for (const [l, t, r, b] of boxes) {
    const [c0, c1] = [Math.max(0, Math.floor((l - x0 - TEXT_MARGIN) * s)), Math.min(cols - 1, Math.floor((r - x0 + TEXT_MARGIN) * s))];
    const [r0, r1] = [Math.max(0, Math.floor((t - y0 - TEXT_MARGIN) * s)), Math.min(rows - 1, Math.floor((b - y0 + TEXT_MARGIN) * s))];
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) marked[y * cols + x] = 1;
  }
  return marked;
}

/** The marked cells, grouped with their neighbours into boxes (page space). */
function boxesOf(marked, cols, rows, [x0, y0]) {
  const boxes = [];
  const seen = new Uint8Array(marked.length);
  for (let k = 0; k < marked.length; k++) {
    if (!marked[k] || seen[k]) continue;
    let box = null;
    const stack = [k];
    seen[k] = 1;
    while (stack.length) {
      const c = stack.pop();
      const [cx, cy] = [c % cols, Math.floor(c / cols)];
      const cell = [cx, cy, cx + 1, cy + 1].map((v) => (v * CELL) / PIXEL_SCALE);
      box = box ? union(box, cell) : cell;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const [nx, ny] = [cx + dx, cy + dy];
        const nk = ny * cols + nx;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && marked[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
      }
    }
    boxes.push([box[0] + x0, box[1] + y0, box[2] + x0, box[3] + y0]);
  }
  return boxes;
}

/** Boxes (page space) where two same-sized pages look different away from any text. */
function visualChanges(pageA, pageB, textRects, [, , x0, y0]) {
  const [a, b] = [grey(pageA), grey(pageB)];
  if (a.w !== b.w || a.h !== b.h) return []; // shortcut: pages of different sizes aren't pixel-compared
  const [cols, rows] = [Math.ceil(a.w / CELL), Math.ceil(a.h / CELL)];
  const text = cellsUnder(textRects, cols, rows, [x0, y0]);
  const changed = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (text[cy * cols + cx]) continue;
      let sum = 0, n = 0;
      for (let y = cy * CELL; y < Math.min(a.h, (cy + 1) * CELL); y++) {
        for (let x = cx * CELL; x < Math.min(a.w, (cx + 1) * CELL); x++, n++) sum += Math.abs(a.px[y * a.w + x] - b.px[y * a.w + x]);
      }
      if (sum / n >= CELL_CHANGE) changed[cy * cols + cx] = 1;
    }
  }
  return boxesOf(changed, cols, rows, [x0, y0]);
}

// ---------- the comparison ----------

const open = (bytes) => mupdf.Document.openDocument(bytes, "application/pdf");

/** The diff's changed runs, each with its pages and text; the boxes of removed / added words per page. */
function changesOf(diff, A, B) {
  const removedOn = A.sizes.map(() => []), addedOn = B.sizes.map(() => []);
  const changes = [];
  let hunk = null;
  for (const d of diff) {
    if (d.op === "=") {
      // a run that only removes text is listed at the new page where the text after it is
      if (hunk) { hunk.newPage ??= B.words[d.b].page; changes.push(hunk); hunk = null; }
      continue;
    }
    hunk ??= { oldPage: null, newPage: null, removed: [], added: [] };
    const w = d.op === "-" ? A.words[d.a] : B.words[d.b];
    if (d.op === "-") { removedOn[w.page].push(w.rect); hunk.oldPage ??= w.page; hunk.removed.push(w.text); }
    else { addedOn[w.page].push(w.rect); hunk.newPage ??= w.page; hunk.added.push(w.text); }
  }
  if (hunk) { hunk.newPage ??= Math.max(0, B.sizes.length - 1); changes.push(hunk); } // removed at the very end
  return { removedOn, addedOn, changes: changes.map((c) => ({ ...c, removed: c.removed.join(" "), added: c.added.join(" ") })) };
}

/**
 * Compare two PDFs. Returns {removed, added (word counts), changes: [{oldPage, newPage, removed,
 * added (text)}], pairs: [{old: {index, size, removed: [box]}, new: {index, size, added: [box]},
 * visual: [box]}]}; pages are 0-based (index null: no page on that side), boxes are page space
 * [x0, y0, x1, y1], sizes [width, height, x0, y0].
 */
export async function compareDocuments(oldBytes, newBytes) {
  const [docA, docB] = [open(oldBytes), open(newBytes)];
  try {
    const [A, B] = [readWords(docA), readWords(docB)];
    const diff = diffWords(A.keys, B.keys);
    const { removedOn, addedOn, changes } = changesOf(diff, A, B);
    const textOn = (X, p) => X.words.filter((w) => w.page === p).map((w) => w.rect);
    const pairs = pairPages(diff, A, B).map(([o, n]) => ({
      old: { index: o, size: o === null ? null : A.sizes[o], removed: o === null ? [] : joinBoxes(removedOn[o]) },
      new: { index: n, size: n === null ? null : B.sizes[n], added: n === null ? [] : joinBoxes(addedOn[n]) },
      visual: o !== null && n !== null
        ? visualChanges(docA.loadPage(o), docB.loadPage(n), [...textOn(A, o), ...textOn(B, n)], B.sizes[n]) : [],
    }));
    return {
      removed: diff.filter((d) => d.op === "-").length,
      added: diff.filter((d) => d.op === "+").length,
      changes,
      pairs,
    };
  } finally {
    docA.destroy();
    docB.destroy();
  }
}

// ---------- the report ----------

const RED = rgb(0.86, 0.15, 0.15), GREEN = rgb(0.09, 0.6, 0.25), ORANGE = rgb(0.96, 0.55, 0.05);
const INK = rgb(0.11, 0.11, 0.1), MUTED = rgb(0.42, 0.4, 0.37);
const REPORT_DPI_SCALE = 1.5; // pages are pictured at 108 dpi
const MARGIN = 24, GUTTER = 24, LABEL = 22;
const SUMMARY = [595, 842]; // A4, unless the side-by-side pages are bigger (then it takes their size)
const TEXT_COLUMN = 560; // pt: the summary's text stays this narrow on a wide page, to be readable
const MAX_LISTED = 300; // changes listed on the summary pages
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Text Helvetica can draw (it's WinAnsi only); other letters become "?". */
const drawable = (font, s) => [...s].map((c) => { try { font.encodeText(c); return c; } catch { return "?"; } }).join("");

/** Words wrapped to `width` at `size`. */
function wrap(font, text, size, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function summaryPages(doc, font, bold, result, { oldName, newName }, pageSize = SUMMARY) {
  let page = doc.addPage(pageSize);
  let y = pageSize[1] - MARGIN * 2;
  const write = (text, { size = 10, f = font, color = INK, indent = 0, gap = 4 } = {}) => {
    for (const line of wrap(f, drawable(f, text), size, Math.min(TEXT_COLUMN, pageSize[0] - MARGIN * 2) - indent)) {
      if (y < MARGIN * 2) { page = doc.addPage(pageSize); y = pageSize[1] - MARGIN * 2; }
      page.drawText(line, { x: MARGIN + indent, y, size, font: f, color });
      y -= size * 1.3;
    }
    y -= gap;
  };
  const changedPages = result.pairs.filter((p) => p.old.removed.length || p.new.added.length || p.visual.length).length;
  write("Comparison", { size: 20, f: bold, gap: 10 });
  write(`Old: ${oldName}`, { size: 11 });
  write(`New: ${newName}`, { size: 11, gap: 10 });
  write(!changedPages ? "No differences found."
    : `${plural(result.removed, "word")} removed, ${plural(result.added, "word")} added; ${plural(changedPages, "page")} with changes.`,
  { size: 12, f: bold, gap: 6 });
  write("Removed text is boxed in red on the old pages, added text in green on the new pages, and other changes (pictures, drawings, colours) in orange on both.",
    { color: MUTED, gap: 12 });
  for (const c of result.changes.slice(0, MAX_LISTED)) {
    write(`New page ${c.newPage + 1}${c.oldPage !== null ? ` (old page ${c.oldPage + 1})` : ""}`, { size: 9, f: bold, color: MUTED, gap: 1 });
    if (c.removed) write(`Removed: “${c.removed}”`, { color: RED, indent: 8, gap: 1 });
    if (c.added) write(`Added: “${c.added}”`, { color: GREEN, indent: 8, gap: 1 });
    y -= 6;
  }
  if (result.changes.length > MAX_LISTED) write(`…and ${result.changes.length - MAX_LISTED} more changes, marked on the pages.`, { color: MUTED });
}

/** One page pictured as a JPEG, embedded in the report. */
async function picture(report, doc, index) {
  const pix = doc.loadPage(index).toPixmap(mupdf.Matrix.scale(REPORT_DPI_SCALE, REPORT_DPI_SCALE), mupdf.ColorSpace.DeviceRGB, false);
  try {
    return await report.embedJpg(Uint8Array.from(pix.asJPEG(80, false)));
  } finally {
    pix.destroy();
  }
}

/**
 * The page itself (vector, its text selectable), placed in the report; null when pdf-lib can't
 * place it as it looks (a turned page: pdf-lib doesn't apply /Rotate), so it's pictured instead.
 */
async function placed(report, source, index) {
  const page = source?.getPage(index);
  if (!page || page.getRotation().angle % 360 !== 0) return null;
  const { x, y, width, height } = page.getCropBox();
  try {
    return await report.embedPage(page, { left: x, bottom: y, right: x + width, top: y + height });
  } catch {
    return null; // shortcut: a page pdf-lib can't copy is pictured
  }
}

/** Draws one side of a pair: its label, its page (or a placeholder) and the boxes of its changes. */
async function drawSide(report, page, fonts, { doc, source, half, x, top, label, boxes, color, visual }) {
  const [font, bold] = fonts;
  const [w, h, ox, oy] = half.size;
  page.drawText(drawable(bold, label), { x, y: top + 8, size: 11, font: bold, color: INK });
  if (half.index === null) {
    page.drawRectangle({ x, y: top - h, width: w, height: h, borderColor: MUTED, borderWidth: 1, borderDashArray: [4, 4] });
    page.drawText("No matching page", { x: x + 16, y: top - 30, size: 12, font, color: MUTED });
    return;
  }
  const vector = await placed(report, source, half.index);
  page.drawRectangle({ x, y: top - h, width: w, height: h, color: rgb(1, 1, 1) }); // a page without a background is white
  if (vector) page.drawPage(vector, { x, y: top - h, width: w, height: h });
  else page.drawImage(await picture(report, doc, half.index), { x, y: top - h, width: w, height: h });
  page.drawRectangle({ x, y: top - h, width: w, height: h, borderColor: MUTED, borderWidth: 0.5 });
  const mark = (r, c) => page.drawRectangle({ x: x + r[0] - ox - 1, y: top - (r[3] - oy) - 1, width: r[2] - r[0] + 2,
    height: r[3] - r[1] + 2, color: c, opacity: 0.18, borderColor: c, borderWidth: 1, borderOpacity: 0.9 });
  for (const r of boxes) mark(r, color);
  for (const r of visual) mark(r, ORANGE);
}

/** The PDF as pdf-lib reads it, for copying its pages; null if it can't (then pages are pictured). */
const sourceOf = (bytes) => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).catch(() => null);

/**
 * The comparison as a PDF: summary page(s), then one page per pair with the old page on the left
 * and the new page on the right, changes boxed. Pages are copied as they are (vector, selectable
 * text); a turned page, or one pdf-lib can't copy, is pictured at 108 dpi instead.
 */
export async function buildReport(oldBytes, newBytes, result, names) {
  const report = await PDFDocument.create();
  const fonts = [await report.embedFont(StandardFonts.Helvetica), await report.embedFont(StandardFonts.HelveticaBold)];
  // the summary is as big as the side-by-side pages, so a viewer's "fit width" suits every page
  const sizeOf = (pair) => {
    const [a, b] = [pair.old.size ?? pair.new.size, pair.new.size ?? pair.old.size];
    return [MARGIN * 2 + a[0] + GUTTER + b[0], MARGIN * 2 + LABEL + Math.max(a[1], b[1])];
  };
  const widest = result.pairs.map(sizeOf).reduce((m, s) => (s[0] > m[0] ? s : m), SUMMARY);
  summaryPages(report, ...fonts, result, names, [Math.max(SUMMARY[0], widest[0]), Math.max(SUMMARY[1], widest[1])]);
  const [sourceA, sourceB] = await Promise.all([sourceOf(oldBytes), sourceOf(newBytes)]);
  const [docA, docB] = [open(oldBytes), open(newBytes)];
  try {
    for (const pair of result.pairs) {
      // a missing side takes the other side's size, for its placeholder
      const oldHalf = { ...pair.old, size: pair.old.size ?? pair.new.size };
      const newHalf = { ...pair.new, size: pair.new.size ?? pair.old.size };
      const [wa, ha] = oldHalf.size, [wb, hb] = newHalf.size;
      const height = Math.max(ha, hb);
      const page = report.addPage([MARGIN * 2 + wa + GUTTER + wb, MARGIN * 2 + LABEL + height]);
      const top = MARGIN + height; // y of the pages' top edge (pdf-lib's y is up)
      await drawSide(report, page, fonts, { doc: docA, source: sourceA, half: oldHalf, x: MARGIN, top, boxes: pair.old.removed, color: RED, visual: pair.visual,
        label: pair.old.index === null ? "Old: —" : `Old · page ${pair.old.index + 1} · ${names.oldName}` });
      await drawSide(report, page, fonts, { doc: docB, source: sourceB, half: newHalf, x: MARGIN + wa + GUTTER, top, boxes: pair.new.added, color: GREEN, visual: pair.visual,
        label: pair.new.index === null ? "New: —" : `New · page ${pair.new.index + 1} · ${names.newName}` });
    }
  } finally {
    docA.destroy();
    docB.destroy();
  }
  return report.save();
}

// Edit real PDF text a paragraph at a time.
// findParagraph: MuPDF reads the page's lines, groups the clicked line with its neighbours
//   into a paragraph and records its style and geometry.
// replaceParagraph: MuPDF removes only those letters (images and lines behind stay), then
//   pdf-lib re-wraps the new text into the paragraph's column, in the document's own embedded
//   font where it has the letters, and the closest standard font for the ones it lacks.
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts, rgb, cmyk, grayscale, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const { PDFPage, Matrix, Rect } = mupdf;
const REMOVE_INSET = 0.2;        // shrink each line's removal box so neighbouring lines are untouched
const SAME_SIZE = 0.1;           // lines of one paragraph differ in font size by at most 10%
const LEADING_RANGE = [0.9, 2];  // baseline gap, in font sizes, for consecutive paragraph lines
const LEADING_SLACK = 0.2;       // ...and each gap matches the first one within 0.2 font sizes
const ALIGN_SLACK = 0.6;         // left edges align within 0.6 font sizes
const HANG_MAX = 4;              // a list item's text may start up to 4 font sizes right of its marker
const JOIN_GAP = 1.2;            // pieces on one baseline closer than this (font sizes) are one line; wider gaps are table cells
const SPACE_GAP = 0.25;          // a gap wider than this (in font sizes) between pieces is a space
const DEFAULT_LEADING = 1.2;

const apply = ([a, b, c, d, e, f], [x, y]) => [x * a + y * c + e, x * b + y * d + f];
const LIST_MARKER = /^\s*([•●▪◦‣■□–\-*]|\d{1,3}[.)]|[a-zA-Z][.)])\s/;

function openPdf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pdf = doc.asPDF();
  if (!pdf) { doc.destroy(); throw new Error("Only PDF files can be edited."); }
  if (pdf.needsPassword()) { doc.destroy(); throw new Error("Quire can't edit password-protected PDFs yet."); }
  return pdf;
}

// The font's name decides its look; MuPDF's serif flag is unreliable (Word marks Lexend, a sans, as serif).
const SERIF = /times|georgia|garamond|cambria|book ?antiqua|palatino|minion|baskerville|serif/i;
const MONO = /mono|courier|consol|menlo/i;
function describeFont(rawName, bold, italic, mono) {
  const name = rawName.replace(/^[A-Z]{6}\+/, ""); // drop the subset tag, e.g. "BAAAAA+"
  return {
    rawName,
    name,
    bold: bold || /bold|black|heavy|semibold/i.test(name),
    italic: italic || /italic|oblique/i.test(name),
    family: mono || MONO.test(name) ? "mono" : SERIF.test(name) && !/sans/i.test(name) ? "serif" : "sans",
  };
}

// ---------- reading lines ----------

/** Visual lines of a page in MuPDF page space (top-left origin, y down). */
function readLines(page) {
  const raw = [];
  let line = null;
  page.toStructuredText("preserve-whitespace").walk({
    beginLine(bbox, wmode, dir) { line = { bbox, wmode, dir, chars: [] }; },
    onChar(c, origin, font, size, quad, color) {
      line.chars.push({ c, origin, size, quad, color,
        font: describeFont(font.getName(), font.isBold(), font.isItalic(), font.isMono()) });
    },
    endLine() { if (line.chars.length) raw.push(finishLine(line)); line = null; },
  });
  return mergeBaselines(raw);
}

function finishLine(l) {
  const styled = l.chars.find((ch) => ch.c.trim()) ?? l.chars[0];
  const start = l.chars.findIndex((ch) => ch.c.trim());
  const end = l.chars.findIndex((ch, i) => i > start && !ch.c.trim());
  const lastOfWord = start === -1 ? null : l.chars[(end === -1 ? l.chars.length : end) - 1];
  return {
    ...l,
    firstWordEnd: lastOfWord ? lastOfWord.quad[2] : l.bbox[0], // right edge of the first word (none: blank line)
    text: l.chars.map((ch) => ch.c).join(""),
    size: styled.size, font: styled.font, color: styled.color,
    left: l.chars[0].origin[0], baseline: l.chars[0].origin[1],
    horizontal: l.wmode === 0 && Math.abs(l.dir[1]) < 0.01 && l.dir[0] > 0,
  };
}

/** MuPDF may split one visual line into pieces (font changes, gaps); join close pieces. */
function mergeBaselines(lines) {
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline || a.left - b.left);
  const out = [];
  for (const l of sorted) {
    const prev = out.at(-1);
    const gap = prev ? l.bbox[0] - prev.bbox[2] : Infinity;
    if (prev && prev.horizontal && l.horizontal && Math.abs(l.baseline - prev.baseline) < prev.size * 0.3
      && gap > -prev.size && gap < prev.size * JOIN_GAP) {
      const space = gap > prev.size * SPACE_GAP && !/\s$/.test(prev.text) ? " " : "";
      out[out.length - 1] = {
        ...prev,
        text: prev.text + space + l.text,
        chars: [...prev.chars, ...l.chars],
        bbox: [prev.bbox[0], Math.min(prev.bbox[1], l.bbox[1]), l.bbox[2], Math.max(prev.bbox[3], l.bbox[3])],
      };
    } else {
      out.push(l);
    }
  }
  return out;
}

// ---------- grouping lines into a paragraph ----------

const overlaps = (a, b) => a.bbox[0] < b.bbox[2] && b.bbox[0] < a.bbox[2];

/** The nearest line below (dir 1) or above (dir -1) `line` that shares horizontal space with it. */
function neighbour(lines, line, dir) {
  let best = null;
  for (const l of lines) {
    const d = (l.baseline - line.baseline) * dir;
    if (d > line.size * 0.3 && overlaps(l, line) && (!best || d < (best.baseline - line.baseline) * dir)) best = l;
  }
  return best;
}

/** Whether `below` continues the paragraph that `above` belongs to, in a column ending at `right`. */
function continues(above, below, leading, right) {
  if (!above.horizontal || !below.horizontal) return false;
  // If below's first word would have fit at the end of above, above ended its paragraph.
  const firstWord = below.firstWordEnd - below.left;
  if (above.bbox[2] + above.size * SPACE_GAP + firstWord < right - 1) return false;
  if (Math.abs(above.size - below.size) > above.size * SAME_SIZE) return false;
  if (above.font.bold !== below.font.bold || above.font.family !== below.font.family) return false;
  if (LIST_MARKER.test(below.text)) return false; // a new list item starts a new paragraph
  const gap = below.baseline - above.baseline;
  if (gap < above.size * LEADING_RANGE[0] || gap > above.size * LEADING_RANGE[1]) return false;
  if (leading !== undefined && Math.abs(gap - leading) > above.size * LEADING_SLACK) return false;
  const shift = below.left - above.left;
  return Math.abs(shift) <= above.size * ALIGN_SLACK
    || (LIST_MARKER.test(above.text) && shift > 0 && shift < above.size * HANG_MAX);
}

function collectParagraph(lines, clicked, bounds) {
  if (!clicked.horizontal) return [clicked]; // shortcut: rotated/vertical text is edited one line at a time
  const rightOf = (line) => columnRight(lines, [line], bounds);
  const para = [clicked];
  let leading;
  for (let cur = clicked, next; (next = neighbour(lines, cur, 1))
    && continues(cur, next, leading, rightOf(cur)); cur = next) {
    leading ??= next.baseline - cur.baseline;
    para.push(next);
  }
  for (let cur = clicked, prev; !LIST_MARKER.test(cur.text) && (prev = neighbour(lines, cur, -1))
    && continues(prev, cur, leading, rightOf(prev)); cur = prev) {
    leading ??= cur.baseline - prev.baseline;
    para.unshift(prev);
  }
  return para;
}

/** Join a paragraph's lines into one string; returns the text and where each line starts in it. */
function joinLines(para) {
  let text = "";
  const starts = [];
  para.forEach((l, i) => {
    let piece = l.text.replace(/\s+$/, "");
    if (i > 0) {
      piece = piece.replace(/^\s+/, "");
      if (!text.endsWith("-")) text += " "; // keep hyphenated words joined as they were
    }
    starts.push(text.length - (i > 0 ? l.text.length - l.text.replace(/^\s+/, "").length : 0));
    text += piece;
  });
  return { text, starts };
}

/**
 * Where the paragraph's column ends: the furthest right edge of lines aligned with it, but
 * never past text sitting to its right on the same lines (a neighbouring table cell or column).
 */
function columnRight(lines, para, pageBounds) {
  const left = para[0].left, size = para[0].size;
  const own = Math.max(...para.map((l) => l.bbox[2]));
  const aligned = lines.filter((l) => l.horizontal && !para.includes(l)
    && Math.abs(l.left - left) <= size * ALIGN_SLACK);
  const right = aligned.length
    ? Math.max(own, ...aligned.map((l) => l.bbox[2]))
    : Math.max(own, pageBounds[2] - (left - pageBounds[0])); // nothing aligned: mirror the left margin
  const neighbours = lines.filter((l) => !para.includes(l) && l.bbox[0] >= own
    && para.some((p) => l.bbox[1] < p.bbox[3] && p.bbox[1] < l.bbox[3])); // shares a line's height
  return Math.min(right, ...neighbours.map((l) => l.bbox[0] - size * SPACE_GAP * 2));
}

/** Line spacing for a one-line paragraph: the smallest normal gap to a same-size line nearby. */
function nearbyLeading(lines, line) {
  const gaps = lines
    .filter((l) => l !== line && l.horizontal && Math.abs(l.size - line.size) <= line.size * SAME_SIZE)
    .map((l) => Math.abs(l.baseline - line.baseline))
    .filter((g) => g >= line.size * LEADING_RANGE[0] && g <= line.size * LEADING_RANGE[1]);
  return gaps.length ? Math.min(...gaps) : line.size * DEFAULT_LEADING;
}

/** Free space under the paragraph before the next text (or the page edge). */
function spaceBelow(lines, para, pageBounds) {
  const last = para.at(-1);
  const below = lines.filter((l) => !para.includes(l) && l.bbox[1] > last.bbox[1] && overlaps(l, last));
  const nextTop = Math.min(pageBounds[3], ...below.map((l) => l.bbox[1]));
  return nextTop - last.bbox[3];
}

// ---------- public: find ----------

const inside = ([x0, y0, x1, y1], [x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/**
 * The paragraph of text under `point` ([x, y] in PDF user space) on page `pageIndex` (0-based).
 * Coordinates named *Page are MuPDF page space; `rect` is PDF user space for drawing the editor.
 * @returns {null | object}
 */
export function findParagraph(bytes, pageIndex, point) {
  const pdf = openPdf(bytes);
  try {
    const page = pdf.loadPage(pageIndex);
    const toPage = page.getTransform();
    const toUser = Matrix.invert(toPage);
    const p = apply(toPage, point);
    const lines = readLines(page);
    const clicked = lines.find((l) => inside(l.bbox, p));
    if (!clicked) return null;
    if (clicked.wmode !== 0) throw new Error("Vertical text can't be edited yet.");

    const bounds = page.getBounds();
    const para = collectParagraph(lines, clicked, bounds);
    const { text, starts } = joinLines(para);
    const [dx, dy] = clicked.dir;
    const along = ([x, y]) => x * dx + y * dy;
    const caretInLine = clicked.chars.filter((ch) => {
      const q = ch.quad;
      return along([(q[0] + q[2]) / 2, (q[1] + q[3]) / 2]) < along(p);
    }).length;
    const lineIndex = para.indexOf(clicked);
    const caret = Math.min(text.length, Math.max(0, starts[lineIndex] + caretInLine));

    const first = para[0];
    const leading = para.length > 1
      ? (para.at(-1).baseline - first.baseline) / (para.length - 1) : nearbyLeading(lines, first);
    const right = first.horizontal ? columnRight(lines, para, bounds) : Infinity;
    const bodyLeft = para[1]?.left ?? first.left;
    const top = Math.min(...para.map((l) => l.bbox[1]));
    const bottom = Math.max(...para.map((l) => l.bbox[3]));
    const editRight = Number.isFinite(right) ? right : Math.max(...para.map((l) => l.bbox[2]));
    const [ux, uy] = [toUser[0] * dx + toUser[2] * dy, toUser[1] * dx + toUser[3] * dy];

    return {
      pageIndex,
      text,
      caret,
      lineCount: para.length,
      rect: Rect.transform([Math.min(first.left, bodyLeft), top, editRight, bottom], toUser),
      removeRects: para.map(({ bbox: [x0, y0, x1, y1] }) => {
        const inset = (y1 - y0) * REMOVE_INSET;
        return [x0, y0 + inset, x1, y1 - inset];
      }),
      layout: {
        firstPage: first.chars[0].origin, // first baseline start, page space
        firstLeft: first.left, bodyLeft, right, leading, dir: clicked.dir,
        spaceBelow: spaceBelow(lines, para, bounds),
      },
      toUser,
      angle: (Math.atan2(uy, ux) * 180) / Math.PI,
      size: first.size,
      color: first.color,
      font: first.font,
    };
  } finally {
    pdf.destroy();
  }
}

// ---------- fonts ----------

/** The embedded TrueType/OpenType file of the page font named `rawName`, if there is one. */
function embeddedFontFile(page, rawName) {
  const fonts = page.getObject().getInheritable("Resources").get("Font");
  if (!fonts.isDictionary()) return null;
  let found = null;
  fonts.forEach((ref) => {
    const font = ref.resolve();
    if (found || !font.isDictionary() || font.get("BaseFont").asName() !== rawName) return;
    const desc = font.get("Subtype").asName() === "Type0"
      ? font.get("DescendantFonts").get(0).get("FontDescriptor") : font.get("FontDescriptor");
    if (!desc.isDictionary()) return;
    const ttf = desc.get("FontFile2");
    const otf = desc.get("FontFile3");
    if (ttf.isStream()) found = ttf.readStream().asUint8Array().slice();
    else if (otf.isStream() && otf.get("Subtype").asName() === "OpenType") found = otf.readStream().asUint8Array().slice();
    // shortcut: bare CFF (Type1C) and Type 1 fonts aren't reused; their text gets a standard font.
  });
  return found;
}

// Fonts cut out of PDFs often lack tables pdf-lib reads (name, OS/2, post): give those values
// safe defaults instead of failing. Only metadata; the glyphs and widths come from the font itself.
const FONT_DEFAULTS = {
  postscriptName: () => "EmbeddedFont",
  italicAngle: () => 0,
  capHeight: (f) => f.ascent * 0.7,
  xHeight: (f) => f.ascent * 0.5,
  post: () => ({ isFixedPitch: 0 }), // pdf-lib's font flags read post.isFixedPitch
};
const tolerantFontkit = {
  create(data, postscriptName) {
    const font = fontkit.create(data, postscriptName);
    for (const [key, fallback] of Object.entries(FONT_DEFAULTS)) {
      let ok;
      try { ok = font[key] !== undefined; } catch { ok = false; }
      if (!ok) Object.defineProperty(font, key, { value: fallback(font) });
    }
    return font;
  },
};

/** Whether fontkit can map characters to glyphs and lay out text with this font file. */
function usableFont(file) {
  try {
    const font = tolerantFontkit.create(file);
    return font.characterSet.length > 0 && font.layout("a").glyphs.length > 0;
  } catch {
    return false; // damaged or cmap-less font: a standard font is the designed fallback
  }
}

function standardFont({ family, bold, italic }) {
  const styles = {
    mono: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
    sans: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
    serif: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  }[family];
  return StandardFonts[styles[(bold ? 1 : 0) + (italic ? 2 : 0)]];
}

/** Fonts to write `text` with: the document's own where it has the letters, a standard one for the rest. */
async function pickFonts(doc, fontFile, style, text) {
  let own = null;
  if (fontFile && usableFont(fontFile)) { // check first: pdf-lib processes every embedded font on save
    doc.registerFontkit(tolerantFontkit);
    // No ligatures: a subset font's "ffi"/"fl" glyphs often have no letter mapping, which breaks
    // search and copy (and the glyph itself may be missing). Kerning stays on.
    own = await doc.embedFont(fontFile, { subset: false, features: { liga: false, clig: false, dlig: false } });
  }
  const ownSet = new Set(own?.getCharacterSet() ?? []);
  const has = (set, ch) => set.has(ch.codePointAt(0));
  const needsFallback = [...text].some((ch) => !has(ownSet, ch)); // spaces too: a subset may lack them
  const fallback = needsFallback || !own ? await doc.embedFont(standardFont(style)) : null;
  const fallbackSet = new Set(fallback?.getCharacterSet() ?? []);
  const unsupported = [...new Set([...text].filter((ch) => !has(ownSet, ch) && !has(fallbackSet, ch)))];
  if (unsupported.length) throw new Error(`These characters can't be typed here yet: ${unsupported.join("")}`);

  const fontFor = (ch) => (has(ownSet, ch) ? own : fallback);
  /** Split a string into runs that share a font. */
  const runs = (s) => {
    const out = [];
    for (const ch of s) {
      const font = fontFor(ch);
      if (out.at(-1)?.font === font) out.at(-1).text += ch;
      else out.push({ font, text: ch });
    }
    return out;
  };
  return {
    runs,
    width: (s, size) => runs(s).reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0),
    usedOwn: Boolean(own),
    usedFallback: fallback ? [...new Set([...text].filter((ch) => ch.trim() && fontFor(ch) === fallback))] : [],
  };
}

// ---------- layout ----------

/** Greedy word wrap; `maxWidth(i)` is the room on line i. Hard line breaks are kept. */
export function wrapText(text, maxWidth, width) {
  const lines = [];
  for (const block of text.split("\n")) {
    let line = "";
    for (const word of block.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && width(candidate) > maxWidth(lines.length)) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function pdfColor(c) {
  if (c.length === 1) return grayscale(c[0]);
  if (c.length === 4) return cmyk(...c);
  return rgb(...c);
}

// ---------- public: replace ----------

/**
 * Replace the paragraph `para` (from findParagraph on the same bytes) with `text`.
 * With allowOverflow false, text that would run into what's below isn't written: bytes is
 * null and overflowLines says how many lines too many it needs.
 * @returns {Promise<{bytes: Uint8Array|null, lines: number, usedOwnFont: boolean,
 *   fallbackChars: string[], overflows: boolean, overflowLines: number}>}
 */
export async function replaceParagraph(bytes, para, text, { allowOverflow = true } = {}) {
  // 1. remove only the old letters, and keep a copy of the paragraph's embedded font
  const pdf = openPdf(bytes);
  let removed, fontFile;
  try {
    const page = pdf.loadPage(para.pageIndex);
    try {
      fontFile = embeddedFontFile(page, para.font.rawName);
    } catch {
      fontFile = null; // malformed font entry: a standard font is the designed fallback
    }
    for (const r of para.removeRects) page.createAnnotation("Redact").setRect(r);
    page.applyRedactions(false, PDFPage.REDACT_IMAGE_NONE, PDFPage.REDACT_LINE_ART_NONE,
      PDFPage.REDACT_TEXT_REMOVE);
    removed = pdf.saveToBuffer("garbage=compact").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }
  const clean = text.replace(/\r/g, "").replace(/[ \t]+$/gm, "");
  if (!clean.trim()) {
    return { bytes: removed, lines: 0, usedOwnFont: false, fallbackChars: [], overflows: false, overflowLines: 0 };
  }

  // 2. wrap the new text into the paragraph's column and write it line by line
  const doc = await PDFDocument.load(removed);
  const fonts = await pickFonts(doc, fontFile, para.font, clean);
  const { firstPage, firstLeft, bodyLeft, right, leading, dir, spaceBelow } = para.layout;
  const room = (i) => right - (i === 0 ? firstLeft : bodyLeft);
  const lines = wrapText(clean, room, (s) => fonts.width(s, para.size));
  const grownBy = (lines.length - para.lineCount) * leading;
  const overflows = grownBy > spaceBelow;
  const overflowLines = overflows ? Math.ceil((grownBy - spaceBelow) / leading) : 0;
  const summary = { lines: lines.length, usedOwnFont: fonts.usedOwn, fallbackChars: fonts.usedFallback, overflows, overflowLines };
  if (overflows && !allowOverflow) return { ...summary, bytes: null };

  const page = doc.getPage(para.pageIndex);
  const color = pdfColor(para.color);
  const [dx, dy] = dir;
  const [nx, ny] = [-dy, dx]; // from one line to the next, in page space
  lines.forEach((line, i) => {
    const shift = i === 0 ? 0 : bodyLeft - firstLeft;
    let x = firstPage[0] + shift * dx + i * leading * nx;
    let y = firstPage[1] + shift * dy + i * leading * ny;
    for (const run of fonts.runs(line)) {
      const [ux, uy] = apply(para.toUser, [x, y]);
      page.drawText(run.text, { x: ux, y: uy, size: para.size, font: run.font, color, rotate: degrees(para.angle) });
      const w = run.font.widthOfTextAtSize(run.text, para.size);
      x += w * dx;
      y += w * dy;
    }
  });
  return { ...summary, bytes: await doc.save() };
}

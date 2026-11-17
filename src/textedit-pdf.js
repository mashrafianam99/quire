// Edit real PDF text a paragraph at a time.
// findParagraph: MuPDF reads the page's lines, groups the clicked line with its neighbours
//   into a paragraph and records its style and geometry.
// replaceParagraph: MuPDF removes only those letters (images and lines behind stay), then
//   pdf-lib re-wraps the new text into the paragraph's column, in the document's own embedded
//   font where it has the letters, and the closest standard font for the ones it lacks.
//   When the paragraph grows, everything below it in its column is moved down to make room;
//   when it shrinks, that is moved up to close the gap.
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

/** Visual lines and image boxes of a page in MuPDF page space (top-left origin, y down). */
function readPage(page) {
  const raw = [];
  const images = [];
  let line = null;
  page.toStructuredText("preserve-whitespace,preserve-images").walk({
    onImageBlock(bbox) { images.push(bbox); },
    beginLine(bbox, wmode, dir) { line = { bbox, wmode, dir, chars: [] }; },
    onChar(c, origin, font, size, quad, color) {
      line.chars.push({ c, origin, size, quad, color,
        font: describeFont(font.getName(), font.isBold(), font.isItalic(), font.isMono()) });
    },
    endLine() { if (line.chars.length) raw.push(finishLine(line)); line = null; },
  });
  return { lines: mergeBaselines(raw), images };
}

const styleKey = (ch) => `${ch.font.rawName}|${ch.size.toFixed(1)}|${ch.color.join()}`;

/** The style most of a line's letters have (a line starting with a bold word is still body text). */
function dominantStyle(chars) {
  const counts = new Map();
  for (const ch of chars) if (ch.c.trim()) counts.set(styleKey(ch), (counts.get(styleKey(ch)) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return chars.find((ch) => styleKey(ch) === best) ?? chars[0];
}

function finishLine(l) {
  const styled = dominantStyle(l.chars);
  const start = l.chars.findIndex((ch) => ch.c.trim());
  const end = l.chars.findIndex((ch, i) => i > start && !ch.c.trim());
  const lastOfWord = start === -1 ? null : l.chars[(end === -1 ? l.chars.length : end) - 1];
  return {
    ...l,
    firstWordEnd: lastOfWord ? lastOfWord.quad[2] : l.bbox[0], // right edge of the first word (none: blank line)
    text: l.chars.map((ch) => ch.c).join(""),
    charStyles: l.chars.flatMap((ch) => Array(ch.c.length).fill(ch)), // one per UTF-16 unit of text
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
        charStyles: [...prev.charStyles, ...(space ? [prev.charStyles.at(-1)] : []), ...l.charStyles],
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
  let charStyles = [];
  const starts = [];
  para.forEach((l, i) => {
    const lead = i > 0 ? l.text.length - l.text.replace(/^\s+/, "").length : 0;
    const piece = l.text.replace(/\s+$/, "").slice(lead);
    if (i > 0 && !text.endsWith("-")) { // keep hyphenated words joined as they were
      text += " ";
      charStyles = [...charStyles, charStyles.at(-1)];
    }
    starts.push(text.length - lead);
    text += piece;
    charStyles = [...charStyles, ...l.charStyles.slice(lead, lead + piece.length)];
  });
  return { text, starts, ...styleRuns(text, charStyles) };
}

/** Split text into runs of one style: {runs: [{text, style}], styles: [{font, size, color}]}. */
function styleRuns(text, charStyles) {
  const styles = [];
  const keys = [];
  const runs = [];
  [...text].reduce((i, ch) => {
    const key = styleKey(charStyles[i]);
    let style = keys.indexOf(key);
    if (style === -1) {
      const { font, size, color } = charStyles[i];
      style = styles.push({ font, size, color }) - 1;
      keys.push(key);
    }
    if (runs.at(-1)?.style === style) runs.at(-1).text += ch;
    else runs.push({ text: ch, style });
    return i + ch.length;
  }, 0);
  return { runs, styles };
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

const FOOTER_BAND = 0.12; // a running footer sits in the bottom 12% of the page...
const FOOTER_GAP = 2;     // ...with at least 2 of its line heights of space above it

/** Top of the page's running footer (page number, "Prepared by …"), or null when it has none. */
function footerTop(lines, [, py0, , py1]) {
  const bandTop = py1 - (py1 - py0) * FOOTER_BAND;
  const [lowest, ...rest] = [...lines].sort((a, b) => b.bbox[3] - a.bbox[3]);
  if (!lowest) return null;
  let top = lowest.bbox[1];
  let height = lowest.bbox[3] - lowest.bbox[1];
  for (const l of rest) {
    if (top < bandTop) return null; // the bottom cluster reaches up into the body: no footer
    if (top - l.bbox[3] >= height * FOOTER_GAP) return top;
    top = Math.min(top, l.bbox[1]);
    height = Math.max(height, l.bbox[3] - l.bbox[1]);
  }
  return null; // the whole page is one cluster
}

/**
 * The block that has to move down when the paragraph grows: from the paragraph's bottom to the
 * running footer (or the page's bottom), as wide as the gap to any column beside it. Null when
 * nothing is below. `bottom` is the lowest text or image in it; `limit` is how low it may go.
 */
function blockBelow(lines, images, para, bounds) {
  const [px0, py0, px1, py1] = bounds;
  const top = para.at(-1).bbox[3];
  const footer = footerTop(lines, bounds);
  const floor = footer !== null && footer > top ? footer : py1;
  const colLeft = Math.min(...para.map((l) => l.bbox[0]));
  const colRight = Math.max(...para.map((l) => l.bbox[2]));
  const under = lines.filter((l) => !para.includes(l) && l.bbox[1] >= top && l.bbox[1] < floor);
  const leftOf = under.filter((l) => l.bbox[2] <= colLeft).map((l) => l.bbox[2]);
  const rightOf = under.filter((l) => l.bbox[0] >= colRight).map((l) => l.bbox[0]);
  let x0 = leftOf.length ? (Math.max(...leftOf) + colLeft) / 2 : px0;
  let x1 = rightOf.length ? (Math.min(...rightOf) + colRight) / 2 : px1;
  // Widen until no line below crosses a side (a wide line or a table row would be cut in two).
  for (let widened = true; widened;) {
    widened = false;
    for (const { bbox: [a, , c] } of under) {
      if (a < x0 && c > x0) { x0 = Math.max(px0, a - 1); widened = true; }
      if (a < x1 && c > x1) { x1 = Math.min(px1, c + 1); widened = true; }
    }
  }
  // shortcut: vector drawings aren't measured, so one near the page bottom may be pushed past it
  const content = [...under.map((l) => l.bbox), ...images]
    .filter(([a, b, c]) => b >= top && b < floor && a < x1 && c > x0);
  if (!content.length) return null;
  // cut mid-gap, not along the text's edge: decorations reaching just past the paragraph (an accent
  // bar, an underline) stay whole above the cut instead of a sliver of them moving down
  // ...but above any line beside the paragraph that reaches across it, so that line moves whole
  // (repeat: raising the cut can make it cross another line)
  let cut = (top + Math.min(...content.map((b) => b[1]))) / 2;
  for (let raised = true; raised;) {
    raised = false;
    for (const l of lines) {
      const [a, b, c, d] = l.bbox;
      if (!para.includes(l) && b < cut && d > cut && a < x1 && c > x0) {
        cut = b;
        raised = true;
      }
    }
  }
  // how high the block may rise when the paragraph shrinks: not into anything above the cut
  // that isn't the paragraph (a figure or a column beside it)
  const above = [...lines.filter((l) => !para.includes(l)).map((l) => l.bbox), ...images]
    .filter(([a, b, c]) => b < cut && a < x1 && c > x0);
  return {
    rect: [x0, cut, x1, floor],
    bottom: Math.max(...content.map((b) => b[3])),
    limit: floor === py1 ? py1 : floor - para.at(-1).size, // keep a line's space above the footer
    ceiling: Math.max(py0, ...above.map((b) => b[3])),
  };
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
    const { lines, images } = readPage(page);
    const clicked = lines.find((l) => inside(l.bbox, p));
    if (!clicked) return null;
    if (clicked.wmode !== 0) throw new Error("Vertical text can't be edited yet.");

    const bounds = page.getBounds();
    const para = collectParagraph(lines, clicked, bounds);
    const { text, starts, runs, styles } = joinLines(para);
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
        below: first.horizontal ? blockBelow(lines, images, para, bounds) : null,
      },
      toUser,
      angle: (Math.atan2(uy, ux) * 180) / Math.PI,
      size: first.size,
      color: first.color,
      font: first.font,
      runs, // [{text, style}] covering `text`; style indexes `styles`
      styles, // [{font, size, color}]
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
    // pdf-lib measures every glyph when embedding a whole font; in a subset, the cut-away ones
    // throw. Their width comes straight from the width table instead (they are never drawn).
    const getGlyph = font.getGlyph.bind(font);
    font.getGlyph = (id, codePoints) => {
      const glyph = getGlyph(id, codePoints);
      try { void glyph.advanceWidth; } catch {
        let width = 0;
        try { const m = font.hmtx.metrics; width = m.get(Math.min(id, m.length - 1))?.advance ?? 0; } catch { /* 0 */ }
        Object.defineProperty(glyph, "advanceWidth", { value: width });
      }
      return glyph;
    };
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
  // A subset font may map a letter to a glyph whose outline was cut away: draw that one in the fallback.
  const probe = own ? tolerantFontkit.create(fontFile) : null;
  for (const ch of new Set(text)) {
    if (!has(ownSet, ch)) continue;
    try { void probe.glyphForCodePoint(ch.codePointAt(0)).cbox; } catch { ownSet.delete(ch.codePointAt(0)); }
  }
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

/**
 * Greedy word wrap over ranges of `text`: `maxWidth(i)` is the room on line i and
 * `widthOf(start, end)` measures text.slice(start, end). Hard line breaks are kept.
 * @returns {[number, number][]} each line's [start, end)
 */
export function wrapRanges(text, maxWidth, widthOf) {
  const lines = [];
  let blockStart = 0;
  for (const block of text.split("\n")) {
    let line = null; // [start, end) of the line being filled
    for (const word of block.matchAll(/[^ ]+/g)) {
      const [start, end] = [blockStart + word.index, blockStart + word.index + word[0].length];
      if (line && widthOf(line[0], end) > maxWidth(lines.length)) {
        lines.push(line);
        line = [start, end];
      } else {
        line = [line?.[0] ?? start, end];
      }
    }
    lines.push(line ?? [blockStart, blockStart]);
    blockStart += block.length + 1;
  }
  return lines;
}

/** Greedy word wrap of plain text; `width(s)` measures a string. */
export function wrapText(text, maxWidth, width) {
  return wrapRanges(text, maxWidth, (a, b) => width(text.slice(a, b))).map(([a, b]) => text.slice(a, b));
}

// ---------- styles of the new text ----------

const fontStem = (name) => name.split(/[-,]/)[0]; // "Carlito-Bold" -> "Carlito"

/** BaseFont names of the fonts the page uses. */
function pageFontNames(page) {
  const fonts = page.getObject().getInheritable("Resources").get("Font");
  const names = [];
  if (fonts.isDictionary()) fonts.forEach((ref) => { const n = ref.resolve().get("BaseFont"); if (n.isName()) names.push(n.asName()); });
  return names;
}

/**
 * Give every run a concrete style. A run's bold/italic flags (from the editor) override its
 * style's: the paragraph's own style with those flags if it has one, else that font's bold/italic
 * sibling from the page, else a standard font with those flags (rawName null).
 */
function resolveStyles(para, runs, fontNames) {
  const base = Math.max(0, para.styles.findIndex((s) => s.font.rawName === para.font.rawName));
  const siblings = fontNames.map((n) => describeFont(n, false, false, false));
  return runs.map(({ text, style = base, bold, italic }) => {
    const own = para.styles[style] ?? para.styles[base];
    const want = { bold: bold ?? own.font.bold, italic: italic ?? own.font.italic };
    const fits = (f) => f.bold === want.bold && f.italic === want.italic;
    if (fits(own.font)) return { text, style: own };
    const same = para.styles.find((s) => fits(s.font) && s.size === own.size && s.color.join() === own.color.join()
      && fontStem(s.font.name) === fontStem(own.font.name));
    if (same) return { text, style: same };
    const sibling = siblings.find((f) => fits(f) && fontStem(f.name) === fontStem(own.font.name));
    return { text, style: { ...own, font: sibling ?? { ...own.font, ...want, rawName: null } } };
  });
}

/** Join runs into one string, dropping \r and spaces at line ends; `styleAt[i]` is the style of unit i. */
function flatten(runs) {
  const units = runs.flatMap(({ text, style }) => text.replace(/\r/g, "").split("").map((u) => ({ u, style })));
  const kept = [];
  let atLineEnd = true; // walking backwards: nothing but spaces since the last line break
  for (let i = units.length - 1; i >= 0; i--) {
    const { u } = units[i];
    if (u === "\n") atLineEnd = true;
    else if (u === " " || u === "\t") { if (atLineEnd) continue; }
    else atLineEnd = false;
    kept.push(units[i]);
  }
  kept.reverse();
  return { text: kept.map((x) => x.u).join(""), styleAt: kept.map((x) => x.style) };
}

/** Consecutive pieces of text[start, end) that share a style: [{text, style}]. */
function segments(text, styleAt, start, end) {
  const out = [];
  for (let i = start; i < end; i++) {
    if (out.at(-1)?.style === styleAt[i]) out.at(-1).text += text[i];
    else out.push({ text: text[i], style: styleAt[i] });
  }
  return out;
}

function pdfColor(c) {
  if (c.length === 1) return grayscale(c[0]);
  if (c.length === 4) return cmyk(...c);
  return rgb(...c);
}

// ---------- public: replace ----------

// Remove text, image pixels, and drawings the rects fully cover.
function redact(pdf, pageIndex, rects) {
  const page = pdf.loadPage(pageIndex);
  for (const r of rects) if (r[2] > r[0] && r[3] > r[1]) page.createAnnotation("Redact").setRect(r);
  page.applyRedactions(false, PDFPage.REDACT_IMAGE_PIXELS, PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
    PDFPage.REDACT_TEXT_REMOVE);
  return pdf.saveToBuffer("garbage=compact").asUint8Array().slice();
}

/** Split a page in two: `kept` without the block `rect`, `block` with only what's inside it. */
function splitBlock(bytes, pageIndex, rect) {
  const [x0, y0, x1, y1] = rect;
  const kept = openPdf(bytes);
  const block = openPdf(bytes);
  try {
    const [px0, py0, px1, py1] = block.loadPage(pageIndex).getBounds();
    return {
      kept: redact(kept, pageIndex, [rect]),
      // everything outside the block, so its clipped-away parts (e.g. the footer) aren't copied as hidden text
      block: redact(block, pageIndex,
        [[px0, py0, px1, y0], [px0, y0, x0, py1], [x1, y0, px1, py1], [x0, y1, x1, py1]]),
    };
  } finally {
    kept.destroy();
    block.destroy();
  }
}

/**
 * Replace the paragraph `para` (from findParagraph on the same bytes) with `content`: plain
 * text (written in the paragraph's main style), or runs [{text, style?, bold?, italic?}] where
 * `style` indexes para.styles and bold/italic override it. When it grows, what's below it in its column moves down by the added lines (`pushed`, in
 * points); when it shrinks, it moves up by the removed lines (`pulled`), but never into
 * anything beside the paragraph. If growing would push content off the page and the text doesn't fit the gap below,
 * it isn't written while allowOverflow is false: bytes is null and overflowLines says how
 * many lines too many it needs.
 * @returns {Promise<{bytes: Uint8Array|null, lines: number, usedOwnFont: boolean,
 *   fallbackChars: string[], overflows: boolean, overflowLines: number, pushed: number, pulled: number}>}
 */
export async function replaceParagraph(bytes, para, content, { allowOverflow = true } = {}) {
  // 1. remove only the old letters; resolve the new text's styles and copy their embedded fonts
  const pdf = openPdf(bytes);
  let removed, text, styleAt, styles, fontFiles;
  try {
    const page = pdf.loadPage(para.pageIndex);
    let names = [];
    try { names = pageFontNames(page); } catch { /* malformed resources: no siblings, standard fonts */ }
    const runs = resolveStyles(para, typeof content === "string" ? [{ text: content }] : content, names);
    ({ text, styleAt } = flatten(runs));
    styles = [...new Set(styleAt)];
    fontFiles = styles.map((s) => {
      try {
        return s.font.rawName ? embeddedFontFile(page, s.font.rawName) : null;
      } catch {
        return null; // malformed font entry: a standard font is the designed fallback
      }
    });
    for (const r of para.removeRects) page.createAnnotation("Redact").setRect(r);
    page.applyRedactions(false, PDFPage.REDACT_IMAGE_NONE, PDFPage.REDACT_LINE_ART_NONE,
      PDFPage.REDACT_TEXT_REMOVE);
    removed = pdf.saveToBuffer("garbage=compact").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }
  if (!text.trim()) {
    return { bytes: removed, lines: 0, usedOwnFont: false, fallbackChars: [], overflows: false, overflowLines: 0, pushed: 0, pulled: 0 };
  }

  // 2. wrap the new text into the paragraph's column, measuring each style in its own font
  const { firstPage, firstLeft, bodyLeft, right, leading, dir, spaceBelow, below } = para.layout;
  const layOut = async (source) => {
    const doc = await PDFDocument.load(source);
    const fonts = new Map();
    for (const [i, s] of styles.entries()) {
      const own = [...text].filter((_, j) => styleAt[j] === s).join(""); // shortcut: units, fine for BMP text
      fonts.set(s, await pickFonts(doc, fontFiles[i], s.font, own));
    }
    const widthOf = (a, b) => segments(text, styleAt, a, b)
      .reduce((w, seg) => w + fonts.get(seg.style).width(seg.text, seg.style.size), 0);
    const room = (i) => right - (i === 0 ? firstLeft : bodyLeft);
    return { doc, fonts, lines: wrapRanges(text, room, widthOf) };
  };
  let { doc, fonts, lines } = await layOut(removed);
  const grownBy = (lines.length - para.lineCount) * leading;
  const pushed = grownBy > 0 && below && below.bottom + grownBy <= below.limit ? grownBy : 0;
  // all or nothing: a part-way pull would leave an odd-sized gap
  const pulled = grownBy < 0 && below && below.rect[1] + grownBy >= below.ceiling ? -grownBy : 0;
  const overflows = !pushed && grownBy > spaceBelow;
  const overflowLines = overflows ? Math.ceil((grownBy - spaceBelow) / leading) : 0;
  const summary = {
    lines: lines.length,
    usedOwnFont: [...fonts.values()].every((f) => f.usedOwn),
    fallbackChars: [...new Set([...fonts.values()].flatMap((f) => f.usedFallback))],
    overflows, overflowLines, pushed, pulled,
  };
  if (overflows && !allowOverflow) return { ...summary, bytes: null };

  // 3. make room (or close the gap): cut out the block below and draw it again lower (or higher),
  // as real (searchable) content
  // shortcut: links and form fields in the block stay where they were; move annotations too if users hit it
  const shift = pushed - pulled; // in page space, + is down
  if (shift) {
    const { kept, block } = splitBlock(removed, para.pageIndex, below.rect);
    ({ doc, fonts } = await layOut(kept));
    const [l, b, r, t] = Rect.transform(below.rect, para.toUser);
    const source = (await PDFDocument.load(block)).getPage(para.pageIndex);
    const form = await doc.embedPage(source, { left: l, bottom: b, right: r, top: t }, [1, 0, 0, 1, 0, 0]);
    const m = para.toUser; // the move in page space (+y down), expressed in user space
    doc.getPage(para.pageIndex).drawPage(form, { x: m[2] * shift, y: m[3] * shift });
  }

  // 4. write the new text line by line
  const page = doc.getPage(para.pageIndex);
  const [dx, dy] = dir;
  const [nx, ny] = [-dy, dx]; // from one line to the next, in page space
  lines.forEach(([start, end], i) => {
    const shift = i === 0 ? 0 : bodyLeft - firstLeft;
    let x = firstPage[0] + shift * dx + i * leading * nx;
    let y = firstPage[1] + shift * dy + i * leading * ny;
    for (const { text: piece, style } of segments(text, styleAt, start, end)) {
      const color = pdfColor(style.color);
      for (const run of fonts.get(style).runs(piece)) {
        const [ux, uy] = apply(para.toUser, [x, y]);
        page.drawText(run.text, { x: ux, y: uy, size: style.size, font: run.font, color, rotate: degrees(para.angle) });
        const w = run.font.widthOfTextAtSize(run.text, style.size);
        x += w * dx;
        y += w * dy;
      }
    }
  });
  return { ...summary, bytes: await doc.save() };
}

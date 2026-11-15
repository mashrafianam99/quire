// Edit one line of real PDF text: MuPDF finds the line under a point and removes its letters
// (only the letters; images and lines behind stay), then pdf-lib writes the new text at the
// same baseline, size, color and angle.
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts, rgb, cmyk, grayscale, degrees } from "pdf-lib";

const { PDFPage, Matrix, Rect } = mupdf;
const REMOVE_INSET = 0.2; // shrink the removal box vertically so neighbouring lines are never touched

const apply = ([a, b, c, d, e, f], [x, y]) => [x * a + y * c + e, x * b + y * d + f];

function openPdf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pdf = doc.asPDF();
  if (!pdf) { doc.destroy(); throw new Error("Only PDF files can be edited."); }
  if (pdf.needsPassword()) { doc.destroy(); throw new Error("Quire can't edit password-protected PDFs yet."); }
  return pdf;
}

/** All text lines of a page, in MuPDF page space (top-left origin). */
function readLines(page) {
  const lines = [];
  let line = null;
  page.toStructuredText("preserve-whitespace").walk({
    beginLine(bbox, wmode, dir) { line = { bbox, wmode, dir, chars: [] }; },
    onChar(c, origin, font, size, quad, color) {
      line.chars.push({
        c, origin, size, quad, color,
        font: describeFont(font.getName(), font.isBold(), font.isItalic(), font.isMono()),
      });
    },
    endLine() { if (line.chars.length) lines.push(line); line = null; },
  });
  return lines;
}

// The font's name decides its look; MuPDF's serif flag is unreliable (Word marks Lexend, a sans, as serif).
const SERIF = /times|georgia|garamond|cambria|book ?antiqua|palatino|minion|baskerville|serif/i;
const MONO = /mono|courier|consol|menlo/i;
function describeFont(rawName, bold, italic, mono) {
  const name = rawName.replace(/^[A-Z]{6}\+/, ""); // drop the subset tag, e.g. "BAAAAA+"
  return {
    name,
    bold: bold || /bold|black|heavy|semibold/i.test(name),
    italic: italic || /italic|oblique/i.test(name),
    family: mono || MONO.test(name) ? "mono" : SERIF.test(name) && !/sans/i.test(name) ? "serif" : "sans",
  };
}

const inside = ([x0, y0, x1, y1], [x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/**
 * The line of text under `point` ([x, y] in PDF user space) on page `pageIndex` (0-based).
 * @returns {null | {pageIndex, text, caret, rect, removeRect, origin, angle, size, color, font}}
 *   rect/origin are in PDF user space; caret is the character index nearest the point.
 */
export function findLine(bytes, pageIndex, point) {
  const pdf = openPdf(bytes);
  try {
    const page = pdf.loadPage(pageIndex);
    const toPage = page.getTransform();
    const toUser = Matrix.invert(toPage);
    const p = apply(toPage, point);
    const line = readLines(page).find((l) => inside(l.bbox, p));
    if (!line) return null;
    if (line.wmode !== 0) throw new Error("Vertical text can't be edited yet.");

    const styled = line.chars.find((ch) => ch.c.trim()) ?? line.chars[0];
    // caret: after the last character whose middle is before the click, along the line direction
    const [dx, dy] = line.dir;
    const along = ([x, y]) => x * dx + y * dy;
    const caret = line.chars.filter((ch) => {
      const q = ch.quad;
      return along([(q[0] + q[2]) / 2, (q[1] + q[3]) / 2]) < along(p);
    }).length;

    const [bx0, by0, bx1, by1] = line.bbox;
    const inset = (by1 - by0) * REMOVE_INSET;
    // direction of the text in user space gives the angle to write it back at
    const [ux, uy] = [toUser[0] * dx + toUser[2] * dy, toUser[1] * dx + toUser[3] * dy];
    return {
      pageIndex,
      text: line.chars.map((ch) => ch.c).join(""),
      caret,
      rect: Rect.transform(line.bbox, toUser),
      removeRect: [bx0, by0 + inset, bx1, by1 - inset],
      origin: apply(toUser, line.chars[0].origin),
      angle: (Math.atan2(uy, ux) * 180) / Math.PI,
      size: styled.size,
      color: styled.color,
      font: styled.font,
    };
  } finally {
    pdf.destroy();
  }
}

// shortcut: new text uses the closest standard PDF font (Latin-1 only), not the document's own
// embedded font; reuse/subset the original font or bundle Noto/Liberation for an exact match.
function standardFont({ family, bold, italic }) {
  const styles = {
    mono: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
    sans: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
    serif: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  }[family];
  return StandardFonts[styles[(bold ? 1 : 0) + (italic ? 2 : 0)]];
}

function pdfColor(c) {
  if (c.length === 1) return grayscale(c[0]);
  if (c.length === 4) return cmyk(...c);
  return rgb(...c);
}

/** Remove the letters of `line` (from findLine on the same bytes) and write `text` in their place. */
export async function replaceLine(bytes, line, text) {
  // 1. remove only the old letters
  const pdf = openPdf(bytes);
  let removed;
  try {
    const page = pdf.loadPage(line.pageIndex);
    page.createAnnotation("Redact").setRect(line.removeRect);
    page.applyRedactions(false, PDFPage.REDACT_IMAGE_NONE, PDFPage.REDACT_LINE_ART_NONE,
      PDFPage.REDACT_TEXT_REMOVE);
    removed = pdf.saveToBuffer("garbage=compact").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }
  if (!text.trim()) return removed;

  // 2. write the new text on the old baseline
  const doc = await PDFDocument.load(removed);
  const font = await doc.embedFont(standardFont(line.font));
  const charset = new Set(font.getCharacterSet());
  const unsupported = [...new Set([...text].filter((ch) => !charset.has(ch.codePointAt(0))))];
  if (unsupported.length) throw new Error(`These characters can't be typed here yet: ${unsupported.join("")}`);
  doc.getPage(line.pageIndex).drawText(text, {
    x: line.origin[0], y: line.origin[1], size: line.size, font,
    color: pdfColor(line.color), rotate: degrees(line.angle),
  });
  return doc.save();
}

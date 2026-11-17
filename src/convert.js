// Conversions to PDF, on the device: Word (.docx) is turned into XHTML (docx.js), MuPDF lays it
// out into pages with real, selectable text, and pdf-lib stamps the header and footer on each page.
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { docxToHtml } from "./docx.js";

const BODY_EM = 11; // pt; the HTML sets its own sizes, this is only MuPDF's base for "em"

/** Draws the header and footer lines on every page, filling in {PAGE} and {NUMPAGES}. */
async function stampBands(pdfBytes, { page, header, footer }) {
  if (!header.length && !footer.length) return pdfBytes;
  const doc = await PDFDocument.load(pdfBytes);
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const pages = doc.getPages();
  // shortcut: header/footer text is drawn in Helvetica; letters it can't encode become "?"
  const encodable = (font, s) => [...s].map((c) => { try { font.encodeText(c); return c; } catch { return "?"; } }).join("");
  const draw = (pdfPage, line, baseline, n) => {
    const font = line.bold ? fonts.bold : fonts.regular;
    const text = encodable(font, line.text.replace(/\{PAGE\}/g, String(n)).replace(/\{NUMPAGES\}/g, String(pages.length)));
    const width = font.widthOfTextAtSize(text, line.size);
    const { width: pw } = pdfPage.getSize();
    const [left, right] = [page.margin[3], pw - page.margin[1]];
    const x = line.align === "center" ? (left + right - width) / 2 : line.align === "right" ? right - width : left;
    const [r, g, b] = line.color ? [1, 3, 5].map((i) => parseInt(line.color.slice(i, i + 2), 16) / 255) : [0, 0, 0];
    pdfPage.drawText(text, { x, y: baseline, size: line.size, font, color: rgb(r, g, b) });
  };
  pages.forEach((pdfPage, i) => {
    const { height } = pdfPage.getSize();
    let y = height - page.header;
    for (const line of header) draw(pdfPage, line, (y -= line.size), i + 1);
    y = page.footer;
    for (const line of [...footer].reverse()) { draw(pdfPage, line, y, i + 1); y += line.size * 1.2; }
  });
  return doc.save();
}

/**
 * A Word document (.docx) as a PDF: text stays real text; pictures, tables, lists, headers and
 * footers are kept.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function docxToPdf(bytes) {
  let converted;
  try {
    converted = await docxToHtml(bytes);
  } catch {
    throw new Error("This Word file couldn't be read. Is it a .docx (not an older .doc)?");
  }
  const out = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(out, "pdf", "compress");
  for (const piece of converted.html) {
    const html = mupdf.Document.openDocument(new TextEncoder().encode(piece), "application/xhtml+xml");
    try {
      html.layout(converted.page.width, converted.page.height, BODY_EM);
      for (let i = 0; i < html.countPages(); i++) {
        const page = html.loadPage(i);
        const device = writer.beginPage(page.getBounds());
        page.run(device, mupdf.Matrix.identity);
        writer.endPage();
      }
    } finally {
      html.destroy();
    }
  }
  writer.close();
  return stampBands(out.asUint8Array().slice(), converted);
}

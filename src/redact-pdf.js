// True redaction with MuPDF: everything under a marked area (text, image pixels, vector art)
// is deleted from the file, and unused objects are dropped so the old content can't be recovered.
import * as mupdf from "mupdf";

const { PDFPage } = mupdf;

/**
 * @param {Uint8Array} bytes
 * @param {{page: number, rect: number[]}[]} marks page is 0-based; rect is [x0,y0,x1,y1] in PDF user space
 * @returns {Uint8Array}
 */
export function redactPdf(bytes, marks) {
  if (!marks.length) throw new Error("Mark at least one area to redact.");
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF();
    if (!pdf) throw new Error("Only PDF files can be redacted.");
    if (pdf.needsPassword()) throw new Error("Quire can't redact password-protected PDFs yet.");
    const pageCount = pdf.countPages();
    const byPage = Map.groupBy(marks, (m) => m.page);
    for (const [index, list] of byPage) {
      if (!Number.isInteger(index) || index < 0 || index >= pageCount) {
        throw new Error(`Page ${index + 1} doesn't exist.`);
      }
      const page = pdf.loadPage(index);
      const toPageSpace = page.getTransform(); // PDF user space -> MuPDF's top-left page space
      for (const { rect } of list) {
        page.createAnnotation("Redact").setRect(mupdf.Rect.transform(rect, toPageSpace));
      }
      page.applyRedactions(true, PDFPage.REDACT_IMAGE_PIXELS,
        PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, PDFPage.REDACT_TEXT_REMOVE);
    }
    // garbage=compact drops the replaced content streams/images instead of leaving them in the file.
    return pdf.saveToBuffer("garbage=compact").asUint8Array().slice();
  } finally {
    doc.destroy();
  }
}

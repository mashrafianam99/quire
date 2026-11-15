import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as mupdf from "mupdf";
import { redactPdf } from "../src/redact-pdf.js";

async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 400]);
  page.drawText("PUBLIC heading", { x: 50, y: 300, size: 20, font });
  page.drawText("SECRET 4111-2222", { x: 50, y: 100, size: 20, font });
  return doc.save({ useObjectStreams: false });
}

function textOf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try { return doc.loadPage(0).toStructuredText("preserve-whitespace").asText(); }
  finally { doc.destroy(); }
}

/** Every stream decompressed, so text can't hide in compressed or hex-encoded form. */
function rawText(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try { return Buffer.from(doc.asPDF().saveToBuffer("decompress").asUint8Array()).toString("latin1"); }
  finally { doc.destroy(); }
}
const SECRET_IN_FILE = /SECRET|4111|534543524554/i; // 534543524554 = "SECRET" as PDF hex string

test("removes the text under a mark and keeps the rest", async () => {
  const original = await samplePdf();
  assert.match(textOf(original), /SECRET 4111/);
  assert.match(rawText(original), SECRET_IN_FILE); // the raw check below can see the secret

  const out = redactPdf(original, [{ page: 0, rect: [40, 90, 400, 125] }]);

  const text = textOf(out);
  assert.match(text, /PUBLIC heading/);
  assert.doesNotMatch(text, /SECRET|4111/);
  assert.doesNotMatch(rawText(out), SECRET_IN_FILE); // not left behind in an old stream either
});

test("rejects empty marks and pages that don't exist", async () => {
  const original = await samplePdf();
  assert.throws(() => redactPdf(original, []), /Mark at least one area/);
  assert.throws(() => redactPdf(original, [{ page: 3, rect: [0, 0, 10, 10] }]), /doesn't exist/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import * as mupdf from "mupdf";
import { findLine, replaceLine } from "../src/textedit-pdf.js";

async function samplePdf({ rotate = 0 } = {}) {
  const doc = await PDFDocument.create();
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.setRotation(degrees(rotate));
  page.drawText("Hello wonderful world", { x: 72, y: 700, size: 18, font: times, color: rgb(0.8, 0.1, 0.1) });
  page.drawText("Second line stays", { x: 72, y: 660, size: 12, font: helv });
  return doc.save();
}

function rawText(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try { return Buffer.from(doc.asPDF().saveToBuffer("decompress").asUint8Array()).toString("latin1"); }
  finally { doc.destroy(); }
}

test("finds the clicked line with its style and caret position", async () => {
  const line = findLine(await samplePdf(), 0, [130, 705]); // inside "wonderful"

  assert.equal(line.text, "Hello wonderful world");
  assert.ok(Math.abs(line.size - 18) < 0.5);
  assert.equal(line.font.family, "serif");
  assert.ok(Math.abs(line.origin[0] - 72) < 1 && Math.abs(line.origin[1] - 700) < 1);
  assert.ok(line.color[0] > 0.7 && line.color[1] < 0.2);
  assert.ok(line.caret > 6 && line.caret < 15, `caret ${line.caret} should be inside "wonderful"`);
});

test("returns null where there is no text", async () => {
  assert.equal(findLine(await samplePdf(), 0, [400, 300]), null);
});

for (const rotate of [0, 90]) {
  test(`replaces only that line, in place (page rotated ${rotate}°)`, async () => {
    const original = await samplePdf({ rotate });
    const line = findLine(original, 0, [130, 705]);

    const out = await replaceLine(original, line, "Hello brave new world");

    const again = findLine(out, 0, [130, 705]);
    assert.equal(again.text, "Hello brave new world");
    assert.ok(Math.abs(again.origin[0] - 72) < 1 && Math.abs(again.origin[1] - 700) < 1);
    assert.ok(Math.abs(again.size - 18) < 0.5);
    assert.equal(findLine(out, 0, [100, 663]).text, "Second line stays");
    assert.doesNotMatch(rawText(out), /wonderful/);
  });
}

test("rejects characters the replacement font can't draw", async () => {
  const original = await samplePdf();
  const line = findLine(original, 0, [130, 705]);
  await assert.rejects(() => replaceLine(original, line, "Hello 世界"), /can't be typed here yet: 世界/);
});

test("judges the font by its name, not MuPDF's serif flag", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.drawText("Bold heading", { x: 72, y: 700, size: 18, font: await doc.embedFont(StandardFonts.HelveticaBold) });
  page.drawText("code line", { x: 72, y: 660, size: 12, font: await doc.embedFont(StandardFonts.Courier) });
  const bytes = await doc.save();

  const heading = findLine(bytes, 0, [100, 705]);
  assert.equal(heading.font.family, "sans");
  assert.equal(heading.font.bold, true);
  assert.equal(findLine(bytes, 0, [90, 663]).font.family, "mono");
});

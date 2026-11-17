import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { docxToPdf } from "../src/convert.js";
import { docxToHtml } from "../src/docx.js";

// A heading, bold and subscript text, a numbered list, a picture, a bordered table with a shaded
// header row and merged cells, a page break, and a "Page X of Y" footer.
const sample = new Uint8Array(readFileSync(new URL("./fixtures/sample.docx", import.meta.url)));

function withPdf(bytes, fn) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try { return fn(doc); } finally { doc.destroy(); }
}

test("Word to PDF keeps the text, the picture and the page break, with real selectable text", async () => {
  const pdf = await docxToPdf(sample);

  withPdf(pdf, (doc) => {
    assert.equal(doc.countPages(), 2, "the page break starts a new page");
    const first = doc.loadPage(0).toStructuredText("preserve-images").asJSON();
    const text = doc.loadPage(0).toStructuredText().asText();
    assert.match(text, /Sample heading/);
    assert.match(text, /1\.\s*First step/);
    assert.match(text, /2\.\s*Second step/);
    assert.equal(JSON.parse(first).blocks.filter((b) => b.type === "image").length, 1, "the picture is kept");
    assert.match(doc.loadPage(1).toStructuredText().asText(), /Second page text\./);
  });
});

test("Word to PDF stamps the footer with page numbers", async () => {
  const pdf = await docxToPdf(sample);
  withPdf(pdf, (doc) => {
    assert.match(doc.loadPage(0).toStructuredText().asText(), /Page 1 of 2/);
    assert.match(doc.loadPage(1).toStructuredText().asText(), /Page 2 of 2/);
  });
});

test("tables keep their borders, shading and merged cells", async () => {
  const { html } = await docxToHtml(sample);
  const table = html[0].slice(html[0].indexOf("<table"), html[0].indexOf("</table>"));

  assert.match(table, /border-top: 1pt solid #000000/);
  assert.match(table, /background-color: #DCE6F2/i);
  assert.match(table, /rowspan="2"[^>]*>.*q0/);
  assert.match(table, /colspan="2"[^>]*>.*q1/);
  assert.equal((table.match(/<td/g) ?? []).length, 7, "merged-away cells aren't drawn");

  // and the drawn page shows the shaded header row
  const pdf = await docxToPdf(sample);
  withPdf(pdf, (doc) => {
    const page = doc.loadPage(0);
    const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const json = JSON.parse(page.toStructuredText().asJSON());
    const state = json.blocks.flatMap((b) => b.lines ?? []).find((l) => l.text.startsWith("State"));
    const [x, y] = [Math.round(state.bbox.x) - 2, Math.round(state.bbox.y + state.bbox.h / 2)];
    const rgb = [...pix.getPixels().slice((y * pix.getWidth() + x) * 3, (y * pix.getWidth() + x) * 3 + 3)];
    assert.ok(rgb[2] > rgb[0] && rgb[0] < 235, `shaded cell behind "State": ${rgb}`);
  });
});

test("explains when the file isn't a .docx", async () => {
  await assert.rejects(() => docxToPdf(new TextEncoder().encode("not a zip")), /couldn't be read/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as mupdf from "mupdf";
import { compressPdf, MAX_SIDE } from "../src/compress-pdf.js";

/** w×h RGB pixmap: top half red, bottom half blue, with noise so it doesn't compress to nothing. */
function picture(w, h, { alpha = false } = {}) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], alpha);
  const p = pix.getPixels();
  const n = alpha ? 4 : 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * n;
      const noise = (x * 7919 + y * 104729) % 40;
      p[i] = y < h / 2 ? 215 + noise : noise;
      p[i + 1] = noise;
      p[i + 2] = y < h / 2 ? noise : 215 + noise;
      if (alpha) p[i + 3] = x < w / 2 ? 255 : 128;
    }
  }
  return pix;
}

async function samplePdf() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const photo = await doc.embedJpg(picture(3000, 2000).asJPEG(95));
  const scan = await doc.embedPng(picture(2400, 1600).asPNG());
  const logo = await doc.embedPng(picture(300, 200, { alpha: true }).asPNG());
  const p1 = doc.addPage([600, 800]);
  p1.drawText("Hello compressed world", { x: 72, y: 740, size: 18, font: helv });
  p1.drawImage(photo, { x: 72, y: 300, width: 450, height: 300 });
  doc.addPage([600, 800]).drawImage(scan, { x: 72, y: 300, width: 450, height: 300 });
  doc.addPage([600, 800]).drawImage(logo, { x: 72, y: 300, width: 300, height: 200 });
  return doc.save();
}

/** Every image XObject as {w, h, filter, smask}. */
function imagesOf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF();
    const out = [];
    for (let num = 1; num < pdf.countObjects(); num++) {
      const d = pdf.newIndirect(num).resolve();
      if (!d.isDictionary() || !d.get("Subtype").isName() || d.get("Subtype").asName() !== "Image") continue;
      out.push({ w: d.get("Width").asNumber(), h: d.get("Height").asNumber(),
        filter: d.get("Filter").isName() ? d.get("Filter").asName() : null, smask: d.get("SMask").isIndirect() });
    }
    return out;
  } finally {
    doc.destroy();
  }
}

function withDoc(bytes, fn) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try { return fn(doc); } finally { doc.destroy(); }
}

test("shrinks big images, keeps text, masks and small images, and the picture the right way up", async () => {
  const original = await samplePdf();

  const result = compressPdf(original);

  assert.ok(result.bytes, "made smaller");
  assert.ok(result.after < result.before / 2, `${result.before} -> ${result.after}`);
  assert.equal(result.images, 2);
  const images = imagesOf(result.bytes);
  const photo = images.find((i) => i.filter === "DCTDecode");
  assert.ok(photo && photo.w === MAX_SIDE && photo.h === Math.round(2000 * MAX_SIDE / 3000), JSON.stringify(photo));
  const scan = images.find((i) => i.filter === "FlateDecode" && !i.smask && i.w !== 300);
  assert.ok(scan && scan.w === MAX_SIDE, `lossless scan resized: ${JSON.stringify(scan)}`);
  assert.ok(images.some((i) => i.smask && i.w === 300 && i.h === 200), "masked logo untouched");

  withDoc(result.bytes, (doc) => {
    assert.equal(doc.countPages(), 3);
    assert.match(doc.loadPage(0).toStructuredText().asText(), /Hello compressed world/);
    // the photo spans y 300..600 (user space) = 200..500 from the top; red on top, blue below
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const at = (x, y) => [...pix.getPixels().slice((y * pix.getWidth() + x) * 3, (y * pix.getWidth() + x) * 3 + 3)];
    const [top, bottom] = [at(300, 230), at(300, 470)];
    assert.ok(top[0] > 180 && top[2] < 80, `top ${top}`);
    assert.ok(bottom[2] > 180 && bottom[0] < 80, `bottom ${bottom}`);
  });
});

test("never returns a bigger file", async () => {
  const once = compressPdf(await samplePdf());
  const twice = compressPdf(once.bytes);
  assert.ok(twice.after <= once.after);
  if (!twice.bytes) assert.equal(twice.after, twice.before);
});

test("rejects files that aren't PDFs", () => {
  assert.throws(() => compressPdf(new TextEncoder().encode("not a pdf")));
});

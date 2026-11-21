import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { imagesToPdf, jpegOrientation } from "../src/image-to-pdf.js";

/** A w×h picture, white with its top quarter red, as PNG or JPEG bytes. */
function picture(w, h, format) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(255);
  const px = pix.getPixels();
  for (let y = 0; y < h / 4; y++) for (let x = 0; x < w; x++) px.set([255, 0, 0], (y * w + x) * 3);
  const bytes = format === "png" ? pix.asPNG() : pix.asJPEG(90, false);
  pix.destroy();
  return Uint8Array.from(bytes);
}

/** The JPEG with an EXIF block saying `orientation`, as a phone would write it. */
function withOrientation(jpeg, orientation) {
  const app1 = [0xff, 0xe1, 0, 34, ..."Exif".split("").map((c) => c.charCodeAt(0)), 0, 0,
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, // big-endian TIFF, IFD at 8
    0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  return Uint8Array.from([...jpeg.slice(0, 2), ...app1, ...jpeg.slice(2)]);
}

/** Page sizes and which side of each rendered page is red. */
function inspect(pdf) {
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  return Array.from({ length: doc.countPages() }, (_, i) => {
    const page = doc.loadPage(i);
    const [, , pw, ph] = page.getBounds();
    const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const [w, h, px] = [pix.getWidth(), pix.getHeight(), pix.getPixels()];
    const red = (x, y) => { const at = (Math.floor(y) * w + Math.floor(x)) * 3; return px[at] > 200 && px[at + 1] < 80; };
    const sides = { top: red(w / 2, 2), bottom: red(w / 2, h - 3), left: red(2, h / 2), right: red(w - 3, h / 2) };
    return { width: Math.round(pw), height: Math.round(ph), red: Object.keys(sides).filter((k) => sides[k]) };
  });
}

test("each picture becomes a page its own shape, upright", async () => {
  const pdf = await imagesToPdf([picture(400, 200, "png"), picture(200, 400, "jpeg")]);
  assert.deepEqual(inspect(pdf), [
    { width: 300, height: 150, red: ["top"] },
    { width: 150, height: 300, red: ["top"] },
  ]);
});

test("big photos are scaled to fit A4's long side", async () => {
  const [page] = inspect(await imagesToPdf([picture(2000, 1000, "jpeg")]));
  assert.equal(page.width, 842);
  assert.equal(page.height, 421);
});

test("a phone photo stored sideways is turned by its EXIF orientation", async () => {
  const jpeg = picture(400, 200, "jpeg");
  assert.equal(jpegOrientation(jpeg), 1);
  assert.equal(jpegOrientation(withOrientation(jpeg, 6)), 6);
  const pages = inspect(await imagesToPdf([3, 6, 8].map((o) => withOrientation(jpeg, o))));
  assert.deepEqual(pages, [
    { width: 300, height: 150, red: ["bottom"] }, // 3: upside down
    { width: 150, height: 300, red: ["right"] }, // 6: top turned to the right
    { width: 150, height: 300, red: ["left"] }, // 8: top turned to the left
  ]);
});

test("refuses bytes that aren't JPEG or PNG", async () => {
  await assert.rejects(imagesToPdf([new TextEncoder().encode("GIF89a")]), /JPEG and PNG/);
});

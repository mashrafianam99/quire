// PDF to Word on the kinds of file that broke it in a sweep of real PDFs: slides with gradients and
// soft masks, beamer's rounded boxes, a bullet set apart from its text, scanned pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import * as mupdf from "mupdf";
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import { unzip } from "../src/docx.js";
import { pdfToDocx } from "../src/pdf-to-docx.js";
import { analyzePdf } from "../src/pdf-layout.js";

v8.setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");

async function partsOf(docx) {
  const entries = unzip(docx);
  const body = new TextDecoder().decode(await entries.get("word/document.xml")());
  const text = [...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  return { entries, body, text };
}

/** Three slides of background art (a zigzag over half the page) with a gradient and/or a box
 * drawn through an alpha soft mask, the way slide makers draw shadows. */
async function artSlides({ gradient, softMask }) {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const shading = ctx.register(ctx.obj({ ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [0, 0, 600, 0], Extend: [true, true],
    Function: { FunctionType: 2, Domain: [0, 1], C0: [0.2, 0.4, 0.9], C1: [0.9, 0.9, 1], N: 1 } }));
  const mask = ctx.register(ctx.stream("0 0 600 800 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 600, 800],
    Group: { S: "Transparency" } }));
  const masked = ctx.register(ctx.obj({ Type: "ExtGState", SMask: { Type: "Mask", S: "Alpha", G: mask } }));
  const zigzag = Array.from({ length: 30 }, (_, i) => `${40 + i * 18} ${i % 2 ? 300 : 700} l`).join(" ");
  for (let n = 1; n <= 3; n++) {
    const page = doc.addPage([600, 800]);
    const res = page.node.Resources();
    res.set(PDFName.of("Shading"), ctx.obj({ Sh0: shading }));
    res.set(PDFName.of("ExtGState"), ctx.obj({ GS0: masked }));
    const art = [gradient && "q /Sh0 sh Q", softMask && "q /GS0 gs 0.5 g 100 100 200 100 re f Q", `q 1 w 40 700 m ${zigzag} S Q`];
    page.node.addContentStream(ctx.register(ctx.stream(art.filter(Boolean).join(" "))));
    page.drawText(`Slide ${n} title`, { x: 72, y: 740, size: 24, font: helv });
  }
  return doc.save();
}

test("slides whose artwork has a gradient convert without corrupting MuPDF's memory", async () => {
  const bytes = await artSlides({ gradient: true });
  // the gradient freed twice shows once it has been garbage collected, on a later conversion
  for (let round = 0; round < 4; round++) {
    const { text } = await partsOf(await pdfToDocx(bytes));
    assert.ok(text.includes("Slide 3 title"), "the slides' text is kept");
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("slides with a shape drawn through a soft mask convert", async () => {
  const { text } = await partsOf(await pdfToDocx(await artSlides({ softMask: true })));
  assert.ok(text.includes("Slide 1 title"));
});

test("a rounded box filled without closing its path (beamer's blocks) keeps its text editable", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 400]);
  // the fill closes the path; its last point isn't its first
  page.drawSvgPath("M 10 0 L 290 0 C 295 0 300 5 300 10 L 300 60 L 0 60 L 0 10", { x: 72, y: 300, color: rgb(0.9, 0.92, 0.95) });
  page.drawText("Small number of oscillations per second.", { x: 82, y: 265, size: 12, font: helv });
  const bytes = await doc.save();

  assert.equal(analyzePdf(bytes).pages[0].images.filter((i) => i.figure).length, 0, "the box isn't a figure");
  const { text } = await partsOf(await pdfToDocx(bytes));
  assert.ok(text.includes("Small number of oscillations per second."), "its text stays text");
});

test("a bullet on a line of its own, followed by its text, converts", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText("• ", { x: 72, y: 700, size: 12, font: helv });
  page.drawText("Tea", { x: 90, y: 692, size: 12, font: helv }); // set lower than its bullet: MuPDF reads two lines
  page.drawText("Milk", { x: 90, y: 678, size: 12, font: helv });
  const { text } = await partsOf(await pdfToDocx(await doc.save()));
  assert.ok(text.includes("Tea") && text.includes("Milk"));
});

test("a picture drawn with no height or width is left out, so Word can open the file", async () => {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  pix.clear(90);
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const png = await doc.embedPng(pix.asPNG());
  page.drawImage(png, { x: 72, y: 600, width: 400, height: 0 }); // a rule drawn as a picture squashed flat
  page.drawImage(png, { x: 72, y: 300, width: 0, height: 200 });
  page.drawImage(png, { x: 72, y: 100, width: 50, height: 50 });
  page.drawText("Some text.", { x: 72, y: 700, size: 12, font: helv });
  const { body } = await partsOf(await pdfToDocx(await doc.save()));

  const extents = [...body.matchAll(/<wp:extent cx="(-?\d+)" cy="(-?\d+)"/g)].map((m) => [+m[1], +m[2]]);
  assert.equal(extents.length, 1, "only the visible picture");
  assert.ok(extents.every(([cx, cy]) => cx > 0 && cy > 0), "Word rejects a picture with a zero or negative size");
});

test("a scanned page comes out as a picture of the page, kept as JPEG so the .docx stays small", async () => {
  const [w, h] = [1240, 1754]; // A4 at 150 dpi
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(235);
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawImage(await doc.embedJpg(pix.asJPEG(90)), { x: 0, y: 0, width: 595, height: 842 });
  const docx = await pdfToDocx(await doc.save());

  const { entries, body } = await partsOf(docx);
  const media = [...entries.keys()].filter((k) => k.startsWith("word/media/"));
  assert.equal(media.length, 1, "one picture");
  assert.match(media[0], /\.jpe?g$/, "as JPEG, not PNG");
  assert.match(body, /<wp:inline/);
  assert.ok(docx.length < 200_000, `${docx.length} bytes`);
});

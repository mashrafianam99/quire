import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFString, StandardFonts, cmyk } from "pdf-lib";
import * as mupdf from "mupdf";
import { toPdfA, srgbProfile, parsePdfDate, standIn, xmpPacket } from "../src/pdfa.js";

const NOW = new Date(Date.UTC(2026, 10, 22, 10, 30, 0));

async function samplePdf({ cmykText = false } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle("Report <draft> & notes");
  doc.setAuthor("Ada");
  doc.setCreationDate(new Date(Date.UTC(2024, 0, 31, 12, 0, 0)));
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRomanBold);
  const page = doc.addPage([600, 800]);
  page.drawText("Hello archive", { x: 72, y: 700, size: 24, font: helv, color: cmykText ? cmyk(0, 1, 1, 0) : undefined });
  page.drawText("Bold title", { x: 72, y: 650, size: 18, font: times });
  page.drawText("αβ", { x: 72, y: 600, size: 18, font: await doc.embedFont(StandardFonts.Symbol) });
  const js = doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('hi')") });
  doc.catalog.set(PDFName.of("OpenAction"), js);
  return doc.save();
}

const open = (bytes) => mupdf.Document.openDocument(bytes, "application/pdf").asPDF();

function simpleFonts(pdf) {
  const out = [];
  for (let n = 1; n < pdf.countObjects(); n++) {
    const d = pdf.newIndirect(n).resolve();
    if (d.isDictionary() && d.get("Type").isName() && d.get("Type").asName() === "Font"
      && d.get("Subtype").asName() === "Type1") out.push(d);
  }
  return out;
}

test("makes a PDF/A-2b: fonts embedded, sRGB output intent, XMP matching the info, no JavaScript", async () => {
  const { bytes, replacedFonts } = toPdfA(await samplePdf(), NOW);
  assert.ok(bytes);
  assert.deepEqual(replacedFonts.sort(), ["Helvetica", "Symbol", "Times-Bold"]);
  const pdf = open(bytes);
  const root = pdf.getTrailer().get("Root");
  assert.ok(root.get("OpenAction").isNull(), "JavaScript open action removed");

  const intent = root.get("OutputIntents", 0);
  assert.equal(intent.get("S").asName(), "GTS_PDFA1");
  assert.equal(intent.get("DestOutputProfile", "N").asNumber(), 3);

  const helv = simpleFonts(pdf).find((f) => f.get("BaseFont").asName() === "Helvetica");
  assert.ok(helv.get("FontDescriptor", "FontFile3").isStream(), "Helvetica embedded");
  assert.equal(helv.get("Widths").length, 256);
  assert.equal(helv.get("Widths", 65).asNumber(), 667, "A is as wide as Helvetica's");
  const symbol = simpleFonts(pdf).find((f) => f.get("BaseFont").asName() === "Symbol");
  assert.equal(symbol.get("Widths", 0x61).asNumber(), 631, "code a is Symbol's alpha");
  assert.equal(symbol.get("FontDescriptor", "Flags").asNumber() & 4, 4, "marked symbolic");

  const meta = root.get("Metadata");
  assert.ok(meta.get("Filter").isNull(), "XMP is left readable");
  const xmp = meta.readStream().asString();
  assert.match(xmp, /<pdfaid:part>2<\/pdfaid:part><pdfaid:conformance>B</);
  assert.match(xmp, /Report &lt;draft&gt; &amp; notes/);
  assert.match(xmp, /<xmp:CreateDate>2024-01-31T12:00:00Z</);
  assert.match(xmp, /<xmp:ModifyDate>2026-11-22T10:30:00Z</);
  const info = pdf.getTrailer().get("Info");
  assert.equal(info.get("Title").asString(), "Report <draft> & notes");
  assert.equal(info.get("ModDate").asString(), "D:20261122103000Z");
  assert.ok(pdf.getTrailer().get("ID").isArray(), "file ID written");

  const text = pdf.loadPage(0).toStructuredText().asText();
  assert.match(text, /Hello archive/);
  assert.match(text, /Bold title/);
});

test("text stays where it was (the stand-in fonts have the same widths)", async () => {
  const before = await samplePdf();
  const after = toPdfA(before, NOW).bytes;
  const lines = (b) => JSON.parse(open(b).loadPage(0).toStructuredText().asJSON()).blocks
    .flatMap((bl) => bl.lines.map((l) => [l.text, Math.round(l.bbox.x), Math.round(l.bbox.y), Math.round(l.bbox.w)]));
  assert.deepEqual(lines(after), lines(before));
});

test("refuses CMYK documents and says why", async () => {
  const result = toPdfA(await samplePdf({ cmykText: true }), NOW);
  assert.equal(result.bytes, null);
  assert.deepEqual(result.problems, ["it uses CMYK (print) colours"]);
});

test("annotations become printable and keep an appearance", async () => {
  const pdf = open(await samplePdf());
  const annot = pdf.loadPage(0).createAnnotation("Square");
  annot.setRect([100, 100, 200, 200]);
  annot.setFlags(mupdf.PDFAnnotation.IS_HIDDEN);
  annot.update();
  const bytes = toPdfA(pdf.saveToBuffer("").asUint8Array(), NOW).bytes;
  const [square] = open(bytes).loadPage(0).getAnnotations();
  assert.equal(square.getFlags(), mupdf.PDFAnnotation.IS_PRINT);
  assert.ok(square.getObject().get("AP", "N").isStream());
});

test("the sRGB profile is a valid ICC profile MuPDF reads as RGB", () => {
  const profile = srgbProfile();
  assert.equal(new DataView(profile.buffer).getUint32(0), profile.length, "size in the header");
  assert.equal(new TextDecoder().decode(profile.slice(36, 40)), "acsp");
  const cs = new mupdf.ColorSpace(profile, "sRGB");
  assert.equal(cs.getType(), "RGB");
  assert.equal(cs.getNumberOfComponents(), 3);
});

test("helpers: PDF dates, stand-in fonts, XMP without optional fields", () => {
  assert.equal(parsePdfDate("D:20240131120000+01'00'").toISOString(), "2024-01-31T11:00:00.000Z");
  assert.equal(parsePdfDate("D:2024").toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(parsePdfDate("garbage"), null);
  assert.equal(standIn("ABCDEF+Arial,Bold"), "Helvetica-Bold");
  assert.equal(standIn("TimesNewRomanPS-ItalicMT"), "Times-Italic");
  assert.equal(standIn("CourierNewPS-BoldItalicMT"), "Courier-BoldOblique");
  assert.equal(standIn("Calibri"), "Helvetica");
  assert.equal(standIn("Georgia-BoldItalic"), "Times-BoldItalic");
  assert.doesNotMatch(xmpPacket({ ModDate: NOW }), /dc:title|CreateDate/);
});

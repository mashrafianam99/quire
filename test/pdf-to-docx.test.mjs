import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { docxToPdf } from "../src/convert.js";
import { unzip } from "../src/docx.js";
import { pdfToDocx } from "../src/pdf-to-docx.js";
import { analyzePdf } from "../src/pdf-layout.js";

const sample = new Uint8Array(readFileSync(new URL("./fixtures/sample.docx", import.meta.url)));

async function partsOf(docx) {
  const entries = unzip(docx);
  const read = async (name) => (entries.has(name) ? new TextDecoder().decode(await entries.get(name)()) : "");
  const body = await read("word/document.xml");
  const footers = (await Promise.all([...entries.keys()].filter((k) => /^word\/footer\d*\.xml$/.test(k)).map(read))).join("");
  const text = [...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  return { body, footers, text };
}

test("PDF to Word keeps headings, lists, pictures, tables with merged and shaded cells, and page breaks", async () => {
  const pdf = await docxToPdf(sample); // heading, list, picture, merged/shaded table, page break, "Page X of Y" footer

  const { body, footers, text } = await partsOf(await pdfToDocx(pdf));

  assert.match(body, /<w:pStyle w:val="Heading\d"\/>[\s\S]*?Sample heading/, "heading");
  for (const words of ["Text with", "bold", "First step", "Second step", "Second page text."]) assert.ok(text.includes(words), words);
  assert.match(body, /<w:b\/>[\s\S]{0,400}?bold/, "bold run");
  assert.match(body, /<w:vertAlign w:val="subscript"\/>/, "subscript");
  assert.equal((body.match(/<wp:inline/g) ?? []).length, 1, "the picture");
  assert.match(body, /<w:tbl>/, "a Word table");
  assert.match(body, /<w:gridSpan w:val="2"\/>/, "cells merged across");
  assert.match(body, /<w:vMerge w:val="restart"\/>/, "cells merged down");
  assert.match(body, /w:fill="dce6f2"/i, "the shaded header row");
  assert.match(body, /<w:pageBreakBefore\/>/, "the page break");
  assert.match(footers, /PAGE/, "the footer's page number is a live field");
  assert.match(footers, /NUMPAGES/, "and so is the page count");
  assert.ok(!/Page \d+ of \d+/.test(text), "the footer isn't repeated as body text");
});

test("a vector diagram becomes one picture, with its labels in it", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText("Before the diagram.", { x: 72, y: 720, size: 12, font: helv });
  page.drawRectangle({ x: 100, y: 500, width: 120, height: 60, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawText("Creator", { x: 130, y: 525, size: 12, font: helv });
  page.drawRectangle({ x: 360, y: 500, width: 120, height: 60, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawText("Product", { x: 390, y: 525, size: 12, font: helv });
  page.drawLine({ start: { x: 220, y: 530 }, end: { x: 360, y: 530 }, thickness: 1 });
  page.drawSvgPath("M 0 0 L 12 -6 L 12 6 Z", { x: 348, y: 270, color: rgb(0, 0, 0) }); // arrowhead (y flipped)
  page.drawLine({ start: { x: 160, y: 500 }, end: { x: 300, y: 420 }, thickness: 1 }); // a slanted connector
  page.drawText("After the diagram.", { x: 72, y: 300, size: 12, font: helv });
  const bytes = await doc.save();

  const { pages } = analyzePdf(bytes);
  assert.equal(pages[0].images.filter((i) => i.figure).length, 1, "one picture for the whole diagram");
  assert.equal(pages[0].tables.length, 0, "the boxes aren't mistaken for a table");

  const { body, text } = await partsOf(await pdfToDocx(bytes));
  assert.ok(text.includes("Before the diagram.") && text.includes("After the diagram."));
  assert.ok(!text.includes("Creator") && !text.includes("Product"), "labels are part of the picture");
  assert.equal((body.match(/<wp:inline/g) ?? []).length, 1);
});

test("a table drawn as rows (no column lines) becomes a Word table", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const rows = [["Pattern", "Purpose"], ["Singleton", "One instance"], ["Builder", "Step by step"]];
  rows.forEach(([a, b], i) => {
    const y = 700 - i * 30;
    const color = i === 0 ? rgb(1, 1, 1) : rgb(0, 0, 0);
    if (i === 0) page.drawRectangle({ x: 72, y: y - 8, width: 400, height: 26, color: rgb(0.24, 0.35, 0.54) });
    page.drawText(a, { x: 80, y, size: 11, font: helv, color });
    page.drawText(b, { x: 240, y, size: 11, font: helv, color });
    page.drawLine({ start: { x: 72, y: y - 9 }, end: { x: 472, y: y - 9 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  });
  const bytes = await doc.save();

  const table = analyzePdf(bytes).pages[0].tables[0];
  assert.ok(table, "found");
  assert.equal(table.xs.length - 1, 2, "two columns");
  assert.ok(table.cells.some((c) => c.row === 0 && c.fill), "the header bar is the first row's shading");

  const { body } = await partsOf(await pdfToDocx(bytes));
  assert.match(body, /<w:tbl>[\s\S]*Singleton[\s\S]*One instance[\s\S]*<\/w:tbl>/);
});

test("a table drawn cell by cell in a rounded frame, with no column lines, keeps its columns", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const grey = rgb(0.89, 0.89, 0.86);
  const [x0, x1, top, r] = [72, 472, 700, 6];
  const cols = [72, 172, 302, 472];
  const rows = [["Family", "Concerned with", "Patterns"], ["Creational", "Creation", "Singleton"],
    ["Structural", "Composition", "Adapter"], ["Behavioral", "Communication", "Observer"]];
  const rowH = 30;
  const bottom = top - rowH * rows.length;
  // the rounded frame's straight sides stop a corner's radius short of each other
  page.drawLine({ start: { x: x0 + r, y: top }, end: { x: x1 - r, y: top }, thickness: 0.7, color: grey });
  page.drawLine({ start: { x: x0 + r, y: bottom }, end: { x: x1 - r, y: bottom }, thickness: 0.7, color: grey });
  page.drawLine({ start: { x: x0, y: top - r }, end: { x: x0, y: bottom + r }, thickness: 0.7, color: grey });
  page.drawLine({ start: { x: x1, y: top - r }, end: { x: x1, y: bottom + r }, thickness: 0.7, color: grey });
  rows.forEach((texts, i) => {
    const y = top - rowH * (i + 1);
    for (let c = 0; c < 3; c++) {
      if (i === 0) page.drawRectangle({ x: cols[c], y, width: cols[c + 1] - cols[c], height: rowH, color: rgb(0.24, 0.35, 0.54) });
      if (i === 2) page.drawRectangle({ x: cols[c], y, width: cols[c + 1] - cols[c], height: rowH, color: rgb(0.97, 0.96, 0.95) });
      // each row line is drawn cell by cell: its pieces meet at the column boundaries
      if (i < rows.length - 1) page.drawLine({ start: { x: cols[c], y }, end: { x: cols[c + 1], y }, thickness: 0.7, color: grey });
      page.drawText(texts[c], { x: cols[c] + 8, y: y + 10, size: 11, font: helv, color: i === 0 ? rgb(1, 1, 1) : rgb(0, 0, 0) });
    }
  });
  const bytes = await doc.save();

  const [table, ...rest] = analyzePdf(bytes).pages[0].tables;
  assert.equal(rest.length, 0, "the header is part of the table, not a box of its own");
  assert.equal(table.xs.length - 1, 3, "three columns");
  assert.equal(table.ys.length - 1, 4, "four rows, the last closed by the frame");
  const textAt = (row, col) => table.cells.find((c) => c.row === row && c.col === col)?.lines.map((l) => l.text).join(" ");
  assert.deepEqual([0, 1, 2, 3].map((row) => [0, 1, 2].map((col) => textAt(row, col))), rows);
  assert.ok(table.cells.find((c) => c.row === 0).fill, "the header keeps its fill");
});

const rounded = (w, h, r) => `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;

test("coloured boxes keep their fill (and accent bar) behind editable text; a highlight in a line isn't a box", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  // a callout: a light rounded box with a 6pt accent bar on its left
  page.drawSvgPath(rounded(400, 60, 6), { x: 72, y: 740, color: rgb(0.93, 0.95, 0.97) });
  page.drawRectangle({ x: 72, y: 680, width: 6, height: 60, color: rgb(0.24, 0.35, 0.54) });
  page.drawText("Callout title", { x: 90, y: 718, size: 11, font: helv });
  page.drawText("Callout body text.", { x: 90, y: 698, size: 11, font: helv });
  // two dark cards side by side with white labels
  for (const [x, label] of [[72, "Creational"], [282, "Structural"]]) {
    page.drawSvgPath(rounded(190, 26, 5), { x, y: 640, color: rgb(0.23, 0.49, 0.45) });
    page.drawText(label, { x: x + 60, y: 623, size: 11, font: helv, color: rgb(1, 1, 1) });
  }
  // a grey highlight behind one word of a sentence
  page.drawRectangle({ x: 150, y: 556, width: 40, height: 16, color: rgb(0.9, 0.9, 0.9) });
  page.drawText("A sentence with a highlighted word inside it.", { x: 72, y: 560, size: 11, font: helv });
  const bytes = await doc.save();

  const boxes = analyzePdf(bytes).pages[0].tables.filter((t) => t.box);
  assert.equal(boxes.length, 2, "the callout and the row of cards");
  const [callout, cards] = boxes.sort((a, b) => a.bbox[1] - b.bbox[1]);
  assert.equal(callout.cells[0].fill, "#edf2f7");
  assert.equal(callout.cells[0].borders.left?.color, "#3d598a", "the accent bar is the left border");
  assert.deepEqual(cards.cells.map((c) => c.lines.map((l) => l.text).join()), ["Creational", "", "Structural"], "one row, with the gap as an empty cell");

  const { body, text } = await partsOf(await pdfToDocx(bytes));
  assert.match(body, /w:fill="edf2f7"[\s\S]*Callout title[\s\S]*Callout body text\./, "callout text sits in its shaded cell");
  assert.match(body, /w:fill="3b7d73"[\s\S]*Creational[\s\S]*Structural/, "white labels keep their dark fill");
  assert.ok(text.includes("A sentence with a highlighted word inside it."), "the highlighted line stays a paragraph");
  assert.ok(!/<w:tbl>(?:(?!<\/w:tbl>)[\s\S])*A sentence/.test(body), "and isn't put in a box");
});

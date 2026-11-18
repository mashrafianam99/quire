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

test("a code listing keeps one paragraph per line, its indentation and blank lines, in a monospace font", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const page = doc.addPage([600, 800]);
  const code = (text, i, x = 72) => page.drawText(text, { x, y: 700 - i * 12, size: 10, font: courier });
  code("public class Main { // a long first line, as wide as the listing gets", 0);
  code("    int x = compute(1, 2, 3);", 1);
  code("    return x;", 2);
  code("y = 2;", 3, 72 + 4 * 6); // indented by position, not by spaces
  code("}", 5); // after a blank line
  page.drawText("Call", { x: 72, y: 600, size: 11, font: helv });
  page.drawRectangle({ x: 96, y: 597, width: 82, height: 13, color: rgb(0.93, 0.93, 0.93) });
  page.drawText("getInstance()", { x: 98, y: 600, size: 10, font: courier });
  page.drawText("once, from any class.", { x: 182, y: 600, size: 11, font: helv });
  const bytes = await doc.save();

  const docx = await pdfToDocx(bytes);
  const { body } = await partsOf(docx);
  const paragraphs = [...body.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p\/>/g)].map((m) => m[0]);
  const textOf = (p) => [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  const lines = paragraphs.map(textOf);
  const at = lines.indexOf("    return x;");
  assert.ok(at > 0, "leading spaces are kept");
  assert.equal(lines[at - 1], "    int x = compute(1, 2, 3);", "each code line is its own paragraph");
  assert.equal(lines[at + 1], "    y = 2;", "an indent by position becomes spaces");
  assert.deepEqual(lines.slice(at + 2, at + 4), ["", "}"], "the blank line survives");
  assert.match(paragraphs[at], /w:ascii="Courier New"/, "an Office monospace font");
  const inline = paragraphs.find((p) => textOf(p).includes("getInstance()"));
  assert.match(inline, /w:fill="ededed"[\s\S]*getInstance\(\)/i, "inline code keeps its grey background");
  assert.match(inline, /w:ascii="Arial"[\s\S]*Call/, "the sentence around it stays in its own font");

  const styles = new TextDecoder().decode(await unzip(docx).get("word/styles.xml")());
  assert.match(styles, /<w:docDefaults>[\s\S]*w:ascii="Arial"[\s\S]*<\/w:docDefaults>/, "empty paragraphs aren't Times New Roman");
});

test("PDF fonts Word doesn't have map to close ones it has; Office fonts keep their name", async () => {
  const { wordFont } = await import("../src/pdf-to-docx.js");
  assert.equal(wordFont({ family: "DejaVu Sans Mono", mono: true }), "Consolas");
  assert.equal(wordFont({ family: "Poppins" }), "Century Gothic");
  assert.equal(wordFont({ family: "Georgia", serif: true }), "Georgia");
  assert.equal(wordFont({ family: "Merriweather", serif: true }), "Cambria");
  assert.equal(wordFont({ family: "Inter" }), "Arial");
});

// a dashed line drawn as one small filled rectangle per dash, each traced back to its start and closed
const dashes = (x0, y0, x1, y1) => {
  const [len, gap, w] = [3.6, 2.4, 1];
  const out = [];
  for (let t = 0; t < Math.hypot(x1 - x0, y1 - y0); t += len + gap) {
    const [x, y] = x0 === x1 ? [x0, y0 + t] : [x0 + t, y0];
    const [dx, dy] = x0 === x1 ? [w, len] : [len, w];
    out.push(`M ${x} ${y} L ${x} ${y + dy} L ${x + dx} ${y + dy} L ${x + dx} ${y} L ${x} ${y} Z`);
  }
  return out.join(" ");
};

test("a UML diagram whose dashed connectors reach bordered class boxes is one picture, not tables", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const black = rgb(0, 0, 0);
  page.drawRectangle({ x: 200, y: 640, width: 100, height: 40, borderColor: black, borderWidth: 1 });
  page.drawText("Factory", { x: 225, y: 655, size: 10, font: helv });
  // inheritance triangle under the interface, then dashed lines down to the two classes (SVG y runs down from y 800)
  page.drawSvgPath("M 250 160 L 244 172 L 256 172 Z", { x: 0, y: 800, color: rgb(1, 1, 1), borderColor: black, borderWidth: 1 });
  page.drawSvgPath([dashes(250, 172, 250, 190), dashes(150, 190, 350, 190), dashes(150, 190, 150, 250), dashes(350, 190, 350, 250)].join(" "),
    { x: 0, y: 800, color: black });
  for (const [x, name] of [[105, "WinFactory"], [305, "MacFactory"]]) {
    page.drawRectangle({ x, y: 500, width: 90, height: 50, borderColor: black, borderWidth: 1 });
    page.drawLine({ start: { x, y: 532 }, end: { x: x + 90, y: 532 }, thickness: 1 });
    page.drawText(name, { x: x + 10, y: 538, size: 9, font: helv });
    page.drawText("+ create()", { x: x + 10, y: 515, size: 9, font: helv });
  }
  const bytes = await doc.save();

  const { pages } = analyzePdf(bytes);
  assert.equal(pages[0].images.filter((i) => i.figure).length, 1, "one picture for the whole diagram");
  assert.equal(pages[0].tables.length, 0, "the class boxes aren't tables");
  assert.ok(!pages[0].lines.some((l) => /Factory/.test(l.text)), "the class names are in the picture");
});

test("drawn bullet dots become a Word list, and a white letter on a round badge keeps the badge's colour", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const ink = rgb(0.2, 0.2, 0.2);
  page.drawCircle({ x: 79, y: 704, size: 7, color: rgb(0.24, 0.35, 0.54) });
  page.drawText("D", { x: 75.5, y: 700, size: 9, font: helv, color: rgb(1, 1, 1) });
  page.drawText("DEFINITION", { x: 92, y: 700, size: 9, font: helv, color: rgb(0.24, 0.35, 0.54) });
  for (const [i, item] of ["One object of a class is needed.", "You need stricter control."].entries()) {
    const y = 660 - i * 24;
    page.drawCircle({ x: 76, y: y + 4, size: 1.9, color: ink });
    page.drawText(item, { x: 86, y, size: 12, font: helv, color: ink });
  }
  const bytes = await doc.save();

  const { body, text } = await partsOf(await pdfToDocx(bytes));
  assert.equal((body.match(/<w:numPr>/g) ?? []).length, 2, "both items are bullets");
  assert.ok(text.includes("One object of a class is needed.") && !text.includes("•"), "the mark is Word's, not typed");
  assert.match(body, /<w:shd [^>]*w:fill="3d5.8a"[^>]*\/>[\s\S]{0,300}?<w:t[^>]*>D<\/w:t>/i, "the badge letter is shaded");
});

test("tables one under another stay separate tables in Word", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const grid = (x, y, w, cols) => {
    for (const dy of [0, 20, 40]) page.drawLine({ start: { x, y: y - dy }, end: { x: x + w, y: y - dy }, thickness: 1 });
    for (let c = 0; c <= cols; c++) page.drawLine({ start: { x: x + (c * w) / cols, y }, end: { x: x + (c * w) / cols, y: y - 40 }, thickness: 1 });
    for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) page.drawText(`r${r}c${c}`, { x: x + (c * w) / cols + 4, y: y - 14 - r * 20, size: 9, font: helv });
  };
  grid(72, 700, 200, 2);
  grid(72, 655, 300, 3); // 5pt below the first, a different width
  const { body } = await partsOf(await pdfToDocx(await doc.save()));
  assert.equal((body.match(/<w:tbl>/g) ?? []).length, 2);
  assert.doesNotMatch(body, /<\/w:tbl><w:tbl>/, "a paragraph between them, or Word merges them");
});

test("a heading whose rule lines up with a ruled table's rows isn't pulled into the table", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const rule = (y) => page.drawLine({ start: { x: 72, y }, end: { x: 472, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  [["Pattern", "Purpose"], ["Singleton", "One instance"], ["Builder", "Step by step"]].forEach(([a, b], i) => {
    page.drawText(a, { x: 80, y: 700 - i * 30, size: 11, font: helv });
    page.drawText(b, { x: 240, y: 700 - i * 30, size: 11, font: helv });
    rule(700 - i * 30 + 21);
  });
  rule(631);
  page.drawText("3 Factory Method", { x: 80, y: 590, size: 16, font: helv });
  rule(580); // the heading's underline, as wide as the table
  const { pages } = analyzePdf(await doc.save());
  assert.ok(pages[0].lines.some((l) => l.text === "3 Factory Method"), "the heading is free text");
  assert.ok(pages[0].tables.every((t) => t.bbox[3] < 600), "the table ends above it");
});

/** A PDF of 600x800 pages; `lines[p]` is how many body lines page p has (from the top), and
 * `footer(p)` the footer text of page p, if any. */
async function pagedPdf(lines, footer = () => null) {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((n, p) => {
    const page = doc.addPage([600, 800]);
    for (let i = 0; i < n; i++) page.drawText(`Line ${i + 1} of page ${p + 1}.`, { x: 72, y: 720 - i * 16, size: 11, font: helv });
    const text = footer(p);
    if (text) page.drawText(text, { x: 72, y: 30, size: 9, font: helv });
  });
  return doc.save();
}

test("an unnumbered cover: the footer's page number starts at 1 on page 2, and the cover has no footer", async () => {
  const bytes = await pagedPdf([3, 40, 40], (p) => (p ? `Page ${p} of 2` : null));

  const { body, footers, text } = await partsOf(await pdfToDocx(bytes));

  assert.match(footers, /PAGE/, "a live page number");
  assert.match(footers, /SECTIONPAGES/, "counting the numbered pages only");
  assert.ok(!text.includes("Page 1 of 2"), "not the literal text");
  const sections = body.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g);
  assert.equal(sections.length, 2, "the cover is a section of its own");
  assert.ok(!/footerReference/.test(sections[0]), "without a footer");
  assert.match(sections[1], /<w:pgNumType w:start="1"\/>/, "numbering starts at 1 after it");
});

test("full pages flow on; a page that ended early keeps its page break", async () => {
  const bytes = await pagedPdf([40, 15, 40]);

  const { body } = await partsOf(await pdfToDocx(bytes));

  const breaks = [...body.matchAll(/<w:pageBreakBefore\/>[\s\S]*?<w:t[^>]*>(Line \d+ of page \d+\.)/g)].map((m) => m[1]);
  assert.deepEqual(breaks, ["Line 1 of page 3."], "page 2 flows on from page 1; page 3 starts fresh");
});

/** Draws pieces [text, font, size] one after another on a line; returns where it ends. */
function drawRun(page, pieces, x, y) {
  for (const [text, font, size] of pieces) {
    page.drawText(text, { x, y, size, font });
    x += font.widthOfTextAtSize(text, size);
  }
  return x;
}

test("lines drawn one by one, each a block of its own, still join into their paragraph, inline code and all", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const page = doc.addPage([600, 800]);
  const full = "We have remote controls and devices, and every remote works with every device we";
  // lines 20pt apart: MuPDF puts each in a block of its own
  page.drawText(full, { x: 72, y: 700, size: 11, font: helv });
  // the next line holds more code (in a smaller font) than prose, and is about as wide as the first
  drawRun(page, [["need ", helv, 11], ["TVRemote", courier, 9], [", ", helv, 11], ["RadioRemote", courier, 9], [", ", helv, 11],
    ["TVPhoneRemote", courier, 9], [", ", helv, 11], ["RadioPhoneRemote", courier, 9], [" and more like them", helv, 11]], 72, 680);
  page.drawText("so on.", { x: 72, y: 660, size: 11, font: helv });
  page.drawText("A short line of its own.", { x: 72, y: 620, size: 11, font: helv });
  const bytes = await doc.save();

  const { body } = await partsOf(await pdfToDocx(bytes));
  const paras = body.match(/<w:p>[\s\S]*?<\/w:p>/g).map((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)</g)].map((m) => m[1]).join(""));
  const joined = paras.find((p) => p.startsWith("We have remote"));
  assert.ok(joined?.includes("need") && joined.includes("so on."), "the three lines are one paragraph");
  assert.ok(paras.includes("A short line of its own."), "the paragraph after a gap stays apart");
});

test("inline code pills on two lines aren't a diagram, and small print next to a diagram is part of it", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const page = doc.addPage([600, 800]);
  // two lines of prose, each with two grey rounded pills behind code words
  for (const y of [700, 685]) {
    let x = drawRun(page, [["Java has ", helv, 11]], 72, y);
    for (const word of ["java.util.Iterator", "hasNext()"]) {
      page.drawSvgPath(rounded(courier.widthOfTextAtSize(word, 9) + 6, 12, 3), { x: x - 3, y: y + 9, color: rgb(0.95, 0.94, 0.92) });
      x = drawRun(page, [[word, courier, 9], [" and ", helv, 11]], x, y);
    }
  }
  // a diagram: two boxes and a slanted connector, with a small-print note 6pt above it
  page.drawRectangle({ x: 100, y: 400, width: 120, height: 60, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawRectangle({ x: 360, y: 400, width: 120, height: 60, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawLine({ start: { x: 220, y: 430 }, end: { x: 360, y: 450 }, thickness: 1 });
  page.drawText("each handler passes it on", { x: 180, y: 466, size: 6, font: helv });
  for (let i = 0; i < 4; i++) page.drawText("Body text in the usual size, under the diagram.", { x: 72, y: 300 - i * 15, size: 11, font: helv });
  const bytes = await doc.save();

  const { pages } = analyzePdf(bytes);
  const figures = pages[0].images.filter((i) => i.figure);
  assert.equal(figures.length, 1, "only the diagram is a picture");
  assert.ok(pages[0].lines.some((l) => l.text.includes("java.util.Iterator")), "the code words stay text");
  assert.ok(!pages[0].lines.some((l) => l.text.includes("each handler")), "the note is in the diagram's picture");
});

test("a header bar drawn as cells over one row line gives a framed table its columns", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const grey = rgb(0.89, 0.89, 0.86);
  const cols = [72, 222, 372, 522];
  const [top, mid, bottom] = [700, 674, 600];
  page.drawRectangle({ x: 72, y: bottom, width: 450, height: top - bottom, borderColor: grey, borderWidth: 0.7 });
  for (let c = 0; c < 3; c++) {
    page.drawRectangle({ x: cols[c], y: mid, width: 150, height: top - mid, color: rgb(0.24, 0.35, 0.54) });
    page.drawLine({ start: { x: cols[c], y: mid }, end: { x: cols[c + 1], y: mid }, thickness: 0.7, color: grey });
    page.drawText(["Creational", "Structural", "Behavioral"][c], { x: cols[c] + 8, y: mid + 9, size: 11, font: helv, color: rgb(1, 1, 1) });
    ["One", "Two", "Three"].forEach((t, i) => page.drawText(`${t} ${c + 1}`, { x: cols[c] + 8, y: mid - 18 - i * 15, size: 11, font: helv }));
  }
  const bytes = await doc.save();

  const table = analyzePdf(bytes).pages[0].tables.find((t) => !t.box);
  assert.equal(table.xs.length - 1, 3, "three columns");
  assert.ok(table.cells.filter((c) => c.row === 0).every((c) => c.fill), "each header cell keeps its fill");
  assert.deepEqual(table.cells.filter((c) => c.row === 1).map((c) => c.lines.length), [3, 3, 3], "each list in its own column");
});

test("a zebra table the page cuts off keeps its last row, and a heading's rule just over it isn't a row", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const grey = rgb(0.89, 0.89, 0.86);
  page.drawText("Comparison", { x: 72, y: 250, size: 14, font: helv });
  page.drawLine({ start: { x: 72, y: 240 }, end: { x: 522, y: 240 }, thickness: 0.8, color: grey });
  // the frame's sides run on to the page's edge: the table goes on over the page
  page.drawRectangle({ x: 71, y: 0, width: 4, height: 232, color: grey });
  page.drawRectangle({ x: 519, y: 0, width: 4, height: 232, color: grey });
  const rows = [["Pattern", "Key idea"], ["Observer", "Subscribe and notify"], ["State", "One class per state"], ["Strategy", "Swap algorithms"]];
  rows.forEach(([a, b], i) => {
    const y = 232 - (i + 1) * 26;
    const color = i ? rgb(0, 0, 0) : rgb(1, 1, 1);
    if (i === 0) page.drawRectangle({ x: 75, y, width: 444, height: 26, color: rgb(0.24, 0.35, 0.54) });
    page.drawText(a, { x: 84, y: y + 9, size: 11, font: helv, color });
    page.drawText(b, { x: 240, y: y + 9, size: 11, font: helv, color });
    if (i < rows.length - 1) page.drawLine({ start: { x: 75, y }, end: { x: 519, y }, thickness: 0.7, color: grey });
  });
  const bytes = await doc.save();

  const table = analyzePdf(bytes).pages[0].tables.find((t) => !t.box);
  assert.ok(table.cells.some((c) => c.lines.some((l) => l.text === "Strategy")), "the last row is in the table");
  assert.equal(table.cells.find((c) => c.row === 0 && c.col === 0).lines[0]?.text, "Pattern", "the header bar is the first row");
});

test("Word rows take their text's height, header rows and headings keep with what follows, short rows stay whole", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([600, 800]);
  page.drawText("Patterns", { x: 72, y: 740, size: 20, font: bold });
  const rows = [["Pattern", "Purpose"], ["Singleton", "One instance"], ["Builder", "Step by step"]];
  rows.forEach(([a, b], i) => {
    const y = 700 - i * 40; // rows much taller than their text
    if (i === 0) page.drawRectangle({ x: 72, y: y - 8, width: 400, height: 26, color: rgb(0.24, 0.35, 0.54) });
    page.drawText(a, { x: 80, y, size: 11, font: helv });
    page.drawText(b, { x: 240, y, size: 11, font: helv });
    page.drawLine({ start: { x: 72, y: y - 9 }, end: { x: 472, y: y - 9 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  });
  for (let i = 0; i < 12; i++) page.drawText(`Body line ${i + 1} of the page, in the usual size.`, { x: 72, y: 560 - i * 15, size: 11, font: helv });

  const { body } = await partsOf(await pdfToDocx(await doc.save()));
  assert.ok(!/<w:trHeight/.test(body), "no fixed row heights");
  assert.match(body, /<w:cantSplit\/>/, "short rows don't break across pages");
  assert.match(body.match(/<w:tr>[\s\S]*?<\/w:tr>/)[0], /<w:keepNext\/>[\s\S]*Pattern/, "the header row stays with the next row");
  assert.match(body, /<w:pStyle w:val="Heading\d"\/><w:keepNext\/>|<w:keepNext\/>(?:(?!<\/w:pPr>)[\s\S])*<w:pStyle w:val="Heading\d"\/>/, "a heading stays with what follows");
  const margins = [...body.matchAll(/<w:tcMar><w:top w:type="dxa" w:w="(\d+)"\/>[\s\S]*?<w:bottom w:type="dxa" w:w="(\d+)"\/>/g)];
  assert.ok(margins.length && margins.every(([, t, b]) => Number(b) <= Number(t)), "the room under a cell's text isn't padding");
});

test("a running header's left and right pieces share one line, set by tab stops", async () => {
  const doc = await PDFDocument.load(await pagedPdf([20, 20, 20]));
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (const page of doc.getPages()) {
    page.drawText("CSE 417 - Software Engineering", { x: 72, y: 770, size: 8, font: helv });
    page.drawText("Part 2", { x: 290 - helv.widthOfTextAtSize("Part 2", 8), y: 770, size: 8, font: helv });
  }
  const entries = unzip(await pdfToDocx(await doc.save()));
  const header = (await Promise.all([...entries.keys()].filter((k) => /^word\/header\d*\.xml$/.test(k))
    .map(async (k) => new TextDecoder().decode(await entries.get(k)())))).join("");
  const paras = header.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
  assert.equal(paras.length, 1, "one paragraph");
  assert.match(paras[0], /CSE 417[\s\S]*<w:tab\/>[\s\S]*Part 2/, "the right piece after a tab");
  assert.match(paras[0], /<w:tab w:val="right"/, "at a right tab stop");
});

test("a page left short only because the next page's picture didn't fit there flows on in Word", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const lines = (page, n) => { for (let i = 0; i < n; i++) page.drawText(`Line ${i + 1} of text.`, { x: 72, y: 720 - i * 16, size: 11, font: helv }); };
  lines(doc.addPage([600, 800]), 40);
  lines(doc.addPage([600, 800]), 30); // ends about 250pt above the bottom
  const third = doc.addPage([600, 800]);
  // a 290pt-tall diagram first: it couldn't fit in the room left above
  third.drawRectangle({ x: 100, y: 440, width: 120, height: 290, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  third.drawRectangle({ x: 360, y: 440, width: 120, height: 290, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  third.drawLine({ start: { x: 220, y: 600 }, end: { x: 360, y: 640 }, thickness: 1 });
  third.drawText("After the figure.", { x: 72, y: 400, size: 11, font: helv });

  const { body } = await partsOf(await pdfToDocx(await doc.save()));
  assert.ok(!/<w:pageBreakBefore\/>/.test(body), "no forced page break before the picture");
});

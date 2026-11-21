import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as mupdf from "mupdf";
import { diffWords, compareDocuments, buildReport } from "../src/compare.js";

const ops = (a, b) => diffWords(a, b).map(({ op, a: i, b: j }) => `${op}${op === "+" ? b[j] : a[i]}`).join(" ");

test("the word diff keeps what's shared and marks what was removed or added", () => {
  assert.equal(ops(["a", "b", "c"], ["a", "x", "c"]), "=a -b +x =c");
  assert.equal(ops(["a", "b"], ["a", "b", "c", "d"]), "=a =b +c +d");
  assert.equal(ops(["x", "a", "b"], ["a", "b"]), "-x =a =b");
  assert.equal(ops([], ["a"]), "+a");
  assert.equal(ops(["a"], []), "-a");
});

test("the word diff copes with long documents and finds the one change in the middle", () => {
  const a = Array.from({ length: 20000 }, (_, i) => `w${i}`);
  const b = [...a.slice(0, 10000), "new", ...a.slice(10001)];
  const changes = diffWords(a, b).filter((d) => d.op !== "=");
  assert.deepEqual(changes.map((d) => d.op === "+" ? `+${b[d.b]}` : `-${a[d.a]}`), ["-w10000", "+new"]);
});

/** Pages of 12pt Helvetica lines (user space y from the top margin down). */
async function textPdf(pages, { square } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([600, 800]);
    lines.forEach((t, i) => page.drawText(t, { x: 72, y: 720 - i * 18, size: 12, font }));
    if (square) page.drawRectangle({ x: 400, y: 100, width: 120, height: 120, color: square });
  }
  return doc.save();
}

const LINES = ["Quire compares two versions of a document.", "It marks what was removed and added.", "Pictures that change are marked too."];

test("identical documents have no changes", async () => {
  const bytes = await textPdf([LINES, LINES]);
  const result = await compareDocuments(bytes, bytes);
  assert.equal(result.removed, 0);
  assert.equal(result.added, 0);
  assert.deepEqual(result.changes, []);
  assert.ok(result.pairs.every((p) => !p.old.removed.length && !p.new.added.length && !p.visual.length));
});

test("a changed word is marked where it is on each side", async () => {
  const before = await textPdf([LINES]);
  const after = await textPdf([[LINES[0], "It marks what was deleted and added.", LINES[2]]]);
  const result = await compareDocuments(before, after);
  assert.equal(result.removed, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(result.changes.map((c) => [c.removed, c.added]), [["removed", "deleted"]]);
  const [pair] = result.pairs;
  const [old] = pair.old.removed, [now] = pair.new.added;
  // the second line: baseline y = 720 - 18 = 702 in user space, so ≈ 98 from the top of the page
  for (const r of [old, now]) assert.ok(r[1] < 98 && r[3] > 90, `on the second line: ${r.map(Math.round)}`);
  assert.ok(Math.abs(old[0] - 171.4) < 3, `starts after “It marks what was ” (x ≈ 171.4): ${old[0]}`);
});

test("text pushed onto the next page isn't a change, only what was really added", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Line number ${i + 1} of the text.`);
  const before = await textPdf([filler.slice(0, 20), filler.slice(20)]);
  const after = await textPdf([["A brand new opening line.", ...filler.slice(0, 19)], filler.slice(19)]);
  const result = await compareDocuments(before, after);
  assert.equal(result.removed, 0);
  assert.equal(result.added, 5, "only “A brand new opening line.”");
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].added, "A brand new opening line.");
});

test("a picture that changes, with the same text, is marked as a visual change", async () => {
  const before = await textPdf([LINES], { square: rgb(0.1, 0.4, 0.8) });
  const after = await textPdf([LINES], { square: rgb(0.9, 0.2, 0.1) });
  const result = await compareDocuments(before, after);
  assert.equal(result.added + result.removed, 0);
  const [box] = result.pairs[0].visual;
  assert.ok(box, "a visual change");
  // the square: x 400–520, y (from the top) 580–700
  assert.ok(box[0] >= 390 && box[2] <= 530 && box[1] >= 570 && box[3] <= 710, `around the square: ${box.map(Math.round)}`);
});

test("pages added in the new version pair with nothing on the old side", async () => {
  const before = await textPdf([LINES]);
  const after = await textPdf([LINES, ["An entirely new page of text."]]);
  const result = await compareDocuments(before, after);
  assert.deepEqual(result.pairs.map((p) => [p.old.index, p.new.index]), [[0, 0], [null, 1]]);
});

test("the report has a summary page and the two versions side by side", async () => {
  const before = await textPdf([LINES, LINES]);
  const after = await textPdf([[LINES[0], "It marks what was deleted and added.", LINES[2]], LINES]);
  const report = await buildReport(before, after, await compareDocuments(before, after), { oldName: "v1.pdf", newName: "v2.pdf" });
  const doc = mupdf.Document.openDocument(report, "application/pdf");
  assert.equal(doc.countPages(), 3, "summary + 2 pairs");
  const summary = doc.loadPage(0).toStructuredText().asText();
  for (const s of ["v1.pdf", "v2.pdf", "1 word removed", "1 word added", "removed", "deleted"]) assert.ok(summary.includes(s), `summary mentions ${s}`);
  const [, , w, h] = doc.loadPage(1).getBounds();
  assert.ok(w > h, "side by side: wider than tall");
  const sideBySide = doc.loadPage(1).toStructuredText().asText();
  assert.equal(sideBySide.split("Quire compares two versions").length - 1, 2, "both pages copied as pages, their text selectable");
});

test("a turned page is pictured in the report, the right way up", async () => {
  const make = async (word) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    page.drawText(`A ${word} page`, { x: 72, y: 720, size: 12, font });
    page.setRotation({ type: "degrees", angle: 90 });
    return doc.save();
  };
  const [before, after] = [await make("first"), await make("second")];
  const result = await compareDocuments(before, after);
  assert.deepEqual(result.changes.map((c) => [c.removed, c.added]), [["first", "second"]]);
  const report = mupdf.Document.openDocument(await buildReport(before, after, result, { oldName: "a", newName: "b" }), "application/pdf");
  const [, , w, h] = report.loadPage(1).getBounds();
  assert.ok(w > h * 1.8, "two landscape pages side by side");
});

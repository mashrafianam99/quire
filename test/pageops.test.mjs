import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  applyPageOrder, deletePages, rotatePages, extractPages, mergePdfs,
} from "../src/pageops.js";

// Page widths double as page IDs: page i is (100 + i) points wide.
async function makePdf(n, base = 100) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([base + i, 200]);
  return doc.save();
}
async function widths(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getWidth());
}

test("applyPageOrder reorders and drops pages", async () => {
  const out = await applyPageOrder(await makePdf(3), [2, 0]);
  assert.deepEqual(await widths(out), [102, 100]);
});

test("applyPageOrder rejects duplicates and bad indices", async () => {
  const pdf = await makePdf(3);
  await assert.rejects(applyPageOrder(pdf, [0, 0]), /only once/);
  await assert.rejects(applyPageOrder(pdf, [3]), /out of range/);
  await assert.rejects(applyPageOrder(pdf, []), /at least one/);
});

test("deletePages removes pages but never all of them", async () => {
  const pdf = await makePdf(3);
  assert.deepEqual(await widths(await deletePages(pdf, [1])), [100, 102]);
  await assert.rejects(deletePages(pdf, [0, 1, 2]), /at least one page/);
});

test("rotatePages adds rotation and wraps around 360", async () => {
  const pdf = await makePdf(2);
  const once = await rotatePages(pdf, [0], -90);
  const doc = await PDFDocument.load(await rotatePages(once, [0, 1], 180));
  assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [90, 180]);
  await assert.rejects(rotatePages(pdf, [0], 45), /multiple of 90/);
});

test("extractPages builds a new PDF from chosen pages", async () => {
  const out = await extractPages(await makePdf(4), [3, 1]);
  assert.deepEqual(await widths(out), [103, 101]);
});

test("mergePdfs concatenates in order", async () => {
  const out = await mergePdfs([await makePdf(2, 100), await makePdf(1, 300)]);
  assert.deepEqual(await widths(out), [100, 101, 300]);
  await assert.rejects(mergePdfs([]), /Nothing to merge/);
});

test("input bytes are not mutated", async () => {
  const pdf = await makePdf(2);
  const copy = pdf.slice();
  await rotatePages(pdf, [0], 90);
  assert.deepEqual(pdf, copy);
});

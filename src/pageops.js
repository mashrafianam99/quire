// Page-level edits on raw PDF bytes, using pdf-lib. Every function takes bytes and
// returns new bytes, so the caller's copy is never mutated.
import { PDFDocument, degrees } from "pdf-lib";

async function load(bytes) {
  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    if (err?.constructor?.name === "EncryptedPDFError") {
      throw new Error("Page tools can't edit password-protected PDFs yet.");
    }
    throw err;
  }
}

function checkIndices(indices, pageCount, { unique = true } = {}) {
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error("Select at least one page.");
  }
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= pageCount) {
      throw new Error(`Page index ${i} is out of range.`);
    }
  }
  if (unique && new Set(indices).size !== indices.length) {
    throw new Error("Each page may appear only once.");
  }
}

/** Keep only `order` pages, in that order. Edits in place so forms and outlines survive. */
export async function applyPageOrder(bytes, order) {
  const doc = await load(bytes);
  checkIndices(order, doc.getPageCount());
  const pages = doc.getPages();
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  for (const i of order) doc.addPage(pages[i]);
  return doc.save();
}

export async function deletePages(bytes, indices) {
  const doc = await load(bytes);
  const count = doc.getPageCount();
  checkIndices(indices, count);
  const drop = new Set(indices);
  if (drop.size === count) throw new Error("A PDF must keep at least one page.");
  const keep = [...Array(count).keys()].filter((i) => !drop.has(i));
  return applyPageOrder(bytes, keep);
}

/** Rotate pages by `delta` degrees (a multiple of 90). */
export async function rotatePages(bytes, indices, delta) {
  if (delta % 90 !== 0) throw new Error("Rotation must be a multiple of 90°.");
  const doc = await load(bytes);
  checkIndices(indices, doc.getPageCount());
  for (const i of indices) {
    const page = doc.getPage(i);
    const next = (((page.getRotation().angle + delta) % 360) + 360) % 360;
    page.setRotation(degrees(next));
  }
  return doc.save();
}

/** Copy the chosen pages into a brand-new PDF. */
export async function extractPages(bytes, indices) {
  const src = await load(bytes);
  checkIndices(indices, src.getPageCount(), { unique: false });
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(src, indices)) out.addPage(page);
  return out.save();
}

/** Join several PDFs, in order, into one. */
export async function mergePdfs(list) {
  if (!list?.length) throw new Error("Nothing to merge.");
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const src = await load(bytes);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return out.save();
}

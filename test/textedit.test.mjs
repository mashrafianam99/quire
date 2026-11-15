import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as mupdf from "mupdf";
import { findParagraph, replaceParagraph, wrapText } from "../src/textedit-pdf.js";

const near = (a, b, tol = 1) => Math.abs(a - b) < tol;

async function samplePdf({ rotate = 0 } = {}) {
  const doc = await PDFDocument.create();
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.setRotation(degrees(rotate));
  page.drawText("Hello wonderful world", { x: 72, y: 700, size: 18, font: times, color: rgb(0.8, 0.1, 0.1) });
  page.drawText("Second line stays", { x: 72, y: 660, size: 12, font: helv });
  return doc.save();
}

/** Every line of page 1 as {text, x (left), y (baseline), right, font}, in PDF user space. */
function linesOf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const page = doc.loadPage(0);
    const toUser = mupdf.Matrix.invert(page.getTransform());
    const out = [];
    let cur;
    page.toStructuredText("preserve-whitespace").walk({
      beginLine() { cur = { text: "", fonts: new Set() }; },
      onChar(c, origin, font, size, quad) {
        if (!cur.text) {
          const [a, b, , , e, f] = toUser;
          cur.x = origin[0] * a + origin[1] * toUser[2] + e;
          cur.y = origin[0] * b + origin[1] * toUser[3] + f;
        }
        cur.text += c;
        cur.right = Math.max(cur.right ?? -Infinity, quad[2]);
        cur.fonts.add(font.getName());
      },
      endLine() { out.push(cur); },
    });
    return out;
  } finally {
    doc.destroy();
  }
}

function rawText(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try { return Buffer.from(doc.asPDF().saveToBuffer("decompress").asUint8Array()).toString("latin1"); }
  finally { doc.destroy(); }
}

// ---------- single lines ----------

test("finds the clicked line with its style and caret position", async () => {
  const para = findParagraph(await samplePdf(), 0, [130, 705]); // inside "wonderful"

  assert.equal(para.text, "Hello wonderful world");
  assert.equal(para.lineCount, 1);
  assert.ok(near(para.size, 18, 0.5));
  assert.equal(para.font.family, "serif");
  assert.ok(para.color[0] > 0.7 && para.color[1] < 0.2);
  assert.ok(para.caret > 6 && para.caret < 15, `caret ${para.caret} should be inside "wonderful"`);
});

test("returns null where there is no text", async () => {
  assert.equal(findParagraph(await samplePdf(), 0, [400, 300]), null);
});

for (const rotate of [0, 90]) {
  test(`replaces only that line, in place (page rotated ${rotate}°)`, async () => {
    const original = await samplePdf({ rotate });
    const para = findParagraph(original, 0, [130, 705]);

    const { bytes } = await replaceParagraph(original, para, "Hello brave new world");

    const lines = linesOf(bytes);
    const edited = lines.find((l) => l.text.startsWith("Hello"));
    assert.equal(edited.text, "Hello brave new world");
    assert.ok(near(edited.x, 72) && near(edited.y, 700), `at ${edited.x},${edited.y}`);
    assert.ok(lines.some((l) => l.text === "Second line stays"));
    assert.doesNotMatch(rawText(bytes), /wonderful/);
  });
}

test("rejects characters no available font can draw", async () => {
  const original = await samplePdf();
  const para = findParagraph(original, 0, [130, 705]);
  await assert.rejects(() => replaceParagraph(original, para, "Hello 世界"), /can't be typed here yet: 世界/);
});

test("judges the font by its name, not MuPDF's serif flag", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.drawText("Bold heading", { x: 72, y: 700, size: 18, font: await doc.embedFont(StandardFonts.HelveticaBold) });
  page.drawText("code line", { x: 72, y: 660, size: 12, font: await doc.embedFont(StandardFonts.Courier) });
  const bytes = await doc.save();

  const heading = findParagraph(bytes, 0, [100, 705]);
  assert.equal(heading.font.family, "sans");
  assert.equal(heading.font.bold, true);
  assert.equal(findParagraph(bytes, 0, [90, 663]).font.family, "mono");
});

// ---------- paragraphs ----------

const BODY = "Quire edits real PDF text. Click any line of a paragraph and the whole paragraph "
  + "opens for editing, then it is wrapped again to fit the column it came from.";
const ITEM = "• First item that is long enough to wrap onto a second line of the column, like real lists do.";
const COLUMN = 300;

/** A heading, a wrapped paragraph, a short paragraph, and a wrapped list item, like a word processor lays them out. */
async function paragraphPdf({ nextGap = 40 } = {}) {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([600, 800]);
  const width = (t) => helv.widthOfTextAtSize(t, 12);
  page.drawText("A bold heading", { x: 72, y: 720, size: 16, font: bold });
  const body = wrapText(BODY, () => COLUMN, width);
  body.forEach((t, i) => page.drawText(t, { x: 72, y: 690 - i * 15, size: 12, font: helv }));
  const nextY = 690 - (body.length - 1) * 15 - nextGap;
  page.drawText("Short closing line.", { x: 72, y: nextY, size: 12, font: helv });
  page.drawText("Next paragraph.", { x: 72, y: nextY - 15, size: 12, font: helv });
  const item = wrapText(ITEM, (i) => (i ? COLUMN - 10 : COLUMN), width);
  item.forEach((t, i) => page.drawText(t, { x: i ? 82 : 72, y: nextY - 45 - i * 15, size: 12, font: helv }));
  return { bytes: await doc.save(), body, item, nextY };
}

test("groups a paragraph's lines, without the heading or the next paragraph", async () => {
  const { bytes, body } = await paragraphPdf();
  assert.ok(body.length >= 3);
  const para = findParagraph(bytes, 0, [150, 678]); // second line

  assert.equal(para.lineCount, body.length);
  assert.equal(para.text, BODY);
  assert.ok(para.caret > body[0].length && para.caret < body[0].length + 1 + body[1].length, `caret ${para.caret}`);
});

test("a short line ends its paragraph even when the next line is equally spaced", async () => {
  const { bytes, nextY } = await paragraphPdf();
  assert.equal(findParagraph(bytes, 0, [90, nextY + 3]).text, "Short closing line.");
  assert.equal(findParagraph(bytes, 0, [90, nextY - 12]).text, "Next paragraph.");
});

test("a list item is its own paragraph, with its hanging line", async () => {
  const { bytes, item, nextY } = await paragraphPdf();
  const para = findParagraph(bytes, 0, [150, nextY - 45 - 15 + 3]); // the item's second line

  assert.equal(para.text, ITEM);
  assert.equal(para.lineCount, item.length);
});

test("re-wraps the edited paragraph inside its column and leaves the rest alone", async () => {
  const { bytes } = await paragraphPdf({ nextGap: 80 });
  const para = findParagraph(bytes, 0, [150, 678]);
  const longer = para.text.replace("real PDF text.", "real PDF text, including long sentences that need several more words.");
  const before = para.lineCount;

  const result = await replaceParagraph(bytes, para, longer);

  assert.ok(result.lines > before, `wrapped into ${result.lines} lines`);
  assert.equal(result.overflows, false);
  const lines = linesOf(result.bytes);
  const body = lines.filter((l) => l.y < 700 && l.y > 690 - result.lines * 15);
  assert.equal(body.map((l) => l.text.trim()).join(" "), longer);
  for (const [i, l] of body.entries()) {
    assert.ok(near(l.x, 72), `line ${i} starts at ${l.x}`);
    assert.ok(near(l.y, 690 - i * 15, 0.5), `line ${i} baseline ${l.y}`);
    assert.ok(l.right < 72 + COLUMN + 1, `line ${i} ends at ${l.right}`);
  }
  assert.ok(lines.some((l) => l.text === "A bold heading"));
  assert.ok(lines.some((l) => l.text === "Short closing line."));
});

test("refuses text that would run into what's below, unless told to place it anyway", async () => {
  const { bytes } = await paragraphPdf({ nextGap: 20 });
  const para = findParagraph(bytes, 0, [150, 678]);
  const longer = `${para.text} ${para.text}`;

  const refused = await replaceParagraph(bytes, para, longer, { allowOverflow: false });
  assert.equal(refused.bytes, null);
  assert.ok(refused.overflowLines >= 1, `${refused.overflowLines} lines too many`);

  const forced = await replaceParagraph(bytes, para, longer);
  assert.equal(forced.overflows, true);
  assert.ok(forced.bytes);
});

test("wrapText keeps hard line breaks and never splits a word", () => {
  const lines = wrapText("aaa bbb ccc\nddd", () => 7, (s) => s.length);
  assert.deepEqual(lines, ["aaa bbb", "ccc", "ddd"]);
});

// ---------- the document's own font ----------

async function embeddedFontPdf({ subset }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const ttf = readFileSync("node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf");
  const font = await doc.embedFont(ttf, { subset });
  doc.addPage([600, 800]).drawText("Lots of letters here", { x: 72, y: 700, size: 14, font });
  return doc.save();
}

test("writes new text in the paragraph's own embedded font", async () => {
  const bytes = await embeddedFontPdf({ subset: false });
  const para = findParagraph(bytes, 0, [100, 704]);

  const result = await replaceParagraph(bytes, para, "Lots of letters here, plus QZ");

  assert.equal(result.usedOwnFont, true);
  assert.deepEqual(result.fallbackChars, []);
  const line = linesOf(result.bytes).find((l) => l.text.startsWith("Lots"));
  assert.equal(line.text, "Lots of letters here, plus QZ");
  assert.deepEqual([...line.fonts].map((n) => n.replace(/-\d+$/, "")), ["LiberationSans"]);
});

test("falls back to a standard font when the embedded one has no character map", async () => {
  const bytes = await embeddedFontPdf({ subset: true }); // pdf-lib subsets drop the cmap
  const para = findParagraph(bytes, 0, [100, 704]);

  const result = await replaceParagraph(bytes, para, "Lots of letters here!");

  assert.equal(result.usedOwnFont, false);
  const line = linesOf(result.bytes).find((l) => l.text.startsWith("Lots"));
  assert.equal(line.text, "Lots of letters here!");
  assert.ok([...line.fonts].every((n) => /Helvetica/.test(n)), [...line.fonts].join());
});

test("pages with whitespace-only lines still work", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText("    ", { x: 72, y: 720, size: 12, font: helv });
  page.drawText("Real text", { x: 72, y: 700, size: 12, font: helv });
  const bytes = await doc.save();
  assert.equal(findParagraph(bytes, 0, [90, 703]).text, "Real text");
});

test("wrapping never runs into a neighbouring table cell", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText("Wide text above that sets a wide column edge for everything", { x: 72, y: 740, size: 12, font: helv });
  page.drawText("Left cell", { x: 72, y: 700, size: 12, font: helv });
  page.drawText("Right cell", { x: 250, y: 700, size: 12, font: helv });
  const bytes = await doc.save();
  const para = findParagraph(bytes, 0, [90, 703]);

  const { bytes: out } = await replaceParagraph(bytes, para, "Left cell with many more words than fit before the next cell");

  const edited = linesOf(out).filter((l) => l.x < 200 && l.y < 720);
  assert.equal(edited.map((l) => l.text).join(" "), "Left cell with many more words than fit before the next cell");
  for (const l of edited) assert.ok(l.right < 250, `"${l.text}" ends at ${l.right}`);
  assert.ok(linesOf(out).some((l) => l.text === "Right cell"));
});

test("new text stays plain letters (no ligatures), so it can be searched and copied", async () => {
  const bytes = await embeddedFontPdf({ subset: false });
  const para = findParagraph(bytes, 0, [100, 704]);

  const result = await replaceParagraph(bytes, para, "Efficient floats fit finely");

  assert.equal(result.usedOwnFont, true);
  assert.equal(linesOf(result.bytes).find((l) => l.text.startsWith("Eff")).text, "Efficient floats fit finely");
});

test("a one-line paragraph that grows keeps the document's line spacing", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText("Short line.", { x: 72, y: 700, size: 12, font: helv });
  page.drawText("Other text spaced like the rest of the document.", { x: 72, y: 682, size: 12, font: helv }); // 18pt apart
  page.drawText("Far below.", { x: 72, y: 500, size: 12, font: helv });
  const bytes = await doc.save();
  const para = findParagraph(bytes, 0, [90, 703]);
  assert.ok(near(para.layout.leading, 18, 0.5), `leading ${para.layout.leading}`);
});

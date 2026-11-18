// PDF to an editable Word document (.docx), on the device. pdf-layout.js reads what each page
// shows; this rebuilds it with the docx library as flowing Word content: paragraphs (lines joined
// back), headings, bold/italic/colour/size, super/subscript, bullets, indents and alignment, rules
// as paragraph borders, pictures (diagrams pictured whole, artwork placed behind the text), real
// Word tables with merged cells, borders and shading, page size and margins, page breaks where a PDF
// page starts something new (elsewhere the content flows on), and the running header/footer with
// live page numbers (a cover without them gets a section of its own).
import {
  AlignmentType, BorderStyle, Document, Footer, FrameAnchorType, Header, HeadingLevel, HorizontalPositionRelativeFrom, ImageRun,
  LevelFormat, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun,
  VerticalPositionRelativeFrom, WidthType,
} from "docx";
import { analyzePdf } from "./pdf-layout.js";

const TW = 20; // twips per point
const PX = 96 / 72; // docx sizes pictures in 96-dpi pixels
const EMU = 12700; // EMU per point
const LIST_MARK = /^\s*[•●○◦▪■▸►–\-*]\s+/;
const LABEL = /^\s*(\(?[a-z0-9ivx]{1,3}[.)])(\s|\S)/i; // "(b)", "2.", "a)": a line starting so starts a paragraph
const BULLETS = "bullets";
const FRAME_SLACK = 1.15; // a framed paragraph's room for a wider stand-in font
const FRESH_GAP = 0.15; // a page that ended this share of its height early: the next starts on a fresh page
const SPACE_WIDTH = 0.25; // a space is about this share of the font size
const HEADING_SLACK = 0.5; // pt: a heading this close to the document's largest is a top-level one

/** Free fonts that stand in for Office fonts, mapped back so Word shows the original look. */
const FONT_NAMES = [
  [/^(carlito)/i, "Calibri"], [/^(caladea)/i, "Cambria"],
  [/^(liberation sans|arimo|nimbus sans|helvetica)/i, "Arial"],
  [/^(liberation serif|tinos|nimbus roman|times)/i, "Times New Roman"],
  [/^(liberation mono|cousine|nimbus mono|courier)/i, "Courier New"],
];
const wordFont = (family) => FONT_NAMES.find(([re]) => re.test(family))?.[1] ?? family;

const mode = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const pct = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

// ---------- text ----------

/** The lines of a page (or cell) grouped into paragraphs. */
function paragraphsOf(lines) {
  const blockRight = new Map();
  for (const l of lines) blockRight.set(l.block, Math.max(blockRight.get(l.block) ?? 0, l.bbox[2]));
  const paras = [];
  for (const line of lines) {
    const size = mode(line.chars.map((c) => Math.round(c.size * 2) / 2));
    const para = paras.at(-1);
    const prev = para?.lines.at(-1);
    const avgChar = (line.bbox[2] - line.bbox[0]) / Math.max(1, line.text.length);
    const joins = prev && prev.block === line.block && !LIST_MARK.test(line.text) && !LABEL.test(line.text)
      && Math.abs(para.size - size) <= size * 0.15
      && line.bbox[1] - prev.bbox[3] < size * 0.8 && line.bbox[1] >= prev.bbox[1] + size * 0.5
      && prev.bbox[2] >= blockRight.get(prev.block) - avgChar * 8; // a short line ends its paragraph
    if (joins) para.lines.push(line);
    else paras.push({ lines: [line], size });
  }
  return paras.map((p) => ({
    ...p,
    bbox: [Math.min(...p.lines.map((l) => l.bbox[0])), p.lines[0].bbox[1],
      Math.max(...p.lines.map((l) => l.bbox[2])), p.lines.at(-1).bbox[3]],
  }));
}

/** A paragraph's characters as Word runs: same font, size, colour and script run together. */
function runsOf(para, bodySize, { stripMark = false, keepGaps = false } = {}) {
  const runs = [];
  para.lines.forEach((line, i) => {
    const baseline = mode(line.chars.map((c) => Math.round(c.baseline)));
    let chars = line.chars;
    if (i === 0 && stripMark) {
      const n = line.text.match(LIST_MARK)[0].length;
      chars = chars.slice(n);
    }
    if (i > 0) {
      const prevText = runs.at(-1)?.text ?? "";
      if (!/[-\s]$/.test(prevText)) runs.at(-1).text += " ";
    }
    chars.forEach((c, j) => {
      // raised or lowered off the line's baseline (often smaller too, but not always)
      const shift = c.baseline - baseline;
      const script = c.c.trim() && shift < -c.size * 0.15 ? "sup" : c.c.trim() && shift > c.size * 0.12 ? "sub" : null;
      const key = `${c.font.family}|${c.font.bold}|${c.font.italic}|${Math.round(c.size * 2)}|${c.color}|${script}`;
      // a wide gap (a number badge before its text) is kept by widening the space
      const gap = keepGaps && !c.c.trim() ? (chars[j + 1]?.x0 ?? c.x0) - c.x0 - c.size * SPACE_WIDTH : 0;
      if (gap > c.size * SPACE_WIDTH) runs.push({ key: null, text: c.c, c, script, spacing: Math.round(gap * TW) });
      else if (runs.at(-1)?.key === key) runs.at(-1).text += c.c;
      else runs.push({ key, text: c.c, c, script });
    });
  });
  return runs.filter((r) => r.text).map(({ text, c, script, spacing }) => new TextRun({
    text: text.replace(/\s+/g, " "),
    font: wordFont(c.font.family),
    size: Math.round((script ? para.size : c.size) * 2),
    bold: c.font.bold, italics: c.font.italic,
    color: c.color === "#000000" ? undefined : c.color.slice(1),
    superScript: script === "sup", subScript: script === "sub",
    characterSpacing: spacing,
  }));
}

/** Alignment and indents of a paragraph within the column [left, right]. `isIndent(x)` tells
 * whether many lines start at x (then a paragraph starting there is indented, not centred). */
function layoutOf(para, left, right, isIndent = () => false) {
  const [x0, , x1] = para.bbox;
  const multi = para.lines.length > 1;
  const middle = (left + right) / 2;
  const listed = LIST_MARK.test(para.lines[0].text);
  let alignment = AlignmentType.LEFT;
  if (listed) alignment = AlignmentType.LEFT;
  else if (Math.abs((x0 + x1) / 2 - middle) < 4 && x0 - left > 12 && !isIndent(x0)) alignment = AlignmentType.CENTER;
  else if (Math.abs(x1 - right) < 4 && x0 - left > 40 && !multi && !isIndent(x0)) alignment = AlignmentType.RIGHT;
  else if (para.lines.length >= 3 && para.lines.slice(0, -1).every((l) => right - l.bbox[2] < 3)) alignment = AlignmentType.JUSTIFIED;
  const bodyLeft = multi ? Math.min(...para.lines.slice(1).map((l) => l.bbox[0])) : x0;
  const indent = alignment === AlignmentType.CENTER || alignment === AlignmentType.RIGHT ? undefined : {
    left: Math.max(0, Math.round((bodyLeft - left) * TW)),
    ...(multi && Math.abs(para.lines[0].bbox[0] - bodyLeft) > 2
      ? (para.lines[0].bbox[0] > bodyLeft
        ? { firstLine: Math.round((para.lines[0].bbox[0] - bodyLeft) * TW) }
        : { hanging: Math.round((bodyLeft - para.lines[0].bbox[0]) * TW) })
      : {}),
  };
  return { alignment, indent };
}

function headingOf(para, bodySize) {
  const bold = para.lines[0].chars.every((c) => !c.c.trim() || c.font.bold);
  if (para.size >= bodySize * 1.5) return HeadingLevel.HEADING_1;
  if (para.size >= bodySize * 1.2) return HeadingLevel.HEADING_2;
  if (bold && para.size >= bodySize * 1.05 && para.lines.length === 1) return HeadingLevel.HEADING_3;
  return undefined;
}

const borderOf = (s) => ({ style: BorderStyle.SINGLE, size: Math.max(2, Math.round(s.width * 8)), color: s.color.slice(1), space: 1 });

/** A frame holding the paragraph where it is on the page, a little wider than its text so a
 * stand-in font doesn't wrap it. */
function frameOf(para, alignment, pageWidth) {
  const [x0, y0, x1] = para.bbox;
  const width = Math.min(pageWidth, (x1 - x0) * FRAME_SLACK + 6);
  const x = alignment === AlignmentType.CENTER ? (x0 + x1 - width) / 2 : alignment === AlignmentType.RIGHT ? x1 - width : x0;
  return {
    type: "absolute", position: { x: Math.round(Math.max(0, x) * TW), y: Math.round(y0 * TW) },
    width: Math.round(width * TW), anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
  };
}

function paragraphOf(para, ctx, { left, right, before = 0, pageBreak = false, framed = false }) {
  const listed = LIST_MARK.test(para.lines[0].text);
  const { alignment, indent } = layoutOf(para, left, right, ctx.isIndent);
  // a rule just under (or over) the paragraph is its border, as Word draws heading underlines
  const width = para.bbox[2] - para.bbox[0];
  const near = (s, y) => Math.abs(s.at - y) < 8 && Math.min(s.to, right) - Math.max(s.from, para.bbox[0]) >= width * 0.5;
  const slack = para.size * 0.4; // a line's box reaches below its baseline
  const under = ctx.rules?.find((s) => !s.used && s.at >= para.bbox[3] - slack && near(s, para.bbox[3]));
  const over = ctx.rules?.find((s) => !s.used && s.at <= para.bbox[1] + slack && s !== under && near(s, para.bbox[1]));
  for (const s of [under, over]) if (s) s.used = true;
  const lineGaps = para.lines.slice(1).map((l, i) => l.chars[0].baseline - para.lines[i].chars[0].baseline);
  return new Paragraph({
    heading: listed ? undefined : headingOf(para, ctx.bodySize),
    alignment,
    indent: listed || framed ? undefined : indent,
    frame: framed ? frameOf(para, alignment, ctx.pageWidth) : undefined,
    numbering: listed ? { reference: BULLETS, level: 0 } : undefined,
    pageBreakBefore: pageBreak || undefined,
    spacing: {
      before: framed ? 0 : Math.max(0, Math.round(before * TW)), after: 0,
      ...(lineGaps.length ? { line: Math.round(mode(lineGaps.map(Math.round)) * TW), lineRule: "atLeast" } : {}),
    },
    border: under || over ? { ...(under ? { bottom: borderOf(under) } : {}), ...(over ? { top: borderOf(over) } : {}) } : undefined,
    children: [...runsOf(para, ctx.bodySize, { stripMark: listed, keepGaps: framed })],
  });
}

// ---------- pictures and tables ----------

function imageOf(img, { left, right, before = 0, pageBreak = false }) {
  const [x0, y0, x1, y1] = img.bbox;
  const scale = Math.min(1, (right - left) / Math.max(1, x1 - x0)); // shortcut: wider than the column? shrink to fit
  const centered = Math.abs((x0 + x1) / 2 - (left + right) / 2) < 6;
  return new Paragraph({
    alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
    indent: centered ? undefined : { left: Math.max(0, Math.round((x0 - left) * TW)) },
    pageBreakBefore: pageBreak || undefined,
    spacing: { before: Math.max(0, Math.round(before * TW)), after: 0 },
    children: [new ImageRun({ type: "png", data: img.png,
      transformation: { width: Math.round((x1 - x0) * scale * PX), height: Math.round((y1 - y0) * scale * PX) } })],
  });
}

const backgroundOf = (img) => new ImageRun({
  type: "png", data: img.png,
  transformation: { width: Math.round((img.bbox[2] - img.bbox[0]) * PX), height: Math.round((img.bbox[3] - img.bbox[1]) * PX) },
  floating: {
    horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(img.bbox[0] * EMU) },
    verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round(img.bbox[1] * EMU) },
    behindDocument: true, allowOverlap: true,
  },
});

function tableOf(table, ctx) {
  const widths = table.xs.slice(1).map((x, i) => Math.round((x - table.xs[i]) * TW));
  const side = (s) => (s ? { style: BorderStyle.SINGLE, size: Math.max(2, Math.round(s.width * 8)), color: s.color.slice(1) }
    : { style: BorderStyle.NONE, size: 0, color: "FFFFFF" });
  const rows = [];
  for (let r = 0; r < table.ys.length - 1; r++) {
    const cells = table.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
    if (!cells.length) continue; // shortcut: a row made only of cells merged from above is dropped
    rows.push(new TableRow({
      children: cells.map((cell) => {
        const [cx0, cy0, cx1, cy1] = cell.rect;
        // the cell's padding is the gap between its border and its content
        const content = [...cell.lines, ...cell.images].map((x) => x.bbox);
        const inset = (f, fallback) => Math.round(Math.max(0, Math.min(36, content.length ? f() : fallback)) * TW);
        // the narrower side, so centred text isn't squeezed; an empty cell (a gap between boxes) needs none
        const padX = inset(() => Math.min(Math.min(...content.map((b) => b[0])) - cx0, cx1 - Math.max(...content.map((b) => b[2]))), 0);
        const margins = { left: padX, right: padX,
          top: inset(() => Math.min(...content.map((b) => b[1])) - cy0, 2),
          bottom: inset(() => cy1 - Math.max(...content.map((b) => b[3])), 2) };
        const [inL, inR] = [cx0 + margins.left / TW, cx1 - margins.right / TW];
        const paras = paragraphsOf(cell.lines).map((p) => paragraphOf(p, { ...ctx, rules: null, isIndent: () => false }, { left: inL, right: inR }));
        const pictures = cell.images.map((img) => imageOf(img, { left: inL, right: inR }));
        return new TableCell({
          margins,
          columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
          rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
          width: { size: widths.slice(cell.col, cell.col + cell.colSpan).reduce((a, b) => a + b, 0), type: WidthType.DXA },
          borders: { top: side(cell.borders.top), bottom: side(cell.borders.bottom), left: side(cell.borders.left), right: side(cell.borders.right) },
          shading: cell.fill ? { fill: cell.fill.slice(1), type: ShadingType.CLEAR, color: "auto" } : undefined,
          children: [...paras, ...pictures].length ? [...paras, ...pictures] : [new Paragraph("")],
        });
      }),
    }));
  }
  const indent = Math.round((table.bbox[0] - (ctx.left ?? table.bbox[0])) * TW);
  return new Table({ rows, columnWidths: widths, layout: TableLayoutType.FIXED,
    indent: indent > 2 * TW ? { size: indent, type: WidthType.DXA } : undefined,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA } });
}

// ---------- header and footer ----------

function bandParagraphs(band, left, right) {
  return band.map(({ text, line }) => {
    const c = line.chars.find((ch) => ch.c.trim()) ?? line.chars[0];
    const style = { font: wordFont(c.font.family), size: Math.round(c.size * 2), bold: c.font.bold, italics: c.font.italic,
      color: c.color === "#000000" ? undefined : c.color.slice(1) };
    const fields = { "{PAGE}": PageNumber.CURRENT, "{NUMPAGES}": PageNumber.TOTAL_PAGES, "{SECTIONPAGES}": PageNumber.TOTAL_PAGES_IN_SECTION };
    const children = text.split(/(\{PAGE\}|\{NUMPAGES\}|\{SECTIONPAGES\})/).filter(Boolean).map((part) => (fields[part]
      ? new TextRun({ ...style, children: [fields[part]] })
      : new TextRun({ ...style, text: part })));
    const [x0, , x1] = line.bbox;
    const alignment = Math.abs((x0 + x1) / 2 - (left + right) / 2) < 8 ? AlignmentType.CENTER
      : Math.abs(x1 - right) < 8 ? AlignmentType.RIGHT : AlignmentType.LEFT;
    return new Paragraph({ alignment, children });
  });
}

// ---------- document ----------

/**
 * @param {Uint8Array} bytes a PDF
 * @returns {Promise<Uint8Array>} a .docx
 */
export async function pdfToDocx(bytes) {
  const { pages, header, footer, from, start } = analyzePdf(bytes);
  const allLines = pages.flatMap((p) => p.lines);
  const bodySize = mode(allLines.flatMap((l) => l.chars.filter((c) => c.c.trim()).map((c) => Math.round(c.size * 2) / 2))) ?? 11;
  const first = pages[0] ?? { width: 612, height: 792 };
  const left = allLines.length ? pct(allLines.map((l) => l.bbox[0]), 0.05) : 72;
  const textRight = allLines.length ? pct(allLines.map((l) => l.bbox[2]), 0.95) : first.width - 72;
  const right = Math.max(textRight, ...pages.flatMap((p) => p.tables.map((t) => t.bbox[2]))); // tables fit inside the margins
  const top = Math.max(18, allLines.length ? pct(allLines.map((l) => l.bbox[1]), 0.02) - 4 : 72);
  const bottom = Math.max(18, allLines.length ? first.height - pct(allLines.map((l) => l.bbox[3]), 0.98) - 4 : 72);

  const starts = allLines.map((l) => l.bbox[0]);
  const isIndent = (x) => starts.filter((s) => Math.abs(s - x) <= 1.5).length >= 3;
  const pageItems = pages.map((page) => [
    ...paragraphsOf(page.lines).map((para) => ({ top: para.bbox[1], bottom: para.bbox[3], para })),
    ...page.images.filter((img) => !img.background).map((img) => ({ top: img.bbox[1], bottom: img.bbox[3], img })),
    ...page.tables.map((table) => ({ top: table.bbox[1], bottom: table.bbox[3], table })),
  ].sort((a, b) => a.top - b.top)); // shortcut: one column; text in side-by-side columns is read row by row
  const hasBackground = (p) => pages[p].images.some((img) => img.background);
  const headingSize = Math.max(0, ...pageItems.flatMap((items, p) => (hasBackground(p) ? []
    : items.filter((it) => it.para && headingOf(it.para, bodySize)).map((it) => it.para.size))));
  /** Whether PDF page p clearly starts something new (a top-level heading, or the page before ended
   * well short of its bottom), so it keeps its page break; elsewhere the content flows on. */
  const startsFresh = (p) => {
    if (hasBackground(p) || hasBackground(p - 1)) return true;
    const lead = pageItems[p][0]?.para;
    if (lead && headingOf(lead, bodySize) && lead.size >= headingSize - HEADING_SLACK) return true;
    const prev = pages[p - 1];
    const ended = Math.max(top, ...pageItems[p - 1].map((it) => it.bottom));
    // the bottom margin is measured from the text, so a short document may not reach it; assume
    // it's at least as deep as the top margin
    const floor = prev.height - Math.min(top, bottom);
    return ended < floor - prev.height * FRESH_GAP;
  };

  // pages before the first one with a header/footer (a cover) get a section of their own, without them
  const split = (header.length || footer.length) && from > 0 ? from : 0;
  const sectionChildren = [[], []];
  pages.forEach((page, p) => {
    const children = sectionChildren[p < split ? 0 : 1];
    const ctx = { bodySize, rules: page.rules, isIndent, left, pageWidth: page.width };
    const framed = hasBackground(p); // text over artwork stays where it is on the page, so the page can't grow
    let pageBreak = p > 0 && p !== split && startsFresh(p);
    if (framed) {
      children.push(new Paragraph({ pageBreakBefore: pageBreak || undefined,
        children: page.images.filter((img) => img.background).map(backgroundOf) }));
      pageBreak = false;
    }
    let y = top;
    pageItems[p].forEach((item, i) => {
      const before = item.top - y;
      const breaks = pageBreak && i === 0;
      if (item.para) {
        children.push(paragraphOf(item.para, ctx, { left, right, before, pageBreak: breaks, framed }));
      } else if (item.img) {
        children.push(imageOf(item.img, { left, right, before, pageBreak: breaks }));
      } else {
        if (breaks || before > 6) children.push(new Paragraph({ pageBreakBefore: breaks || undefined, spacing: { before: 0, after: 0, line: Math.max(20, Math.round(before * TW)), lineRule: "exact" } }));
        children.push(tableOf(item.table, ctx));
      }
      y = Math.max(y, item.bottom);
    });
  });

  const page = {
    size: { width: Math.round(first.width * TW), height: Math.round(first.height * TW) },
    margin: {
      top: Math.round(top * TW), bottom: Math.round(bottom * TW),
      left: Math.round(left * TW), right: Math.round(Math.max(18, first.width - right) * TW),
      header: Math.round(Math.max(12, header[0]?.line.bbox[1] ?? 36) * TW),
      footer: Math.round(Math.max(12, first.height - (footer.at(-1)?.line.bbox[3] ?? first.height - 36)) * TW),
    },
  };
  const doc = new Document({
    numbering: { config: [{ reference: BULLETS, levels: [{ level: 0, format: LevelFormat.BULLET, text: "•",
      alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }] }] },
    styles: { default: { document: { run: { size: Math.round(bodySize * 2) } } } },
    sections: [
      ...(split ? [{ properties: { page }, children: sectionChildren[0] }] : []),
      {
        // the PDF's own page numbers (a cover left unnumbered makes page 2 "Page 1")
        properties: { page: start === undefined ? page : { ...page, pageNumbers: { start } } },
        headers: header.length ? { default: new Header({ children: bandParagraphs(header, left, right) }) } : undefined,
        footers: footer.length ? { default: new Footer({ children: bandParagraphs(footer, left, right) }) } : undefined,
        children: sectionChildren[1],
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

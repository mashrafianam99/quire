// PDF to an editable Word document (.docx), on the device. pdf-layout.js reads what each page
// shows; this rebuilds it with the docx library as flowing Word content: paragraphs (lines joined
// back), headings, bold/italic/colour/size, super/subscript, bullets, indents and alignment, rules
// as paragraph borders, pictures (diagrams pictured whole, artwork placed behind the text), real
// Word tables with merged cells, borders and shading, page size and margins, page breaks where a PDF
// page starts something new (elsewhere the content flows on), and the running header/footer with
// live page numbers (a cover without them gets a section of its own).
import {
  AlignmentType, BorderStyle, Document, Footer, FrameAnchorType, Header, HeadingLevel, HeightRule, HorizontalPositionRelativeFrom, ImageRun,
  LevelFormat, Packer, PageNumber, Paragraph, ShadingType, Tab, Table, TableCell, TableLayoutType, TableRow, TabStopType, TextRun,
  VerticalPositionRelativeFrom, WidthType,
} from "docx";
import { analyzePdf } from "./pdf-layout.js";

const TW = 20; // twips per point
const PX = 96 / 72; // docx sizes pictures in 96-dpi pixels
const EMU = 12700; // EMU per point
const LIST_MARK = /^\s*[•●○◦▪■▸►–\-*]\s+/;
const LABEL = /^\s*(\(?[a-z0-9ivx]{1,3}[.)])(\s|\S)/i; // "(b)", "2.", "a)": a line starting so starts a paragraph
const FIELD_VALUE = /^\s*:/; // ": 12 January": a form's value, one per line
const BULLETS = "bullets";
const NEAR_JOIN = 2; // pt; a table this close under another, with the same edges, continues it in Word
const FRAME_SLACK = 1.15; // a framed paragraph's room for a wider stand-in font
const FRESH_GAP = 0.15; // a page that ended this share of its height early: the next starts on a fresh page
const SPACE_WIDTH = 0.25; // a space is about this share of the font size
const HEADING_SLACK = 0.5; // pt: a heading this close to the document's largest is a top-level one
const LEAD_GAP = 16; // pt; an item this close under a page's first picture (its caption) goes with it
const SPLIT_START = 48; // pt; the room a paragraph or table needs to start on a page (a couple of lines)
const SUBHEAD_SIZE = 1.03; // a one-line paragraph this much bigger than the body heads what follows
const KEEP_ROW = 0.3; // share of the page height; a table row (a callout) up to this tall isn't split across pages
const GUTTER = 6; // pt; items at least this far apart side by side are in columns of their own
const RULE_REACH = 8; // pt; a fill-in line this close under text is on the text's row
const LINE_HEIGHT = 1.15; // in font sizes; Word's single line
const WORD_MAX_PAGE = 1584; // pt (22 in): Word's largest page side
const MIN_MARGIN = 18; // pt
const MAX_MARGIN_SHARE = 0.25; // of the page's width or height

/** Free fonts that stand in for Office fonts, mapped back so Word shows the original look; and
 * web fonts Word doesn't have, mapped to the closest font it does. */
const FONT_NAMES = [
  [/^(carlito)/i, "Calibri"], [/^(caladea)/i, "Cambria"],
  [/^(liberation sans|arimo|nimbus sans|helvetica)/i, "Arial"],
  [/^(liberation serif|tinos|nimbus roman|times)/i, "Times New Roman"],
  [/^(liberation mono|cousine|nimbus mono|courier)/i, "Courier New"],
  [/^(poppins|montserrat|lexend|futura|avenir|quicksand|nunito|raleway|comfortaa|questrial|josefin|urbanist|outfit|manrope)/i, "Century Gothic"],
];
/** Fonts that come with Office on Windows and Mac: kept as they are. */
const OFFICE_FONTS = new Set(["arial", "arial narrow", "arial black", "aptos", "book antiqua", "calibri", "calibri light", "cambria",
  "candara", "century gothic", "comic sans ms", "consolas", "constantia", "corbel", "courier new", "franklin gothic",
  "garamond", "georgia", "gill sans mt", "impact", "lucida console", "lucida sans", "palatino linotype", "segoe ui",
  "tahoma", "times new roman", "trebuchet ms", "verdana"]);
const CODE_FONT = "Consolas";
// shortcut: any other font becomes Arial, Cambria or Consolas; embed the PDF's own fonts for an exact look
export const wordFont = ({ family, mono, serif }) => FONT_NAMES.find(([re]) => re.test(family))?.[1]
  ?? (OFFICE_FONTS.has(family.toLowerCase()) ? family : mono ? CODE_FONT : serif ? "Cambria" : "Arial");

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

const isCode = (line) => line.chars.every((c) => !c.c.trim() || c.font.mono);
const MAX_BLANKS = 3; // blank lines kept inside a listing; a wider gap starts a new listing

/** A line's text size: its usual size, not counting inline code (often set smaller). */
const sizeOf = (line) => {
  const prose = line.chars.filter((c) => c.c.trim() && !c.font.mono);
  return mode((prose.length ? prose : line.chars).map((c) => Math.round(c.size * 2) / 2));
};
const FULL_LINE = 3; // in font sizes; a line ending this close to the column's right edge is full
const SAME_LEFT = 4; // pt; lines starting this close are in one column (inline code's pill starts a little off)

/** MuPDF's text blocks, with a line that runs on from a full line above it (same x, same size, a
 * line apart) taken into that line's block: some PDFs, justified text especially, put each line in
 * a block of its own. */
function blocksOf(lines) {
  const right = Math.max(...lines.map((l) => l.bbox[2]));
  let block = 0;
  return lines.map((line, i) => {
    const prev = lines[i - 1];
    const stacked = prev && Math.abs(prev.bbox[0] - line.bbox[0]) <= SAME_LEFT && sizeOf(prev) === sizeOf(line)
      && prev.bbox[2] >= right - sizeOf(prev) * FULL_LINE
      && line.bbox[1] >= prev.bbox[1] && line.bbox[1] - prev.bbox[3] < sizeOf(line) * 0.8;
    if (prev && prev.block !== line.block && !stacked) block++;
    return block;
  });
}

/** The lines of a page (or cell) grouped into paragraphs. */
function paragraphsOf(lines) {
  const blocks = blocksOf(lines);
  const blockOf = new Map(lines.map((l, i) => [l, blocks[i]]));
  const blockRight = new Map();
  const blockLeft = new Map();
  for (const l of lines) {
    const b = blockOf.get(l);
    blockRight.set(b, Math.max(blockRight.get(b) ?? 0, l.bbox[2]));
    blockLeft.set(b, Math.min(blockLeft.get(b) ?? Infinity, l.bbox[0]));
  }
  const paras = [];
  for (const line of lines) {
    const size = sizeOf(line);
    const para = paras.at(-1);
    const prev = para?.lines.at(-1);
    const avgChar = (line.bbox[2] - line.bbox[0]) / Math.max(1, line.text.length);
    const joins = prev && blockOf.get(prev) === blockOf.get(line) && !isCode(line) && !isCode(prev) && !LIST_MARK.test(line.text) && !LABEL.test(line.text) && !FIELD_VALUE.test(line.text)
      && Math.abs(para.size - size) <= size * 0.15
      && line.bbox[1] - prev.bbox[3] < size * 0.8 && line.bbox[1] >= prev.bbox[1] + size * 0.5
      && prev.bbox[2] >= blockRight.get(blockOf.get(prev)) - avgChar * 8 // a short line ends its paragraph
      && prev.bbox[0] <= blockLeft.get(blockOf.get(prev)) + avgChar * 8; // so does one set far right (right-aligned lines)
    if (joins) para.lines.push(line);
    else paras.push({ lines: [line], size, code: isCode(line) });
  }
  const out = paras.map((p) => ({
    ...p,
    bbox: [Math.min(...p.lines.map((l) => l.bbox[0])), p.lines[0].bbox[1],
      Math.max(...p.lines.map((l) => l.bbox[2])), p.lines.at(-1).bbox[3]],
  }));
  for (let i = 0; i < out.length; i++) {
    let j = i;
    while (out[i].code && out[j + 1]?.code) j++;
    if (out[i].code) layOutCode(out.slice(i, j + 1));
    i = j;
  }
  return out;
}

/** A code listing keeps its layout: its line pitch, blank lines between its lines, and indents
 * as leading spaces (counted in character widths where the PDF moved a line instead of drawing spaces). */
function layOutCode(listing) {
  const baseline = (p) => p.lines[0].chars[0].baseline;
  const gaps = listing.slice(1).map((p, k) => baseline(p) - baseline(listing[k]));
  const pitch = mode(gaps.filter((g) => g > 0).map((g) => Math.round(g * 2) / 2)) ?? listing[0].size * 1.2;
  const codeLeft = Math.min(...listing.map((p) => p.bbox[0]));
  listing.forEach((p, k) => {
    const charWidth = mode(p.lines[0].chars.map((c) => Math.round((c.x1 - c.x0) * 10) / 10)) || p.size * 0.6;
    const lines = k ? Math.round(gaps[k - 1] / pitch) : 0;
    const inCode = lines >= 1 && lines <= MAX_BLANKS + 1;
    Object.assign(p, { pitch, codeLeft, pad: Math.round((p.bbox[0] - codeLeft) / charWidth), inCode, blanks: inCode ? lines - 1 : 0 });
  });
}

/** A paragraph's characters as Word runs: same font, size, colour and script run together. */
function runsOf(para, bodySize, { stripMark = false, pad = 0, keepGaps = false } = {}) {
  const runs = [];
  para.lines.forEach((line, i) => {
    const baseline = mode(line.chars.map((c) => Math.round(c.baseline)));
    let chars = line.chars;
    if (i === 0 && stripMark) {
      const n = line.text.match(LIST_MARK)[0].length;
      chars = chars.slice(n);
    }
    if (i > 0 && runs.length) {
      const prevText = runs.at(-1)?.text ?? "";
      if (!/[-\s]$/.test(prevText)) runs.at(-1).text += " ";
    }
    chars.forEach((c, j) => {
      // raised or lowered off the line's baseline (often smaller too, but not always)
      const shift = c.baseline - baseline;
      const script = c.c.trim() && shift < -c.size * 0.15 ? "sup" : c.c.trim() && shift > c.size * 0.12 ? "sub" : null;
      const key = `${c.font.family}|${c.font.bold}|${c.font.italic}|${Math.round(c.size * 2)}|${c.color}|${script}|${c.badge ?? c.bg}`;
      // a wide gap (a number badge before its text) is kept by widening the space
      const gap = keepGaps && !c.c.trim() ? (chars[j + 1]?.x0 ?? c.x0) - c.x0 - c.size * SPACE_WIDTH : 0;
      if (gap > c.size * SPACE_WIDTH) runs.push({ key: null, text: c.c, c, script, spacing: Math.round(gap * TW) });
      else if (runs.at(-1)?.key === key) runs.at(-1).text += c.c;
      else runs.push({ key, text: c.c, c, script });
    });
  });
  if (pad && runs.length) runs[0].text = " ".repeat(pad) + runs[0].text;
  return runs.filter((r) => r.text).map(({ text, c, script, spacing }) => new TextRun({
    text: c.font.mono ? text : text.replace(/\s+/g, " "), // code keeps its spaces
    font: wordFont(c.font),
    size: Math.round((script ? para.size : c.size) * 2),
    bold: c.font.bold, italics: c.font.italic,
    color: c.color.slice(1),
    superScript: script === "sup", subScript: script === "sub",
    // a badge's or inline code's fill; shortcut: a round badge becomes a square of shading behind its letter
    shading: (c.badge ?? c.bg) ? { type: ShadingType.CLEAR, fill: (c.badge ?? c.bg).slice(1), color: "auto" } : undefined,
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

const styleOf = (s) => (s.dash === "dot" ? BorderStyle.DOTTED : s.dash === "dash" ? BorderStyle.DASHED : BorderStyle.SINGLE);
const BORDER_SPACE = 1; // pt between a paragraph and its border line
const borderOf = (s) => ({ style: styleOf(s), size: Math.max(2, Math.round(s.width * 8)), color: s.color.slice(1), space: BORDER_SPACE });

/** A line of code: as it is, left aligned at the listing's indent, at the listing's own pitch,
 * after the blank lines that came before it. */
function codeOf(para, ctx, { left, before, pageBreak, extra }) {
  const spacing = { after: 0, line: Math.round(para.pitch * TW), lineRule: "exact" };
  const indent = { left: Math.max(0, Math.round((para.codeLeft - left) * TW)) };
  const blank = () => new Paragraph({ indent, spacing: { ...spacing, before: 0 } });
  return [...Array.from({ length: para.blanks }, blank), new Paragraph({
    indent, pageBreakBefore: pageBreak || undefined,
    spacing: { ...spacing, before: para.inCode ? 0 : Math.max(0, Math.round(before * TW)) },
    children: [...extra, ...runsOf(para, ctx.bodySize, { pad: para.pad })],
  })];
}

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

/** A paragraph as Word paragraphs (a code line may bring blank lines before it); a framed one
 * stays where it is on the page (text over a background). */
function paragraphOf(para, ctx, { left, right, before = 0, pageBreak = false, extra = [], framed = false, keepNext = false }) {
  if (para.code) return codeOf(para, ctx, { left, before, pageBreak, extra });
  const listed = LIST_MARK.test(para.lines[0].text);
  const { alignment, indent } = layoutOf(para, left, right, ctx.isIndent);
  // a rule just under (or over) the paragraph is its border, as Word draws heading underlines
  const width = para.bbox[2] - para.bbox[0];
  const near = (s, y) => Math.abs(s.at - y) < 8 && Math.min(s.to, right) - Math.max(s.from, para.bbox[0]) >= width * 0.5;
  const slack = para.size * 0.4; // a line's box reaches below its baseline
  const under = ctx.rules?.find((s) => !s.used && s.at >= para.bbox[3] - slack && near(s, para.bbox[3]));
  const over = ctx.rules?.find((s) => !s.used && s.at <= para.bbox[1] + slack && s !== under && near(s, para.bbox[1]));
  for (const s of [under, over]) if (s) s.used = true;
  para.ruled = [under, over].reduce((n, s) => n + (s ? s.width + BORDER_SPACE : 0), 0); // what Word's borders add
  // in a form field the line ends where the PDF's does, not at the cell's edge
  const fit = ctx.fit && (under ?? over) ? { right: Math.max(0, Math.round((right - (under ?? over).to) * TW)) } : {};
  const lineGaps = para.lines.slice(1).map((l, i) => l.chars[0].baseline - para.lines[i].chars[0].baseline);
  const heading = listed ? undefined : headingOf(para, ctx.bodySize);
  return [new Paragraph({
    heading,
    // a heading, or a one-line subheading a little bigger than the body, stays with what it heads
    keepNext: keepNext || !!heading || (para.lines.length === 1 && para.size >= ctx.bodySize * SUBHEAD_SIZE) || undefined,
    alignment,
    indent: listed || framed ? undefined : { ...indent, ...fit },
    frame: framed ? frameOf(para, alignment, ctx.pageWidth) : undefined,
    numbering: listed ? { reference: BULLETS, level: 0 } : undefined,
    pageBreakBefore: pageBreak || undefined,
    spacing: {
      before: framed ? 0 : Math.max(0, Math.round(before * TW)), after: 0,
      ...(lineGaps.length ? { line: Math.round(mode(lineGaps.map(Math.round)) * TW), lineRule: "atLeast" } : {}),
    },
    // Word boxes consecutive paragraphs with the same borders together; `between` keeps each one's line
    border: under || over ? { ...(under ? { bottom: borderOf(under), between: borderOf(under) } : {}), ...(over ? { top: borderOf(over) } : {}) } : undefined,
    children: [...extra, ...runsOf(para, ctx.bodySize, { stripMark: listed, keepGaps: framed })],
  })];
}

// ---------- pictures and tables ----------

function imageOf(img, { left, right, before = 0, pageBreak = false, maxHeight = Infinity }) {
  const [x0, y0, x1, y1] = img.bbox;
  // bigger than the column or the page (a poster, a scan on an oversized page)? shrink to fit
  const scale = Math.min(1, (right - left) / Math.max(1, x1 - x0), maxHeight / Math.max(1, y1 - y0));
  const centered = Math.abs((x0 + x1) / 2 - (left + right) / 2) < 6;
  return new Paragraph({
    alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
    indent: centered ? undefined : { left: Math.max(0, Math.round((x0 - left) * TW)) },
    pageBreakBefore: pageBreak || undefined,
    spacing: { before: Math.max(0, Math.round(before * TW)), after: 0 },
    children: [new ImageRun({ type: img.type, data: img.data,
      transformation: { width: Math.round((x1 - x0) * scale * PX), height: Math.round((y1 - y0) * scale * PX) } })],
  });
}

const backgroundOf = (img) => new ImageRun({
  type: img.type, data: img.data,
  transformation: { width: Math.round((img.bbox[2] - img.bbox[0]) * PX), height: Math.round((img.bbox[3] - img.bbox[1]) * PX) },
  floating: {
    horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(img.bbox[0] * EMU) },
    verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round(img.bbox[1] * EMU) },
    behindDocument: true, allowOverlap: true,
  },
});

const EMPTY_PAD = 2; // pt; the top and bottom padding of an empty cell
const CENTRED = 4; // pt; text whose side gaps differ less than this (or this share of them) is centred in its cell
const CENTRED_SHARE = 0.25;
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };

function tableOf(table, ctx) {
  const widths = table.xs.slice(1).map((x, i) => Math.round((x - table.xs[i]) * TW));
  const side = (s) => (s ? { style: styleOf(s), size: Math.max(2, Math.round(s.width * 8)), color: s.color.slice(1) }
    : NO_BORDER);
  const rows = [];
  for (let r = 0; r < table.ys.length - 1; r++) {
    const cells = table.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
    if (!cells.length) continue; // shortcut: a row made only of cells merged from above is dropped
    // rows with text get no height: Word sizes them to their text (an "at least" height made Word's
    // rows taller than the PDF's); a row with nothing in it keeps its own, or it would shrink to one line
    const empty = cells.every((c) => !c.lines.length && !c.images.length);
    const emptyHeight = Math.round((table.ys[r + 1] - table.ys[r] - 2 * EMPTY_PAD) * TW); // ≤ 0 for a sliver of a row
    rows.push(new TableRow({
      cantSplit: table.ys[r + 1] - table.ys[r] <= ctx.pageHeight * KEEP_ROW || undefined,
      height: empty && emptyHeight > 0 ? { value: emptyHeight, rule: HeightRule.ATLEAST } : undefined,
      children: cells.map((cell) => {
        const [cx0, cy0, cx1, cy1] = cell.rect;
        // the cell's padding is the gap between its border and its content
        const content = [...cell.lines, ...cell.images].map((x) => x.bbox);
        const inset = (f, fallback) => Math.round(Math.max(0, Math.min(36, content.length ? f() : fallback)) * TW);
        // the narrower side, so centred text isn't squeezed (nor wrapped in a wider stand-in font);
        // an empty cell (a gap between boxes) needs none
        const sides = () => [Math.min(...content.map((b) => b[0])) - cx0, cx1 - Math.max(...content.map((b) => b[2]))];
        const padX = inset(() => (Math.abs(sides()[0] - sides()[1]) < Math.max(CENTRED, Math.min(...sides()) * CENTRED_SHARE) ? EMPTY_PAD : Math.min(...sides())), 0);
        const top = inset(() => Math.min(...content.map((b) => b[1])) - cy0, EMPTY_PAD);
        // the room under a short cell's text comes from its row's taller cells; as padding it would
        // add to the row's height wherever Word's lines come out taller than the PDF's
        const margins = { left: padX, right: padX, top,
          bottom: Math.min(top, inset(() => cy1 - Math.max(...content.map((b) => b[3])), EMPTY_PAD)) };
        const [inL, inR] = [cx0 + margins.left / TW, cx1 - margins.right / TW];
        // a header row stays with the row under it
        const keepNext = r === 0 && table.ys.length > 2;
        const paras = paragraphsOf(cell.lines).flatMap((p) => paragraphOf(p, { ...ctx, rules: null, isIndent: () => false }, { left: inL, right: inR, keepNext }));
        const pictures = cell.images.map((img) => imageOf(img, { left: inL, right: inR }));
        return new TableCell({
          margins,
          columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
          rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
          width: { size: widths.slice(cell.col, cell.col + cell.colSpan).reduce((a, b) => a + b, 0), type: WidthType.DXA },
          borders: { top: side(cell.borders.top), bottom: side(cell.borders.bottom), left: side(cell.borders.left), right: side(cell.borders.right) },
          shading: cell.fill ? { fill: cell.fill.slice(1), type: ShadingType.CLEAR, color: "auto" } : undefined,
          children: [...paras, ...pictures].length ? [...paras, ...pictures] : [new Paragraph({ keepNext: keepNext || undefined })],
        });
      }),
    }));
  }
  const indent = Math.round((table.bbox[0] - (ctx.left ?? table.bbox[0])) * TW);
  return new Table({ rows, columnWidths: widths, layout: TableLayoutType.FIXED,
    indent: indent > 2 * TW ? { size: indent, type: WidthType.DXA } : undefined,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA } });
}

// ---------- side by side (forms, logos beside titles, label/value pairs) ----------

// keepNext: a spacer before a table stays on the table's page
const spacerOf = (height, pageBreak = false, { keepNext = false } = {}) => new Paragraph({ pageBreakBefore: pageBreak || undefined,
  keepNext: keepNext || undefined,
  spacing: { before: 0, after: 0, line: Math.max(20, Math.round(height * TW)), lineRule: "exact" } });

/** Items stacked in bands: an item whose top is above the bottom of the band so far is beside it. */
function bandsOf(items) {
  const bands = [];
  for (const it of [...items].sort((a, b) => a.top - b.top)) {
    const band = bands.at(-1);
    if (band && it.top < band.bottom - 1) {
      band.items.push(it);
      band.bottom = Math.max(band.bottom, it.bottom);
    } else bands.push({ top: it.top, bottom: it.bottom, items: [it] });
  }
  return bands;
}

/** The x ranges no item of a band covers: the gaps between them and out to either side. */
function freeOf(items) {
  const free = [];
  let right = -Infinity;
  for (const it of [...items].sort((a, b) => a.x0 - b.x0)) {
    if (it.x0 > right) free.push([right, it.x0]);
    right = Math.max(right, it.x1);
  }
  return [...free, [right, Infinity]];
}
const guttersOf = (items) => freeOf(items).slice(1, -1).filter(([a, b]) => b - a >= GUTTER);

/** A region's gutters narrowed to stay open in the band, or null when the band crosses one or
 * splits where the region doesn't. */
function narrowed(gutters, band) {
  const free = freeOf(band.items);
  const kept = gutters.map(([a, b]) => free.map(([c, d]) => [Math.max(a, c), Math.min(b, d)]).find(([c, d]) => d - c >= GUTTER));
  if (kept.some((g) => !g)) return null;
  const extra = guttersOf(band.items).some(([a, b]) => !kept.some(([c, d]) => c < b && d > a));
  return extra ? null : kept;
}

/**
 * The page's items, with runs of rows whose items sit side by side (columns apart by a gutter on
 * every row) gathered into regions, each laid out as one borderless Word table: a row per band, a
 * column per gutter. A fill-in line (a free rule) counts as an item there. A full-width item, code,
 * and anything crossing a gutter stays in the normal flow.
 */
function regionsOf(items, rules) {
  const bands = bandsOf(items);
  // a fill-in line on a row (or just under it) is on that row when the row is side by side with it,
  // unless it runs across a gutter (a separator); under a lone label it stays that label's border
  const free = new Set(rules);
  for (const band of bands) {
    const gutters = guttersOf(band.items);
    for (const rule of free) {
      const item = { top: rule.at - RULE_REACH, bottom: rule.at, x0: rule.from, x1: rule.to, rule };
      const near = rule.at >= band.top && rule.at <= band.bottom + RULE_REACH;
      if (!near || gutters.some(([a, b]) => rule.from <= a && rule.to >= b) || !guttersOf([...band.items, item]).length) continue;
      free.delete(rule);
      band.items.push(item);
      band.bottom = Math.max(band.bottom, rule.at);
    }
  }
  const out = [];
  let region = null;
  for (const band of bands) {
    const code = band.items.some((it) => it.para?.code);
    // only rows that are side by side themselves carry a region on (a lone label below ends it)
    const kept = region && !code && guttersOf(band.items).length && narrowed(region.gutters, band);
    if (kept) {
      region.gutters = kept;
      region.bands.push(band);
    } else {
      const gutters = code ? [] : guttersOf(band.items);
      region = gutters.length && band.items.some((it) => !it.rule) ? { gutters, bands: [band] } : null;
      if (region) out.push({ region, top: band.top });
      else out.push(...band.items.filter((it) => !it.rule));
    }
    if (region) out.at(-1).bottom = band.bottom;
  }
  return out;
}

/** The children of a layout cell: its items stacked from y, each at its distance below the one before;
 * and where they end in Word (whose lines are taller than the PDF's line boxes). */
function cellOf(items, ctx, { left, right, y }) {
  const lineHeight = ctx.bodySize * LINE_HEIGHT;
  const rules = items.filter((it) => it.rule).map((it) => it.rule);
  const out = [];
  for (const it of items) {
    if (it.rule?.used) continue;
    const before = (it.rule ? it.rule.at - lineHeight : it.top) - y;
    if (it.para) out.push(...paragraphOf(it.para, { ...ctx, rules, fit: true }, { left, right, before }));
    else if (it.img) out.push(imageOf(it.img, { left, right, before }));
    else if (it.table) out.push(spacerOf(before), tableOf(it.table, { ...ctx, left }));
    else {
      // a fill-in line on its own: an empty paragraph underlined where the line runs
      it.rule.used = true;
      out.push(new Paragraph({ spacing: { before: Math.max(0, Math.round(before * TW)), after: 0 },
        indent: { left: Math.max(0, Math.round((it.rule.from - left) * TW)), right: Math.max(0, Math.round((right - it.rule.to) * TW)) },
        border: { bottom: { ...borderOf(it.rule), space: 0 } } }));
    }
    y = Math.max(y, it.rule ? it.rule.at : wordBottom(it));
  }
  // a cell ends with a paragraph (also after a table inside it)
  if (!out.length || out.at(-1) instanceof Table) out.push(spacerOf(1));
  return { children: out, bottom: y };
}

/** A region as a borderless table, its first row starting at y: columns meet mid-gutter (room for a
 * wider stand-in font), the first starts at its items, the last reaches the margin. */
function layoutTableOf(region, ctx, { left, right, y }) {
  const colOf = (it) => region.gutters.filter(([, b]) => b <= it.x0).length;
  const all = region.bands.flatMap((b) => b.items);
  const edges = [Math.min(...all.filter((it) => colOf(it) === 0).map((it) => it.x0)), ...region.gutters.map(([a, b]) => (a + b) / 2),
    Math.max(right, ...all.map((it) => it.x1))];
  const widths = edges.slice(1).map((x, i) => Math.round((x - edges[i]) * TW));
  const rows = region.bands.map((band) => {
    const top = y; // a row's cells start where the row before ended
    const cells = widths.map((w, c) => cellOf(band.items.filter((it) => colOf(it) === c).sort((a, b) => a.top - b.top), ctx,
      { left: edges[c], right: edges[c + 1], y: top }));
    y = Math.max(band.bottom, ...cells.map((cell) => cell.bottom));
    return new TableRow({ children: cells.map(({ children }, c) => new TableCell({
      width: { size: widths[c], type: WidthType.DXA }, margins: { top: 0, bottom: 0, left: 0, right: 0 },
      borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER }, children,
    })) });
  });
  return { bottom: y, table: new Table({ rows, columnWidths: widths, layout: TableLayoutType.FIXED,
    indent: { size: Math.round((edges[0] - left) * TW), type: WidthType.DXA },
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA } }) };
}

// ---------- header and footer ----------

const FIELDS = { "{PAGE}": PageNumber.CURRENT, "{NUMPAGES}": PageNumber.TOTAL_PAGES, "{SECTIONPAGES}": PageNumber.TOTAL_PAGES_IN_SECTION };

/** A band line's text as runs in its own style, page-number fields live. */
function bandRuns({ text, line }) {
  const c = line.chars.find((ch) => ch.c.trim()) ?? line.chars[0];
  const style = { font: wordFont(c.font), size: Math.round(c.size * 2), bold: c.font.bold, italics: c.font.italic,
    color: c.color === "#000000" ? undefined : c.color.slice(1) };
  return text.split(/(\{PAGE\}|\{NUMPAGES\}|\{SECTIONPAGES\})/).filter(Boolean).map((part) => (FIELDS[part]
    ? new TextRun({ ...style, children: [FIELDS[part]] })
    : new TextRun({ ...style, text: part })));
}

/** The header or footer: lines on one row (a title left, a part name right) share a paragraph,
 * placed at the centre and right edge with tab stops, as Word's own header has them. */
function bandParagraphs(band, left, right) {
  const rows = [];
  for (const item of [...band].sort((a, b) => a.line.bbox[1] - b.line.bbox[1])) {
    const row = rows.find((r) => item.line.bbox[1] < r[0].line.bbox[3] && item.line.bbox[3] > r[0].line.bbox[1]);
    if (row) row.push(item); else rows.push([item]);
  }
  // 0: the left margin, 1: the centre, 2: the right margin
  const stopOf = ({ line: { bbox: [x0, , x1] } }) => (Math.abs((x0 + x1) / 2 - (left + right) / 2) < 8 ? 1
    : Math.abs(x1 - right) < 8 ? 2 : 0);
  const stops = [{ type: TabStopType.CENTER, position: Math.round(((right - left) / 2) * TW) },
    { type: TabStopType.RIGHT, position: Math.round((right - left) * TW) }];
  return rows.map((row) => {
    let at = 0;
    const children = row.sort((a, b) => a.line.bbox[0] - b.line.bbox[0]).flatMap((item, k) => {
      // a later piece goes to the centre if it's centred there, else to the right margin
      const stop = k ? (stopOf(item) === 1 && at < 1 ? 1 : 2) : stopOf(item);
      const tabs = Array.from({ length: stop - at }, () => new TextRun({ children: [new Tab()] }));
      at = stop;
      return [...tabs, ...bandRuns(item)];
    });
    return new Paragraph({ tabStops: stops, children });
  });
}

// ---------- document ----------

const extentOf = (bbox) => ({ top: bbox[1], bottom: bbox[3], x0: bbox[0], x1: bbox[2] });
/** Where an item ends in Word: a paragraph's Word lines are taller than the PDF's line boxes. */
const wordBottom = (it) => (!it.para || it.para.code ? it.bottom : Math.max(it.bottom,
  it.top + it.para.lines.reduce((h, l) => h + Math.max(...l.chars.map((c) => c.size)) * LINE_HEIGHT, 0)) + (it.para.ruled ?? 0));

/**
 * @param {Uint8Array} bytes a PDF
 * @returns {Promise<Uint8Array>} a .docx
 */
export async function pdfToDocx(bytes) {
  const { pages, header, footer, from, start } = analyzePdf(bytes);
  const allLines = pages.flatMap((p) => p.lines);
  const bodySize = mode(allLines.flatMap((l) => l.chars.filter((c) => c.c.trim()).map((c) => Math.round(c.size * 2) / 2))) ?? 11;
  const bodyChars = allLines.filter((l) => !isCode(l)).flatMap((l) => l.chars.filter((c) => c.c.trim()));
  const bodyFamily = mode(bodyChars.map((c) => c.font.family));
  const bodyFont = bodyChars.find((c) => c.font.family === bodyFamily)?.font ?? { family: "Arial" };
  const pdfFirst = pages[0] ?? { width: 612, height: 792 };
  // shortcut: a page bigger than Word allows (a poster) is cut down to Word's largest, not scaled
  const first = { width: Math.min(pdfFirst.width, WORD_MAX_PAGE), height: Math.min(pdfFirst.height, WORD_MAX_PAGE) };
  // margins come from the free text; when there's little of it (a page of tables under a centred
  // title, scans with a stamp at the foot), they're kept to a share of the page so there is room left
  const [maxX, maxY] = [first.width * MAX_MARGIN_SHARE, first.height * MAX_MARGIN_SHARE];
  const left = Math.min(maxX, allLines.length ? pct(allLines.map((l) => l.bbox[0]), 0.05) : 72);
  const textRight = allLines.length ? pct(allLines.map((l) => l.bbox[2]), 0.95) : first.width - 72;
  const right = Math.min(first.width - MIN_MARGIN, // tables fit inside the margins
    Math.max(first.width - maxX, textRight, ...pages.flatMap((p) => p.tables.map((t) => t.bbox[2]))));
  const firstTops = pages.map((p) => Math.min(...p.lines.map((l) => l.bbox[1]), ...p.images.filter((i) => !i.background).map((i) => i.bbox[1])));
  const top = Math.min(maxY, Math.max(18, allLines.length ? Math.min(pct(allLines.map((l) => l.bbox[1]), 0.02), pct(firstTops, 0.5)) - 4 : 72));
  // Word's last line reaches lower than the PDF's line box: half a line of room for it
  const bottom = Math.min(maxY, Math.max(18, allLines.length ? first.height - pct(allLines.map((l) => l.bbox[3]), 0.98) - 4 - bodySize / 2 : 72));

  const starts = allLines.map((l) => l.bbox[0]);
  const isIndent = (x) => starts.filter((s) => Math.abs(s - x) <= 1.5).length >= 3;
  const pageItems = pages.map((page) => [
    ...paragraphsOf(page.lines).map((para) => ({ ...extentOf(para.bbox), para })),
    ...page.images.filter((img) => !img.background).map((img) => ({ ...extentOf(img.bbox), img })),
    ...page.tables.map((table) => ({ ...extentOf(table.bbox), table })),
  ].sort((a, b) => a.top - b.top));
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
    // a page left short because what comes next (a figure and its caption) didn't fit there ended
    // where it had to; in Word, where the text before often takes less room, it may fit, so it flows
    // (text and tables split across pages, so only their first lines need the room)
    const [first, next] = pageItems[p];
    const firstBottom = first?.img && next && next.top - first.bottom < LEAD_GAP ? next.bottom : first?.bottom ?? 0;
    const needed = first ? (first.img ? firstBottom - first.top : Math.min(firstBottom - first.top, SPLIT_START)) : 0;
    const fitted = needed <= floor - ended;
    return ended < floor - prev.height * FRESH_GAP && fitted;
  };

  // pages before the first one with a header/footer (a cover) get a section of their own, without them
  const split = (header.length || footer.length) && from > 0 ? from : 0;
  const sectionChildren = [[], []];
  pages.forEach((page, p) => {
    const children = sectionChildren[p < split ? 0 : 1];
    const ctx = { bodySize, rules: page.rules, isIndent, left, pageWidth: page.width, pageHeight: page.height };
    const framed = hasBackground(p); // text over artwork stays where it is on the page, so the page can't grow
    let pageBreak = p > 0 && p !== split && startsFresh(p);
    if (framed) {
      children.push(new Paragraph({ pageBreakBefore: pageBreak || undefined,
        children: page.images.filter((img) => img.background).map(backgroundOf) }));
      pageBreak = false;
    }
    let y = top;
    // side-by-side rows become layout tables; text over a background stays framed instead
    const entries = framed ? pageItems[p] : regionsOf(pageItems[p], page.rules);
    entries.forEach((item, i) => {
      const before = item.top - y;
      const breaks = pageBreak && i === 0;
      if (item.region) {
        // Word joins tables with nothing between them; otherwise the gap goes into the first row
        const apart = breaks || entries[i - 1]?.table || entries[i - 1]?.region;
        if (apart) children.push(spacerOf(before, breaks));
        const { table, bottom } = layoutTableOf(item.region, ctx, { left, right, y: apart ? item.top : y });
        children.push(table);
        y = Math.max(y, bottom);
      } else if (item.para) {
        // a tag set on a heading's row ("BEHAVIORAL") stays with the heading's section too
        const prev = entries[i - 1];
        const keepNext = !!prev?.para && !!headingOf(prev.para, bodySize) && item.top < prev.bottom;
        children.push(...paragraphOf(item.para, ctx, { left, right, before, pageBreak: breaks, framed, keepNext }));
      } else if (item.img) {
        children.push(imageOf(item.img, { left, right, before, pageBreak: breaks, maxHeight: Math.max(MIN_MARGIN, first.height - top - bottom) }));
      } else {
        // Word merges tables with nothing between them: only a header bar flush on its table may join
        const prev = entries[i - 1]?.table;
        const joins = prev && before <= NEAR_JOIN && Math.abs(prev.bbox[0] - item.table.bbox[0]) <= NEAR_JOIN
          && Math.abs(prev.bbox[2] - item.table.bbox[2]) <= NEAR_JOIN;
        if (breaks || before > 6 || (prev && !joins) || entries[i - 1]?.region) children.push(spacerOf(before, breaks, { keepNext: true }));
        children.push(tableOf(item.table, ctx));
      }
      y = Math.max(y, wordBottom(item));
    });
  });

  // a document ending in a table gets Word's own empty last paragraph, a full line that can spill onto a new page
  for (const children of sectionChildren) if (children.at(-1) instanceof Table) children.push(spacerOf(1));
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
    // empty and spacer paragraphs take the body font too, not Word's Times New Roman
    styles: { default: { document: { run: { size: Math.round(bodySize * 2), font: wordFont(bodyFont) } } } },
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

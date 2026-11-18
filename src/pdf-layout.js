// Reads what a PDF page shows, for rebuilding it as an editable document (pdf-to-docx.js):
// text lines with their fonts, sizes and colours; pictures; tables, rebuilt from the cell borders
// and shading the page draws; rules under or over text; and the header/footer lines that repeat
// on every page. Coordinates are MuPDF page space: points, origin top-left, y down.
import * as mupdf from "mupdf";

const { Matrix } = mupdf;

const THIN = 3; // pt; a filled rectangle at most this thick is a line (how most PDFs draw borders)
const NEAR = 2; // pt; lines this close count as the same grid line
const BAND = 0.08; // the top/bottom share of a page where running headers and footers live

const apply = ([a, b, c, d, e, f], [x, y]) => [x * a + y * c + e, x * b + y * d + f];
const hexOf = (rgb) => `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;

/** A device colour as #rrggbb. */
function colorOf(colorspace, color) {
  const n = colorspace?.getNumberOfComponents?.() ?? color.length;
  if (n === 1) return hexOf([color[0], color[0], color[0]]);
  if (n === 4) { const [c, m, y, k] = color; return hexOf([(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]); }
  return hexOf(color.slice(0, 3));
}

/** A path's subpaths as point lists in page space (null marks a curved edge; `controls` holds the
 * curves' control points, so a bounding box covers the whole curve). */
function subpaths(path, ctm) {
  const out = [];
  let cur = null;
  path.walk({
    moveTo(x, y) { cur = Object.assign([apply(ctm, [x, y])], { controls: [] }); out.push(cur); },
    lineTo(x, y) { cur?.push(apply(ctm, [x, y])); },
    curveTo(x1, y1, x2, y2, x, y) {
      cur?.push(null, apply(ctm, [x, y]));
      cur?.controls.push(apply(ctm, [x1, y1]), apply(ctm, [x2, y2]));
    },
    closePath() { if (cur?.length) cur.push(cur[0]); },
  });
  return out;
}

const boundsOf = (pts) => {
  const all = [...pts.filter(Boolean), ...(pts.controls ?? [])];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const closedPath = (pts) => {
  const [a, b] = [pts[0], pts.at(-1)];
  return pts.length > 2 && !!a && !!b && Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;
};
/** Whether a subpath has an edge that is neither horizontal nor vertical (or is curved). */
const slanted = (pts) => pts.some((p, i) => i > 0 && (!p || !pts[i - 1]
  || (Math.abs(p[0] - pts[i - 1][0]) > 0.5 && Math.abs(p[1] - pts[i - 1][1]) > 0.5)));

const axisRect = (pts) => {
  if (pts.includes(null) || pts.length < 4 || pts.length > 5) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const onEdge = pts.every(([x, y]) => (Math.abs(x - x0) < 0.5 || Math.abs(x - x1) < 0.5) && (Math.abs(y - y0) < 0.5 || Math.abs(y - y1) < 0.5));
  return onEdge ? [x0, y0, x1, y1] : null;
};

/** The page's straight lines (as segments), filled boxes, and the bounds of everything slanted or
 * curved (arrows, circles, connectors: the marks of a diagram), from its drawing commands. */
function vectorsOf(page) {
  const segments = []; // {dir: "h"|"v", at, from, to, width, color}
  const boxes = []; // {rect, color}
  const shapes = []; // bounding boxes of slanted/curved subpaths
  const asLine = ([x0, y0, x1, y1], color) => {
    if (y1 - y0 <= THIN && x1 - x0 > y1 - y0) return { dir: "h", at: (y0 + y1) / 2, from: x0, to: x1, width: Math.max(0.25, y1 - y0), color };
    if (x1 - x0 <= THIN) return { dir: "v", at: (x0 + x1) / 2, from: y0, to: y1, width: Math.max(0.25, x1 - x0), color };
    return null;
  };
  // what's drawn counts only where it shows: a big box clipped to a sliver is a bar
  const clips = [page.getBounds()];
  const clip = () => clips.at(-1);
  const cut = ([a, b, c, d]) => {
    const [x0, y0, x1, y1] = clip();
    const r = [Math.max(a, x0), Math.max(b, y0), Math.min(c, x1), Math.min(d, y1)];
    return r[0] <= r[2] && r[1] <= r[3] ? r : null;
  };
  const pushClip = (bounds) => clips.push(bounds ? (cut(bounds) ?? [0, 0, 0, 0]) : clip());
  const addSegment = (s) => {
    const [x0, y0, x1, y1] = clip();
    const [lo, hi] = s.dir === "h" ? [x0, x1] : [y0, y1];
    const [across0, across1] = s.dir === "h" ? [y0, y1] : [x0, x1];
    if (s.at < across0 || s.at > across1) return;
    const [from, to] = [Math.max(s.from, lo), Math.min(s.to, hi)];
    if (to - from > 1) segments.push({ ...s, from, to });
  };
  const device = new mupdf.Device({
    fillPath(path, evenOdd, ctm, colorspace, color, alpha) {
      if (alpha < 0.1) return;
      const c = colorOf(colorspace, color);
      for (const pts of subpaths(path, ctm)) {
        if (slanted(pts)) {
          const bbox = cut(boundsOf(pts));
          if (bbox) shapes.push({ bbox, closed: closedPath(pts), fill: c });
        }
        const rect = axisRect(pts) && cut(axisRect(pts));
        if (!rect) continue;
        const line = asLine(rect, c);
        if (line) segments.push(line);
        else boxes.push({ rect, color: c });
      }
    },
    strokePath(path, stroke, ctm, colorspace, color, alpha) {
      if (alpha < 0.1) return;
      const c = colorOf(colorspace, color);
      const width = Math.max(0.25, (stroke.getLineWidth?.() ?? 1) * (Math.hypot(ctm[0], ctm[1]) || 1));
      for (const pts of subpaths(path, ctm)) {
        if (slanted(pts)) {
          const bbox = cut(boundsOf(pts));
          if (bbox) shapes.push({ bbox, closed: closedPath(pts) });
        }
        for (let i = 1; i < pts.length; i++) {
          const [p, q] = [pts[i - 1], pts[i]];
          if (!p || !q) continue;
          if (Math.abs(p[1] - q[1]) < 0.5 && Math.abs(p[0] - q[0]) > 1) {
            addSegment({ dir: "h", at: p[1], from: Math.min(p[0], q[0]), to: Math.max(p[0], q[0]), width, color: c });
          } else if (Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) > 1) {
            addSegment({ dir: "v", at: p[0], from: Math.min(p[1], q[1]), to: Math.max(p[1], q[1]), width, color: c });
          }
        }
      }
    },
    clipPath(path, evenOdd, ctm) { pushClip(path.getBounds(null, ctm)); },
    clipStrokePath(path, stroke, ctm) { pushClip(path.getBounds(stroke, ctm)); },
    clipText() { pushClip(null); }, // shortcut: text clips keep the current area
    clipStrokeText() { pushClip(null); },
    clipImageMask() { pushClip(null); },
    endMask() { pushClip(null); }, // a soft mask is popped like a clip
    popClip() { if (clips.length > 1) clips.pop(); },
  });
  page.run(device, Matrix.identity);
  device.close();
  return { segments, boxes, shapes };
}

// ---------- figures ----------

const FIGURE_GAP = 8; // pt; diagram marks this close belong to the same figure
const FIGURE_JOIN = 3; // pt; a box or line this close to a figure is part of it
const FIGURE_MIN = 24; // pt; smaller clusters (a lone arrow, a bullet) aren't figures
const FIGURE_DPI_SCALE = 2; // figures are pictured at 144 dpi
const BACKGROUND_SHARE = 0.4; // a figure over this share of the page is background art

const touches = (a, b, gap) => a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Regions of the page holding vector diagrams. A figure starts from slanted or curved marks with
 * no text inside (arrows, connectors, inheritance triangles) and grows to take in the lines, boxes
 * and labelled shapes they touch (class boxes, state circles). A curved shape with text inside
 * (a badge, a pill, a rounded panel) never starts one, and a box enclosing the figure (the panel
 * it sits in) never joins it, so headings and callouts stay editable text. Text in a figure is
 * part of its picture. */
function figuresOf({ shapes, segments, boxes }, lines, pageArea) {
  const segBox = (s) => (s.dir === "h" ? [s.from, s.at, s.to, s.at] : [s.at, s.from, s.at, s.to]);
  const small = (b) => (b[2] - b[0]) * (b[3] - b[1]) < pageArea * 0.5; // not a page background
  const holdsText = (b) => lines.some((l) => inside(b, center(l.bbox)));
  const labelled = shapes.filter((s) => s.closed && holdsText(s.bbox));
  const parts = [...segments.map(segBox), ...boxes.map((b) => b.rect), ...labelled.map((s) => s.bbox)].filter(small);
  let regions = shapes.filter((s) => !labelled.includes(s) && small(s.bbox)).map((s) => [...s.bbox]);
  for (let changed = true; changed;) {
    changed = false;
    // merge regions that touch, and grow them by the boxes and lines they touch
    const merged = [];
    for (const r of regions) {
      const hit = merged.find((m) => touches(m, r, FIGURE_GAP));
      if (hit) { Object.assign(hit, union(hit, r)); changed = true; } else merged.push([...r]);
    }
    for (const m of merged) {
      for (const p of parts) {
        // a box or line joins a figure it touches, unless it encloses the figure (the panel it sits in)
        const encloses = p[0] <= m[0] + 1 && p[1] <= m[1] + 1 && p[2] >= m[2] - 1 && p[3] >= m[3] - 1;
        if (touches(m, p, FIGURE_JOIN) && (p[0] < m[0] || p[1] < m[1] || p[2] > m[2] || p[3] > m[3]) && !encloses) {
          Object.assign(m, union(m, p));
          changed = true;
        }
      }
    }
    regions = merged;
  }
  return regions.filter((r) => r[2] - r[0] >= FIGURE_MIN && r[3] - r[1] >= FIGURE_MIN);
}

const TEXT_CALLS = new Set(["fillText", "strokeText", "ignoreText"]);
const DEVICE_CALLS = ["fillPath", "strokePath", "clipPath", "clipStrokePath", "fillText", "strokeText", "clipText",
  "clipStrokeText", "ignoreText", "fillShade", "fillImage", "fillImageMask", "clipImageMask", "popClip", "beginMask",
  "endMask", "beginGroup", "endGroup", "beginTile", "endTile", "beginLayer", "endLayer"];

/** The region of the page as a PNG, drawn the way the page shows it; with withText false, the
 * text is left out (for a background the text is laid over as editable paragraphs). */
function picture(page, [x0, y0, x1, y1], { withText = true } = {}) {
  const s = FIGURE_DPI_SCALE;
  const box = [Math.floor(x0 * s), Math.floor(y0 * s), Math.ceil(x1 * s), Math.ceil(y1 * s)];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, false);
  pix.clear(255);
  const draw = new mupdf.DrawDevice(Matrix.scale(s, s), pix);
  // every drawing call goes on to the draw device, except text when it's left out
  const device = withText ? draw : new mupdf.Device(Object.fromEntries(DEVICE_CALLS
    .filter((name) => !TEXT_CALLS.has(name)).map((name) => [name, (...args) => draw[name](...args)])));
  page.run(device, Matrix.identity);
  device.close();
  if (device !== draw) draw.close();
  return { bbox: [x0, y0, x1, y1], png: pix.asPNG(), figure: true, background: !withText };
}

/** Font facts from MuPDF's font object and its name ("ABCDEF+Carlito-BoldItalic" -> Carlito). */
function fontOf(font) {
  const name = font.getName().replace(/^[A-Z]{6}\+/, "");
  const family = name.replace(/[-,](Bold|Italic|Oblique|Regular|Roman|Medium|Light|Semibold|SemiBold|Black|Book)+.*$/i, "")
    .replace(/(MT|PS)$/, "").replace(/([a-z])(?<!Deja)([A-Z])/g, "$1 $2").trim() || name; // "DejaVu" is one word
  return {
    family,
    bold: font.isBold() || /bold|black|heavy|semibold/i.test(name),
    italic: font.isItalic() || /italic|oblique/i.test(name),
    mono: font.isMono?.() || /mono|courier|consolas|code/i.test(name),
    serif: font.isSerif?.() ?? false,
  };
}

/** Text lines and pictures, in MuPDF's reading order. */
function contentOf(page) {
  const lines = [];
  const images = [];
  let block = -1;
  let line = null;
  page.toStructuredText("preserve-images,preserve-whitespace").walk({
    onImageBlock(bbox, transform, image) {
      try {
        let pix = image.toPixmap();
        const n = pix.getColorSpace()?.getNumberOfComponents();
        if (n && n !== 1 && n !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
        images.push({ bbox: [...bbox], png: pix.asPNG() });
      } catch {
        // a picture MuPDF can't decode is left out rather than failing the whole conversion
      }
    },
    beginTextBlock() { block++; },
    beginLine(bbox, wmode) { line = { bbox: [...bbox], block, vertical: wmode === 1, chars: [] }; },
    onChar(c, origin, font, size, quad, color) {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      line.chars.push({ c, font: fontOf(font), size, color: colorOf(null, color), x0: Math.min(...xs), x1: Math.max(...xs), baseline: origin[1] });
    },
    endLine() {
      if (line.chars.some((ch) => ch.c.trim())) lines.push({ ...line, text: line.chars.map((ch) => ch.c).join("") });
    },
  });
  return { lines, images };
}

// ---------- tables ----------

function cluster(values) {
  const out = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length && v - out.at(-1).at(-1) <= NEAR) out.at(-1).push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

/** Groups of segments that touch each other (union-find on their boxes). */
function connected(segments) {
  const parent = segments.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const boxes = segments.map((s) => (s.dir === "h" ? [s.from, s.at, s.to, s.at] : [s.at, s.from, s.at, s.to]));
  // shortcut: pairwise, O(n²); fine for the few hundred lines a page has, sweep if pages get huge
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      if (a[0] - NEAR <= b[2] && b[0] - NEAR <= a[2] && a[1] - NEAR <= b[3] && b[1] - NEAR <= a[3]) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  segments.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));
  return [...groups.values()];
}

/** Tables: grids of at least 2 horizontal and 2 vertical lines; a missing inner border merges cells. */
function tablesOf(segments, boxes) {
  const tables = [];
  for (const group of connected(segments)) {
    const hs = group.filter((s) => s.dir === "h");
    const vs = group.filter((s) => s.dir === "v");
    if (hs.length < 2 || vs.length < 2) continue;
    const xs = cluster(vs.map((s) => s.at));
    const ys = cluster(hs.map((s) => s.at));
    if (xs.length < 2 || ys.length < 2) continue;
    /** The line along `at` from `from` to `to`, if drawn (in one piece or several, as cell by cell). */
    const edge = (list, at, from, to) => {
      const parts = list.filter((s) => Math.abs(s.at - at) <= NEAR && Math.min(s.to, to) > Math.max(s.from, from));
      const covered = parts.reduce((n, s) => n + Math.min(s.to, to) - Math.max(s.from, from), 0);
      return covered >= (to - from) * 0.7 ? parts[0] : undefined;
    };
    const side = (list, at, from, to) => {
      const s = edge(list, at, from, to);
      return s ? { width: s.width, color: s.color } : null;
    };
    const taken = new Set();
    const cells = [];
    for (let r = 0; r < ys.length - 1; r++) {
      for (let c = 0; c < xs.length - 1; c++) {
        if (taken.has(`${r}:${c}`)) continue;
        let colSpan = 1;
        while (c + colSpan < xs.length - 1 && !edge(vs, xs[c + colSpan], ys[r], ys[r + 1])) colSpan++;
        let rowSpan = 1;
        while (r + rowSpan < ys.length - 1 && !edge(hs, ys[r + rowSpan], xs[c], xs[c + colSpan])) rowSpan++;
        for (let i = 0; i < rowSpan; i++) for (let j = 0; j < colSpan; j++) taken.add(`${r + i}:${c + j}`);
        const rect = [xs[c], ys[r], xs[c + colSpan], ys[r + rowSpan]];
        const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
        const overlap = (b) => Math.max(0, Math.min(b[2], rect[2]) - Math.max(b[0], rect[0]))
          * Math.max(0, Math.min(b[3], rect[3]) - Math.max(b[1], rect[1]));
        const fill = boxes.find(({ rect: b, color }) => color !== "#ffffff" && overlap(b) >= area * 0.8);
        cells.push({
          row: r, col: c, rowSpan, colSpan, rect,
          borders: {
            top: side(hs, rect[1], rect[0], rect[2]), bottom: side(hs, rect[3], rect[0], rect[2]),
            left: side(vs, rect[0], rect[1], rect[3]), right: side(vs, rect[2], rect[1], rect[3]),
          },
          fill: fill?.color ?? null, lines: [], images: [],
        });
      }
    }
    tables.push({ bbox: [xs[0], ys[0], xs.at(-1), ys.at(-1)], xs, ys, cells, segments: group });
  }
  return tables;
}

const RULED_MIN_WIDTH = 100; // pt; row lines/bars narrower than this don't make a table
const RULED_EDGE_SLACK = 10; // pt; a rounded outer border starts its straight part a little inside
const RULED_MAX_ROW = 120; // pt; a taller gap between row lines ends the table

/**
 * Tables drawn without column lines (the common "zebra" style): rows marked by stacked horizontal
 * lines and full-width coloured bars of the same width, columns by where the rows' text starts.
 * At least two rows and two columns, or it's just a box around text.
 */
/** Horizontal pieces on one line that touch end to end, joined into one (keeping the pieces:
 * where they meet are the column boundaries of a table drawn cell by cell). */
function joinPieces(pieces) {
  const out = [];
  for (const p of [...pieces].sort((a, b) => a.at - b.at || a.from - b.from)) {
    const last = out.findLast((o) => Math.abs(o.at - p.at) <= 0.5 && p.from <= o.to + 1 && (o.line ? 1 : 0) === (p.line ? 1 : 0));
    if (last) { last.to = Math.max(last.to, p.to); last.pieces.push(p); } else out.push({ ...p, pieces: [p] });
  }
  return out;
}

function ruledTablesOf(segments, boxes, lines) {
  const rows = boxes.filter((b) => b.color !== "#ffffff" && b.rect[3] - b.rect[1] < RULED_MAX_ROW);
  const edges = joinPieces([
    ...segments.filter((s) => s.dir === "h").map((s) => ({ at: s.at, from: s.from, to: s.to, line: s })),
    ...rows.flatMap((b) => [{ at: b.rect[1], from: b.rect[0], to: b.rect[2] }, { at: b.rect[3], from: b.rect[0], to: b.rect[2] }]),
  ]).filter((e) => e.to - e.from >= RULED_MIN_WIDTH).sort((a, b) => a.at - b.at);
  // runs of edges with the same left and right ends, stacked without big gaps
  const groups = [];
  for (const e of edges) {
    const g = groups.find((x) => Math.abs(x.from - e.from) <= RULED_EDGE_SLACK && Math.abs(x.to - e.to) <= RULED_EDGE_SLACK && e.at - x.edges.at(-1).at <= RULED_MAX_ROW);
    if (g) g.edges.push(e); else groups.push({ from: e.from, to: e.to, edges: [e] });
  }
  const tables = [];
  for (const g of groups) {
    const ys = cluster(g.edges.map((e) => e.at));
    if (ys.length < 3) continue;
    const bbox = [g.from, ys[0], g.to, ys.at(-1)];
    const rowOf = (l) => ys.findIndex((y, i) => i < ys.length - 1 && center(l.bbox)[1] >= y && center(l.bbox)[1] <= ys[i + 1]);
    const rowLines = lines.filter((l) => inside(bbox, center(l.bbox)));
    // a column starts where text starts in at least two rows (or in every row of a two-row table)
    const startRows = new Map();
    for (const l of rowLines) {
      const x = Math.round(l.bbox[0]);
      const key = [...startRows.keys()].find((k) => Math.abs(k - x) <= 3) ?? x;
      startRows.set(key, new Set([...(startRows.get(key) ?? []), rowOf(l)]));
    }
    const starts = [...startRows].filter(([, rows]) => rows.size >= Math.min(2, ys.length - 1)).map(([x]) => x).sort((a, b) => a - b);
    // where a row's pieces meet is a column boundary (when the table is drawn cell by cell)
    const joints = cluster(g.edges.flatMap((e) => e.pieces.slice(1).map((p) => p.from)))
      .filter((x) => g.edges.filter((e) => e.pieces.some((p) => Math.abs(p.from - x) <= NEAR)).length >= 2);
    const inner = joints.length ? joints : starts.slice(1).map((s) => s - 4);
    if (!inner.length) continue;
    const xs = [g.from, ...inner.filter((x) => x > g.from + NEAR && x < g.to - NEAR).sort((a, b) => a - b), g.to];
    if (xs.length < 3) continue;
    const lineAt = (y) => g.edges.find((e) => e.line && Math.abs(e.at - y) <= NEAR)?.pieces[0].line;
    const cells = [];
    for (let r = 0; r < ys.length - 1; r++) {
      for (let c = 0; c < xs.length - 1; c++) {
        const rect = [xs[c], ys[r], xs[c + 1], ys[r + 1]];
        const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
        const overlap = (b) => Math.max(0, Math.min(b[2], rect[2]) - Math.max(b[0], rect[0]))
          * Math.max(0, Math.min(b[3], rect[3]) - Math.max(b[1], rect[1]));
        const fill = boxes.find(({ rect: b, color }) => color !== "#ffffff" && overlap(b) >= area * 0.8);
        const side = (s) => (s ? { width: s.width, color: s.color } : null);
        cells.push({ row: r, col: c, rowSpan: 1, colSpan: 1, rect,
          borders: { top: side(lineAt(ys[r])), bottom: side(lineAt(ys[r + 1])), left: null, right: null },
          fill: fill?.color ?? null, lines: [], images: [] });
      }
    }
    tables.push({ bbox, xs, ys, cells, segments: g.edges.filter((e) => e.line).flatMap((e) => e.pieces.map((p) => p.line)) });
  }
  return tables;
}

const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const inside = (r, [x, y]) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const areaOf = (r) => (r[2] - r[0]) * (r[3] - r[1]);

// ---------- coloured boxes ----------

const EDGE_NEAR = 4; // pt; a border or accent bar this close to a box's edge belongs to it
const EDGE_COVER = 0.6; // share of a box's side a line must run along to be that side's border
const COLUMN_PAD = 4; // pt; a header bar's column starts this far left of its text
const BAR = 6; // pt; a filled box this thin along a box's side is its accent bar (Word borders go up to 6pt)
const ROW_GAP_MAX = 24; // pt; boxes side by side closer than this are one row (header cells, cards)

/**
 * Coloured boxes with text in them (callouts, header bars, badges, tags): filled shapes, square or
 * rounded, holding whole lines. Each becomes a one-row table, so Word keeps the fill behind its
 * text (white text stays readable) and the box grows with the text. The smallest box wins a line:
 * a box inside another keeps its text and the outer one is dropped. Lines side by side in one row
 * (a header bar) get a column each; borders and accent bars along the box's sides are kept.
 * shortcut: rounded corners become square and gradients (fillShade) aren't seen; picture a box
 * (option 1 in CLAUDE.md) if its look matters.
 */
function boxTablesOf({ shapes, boxes, segments }, lines, images, pageArea, taken) {
  const overlaps = (r, b) => Math.min(r[2], b[2]) - Math.max(r[0], b[0]) > 1 && Math.min(r[3], b[3]) - Math.max(r[1], b[1]) > 1;
  const fills = [...shapes.filter((s) => s.closed && s.fill).map((s) => ({ rect: s.bbox, color: s.fill })), ...boxes]
    .filter((b) => b.color !== "#ffffff" && areaOf(b.rect) < pageArea * 0.5 && !taken(b.rect))
    .sort((a, b) => areaOf(a.rect) - areaOf(b.rect));
  // borders and accent bars: thin lines, and thin filled boxes, as segments along their length
  const edges = [...segments, ...boxes.flatMap(({ rect: [x0, y0, x1, y1], color }) => {
    if (x1 - x0 <= BAR && y1 - y0 > x1 - x0) return [{ dir: "v", at: (x0 + x1) / 2, from: y0, to: y1, width: x1 - x0, color }];
    if (y1 - y0 <= BAR && x1 - x0 > y1 - y0) return [{ dir: "h", at: (y0 + y1) / 2, from: x0, to: x1, width: y1 - y0, color }];
    return [];
  })];
  const claimed = new Set();
  const tables = [];
  for (const { rect, color } of fills) {
    const within = (l) => l.bbox[0] >= rect[0] - 2 && l.bbox[2] <= rect[2] + 2;
    const held = lines.filter((l) => inside(rect, center(l.bbox)));
    // a box must hold whole lines: one that a line runs out of is a highlight or badge in that line
    if (!held.length || held.some((l) => claimed.has(l) || !within(l))) continue;
    if (lines.some((l) => !held.includes(l) && overlaps(rect, l.bbox))) continue;
    held.forEach((l) => claimed.add(l));
    const oneRow = held.length > 1 && held.every((l) => l.bbox[1] < held[0].bbox[3] && l.bbox[3] > held[0].bbox[1]);
    const starts = oneRow ? held.map((l) => l.bbox[0] - COLUMN_PAD).filter((x) => x > rect[0] + COLUMN_PAD).sort((a, b) => a - b) : [];
    const xs = [rect[0], ...starts, rect[2]];
    const ys = [rect[1], rect[3]];
    const along = (dir, at, from, to) => edges.find((s) => s.dir === dir && Math.abs(s.at - at) <= EDGE_NEAR
      && Math.min(s.to, to) - Math.max(s.from, from) >= (to - from) * EDGE_COVER);
    const side = (s) => (s ? { width: s.width, color: s.color } : null);
    const [top, bottom] = [along("h", rect[1], rect[0], rect[2]), along("h", rect[3], rect[0], rect[2])];
    const [left, right] = [along("v", rect[0], rect[1], rect[3]), along("v", rect[2], rect[1], rect[3])];
    const cells = xs.slice(1).map((x1, c) => {
      const r = [xs[c], rect[1], x1, rect[3]];
      return { row: 0, col: c, rowSpan: 1, colSpan: 1, rect: r, fill: color,
        borders: { top: side(top), bottom: side(bottom), left: c === 0 ? side(left) : null, right: c === xs.length - 2 ? side(right) : null },
        lines: held.filter((l) => inside(r, center(l.bbox))), images: images.filter((img) => inside(r, center(img.bbox))) };
    });
    tables.push({ bbox: [...rect], xs, ys, cells, segments: [top, bottom, left, right].filter(Boolean), box: true });
  }
  return rowsOfBoxes(tables);
}

/** Boxes side by side with the same top and bottom (a header row drawn cell by cell, a row of
 * cards) joined into one table, with an empty cell for each gap, so Word keeps them in one row. */
function rowsOfBoxes(tables) {
  const rows = [];
  for (const t of [...tables].sort((a, b) => a.bbox[0] - b.bbox[0])) {
    const row = rows.find((r) => Math.abs(r.ys[0] - t.ys[0]) <= NEAR && Math.abs(r.ys[1] - t.ys[1]) <= NEAR
      && t.bbox[0] >= r.bbox[2] - NEAR && t.bbox[0] - r.bbox[2] <= ROW_GAP_MAX);
    if (!row) { rows.push({ ...t, xs: [...t.xs], cells: [...t.cells] }); continue; }
    const gap = t.bbox[0] - row.bbox[2] > NEAR;
    const at = row.xs.length - 1 + (gap ? 1 : 0); // the column t's first cell lands in
    if (gap) {
      row.cells.push({ row: 0, col: row.xs.length - 1, rowSpan: 1, colSpan: 1, rect: [row.bbox[2], row.ys[0], t.bbox[0], row.ys[1]],
        fill: null, borders: { top: null, bottom: null, left: null, right: null }, lines: [], images: [] });
      row.xs.push(t.bbox[0]);
    }
    row.cells.push(...t.cells.map((c) => ({ ...c, col: c.col + at })));
    row.xs.push(...t.xs.slice(1));
    row.segments = [...row.segments, ...t.segments];
    row.bbox = union(row.bbox, t.bbox);
  }
  return rows;
}

const ROW_GAP = 1.5; // in font sizes; pieces of text on one baseline closer than this are one line

/** Pieces MuPDF reads as separate lines but that sit on one baseline close together (a numbered
 * badge and its text, a label and its value) joined into one line, left to right. */
function joinRows(lines) {
  const baseline = (l) => l.chars.find((c) => c.c.trim())?.baseline ?? l.bbox[3];
  const sizeOf = (l) => Math.max(...l.chars.map((c) => c.size));
  const out = [];
  for (const line of [...lines].sort((a, b) => a.bbox[0] - b.bbox[0])) {
    const left = out.find((o) => !o.vertical && !line.vertical && Math.abs(baseline(o) - baseline(line)) <= 2
      && line.bbox[0] - o.bbox[2] >= -1 && line.bbox[0] - o.bbox[2] <= ROW_GAP * Math.max(sizeOf(o), sizeOf(line)));
    if (!left) { out.push(line); continue; }
    const space = { ...left.chars.at(-1), c: " ", x0: left.bbox[2], x1: line.bbox[0] };
    Object.assign(left, {
      chars: [...left.chars, space, ...line.chars], text: `${left.text} ${line.text}`,
      bbox: [left.bbox[0], Math.min(left.bbox[1], line.bbox[1]), line.bbox[2], Math.max(left.bbox[3], line.bbox[3])],
    });
  }
  // back in reading order (MuPDF's), by the position of each joined line's first piece
  return lines.filter((l) => out.includes(l));
}

/** Inline code's background (the grey pill behind `getInstance()` in a sentence), kept on its
 * characters as `bg`. A line that is all code is a listing: its box becomes a table instead. */
function shadeInlineCode(lines, { shapes, boxes }) {
  const fills = [...shapes.filter((s) => s.closed && s.fill).map((s) => ({ rect: s.bbox, color: s.fill })), ...boxes]
    .filter((f) => f.color !== "#ffffff");
  for (const line of lines) {
    if (line.chars.every((c) => !c.c.trim() || c.font.mono)) continue;
    for (const c of line.chars) {
      if (!c.font.mono) continue;
      const pill = fills.find(({ rect }) => rect[3] - rect[1] < c.size * 2.5 && inside(rect, [(c.x0 + c.x1) / 2, c.baseline - c.size * 0.3]));
      if (pill) c.bg = pill.color;
    }
  }
}

// ---------- headers and footers ----------

const normalized = (text) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** Lines in the top/bottom band that repeat on most pages: removed from the pages, returned once. */
function bandsOf(pages) {
  const bands = { header: [], footer: [] };
  if (pages.length < 2) return bands;
  const where = (p, l) => (l.bbox[3] < p.height * BAND ? "header" : l.bbox[1] > p.height * (1 - BAND) ? "footer" : null);
  const keyOf = (p, l) => where(p, l) && `${where(p, l)}|${normalized(l.text)}`;
  const counts = new Map();
  for (const p of pages) {
    for (const key of new Set(p.lines.map((l) => keyOf(p, l)).filter(Boolean))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = new Set([...counts].filter(([, n]) => n >= Math.max(2, pages.length * 0.6)).map(([k]) => k));
  // for each repeated line, its numbers on every page it's on: [{page, numbers}]
  const numbersOf = new Map();
  pages.forEach((p, i) => p.lines.forEach((l) => {
    const key = keyOf(p, l);
    if (repeated.has(key)) numbersOf.set(key, [...(numbersOf.get(key) ?? []), { page: i, numbers: (l.text.match(/\d+/g) ?? []).map(Number) }]);
  }));
  /** A number that is this page's number on every page becomes {PAGE}; the page count, {NUMPAGES}. */
  const fieldAt = (key, k) => {
    const seen = numbersOf.get(key);
    if (seen.every((s) => s.numbers[k] === s.page + 1) && new Set(seen.map((s) => s.numbers[k])).size > 1) return "{PAGE}";
    if (seen.every((s) => s.numbers[k] === pages.length)) return "{NUMPAGES}";
    return null;
  };
  pages.forEach((p) => {
    const kept = [];
    for (const l of p.lines) {
      const key = keyOf(p, l);
      if (!repeated.has(key)) { kept.push(l); continue; }
      const kind = where(p, l);
      if (bands[kind].some((b) => b.key === key)) continue;
      let k = 0;
      const text = l.text.replace(/\d+/g, (d) => fieldAt(key, k++) ?? d);
      bands[kind].push({ key, text: text.trim(), line: l, page: p });
    }
    p.lines = kept;
  });
  return bands;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{pages: {width: number, height: number, lines: object[], images: object[], tables: object[], rules: object[]}[],
 *   header: {text: string, line: object, page: object}[], footer: {text: string, line: object, page: object}[]}}
 *   lines are {bbox, block, text, chars: [{c, font: {family, bold, italic, mono, serif}, size, color, x0, x1, baseline, bg?}]}
 */
export function analyzePdf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    if (doc.needsPassword()) throw new Error("Quire can't convert password-protected PDFs yet.");
    const pages = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      const content = contentOf(page);
      const vectors = vectorsOf(page);
      shadeInlineCode(content.lines, vectors);
      const pageArea = (x1 - x0) * (y1 - y0);
      const found = figuresOf(vectors, content.lines, pageArea)
        .map(([a, b, c, d]) => [Math.max(x0, a - 2), Math.max(y0, b - 2), Math.min(x1, c + 2), Math.min(y1, d + 2)]);
      // a figure covering much of the page is artwork behind the text: it's pictured without its
      // text, and the text stays editable on top. A smaller one (a diagram) is pictured whole.
      const isBackground = (f) => (f[2] - f[0]) * (f[3] - f[1]) > pageArea * BACKGROUND_SHARE;
      const diagrams = found.filter((f) => !isBackground(f));
      const inDiagram = (b) => diagrams.some((f) => inside(f, center(b)));
      const inAnyFigure = (b) => found.some((f) => inside(f, center(b)));
      const lines = content.lines.filter((l) => !inDiagram(l.bbox));
      const images = [...content.images.filter((img) => !inAnyFigure(img.bbox)),
        ...found.map((f) => picture(page, f, { withText: !isBackground(f) }))];
      const inFigure = inAnyFigure;
      const segments = vectors.segments.filter((s) => !inFigure(s.dir === "h" ? [s.from, s.at, s.to, s.at] : [s.at, s.from, s.at, s.to]));
      const boxes = vectors.boxes.filter((b) => !inFigure(b.rect));
      // a one-cell "grid" is just a box drawn around something; look for tables inside it first
      const allGrids = tablesOf(segments, boxes);
      const grids = allGrids.filter((t) => t.cells.length > 1);
      const inGrid = (b) => grids.some((t) => inside(t.bbox, center(b)));
      const gridSegments = new Set(grids.flatMap((t) => t.segments));
      const ruled = ruledTablesOf(segments.filter((s) => !gridSegments.has(s)), boxes.filter((b) => !inGrid(b.rect)),
        lines.filter((l) => !inGrid(l.bbox)));
      const holdsTable = (box) => [...grids, ...ruled].some((t) => inside(box.bbox, center(t.bbox)));
      const tables = [...grids, ...ruled, ...allGrids.filter((t) => t.cells.length === 1 && !holdsTable(t))];
      const cellAt = (b) => {
        const p = center(b);
        return tables.find((t) => inside(t.bbox, p))?.cells.find((c) => inside(c.rect, p));
      };
      for (const l of lines) cellAt(l.bbox)?.lines.push(l);
      for (const img of images) cellAt(img.bbox)?.images.push(img);
      const freeLines = joinRows(lines.filter((l) => !cellAt(l.bbox)));
      const freeImages = images.filter((img) => !cellAt(img.bbox));
      // a box inside a table or diagram is part of it; one around a table or diagram is just a panel
      const solid = [...tables.map((t) => t.bbox), ...diagrams];
      const taken = (r) => solid.some((b) => inside(b, center(r)) || inside(r, center(b)));
      const boxTables = boxTablesOf(vectors, freeLines, freeImages.filter((img) => !img.figure), pageArea, taken);
      const inBox = (b) => boxTables.some((t) => t.cells.some((c) => c.lines.some((l) => l.bbox === b) || c.images.some((i) => i.bbox === b)));
      tables.push(...boxTables);
      const tableSegments = new Set(tables.flatMap((t) => t.segments));
      pages.push({
        width: x1 - x0, height: y1 - y0,
        lines: freeLines.filter((l) => !inBox(l.bbox)),
        images: freeImages.filter((img) => !inBox(img.bbox)),
        tables,
        rules: segments.filter((s) => s.dir === "h" && !tableSegments.has(s) && s.to - s.from > 20),
      });
    }
    return { pages, ...bandsOf(pages) };
  } finally {
    doc.destroy();
  }
}

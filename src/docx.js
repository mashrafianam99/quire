// Word (.docx) to XHTML that MuPDF's HTML engine lays out into pages. Keeps what a reader sees:
// styles (Normal, headings), bold/italic/underline/strike, sizes, colours, fonts, super/subscript,
// alignment, spacing, indents, paragraph borders and shading, page breaks, bullet/number lists,
// tables (borders, shading, padding, widths, merged cells) and inline/floating pictures.
// Headers and footers come back as plain lines with {PAGE} / {NUMPAGES} fields, to stamp later.
//
// Units: twips/20 = pt, half-points/2 = pt, eighths of a point/8 = pt, EMU/12700 = pt.

// ---------- zip ----------

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** The entries of a zip archive: name -> () => Promise<Uint8Array>. */
export function unzip(bytes) {
  let eocd = bytes.length - 22;
  while (eocd >= 0 && u32(bytes, eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip archive");
  // shortcut: no ZIP64 (archives over 4 GB or 65535 entries); Word files don't get there
  const entries = new Map();
  let p = u32(bytes, eocd + 16);
  for (let n = u16(bytes, eocd + 10); n > 0; n--) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error("damaged zip directory");
    const [method, size, nameLen] = [u16(bytes, p + 10), u32(bytes, p + 20), u16(bytes, p + 28)];
    const local = u32(bytes, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
    entries.set(name, async () => {
      const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`unsupported zip compression ${method}`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  }
  return entries;
}

// ---------- XML helpers (namespace prefixes ignored; Word's names don't collide where we look) ----------

const kids = (el, name) => [...(el?.childNodes ?? [])].filter((n) => n.nodeType === 1 && (!name || n.localName === name));
const kid = (el, name) => kids(el, name)[0];
const attr = (el, name) => {
  for (const a of el?.attributes ?? []) if (a.localName === name) return a.value;
  return null;
};
const val = (el, name) => attr(kid(el, name), "val");
const num = (s) => (s == null || s === "" ? null : Number.parseFloat(s));
/** A Word on/off property: undefined when absent, else whether it is on. */
const on = (el, name) => {
  const k = kid(el, name);
  if (!k) return undefined;
  const v = attr(k, "val");
  return v == null || !["0", "false", "off", "none"].includes(v);
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === "#"
  ? String.fromCodePoint(e[1].toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : ENTITIES[e] ?? m));
const localName = (q) => q.slice(q.indexOf(":") + 1);

/**
 * A small XML reader for Word's well-formed parts (same in the browser and in Node, which has no
 * DOMParser). Nodes: {nodeType: 1, localName, attributes: [{localName, value}], childNodes} for
 * elements, {nodeType: 3, text} for text. CDATA, comments and processing instructions are skipped.
 */
function parseXml(xml) {
  const root = { nodeType: 1, localName: "#document", attributes: [], childNodes: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.childNodes.push({ nodeType: 3, text: m[1] });
    else if (m[2]) stack.length > 1 && stack.pop();
    else if (m[3]) {
      const attributes = [...m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
        .map((a) => ({ localName: localName(a[1]), value: decode(a[2] ?? a[3]) }));
      const el = { nodeType: 1, localName: localName(m[3]), attributes, childNodes: [] };
      top.childNodes.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.childNodes.push({ nodeType: 3, text: decode(m[6]) });
  }
  return { documentElement: root.childNodes.find((n) => n.nodeType === 1) };
}
const textOf = (el) => el.childNodes.map((n) => (n.nodeType === 3 ? n.text : textOf(n))).join("");
function descendant(el, name) {
  for (const n of el?.childNodes ?? []) {
    if (n.nodeType !== 1) continue;
    if (n.localName === name) return n;
    const found = descendant(n, name);
    if (found) return found;
  }
  return undefined;
}

// ---------- properties ----------

const GENERIC = [
  [/consolas|courier|mono|menlo|code|lucida console/i, "monospace"],
  [/times|cambria|georgia|garamond|book|serif|roman|palatino/i, "serif"],
];
const fontStack = (name) => `'${name}', ${GENERIC.find(([re]) => re.test(name))?.[1] ?? "sans-serif"}`;

const HIGHLIGHT = { yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff",
  red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080",
  darkRed: "#800000", darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000", white: "#ffffff" };
const hex = (v) => (v && /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : null);

/** Run properties of a w:rPr element (only those it sets). */
function readRPr(rPr) {
  if (!rPr) return {};
  const out = {};
  for (const [key, name] of [["bold", "b"], ["italic", "i"], ["strike", "strike"], ["smallCaps", "smallCaps"],
    ["caps", "caps"], ["hidden", "vanish"]]) {
    const v = on(rPr, name);
    if (v !== undefined) out[key] = v;
  }
  const u = val(rPr, "u");
  if (u) out.underline = u !== "none";
  const color = hex(val(rPr, "color"));
  if (color) out.color = color;
  const sz = num(val(rPr, "sz"));
  if (sz) out.size = sz / 2;
  const fonts = kid(rPr, "rFonts");
  const font = attr(fonts, "ascii") ?? attr(fonts, "hAnsi");
  if (font) out.font = font;
  const va = val(rPr, "vertAlign");
  if (va) out.vertAlign = va;
  const hl = HIGHLIGHT[val(rPr, "highlight")] ?? hex(attr(kid(rPr, "shd"), "fill"));
  if (hl) out.background = hl;
  return out;
}

/** A border element (w:top etc.) as CSS, or null when there is none. */
function border(el) {
  const kind = attr(el, "val");
  if (!el || !kind || ["nil", "none"].includes(kind)) return null;
  const width = Math.max(0.5, (num(attr(el, "sz")) ?? 4) / 8);
  const style = kind === "dotted" ? "dotted" : kind.startsWith("dash") ? "dashed" : kind === "double" ? "double" : "solid";
  return `${width}pt ${style} ${hex(attr(el, "color")) ?? "#000000"}`;
}

/** Paragraph properties of a w:pPr element (only those it sets). */
function readPPr(pPr) {
  if (!pPr) return {};
  const out = {};
  const jc = val(pPr, "jc");
  if (jc) out.align = { both: "justify", distribute: "justify", center: "center", right: "right", end: "right" }[jc] ?? "left";
  const sp = kid(pPr, "spacing");
  if (sp) {
    for (const name of ["before", "after"]) {
      const v = num(attr(sp, name));
      if (v != null && attr(sp, `${name}Autospacing`) !== "1") out[name] = v / 20;
    }
    const line = num(attr(sp, "line"));
    const rule = attr(sp, "lineRule");
    if (line) out.line = rule === "exact" || rule === "atLeast" ? `${line / 20}pt` : (line / 240).toFixed(3);
  }
  const ind = kid(pPr, "ind");
  if (ind) {
    const left = num(attr(ind, "left") ?? attr(ind, "start"));
    const right = num(attr(ind, "right") ?? attr(ind, "end"));
    if (left != null) out.indLeft = left / 20;
    if (right != null) out.indRight = right / 20;
    const hanging = num(attr(ind, "hanging"));
    const first = num(attr(ind, "firstLine"));
    if (hanging != null) out.firstLine = -hanging / 20;
    else if (first != null) out.firstLine = first / 20;
  }
  const pageBreak = on(pPr, "pageBreakBefore");
  if (pageBreak !== undefined) out.pageBreakBefore = pageBreak;
  const bdr = kid(pPr, "pBdr");
  if (bdr) out.borders = Object.fromEntries(["top", "bottom", "left", "right"].map((s) => [s, border(kid(bdr, s))]));
  const fill = hex(attr(kid(pPr, "shd"), "fill"));
  if (fill) out.background = fill;
  const numPr = kid(pPr, "numPr");
  if (numPr) out.numbering = { id: val(numPr, "numId"), level: Number(val(numPr, "ilvl") ?? 0) };
  return out;
}

// ---------- styles and numbering ----------

function readStyles(doc) {
  const styles = new Map();
  let defaultParagraph = null;
  for (const s of kids(doc?.documentElement, "style")) {
    const id = attr(s, "styleId");
    styles.set(id, {
      type: attr(s, "type"), basedOn: val(s, "basedOn"), isDefault: attr(s, "default") === "1",
      pPr: readPPr(kid(s, "pPr")), rPr: readRPr(kid(s, "rPr")), tblPr: kid(s, "tblPr"),
    });
    if (attr(s, "type") === "paragraph" && attr(s, "default") === "1") defaultParagraph = id;
  }
  const defaults = kid(doc?.documentElement, "docDefaults");
  return {
    styles, defaultParagraph,
    rPr: readRPr(kid(kid(defaults, "rPrDefault"), "rPr")),
    pPr: readPPr(kid(kid(defaults, "pPrDefault"), "pPr")),
  };
}

/** A style's properties with everything it's based on applied first. */
function styleChain(styles, id, key, seen = new Set()) {
  const s = styles.get(id);
  if (!s || seen.has(id)) return {};
  return { ...styleChain(styles, s.basedOn, key, new Set([...seen, id])), ...s[key] };
}

function readNumbering(doc) {
  const abstract = new Map(kids(doc?.documentElement, "abstractNum").map((a) => [attr(a, "abstractNumId"),
    new Map(kids(a, "lvl").map((l) => [Number(attr(l, "ilvl")), {
      format: val(l, "numFmt") ?? "decimal", text: val(l, "lvlText") ?? "", start: Number(val(l, "start") ?? 1),
      pPr: readPPr(kid(l, "pPr")), rPr: readRPr(kid(l, "rPr")),
    }]))]));
  return new Map(kids(doc?.documentElement, "num").map((n) => [attr(n, "numId"), abstract.get(val(n, "abstractNumId"))]));
}

const roman = (n) => [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
  [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]].reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, "");
const letter = (n) => String.fromCharCode(97 + ((n - 1) % 26));
function formatNumber(n, format) {
  switch (format) {
    case "lowerRoman": return roman(n);
    case "upperRoman": return roman(n).toUpperCase();
    case "lowerLetter": return letter(n);
    case "upperLetter": return letter(n).toUpperCase();
    default: return String(n);
  }
}
const BULLETS = ["•", "◦", "▪"];
/** Symbol-font bullets are private-use characters; show them as plain bullets. */
const bulletText = (text, level) => (!text || /[-]/.test(text) ? BULLETS[level % 3] : text);

// ---------- CSS ----------

function css(props) {
  return Object.entries(props).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${v}`).join("; ");
}

function runCss(r) {
  return css({
    "font-family": r.font ? fontStack(r.font) : null,
    "font-size": r.size ? `${r.size}pt` : null,
    "font-weight": r.bold ? "bold" : null,
    "font-style": r.italic ? "italic" : null,
    "text-decoration": [r.underline && "underline", r.strike && "line-through"].filter(Boolean).join(" ") || null,
    "font-variant": r.smallCaps ? "small-caps" : null,
    "text-transform": r.caps ? "uppercase" : null,
    color: r.color,
    "background-color": r.background,
  });
}

function paragraphCss(p, size) {
  const b = p.borders ?? {};
  return css({
    "text-align": p.align,
    "margin-top": `${p.before ?? 0}pt`,
    "margin-bottom": `${p.after ?? 0}pt`,
    "margin-left": p.indLeft ? `${p.indLeft}pt` : null,
    "margin-right": p.indRight ? `${p.indRight}pt` : null,
    "text-indent": p.firstLine ? `${p.firstLine}pt` : null,
    "line-height": p.line,
    "border-top": b.top, "border-bottom": b.bottom, "border-left": b.left, "border-right": b.right,
    "padding-top": b.top ? "1pt" : null, "padding-bottom": b.bottom ? "1pt" : null,
    "padding-left": b.left ? "4pt" : null, "padding-right": b.right ? "4pt" : null,
    "background-color": p.background,
    "font-size": `${size}pt`,
  });
}

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" };

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- body ----------

/** Converts parts (body, header, footer) with the document's styles, numbering and pictures. */
function makeConverter({ styles, numbering, images }) {
  const counters = new Map(); // "numId:level" -> current number

  function runsHtml(parent, baseRun, fields) {
    let html = "";
    for (const node of kids(parent)) {
      switch (node.localName) {
        case "r": html += runHtml(node, baseRun, fields); break;
        case "fldSimple": {
          const field = /\b(NUMPAGES|PAGE)\b/.exec(attr(node, "instr") ?? "")?.[1];
          html += field && fields ? `<span style="${runCss(baseRun)}">{${field}}</span>` : runsHtml(node, baseRun, fields);
          break;
        }
        case "hyperlink": case "smartTag": case "ins": case "customXml":
          html += runsHtml(node, baseRun, fields); break;
        case "sdt": html += runsHtml(kid(node, "sdtContent"), baseRun, fields); break;
        default: break; // deletions, bookmarks, proofing marks: nothing to show
      }
    }
    return html;
  }

  function runHtml(r, baseRun, fields) {
    const rPr = kid(r, "rPr");
    const props = { ...baseRun, ...styleChain(styles.styles, val(rPr, "rStyle"), "rPr"), ...readRPr(rPr) };
    if (props.hidden) return "";
    let inner = "";
    for (const node of kids(r)) {
      switch (node.localName) {
        case "t": inner += esc(textOf(node)); break;
        case "tab": inner += "    "; break; // shortcut: tab stops aren't laid out, a tab is four spaces (MuPDF fonts lack em spaces)
        case "br": inner += "<br/>"; break;
        case "noBreakHyphen": inner += "-"; break;
        case "sym": inner += "•"; break; // shortcut: Symbol/Wingdings glyphs shown as a bullet
        case "instrText": if (fields) fields.pending = /\b(NUMPAGES|PAGE)\b/.exec(textOf(node))?.[1] ?? fields.pending; break;
        case "fldChar": {
          if (!fields) break;
          const type = attr(node, "fldCharType");
          if (type === "separate" && fields.pending) { inner += `{${fields.pending}}`; fields.skip = true; }
          if (type === "end") { fields.pending = null; fields.skip = false; }
          break;
        }
        case "drawing": inner += drawingHtml(node); break;
        default: break;
      }
    }
    if (fields?.skip && !inner.includes("{")) return ""; // the field's saved result; ours is stamped per page
    if (!inner) return "";
    const tag = props.vertAlign === "superscript" ? "sup" : props.vertAlign === "subscript" ? "sub" : null;
    const span = `<span style="${runCss(props)}">${inner}</span>`;
    return tag ? `<${tag}>${span}</${tag}>` : span;
  }

  function drawingHtml(drawing) {
    const frame = kid(drawing, "inline") ?? kid(drawing, "anchor");
    const extent = kid(frame, "extent");
    const src = images.get(attr(descendant(drawing, "blip"), "embed"));
    if (!src || !extent) return ""; // shortcut: charts, shapes and EMF/WMF pictures aren't drawn yet
    const [w, h] = [num(attr(extent, "cx")) / 12700, num(attr(extent, "cy")) / 12700];
    const img = `<img src="${src}" style="width: ${w.toFixed(1)}pt; height: ${h.toFixed(1)}pt"/>`;
    // shortcut: a floating picture is placed on its own line where it's anchored; text doesn't wrap around it
    return frame.localName === "anchor" ? `<br/>${img}<br/>` : img;
  }

  function listPrefix(p, runProps) {
    const level = p.numbering && numbering.get(p.numbering.id)?.get(p.numbering.level);
    if (!level || level.format === "none") return { prefix: "", p };
    const { id, level: lvl } = p.numbering;
    const key = `${id}:${lvl}`;
    const n = counters.has(key) ? counters.get(key) + 1 : level.start;
    counters.set(key, n);
    for (const k of [...counters.keys()]) {
      const [kid2, l] = k.split(":");
      if (kid2 === id && Number(l) > lvl) counters.delete(k); // deeper levels restart under a new item
    }
    const label = level.format === "bullet" ? bulletText(level.text, lvl)
      : level.text.replace(/%(\d)/g, (_, d) => formatNumber(Number(d) - 1 === lvl ? n : counters.get(`${id}:${d - 1}`) ?? 1, level.format));
    const props = { ...runProps, ...level.rPr };
    const labelProps = level.format === "bullet" ? { ...props, font: null } : props;
    return { prefix: `<span style="${runCss(labelProps)}">${esc(label)}</span>  `, p: { ...level.pPr, ...p } };
  }

  function paragraphHtml(el, { fields, extraRun = {} } = {}) {
    const pPr = kid(el, "pPr");
    const styleId = val(pPr, "pStyle") ?? styles.defaultParagraph;
    const own = { ...styles.pPr, ...styleChain(styles.styles, styleId, "pPr"), ...readPPr(pPr) };
    const runProps = { ...styles.rPr, ...extraRun, ...styleChain(styles.styles, styleId, "rPr") };
    const { prefix, p } = listPrefix(own, runProps);
    const content = runsHtml(el, runProps, fields);
    const size = runProps.size ?? 11;
    const empty = !prefix && !content.replace(/<\/?span[^>]*>/g, "");
    const body = empty ? `<span style="font-size: ${size}pt"> </span>` : prefix + content;
    return { html: `<p style="${paragraphCss(p, size)}">${body}</p>`, pageBreakBefore: p.pageBreakBefore };
  }

  // ---------- tables ----------

  const sideEl = (el, s) => kid(el, s) ?? kid(el, { left: "start", right: "end" }[s] ?? s);

  function cellBorders(tblBorders, styleBorders, tcBorders, edges) {
    const pick = (side, inner) => {
      const own = sideEl(tcBorders, side);
      if (own) return border(own);
      const name = edges[side] ? side : inner;
      return border(sideEl(tblBorders, name)) ?? border(sideEl(styleBorders, name));
    };
    return {
      "border-top": pick("top", "insideH"), "border-bottom": pick("bottom", "insideH"),
      "border-left": pick("left", "insideV"), "border-right": pick("right", "insideV"),
    };
  }

  /** Cell margins in twips from a tblCellMar/tcMar element, falling back side by side. */
  function margins(el, fallback) {
    const get = (s) => num(attr(sideEl(el, s), "w")) ?? fallback?.[s];
    return { top: get("top"), bottom: get("bottom"), left: get("left"), right: get("right") };
  }

  function tableHtml(tbl) {
    const tblPr = kid(tbl, "tblPr");
    const styleId = val(tblPr, "tblStyle");
    const styleTblPr = styles.styles.get(styleId)?.tblPr;
    const defaultTblPr = [...styles.styles.values()].find((s) => s.type === "table" && s.isDefault)?.tblPr;
    const tblBorders = kid(tblPr, "tblBorders");
    const styleBorders = kid(styleTblPr, "tblBorders");
    const cellMar = margins(kid(tblPr, "tblCellMar"), margins(kid(styleTblPr, "tblCellMar"),
      margins(kid(defaultTblPr, "tblCellMar"), { top: 0, bottom: 0, left: 108, right: 108 })));
    const grid = kids(kid(tbl, "tblGrid"), "gridCol").map((g) => num(attr(g, "w")) / 20);
    const rows = kids(tbl, "tr").map((tr) => {
      let col = 0;
      return kids(tr, "tc").map((tc) => {
        const tcPr = kid(tc, "tcPr");
        const span = Number(val(tcPr, "gridSpan") ?? 1);
        const vMerge = kid(tcPr, "vMerge");
        const cell = { tc, tcPr, col, span, merge: vMerge ? (attr(vMerge, "val") === "restart" ? "restart" : "continue") : null };
        col += span;
        return cell;
      });
    });
    const lastCol = Math.max(grid.length, ...rows.map((r) => r.reduce((n, c) => n + c.span, 0)));
    const extraRun = styleChain(styles.styles, styleId, "rPr");
    const total = grid.reduce((a, b) => a + b, 0);
    const indent = num(attr(kid(tblPr, "tblInd"), "w")) / 20 || 0;
    let html = `<table style="border-collapse: collapse; width: ${total ? `${total.toFixed(1)}pt` : "100%"}${indent > 0 ? `; margin-left: ${indent.toFixed(1)}pt` : ""}">`;
    rows.forEach((row, r) => {
      html += "<tr>";
      for (const cell of row) {
        if (cell.merge === "continue") continue;
        let rowspan = 1;
        if (cell.merge === "restart") {
          while (r + rowspan < rows.length && rows[r + rowspan].find((c) => c.col === cell.col)?.merge === "continue") rowspan++;
        }
        const width = grid.slice(cell.col, cell.col + cell.span).reduce((a, b) => a + b, 0);
        const pad = margins(kid(cell.tcPr, "tcMar"), cellMar);
        const edges = { top: r === 0, bottom: r + rowspan >= rows.length, left: cell.col === 0, right: cell.col + cell.span >= lastCol };
        const style = css({
          ...cellBorders(tblBorders, styleBorders, kid(cell.tcPr, "tcBorders"), edges),
          "background-color": hex(attr(kid(cell.tcPr, "shd"), "fill")),
          "vertical-align": { center: "middle", bottom: "bottom" }[val(cell.tcPr, "vAlign")] ?? "top",
          // a Word cell width includes its padding; a CSS one doesn't
          width: width ? `${Math.max(0, width - ((pad.left ?? 0) + (pad.right ?? 0)) / 20).toFixed(1)}pt` : null,
          padding: ["top", "right", "bottom", "left"].map((s) => `${((pad[s] ?? 0) / 20).toFixed(1)}pt`).join(" "),
        });
        const spans = `${cell.span > 1 ? ` colspan="${cell.span}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}`;
        html += `<td${spans} style="${style}">${blocksHtml(cell.tc, { extraRun })}</td>`;
      }
      html += "</tr>";
    });
    return `${html}</table>`;
  }

  /** The paragraphs and tables of a body, cell, header or footer, as [{html, pageBreakBefore}]. */
  function blocks(parent, opts = {}) {
    return kids(parent).flatMap((node) => {
      if (node.localName === "p") return [paragraphHtml(node, opts)];
      if (node.localName === "tbl") return [{ html: tableHtml(node) }];
      if (node.localName === "sdt") return blocks(kid(node, "sdtContent"), opts);
      return [];
    });
  }
  const blocksHtml = (parent, opts) => blocks(parent, opts).map((b) => b.html).join("");

  /** The body split where Word starts a new page. Each piece is laid out on its own: MuPDF's CSS
   * page breaks drew the next paragraph's border on the page before. */
  function pages(body) {
    const out = [];
    for (const b of blocks(body)) {
      if (!out.length || b.pageBreakBefore) out.push("");
      out[out.length - 1] += b.html;
    }
    return out;
  }

  return { pages, paragraphHtml };
}

// ---------- package ----------

async function readRels(entries, path) {
  const get = entries.get(path);
  if (!get) return new Map();
  const doc = parseXml(new TextDecoder().decode(await get()));
  return new Map(kids(doc.documentElement, "Relationship").map((r) => [attr(r, "Id"), attr(r, "Target")]));
}

const partPath = (target) => (target.startsWith("/") ? target.slice(1) : `word/${target}`);

async function picturesFor(entries, rels) {
  const images = new Map();
  for (const [id, target] of rels) {
    const type = IMAGE_TYPES[target.split(".").pop().toLowerCase()];
    const get = entries.get(partPath(target));
    if (type && get) images.set(id, `data:${type};base64,${base64(await get())}`);
  }
  return images;
}

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/**
 * @param {Uint8Array} bytes a .docx file
 * @returns {Promise<{html: string[] (one XHTML document per run of pages; Word page breaks split them),
 *   page: {width: number, height: number, margin: number[], header: number, footer: number},
 *   header: {text: string, align: string, size: number, bold: boolean, color: string|null}[],
 *   footer: {text: string, align: string, size: number, bold: boolean, color: string|null}[]}>}
 *   sizes in points; margin is [top, right, bottom, left]
 */
export async function docxToHtml(bytes) {
  const entries = unzip(bytes);
  const text = async (path) => {
    const get = entries.get(path);
    return get ? new TextDecoder().decode(await get()) : null;
  };
  const documentXml = await text("word/document.xml");
  if (!documentXml) throw new Error("not a Word document");
  const stylesXml = await text("word/styles.xml");
  const numberingXml = await text("word/numbering.xml");
  const styles = readStyles(stylesXml ? parseXml(stylesXml) : null);
  const numbering = readNumbering(numberingXml ? parseXml(numberingXml) : null);
  const rels = await readRels(entries, "word/_rels/document.xml.rels");
  const body = kid(parseXml(documentXml).documentElement, "body");
  const convert = makeConverter({ styles, numbering, images: await picturesFor(entries, rels) });

  const sect = kid(body, "sectPr"); // shortcut: one page setup for the whole document (its last section)
  const pgSz = kid(sect, "pgSz");
  const pgMar = kid(sect, "pgMar");
  const tw = (el, name, fallback) => (num(attr(el, name)) ?? fallback) / 20;
  const page = {
    width: tw(pgSz, "w", 11906), height: tw(pgSz, "h", 16838),
    margin: [tw(pgMar, "top", 1440), tw(pgMar, "right", 1440), tw(pgMar, "bottom", 1440), tw(pgMar, "left", 1440)],
    header: tw(pgMar, "header", 720), footer: tw(pgMar, "footer", 720),
  };

  // shortcut: headers/footers are stamped as plain text lines (no pictures or tables in them)
  const band = async (kind) => {
    const ref = kids(sect, `${kind}Reference`).find((r) => attr(r, "type") === "default") ?? kid(sect, `${kind}Reference`);
    const target = rels.get(attr(ref, "id"));
    const xml = target && (await text(partPath(target)));
    if (!xml) return [];
    return kids(parseXml(xml).documentElement, "p").map((p) => {
      const pPr = kid(p, "pPr");
      const styleId = val(pPr, "pStyle") ?? styles.defaultParagraph;
      const pp = { ...styles.pPr, ...styleChain(styles.styles, styleId, "pPr"), ...readPPr(pPr) };
      const rp = { ...styles.rPr, ...styleChain(styles.styles, styleId, "rPr") };
      const firstRun = readRPr(kid(kids(p, "r").find((r) => kid(r, "t")), "rPr"));
      const html = convert.paragraphHtml(p, { fields: { pending: null, skip: false } }).html;
      return {
        text: unescape(html.replace(/<[^>]+>/g, "")).replace(/ /g, " ").trim(),
        align: pp.align ?? "left", size: firstRun.size ?? rp.size ?? 11,
        bold: !!(firstRun.bold ?? rp.bold), color: firstRun.color ?? rp.color ?? null,
      };
    }).filter((l) => l.text);
  };

  const head = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><head><style>'
    + `@page { margin: ${page.margin.map((m) => `${m}pt`).join(" ")} } `
    + `body { margin: 0; font-family: ${styles.rPr.font ? fontStack(styles.rPr.font) : "serif"}; font-size: ${styles.rPr.size ?? 11}pt } `
    + "p { margin: 0 } table { margin: 0 }</style></head><body>";
  const html = convert.pages(body).map((part) => `${head}${part}</body></html>`);
  return { html, page, header: await band("header"), footer: await band("footer") };
}

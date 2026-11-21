// Turn a PDF into PDF/A-2b (ISO 19005-2, level B: it looks the same forever), on the device, with MuPDF.
// What PDF/A-2b asks for, and what is done here:
// - every font embedded: fonts that aren't in the file get MuPDF's built-in look-alike (Nimbus,
//   the free twins of Helvetica/Times/Courier), with widths taken from that font;
// - colour defined: an sRGB output intent (a small sRGB ICC profile made here);
// - nothing that runs or plays: JavaScript, launch/sound/movie actions, additional actions,
//   attachments, XFA, multimedia annotations are removed;
// - annotations printable and with an appearance; image Interpolate/OPI/Alternates removed;
// - XMP metadata saying "PDF/A-2B", matching the document information.
// Things it can't fix (CMYK colours, a missing CID font…) are reported instead.
import * as mupdf from "mupdf";
import { Encodings } from "@pdf-lib/standard-fonts";

const { PDFAnnotation } = mupdf;

const FORBIDDEN_ACTIONS = new Set(["Launch", "Sound", "Movie", "ResetForm", "ImportData", "Hide",
  "SetOCGState", "Rendition", "Trans", "GoTo3DView", "JavaScript"]);
// shortcut: attachments are removed, since PDF/A-2 only allows attached PDF/A files; check them if users need it
const FORBIDDEN_ANNOTS = new Set(["Sound", "Movie", "Screen", "3D", "RichMedia", "FileAttachment"]);
const INFO_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate"];
const SAVE_OPTIONS = "garbage=compact,compress";

const nameOf = (obj) => (obj.isName() ? obj.asName() : null);

// ---------- fonts ----------

// Glyph names of StandardEncoding codes 32–126 (ASCII, but ' and ` are curly quotes).
const STANDARD_NAMES = ("space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft "
  + "parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine "
  + "colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z "
  + "bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q "
  + "r s t u v w x y z braceleft bar braceright asciitilde").split(" ");
const GLYPH_UNICODE = new Map(STANDARD_NAMES.map((n, i) => [n, 32 + i]));
for (const [n, u] of Object.entries({ quoteright: 0x2019, quoteleft: 0x2018, fi: 0xfb01, fl: 0xfb02,
  nbspace: 0xa0, minus: 0x2212, Ydieresis: 0x178 })) GLYPH_UNICODE.set(n, u);
// The built-in encodings of Symbol and ZapfDingbats (code → Unicode); their glyph names and WinAnsi's join the map.
const BUILT_IN = {};
for (const font of ["Symbol", "ZapfDingbats", "WinAnsi"]) {
  const enc = Encodings[font];
  const codes = new Array(256).fill(-1);
  for (const u of enc.supportedCodePoints) {
    const { code, name } = enc.encodeUnicodeCodePoint(u);
    codes[code] = u;
    if (!GLYPH_UNICODE.has(name)) GLYPH_UNICODE.set(name, u);
  }
  BUILT_IN[font] = codes;
}

/** Unicode of a glyph name, or -1. */
export function glyphUnicode(name) {
  if (GLYPH_UNICODE.has(name)) return GLYPH_UNICODE.get(name);
  const m = /^uni([0-9A-F]{4})$/.exec(name) || /^u([0-9A-F]{4,6})$/.exec(name);
  return m ? parseInt(m[1], 16) : -1;
}

const DECODERS = { WinAnsiEncoding: "windows-1252", MacRomanEncoding: "macintosh" };

/**
 * code → Unicode (−1 unknown) for a simple font's Encoding (null object if none), or null if a glyph
 * name can't be mapped. `builtIn` is the stand-in's name: Symbol and ZapfDingbats have their own encoding.
 */
export function codeToUnicode(encoding, builtIn) {
  const base = encoding.isDictionary() ? nameOf(encoding.get("BaseEncoding")) : nameOf(encoding);
  let map = new Array(256).fill(-1);
  if (!base && BUILT_IN[builtIn]) {
    map = [...BUILT_IN[builtIn]];
  } else if (DECODERS[base]) {
    const decoder = new TextDecoder(DECODERS[base]);
    for (let c = 32; c < 256; c++) map[c] = decoder.decode(Uint8Array.of(c)).codePointAt(0);
  } else {
    // shortcut: StandardEncoding codes above 126 (accents, ligatures) are left unknown; add the table if needed
    for (let c = 32; c < 127; c++) map[c] = GLYPH_UNICODE.get(STANDARD_NAMES[c - 32]);
  }
  const diffs = encoding.isDictionary() ? encoding.get("Differences") : null;
  if (diffs?.isArray()) {
    let code = 0;
    for (let i = 0; i < diffs.length; i++) {
      const item = diffs.get(i);
      if (item.isNumber()) { code = item.asNumber(); continue; }
      const u = glyphUnicode(item.asName());
      if (u < 0 && item.asName() !== ".notdef") return null;
      map[code++] = u;
    }
  }
  return map;
}

/** The built-in font that stands in for `name` (subset prefix dropped, style words looked at). */
export function standIn(name, flags = 0) {
  const n = name.replace(/^[A-Z]{6}\+/, "").toLowerCase();
  if (/symbol/.test(n)) return "Symbol";
  if (/dingbat/.test(n)) return "ZapfDingbats";
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique|slanted/.test(n) || (flags & 64) !== 0;
  const style = (b, i, plain) => (b && i ? `${b}${i}` : b || i || plain);
  if (/courier|mono|consol|typewriter/.test(n) || (flags & 1)) {
    return `Courier${bold || italic ? `-${style(bold && "Bold", italic && "Oblique", "")}` : ""}`;
  }
  const serif = /times|georgia|garamond|cambria|serif|roman|minion|palatino/.test(n)
    ? !/sans/.test(n) : (flags & 2) !== 0 && !/sans|arial|helvet|calibri|verdana|tahoma/.test(n);
  if (serif) return `Times-${style(bold && "Bold", italic && "Italic", "Roman")}`;
  return `Helvetica${bold || italic ? `-${style(bold && "Bold", italic && "Oblique", "")}` : ""}`;
}

/** The font program (CFF bytes) and descriptor of a built-in font, embedded once per document. */
function builtInProgram(pdf, cache, name) {
  if (!cache.has(name)) {
    const font = new mupdf.Font(name);
    // addSimpleFont doesn't embed the base 14; the CID route does, so take the font file from there
    const descriptor = pdf.addFont(font).get("DescendantFonts", 0, "FontDescriptor");
    const file = pdf.addRawStream(descriptor.get("FontFile3").readRawStream(),
      { Subtype: pdf.newName("Type1C") });
    cache.set(name, { font, file, descriptor });
  }
  return cache.get(name);
}

/** Embed a stand-in for a simple font that isn't in the file; returns a problem or null. */
function embedSimpleFont(pdf, dict, cache) {
  const baseFont = nameOf(dict.get("BaseFont")) || "Helvetica";
  const encoding = dict.get("Encoding");
  const oldFlags = dict.get("FontDescriptor", "Flags");
  const name = standIn(baseFont, oldFlags.isNumber() ? oldFlags.asNumber() : 0);
  const symbolic = name === "Symbol" || name === "ZapfDingbats";
  const codes = codeToUnicode(encoding, name);
  if (!codes) return `the font ${baseFont} isn't in the file and uses glyph names Quire doesn't know`;
  const { font, file, descriptor: src } = builtInProgram(pdf, cache, name);
  const widths = pdf.newArray();
  for (let c = 0; c < 256; c++) {
    widths.push(Math.round(font.advanceGlyph(codes[c] < 0 ? 0 : font.encodeCharacter(codes[c])) * 1000));
  }
  const italic = /Oblique|Italic/.test(name);
  const flags = (symbolic ? 4 : 32) | (name.startsWith("Times") ? 2 : 0) | (name.startsWith("Courier") ? 1 : 0) | (italic ? 64 : 0);
  const ascent = src.get("Ascent").asNumber();
  dict.put("Subtype", pdf.newName("Type1")); // a TrueType font name may now hold a CFF (Type 1) program
  dict.put("FontDescriptor", pdf.addObject({
    Type: pdf.newName("FontDescriptor"), FontName: pdf.newName(baseFont), Flags: flags,
    FontBBox: src.get("FontBBox"), ItalicAngle: italic ? -12 : 0, Ascent: ascent,
    Descent: src.get("Descent").asNumber(), CapHeight: Math.round(ascent * 0.7),
    StemV: src.get("StemV").asNumber(), FontFile3: file,
  }));
  dict.put("FirstChar", 0);
  dict.put("LastChar", 255);
  dict.put("Widths", widths);
  return null;
}

const isEmbedded = (descriptor) => descriptor.isDictionary()
  && ["FontFile", "FontFile2", "FontFile3"].some((k) => descriptor.get(k).isStream());

/**
 * Fonts some page, form, pattern or appearance can draw with: the ones in a /Resources /Font dictionary.
 * A form's default fonts (AcroForm /DR) aren't drawn, so they needn't be embedded.
 */
function fontsInUse(objects) {
  const used = new Map();
  for (const obj of objects) {
    const fonts = obj.resolve().isDictionary() ? obj.resolve().get("Resources", "Font") : null;
    if (!fonts?.isDictionary()) continue;
    fonts.forEach((font) => {
      const dict = font.resolve();
      if (dict.isDictionary()) used.set(font.isIndirect() ? font.asIndirect() : dict, dict);
    });
  }
  return [...used.values()];
}

/** Embed missing fonts; returns problems, and the names of the fonts given a stand-in. */
function embedFonts(pdf, fonts) {
  const problems = [];
  const replaced = new Set();
  const cache = new Map();
  for (const dict of fonts) {
    const subtype = nameOf(dict.get("Subtype"));
    if (subtype === "Type3") continue;
    if (subtype === "Type0") {
      if (!isEmbedded(dict.get("DescendantFonts", 0, "FontDescriptor"))) {
        problems.push(`the font ${nameOf(dict.get("BaseFont"))} isn't in the file`);
      }
      continue;
    }
    if (isEmbedded(dict.get("FontDescriptor"))) continue;
    const problem = embedSimpleFont(pdf, dict, cache);
    if (problem) problems.push(problem);
    else replaced.add(nameOf(dict.get("BaseFont")).replace(/^[A-Z]{6}\+/, ""));
  }
  return { problems, replaced: [...replaced] };
}

// ---------- colour ----------

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const s15 = (f) => u32(Math.round(f * 65536) >>> 0);

/** sRGB's tone curve as an ICC 'curv' tag with 1024 points. */
function srgbCurve() {
  const n = 1024;
  const out = [...ascii("curv"), 0, 0, 0, 0, ...u32(n)];
  for (let i = 0; i < n; i++) {
    const v = i / (n - 1);
    const w = Math.round((v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * 65535);
    out.push(w >> 8, w & 255);
  }
  return out;
}

/** A small ICC v2 display profile for sRGB (D50-adapted primaries, sRGB tone curve). */
export function srgbProfile() {
  const text = (s) => [...ascii("text"), 0, 0, 0, 0, ...ascii(s), 0];
  const desc = (s) => [...ascii("desc"), 0, 0, 0, 0, ...u32(s.length + 1), ...ascii(s), 0,
    ...new Array(4 + 4 + 2 + 1 + 67).fill(0)]; // no Unicode or Mac script names
  const xyz = (x, y, z) => [...ascii("XYZ "), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  const trc = srgbCurve();
  const tags = [["desc", desc("sRGB IEC61966-2.1")], ["cprt", text("No copyright, use freely")],
    ["wtpt", xyz(0.9642, 1, 0.8249)], ["rXYZ", xyz(0.4361, 0.2225, 0.0139)],
    ["gXYZ", xyz(0.3851, 0.7169, 0.0971)], ["bXYZ", xyz(0.1431, 0.0606, 0.7141)],
    ["rTRC", trc], ["gTRC", trc], ["bTRC", trc]];
  const start = 128 + 4 + tags.length * 12;
  const table = [];
  const data = [];
  const placed = new Map(); // the three curves share one copy
  for (const [sig, bytes] of tags) {
    if (!placed.has(bytes)) {
      placed.set(bytes, start + data.length);
      data.push(...bytes);
      while (data.length % 4) data.push(0);
    }
    table.push(...ascii(sig), ...u32(placed.get(bytes)), ...u32(bytes.length));
  }
  const header = [...u32(start + data.length), 0, 0, 0, 0, ...u32(0x02100000), ...ascii("mntrRGB XYZ "),
    ...[2026, 1, 1, 0, 0, 0].flatMap((v) => [v >> 8, v & 255]), ...ascii("acsp"),
    ...new Array(24).fill(0), ...u32(0), ...s15(0.9642), ...s15(1), ...s15(0.8249)];
  while (header.length < 128) header.push(0);
  return Uint8Array.from([...header, ...u32(tags.length), ...table, ...data]);
}

const CMYK_OPERATOR = /(?:^|[\s\]])(?:-?[\d.]+\s+){4}[kK](?=[\s/[<(]|$)/m;
const FONT_FILES = ["Length1", "Length2", "Length3"];

/** Whether the document paints in CMYK: a CMYK colour space anywhere, or k/K in a content stream. */
function usesCMYK(objects) {
  for (const obj of objects) {
    const dict = obj.resolve();
    if (/\/DeviceCMYK\b/.test(dict.toString(true))) return true;
    if (!obj.isStream()) continue;
    const kind = nameOf(dict.get("Subtype"));
    const isContent = !kind || kind === "Form";
    if (!isContent || FONT_FILES.some((k) => dict.get(k).isNumber()) || !dict.get("N").isNull()
      || nameOf(dict.get("Type")) === "Metadata") continue;
    let text;
    try { text = obj.readStream().asString(); } catch { continue; } // an unreadable stream paints nothing
    if (CMYK_OPERATOR.test(text)) return true;
  }
  return false;
}

// ---------- metadata ----------

const pad = (n) => String(n).padStart(2, "0");

/** Date from a PDF date string ("D:20240131120000+01'00'"), or null. */
export function parsePdfDate(s) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s || "");
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", sign, oh = "00", om = "00"] = m;
  const offset = sign === "+" || sign === "-" ? (sign === "+" ? 1 : -1) * (+oh * 60 + +om) * 60000 : 0;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - offset);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pdfDate = (d) => `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
  + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const xmpDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const xml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""); // not allowed in XML

/** The XMP packet for PDF/A-2B with the document information `info` ({Title, Author, …, dates as Date}). */
export function xmpPacket(info) {
  const alt = (tag, v) => `<${tag}><rdf:Alt><rdf:li xml:lang="x-default">${xml(v)}</rdf:li></rdf:Alt></${tag}>`;
  const lines = [
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"'
      + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
      + ' xmlns:pdf="http://ns.adobe.com/pdf/1.3/">',
    "<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>",
    info.Title && alt("dc:title", info.Title),
    info.Author && `<dc:creator><rdf:Seq><rdf:li>${xml(info.Author)}</rdf:li></rdf:Seq></dc:creator>`,
    info.Subject && alt("dc:description", info.Subject),
    info.Keywords && `<pdf:Keywords>${xml(info.Keywords)}</pdf:Keywords>`,
    info.Creator && `<xmp:CreatorTool>${xml(info.Creator)}</xmp:CreatorTool>`,
    info.Producer && `<pdf:Producer>${xml(info.Producer)}</pdf:Producer>`,
    info.CreationDate && `<xmp:CreateDate>${xmpDate(info.CreationDate)}</xmp:CreateDate>`,
    `<xmp:ModifyDate>${xmpDate(info.ModDate)}</xmp:ModifyDate>`,
    `<xmp:MetadataDate>${xmpDate(info.ModDate)}</xmp:MetadataDate>`,
    "</rdf:Description>",
  ].filter(Boolean);
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
    + `${lines.join("\n")}\n</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
}

/** Keep only document information XMP mirrors, and add the matching XMP stream. */
function writeMetadata(pdf, now) {
  const trailer = pdf.getTrailer();
  const old = trailer.get("Info");
  const info = {};
  for (const key of INFO_KEYS) {
    const v = old.isDictionary() ? old.get(key) : null;
    if (!v?.isString() || !v.asString().trim()) continue;
    const value = key === "CreationDate" ? parsePdfDate(v.asString()) : v.asString();
    if (value) info[key] = value;
  }
  info.ModDate = now;
  const dict = pdf.newDictionary();
  for (const [key, v] of Object.entries(info)) dict.put(key, pdf.newString(v instanceof Date ? pdfDate(v) : v));
  trailer.put("Info", pdf.addObject(dict));
  trailer.get("Root").put("Metadata", pdf.addStream(new TextEncoder().encode(xmpPacket(info)),
    { Type: pdf.newName("Metadata"), Subtype: pdf.newName("XML") }));
}

// ---------- clean-up ----------

/** Remove forbidden actions, transfer functions and image extras from a dictionary and the ones inside it. */
function cleanDict(dict) {
  dict.delete("AA");
  for (const key of ["A", "OpenAction", "Next"]) {
    const action = dict.get(key);
    if (action.isDictionary() && FORBIDDEN_ACTIONS.has(nameOf(action.get("S")))) dict.delete(key);
  }
  if (nameOf(dict.get("Type")) === "ExtGState") {
    dict.delete("TR");
    if (!dict.get("TR2").isNull() && nameOf(dict.get("TR2")) !== "Default") dict.delete("TR2");
  }
  const subtype = nameOf(dict.get("Subtype"));
  if (subtype === "Image") ["Interpolate", "Alternates", "OPI"].forEach((k) => dict.delete(k));
  if (subtype === "Form") dict.delete("OPI");
  dict.forEach((v) => {
    if (v.isIndirect()) return; // indirect objects get their own turn
    if (v.isDictionary()) cleanDict(v);
    else if (v.isArray()) v.forEach((item) => { if (!item.isIndirect() && item.isDictionary()) cleanDict(item); });
  });
}

function cleanCatalog(pdf) {
  const root = pdf.getTrailer().get("Root");
  const names = root.get("Names");
  if (names.isDictionary()) { names.delete("JavaScript"); names.delete("EmbeddedFiles"); }
  const form = root.get("AcroForm");
  if (form.isDictionary()) { form.delete("XFA"); form.delete("NeedAppearances"); }
  root.delete("Perms");
  const oc = root.get("OCProperties");
  if (!oc.isDictionary()) return;
  const configs = [oc.get("D")];
  oc.get("Configs").forEach?.((c) => configs.push(c));
  configs.forEach((c, i) => {
    if (!c.isDictionary()) return;
    c.delete("AS");
    if (!c.get("Name").isString()) c.put("Name", pdf.newString(i ? `View ${i}` : "Default"));
  });
}

const HIDING = PDFAnnotation.IS_INVISIBLE | PDFAnnotation.IS_HIDDEN | PDFAnnotation.IS_NO_VIEW
  | PDFAnnotation.IS_TOGGLE_NO_VIEW;

/** Annotations printable, visible, with a normal appearance only; forbidden kinds removed. */
function cleanAnnotations(pdf) {
  const problems = [];
  for (let i = 0; i < pdf.countPages(); i++) {
    const page = pdf.loadPage(i);
    for (const annot of [...page.getAnnotations(), ...page.getWidgets()]) {
      const type = annot.getType();
      if (FORBIDDEN_ANNOTS.has(type)) { page.deleteAnnotation(annot); continue; }
      let flags = (annot.getFlags() | PDFAnnotation.IS_PRINT) & ~HIDING;
      if (type === "Text") flags |= PDFAnnotation.IS_NO_ZOOM | PDFAnnotation.IS_NO_ROTATE;
      annot.setFlags(flags);
      if (type === "Popup" || type === "Link") continue;
      const obj = annot.getObject();
      if (obj.get("AP", "N").isNull()) annot.update();
      const ap = obj.get("AP");
      if (ap.isDictionary()) { ap.delete("D"); ap.delete("R"); }
      // a check box/radio button keeps a dictionary of states; anything else needs one stream
      const isButton = type === "Widget" && nameOf(obj.getInheritable("FT")) === "Btn";
      if (!obj.get("AP", "N").isStream() && !isButton) {
        problems.push(`a ${type} annotation on page ${i + 1} has no appearance`);
      }
    }
  }
  return problems;
}

// ---------- main ----------

/**
 * Convert to PDF/A-2b. Returns {bytes, replacedFonts} or, when it can't be done, {bytes: null, problems}.
 * `now` is the modification date written into the file.
 */
export function toPdfA(bytes, now = new Date()) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    return convert(doc.asPDF(), now);
  } finally {
    doc.destroy();
  }
}

function convert(pdf, now) {
  if (pdf.needsPassword()) return { bytes: null, problems: ["the file is locked with a password"] };
  const problems = cleanAnnotations(pdf); // first: new appearances may add fonts
  cleanCatalog(pdf);
  const objects = [];
  for (let num = 1; num < pdf.countObjects(); num++) objects.push(pdf.newIndirect(num));
  // shortcut: CMYK needs a CMYK output intent (a large print profile); convert colours or bundle one if users need it
  if (usesCMYK(objects)) problems.push("it uses CMYK (print) colours");
  for (const obj of objects) { if (obj.resolve().isDictionary()) cleanDict(obj.resolve()); }
  const { problems: fontProblems, replaced } = embedFonts(pdf, fontsInUse(objects));
  problems.push(...fontProblems);
  if (problems.length) return { bytes: null, problems: [...new Set(problems)] };

  pdf.getTrailer().get("Root").put("OutputIntents", [pdf.addObject({
    Type: pdf.newName("OutputIntent"), S: pdf.newName("GTS_PDFA1"),
    OutputConditionIdentifier: pdf.newString("sRGB IEC61966-2.1"), Info: pdf.newString("sRGB IEC61966-2.1"),
    DestOutputProfile: pdf.addStream(srgbProfile(), { N: 3 }),
  })]);
  writeMetadata(pdf, now);
  if (!pdf.getTrailer().get("ID").isArray()) {
    const id = pdf.newByteString(crypto.getRandomValues(new Uint8Array(16)));
    pdf.getTrailer().put("ID", [id, id]);
  }
  // .slice(): the buffer is a view of MuPDF's memory, which moves when it grows
  return { bytes: pdf.saveToBuffer(SAVE_OPTIONS).asUint8Array().slice(), replacedFonts: replaced };
}

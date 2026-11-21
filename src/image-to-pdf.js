// Pictures to PDF, on the device: one picture per page, the page the picture's shape.
// JPEG and PNG are embedded as they are (no re-encoding); the caller turns other formats into PNG.
import { PDFDocument, degrees } from "pdf-lib";

const PT_PER_PX = 0.75; // 96 dpi
const MAX_SIDE = 842; // pt, A4's long side: a 4000 px photo shouldn't make a 1-metre page

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** A JPEG's EXIF orientation (1–8), 1 when it has none. Phones store photos sideways and set this. */
export function jpegOrientation(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    for (let at = 2; at + 4 <= b.length && b[at] === 0xff;) {
      const marker = b[at + 1];
      if (marker === 0xda) break; // image data starts; no EXIF after it
      const exif = at + 4;
      if (marker === 0xe1 && view.getUint32(exif) === 0x45786966) { // "Exif"
        const tiff = exif + 6;
        const little = view.getUint16(tiff) === 0x4949;
        const u16 = (o) => view.getUint16(o, little);
        const ifd = tiff + view.getUint32(tiff + 4, little);
        for (let i = 0, n = u16(ifd); i < n; i++) {
          const entry = ifd + 2 + i * 12;
          if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
        }
        return 1;
      }
      at += 2 + view.getUint16(at + 2);
    }
  } catch { /* a broken EXIF block reads past the end: treat as upright */ }
  return 1;
}

const HEIF_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/;
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
/** An iPhone photo (HEIC/HEIF): an ISO box file whose brand is HEVC-coded HEIF. */
export const isHeif = (b) => ascii(b, 4, 8) === "ftyp" && HEIF_BRANDS.test(ascii(b, 8, 12));

const SVG_DPI = 300; // the browser draws SVGs at this resolution; MuPDF.js has no SVG reader
const HEIC_QUALITY = 0.92;

async function canvasBytes(width, height, draw, type = "image/png") {
  const canvas = new OffscreenCanvas(width, height);
  draw(canvas.getContext("2d"));
  return new Uint8Array(await (await canvas.convertToBlob({ type, quality: HEIC_QUALITY })).arrayBuffer());
}

let libheif; // the decoder is ~2 MB, so it loads on the first HEIC only
async function heifToJpeg(bytes) {
  libheif ??= import("libheif-js/libheif-wasm/libheif-bundle.mjs").then((m) => m.default());
  const images = new (await libheif).HeifDecoder().decode(bytes);
  try {
    const [image] = images; // the primary picture; bursts' other frames are dropped
    if (!image) throw new Error("no picture inside");
    const data = new ImageData(image.get_width(), image.get_height());
    await new Promise((ok, fail) => image.display(data, (d) => (d ? ok() : fail(new Error("decoding failed")))));
    return canvasBytes(data.width, data.height, (g) => g.putImageData(data, 0, 0), "image/jpeg");
  } finally {
    for (const image of images) image.free();
  }
}

/** Whether an SVG says how big it is; one with only a viewBox (logos, icons) is made page-sized. */
export function hasOwnSize(bytes) {
  const root = /<svg\b[^>]*>/i.exec(new TextDecoder().decode(bytes.subarray(0, 8192)))?.[0] ?? "";
  const given = (name) => new RegExp(`\\s${name}\\s*=\\s*["']\\s*[\\d.]+(px|pt|mm|cm|in|pc)?\\s*["']`, "i").test(root);
  return given("width") && given("height");
}

async function svgToPng(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // shortcut: drawn as pixels, not vectors (MuPDF.js has no SVG reader); upgrade if vector output matters
    const pt = [img.naturalWidth * PT_PER_PX, img.naturalHeight * PT_PER_PX];
    const fit = hasOwnSize(bytes) ? Math.min(1, MAX_SIDE / Math.max(...pt)) : MAX_SIDE / Math.max(...pt);
    const size = pt.map((v) => v * fit);
    const [w, h] = size.map((v) => Math.max(1, Math.round((v * SVG_DPI) / 72)));
    return { bytes: await canvasBytes(w, h, (g) => g.drawImage(img, 0, 0, w, h)), size };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A picture file as something `imagesToPdf` takes (browser only): JPEG and PNG as they are; HEIC
 * decoded to JPEG; SVG drawn at 300 dpi; WebP, GIF (first frame), BMP redrawn as PNG.
 * @param {File} file
 */
export async function pictureFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (isJpeg(bytes) || isPng(bytes)) return bytes;
    if (isHeif(bytes)) return await heifToJpeg(bytes);
    if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) return await svgToPng(bytes);
    const bitmap = await createImageBitmap(file);
    try {
      return await canvasBytes(bitmap.width, bitmap.height, (g) => g.drawImage(bitmap, 0, 0));
    } finally {
      bitmap.close();
    }
  } catch {
    throw new Error(`“${file.name}” couldn't be read as a picture.`);
  }
}

/** Degrees pdf-lib turns the picture by for each EXIF orientation. */
// shortcut: mirrored orientations (2, 4, 5, 7, rare outside selfies) are drawn unmirrored
const TURN = { 3: 180, 4: 180, 5: -90, 6: -90, 7: 90, 8: 90 };

/**
 * @param {(Uint8Array | {bytes: Uint8Array, size: [number, number]})[]} images JPEG or PNG files, in
 *   page order; `size` (pt) overrides the page size the pixels would give (SVGs drawn at 300 dpi)
 * @returns {Promise<Uint8Array>} a PDF with one page per picture
 */
export async function imagesToPdf(images) {
  const doc = await PDFDocument.create();
  for (const item of images) {
    const { bytes, size } = item instanceof Uint8Array ? { bytes: item } : item;
    if (!isJpeg(bytes) && !isPng(bytes)) throw new Error("Only JPEG and PNG pictures can be embedded.");
    const image = isJpeg(bytes) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const turn = isJpeg(bytes) ? TURN[jpegOrientation(bytes)] ?? 0 : 0;
    const [pw, ph] = size ?? [image.width * PT_PER_PX, image.height * PT_PER_PX];
    const fit = Math.min(1, MAX_SIDE / Math.max(pw, ph));
    const [w, h] = [pw * fit, ph * fit];
    const page = doc.addPage(Math.abs(turn) === 90 ? [h, w] : [w, h]);
    // pdf-lib turns the picture about its bottom-left corner; put that corner where it lands
    const [x, y] = { 0: [0, 0], 180: [w, h], [-90]: [0, w], 90: [h, 0] }[turn];
    page.drawImage(image, { x, y, width: w, height: h, rotate: degrees(turn) });
  }
  return doc.save();
}

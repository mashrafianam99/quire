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

/** Degrees pdf-lib turns the picture by for each EXIF orientation. */
// shortcut: mirrored orientations (2, 4, 5, 7, rare outside selfies) are drawn unmirrored
const TURN = { 3: 180, 4: 180, 5: -90, 6: -90, 7: 90, 8: 90 };

/**
 * @param {Uint8Array[]} images JPEG or PNG files, in page order
 * @returns {Promise<Uint8Array>} a PDF with one page per picture
 */
export async function imagesToPdf(images) {
  const doc = await PDFDocument.create();
  for (const bytes of images) {
    if (!isJpeg(bytes) && !isPng(bytes)) throw new Error("Only JPEG and PNG pictures can be embedded.");
    const image = isJpeg(bytes) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const turn = isJpeg(bytes) ? TURN[jpegOrientation(bytes)] ?? 0 : 0;
    const scale = PT_PER_PX * Math.min(1, MAX_SIDE / (PT_PER_PX * Math.max(image.width, image.height)));
    const [w, h] = [image.width * scale, image.height * scale];
    const page = doc.addPage(Math.abs(turn) === 90 ? [h, w] : [w, h]);
    // pdf-lib turns the picture about its bottom-left corner; put that corner where it lands
    const [x, y] = { 0: [0, 0], 180: [w, h], [-90]: [0, w], 90: [h, 0] }[turn];
    page.drawImage(image, { x, y, width: w, height: h, rotate: degrees(turn) });
  }
  return doc.save();
}

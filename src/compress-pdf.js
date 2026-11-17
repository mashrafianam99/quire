// Make a PDF smaller with MuPDF, on the device.
// 1. Images larger than MAX_SIDE pixels are drawn again smaller (MuPDF's own smooth scaler);
//    photos (JPEG/JPEG 2000) are re-encoded as JPEG, other images stay lossless.
// 2. Saving drops unused and duplicate objects, compresses every stream and packs objects
//    into object streams.
import * as mupdf from "mupdf";

const { ColorSpace, DrawDevice, Matrix, Pixmap } = mupdf;

export const MAX_SIDE = 2000; // px; about 180 dpi across a full A4/Letter page
const JPEG_QUALITY = 75;
const WORTH_IT = 0.9; // re-encode a photo only if it gets at least 10% smaller
const PHOTO_FILTERS = new Set(["DCTDecode", "JPXDecode"]);
const SAVE_OPTIONS = "garbage=deduplicate,compress,compress-fonts,compress-images,objstms,compression-effort=100";

const filtersOf = (dict) => {
  const f = dict.get("Filter");
  if (f.isName()) return [f.asName()];
  const out = [];
  if (f.isArray()) f.forEach((v) => out.push(v.asName()));
  return out;
};

/** Image XObjects worth rewriting, as {obj, dict, photo}; masks and images with masks are left alone. */
function imagesToShrink(pdf) {
  const images = [];
  const masks = new Set();
  for (let num = 1; num < pdf.countObjects(); num++) {
    const obj = pdf.newIndirect(num);
    if (!obj.isStream()) continue;
    const dict = obj.resolve();
    if (!dict.get("Subtype").isName() || dict.get("Subtype").asName() !== "Image") continue;
    for (const key of ["SMask", "Mask"]) {
      const m = dict.get(key);
      if (m.isIndirect()) masks.add(m.asIndirect());
    }
    images.push({ num, obj, dict });
  }
  // shortcut: masked images (logos with transparency) and the masks themselves are kept as they
  // are, since redrawing would need the mask resampled too; handle them if users have big ones
  return images.filter(({ num, dict }) => !masks.has(num)
    && !dict.get("SMask").isIndirect() && !dict.get("Mask").isIndirect()
    && !(dict.get("ImageMask").isBoolean() && dict.get("ImageMask").asBoolean())
    && dict.get("BitsPerComponent").isNumber() && dict.get("BitsPerComponent").asNumber() >= 8)
    .map(({ obj, dict }) => ({ obj, dict, photo: filtersOf(dict).some((f) => PHOTO_FILTERS.has(f)) }));
}

/** `image` drawn at w×h pixels, in gray or RGB. */
function redraw(image, w, h) {
  const gray = image.getColorSpace()?.getNumberOfComponents() === 1;
  const pixmap = new Pixmap(gray ? ColorSpace.DeviceGray : ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pixmap.clear(255);
  const device = new DrawDevice(Matrix.identity, pixmap);
  device.fillImage(image, [w, 0, 0, h, 0, 0], 1);
  device.close();
  return { pixmap, gray };
}

/** Rewrite one image smaller; returns whether it changed. */
function shrinkImage(pdf, { obj, dict, photo }) {
  const image = pdf.loadImage(obj);
  const [w, h] = [image.getWidth(), image.getHeight()];
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  if (scale === 1 && !photo) return false; // already small and lossless: saving compresses it
  const [nw, nh] = [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
  const { pixmap, gray } = redraw(image, nw, nh);
  const data = photo ? pixmap.asJPEG(JPEG_QUALITY) : Uint8Array.from(pixmap.getPixels()); // writeStream wants a Uint8Array
  if (photo && scale === 1 && data.length >= obj.readRawStream().getLength() * WORTH_IT) return false;

  if (photo) obj.writeRawStream(data);
  else obj.writeStream(data); // stored raw here; the save compresses it losslessly
  dict.put("Width", nw);
  dict.put("Height", nh);
  dict.put("BitsPerComponent", 8);
  dict.put("ColorSpace", pdf.newName(gray ? "DeviceGray" : "DeviceRGB"));
  for (const key of ["DecodeParms", "Decode", "Filter"]) dict.delete(key);
  if (photo) dict.put("Filter", pdf.newName("DCTDecode"));
  return true;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{bytes: Uint8Array|null, before: number, after: number, images: number}}
 *   bytes is null when the file couldn't be made smaller.
 */
export function compressPdf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF();
    if (!pdf) throw new Error("Only PDF files can be compressed.");
    if (pdf.needsPassword()) throw new Error("Quire can't compress password-protected PDFs yet.");
    let images = 0;
    for (const img of imagesToShrink(pdf)) {
      try {
        if (shrinkImage(pdf, img)) images++;
      } catch {
        // an image MuPDF can't decode is left exactly as it was
      }
    }
    const out = pdf.saveToBuffer(SAVE_OPTIONS).asUint8Array().slice();
    const smaller = out.length < bytes.length;
    return { bytes: smaller ? out : null, before: bytes.length, after: smaller ? out.length : bytes.length, images };
  } finally {
    doc.destroy();
  }
}

// OCR: make scanned pages searchable. Each page without text is rendered, read by
// Tesseract (offline, in a worker), and the words are laid back onto the ORIGINAL page as
// invisible text, so the page looks exactly the same but can be searched and selected.
import { createWorker, OEM } from "tesseract.js";
import { StandardFonts } from "pdf-lib";
import { loadPdf } from "./viewer.js";
import { loadForEditing } from "./pageops.js";

const OCR_DPI = 300;
const PDF_DPI = 72;
const MIN_WORD_CONFIDENCE = 40;
const ASSETS = new URL("tesseract/", document.baseURI).href;

async function startWorker() {
  return createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: ASSETS + "worker.min.js",
    corePath: ASSETS + "core",
    langPath: ASSETS + "lang",
    workerBlobURL: false,
    cacheMethod: "none",
    // Android's build unzips .gz files it packs into the app (eng.traineddata.gz → eng.traineddata)
    gzip: !window.Capacitor?.isNativePlatform?.(),
  });
}

// shortcut: the standard Helvetica font only covers Latin-1; other characters become "?".
// Embed a Unicode font (pdf-lib + fontkit) when adding non-Latin OCR languages.
function encodable(text, charset) {
  return [...text].map((c) => (charset.has(c.codePointAt(0)) ? c : "?")).join("");
}

/**
 * @returns {Promise<{bytes: Uint8Array|null, recognized: number, skipped: number}>}
 *   bytes is null when every page already had text.
 */
export async function ocrPdf(bytes, onProgress = () => {}) {
  const src = await loadPdf(bytes).promise;
  const out = await loadForEditing(bytes);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const charset = new Set(font.getCharacterSet());
  let worker = null;
  let recognized = 0, skipped = 0;
  try {
    for (let n = 1; n <= src.numPages; n++) {
      onProgress(n, src.numPages);
      const page = await src.getPage(n);
      const { items } = await page.getTextContent();
      if (items.some((i) => i.str.trim())) { skipped++; continue; }

      // shortcut: pages are read unrotated; a scan stored sideways with /Rotate is read sideways.
      const viewport = page.getViewport({ scale: OCR_DPI / PDF_DPI, rotation: 0 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;

      worker ??= await startWorker();
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      canvas.width = canvas.height = 0;

      const target = out.getPage(n - 1);
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            for (const word of line.words) {
              const text = encodable(word.text.trim(), charset);
              if (!text || word.confidence < MIN_WORD_CONFIDENCE) continue;
              const [x0, y0] = viewport.convertToPdfPoint(word.bbox.x0, word.bbox.y1);
              const [x1, y1] = viewport.convertToPdfPoint(word.bbox.x1, word.bbox.y0);
              const width = x1 - x0, height = y1 - y0;
              const widthAt1 = font.widthOfTextAtSize(text, 1);
              if (width <= 0 || height <= 0 || widthAt1 <= 0) continue;
              // Size the invisible word so selecting it covers the word in the image.
              const size = Math.min(width / widthAt1, height * 1.5);
              target.drawText(text, { x: x0, y: y0 + height * 0.15, size, font, opacity: 0 });
            }
          }
        }
      }
      recognized++;
    }
  } finally {
    await worker?.terminate();
    await src.loadingTask.destroy();
  }
  return { bytes: recognized ? await out.save() : null, recognized, skipped };
}

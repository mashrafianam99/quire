import { defineConfig } from "vite";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { writeDictionary } from "./scripts/build-dictionary.mjs";

// pdf.js fetches CMaps, standard fonts, ICC profiles and WASM decoders by URL at runtime.
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(`node_modules/pdfjs-dist/${dir}`, `public/pdfjs/${dir}`, { recursive: true });
}

// OCR runs fully offline: ship tesseract's worker, LSTM cores and English model.
cpSync("node_modules/tesseract.js/dist/worker.min.js", "public/tesseract/worker.min.js");
for (const file of readdirSync("node_modules/tesseract.js-core")) {
  if (file.endsWith("-lstm.wasm.js")) {
    cpSync(`node_modules/tesseract.js-core/${file}`, `public/tesseract/core/${file}`);
  }
}
cpSync("node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  "public/tesseract/lang/eng.traineddata.gz");

// The dictionary works offline too: WordNet packed into per-letter files (a few seconds, once).
if (!existsSync("public/dictionary/a.json")) writeDictionary("public/dictionary");

export default defineConfig({
  base: "./", // relative paths so the same build works inside the Tauri shell later
  build: { target: "esnext" },
  // mupdf finds its .wasm via import.meta.url, which pre-bundling would break
  optimizeDeps: { exclude: ["mupdf"] },
});

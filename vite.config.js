import { defineConfig } from "vite";
import { cpSync } from "node:fs";

// pdf.js fetches CMaps, standard fonts, ICC profiles and WASM decoders by URL at runtime.
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(`node_modules/pdfjs-dist/${dir}`, `public/pdfjs/${dir}`, { recursive: true });
}

export default defineConfig({
  base: "./", // relative paths so the same build works inside the Tauri shell later
  build: { target: "esnext" },
});

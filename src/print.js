// Print by rendering each page to an image and printing those, so it works the same in a
// browser, the desktop shell and Android (none of which can be relied on to print a PDF).
import { loadPdf } from "./viewer.js";

const PRINT_DPI = 150;
const PDF_DPI = 72;

export async function printPdf(bytes) {
  document.querySelector("#print-root")?.remove();
  const doc = await loadPdf(bytes).promise;
  const root = Object.assign(document.createElement("div"), { id: "print-root" });
  const urls = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: PRINT_DPI / PDF_DPI });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport, intent: "print" }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
      canvas.width = canvas.height = 0; // free the pixels now, big documents add up
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = Object.assign(document.createElement("img"), { src: url, alt: `Page ${n}` });
      root.append(img);
    }
  } finally {
    await doc.loadingTask.destroy();
  }
  document.body.append(root);
  await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode()));
  await new Promise((resolve) => {
    window.addEventListener("afterprint", resolve, { once: true });
    window.print();
  });
  root.remove();
  urls.forEach(URL.revokeObjectURL);
}

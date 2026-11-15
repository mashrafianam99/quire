// pdf_viewer.mjs reads the core library from globalThis.pdfjsLib, so this module
// must be imported before it.
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
globalThis.pdfjsLib = pdfjsLib;

export { pdfjsLib };

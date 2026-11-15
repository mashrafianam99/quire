# Quire

A free, open-source PDF editor. Everything runs on your device — no account, no uploads, no telemetry.

Licensed under the **GNU AGPL v3 or later** (see `LICENSE`).

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for page operations
npm run build    # static build in dist/
```

## What works today (phase 1)

- Open many PDFs in tabs (button, Ctrl+O, or drag-and-drop); password-protected files prompt for the password
- Fast rendering with selectable text, links and fillable forms (pdf.js)
- Search with match count (Ctrl+F, Enter / Shift+Enter)
- Annotate: highlight, freehand draw, text boxes, images — with color and size controls
- Sign: draw your signature once (kept on this device only), then place it as a movable, resizable image
- Undo / redo (buttons, or Ctrl+Z / Ctrl+Y while editing)
- Print (Ctrl+P) — pages are rendered to images, so it works the same on every platform
- Pages sidebar: rotate, delete, extract to a new tab, drag to reorder
- Combine files: append other PDFs to the current one
- Recognize text (OCR): makes scanned pages searchable, fully offline (Tesseract)
- Edit text: click a line, change it in place (Enter applies, Esc cancels); new text uses the closest standard font
- Redact: drag boxes, Apply — the text, images and drawings under them are permanently deleted from the file (MuPDF)
- Zoom with Ctrl+wheel or touchpad pinch
- Save keeps annotations and form input (Ctrl+S); warns before closing with unsaved changes

## Architecture

| File | Role |
|---|---|
| `src/viewer.js` | Wraps the pdf.js viewer components (render, text layer, search, forms, annotation editor) |
| `src/pageops.js` | Page operations on raw bytes with pdf-lib — pure functions, unit-tested |
| `src/thumbs.js` | Lazy thumbnail sidebar with page actions and drag reorder |
| `src/ocr.js` | Offline OCR: Tesseract words laid back as invisible text |
| `src/redact.js`, `src/redact-pdf.js` | Redaction marks UI; MuPDF removal — unit-tested |
| `src/textedit.js`, `src/textedit-pdf.js` | In-place line editor; MuPDF line lookup/removal + pdf-lib rewrite — unit-tested |
| `src/main.js` | Tabs, files, toolbar and keyboard wiring |

## Built on

| Library | License | Used for |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | Rendering, text, search, forms, annotations |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | MIT | Page operations, merging, writing text |
| [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js) | AGPL-3.0 | Redaction, text lookup for editing |
| [tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 | OCR |

## Roadmap

1. **Desktop shell** — Tauri 2 (needs Rust + MSVC Build Tools) for native open/save and a small installer
2. **Text editing, phase 2** — reuse the document's own font, reflow edits across a paragraph
3. **OCR** — more languages, rotated scans
4. **Conversion** — LibreOffice (Office → PDF), Docling (PDF → Word/Markdown), Ghostscript (PostScript, compression)
5. **Signatures & compliance** — pyHanko (PAdES), veraPDF (PDF/A, PDF/UA)
6. **Our own** — in-place text editing, accessibility auto-tagging, form designer, compare

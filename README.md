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
- Annotate: highlight, draw / sign, text boxes, images
- Pages sidebar: rotate, delete, extract to a new tab, drag to reorder
- Combine files: append other PDFs to the current one
- Save keeps annotations and form input (Ctrl+S); warns before closing with unsaved changes

## Architecture

| File | Role |
|---|---|
| `src/viewer.js` | Wraps the pdf.js viewer components (render, text layer, search, forms, annotation editor) |
| `src/pageops.js` | Page operations on raw bytes with pdf-lib — pure functions, unit-tested |
| `src/thumbs.js` | Lazy thumbnail sidebar with page actions and drag reorder |
| `src/main.js` | Tabs, files, toolbar and keyboard wiring |

## Built on

| Library | License | Used for |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | Rendering, text, search, forms, annotations |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | MIT | Page operations and merging |

## Roadmap

1. **Desktop shell** — Tauri 2 (needs Rust + MSVC Build Tools) for native open/save and a small installer
2. **OCR** — Tesseract / OCRmyPDF to make scanned PDFs searchable
3. **True redaction & text editing** — MuPDF (AGPL)
4. **Conversion** — LibreOffice (Office → PDF), Docling (PDF → Word/Markdown), Ghostscript (PostScript, compression)
5. **Signatures & compliance** — pyHanko (PAdES), veraPDF (PDF/A, PDF/UA)
6. **Our own** — in-place text editing, accessibility auto-tagging, form designer, compare

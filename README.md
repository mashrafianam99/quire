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
- Word → PDF: open (or combine) a .docx and it is converted on the device, with real selectable text: styles, lists, pictures, tables (borders, shading, merged cells), page breaks, and the header/footer with page numbers
- Pictures → PDF: open (or combine) JPEG, PNG, WebP, GIF, BMP, HEIC (iPhone) or SVG files and each becomes a page its own shape; pictures picked together make one PDF. JPEG/PNG are embedded untouched, phone photos stored sideways are turned upright, HEIC is decoded on the device (libheif) and SVG is drawn sharp at 300 dpi
- PDF → Word (To Word): an editable .docx with paragraphs, headings, bold/italic/colours, bullets, real Word tables (grid and row-striped, merged cells, borders, shading), pictures, diagrams as pictures, cover artwork behind the text, page size/margins, and the running header/footer with live page numbers
- Compress: drops unused/duplicate objects and recompresses streams; images over 2000 px are reduced (photos as JPEG, others stay lossless). Undoable; never makes the file bigger
- Edit text: click any text and its whole paragraph opens in place; edits re-wrap inside the paragraph's column, in the document's own embedded font (a similar standard font only for letters it lacks). Bold and italic words keep their style, and Ctrl+B / Ctrl+I change it (using the page's own bold/italic font when it has one); Ctrl+U or the style bar above the box underlines, and its colour picker recolours the selected words. When a paragraph grows, the content below it in its column moves down to make room (other columns stay put); when it shrinks, that content moves back up to close the gap. A callout box or accent bar around the paragraph grows and shrinks with it, and whatever no longer fits on the page continues on a new page inserted after it
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
| `src/compress-pdf.js` | MuPDF compression: image downsampling + compact save — unit-tested |
| `src/docx.js`, `src/convert.js` | Word (.docx) → XHTML (own zip + XML reader, no dependencies); MuPDF lays it out, pdf-lib stamps header/footer — unit-tested |
| `src/pdf-layout.js`, `src/pdf-to-docx.js` | PDF → Word: MuPDF reads lines, pictures and drawings (tables rebuilt from cell borders/shading, diagrams pictured); docx writes the Word file — unit-tested |
| `src/image-to-pdf.js` | Pictures → PDF: one page per picture, EXIF orientation honoured; HEIC via libheif, SVG via the browser — unit-tested |
| `src/textedit.js`, `src/textedit-pdf.js` | In-place line editor; MuPDF line lookup/removal + pdf-lib rewrite — unit-tested |
| `src/main.js` | Tabs, files, toolbar and keyboard wiring |

## Built on

| Library | License | Used for |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | Rendering, text, search, forms, annotations |
| [pdf-lib](https://github.com/Hopding/pdf-lib) + [fontkit](https://github.com/Hopding/fontkit) | MIT | Page operations, merging, writing text in embedded fonts |
| [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js) | AGPL-3.0 | Redaction, text lookup for editing, compression |
| [tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 | OCR |
| [docx](https://github.com/dolanmiu/docx) | MIT | Writing Word files (PDF → Word) |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | LGPL-3.0 | Decoding HEIC (iPhone) photos, loaded only when one is opened |

## Roadmap

1. **Desktop shell** — Tauri 2 (needs Rust + MSVC Build Tools) for native open/save and a small installer
2. **Text editing, next** — flow onto the next page when the page is full, non-Latin scripts (bundled Noto fonts)
3. **OCR** — more languages, rotated scans
4. **Conversion** — Excel/PowerPoint → PDF, PDF → Markdown, PostScript
5. **Signatures & compliance** — pyHanko (PAdES), veraPDF (PDF/A, PDF/UA)
6. **Our own** — in-place text editing, accessibility auto-tagging, form designer, compare

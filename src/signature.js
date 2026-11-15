// Signature pad: draw a signature once, reuse it on any document. The signature is kept
// in this browser's localStorage so it never leaves the device.
const STORE_KEY = "quire.signature";
const STROKE_WIDTH = 2.5;
const STROKE_COLOR = "#111827";
const CROP_PADDING = 8;

const dialog = document.querySelector("#sign-dialog");
const pad = dialog.querySelector(".sign-pad");
const ctx = pad.getContext("2d");
let bounds = null; // bounding box of the ink, in canvas pixels

function setupCanvas() {
  const ratio = devicePixelRatio || 1;
  const { width, height } = pad.getBoundingClientRect();
  pad.width = Math.round(width * ratio);
  pad.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = STROKE_COLOR;
  bounds = null;
}

function grow(x, y) {
  const ratio = devicePixelRatio || 1;
  const [px, py, r] = [x * ratio, y * ratio, STROKE_WIDTH * ratio];
  bounds = bounds
    ? { x0: Math.min(bounds.x0, px - r), y0: Math.min(bounds.y0, py - r), x1: Math.max(bounds.x1, px + r), y1: Math.max(bounds.y1, py + r) }
    : { x0: px - r, y0: py - r, x1: px + r, y1: py + r };
}

let drawing = false;
pad.addEventListener("pointerdown", (e) => {
  drawing = true;
  pad.setPointerCapture(e.pointerId);
  ctx.beginPath();
  ctx.moveTo(e.offsetX, e.offsetY);
  grow(e.offsetX, e.offsetY);
});
pad.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  for (const p of e.getCoalescedEvents?.() ?? [e]) {
    ctx.lineTo(p.offsetX, p.offsetY);
    grow(p.offsetX, p.offsetY);
  }
  ctx.stroke();
});
const stop = () => { drawing = false; };
pad.addEventListener("pointerup", stop);
pad.addEventListener("pointercancel", stop);

dialog.querySelector('[data-sign="clear"]').onclick = setupCanvas;

function loadSaved() {
  let url = null;
  try { url = localStorage.getItem(STORE_KEY); } catch { /* storage blocked: start empty */ }
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    const { width, height } = pad.getBoundingClientRect();
    const scale = Math.min(1, (width - 20) / img.width, (height - 20) / img.height);
    const w = img.width * scale, h = img.height * scale;
    const x = (width - w) / 2, y = (height - h) / 2;
    ctx.drawImage(img, x, y, w, h);
    grow(x, y);
    grow(x + w, y + h);
  };
  img.src = url;
}

/** The ink, cropped to its bounding box, as a transparent PNG. */
function cropped() {
  const x = Math.max(0, Math.floor(bounds.x0 - CROP_PADDING));
  const y = Math.max(0, Math.floor(bounds.y0 - CROP_PADDING));
  const w = Math.min(pad.width, Math.ceil(bounds.x1 + CROP_PADDING)) - x;
  const h = Math.min(pad.height, Math.ceil(bounds.y1 + CROP_PADDING)) - y;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").drawImage(pad, x, y, w, h, 0, 0, w, h);
  return out;
}

dialog.querySelector("form").addEventListener("submit", (e) => {
  if (e.submitter?.value === "ok" && !bounds) {
    e.preventDefault();
    dialog.querySelector(".sign-hint").textContent = "Draw your signature first.";
  }
});

/** Opens the pad; resolves to a PNG File of the signature, or null if cancelled. */
export function askForSignature() {
  dialog.querySelector(".sign-hint").textContent =
    "Draw with your mouse, touchpad (press and hold), pen or finger.";
  dialog.returnValue = "";
  dialog.showModal();
  setupCanvas();
  loadSaved();
  return new Promise((resolve) => {
    dialog.addEventListener("close", async () => {
      if (dialog.returnValue !== "ok" || !bounds) return resolve(null);
      const canvas = cropped();
      try { localStorage.setItem(STORE_KEY, canvas.toDataURL("image/png")); } catch { /* not remembered */ }
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      resolve(new File([blob], "signature.png", { type: "image/png" }));
    }, { once: true });
  });
}

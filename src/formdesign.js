// Form designer mode: every form field is outlined on the page; drag (or click) on an empty spot to
// add a field of the chosen type, drag a field to move it, drag its corner to resize it, and edit
// its properties in the panel at the side. The PDF work goes through `hooks` (forms.js in main.js),
// and every change rewrites the file, so it can be undone like any other edit.

const MIN_DRAG_PX = 6;
// a click (no drag) makes a field of this size, in pt
const DEFAULT_SIZE = { text: [160, 22], multiline: [200, 60], checkbox: [14, 14], radio: [14, 14], dropdown: [140, 22], list: [140, 60] };
const TYPE_LABEL = { text: "Text", multiline: "Multi-line text", checkbox: "Checkbox", radio: "Radio button", dropdown: "Dropdown", list: "List" };

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
};

/**
 * @param {ReturnType<import("./viewer.js").createViewer>} viewer
 * @param {HTMLElement} container the scrolling viewer element
 * @param {HTMLElement} workspace where the properties panel goes (gets `form-panel-open`)
 * @param {{list: () => Promise<object[]>, add: (spec: object) => Promise<string>,
 *   update: (name: string, changes: object) => Promise<void>, remove: (name: string) => Promise<void>,
 *   onChange: () => void, onResize: () => void}} hooks
 */
export function createFormDesigner(viewer, container, workspace, hooks) {
  let active = false;
  let type = "text";
  let fields = [];
  let selected = null; // {name, widget}
  const panel = el("aside", { className: "form-panel", hidden: true });
  panel.setAttribute("aria-label", "Field properties");
  workspace.append(panel);

  const isSelected = (f) => selected && f.name === selected.name && f.widget === selected.widget;

  function draw(pageNumber) {
    const view = viewer.pageView(pageNumber);
    if (!view?.div) return;
    for (const old of view.div.querySelectorAll(".form-box")) old.remove();
    if (!active) return;
    fields.forEach((f, i) => {
      if (f.page !== pageNumber - 1) return;
      const box = el("div", { className: `form-box${isSelected(f) ? " selected" : ""}`, title: `${f.name} (${TYPE_LABEL[f.type]})` },
        el("span", { className: "form-box-label", textContent: f.type === "radio" ? `${f.name}: ${f.option}` : f.name }),
        el("span", { className: "form-resize" }));
      box.dataset.index = String(i);
      viewer.placeOnPage(box, pageNumber, f.rect);
      view.div.append(box);
    });
  }
  const drawAll = () => { for (let n = 1; n <= viewer.pageCount; n++) draw(n); };

  async function refresh() {
    fields = active ? await hooks.list() : [];
    if (selected && !fields.some(isSelected)) selected = null;
    drawAll();
    showPanel();
  }

  /** Runs a change, then re-reads the fields (the document was reopened). */
  async function change(task) {
    try {
      await task();
    } finally {
      await refresh();
    }
  }

  // ---------- the properties panel ----------
  function showPanel() {
    const field = fields.find(isSelected);
    const wasOpen = !panel.hidden;
    panel.hidden = !field;
    workspace.classList.toggle("form-panel-open", !!field);
    if (wasOpen !== !panel.hidden) hooks.onResize();
    if (!field) return;
    const apply = (changes) => change(() => hooks.update(field.name, changes));
    const row = (label, input) => el("label", { className: "form-prop" }, el("span", { textContent: label }), input);
    const name = el("input", { type: "text", value: field.name });
    name.onchange = () => { const v = name.value.trim(); if (v && v !== field.name) { selected = { ...selected, name: v }; apply({ name: v }); } };
    const required = el("input", { type: "checkbox", checked: field.required });
    required.onchange = () => apply({ required: required.checked });
    const parts = [el("h2", { textContent: TYPE_LABEL[field.type] }), row("Name", name), row("Required", required)];
    if (field.type === "text" || field.type === "multiline") {
      const size = el("input", { type: "number", min: "0", max: "72", value: field.fontSize ?? 0, title: "0 = fits the box" });
      size.onchange = () => apply({ fontSize: Number(size.value) });
      const multi = el("input", { type: "checkbox", checked: field.type === "multiline" });
      multi.onchange = () => apply({ multiline: multi.checked });
      const value = el("input", { type: "text", value: field.value ?? "" });
      value.onchange = () => apply({ value: value.value });
      parts.push(row("Font size (0 = auto)", size), row("Multi-line", multi), row("Default text", value));
    } else if (field.type === "checkbox") {
      const checked = el("input", { type: "checkbox", checked: !!field.value });
      checked.onchange = () => apply({ value: checked.checked });
      parts.push(row("Ticked at first", checked));
    } else if (field.type === "radio") {
      parts.push(el("p", { className: "form-hint", textContent: `This button's value: “${field.option}”. With it selected, choose Radio and click to add another button to this group.` }));
    } else {
      const options = el("textarea", { rows: 5, value: field.options.join("\n") });
      options.onchange = () => apply({ options: options.value.split("\n").map((s) => s.trim()).filter(Boolean) });
      parts.push(row("Options (one per line)", options));
    }
    const del = el("button", { type: "button", className: "btn danger", textContent: field.type === "radio" ? "Delete this group" : "Delete field" });
    del.onclick = () => { selected = null; change(() => hooks.remove(field.name)); };
    const close = el("button", { type: "button", className: "btn", textContent: "Close" });
    close.onclick = () => { selected = null; drawAll(); showPanel(); };
    panel.replaceChildren(...parts, el("div", { className: "form-actions" }, del, close));
  }

  // ---------- drawing, moving and resizing on the page ----------
  container.addEventListener("pointerdown", (e) => {
    if (!active || e.button !== 0) return;
    const pageDiv = e.target.closest?.(".page");
    if (!pageDiv) return;
    e.preventDefault();
    e.stopPropagation();
    const pageNumber = Number(pageDiv.dataset.pageNumber);
    const start = viewer.pdfPoint(pageDiv, e);
    const [sx, sy] = [e.clientX, e.clientY];
    const hit = e.target.closest(".form-box");
    const field = hit ? fields[Number(hit.dataset.index)] : null;
    const resizing = !!e.target.closest(".form-resize");
    const ghost = hit ?? el("div", { className: "form-box drawing" });
    if (!hit) pageDiv.append(ghost);
    const rectFor = (end) => {
      const [dx, dy] = [end[0] - start[0], end[1] - start[1]];
      if (!field) return [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
      const [x0, y0, x1, y1] = field.rect;
      // pdf y is up: the corner handle is the bottom-right one, so it moves x1 and y0
      return resizing ? [x0, Math.min(y0 + dy, y1 - 4), Math.max(x1 + dx, x0 + 4), y1] : [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
    };
    let moved = false;
    const move = (ev) => {
      moved ||= Math.hypot(ev.clientX - sx, ev.clientY - sy) >= MIN_DRAG_PX;
      if (moved) viewer.placeOnPage(ghost, pageNumber, rectFor(viewer.pdfPoint(pageDiv, ev)));
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (field) {
        selected = { name: field.name, widget: field.widget };
        if (moved) change(() => hooks.update(field.name, { rect: rectFor(viewer.pdfPoint(pageDiv, ev)), widget: field.widget }));
        else { drawAll(); showPanel(); }
        return;
      }
      ghost.remove();
      const [w, h] = DEFAULT_SIZE[type];
      const rect = moved ? rectFor(viewer.pdfPoint(pageDiv, ev)) : [start[0], start[1] - h, start[0] + w, start[1]];
      const group = type === "radio" && fields.find(isSelected)?.type === "radio" ? selected.name : undefined;
      change(async () => {
        const name = await hooks.add({ type, page: pageNumber - 1, rect, group });
        const added = (await hooks.list()).filter((f) => f.name === name);
        selected = { name, widget: added.at(-1)?.widget ?? 0 };
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, { capture: true });

  document.addEventListener("keydown", (e) => {
    if (!active || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const field = fields.find(isSelected);
    if ((e.key === "Delete" || e.key === "Backspace") && field) {
      e.preventDefault();
      selected = null;
      change(() => hooks.remove(field.name));
    } else if (e.key === "Escape" && field) {
      selected = null;
      drawAll();
      showPanel();
    }
  });

  // pdf.js removes unknown children of a page when it re-renders it (zoom, scrolling far)
  viewer.eventBus.on("pagerendered", ({ pageNumber }) => draw(pageNumber));

  return {
    get active() { return active; },
    get type() { return type; },
    setType(next) { type = next; hooks.onChange(); },
    async start() {
      active = true;
      container.classList.add("form-designing");
      hooks.onChange();
      await refresh();
    },
    /** Leaves the mode (e.g. the document is being replaced). */
    stop() {
      if (!active) return;
      active = false;
      selected = null;
      container.classList.remove("form-designing");
      fields = [];
      drawAll();
      showPanel();
      hooks.onChange();
    },
    refresh,
  };
}

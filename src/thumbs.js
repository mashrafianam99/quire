// Page sidebar: lazily rendered thumbnails with rotate / extract / delete and
// drag-to-reorder. All edits are reported back through `handlers`.
const THUMB_CSS_WIDTH = 132;

const ICONS = {
  rotate: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/>',
  extract: '<path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/>',
  delete: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

export function renderThumbs(list, doc, handlers) {
  list.replaceChildren();
  const renders = new Set();
  let destroyed = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      draw(entry.target);
    }
  }, { root: list, rootMargin: "300px 0px" });

  for (let i = 0; i < doc.numPages; i++) {
    const item = document.createElement("li");
    item.className = "thumb";
    item.dataset.index = i;
    item.draggable = true;
    item.innerHTML = `
      <button class="thumb-page" aria-label="Go to page ${i + 1}"><canvas></canvas></button>
      <span class="thumb-num">${i + 1}</span>
      <div class="thumb-actions">
        <button data-act="rotate" title="Rotate clockwise" aria-label="Rotate page ${i + 1}">${icon("rotate")}</button>
        <button data-act="extract" title="Extract to new tab" aria-label="Extract page ${i + 1}">${icon("extract")}</button>
        <button data-act="delete" title="Delete page" aria-label="Delete page ${i + 1}">${icon("delete")}</button>
      </div>`;
    list.append(item);
    observer.observe(item);
  }

  async function draw(item) {
    let task;
    try {
      const page = await doc.getPage(Number(item.dataset.index) + 1);
      if (destroyed) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: (THUMB_CSS_WIDTH * devicePixelRatio) / base.width,
      });
      const canvas = item.querySelector("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.aspectRatio = `${base.width} / ${base.height}`;
      task = page.render({ canvas, viewport });
      renders.add(task);
      await task.promise;
    } catch (err) {
      // Cancelled because the sidebar was torn down: expected, nothing to report.
      if (!destroyed && err?.name !== "RenderingCancelledException") {
        console.error("Thumbnail render failed", err);
      }
    } finally {
      renders.delete(task);
    }
  }

  const onClick = (e) => {
    const item = e.target.closest(".thumb");
    if (!item) return;
    const index = Number(item.dataset.index);
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "rotate") handlers.onRotate(index);
    else if (act === "extract") handlers.onExtract(index);
    else if (act === "delete") handlers.onDelete(index);
    else handlers.onSelect(index);
  };
  let dragFrom = null;
  const onDragStart = (e) => {
    dragFrom = Number(e.target.closest(".thumb")?.dataset.index);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e) => {
    if (dragFrom == null || !e.target.closest(".thumb")) return;
    e.preventDefault();
  };
  const onDrop = (e) => {
    const to = Number(e.target.closest(".thumb")?.dataset.index);
    e.preventDefault();
    if (dragFrom != null && !Number.isNaN(to) && to !== dragFrom) handlers.onMove(dragFrom, to);
    dragFrom = null;
  };
  list.addEventListener("click", onClick);
  list.addEventListener("dragstart", onDragStart);
  list.addEventListener("dragover", onDragOver);
  list.addEventListener("drop", onDrop);

  return {
    setActive(pageNumber) {
      list.querySelector(".thumb.active")?.classList.remove("active");
      const item = list.children[pageNumber - 1];
      item?.classList.add("active");
      item?.scrollIntoView({ block: "nearest" });
    },
    destroy() {
      destroyed = true;
      for (const task of renders) task.cancel();
      observer.disconnect();
      list.removeEventListener("click", onClick);
      list.removeEventListener("dragstart", onDragStart);
      list.removeEventListener("dragover", onDragOver);
      list.removeEventListener("drop", onDrop);
      list.replaceChildren();
    },
  };
}

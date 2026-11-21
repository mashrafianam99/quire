// The recent-documents list, shown on the start screen (cards with a preview) and under Open (a menu).
const PREVIEW_WIDTH = 180; // px; cards show it at 90 px, so it stays sharp on high-density screens

/** A small JPEG of page 1, or "" if it can't be drawn. */
export async function previewOf(doc) {
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PREVIEW_WIDTH / base.width });
    const canvas = Object.assign(document.createElement("canvas"),
      { width: Math.round(viewport.width), height: Math.round(viewport.height) });
    await page.render({ canvas, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.75);
  } catch {
    return ""; // a preview is a nicety; the entry still reopens
  }
}

const sizeText = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** "14:05" today, "Yesterday", else "3 Nov". */
export function whenText(ms, now = Date.now()) {
  const d = new Date(ms);
  const day = (t) => new Date(t).toDateString();
  if (day(ms) === day(now)) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (day(ms) === day(now - 86_400_000)) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function thumb(entry) {
  const img = document.createElement("img");
  img.alt = "";
  if (entry.preview) img.src = entry.preview;
  return img;
}

function label(entry) {
  const span = document.createElement("span");
  const name = Object.assign(document.createElement("b"), { textContent: entry.name, title: entry.name });
  const meta = Object.assign(document.createElement("small"),
    { textContent: `${whenText(entry.opened)} · ${sizeText(entry.size)}` });
  span.append(name, meta);
  return span;
}

/**
 * @param {{recent, cards: HTMLElement, section: HTMLElement, menu: HTMLElement, onOpen: (entry) => void}} parts
 * `section` holds the start-screen cards (hidden while the list is empty); `menu` is the popover under Open.
 */
export function createRecentView({ recent, cards, section, menu, onOpen }) {
  const menuList = menu.querySelector("[data-recent-items]");
  const empty = menu.querySelector("[data-recent-empty]");
  const clears = document.querySelectorAll("[data-recent-clear]");

  async function refresh() {
    const list = await recent.list();
    section.hidden = !list.length;
    empty.hidden = !!list.length;
    for (const b of clears) b.hidden = !list.length;
    cards.replaceChildren(...list.map((entry) => {
      const li = document.createElement("li");
      li.className = "recent-card";
      const open = Object.assign(document.createElement("button"), { className: "recent-open", title: `Open ${entry.name}` });
      open.append(thumb(entry), label(entry));
      open.onclick = () => onOpen(entry);
      const remove = Object.assign(document.createElement("button"),
        { className: "recent-remove", textContent: "×", title: "Remove from the list" });
      remove.setAttribute("aria-label", `Remove ${entry.name} from the list`);
      remove.onclick = () => recent.remove(entry.id).then(refresh);
      li.append(open, remove);
      return li;
    }));
    menuList.replaceChildren(...list.map((entry) => {
      const item = Object.assign(document.createElement("button"), { className: "menu-item recent-item" });
      item.append(thumb(entry), label(entry));
      item.onclick = () => onOpen(entry);
      return item;
    }));
  }

  for (const b of clears) b.onclick = () => recent.clear().then(refresh);
  refresh();
  return {
    refresh,
    /** Put a document (now open as `doc`) at the top of the list. */
    async remember(name, bytes, doc) {
      await recent.add({ name, bytes, preview: await previewOf(doc) });
      await refresh();
    },
  };
}

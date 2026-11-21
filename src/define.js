// Double-click (or double-tap) a word while reading: a dictionary panel at the side shows its
// meanings by part of speech, synonyms and examples, from the offline WordNet files. The page
// narrows to make room, so the panel never covers the text; each double-click updates it.
// Synonyms and suggestions are links, and words in the panel can be double-clicked too.
import { lookup, suggest, loadShard, keepDictionaryOnDevice } from "./dictionary.js";

const SHOWN = 3; // senses per part of speech before "Show all"
const WORD_CHAR = /[\p{L}\p{M}\p{N}'’_-]/u;
const LOOKS_LIKE_WORD = /\p{L}/u;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

const JOIN_PIECES = 6; // at most this many text pieces either side are joined into one word

/** Where a text piece is drawn (its own text, not its wrapper element, which may have no size). */
function boxOf(text) {
  const range = document.createRange();
  range.selectNodeContents(text);
  return range.getBoundingClientRect();
}

/** Whether two text pieces sit on the same line (a word can be split across them). */
function sameLine(a, b) {
  const [ra, rb] = [boxOf(a), boxOf(b)];
  if (!ra.height || !rb.height) return false;
  return Math.abs((ra.top + ra.bottom) / 2 - (rb.top + rb.bottom) / 2) < Math.min(ra.height, rb.height) / 2;
}

/**
 * The whole word around a point in a text layer, joining the neighbouring pieces on the same line:
 * PDFs often draw a word in several pieces (a "ﬁ" ligature, kerning), so the browser's own
 * double-click selection can stop short ("nished").
 */
export function wordAround(node, offset) {
  if (node.nodeType !== Node.TEXT_NODE) return "";
  const walker = document.createTreeWalker(node.parentElement.closest(".textLayer") ?? node.parentElement, NodeFilter.SHOW_TEXT);
  let [start, end] = [offset, offset];
  const t = node.data;
  while (start > 0 && WORD_CHAR.test(t[start - 1])) start--;
  while (end < t.length && WORD_CHAR.test(t[end])) end++;
  let word = t.slice(start, end);
  // reached a piece's edge: carry on into the piece before or after it, if it's on the same line
  walker.currentNode = node;
  for (let n = 0, at = start, prev = walker.previousNode(); at === 0 && prev && n < JOIN_PIECES && sameLine(prev, node);
    n++, prev = walker.previousNode()) {
    const p = prev.data;
    let i = p.length;
    while (i > 0 && WORD_CHAR.test(p[i - 1])) i--;
    word = p.slice(i) + word;
    at = i;
  }
  walker.currentNode = node;
  for (let n = 0, at = end, len = t.length, next = walker.nextNode(); at === len && next && n < JOIN_PIECES && sameLine(next, node);
    n++, next = walker.nextNode()) {
    const s = next.data;
    let i = 0;
    while (i < s.length && WORD_CHAR.test(s[i])) i++;
    word += s.slice(0, i);
    [at, len] = [i, s.length];
  }
  return word.replace(/^[-_'’]+|[-_'’]+$/g, "");
}

/** One part of speech's senses, the first `limit` of them; synonyms look themselves up. */
function senseList(senses, limit, lookUp) {
  return el("ol", { className: "define-senses" }, ...senses.slice(0, limit).map((s) => el("li", {},
    el("span", { textContent: s.definition }),
    s.examples[0] ? el("q", { className: "define-example", textContent: s.examples[0] }) : null,
    s.synonyms.length ? el("span", { className: "define-synonyms" }, "Synonyms: ",
      ...s.synonyms.slice(0, 6).flatMap((w, i) => [i ? ", " : "", wordLink(w, lookUp)])) : null)));
}

function wordLink(word, lookUp) {
  const link = el("button", { type: "button", className: "define-link", textContent: word, title: `Look up “${word}”` });
  link.onclick = () => lookUp(word);
  return link;
}

/** The panel's body for what was found, or what to try when nothing was. */
function resultView(word, entries, suggestions, showAll, lookUp) {
  if (!entries.length) {
    const name = /^\p{Lu}/u.test(word) || /\d|%|[a-z][A-Z]/.test(word);
    return [
      el("p", { className: "define-none", textContent: name
        ? `No dictionary entry for “${word}”. It may be a name, a brand or code, which dictionaries don't list.`
        : `No dictionary entry for “${word}”.` }),
      suggestions.length ? el("p", { className: "define-suggest" }, "Did you mean: ",
        ...suggestions.flatMap((w, i) => [i ? ", " : "", wordLink(w, lookUp)])) : null,
    ];
  }
  return entries.flatMap(({ lemma, senses, note }, i) => {
    const parts = [...new Set(senses.map((s) => s.pos))];
    return [
      i > 0 || note ? el("h3", { className: "define-lemma", textContent: note ? `${lemma} (${note})` : lemma }) : null,
      ...parts.flatMap((pos) => {
        const own = senses.filter((s) => s.pos === pos);
        return [el("h4", { className: "define-pos", textContent: pos }), senseList(own, showAll ? own.length : SHOWN, lookUp)];
      }),
    ];
  });
}

/**
 * @param {HTMLElement} container the scrolling viewer element
 * @param {HTMLElement} app the element that gets the `defining` class while the panel is open
 * @param {() => boolean} isReading whether a double-click should look words up (not while editing)
 * @param {() => void} onResize called after the panel opens or closes, as the view's width changes
 */
export function createDefiner(container, app, isReading, onResize = () => {}) {
  const title = el("h2", { id: "define-title" });
  const closeButton = el("button", { type: "button", className: "define-close", textContent: "×", title: "Close (Esc)" });
  closeButton.setAttribute("aria-label", "Close the dictionary");
  const body = el("div", { className: "define-body" });
  const panel = el("aside", { className: "define-panel", hidden: true },
    el("div", { className: "define-head" }, title, closeButton), body);
  panel.setAttribute("aria-labelledby", "define-title");
  panel.setAttribute("aria-live", "polite");
  app.append(panel);
  let asked = 0; // the latest lookup; older answers that arrive late are dropped

  function close() {
    asked++;
    panel.hidden = true;
    if (app.classList.contains("defining")) { app.classList.remove("defining"); onResize(); }
  }
  closeButton.onclick = close;

  async function lookUp(raw) {
    const word = raw.normalize("NFKC").trim(); // a "ﬁ" ligature shows as "fi"
    if (!word || !LOOKS_LIKE_WORD.test(word)) return;
    const mine = ++asked;
    title.textContent = word;
    body.replaceChildren(el("p", { className: "define-none", textContent: "Looking up…" }));
    panel.hidden = false;
    if (!app.classList.contains("defining")) { app.classList.add("defining"); onResize(); }
    let entries, suggestions = [];
    try {
      entries = await lookup(word, loadShard);
      if (!entries.length) suggestions = await suggest(word, loadShard);
    } catch (err) {
      if (mine === asked) body.replaceChildren(el("p", { className: "define-none", textContent: err.message }));
      return;
    }
    if (mine !== asked) return;
    const render = (showAll) => {
      const hidden = entries.some((e) => [...new Set(e.senses.map((s) => s.pos))]
        .some((pos) => e.senses.filter((s) => s.pos === pos).length > SHOWN));
      const total = entries.reduce((n, e) => n + e.senses.length, 0);
      const more = !showAll && hidden ? el("button", { type: "button", className: "define-more", textContent: `Show all ${total} meanings` }) : null;
      if (more) more.onclick = () => render(true);
      body.replaceChildren(...resultView(word, entries, suggestions, showAll, lookUp).filter(Boolean), ...(more ? [more] : []));
      body.scrollTop = 0;
    };
    render(false);
  }

  container.addEventListener("dblclick", () => {
    if (!isReading()) return;
    const selection = getSelection();
    if (!selection.rangeCount || !selection.anchorNode?.parentElement?.closest(".textLayer")) return;
    const range = selection.getRangeAt(0);
    const word = wordAround(range.startContainer, range.startOffset) || selection.toString();
    lookUp(word);
  });
  // a word in the panel itself can be looked up the same way
  panel.addEventListener("dblclick", () => {
    const word = getSelection().toString().trim();
    if (word && !word.includes(" ")) lookUp(word);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden && !e.target.closest?.("input, textarea, [contenteditable]")) close();
  });
  // keep the whole dictionary on the device (once, in the background), so it works with no server
  // or network; ask the browser not to clear it when space runs low
  const keep = () => keepDictionaryOnDevice().catch(() => false);
  const later = window.requestIdleCallback ?? ((run) => setTimeout(run, 3000));
  later(() => { navigator.storage?.persist?.().catch(() => {}); keep(); }, { timeout: 10000 });
  window.addEventListener("online", keep); // a warm-up cut short finishes when the connection is back
  return { close, lookUp };
}

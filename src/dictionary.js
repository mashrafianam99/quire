// The offline dictionary: looks a word up in the per-letter WordNet files that
// scripts/build-dictionary.mjs writes to public/dictionary/. Nothing leaves the device.

import { IRREGULAR, FUNCTION_WORDS, CONTRACTIONS, ABBREVIATIONS } from "./dictionary-extra.js";
import { deviceStore } from "./device-store.js";

/** The shard a lemma lives in: its first letter, a–z, else "_". */
export const shardOf = (lemma) => (/^[a-z]/.test(lemma) ? lemma[0] : "_");

/** A word as it's looked up: lower case, straight apostrophes, no surrounding punctuation. */
export const normalize = (raw) => raw.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'")
  .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/g, " ");

// WordNet's own ("morphy") endings: what an inflected word may have been before it
const ENDINGS = [
  ["s", ""], ["ses", "s"], ["xes", "x"], ["zes", "z"], ["ches", "ch"], ["shes", "sh"], ["men", "man"], ["ies", "y"],
  ["es", "e"], ["es", ""], ["ied", "y"], ["ed", "e"], ["ed", ""], ["ing", "e"], ["ing", ""],
  ["ier", "y"], ["iest", "y"], ["er", ""], ["est", ""], ["er", "e"], ["est", "e"],
];

/**
 * The word itself, then the base forms it may come from: irregular ones (went → go, children →
 * child), a possessive's word (pattern's → pattern), then regular endings (running → run).
 */
export function baseForms(word) {
  const forms = [word, ...(Object.hasOwn(IRREGULAR, word) ? IRREGULAR[word] : [])];
  const bare = word.replace(/'s$|s'$|'$/, "");
  if (bare !== word && bare) forms.push(bare, ...(Object.hasOwn(IRREGULAR, bare) ? IRREGULAR[bare] : []));
  for (const w of [bare || word]) {
    for (const [end, add] of ENDINGS) {
      if (w.length <= end.length + 1 || !w.endsWith(end)) continue;
      const stem = w.slice(0, -end.length) + add;
      forms.push(stem);
      // a doubled last consonant was added for the ending (running, bigger)
      if (!add && /([b-df-hj-np-tv-z])\1$/.test(stem)) forms.push(stem.slice(0, -1));
    }
  }
  return [...new Set(forms)];
}

const MAX_ENTRIES = 3; // the word, a base form or two, or a joined word's parts

/** The entry for exactly `lemma`: WordNet's senses, after a short one for small words it lacks. */
async function entryFor(lemma, load) {
  const shard = await load(shardOf(lemma));
  // "constructor" is a word, not a built-in, so only own keys count
  const wordnet = Object.hasOwn(shard, lemma) ? shard[lemma] : [];
  const small = [FUNCTION_WORDS, ABBREVIATIONS].flatMap((table) => (Object.hasOwn(table, lemma) ? table[lemma] : []));
  const senses = [
    ...small.map(([pos, definition, example]) => ({ pos, definition, synonyms: [], examples: example ? [example] : [] })),
    ...wordnet.map(([pos, definition, synonyms, examples]) => ({ pos, definition, synonyms, examples })),
  ];
  return senses.length ? { lemma, senses } : null;
}

/** The first of `forms` that has an entry. */
async function firstEntry(forms, load) {
  for (const form of forms) {
    const entry = await entryFor(form, load);
    if (entry) return entry;
  }
  return null;
}

// Endings that make a related word (creational → creation, iterator → iterate), tried last
const DERIVED = [["al", ""], ["ator", "ate"], ["ness", ""], ["ful", ""], ["less", ""], ["ment", ""], ["ize", ""], ["ise", ""]];
const PART = 3; // letters each half of a compound needs (checkbox → check + box)

/** Each of `words` looked up by its first form that has an entry, noted as part of `whole`. */
async function partsOf(words, whole, load) {
  const entries = await Promise.all(words.map((w) => firstEntry(baseForms(w), load)));
  return entries.every(Boolean) ? entries.map((e) => ({ ...e, note: `part of “${whole}”` })) : entries.filter(Boolean);
}

/** A compound of two dictionary words, as its two halves, longest first half first; or null. */
async function compoundOf(word, load) {
  if (!/^\p{L}+$/u.test(word)) return null;
  for (let i = word.length - PART; i >= PART; i--) {
    const [left, right] = await Promise.all([word.slice(0, i), word.slice(i)].map((w) => firstEntry(baseForms(w), load)));
    if (left && right) return [left, right].map((e) => ({ ...e, note: `part of “${word}”` }));
  }
  return null;
}

/**
 * The entries for `raw`, each {lemma, senses: [{pos, definition, synonyms, examples}], note?}: the
 * word's own and its base forms'; a contraction's words (don't → do, not); else a joined word's
 * parts (find_max, getInstance), a related word (creational → creation) or a compound's halves
 * (checkbox → check, box). `load(key)` returns a shard object.
 */
export async function lookup(raw, load) {
  const word = normalize(raw);
  if (!word) return [];
  if (Object.hasOwn(CONTRACTIONS, word)) {
    return (await partsOf(CONTRACTIONS[word], word, load)).map((e) => ({ ...e, note: `in “${word}”` }));
  }
  const found = [];
  for (const form of baseForms(word)) {
    const entry = await entryFor(form, load);
    if (entry && !found.some((e) => e.lemma === entry.lemma)) found.push(found.length ? { ...entry, note: "base form" } : entry);
    if (found.length === MAX_ENTRIES) break;
  }
  if (found.length) return found;
  // underscores, hyphens, slashes and camelCase join words that are looked up one by one
  const parts = raw.normalize("NFKC").split(/[_\-/]+|(?<=\p{Ll})(?=\p{Lu})/u).map(normalize).filter(Boolean);
  if (parts.length > 1) return partsOf(parts.slice(0, MAX_ENTRIES), word, load);
  for (const [end, add] of DERIVED) {
    if (word.length <= end.length + PART || !word.endsWith(end)) continue;
    const entry = await firstEntry(baseForms(word.slice(0, -end.length) + add), load);
    if (entry) return [{ ...entry, note: "related word" }];
  }
  return (await compoundOf(word, load)) ?? [];
}

/** How many single-letter edits turn `a` into `b`, or Infinity once over `max`. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...next) > max) return Infinity;
    row = next;
  }
  return row[b.length] <= max ? row[b.length] : Infinity;
}

const SUGGESTIONS = 5;

/** Words close to `raw` in spelling, closest and most used first (for a typo or an OCR slip). */
export async function suggest(raw, load) {
  const word = normalize(raw);
  if (word.length < 3) return [];
  const max = word.length > 6 ? 2 : 1;
  const shard = await load(shardOf(word));
  return Object.keys(shard)
    .map((lemma) => ({ lemma, d: distance(word, lemma, max), uses: shard[lemma].length }))
    .filter(({ d }) => d !== Infinity && d > 0)
    .sort((a, b) => a.d - b.d || b.uses - a.uses)
    .slice(0, SUGGESTIONS)
    .map(({ lemma }) => lemma);
}

// ---------- keeping the dictionary on the device ----------

/** Every shard the build writes (see scripts/build-dictionary.mjs). */
export const SHARD_KEYS = [..."abcdefghijklmnopqrstuvwxyz_"];
// stored copies carry this; change it when the files' format changes, so old copies are replaced
const STORED = "wordnet-3.1-v1";
const COMPLETE = `${STORED}:complete`;
const IN_MEMORY = 4; // parsed shards kept at once (they're 0.3–3 MB each)

/** A shard's JSON text from the app's own files. */
async function fetchFromApp(key) {
  const response = await fetch(`dictionary/${key}.json`);
  if (!response.ok) throw new Error(`The dictionary file “${key}” is missing (${response.status}).`);
  return response.text();
}

/**
 * Loads dictionary shards from what's stored on the device, else from the app's files (and
 * stores them). `warm()` stores every shard ahead of time, so the dictionary keeps working
 * when the app's server or the network is gone; it's a no-op once all are stored.
 * @param {{fetchFile?: (key: string) => Promise<string>, store?: {get, put}}} [sources]
 */
export function createShardLoader({ fetchFile = fetchFromApp, store = deviceStore("quire-dictionary", "shards") } = {}) {
  const parsed = new Map(); // key → Promise of the shard object, most recent last

  async function text(key) {
    const kept = await store.get(`${STORED}:${key}`);
    if (typeof kept === "string") return kept;
    let fetched;
    try {
      fetched = await fetchFile(key);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      // a network failure: the page is still open but Quire's server (npm run dev, or the app) has stopped
      throw new Error("Quire couldn't reach its dictionary files. If you started it with “npm run dev”, "
        + "start it again, then reload this page.");
    }
    await store.put(`${STORED}:${key}`, fetched);
    return fetched;
  }

  function load(key) {
    if (parsed.has(key)) {
      const hit = parsed.get(key);
      parsed.delete(key);
      parsed.set(key, hit); // most recently used
      return hit;
    }
    const shard = text(key).then((t) => JSON.parse(t));
    shard.catch(() => parsed.delete(key)); // a failure isn't kept: the next lookup tries again
    parsed.set(key, shard);
    while (parsed.size > IN_MEMORY) parsed.delete(parsed.keys().next().value);
    return shard;
  }

  /** Stores every shard; resolves to whether all are now on the device. */
  async function warm() {
    if (await store.get(COMPLETE)) return true;
    for (const key of SHARD_KEYS) {
      try {
        await text(key); // stored, not parsed: nothing stays in memory
      } catch {
        return false; // offline or the server stopped; the next start carries on
      }
    }
    await store.put(COMPLETE, true);
    return true;
  }

  return { load, warm };
}

const shared = createShardLoader();
/** The app's shard loader: from the device, else from the app's files. */
export const loadShard = (key) => shared.load(key);
/** Stores the whole dictionary on the device, in the background (see createShardLoader). */
export const keepDictionaryOnDevice = () => shared.warm();

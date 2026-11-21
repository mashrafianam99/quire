// Packs WordNet 3.1 (the wordnet-db package) into small per-letter JSON files for the offline
// dictionary: { lemma: [[part of speech, definition, synonyms, examples], ...] }, most common
// sense first. Run by vite.config.js when public/dictionary/ is missing; nothing is fetched online.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { shardOf } from "../src/dictionary.js";

const PARTS = [["noun", "noun"], ["verb", "verb"], ["adj", "adjective"], ["adv", "adverb"]];
const wordnetDir = () => createRequire(import.meta.url)("wordnet-db").path;

const words = (s) => s.replace(/_/g, " ");

/** The synsets of a data.* file: offset → {words, gloss}. Lines starting with spaces are the licence. */
export function parseData(text) {
  const synsets = new Map();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith(" ")) continue;
    const bar = line.indexOf(" | ");
    const t = line.slice(0, bar === -1 ? line.length : bar).split(" ");
    const count = parseInt(t[3], 16);
    const list = Array.from({ length: count }, (_, i) => words(t[4 + i * 2]).replace(/\(\w+\)$/, ""));
    synsets.set(t[0], { words: list, gloss: bar === -1 ? "" : line.slice(bar + 3).trim() });
  }
  return synsets;
}

/** A gloss is a definition, then optional examples in double quotes, separated by "; ". */
export function parseGloss(gloss) {
  const examples = [...gloss.matchAll(/"([^"]*)"/g)].map((m) => m[1].trim()).filter(Boolean);
  const first = gloss.search(/;?\s*"/);
  return { definition: (first === -1 ? gloss : gloss.slice(0, first)).trim(), examples };
}

/** Every lemma's senses, grouped into shards by first letter: Map key → {lemma: senses}. */
export function buildShards(dir = wordnetDir()) {
  const shards = new Map();
  for (const [file, pos] of PARTS) {
    const synsets = parseData(readFileSync(join(dir, `data.${file}`), "utf8"));
    for (const line of readFileSync(join(dir, `index.${file}`), "utf8").split("\n")) {
      if (!line || line.startsWith(" ")) continue;
      const t = line.trim().split(" ");
      const lemma = words(t[0]);
      const pointers = Number(t[3]);
      const offsets = t.slice(4 + pointers + 2, 4 + pointers + 2 + Number(t[2]));
      const key = shardOf(lemma);
      if (!shards.has(key)) shards.set(key, Object.create(null)); // "constructor" is a word too
      const entry = (shards.get(key)[lemma] ??= []);
      for (const offset of offsets) {
        const synset = synsets.get(offset);
        if (!synset) continue;
        const { definition, examples } = parseGloss(synset.gloss);
        const synonyms = synset.words.filter((w) => w.toLowerCase() !== lemma);
        entry.push([pos, definition, synonyms, examples]);
      }
    }
  }
  return shards;
}

/** Writes one JSON file per shard into `outDir`, with WordNet's licence beside them. */
export function writeDictionary(outDir) {
  const dir = wordnetDir();
  mkdirSync(outDir, { recursive: true });
  for (const [key, entries] of buildShards(dir)) writeFileSync(join(outDir, `${key}.json`), JSON.stringify(entries));
  copyFileSync(join(dir, "..", "LICENSE"), join(outDir, "WORDNET-LICENSE.txt")); // the licence asks for it
}

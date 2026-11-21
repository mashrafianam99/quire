import { test } from "node:test";
import assert from "node:assert/strict";
import { parseData, parseGloss, buildShards } from "../scripts/build-dictionary.mjs";
import { normalize, baseForms, lookup, suggest, shardOf, createShardLoader, SHARD_KEYS } from "../src/dictionary.js";

test("reads a WordNet data line: its words and its gloss", () => {
  const line = "02086723 05 n 03 dog 0 domestic_dog 0 Canis_familiaris 0 001 @ 02085998 n 0000 | a member of the genus Canis; \"the dog barked all night\"";
  const synsets = parseData(`  1 This software and database is being provided...\n${line}\n`);
  assert.deepEqual(synsets.get("02086723"), {
    words: ["dog", "domestic dog", "Canis familiaris"],
    gloss: "a member of the genus Canis; \"the dog barked all night\"",
  });
});

test("adjective markers like (a) are dropped from words", () => {
  const synsets = parseData("00217728 00 s 02 beautiful(a) 0 lovely 0 000 | delighting the senses\n");
  assert.deepEqual(synsets.get("00217728").words, ["beautiful", "lovely"]);
});

test("a gloss splits into its definition and its quoted examples", () => {
  assert.deepEqual(parseGloss("move fast by using one's feet; \"Don't run--you'll be out of breath\"; \"The children ran to the store\""), {
    definition: "move fast by using one's feet",
    examples: ["Don't run--you'll be out of breath", "The children ran to the store"],
  });
  assert.deepEqual(parseGloss("a domesticated carnivorous mammal (Canis familiaris)"), {
    definition: "a domesticated carnivorous mammal (Canis familiaris)", examples: [],
  });
});

test("words are cleaned before looking them up", () => {
  assert.equal(normalize("“Running,”"), "running");
  assert.equal(normalize("Dog’s"), "dog's");
  assert.equal(normalize("  E-mail. "), "e-mail");
});

test("base forms follow WordNet's endings, doubled consonants included", () => {
  assert.ok(baseForms("running").includes("run"));
  assert.ok(baseForms("boxes").includes("box"));
  assert.ok(baseForms("studies").includes("study"));
  assert.ok(baseForms("bigger").includes("big"));
  assert.ok(baseForms("made").includes("made"));
  assert.equal(baseForms("dog")[0], "dog", "the word itself first");
});

test("shards are named by the first letter", () => {
  assert.equal(shardOf("dog"), "d");
  assert.equal(shardOf("Émile"), "_");
  assert.equal(shardOf("3d"), "_");
});

// the real WordNet data, built in memory once
const shards = buildShards();
const load = async (key) => shards.get(key) ?? {};

test("looks up a word: meanings by part of speech, most common first, with synonyms and examples", async () => {
  const [dog] = await lookup("Dog", load);
  assert.equal(dog.lemma, "dog");
  assert.equal(dog.senses[0].pos, "noun");
  assert.match(dog.senses[0].definition, /domesticated/);
  assert.ok(dog.senses[0].synonyms.includes("domestic dog"));
  assert.ok(!dog.senses[0].synonyms.includes("dog"), "not the word itself");
  assert.ok(dog.senses.some((s) => s.pos === "verb"), "dog is a verb too");
  assert.ok(dog.senses.some((s) => s.examples.length), "some senses have examples");
});

test("an inflected word shows its own entry and its base form's", async () => {
  const entries = await lookup("running.", load);
  assert.deepEqual(entries.map((e) => e.lemma), ["running", "run"]);
  assert.ok(entries[1].senses.some((s) => s.pos === "verb"));
  const [box] = await lookup("boxes", load);
  assert.equal(box.lemma, "box");
});

const lemmas = async (raw) => (await lookup(raw, load)).map((e) => e.lemma);

test("small words WordNet leaves out (the, that, of, is) still have an entry", async () => {
  for (const w of ["the", "That", "of", "and", "how", "you"]) assert.ok((await lemmas(w)).length, `${w} found`);
  const [can, ...rest] = await lookup("can", load);
  assert.ok(can.senses.some((s) => s.pos === "auxiliary verb") && can.senses.some((s) => s.pos === "noun"), "both kinds of “can”");
  assert.deepEqual(await lemmas("is"), ["be"], "is → be");
  assert.equal(rest.length, 0);
});

test("irregular forms, possessives, contractions and ligatures find their word", async () => {
  assert.ok((await lemmas("went")).includes("go"));
  assert.ok((await lemmas("children")).includes("child"));
  assert.ok((await lemmas("better")).includes("good"));
  assert.ok((await lemmas("pattern’s")).includes("pattern"));
  assert.deepEqual(await lemmas("don't"), ["do", "not"]);
  assert.ok((await lemmas("ﬁnished")).includes("finish"), "the fi ligature is two letters");
});

test("joined words are looked up by their parts", async () => {
  assert.deepEqual(await lemmas("find_max"), ["find", "max"]);
  assert.deepEqual(await lemmas("getInstance"), ["get", "instance"]);
  assert.ok((await lemmas("e-mail")).length);
});

test("a word with no entry gets close spellings to try", async () => {
  assert.deepEqual(await lookup("pattren", load), []);
  assert.ok((await suggest("pattren", load)).includes("pattern"));
  assert.ok((await suggest("definately", load)).includes("definitely"));
  assert.deepEqual(await suggest("", load), []);
});

// ---------- keeping the dictionary on the device ----------

/** A fake server for the dictionary files: counts requests, and can be switched off. */
function fakeServer() {
  const server = { up: true, requests: 0 };
  server.fetchFile = async (key) => {
    server.requests++;
    if (!server.up) throw new TypeError("Failed to fetch");
    return JSON.stringify({ [`${key}word`]: [["noun", `a word starting with ${key}`, [], []]] });
  };
  return server;
}
const memoryStore = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, size: () => m.size }; };

test("a downloaded letter keeps working after a reload, even with the server gone", async () => {
  const [server, store] = [fakeServer(), memoryStore()];
  assert.deepEqual(Object.keys(await createShardLoader({ ...server, store }).load("q")), ["qword"]);
  server.up = false;
  const afterReload = createShardLoader({ ...server, store }); // a new page, same storage
  assert.deepEqual(Object.keys(await afterReload.load("q")), ["qword"]);
});

test("warming up downloads every letter once, so all of them work offline; a second warm-up downloads nothing", async () => {
  const [server, store] = [fakeServer(), memoryStore()];
  assert.equal(await createShardLoader({ ...server, store }).warm(), true);
  assert.equal(server.requests, SHARD_KEYS.length);
  server.up = false;
  const offline = createShardLoader({ ...server, store });
  for (const key of SHARD_KEYS) assert.ok(Object.keys(await offline.load(key)).length, `${key} offline`);
  assert.equal(await offline.warm(), true, "already complete");
  assert.equal(server.requests, SHARD_KEYS.length, "nothing more was asked for");
});

test("a warm-up cut short by a lost connection finishes on a later try", async () => {
  const [server, store] = [fakeServer(), memoryStore()];
  let budget = 5;
  const flaky = { fetchFile: async (key) => { if (budget-- <= 0) throw new TypeError("Failed to fetch"); return server.fetchFile(key); }, store };
  assert.equal(await createShardLoader(flaky).warm(), false);
  assert.equal(await createShardLoader({ ...server, store }).warm(), true);
  assert.equal(store.size(), SHARD_KEYS.length + 1, "every letter, plus the 'complete' mark");
});

test("a letter that was never downloaded, with no server, says what to do; a later lookup tries again", async () => {
  const server = fakeServer();
  server.up = false;
  const loader = createShardLoader({ ...server, store: memoryStore() });
  await assert.rejects(loader.load("q"), /couldn't reach.*reload/i);
  server.up = true;
  assert.deepEqual(Object.keys(await loader.load("q")), ["qword"], "not stuck on the failure");
});

test("multi-word entries are found with spaces, and unknown words give nothing", async () => {
  const [ice] = await lookup("ice cream", load);
  assert.equal(ice.lemma, "ice cream");
  assert.deepEqual(await lookup("qwzxvbn", load), []);
  const [constructor] = await lookup("constructor", load); // a word that's also a JavaScript built-in
  assert.match(constructor.senses[0].definition, /construct/);
  assert.deepEqual(await lookup("", load), []);
});

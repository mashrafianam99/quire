import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecent, withEntry, MAX_RECENT, MAX_BYTES } from "../src/recent.js";

function memoryStore() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
const bytes = (n) => new Uint8Array(n).fill(7);

test("newest first; opening a file again moves it to the top without a copy", async () => {
  const recent = createRecent(memoryStore());
  await recent.add({ name: "a.pdf", bytes: bytes(3) });
  await recent.add({ name: "b.pdf", bytes: bytes(4) });
  await recent.add({ name: "A.pdf", bytes: bytes(5) });
  const list = await recent.list();
  assert.deepEqual(list.map((e) => [e.name, e.size]), [["A.pdf", 5], ["b.pdf", 4]]);
  assert.equal((await recent.load(list[0].id)).length, 5, "the newest bytes are kept");
});

test("keeps at most MAX_RECENT and forgets the bytes of those that fall off", async () => {
  const store = memoryStore();
  const recent = createRecent(store);
  for (let i = 0; i < MAX_RECENT + 2; i++) await recent.add({ name: `f${i}.pdf`, bytes: bytes(1) });
  const list = await recent.list();
  assert.equal(list.length, MAX_RECENT);
  assert.equal(list[0].name, `f${MAX_RECENT + 1}.pdf`);
  assert.equal(await recent.load("f0.pdf"), undefined);
  assert.equal([...store.m.keys()].filter((k) => k.startsWith("file:")).length, MAX_RECENT);
});

test("remove and clear delete the stored files too; files over MAX_BYTES aren't kept", async () => {
  const store = memoryStore();
  const recent = createRecent(store);
  await recent.add({ name: "a.pdf", bytes: bytes(1) });
  await recent.add({ name: "b.pdf", bytes: bytes(1) });
  await recent.remove("a.pdf");
  assert.deepEqual((await recent.list()).map((e) => e.name), ["b.pdf"]);
  assert.equal(await recent.load("a.pdf"), undefined);
  await recent.clear();
  assert.deepEqual(await recent.list(), []);
  assert.equal(store.m.size, 1, "only the empty list is left");
  assert.equal(await recent.add({ name: "big.pdf", bytes: { length: MAX_BYTES + 1 } }), false);
});

test("changes made at the same time don't overwrite each other", async () => {
  const recent = createRecent(memoryStore());
  await Promise.all(["a", "b", "c"].map((n) => recent.add({ name: `${n}.pdf`, bytes: bytes(1) })));
  assert.equal((await recent.list()).length, 3);
  assert.deepEqual(withEntry([{ id: "x" }], { id: "x" }), [[{ id: "x" }], []]);
});

// Recently opened documents, kept on this device (IndexedDB) so they reopen with one click.
// Each entry is {id, name, size, opened (ms), preview (small JPEG data URL)}; the bytes are kept
// under their own key, so showing the list never loads the files.
import { deviceStore } from "./device-store.js";

export const MAX_RECENT = 8;
// shortcut: bigger files aren't kept (browser storage is limited); raise it if users miss them
export const MAX_BYTES = 50 * 1024 * 1024;
const LIST = "list";
const fileKey = (id) => `file:${id}`;

/** `entry` first, its older copy dropped, at most MAX_RECENT; returns [list, ids that fell off]. */
export function withEntry(list, entry) {
  const next = [entry, ...list.filter((e) => e.id !== entry.id)];
  return [next.slice(0, MAX_RECENT), next.slice(MAX_RECENT).map((e) => e.id)];
}

// shortcut: a document is known by its name, so two files with the same name share one entry
export const recentId = (name) => name.toLowerCase();

export function createRecent(store = deviceStore("quire-recent", "files")) {
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn)); // one change at a time, so the list isn't overwritten
  const list = async () => (await store.get(LIST)) ?? [];
  return {
    list,
    /** Remember (or refresh) a document; false if it's too big to keep. */
    add: ({ name, bytes, preview }) => serial(async () => {
      if (bytes.length > MAX_BYTES) return false;
      const id = recentId(name);
      const [next, dropped] = withEntry(await list(), { id, name, size: bytes.length, opened: Date.now(), preview });
      await store.put(fileKey(id), bytes);
      await store.put(LIST, next);
      for (const old of dropped) await store.delete(fileKey(old));
      return true;
    }),
    /** The document's bytes, or undefined if they're gone. */
    load: (id) => store.get(fileKey(id)),
    remove: (id) => serial(async () => {
      await store.put(LIST, (await list()).filter((e) => e.id !== id));
      await store.delete(fileKey(id));
    }),
    clear: () => serial(async () => {
      for (const e of await list()) await store.delete(fileKey(e.id));
      await store.put(LIST, []);
    }),
  };
}

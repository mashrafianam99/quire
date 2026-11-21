// A key-value store that outlives the page (IndexedDB), on this device only.
// Storage can be refused (private windows, full disk): then it quietly keeps things in memory for this visit.

/** {get, put, delete} on object store `storeName` of database `dbName`. */
export function deviceStore(dbName, storeName) {
  const memory = new Map();
  const fallback = {
    get: async (k) => memory.get(k),
    put: async (k, v) => { memory.set(k, v); },
    delete: async (k) => { memory.delete(k); },
  };
  if (typeof indexedDB === "undefined") return fallback;
  const db = new Promise((ok, fail) => {
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(storeName);
    open.onsuccess = () => ok(open.result);
    open.onerror = () => fail(open.error);
  });
  const run = (mode, act) => db.then((d) => new Promise((ok, fail) => {
    const tx = d.transaction(storeName, mode);
    const request = act(tx.objectStore(storeName));
    tx.oncomplete = () => ok(request.result);
    tx.onerror = () => fail(tx.error);
  }));
  return {
    get: (k) => run("readonly", (s) => s.get(k)).catch(() => fallback.get(k)),
    put: (k, v) => run("readwrite", (s) => s.put(v, k)).catch(() => fallback.put(k, v)),
    delete: (k) => run("readwrite", (s) => s.delete(k)).catch(() => fallback.delete(k)),
  };
}

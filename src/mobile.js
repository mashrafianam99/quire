// The Android app (Capacitor). Save writes into Documents/Quire, Share sends a copy to another app,
// and documents opened or shared from other apps (android/…/QuireIntentPlugin.java) arrive here.
// main.js loads this only inside the app, so the web and desktop builds never run it.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

const QuireIntent = registerPlugin("QuireIntent");
const FOLDER = "Quire";
const CHUNK = 0x8000; // String.fromCharCode takes its arguments on the stack
const SAME_FILE_MS = 5000;
const PIECE = 3 * 1024 * 1024; // bytes per write call (4 MB of base64)

/** Bytes → base64 (Capacitor's file calls take text). */
export function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += CHUNK) text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(text);
}

/**
 * Write `bytes` in pieces: each call crosses to Java as base64 text (2 bytes a character there), and the
 * whole file in one call ran a 22 MB PDF out of Java's 256 MB. Returns the file's URI.
 */
export async function writeInPieces(path, directory, bytes) {
  let uri;
  for (let at = 0; at === 0 || at < bytes.length; at += PIECE) {
    const data = toBase64(bytes.subarray(at, at + PIECE));
    if (at === 0) ({ uri } = await Filesystem.writeFile({ path, data, directory, recursive: true }));
    else await Filesystem.appendFile({ path, data, directory });
  }
  return uri;
}

/** Write into Documents/Quire (replacing a file of the same name) → {name, place}. */
export async function saveToDocuments(name, bytes) {
  await writeInPieces(`${FOLDER}/${name}`, Directory.Documents, bytes);
  return { name, place: `Documents/${FOLDER}` };
}

/** Android's share sheet with a copy of the document (WhatsApp, Drive, Gmail…). */
export async function shareFile(name, bytes) {
  await Share.share({ title: name, files: [await writeInPieces(name, Directory.Cache, bytes)] });
}

/**
 * The bytes of a copy QuireIntentPlugin left in the cache, read as a file (no base64: a 22 MB PDF as text
 * crashed the app), then the copy is deleted.
 */
async function readCopy(path) {
  const response = await fetch(Capacitor.convertFileSrc(`file://${path}`));
  if (!response.ok) throw new Error(`Quire couldn't read its copy (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  Filesystem.deleteFile({ path: `file://${path}` }).catch(() => {}); // the next start clears it anyway
  return bytes;
}

/** `onFile({name, bytes})` for the document Quire was started with and each one opened later. */
export async function listenForFiles(onFile, onError) {
  let last = { key: "", at: 0 };
  const deliver = async (file) => {
    if (!file) return;
    // a cold start hands over the same file twice (launch file and new-intent event): keep the first
    const key = `${file.name}:${file.size ?? file.error}`;
    if (key === last.key && Date.now() - last.at < SAME_FILE_MS) {
      if (file.path) Filesystem.deleteFile({ path: `file://${file.path}` }).catch(() => {});
      return;
    }
    last = { key, at: Date.now() };
    if (file.error) { onError(file.name, file.error); return; }
    try {
      onFile({ name: file.name, bytes: await readCopy(file.path) });
    } catch (err) {
      onError(file.name, err.message);
    }
  };
  await QuireIntent.addListener("file", deliver);
  deliver((await QuireIntent.takeLaunchFile()).file);
}

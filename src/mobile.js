// The Android app (Capacitor). Save writes into Documents/Quire, Share sends a copy to another app,
// and documents opened or shared from other apps (android/…/QuireIntentPlugin.java) arrive here.
// main.js loads this only inside the app, so the web and desktop builds never run it.
import { registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

const QuireIntent = registerPlugin("QuireIntent");
const FOLDER = "Quire";
const CHUNK = 0x8000; // String.fromCharCode takes its arguments on the stack
const SAME_FILE_MS = 5000;

/** Bytes → base64 (Capacitor's file calls take text). */
export function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += CHUNK) text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(text);
}

export function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Write into Documents/Quire (replacing a file of the same name) → {name, place}. */
export async function saveToDocuments(name, bytes) {
  await Filesystem.writeFile({ path: `${FOLDER}/${name}`, data: toBase64(bytes), directory: Directory.Documents, recursive: true });
  return { name, place: `Documents/${FOLDER}` };
}

/** Android's share sheet with a copy of the document (WhatsApp, Drive, Gmail…). */
export async function shareFile(name, bytes) {
  const { uri } = await Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: Directory.Cache });
  await Share.share({ title: name, files: [uri] });
}

/** `onFile({name, bytes})` for the document Quire was started with and each one opened later. */
export async function listenForFiles(onFile, onError) {
  let last = { key: "", at: 0 };
  const deliver = (file) => {
    if (!file) return;
    // a cold start hands over the same file twice (launch file and new-intent event): keep the first
    const key = `${file.name}:${file.data?.length ?? file.error}`;
    if (key === last.key && Date.now() - last.at < SAME_FILE_MS) return;
    last = { key, at: Date.now() };
    if (file.error) onError(file.name, file.error);
    else onFile({ name: file.name, bytes: fromBase64(file.data) });
  };
  await QuireIntent.addListener("file", deliver);
  deliver((await QuireIntent.takeLaunchFile()).file);
}

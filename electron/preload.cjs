// The only bridge between the Quire page and the computer: open and save files, nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quireDesktop", {
  /** Native Open dialog → [{name, path, bytes}]. */
  open: () => ipcRenderer.invoke("desktop:open"),
  /** Files Quire was started with (a double-clicked PDF). */
  initialFiles: () => ipcRenderer.invoke("desktop:initial-files"),
  /** Files double-clicked while Quire is already open. */
  onOpenFiles: (callback) => ipcRenderer.on("desktop:open-files", (_e, files) => callback(files)),
  /** Write over a file that was opened or saved before → {path, name}. */
  save: (path, bytes) => ipcRenderer.invoke("desktop:save", path, bytes),
  /** Native Save dialog → {path, name}, or null if cancelled. */
  saveAs: (name, bytes, extension) => ipcRenderer.invoke("desktop:save-as", name, bytes, extension),
});

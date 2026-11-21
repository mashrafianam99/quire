// Quire's desktop shell (Electron). The app itself is the same web build (dist/), served from
// inside the program as app://quire/, so it needs no server and works offline.
// The page gets no Node access: it reaches the disk only through preload.cjs, and may write only
// to files the user opened or picked in a Save dialog.
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const ORIGIN = "app://quire";
const OPENABLE = /\.(pdf|docx|jpe?g|png|webp|gif|bmp|heic|heif|svg)$/i;
const FILTERS = {
  ".pdf": [{ name: "PDF document", extensions: ["pdf"] }],
  ".docx": [{ name: "Word document", extensions: ["docx"] }],
};
const OPEN_FILTERS = [
  { name: "PDF, Word and pictures", extensions: ["pdf", "docx", "jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif", "svg"] },
  { name: "All files", extensions: ["*"] },
];

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const granted = new Set(); // files the page may write: ones the user opened or chose in a Save dialog
let win = null;
let pending = []; // files given on the command line before the page asked for them

/** Files named on a command line (double-clicked PDFs arrive this way). */
const filesIn = (argv) => argv.filter((a) => !a.startsWith("-") && OPENABLE.test(a)
  && existsSync(a) && statSync(a).isFile()).map((a) => path.resolve(a));

async function read(paths) {
  const files = [];
  for (const p of paths) {
    try {
      files.push({ name: path.basename(p), path: p, bytes: await readFile(p) });
      granted.add(p);
    } catch (err) {
      dialog.showErrorBox("Quire", `Couldn't open ${p}:\n${err.message}`);
    }
  }
  return files;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 400, show: false, title: "Quire",
    backgroundColor: "#f4f2ee", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  // links in PDFs open in the user's browser; the window itself never leaves the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
  // the page's "unsaved changes" check: Electron would cancel the close silently, so ask here
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question", buttons: ["Close without saving", "Cancel"], defaultId: 1, cancelId: 1,
      title: "Quire", message: "Some documents have unsaved changes.", detail: "Close Quire anyway?",
    });
    if (choice === 0) e.preventDefault();
  });
  win.on("closed", () => { win = null; });
  win.loadURL(`${ORIGIN}/index.html`);
}

ipcMain.handle("desktop:initial-files", async () => {
  const files = await read(pending);
  pending = [];
  return files;
});

ipcMain.handle("desktop:open", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"], filters: OPEN_FILTERS,
  });
  return canceled ? [] : read(filePaths);
});

ipcMain.handle("desktop:save", async (_e, file, bytes) => {
  if (!granted.has(file)) throw new Error("Quire can only save over files you opened or chose.");
  await writeFile(file, bytes);
  return { path: file, name: path.basename(file) };
});

ipcMain.handle("desktop:save-as", async (_e, name, bytes, extension) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: name, filters: FILTERS[extension] ?? [{ name: "All files", extensions: ["*"] }],
  });
  if (canceled || !filePath) return null;
  await writeFile(filePath, bytes);
  granted.add(filePath);
  return { path: filePath, name: path.basename(filePath) };
});

if (!app.requestSingleInstanceLock()) {
  app.quit(); // Quire is already open: that copy gets the files (second-instance below)
} else {
  pending = filesIn(process.argv);
  app.on("second-instance", async (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const files = await read(filesIn(argv));
    if (files.length) win.webContents.send("desktop:open-files", files);
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    protocol.handle("app", (request) => {
      const file = path.normalize(path.join(DIST, decodeURIComponent(new URL(request.url).pathname)));
      if (!file.startsWith(DIST + path.sep)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}

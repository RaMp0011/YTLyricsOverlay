
import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { getLyrics } from "./lyrics";
import { setupOverlayControls } from "./controls";
import type { LyricsQuery, PlaybackUpdate } from "../src/types";

// package.json has "type": "module", so main is built as ESM where __dirname doesn't exist.
const __dirname = dirname(fileURLToPath(import.meta.url));
// Vite serves public/ in dev and copies it into dist/ for builds.
const PUBLIC_DIR = process.env.VITE_DEV_SERVER_URL ? join(__dirname, "../public") : join(__dirname, "../dist");
// Extensions allowed to connect. The first is pinned by the "key" in extension/manifest.json, so it's
// the same on every machine when loaded unpacked. Add the Chrome Web Store ID here if you publish there.
const ALLOWED_EXTENSION_IDS = ["gdfhcfmlflcmhcfbodkpihmgoaamadjm"];
const PORT = 8765;
let mainWindow: BrowserWindow | null = null;
let server: WebSocketServer | null = null;

function startPlaybackBridge(
  getWindow: () => BrowserWindow | null
) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: PORT,
  });

  server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const allowed = ALLOWED_EXTENSION_IDS.some((id) => request.headers.origin === `chrome-extension://${id}`);

    if (!allowed) {
      socket.close(1008, "Untrusted origin");
      return;
    }

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as PlaybackUpdate;

        if (message.type !== "playback") return;
        if (typeof message.title !== "string") return;
        if (typeof message.artist !== "string") return;
        if (!Number.isFinite(message.currentTime)) return;
        if (!Number.isFinite(message.duration)) return;
        if (typeof message.paused !== "boolean") return;

        const win = getWindow();

        if (win && !win.isDestroyed()) {
          const update: PlaybackUpdate = {
            type: "playback",
            title: message.title,
            artist: message.artist,
            currentTime: message.currentTime,
            duration: message.duration,
            paused: message.paused,
            // Older extension builds don't send artwork; only accept https image URLs.
            artwork:
              typeof message.artwork === "string" && message.artwork.startsWith("https://")
                ? message.artwork
                : "",
          };

          win.webContents.send("playback:update", update);
        }
      } catch {
        // Ignore malformed messages.
      }
    });
  });

  server.on("listening", () => {
    console.log(`Playback bridge listening on 127.0.0.1:${PORT}`);
  });

  server.on("error", (error) => {
    console.error("Playback bridge error:", error);
  });

  return server;
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 550,
    height: 180,
    minWidth: 350,
    minHeight: 100,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setAlwaysOnTop(true, "floating");

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }

  return mainWindow;
}

// Only one copy may run: a second one would fail to get port 8765 and add a second tray icon.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening the app again just brings the overlay back.
  app.on("second-instance", () => mainWindow?.showInactive());

  app.whenReady().then(() => {
    ipcMain.handle("lyrics:get", (_event, query: LyricsQuery) => {
      if (
        typeof query?.title !== "string" ||
        typeof query?.artist !== "string" ||
        !Number.isFinite(query?.duration)
      ) {
        return { status: "not-found" };
      }

      return getLyrics(query);
    });

    mainWindow = createWindow(); // Adapt to your existing function.
    setupOverlayControls(mainWindow, join(PUBLIC_DIR, "tray-icon.png"));
    server = startPlaybackBridge(() => mainWindow);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    server?.close();
  }
});

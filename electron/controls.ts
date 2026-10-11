import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import type { OverlayState, Size } from "../src/types";

export const TOGGLE_SHORTCUT = "CommandOrControl+Shift+L";
// The page gets no mouse events over drag regions (or reliably while click-through),
// so hover is detected here by polling the cursor position.
const HOVER_POLL_MS = 100;

// Module-level so the tray icon isn't garbage collected.
let tray: Tray | null = null;

function isSize(value: unknown): value is Size {
  const size = value as Size | null;
  return (
    Number.isFinite(size?.width) && Number.isFinite(size?.height) &&
    size!.width >= 40 && size!.height >= 40 && size!.width <= 4000 && size!.height <= 4000
  );
}

/** Tray menu, show/hide hotkey, click-through lock, and compact (pill) mode for the overlay window. */
export function setupOverlayControls(win: BrowserWindow, trayIconPath: string) {
  let locked = false;
  let hovered = false;
  let controlsHovered = false;
  let compact = false;
  // Size and minimum size to restore when leaving compact mode.
  let fullSize: Size = { width: 0, height: 0 };
  let fullMinSize = [0, 0];

  const applyMousePassthrough = () => {
    // `forward` still delivers mouse moves while clicks pass through, so the overlay can show its unlock button.
    win.setIgnoreMouseEvents(locked && !controlsHovered, { forward: true });
  };

  const sendState = () => {
    const state: OverlayState = { locked, hovered, compact };
    win.webContents.send("overlay:state", state);
  };

  // The page animates the card itself; this only resizes the window, keeping the top-left corner fixed.
  const setCompact = (value: boolean, size?: Size) => {
    const bounds = win.getBounds();

    if (value && !compact && size) {
      fullSize = { width: bounds.width, height: bounds.height };
      fullMinSize = win.getMinimumSize();
      win.setMinimumSize(size.width, size.height);
      win.setResizable(false);
      win.setBounds({ x: bounds.x, y: bounds.y, ...size });
      compact = true;
    } else if (!value && compact) {
      // Nudge back inside the screen if growing from here would overflow it.
      const area = screen.getDisplayMatching(bounds).workArea;
      const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - fullSize.width));
      const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - fullSize.height));

      win.setResizable(true);
      win.setMinimumSize(fullMinSize[0], fullMinSize[1]);
      win.setBounds({ x, y, ...fullSize });
      compact = false;
    }

    sendState();
  };

  const hoverTimer = setInterval(() => {
    if (!win.isVisible()) return;

    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const inside =
      cursor.x >= bounds.x &&
      cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y < bounds.y + bounds.height;

    if (inside !== hovered) {
      hovered = inside;
      sendState();
    }
  }, HOVER_POLL_MS);

  win.on("closed", () => clearInterval(hoverTimer));

  const toggleVisible = () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.showInactive(); // Don't steal focus from whatever you're doing.
    }
  };

  const updateTrayMenu = () => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: win.isVisible() ? "Hide lyrics" : "Show lyrics",
          accelerator: TOGGLE_SHORTCUT,
          registerAccelerator: false,
          click: toggleVisible,
        },
        {
          label: "Lock (click-through)",
          type: "checkbox",
          checked: locked,
          click: (item) => setLocked(item.checked),
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ])
    );
  };

  const setLocked = (value: boolean) => {
    locked = value;
    controlsHovered = false;
    applyMousePassthrough();
    sendState();
    updateTrayMenu();
  };

  tray = new Tray(nativeImage.createFromPath(trayIconPath));
  tray.setToolTip("YouTube Music Lyrics");
  tray.on("click", toggleVisible);
  updateTrayMenu();

  win.on("show", updateTrayMenu);
  win.on("hide", updateTrayMenu);
  // Re-send after the page reloads so it shows the current lock state.
  win.webContents.on("did-finish-load", sendState);

  const fromOverlay = (event: { sender: Electron.WebContents }) => event.sender === win.webContents;

  ipcMain.handle("overlay:set-compact", (event, value: unknown, size: unknown) => {
    if (fromOverlay(event)) setCompact(value === true, isSize(size) ? size : undefined);
  });

  ipcMain.on("overlay:set-locked", (event, value: unknown) => {
    if (fromOverlay(event)) setLocked(value === true);
  });

  ipcMain.on("overlay:controls-hovered", (event, hovered: unknown) => {
    if (!fromOverlay(event)) return;
    controlsHovered = hovered === true;
    applyMousePassthrough();
  });

  ipcMain.on("overlay:hide", (event) => {
    if (fromOverlay(event)) win.hide();
  });

  if (!globalShortcut.register(TOGGLE_SHORTCUT, toggleVisible)) {
    console.warn(`Couldn't register ${TOGGLE_SHORTCUT}; another app may already use it.`);
  }

  app.on("will-quit", () => globalShortcut.unregisterAll());
}

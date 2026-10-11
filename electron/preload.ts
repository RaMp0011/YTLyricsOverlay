
import { contextBridge, ipcRenderer } from "electron";
import type { LyricsOverlayAPI, OverlayState, PlaybackUpdate } from "../src/types";

const lyricsOverlay: LyricsOverlayAPI = {
  onPlayback(callback: (data: PlaybackUpdate) => void) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: PlaybackUpdate
    ) => callback(data);

    ipcRenderer.on("playback:update", listener);

    return () => {
      ipcRenderer.removeListener("playback:update", listener);
    };
  },
  getLyrics(query) {
    return ipcRenderer.invoke("lyrics:get", query);
  },
  onOverlayState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: OverlayState) => callback(state);

    ipcRenderer.on("overlay:state", listener);

    return () => {
      ipcRenderer.removeListener("overlay:state", listener);
    };
  },
  setLocked(locked) {
    ipcRenderer.send("overlay:set-locked", locked);
  },
  setControlsHovered(hovered) {
    ipcRenderer.send("overlay:controls-hovered", hovered);
  },
  hide() {
    ipcRenderer.send("overlay:hide");
  },
  setCompact(compact, size) {
    return ipcRenderer.invoke("overlay:set-compact", compact, size);
  },
};

contextBridge.exposeInMainWorld("lyricsOverlay", lyricsOverlay);

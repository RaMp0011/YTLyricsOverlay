
// Forwards playback from page.ts (which reads YouTube's player API in the page context)
// to the background service worker.
import { MESSAGE_SOURCE, type PlaybackUpdate } from "./shared";

window.addEventListener("message", (event: MessageEvent<{ source?: string; playback?: PlaybackUpdate }>) => {
  if (event.source !== window || event.data?.source !== MESSAGE_SOURCE) return;

  try {
    // Nothing replies to this message; ignore the "port closed" rejection.
    chrome.runtime.sendMessage(event.data.playback).catch(() => {});
  } catch {
    // The extension was reloaded; this copy stops working until the tab is refreshed.
  }
});

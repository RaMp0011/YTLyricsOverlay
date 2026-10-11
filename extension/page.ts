
// Runs in the page's own JavaScript context ("world": "MAIN") so it can use YouTube's player API.
// YouTube Music plays queued tracks back-to-back on one <video>, so video.currentTime and
// video.duration keep growing across tracks; the player API reports the current track instead.
// Updates are posted to content.ts, which forwards them to the extension.
import { MESSAGE_SOURCE, type PlaybackUpdate } from "./shared";

type YouTubePlayer = HTMLElement & {
  getCurrentTime?: () => number;
  getDuration?: () => number;
  getPlayerResponse?: () => { videoDetails?: { lengthSeconds?: string } } | undefined;
};

function readText(selectors: string[]): string {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.textContent?.trim();
    if (value) return value;
  }

  return "";
}

function getArtwork(): string {
  // YouTube Music publishes the cover through the Media Session API, in several sizes.
  let best = "";
  let bestSize = -1;

  for (const image of navigator.mediaSession?.metadata?.artwork ?? []) {
    const size = parseInt(image.sizes ?? "", 10) || 0;

    if (size > bestSize) {
      best = image.src;
      bestSize = size;
    }
  }

  if (best) return best;

  // Fallback: the player bar thumbnail, requested at a larger size.
  const thumbnail = document.querySelector<HTMLImageElement>("ytmusic-player-bar img.image");
  return thumbnail?.src.replace(/=w\d+-h\d+/, "=w544-h544") ?? "";
}

function getDuration(player: YouTubePlayer): number {
  // The track's listed length. Right after a track starts, getDuration() only covers the part
  // loaded so far and keeps growing, which breaks the lyrics lookup.
  const listed = Number(player.getPlayerResponse?.()?.videoDetails?.lengthSeconds);
  if (listed > 0) return listed;

  const progressMax = Number(document.querySelector("ytmusic-player-bar #progress-bar")?.getAttribute("aria-valuemax"));
  if (progressMax > 0) return progressMax;

  const reported = player.getDuration?.() ?? 0;
  return Number.isFinite(reported) ? reported : 0;
}

function getPlayback(): PlaybackUpdate | null {
  const player = document.getElementById("movie_player") as YouTubePlayer | null;
  const video = document.querySelector("video");

  if (!player?.getCurrentTime || !player.getDuration || !video) return null;

  const title = readText([
    "ytmusic-player-bar .title",
    "ytmusic-player-bar .content-info-wrapper .title",
  ]);

  // The byline reads "Artist • Album • Year" (or "Artist • 1.2M views" for videos); keep the artist.
  const artist = readText([
    "ytmusic-player-bar .byline",
    "ytmusic-player-bar .subtitle",
  ]).split("•")[0].trim();

  if (!title || !artist) return null;

  return {
    type: "playback",
    title,
    artist,
    currentTime: player.getCurrentTime() || 0,
    duration: getDuration(player),
    paused: video.paused,
    artwork: getArtwork(),
  };
}

function report() {
  const playback = getPlayback();

  if (playback) {
    window.postMessage({ source: MESSAGE_SOURCE, playback }, location.origin);
  }
}

setInterval(report, 500);

// Report straight away on play/pause/seek. Media events don't bubble, so listen in the capture phase.
for (const type of ["play", "pause", "seeked", "loadedmetadata"]) {
  document.addEventListener(type, report, true);
}

report();

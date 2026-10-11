
/** Tags the messages page.ts posts to content.ts, so other window messages are ignored. */
export const MESSAGE_SOURCE = "ytm-lyrics-bridge";

export type PlaybackUpdate = {
  type: "playback";
  title: string;
  artist: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  artwork: string;
};

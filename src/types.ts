
export interface PlaybackUpdate {
  type: "playback";
  title: string;
  artist: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  /** Album art URL (https), or "" if unknown. */
  artwork: string;
}

export interface OverlayState {
  /** Click-through mode: mouse clicks pass to the windows underneath. */
  locked: boolean;
  /** The cursor is over the window (works in drag regions and while locked). */
  hovered: boolean;
  /** Shrunk to just the cover (the title slides out on hover). */
  compact: boolean;
}

export interface Size {
  width: number;
  height: number;
}

export interface LyricsQuery {
  title: string;
  artist: string;
  /** Track length in seconds, or 0 if unknown. Used to pick the right version. */
  duration: number;
}

export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
}

export type LyricsSource = "Musixmatch" | "LRCLIB";

export type LyricsResult =
  | { status: "synced"; lines: LyricLine[]; source: LyricsSource }
  | { status: "plain"; text: string; source: LyricsSource }
  | { status: "instrumental"; source: LyricsSource }
  | { status: "not-found" }
  | { status: "error"; message: string };

export interface LyricsOverlayAPI {
  onPlayback(
    callback: (data: PlaybackUpdate) => void
  ): () => void;
  getLyrics(query: LyricsQuery): Promise<LyricsResult>;
  onOverlayState(callback: (state: OverlayState) => void): () => void;
  setLocked(locked: boolean): void;
  /** While locked, the window accepts clicks only while the pointer is over the controls. */
  setControlsHovered(hovered: boolean): void;
  hide(): void;
  /** Resizes the window to `size` (compact) or back to its previous full size. */
  setCompact(compact: boolean, size?: Size): Promise<void>;
}

declare global {
  interface Window {
    lyricsOverlay: LyricsOverlayAPI;
  }
}

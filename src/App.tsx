
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { LyricLine, LyricsResult, OverlayState, PlaybackUpdate } from "./types";

// Show each line slightly early so it doesn't land late after IPC and rendering.
const LYRICS_LEAD_SECONDS = 0.15;
// YouTube Music changes the title before the new track's duration is known; let it settle first.
const LOOKUP_DELAY_MS = 800;
// Stop estimating forward if updates stop arriving (e.g. the YouTube Music tab was closed).
const MAX_EXTRAPOLATION_SECONDS = 5;
// Compact mode: just the cover; hovering slides the title out. Sizes and durations match index.css.
const COMPACT_SIZE = { width: 56, height: 56 };
// Space around the title while it's showing: padding, the cover, the gap and the border.
const PEEK_CHROME_WIDTH = 78;
const MAX_PEEK_WIDTH = 320;
const SHRINK_MS = 280;
const EXPAND_MS = 480;

type View = "full" | "shrinking" | "compact" | "expanding";

const STATUS_MESSAGES: Record<Exclude<LyricsResult["status"], "synced">, string> = {
  plain: "Only unsynced lyrics found",
  instrumental: "♪ Instrumental ♪",
  "not-found": "No lyrics found",
  error: "Couldn't load lyrics",
};

const initialPlayback: PlaybackUpdate = {
  type: "playback",
  title: "Waiting for YouTube Music",
  artist: "Play a song in Chrome",
  currentTime: 0,
  duration: 0,
  paused: true,
  artwork: "",
};

type PlaybackClock = {
  time: number;
  receivedAt: number;
  paused: boolean;
  duration: number;
};

/** Playback position now, estimated from the last update (they arrive ~500ms apart). */
function estimatePosition({ time, receivedAt, paused, duration }: PlaybackClock): number {
  const elapsed = paused
    ? 0
    : Math.min((performance.now() - receivedAt) / 1000, MAX_EXTRAPOLATION_SECONDS);
  const position = time + elapsed;

  return duration > 0 ? Math.min(position, duration) : position;
}

/** Index of the last line whose time has been reached, or -1 before the first line. */
function findLineIndex(lines: LyricLine[], time: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;

    if (lines[mid].time <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found;
}

/** Empty LRC lines mark instrumental breaks. */
function lineText(line: LyricLine | undefined): string {
  return line ? line.text || "♪" : "";
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));

  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function LockIcon({ open }: { open: boolean }) {
  return (
    <svg {...iconProps} aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d={open ? "M8 11V7a4 4 0 0 1 7.5-2" : "M8 11V7a4 4 0 0 1 8 0v4"} />
    </svg>
  );
}

function HideIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M6 12h12" />
    </svg>
  );
}

/** A record with the cover as its label; spins while playing. The sheen stays still, like light on real vinyl. */
function Vinyl({ artwork, spinning, label }: { artwork: string; spinning: boolean; label: string }) {
  return (
    <div className="turntable" role="img" aria-label={label} title={label}>
      <div className={`vinyl ${spinning ? "spinning" : ""}`}>
        {artwork ? (
          <img className="vinyl-label" src={artwork} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="vinyl-label" />
        )}
      </div>
      <div className="vinyl-sheen" />
    </div>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Width of `text` rendered in `element`'s font. */
function textWidth(text: string, element: Element): number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return 0;

  context.font = getComputedStyle(element).font;
  return Math.ceil(context.measureText(text).width);
}

/** Resolves on the next window resize, or after `timeoutMs` if none happens. */
function nextResize(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("resize", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener("resize", done);
  });
}

export default function App() {
  const [playback, setPlayback] =
    useState<PlaybackUpdate>(initialPlayback);

  const [connected, setConnected] = useState(false);
  const [lyrics, setLyrics] = useState<{ trackKey: string; result: LyricsResult } | null>(null);
  const [lineIndex, setLineIndex] = useState(-1);
  const [second, setSecond] = useState(0);
  const [overlay, setOverlay] = useState<OverlayState>({ locked: false, hovered: false, compact: false });
  const [overControls, setOverControls] = useState(false);
  const [brokenArtwork, setBrokenArtwork] = useState("");
  const [view, setView] = useState<View>("full");
  // Compact mode: whether the title is slid out, and the widths for the CSS animations.
  const [peek, setPeek] = useState(false);
  const [peekWidth, setPeekWidth] = useState(COMPACT_SIZE.width);
  const [expandFrom, setExpandFrom] = useState(COMPACT_SIZE.width);
  const clock = useRef<PlaybackClock>({ time: 0, receivedAt: 0, paused: true, duration: 0 });
  const progressRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const viewSynced = useRef(false);
  // Right after shrinking the pointer is still on the cover; only slide the title out once it has left.
  const peekArmed = useRef(true);
  const peekTarget = useRef(false);
  // Bumped by every peek change or expand, so a slower, older one doesn't resize the window afterwards.
  const peekToken = useRef(0);

  useEffect(() => {
    const unsubscribe = window.lyricsOverlay.onPlayback((data) => {
      if (!data || typeof data !== "object") return;

      const update = data as PlaybackUpdate;

      if (
        update.type !== "playback" ||
        typeof update.title !== "string" ||
        typeof update.artist !== "string" ||
        typeof update.currentTime !== "number" ||
        typeof update.duration !== "number" ||
        typeof update.paused !== "boolean"
      ) {
        return;
      }

      clock.current = {
        time: update.currentTime,
        receivedAt: performance.now(),
        paused: update.paused,
        duration: update.duration,
      };

      setPlayback({ ...update, artwork: typeof update.artwork === "string" ? update.artwork : "" });
      setConnected(true);
    });

    return unsubscribe;
  }, []);

  useEffect(
    () =>
      window.lyricsOverlay.onOverlayState((state) => {
        setOverlay(state);

        // After a reload, start in whichever mode the window is already in (with the title hidden).
        if (!viewSynced.current) {
          viewSynced.current = true;
          setView(state.compact ? "compact" : "full");
          if (state.compact) void window.lyricsOverlay.setCompact(true, COMPACT_SIZE);
        }
      }),
    []
  );

  // Compact mode: slide the title out while the pointer is over the cover, and back when it leaves.
  // Opening widens the window first; closing shrinks it after the card has animated back.
  useEffect(() => {
    if (view !== "compact") return;
    if (!overlay.hovered) peekArmed.current = true;

    const open = overlay.hovered && peekArmed.current;
    if (open === peekTarget.current) return;

    peekTarget.current = open;
    const token = ++peekToken.current;

    void (async () => {
      if (open) {
        const title = titleRef.current;
        const titleWidth = title ? textWidth(title.textContent ?? "", title) : 0;
        const width = Math.min(MAX_PEEK_WIDTH, PEEK_CHROME_WIDTH + titleWidth);
        const resized = nextResize(250);

        setPeekWidth(width);
        await window.lyricsOverlay.setCompact(true, { width, height: COMPACT_SIZE.height });
        await resized;
        if (token === peekToken.current) setPeek(true);
      } else {
        setPeek(false);
        await sleep(SHRINK_MS);
        if (token === peekToken.current) await window.lyricsOverlay.setCompact(true, COMPACT_SIZE);
      }
    })();
  }, [view, overlay.hovered]);

  const trackKey = connected ? `${playback.title}\n${playback.artist}` : "";
  const foundSynced = lyrics?.trackKey === trackKey && lyrics.result.status === "synced";
  // Includes the duration: right after a track change the reported length can be stale, and a
  // wrong length makes the lookup miss. When it changes, look up again (until synced lyrics are found).
  const lookupKey = trackKey && !foundSynced ? `${trackKey}\n${Math.round(playback.duration)}` : "";

  useEffect(() => {
    if (!lookupKey) return;

    const [title, artist, duration] = lookupKey.split("\n");
    const forTrack = `${title}\n${artist}`;
    let cancelled = false;

    const timer = setTimeout(() => {
      window.lyricsOverlay
        .getLyrics({ title, artist, duration: Number(duration) })
        .then((result) => {
          if (!cancelled) setLyrics({ trackKey: forTrack, result });
        })
        .catch((error: unknown) => {
          if (!cancelled) setLyrics({ trackKey: forTrack, result: { status: "error", message: String(error) } });
        });
    }, LOOKUP_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lookupKey]);

  const result = lyrics?.trackKey === trackKey ? lyrics.result : null;
  const syncedLines = result?.status === "synced" ? result.lines : null;

  // Update the line, clock and progress bar only when they change: at the next line or the next whole
  // second. A per-frame loop kept a CPU core ~60% busy, since every frame of a transparent window is
  // expensive to draw. Rescheduled on every playback update, which also covers seeking.
  useEffect(() => {
    let timer = 0;

    const update = () => {
      const { receivedAt, paused, duration } = clock.current;
      const position = estimatePosition(clock.current);
      const index = syncedLines ? findLineIndex(syncedLines, position + LYRICS_LEAD_SECONDS) : -1;
      const wholeSecond = Math.floor(position);

      setSecond(wholeSecond);
      setLineIndex(index);

      if (progressRef.current) {
        progressRef.current.style.transform = `scaleX(${duration > 0 ? wholeSecond / duration : 0})`;
      }

      // Nothing moves while paused, or once updates have stopped arriving.
      if (paused || (performance.now() - receivedAt) / 1000 >= MAX_EXTRAPOLATION_SECONDS) return;

      const nextLine = syncedLines?.[index + 1];
      const untilLine = nextLine ? nextLine.time - LYRICS_LEAD_SECONDS - position : Infinity;
      const untilSecond = wholeSecond + 1 - position;
      timer = window.setTimeout(update, Math.max(10, Math.min(untilLine, untilSecond) * 1000));
    };

    update();
    return () => clearTimeout(timer);
  }, [syncedLines, playback]);

  let current: string;
  let next = "";

  if (!connected) {
    current = "Open YouTube Music and play a song";
  } else if (!result) {
    current = "Searching lyrics…";
  } else if (syncedLines) {
    current = lineText(syncedLines[lineIndex]) || "♪";
    next = lineText(syncedLines[lineIndex + 1]);
  } else {
    current = STATUS_MESSAGES[result.status as keyof typeof STATUS_MESSAGES];
  }

  const source = result && "source" in result ? result.source : null;
  const artwork = playback.artwork !== brokenArtwork ? playback.artwork : "";
  const showControls = overlay.hovered || overControls;

  // While locked, the window only takes clicks while the pointer is over the controls.
  const enterControls = () => {
    setOverControls(true);
    window.lyricsOverlay.setControlsHovered(true);
  };

  const leaveControls = () => {
    setOverControls(false);
    window.lyricsOverlay.setControlsHovered(false);
  };

  const toggleLock = () => {
    window.lyricsOverlay.setLocked(!overlay.locked);
    // Locking resets the hover flag in main; the pointer is still here, so keep the button clickable.
    window.lyricsOverlay.setControlsHovered(true);
  };

  // Shrink: animate the card down inside the full window, then shrink the window to the cover.
  // Expand: grow the window first (the card stays put in its top-left corner), then animate the card out
  // from whatever width it has now (the cover alone, or with the title showing).
  const toggleCompact = async () => {
    if (view === "full") {
      peekArmed.current = false;
      peekTarget.current = false;
      setView("shrinking");
      await sleep(SHRINK_MS);
      await window.lyricsOverlay.setCompact(true, COMPACT_SIZE);
      setView("compact");
    } else if (view === "compact") {
      peekToken.current++;
      setExpandFrom(cardRef.current?.getBoundingClientRect().width ?? COMPACT_SIZE.width);

      const resized = nextResize(250);
      await window.lyricsOverlay.setCompact(false);
      await resized;

      peekTarget.current = false;
      setPeek(false);
      setView("expanding");
      await sleep(EXPAND_MS);
      setView("full");
    }
  };

  const isCompact = view === "shrinking" || view === "compact";
  const statusLabel = connected ? (playback.paused ? "Paused" : "Playing") : "Waiting for YouTube Music";

  const classes = [
    "overlay",
    connected && "connected",
    playback.paused && "paused",
    overlay.locked && "locked",
    showControls && "hovering",
    isCompact && "compact",
    isCompact && peek && "peek",
    view === "expanding" && "expanding",
  ]
    .filter(Boolean)
    .join(" ");

  const sizes = {
    "--peek-width": `${peekWidth}px`,
    "--expand-from": `${expandFrom}px`,
  } as CSSProperties;

  return (
    <main className={classes} style={sizes} ref={cardRef}>
      {/* no-referrer: Google's image CDN rejects requests referred from http://localhost (429). */}
      <div className="backdrop" aria-hidden="true">
        {artwork && (
          <img
            key={artwork}
            src={artwork}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setBrokenArtwork(artwork)}
          />
        )}
      </div>

      <header className="song-info">
        {/* Clickable even while locked, like the controls. */}
        <button
          className="cover-button"
          onClick={toggleCompact}
          onMouseEnter={enterControls}
          onMouseLeave={leaveControls}
          title={isCompact ? "Expand" : "Shrink"}
          aria-label={isCompact ? "Expand" : "Shrink"}
        >
          {artwork ? (
            <img className="cover" src={artwork} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="cover placeholder" aria-hidden="true">♪</div>
          )}
        </button>

        <div className="track-details">
          <span className="song-title" ref={titleRef}>{playback.title}</span>
          <span className="artist">{playback.artist}</span>
        </div>

        <div className="top-right">
          <Vinyl artwork={artwork} spinning={connected && !playback.paused} label={statusLabel} />

          <div className="controls" onMouseEnter={enterControls} onMouseLeave={leaveControls}>
            <button
              className="control"
              onClick={toggleLock}
              title={overlay.locked ? "Unlock (move and resize)" : "Lock (click-through)"}
            >
              <LockIcon open={overlay.locked} />
            </button>

            {!overlay.locked && (
              <button
                className="control"
                onClick={() => window.lyricsOverlay.hide()}
                title="Hide (Ctrl+Shift+L to show)"
              >
                <HideIcon />
              </button>
            )}
          </div>
        </div>
      </header>

      <section className="lyrics">
        <p className="current" key={`${trackKey}:${lineIndex}`}>
          {current}
        </p>
        {next && (
          <p className="next" key={`${trackKey}:${lineIndex}:next`}>
            {next}
          </p>
        )}
      </section>

      <footer className="playback-time">
        <span>{formatTime(second)}</span>
        <div className="progress">
          <div className="progress-fill" ref={progressRef} />
        </div>
        <span>{formatTime(playback.duration)}</span>
        {source && <span className="lyrics-source">{source}</span>}
      </footer>
    </main>
  );
}

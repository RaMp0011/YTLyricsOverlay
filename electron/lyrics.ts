import type { LyricLine, LyricsQuery, LyricsResult } from "../src/types";

const USER_AGENT = "YouTubeMusicLyricsOverlay/0.1.0 (desktop app)";
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 600;
const LRCLIB_API = "https://lrclib.net/api";
const MUSIXMATCH_API = "https://api.musixmatch.com/ws/1.1";
// How many seconds a lyrics version's length may differ from the playing track.
const DURATION_TOLERANCE = 3;

const MUSIXMATCH_ERRORS: Record<number, string> = {
  401: "invalid or missing API key",
  402: "usage limit reached",
  403: "your plan doesn't include synced lyrics (subtitles)",
};

type MusixmatchResponse = {
  message: {
    header: { status_code: number };
    body: { subtitle?: { subtitle_body?: string } } | [];
  };
};

type LrclibRecord = {
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

const cache = new Map<string, Promise<LyricsResult>>();

export function getLyrics(query: LyricsQuery): Promise<LyricsResult> {
  const title = query.title.trim();
  const artist = query.artist.trim();
  // Duration is part of the key so a lookup made with a wrong (stale) length isn't reused.
  const key = `${title}\n${artist}\n${Math.round(query.duration)}`.toLowerCase();

  const cached = cache.get(key);
  if (cached) return cached;

  const pending = findLyrics({ title, artist, duration: query.duration }).catch(
    (error: unknown): LyricsResult => {
      // Don't cache failures (e.g. offline); retry next time this track plays.
      cache.delete(key);
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  );

  cache.set(key, pending);
  return pending;
}

async function findLyrics(query: LyricsQuery): Promise<LyricsResult> {
  const apiKey = process.env.MUSIXMATCH_API_KEY;

  if (apiKey) {
    try {
      const lines = await musixmatchSubtitles(query, apiKey);
      if (lines) return { status: "synced", lines, source: "Musixmatch" };
    } catch (error) {
      console.warn("Musixmatch lookup failed, falling back to LRCLIB:", error);
    }
  }

  return lrclibLyrics(query);
}

// Official Musixmatch API. Synced lyrics require a plan that includes subtitles.
async function musixmatchSubtitles(
  { title, artist, duration }: LyricsQuery,
  apiKey: string
): Promise<LyricLine[] | null> {
  const params = new URLSearchParams({
    format: "json",
    q_track: title,
    q_artist: artist,
    apikey: apiKey,
  });

  if (duration > 0) {
    params.set("f_subtitle_length", String(Math.round(duration)));
    params.set("f_subtitle_length_max_deviation", String(DURATION_TOLERANCE));
  }

  const data = await fetchJson<MusixmatchResponse>(`${MUSIXMATCH_API}/matcher.subtitle.get?${params}`);
  const status = data?.message.header.status_code;

  if (!data || status === 404) return null;
  if (status !== 200) {
    throw new Error(`Musixmatch status ${status}: ${MUSIXMATCH_ERRORS[status ?? 0] ?? "request failed"}`);
  }

  const body = data.message.body;
  const lrc = Array.isArray(body) ? undefined : body.subtitle?.subtitle_body;
  const lines = lrc ? parseLrc(lrc) : [];

  return lines.length ? lines : null;
}

async function lrclibLyrics({ title, artist, duration }: LyricsQuery): Promise<LyricsResult> {
  const exactParams = new URLSearchParams({ track_name: title, artist_name: artist });
  if (duration > 0) exactParams.set("duration", String(Math.round(duration)));

  // A failed exact lookup (LRCLIB sometimes returns a transient 5xx) shouldn't skip the searches below.
  const exact = await fetchJson<LrclibRecord>(`${LRCLIB_API}/get?${exactParams}`).catch(() => null);
  if (exact?.syncedLyrics || exact?.instrumental) return lrclibResult(exact);

  // No exact synced match: look through other versions (other albums, slightly different lengths).
  const searchParams = new URLSearchParams({ track_name: title, artist_name: artist });
  const candidates = (await fetchJson<LrclibRecord[]>(`${LRCLIB_API}/search?${searchParams}`)) ?? [];

  if (!pickBest(candidates, duration)?.syncedLyrics) {
    // Looser full-text search for titles like "Song (Official Video)" or artist lists like "A, B & C".
    const q = `${cleanTitle(title)} ${primaryArtist(artist)}`;
    candidates.push(...((await fetchJson<LrclibRecord[]>(`${LRCLIB_API}/search?${new URLSearchParams({ q })}`)) ?? []));
  }

  return lrclibResult(pickBest(candidates, duration) ?? exact);
}

function pickBest(records: LrclibRecord[], duration: number): LrclibRecord | undefined {
  const distance = (record: LrclibRecord) =>
    duration > 0 ? Math.abs(record.duration - duration) : 0;

  const fitting = records
    .filter((record) => distance(record) <= DURATION_TOLERANCE)
    .sort((a, b) => distance(a) - distance(b));

  return (
    fitting.find((record) => record.syncedLyrics) ??
    fitting.find((record) => record.instrumental) ??
    fitting.find((record) => record.plainLyrics)
  );
}

function lrclibResult(record: LrclibRecord | null | undefined): LyricsResult {
  if (!record) return { status: "not-found" };

  const lines = record.syncedLyrics ? parseLrc(record.syncedLyrics) : [];
  if (lines.length) return { status: "synced", lines, source: "LRCLIB" };
  if (record.instrumental) return { status: "instrumental", source: "LRCLIB" };
  if (record.plainLyrics) return { status: "plain", text: record.plainLyrics, source: "LRCLIB" };

  return { status: "not-found" };
}

function cleanTitle(title: string): string {
  return title.replace(/\s*[([][^)\]]*[)\]]/g, "").trim() || title;
}

function primaryArtist(artist: string): string {
  return artist.split(/\s*(?:•|,|&|\bfeat\.?|\bft\.)\s*/i)[0].trim() || artist;
}

async function fetchJson<T>(url: string, retries = 1): Promise<T | null> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // LRCLIB occasionally returns a transient 5xx; one retry usually succeeds.
  if (response.status >= 500 && retries > 0) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return fetchJson<T>(url, retries - 1);
  }

  if (response.status === 404) return null;
  // Only the host goes in the message, so an API key in the query string never ends up in logs.
  if (!response.ok) throw new Error(`${new URL(url).host} responded ${response.status}`);

  return (await response.json()) as T;
}

const TIME_TAG = /^\[(\d+):(\d+(?:[.:]\d+)?)\]/;

/** Parses LRC text ("[01:02.50] line") into lines sorted by time. */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  let offset = 0;

  for (const raw of lrc.split(/\r?\n/)) {
    const offsetTag = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetTag) {
      offset = Number(offsetTag[1]) / 1000;
      continue;
    }

    // A line can carry several timestamps: "[00:12.00][01:30.00] Chorus line".
    const times: number[] = [];
    let rest = raw.trim();
    let match: RegExpExecArray | null;

    while ((match = TIME_TAG.exec(rest))) {
      times.push(Number(match[1]) * 60 + Number(match[2].replace(":", ".")));
      rest = rest.slice(match[0].length);
    }

    // Drop word-level timing from "enhanced" LRC: "<00:12.34>word".
    const text = rest.replace(/<\d+:\d+(?:[.:]\d+)?>/g, "").trim();
    for (const time of times) lines.push({ time, text });
  }

  // A positive [offset:] (ms) means lyrics should show earlier.
  return lines
    .map((line) => ({ time: Math.max(0, line.time - offset), text: line.text }))
    .sort((a, b) => a.time - b.time);
}

// ── Lyrics (LRCLIB proxy + parser + semantic search) ────────────────────
// LRCLIB is a free, no-auth lyrics database with synced LRC timestamps for
// most popular tracks. We proxy through Blue's server so we can:
//   - cache by track to avoid re-fetching as the user replays / scrubs
//   - convert LRC to a clean { time, text } array for the client
//   - hide CORS / UA quirks behind a single shape
//   - embed each timestamped line into the vector store so the agent can
//     recall a song from a half-remembered lyric ("the one about driving
//     at night")
const { json, readJson } = require("../lib/http");
const { remember, recall } = require("../agent/vector-memory");

const LYRICS_CACHE = new Map();
const LYRICS_CACHE_MAX = 200;

// We embed lines in the background so the lyrics response isn't blocked. To
// avoid hammering Ollama on first fetch, cap how many lines we embed per song
// and prefer substantive ones (skip "♪", repeats, very short).
const MAX_EMBED_LINES_PER_SONG = 30;
const MIN_LINE_CHARS = 6;

async function embedLyricsBackground(payload) {
  if (!payload || !payload.synced || !Array.isArray(payload.lines)) return;
  const { title, artist } = payload;
  if (!title || !artist) return;
  const seen = new Set();
  const candidates = [];
  for (const line of payload.lines) {
    const text = (line.text || "").trim();
    if (!text || text === "♪" || text.length < MIN_LINE_CHARS) continue;
    const norm = text.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    candidates.push(line);
    if (candidates.length >= MAX_EMBED_LINES_PER_SONG) break;
  }
  for (const line of candidates) {
    try {
      await remember({
        type: "lyric",
        text: line.text,
        meta: { title, artist, time: line.time },
        dedupKey: `lyric|${title.toLowerCase()}|${artist.toLowerCase()}|${line.text.toLowerCase()}`,
      });
    } catch {}
  }
}

async function lyrics(url, res) {
  try {
    const title    = (url.searchParams.get("title") || "").trim();
    const artist   = (url.searchParams.get("artist") || "").trim();
    const album    = (url.searchParams.get("album") || "").trim();
    const duration = Number(url.searchParams.get("duration")) || 0;

    if (!title || !artist) {
      return json(res, { ok: false, error: "title and artist are required.", synced: false, lines: [], plain: "" });
    }

    const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
    if (LYRICS_CACHE.has(key)) return json(res, LYRICS_CACHE.get(key));

    const headers = { "User-Agent": "Blue Music Agent (local, https://github.com)" };

    // Try the precise /api/get endpoint first (matches by title+artist+duration).
    const getParams = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album)    getParams.set("album_name", album);
    if (duration) getParams.set("duration",   String(Math.round(duration / 1000)));
    let result = null;
    try {
      const r = await fetch(`https://lrclib.net/api/get?${getParams}`, { headers });
      if (r.ok) {
        const data = await r.json();
        result = parseLyricsResult(data);
      }
    } catch {}

    // Fall back to /api/search if /api/get returned nothing usable.
    if (!result || (!result.lines.length && !result.plain)) {
      try {
        const sParams = new URLSearchParams({ track_name: title, artist_name: artist });
        const r = await fetch(`https://lrclib.net/api/search?${sParams}`, { headers });
        if (r.ok) {
          const arr = await r.json();
          const best = Array.isArray(arr) ? arr.find((x) => x.syncedLyrics) || arr[0] : null;
          if (best) result = parseLyricsResult(best);
        }
      } catch {}
    }

    const payload = result || { ok: true, synced: false, lines: [], plain: "" };
    payload.ok = true;
    payload.title  = title;
    payload.artist = artist;

    // Tiny LRU-ish cap so the cache doesn't grow forever.
    if (LYRICS_CACHE.size >= LYRICS_CACHE_MAX) {
      LYRICS_CACHE.delete(LYRICS_CACHE.keys().next().value);
    }
    LYRICS_CACHE.set(key, payload);
    json(res, payload);

    // Fire-and-forget: embed each timestamped line so the agent can do
    // semantic recall later. Only run on cache miss (we just inserted).
    embedLyricsBackground(payload).catch(() => {});
  } catch (error) {
    json(res, { ok: false, error: error.message, synced: false, lines: [], plain: "" });
  }
}

function parseLyricsResult(data) {
  if (!data || typeof data !== "object") return { ok: true, synced: false, lines: [], plain: "" };
  if (data.syncedLyrics && typeof data.syncedLyrics === "string") {
    return { ok: true, synced: true, lines: parseLrc(data.syncedLyrics), plain: data.plainLyrics || "" };
  }
  if (data.plainLyrics && typeof data.plainLyrics === "string") {
    return { ok: true, synced: false, lines: [], plain: data.plainLyrics };
  }
  return { ok: true, synced: false, lines: [], plain: "" };
}

// Parse a standard LRC blob: lines like "[mm:ss.cc] words..." → { time(ms), text }.
// Also handles compound stamps "[00:12.45][00:48.90] same line" by emitting one
// entry per stamp. Empty/blank text becomes a "♪" so the line still renders.
function parseLrc(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const stamps = raw.match(/\[(\d+):(\d+)(?:[.:](\d{1,3}))?\]/g);
    if (!stamps) continue;
    const idx = raw.lastIndexOf("]");
    const body = (idx >= 0 ? raw.slice(idx + 1) : "").trim();
    for (const stamp of stamps) {
      const m = stamp.match(/\[(\d+):(\d+)(?:[.:](\d{1,3}))?\]/);
      if (!m) continue;
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(m[3].padEnd(3, "0").slice(0, 3)) : 0;
      const time = (min * 60 + sec) * 1000 + frac;
      out.push({ time, text: body });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

// Semantic search across all embedded lyrics.
async function searchLyrics(req, res) {
  try {
    const body = await readJson(req);
    const query = String(body.query || "").trim();
    if (!query) return json(res, { ok: false, error: "query required." }, 400);
    const k = Math.min(20, Math.max(1, Number(body.k) || 5));
    const hits = await recall(query, { k, types: ["lyric"] });
    const results = hits.map((h) => ({
      title:     h.meta?.title || "",
      artist:    h.meta?.artist || "",
      timestamp: h.meta?.time ?? null,
      line:      h.text,
      score:     h.score,
    }));
    json(res, { ok: true, results });
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
}

module.exports = { lyrics, searchLyrics };

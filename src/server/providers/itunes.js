const { normalizeGenre, inferGenreFromText } = require("../lib/music-text");

// ════════════════════════════════════════════════════════════════════════════
// GENRE / MOOD INTELLIGENCE
// Multi-tag classifier with confidence scores. Falls back to MusicBrainz /
// iTunes Search for "Unknown" tracks. Multi-genre output drives the
// dashboard's secondary tags.
// ════════════════════════════════════════════════════════════════════════════
const GENRE_CACHE = new Map();
const GENRE_CACHE_MAX = 500;

async function classifyTrackGenre({ title, artist }) {
  const key = `${title}|${artist}`.toLowerCase();
  if (GENRE_CACHE.has(key)) return GENRE_CACHE.get(key);

  const tags = new Map(); // bucket → score

  const addTag = (bucket, score) => {
    if (!bucket || bucket === "Unknown") return;
    tags.set(bucket, (tags.get(bucket) || 0) + score);
  };

  // 1. Text-based heuristics (artist names, track titles)
  const textGuess = inferGenreFromText(`${title} ${artist}`);
  if (textGuess && textGuess !== "Unknown") addTag(textGuess, 0.6);

  // 2. Bucketize anything the artist string hints at
  const bucket = normalizeGenre(`${title} ${artist}`);
  if (bucket && bucket !== "Other" && bucket !== "Unknown") addTag(bucket, 0.4);

  // 3. iTunes Search API — free, no auth, decent genre tags
  try {
    const params = new URLSearchParams({
      term: `${title} ${artist}`.trim(),
      entity: "song",
      limit: "5",
    });
    const r = await fetch(`https://itunes.apple.com/search?${params}`, { headers: { "User-Agent": "Blue Music Agent" } });
    if (r.ok) {
      const data = await r.json();
      for (const item of (data.results || []).slice(0, 5)) {
        const g = item.primaryGenreName;
        if (g) addTag(normalizeGenre(g), 0.5);
      }
    }
  } catch {}

  // 4. MusicBrainz — slower but more accurate for non-English / rare tracks.
  // Skip if iTunes already gave us strong signal.
  if (tags.size < 2) {
    try {
      const params = new URLSearchParams({
        query: `recording:"${title}" AND artist:"${artist}"`,
        fmt: "json",
        limit: "3",
      });
      const r = await fetch(`https://musicbrainz.org/ws/2/recording?${params}`, {
        headers: { "User-Agent": "Blue Music Agent (avk0603@gmail.com)" },
      });
      if (r.ok) {
        const data = await r.json();
        for (const rec of (data.recordings || []).slice(0, 3)) {
          for (const tag of (rec.tags || []).slice(0, 5)) {
            const g = normalizeGenre(tag.name);
            if (g && g !== "Other") addTag(g, 0.3 * Math.min(1, (tag.count || 1) / 5));
          }
        }
      }
    } catch {}
  }

  const sorted = [...tags.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0) || 1;
  const result = {
    primary:    sorted[0]?.[0] || "Unknown",
    secondary:  sorted.slice(1, 4).map(([name, score]) => ({ name, confidence: +(score / total).toFixed(2) })),
    confidence: sorted[0] ? +(sorted[0][1] / total).toFixed(2) : 0,
    all:        sorted.map(([name, score]) => ({ name, confidence: +(score / total).toFixed(2) })),
  };

  if (GENRE_CACHE.size >= GENRE_CACHE_MAX) {
    GENRE_CACHE.delete(GENRE_CACHE.keys().next().value);
  }
  GENRE_CACHE.set(key, result);
  return result;
}

module.exports = { classifyTrackGenre };

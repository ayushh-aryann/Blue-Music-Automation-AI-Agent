// ════════════════════════════════════════════════════════════════════════════
// LAST.FM INTEGRATION
//
// Read-only Last.fm API calls used by the planner to discover similar tracks
// and by the get_listening_profile tool to surface broader taste data.
// No session key needed — these are public endpoints.
//
// Set LASTFM_API_KEY in .env to enable. Calls gracefully return [] when the
// key is missing or the API is unreachable.
// ════════════════════════════════════════════════════════════════════════════

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";

function apiKey() {
  return process.env.LASTFM_API_KEY || "";
}

async function lfmGet(params) {
  const key = apiKey();
  if (!key) return null;
  const qs = new URLSearchParams({ ...params, api_key: key, format: "json" }).toString();
  try {
    const r = await fetch(`${API_ROOT}?${qs}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

/**
 * Get tracks similar to a given track via Last.fm.
 * Returns [{title, artist, match}] sorted by match score (highest first).
 */
async function getSimilarTracks(artist, track, limit = 10) {
  const data = await lfmGet({ method: "track.getSimilar", artist, track, limit });
  return (data?.similartracks?.track || []).map((t) => ({
    title:  t.name,
    artist: t.artist?.name || artist,
    match:  parseFloat(t.match || 0),
  }));
}

/**
 * Get top tracks for an artist.
 * Returns [{title, artist}] sorted by play count (API default).
 */
async function getTopArtistTracks(artist, limit = 5) {
  const data = await lfmGet({ method: "artist.getTopTracks", artist, limit });
  return (data?.toptracks?.track || []).map((t) => ({
    title:  t.name,
    artist: t.artist?.name || artist,
  }));
}

/**
 * Get top tracks in a genre/tag (useful for proactive suggestions).
 * Returns [{title, artist}].
 */
async function getTagTopTracks(tag, limit = 10) {
  const data = await lfmGet({ method: "tag.getTopTracks", tag, limit });
  return (data?.tracks?.track || []).map((t) => ({
    title:  t.name,
    artist: t.artist?.name || "",
  }));
}

/**
 * Get tracks similar to those in a list of seed tracks.
 * Merges results from all seeds and deduplicates by title+artist.
 */
async function getSimilarForSeeds(seeds, limit = 5) {
  if (!seeds.length) return [];
  const results = await Promise.all(
    seeds.slice(0, 3).map(({ title, artist }) => getSimilarTracks(artist, title, limit))
  );
  const seen  = new Set();
  const out   = [];
  for (const batch of results) {
    for (const t of batch) {
      const key = `${t.title.toLowerCase()}|${t.artist.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
  }
  return out.sort((a, b) => b.match - a.match);
}

module.exports = { getSimilarTracks, getTopArtistTracks, getTagTopTracks, getSimilarForSeeds };

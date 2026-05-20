// ════════════════════════════════════════════════════════════════════════════
// ADAPTIVE LISTENING PROFILE
//
// Builds a statistical model of the user's listening habits from the event log
// (.blue-events.jsonl) and surfaces actionable signals for the agent:
//
//   • Artist / genre affinity scores  (plays vs skips → weighted score 0–1)
//   • Avoided artists                 (skip rate > 50 % and ≥ 3 skips)
//   • Time-of-day genre + mood bias   (what the user plays at each hour)
//   • Top artists / genres overall
//
// getCurrentContext() returns a compact snapshot keyed to the current hour;
// it's cheap enough to call on every agent turn.
//
// buildProfile() does the full analysis; use it for the get_listening_profile
// tool and the /api/profile route.
// ════════════════════════════════════════════════════════════════════════════
const { readEvents } = require("./events");

// ── Helpers ───────────────────────────────────────────────────────────────────

function topN(map, n, key = "count") {
  return Object.entries(map)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => (b[key] || 0) - (a[key] || 0))
    .slice(0, n);
}

function affinity(plays, skips) {
  // Weighted score: each skip counts twice (listening halfway then bailing
  // is a clearer signal than never clicking at all).
  const total = plays + skips * 2;
  return total > 0 ? +(plays / total).toFixed(3) : 0.5;
}

// ── Core analysis ──────────────────────────────────────────────────────────────

/**
 * Build a full profile from the last `days` days of event history.
 *
 * @returns {{
 *   avoidArtists: string[],
 *   topArtists: {name, plays, skips, score}[],
 *   topGenres:  {name, plays, skips, score}[],
 *   hourProfiles: Record<string, {genre, mood, artist}>,
 *   skipCounts: Record<string, number>,
 *   dataPoints: number,
 * }}
 */
function buildProfile({ days = 30 } = {}) {
  const since  = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = readEvents({ sinceMs: since, limit: 15_000 });

  // artist/genre → {plays, skips}
  const artistMap = {};
  const genreMap  = {};
  // hour (0–23) → {genres: {}, artists: {}, moods: {}}
  const hourMap   = {};

  for (const evt of events) {
    const artist = (evt.artist || "").toLowerCase().trim();
    const genre  = (evt.genre  || "").toLowerCase().trim();
    const hour   = typeof evt.hour === "number" ? evt.hour
                 : evt.at ? new Date(evt.at).getHours() : -1;

    if (evt.type === "play" || evt.type === "like") {
      if (artist) {
        artistMap[artist] = artistMap[artist] || { plays: 0, skips: 0 };
        artistMap[artist].plays++;
      }
      if (genre) {
        genreMap[genre] = genreMap[genre] || { plays: 0, skips: 0 };
        genreMap[genre].plays++;
      }
      if (hour >= 0) {
        hourMap[hour] = hourMap[hour] || { genres: {}, artists: {}, moods: {} };
        if (genre)  hourMap[hour].genres[genre]   = (hourMap[hour].genres[genre]   || 0) + 1;
        if (artist) hourMap[hour].artists[artist] = (hourMap[hour].artists[artist] || 0) + 1;
      }

    } else if (evt.type === "skip") {
      if (artist) {
        artistMap[artist] = artistMap[artist] || { plays: 0, skips: 0 };
        artistMap[artist].skips++;
      }
      if (genre) {
        genreMap[genre] = genreMap[genre] || { plays: 0, skips: 0 };
        genreMap[genre].skips++;
      }

    } else if (evt.type === "mood" && evt.mood) {
      if (hour >= 0) {
        hourMap[hour] = hourMap[hour] || { genres: {}, artists: {}, moods: {} };
        hourMap[hour].moods[evt.mood] = (hourMap[hour].moods[evt.mood] || 0) + 1;
      }
    }
  }

  // Compute scores and classify artists
  const avoidArtists  = [];
  const topArtistList = [];
  const skipCounts    = {};

  for (const [name, s] of Object.entries(artistMap)) {
    s.score = affinity(s.plays, s.skips);
    skipCounts[name] = s.skips;
    const skipMajority = s.skips >= 3 && s.skips > s.plays;
    if (skipMajority) {
      avoidArtists.push(name);
    } else if (s.plays >= 2) {
      topArtistList.push({ name, plays: s.plays, skips: s.skips, score: s.score });
    }
  }
  topArtistList.sort((a, b) => b.plays - a.plays);

  const topGenreList = Object.entries(genreMap)
    .map(([name, s]) => ({ name, ...s, score: affinity(s.plays, s.skips) }))
    .sort((a, b) => b.plays - a.plays);

  // Collapse hour buckets → dominant signal per hour
  const hourProfiles = {};
  for (const [h, data] of Object.entries(hourMap)) {
    const topGenre  = Object.entries(data.genres).sort((a, b) => b[1] - a[1])[0]?.[0]  || null;
    const topMood   = Object.entries(data.moods).sort((a, b) => b[1] - a[1])[0]?.[0]   || null;
    const topArtist = Object.entries(data.artists).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    hourProfiles[h] = { genre: topGenre, mood: topMood, artist: topArtist };
  }

  return {
    avoidArtists,
    topArtists:   topArtistList.slice(0, 15),
    topGenres:    topGenreList.slice(0, 10),
    hourProfiles,
    skipCounts,
    dataPoints:   events.length,
  };
}

// ── Current-moment context (cheap, called per agent turn) ──────────────────────

/**
 * Returns a compact context object for the current hour. Used to inject
 * time-aware music preferences into the system prompt and planner.
 */
function getCurrentContext() {
  const profile = buildProfile({ days: 14 });
  const hour    = new Date().getHours();
  const hp      = profile.hourProfiles[hour] || {};

  // Build a human-readable insight for the prompt
  const insights = [];
  if (profile.dataPoints < 5) {
    insights.push("Not enough listening history yet — keep playing music to build your profile.");
  } else {
    if (hp.genre)  insights.push(`You usually listen to ${hp.genre} at this hour.`);
    if (hp.mood)   insights.push(`Typical vibe right now: ${hp.mood}.`);
    if (hp.artist) insights.push(`Favourite artist at this hour: ${hp.artist}.`);
    if (profile.avoidArtists.length)
      insights.push(`Frequent skips: ${profile.avoidArtists.slice(0, 3).join(", ")}.`);
  }

  return {
    avoidArtists:    profile.avoidArtists,
    topArtists:      profile.topArtists.slice(0, 5).map((a) => a.name),
    topGenres:       profile.topGenres.slice(0, 3).map((g) => g.name),
    currentHour:     { hour, genre: hp.genre, mood: hp.mood, artist: hp.artist },
    profileInsight:  insights.join(" "),
    dataPoints:      profile.dataPoints,
  };
}

// ── Agent-facing summary (for get_listening_profile tool) ──────────────────────

/**
 * Returns a structured summary the agent can relay to the user or use for
 * smarter recommendations.
 */
function getProfileSummary() {
  const profile = buildProfile({ days: 30 });
  const ctx     = getCurrentContext();

  const patterns = [];
  for (const [h, hp] of Object.entries(profile.hourProfiles)) {
    if (hp.genre || hp.mood) {
      const label = h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
      patterns.push({ hour: Number(h), label, ...hp });
    }
  }
  patterns.sort((a, b) => a.hour - b.hour);

  return {
    topArtists:   profile.topArtists.slice(0, 8),
    topGenres:    profile.topGenres.slice(0, 6),
    avoidArtists: profile.avoidArtists,
    timePatterns: patterns.slice(0, 6),
    currentHour:  ctx.currentHour,
    insight:      ctx.profileInsight,
    dataPoints:   profile.dataPoints,
  };
}

module.exports = { buildProfile, getCurrentContext, getProfileSummary };

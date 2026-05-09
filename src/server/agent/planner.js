// Multi-step session planner. Builds a queue along a requested mood curve
// using Spotify's recently-played tracks as candidates plus their audio
// features (tempo, energy, valence). We don't auto-queue — the model gets a
// proposal it shows the user, who can confirm before queue_track is called.
const {
  spotifyFetch,
  spotifyGenres,
  normalizeSpotifyTrack,
} = require("../providers/spotify");
const { recentTrackKeys } = require("./events");

// Average track is ~3.5 minutes; tune count by duration.
function targetCount(durationMin) {
  const minutesPerTrack = 3.5;
  return Math.max(4, Math.min(40, Math.round(durationMin / minutesPerTrack)));
}

// Mood curve interpreters. We score each candidate against an "ideal energy
// at position p ∈ [0,1]" function. Lower distance == better fit at that slot.
function curveFn(curve) {
  const c = String(curve || "flat").toLowerCase();
  if (/chill.*energ|low.*high|ramp.*up/.test(c))   return (p) => 0.25 + 0.6 * p;       // 0.25 → 0.85
  if (/energ.*chill|high.*low|wind.*down|ramp.*down/.test(c)) return (p) => 0.85 - 0.6 * p; // 0.85 → 0.25
  if (/peak|arch/.test(c))                           return (p) => 0.4 + 0.5 * Math.sin(Math.PI * p); // up then down
  if (/valley|dip/.test(c))                          return (p) => 0.85 - 0.5 * Math.sin(Math.PI * p);
  if (/focus/.test(c))                               return () => 0.55;                  // steady mid
  if (/calm|chill/.test(c))                          return () => 0.35;
  if (/energ|hype/.test(c))                          return () => 0.85;
  return () => 0.55; // flat default
}

async function planSession({
  duration_min = 30,
  mood_curve = "flat",
  exclude_recent_days = 7,
  candidate_pool = 50,
} = {}) {
  // 1. Pull candidates from recently-played + saved (Spotify gives us recently-
  //    played; we use that as the working set since we already have a token).
  const recentResp = await spotifyFetch(`/me/player/recently-played?limit=${Math.min(50, candidate_pool)}`)
    .catch(() => null);
  const items = recentResp?.items || [];
  const tracks = items.map((it) => it.track).filter(Boolean);
  if (!tracks.length) {
    return { ok: false, error: "No Spotify history to plan from yet — play a few tracks first." };
  }

  // 2. Fetch audio features in batch
  const ids = [...new Set(tracks.map((t) => t.id).filter(Boolean))].slice(0, 100);
  let featuresById = {};
  if (ids.length) {
    try {
      const f = await spotifyFetch(`/audio-features?ids=${ids.join(",")}`);
      for (const af of f?.audio_features || []) {
        if (af && af.id) featuresById[af.id] = af;
      }
    } catch {}
  }

  // 3. Filter out tracks the user has already played in the last N days
  const excludeKeys = recentTrackKeys({ days: exclude_recent_days });
  const candidates = [];
  const seenIds = new Set();
  for (const t of tracks) {
    if (!t.id || seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    const key = `${(t.name || "").toLowerCase()}|${(t.artists?.[0]?.name || "").toLowerCase()}`;
    if (excludeKeys.has(key)) continue;
    const feat = featuresById[t.id];
    if (!feat) continue;
    candidates.push({ track: t, feat });
  }

  if (candidates.length < 3) {
    return { ok: false, error: "Not enough candidate tracks with audio features after filtering." };
  }

  // 4. Walk the curve and pick the best-fit candidate for each slot
  const fn = curveFn(mood_curve);
  const need = Math.min(candidates.length, targetCount(duration_min));
  const picked = [];
  const used = new Set();
  for (let i = 0; i < need; i++) {
    const p = need === 1 ? 0.5 : i / (need - 1);
    const ideal = fn(p);
    let best = null;
    let bestDist = Infinity;
    for (const cand of candidates) {
      if (used.has(cand.track.id)) continue;
      const d = Math.abs(cand.feat.energy - ideal);
      if (d < bestDist) { bestDist = d; best = cand; }
    }
    if (!best) break;
    used.add(best.track.id);
    picked.push({ ...best, idealEnergy: +ideal.toFixed(2), dist: +bestDist.toFixed(3) });
  }

  // 5. Format the queue for the model + user
  const genres = await spotifyGenres(picked.map((p) => p.track)).catch(() => ({}));
  const queue = picked.map((p, i) => {
    const norm = normalizeSpotifyTrack(p.track, genres);
    return {
      slot:        i + 1,
      title:       norm.title,
      artist:      norm.artist,
      uri:         norm.uri,
      genre:       norm.genre,
      tempo:       Math.round(p.feat.tempo || 0),
      energy:      +(p.feat.energy ?? 0).toFixed(2),
      valence:     +(p.feat.valence ?? 0).toFixed(2),
      danceability:+(p.feat.danceability ?? 0).toFixed(2),
      idealEnergy: p.idealEnergy,
    };
  });

  const totalMinutes = picked.reduce((s, p) => s + (p.track.duration_ms || 0), 0) / 60000;
  return {
    ok: true,
    duration_min,
    mood_curve,
    estimated_minutes: +totalMinutes.toFixed(1),
    excluded_days: exclude_recent_days,
    candidate_pool: candidates.length,
    queue,
  };
}

module.exports = { planSession };

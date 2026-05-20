// ════════════════════════════════════════════════════════════════════════════
// AGENT TOOLS
// JSON-schema tool definitions (the shape Ollama expects in /api/chat tools)
// plus their server-side handlers. Each handler returns a JSON-serializable
// object that gets fed back to the model as a `tool` role message.
//
// The dispatcher executes a tool by name and is the single integration point
// between the agent loop and the rest of the server (providers, memory).
// ════════════════════════════════════════════════════════════════════════════
const { spotifyFetch, friendlySpotifyError, spotifyProviderPlay, isSpotifyAppLockedOut } = require("../providers/spotify");
const { youtubeSearch, youtubeProviderPlay } = require("../providers/youtube");
const { appleProviderPlay } = require("../providers/apple");
const { remember, recall } = require("./vector-memory");
const { logEvent } = require("./events");
const { planSession } = require("./planner");
const { gatherContext } = require("./context");
const { analyze: analyzeAudio } = require("../providers/audio-analysis");
const { resolveYouTubeVideo } = require("../providers/youtube");
const { getProfileSummary } = require("./profile");

async function runProviderPlay(name, args) {
  if (name === "spotify") return spotifyProviderPlay(args);
  if (name === "youtube") return youtubeProviderPlay(args);
  if (name === "apple")   return appleProviderPlay(args);
  return { ok: false, error: `Unknown provider ${name}` };
}

// ── Tool schemas ─────────────────────────────────────────────────────────
// Compact, action-focused descriptions. The model uses these to decide which
// tool to call, so wording matters more than length.
const toolSchemas = [
  {
    type: "function",
    function: {
      name: "play_track",
      description: "Start playback of a track. Use this whenever the user asks to play something. IMPORTANT: query MUST be the actual 'title artist' of the song — never pronouns like 'this' or 'that song'. If the user says 'play this on X', use the Currently playing title+artist from your context as the query. Provider rules: pass 'auto' to let Blue pick (Spotify → YouTube → Apple). Pass an explicit provider ('spotify' / 'youtube' / 'apple') ONLY when the user names it — and in that case Blue will NOT fall back to other providers.",
      parameters: {
        type: "object",
        properties: {
          query:    { type: "string", description: "Full 'title artist' query. Resolve pronouns from context — never pass 'this', 'that', or empty." },
          uri:      { type: "string", description: "Spotify URI if you already have one." },
          provider: { type: "string", enum: ["auto", "spotify", "youtube", "apple"], description: "Default auto. Only set explicitly if the user named a provider." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_track",
      description: "Add a track to the playback queue without interrupting what's currently playing. Use after the user agrees to a recommendation or as a follow-up to plan_session.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          uri:   { type: "string" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tracks",
      description: "Search for tracks ONLY when the user explicitly wants a LIST of options (e.g. 'find me some songs like X', 'what are the top Coldplay tracks'). DO NOT use search_tracks when the user wants to play music — call play_track directly instead. play_track already handles vague queries internally. Listing results in your text reply is NOT playing.",
      parameters: {
        type: "object",
        properties: {
          query:    { type: "string" },
          provider: { type: "string", enum: ["auto", "spotify", "youtube"] },
          limit:    { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transfer_device",
      description: "Move Spotify playback to a specific device.",
      parameters: {
        type: "object",
        properties: {
          device_id: { type: "string" },
          play:      { type: "boolean" },
        },
        required: ["device_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_mood",
      description: "Record the current vibe so future suggestions match. Call when the user states a mood or you've inferred one with confidence.",
      parameters: {
        type: "object",
        properties: {
          mood:    { type: "string", enum: ["Electric", "Chill", "Focused", "Late Night", "Reflective", "Calm"] },
          context: { type: "string", description: "Why — e.g., 'before a workout', 'late-night coding'." },
        },
        required: ["mood"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description: "Search long-term memory for past preferences, plays, or stated moods. Use BEFORE recommending if you suspect the user has opinions on this kind of music.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search. e.g., 'what does the user think about late-night ambient?'" },
          types: { type: "array", items: { type: "string", enum: ["preference", "mood", "like", "skip", "play", "note"] } },
          k:     { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_preference",
      description: "Persist an explicit preference the user has stated (genres, artists they love/hate, tempo preferences, contexts). Call only when the user states a real preference, not transient feelings.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "How to phrase the preference for future recall." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_track",
      description: "Analyze a track for BPM, musical key (Camelot notation), and energy. Use when the user asks 'what BPM is this' or 'what key is X in', or before suggesting a harmonic mix. Requires the audio sidecar — gracefully says so if missing.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Track query (title artist) — will be resolved via YouTube." },
          url:   { type: "string", description: "YouTube/audio URL if you already have one." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_context",
      description: "Get current real-world context: time of day, weekday, weather, next calendar event. Call when you want to factor in 'is it late?' / 'is it raining?' / 'is something coming up soon?' before recommending.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "find_lyric_line",
      description: "Find a song from a half-remembered lyric. Use when the user says things like 'play that song with the line about X' or 'what's the song that goes ...'. Returns matching lines with track + timestamp.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The lyric fragment or theme to search for." },
          k:     { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_session",
      description: "Plan a multi-track session along a mood curve. Returns a proposed queue — DO NOT auto-queue. Show the queue to the user, ask to confirm, then call queue_track for each.",
      parameters: {
        type: "object",
        properties: {
          duration_min:        { type: "integer", minimum: 5, maximum: 240 },
          mood_curve:          { type: "string", description: "e.g. 'chill to energetic', 'energetic to wind down', 'peak in the middle', 'flat focus'" },
          exclude_recent_days: { type: "integer", minimum: 0, maximum: 60, description: "Skip tracks the user played in the last N days. Default 7." },
        },
        required: ["duration_min", "mood_curve"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_listening_profile",
      description: "Return the user's adaptive listening profile: top artists/genres, time-of-day patterns, and artists they frequently skip. Call BEFORE making unsolicited recommendations or when the user asks what they listen to.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────────
// Each handler returns a JSON-serializable result. We track an optional
// `__action` shape (action, track, playQuery) so the chat route can
// reconstruct the legacy SSE done payload the existing frontend expects.
async function play_track({ query, uri, provider = "auto" }) {
  // Reject obviously-bad queries before they hit any provider. The model
  // sometimes passes pronouns ("this", "that", "the song") which Spotify's
  // search will happily match against a random unrelated track.
  const q = String(query || "").trim();
  if (provider !== "auto" || !uri) {
    if (!uri && /^(this|that|it|the song|current(ly)? playing)?$/i.test(q)) {
      return {
        ok: false,
        provider,
        error: "I don't know which song to play — tell me the title and artist.",
      };
    }
  }

  // Try providers in order. Unlike musicPlay (HTTP route), runProviderPlay
  // returns {ok:false, error} for soft failures (no device, no token), and
  // only THROWS for transport errors. We need to honor both — checking
  // result.ok on the way back, not just catching exceptions.
  // Skip Spotify entirely once we've confirmed the dev-app lockout — it'll
  // just 403 again. The user will get a single tool round trip on YouTube.
  const skipSpotify = isSpotifyAppLockedOut();
  let order;
  if (provider === "auto") {
    order = skipSpotify ? ["youtube", "apple"] : ["spotify", "youtube", "apple"];
  } else if (skipSpotify && provider === "spotify") {
    // User asked for Spotify but it's locked out — degrade to YouTube once,
    // don't try other providers silently.
    order = ["youtube"];
  } else {
    // User named a provider — honor it strictly. No silent fallback to other
    // services, because they'd play the wrong song against a wrong-context
    // query (e.g. "play this on YouTube" → falling through to Spotify search
    // matches against a random track).
    order = [provider];
  }

  let lastResult = null;
  let lastErrors = [];
  const seen = new Set();
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    let result;
    try {
      result = await runProviderPlay(name, { query, uri });
    } catch (e) {
      lastErrors.push({ provider: name, error: e.message });
      continue;
    }
    lastResult = { ...result, provider: name };
    if (result?.ok) break;
    lastErrors.push({ provider: name, error: result?.error || "unknown" });
    // If the provider returned only a preview (Spotify free tier), keep it as
    // a soft success — but still try the next provider for full playback.
  }

  // Pick the best outcome we got. ok=true wins; otherwise return the first
  // result so the model has something to narrate.
  const ok = !!(lastResult && lastResult.ok);
  const finalProvider = lastResult?.provider || (provider === "auto" ? "spotify" : provider);

  if (ok && lastResult.track) {
    await logEvent("play", {
      title:    lastResult.track.title,
      artist:   lastResult.track.artist,
      genre:    lastResult.track.genre || "",
      query,
      provider: finalProvider,
      uri:      lastResult.uri || uri,
    });

    // Announce "now playing" via voice daemon if it's running
    const VOICE_PORT = Number(process.env.BLUE_VOICE_PORT || 4177);
    if (VOICE_PORT) {
      const trackLabel = lastResult.track.title
        + (lastResult.track.artist ? ` by ${lastResult.track.artist}` : "");
      fetch(`http://127.0.0.1:${VOICE_PORT}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `Now playing ${trackLabel}` }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
  }

  return {
    ok,
    provider: finalProvider,
    track: lastResult?.track || null,
    youtube: lastResult?.youtube || null,
    previewUrl: lastResult?.previewUrl || null,
    uri: lastResult?.uri || uri || null,
    attempts: lastErrors,
    error: ok ? undefined : (lastResult?.error || lastErrors[0]?.error || "Could not play that track."),
    __action: {
      action: "play",
      playQuery: query || "",
      track: lastResult?.track || null,
      provider: finalProvider,
    },
  };
}

async function queue_track({ query, uri }) {
  let trackUri = uri || "";
  if (!trackUri && query) {
    try {
      const search = await spotifyFetch(`/search?type=track&limit=1&q=${encodeURIComponent(query)}`);
      trackUri = search.tracks?.items?.[0]?.uri || "";
    } catch (e) {
      return { ok: false, error: friendlySpotifyError(e.message) };
    }
  }
  if (!trackUri) return { ok: false, error: "Need a uri or query to queue." };
  try {
    await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(trackUri)}`, { method: "POST" });
    await logEvent("queue", { uri: trackUri, query });
    return { ok: true, uri: trackUri };
  } catch (e) {
    return { ok: false, error: friendlySpotifyError(e.message) };
  }
}

async function search_tracks({ query, provider = "auto", limit }) {
  // Coerce nulls and bad values — some models pass `limit: null` which would
  // break the `results.length < limit` checks below.
  const lim = (typeof limit === "number" && limit > 0) ? Math.min(10, limit) : 5;
  const out = { ok: true, results: [] };
  if (provider === "spotify" || provider === "auto") {
    try {
      const r = await spotifyFetch(`/search?type=track&limit=${lim}&q=${encodeURIComponent(query)}`);
      for (const t of r?.tracks?.items || []) {
        out.results.push({
          provider: "spotify",
          title: t.name,
          artist: t.artists?.map((a) => a.name).join(", ") || "",
          uri: t.uri,
        });
      }
    } catch {}
  }
  if (out.results.length < lim && (provider === "youtube" || provider === "auto")) {
    try {
      const yt = await youtubeSearch(query);
      for (const v of yt.slice(0, lim - out.results.length)) {
        out.results.push({ provider: "youtube", title: v.title, artist: v.channel, videoId: v.videoId });
      }
    } catch {}
  }
  return out;
}

async function transfer_device({ device_id, play = false }) {
  try {
    await spotifyFetch("/me/player", {
      method: "PUT",
      body: JSON.stringify({ device_ids: [device_id], play }),
    });
    return { ok: true, device_id };
  } catch (e) {
    return { ok: false, error: friendlySpotifyError(e.message) };
  }
}

async function set_mood({ mood, context = "" }) {
  await logEvent("mood", { mood, context });
  return { ok: true, mood, __action: { mood } };
}

async function recall_memory({ query, types = null, k = 5 }) {
  const results = await recall(query, { k, types });
  return { ok: true, count: results.length, results };
}

async function save_preference({ text }) {
  if (!text || !String(text).trim()) return { ok: false, error: "text required." };
  await logEvent("preference", { text });
  return { ok: true, saved: text };
}

async function plan_session(args) {
  return planSession(args);
}

async function get_context() {
  const ctx = await gatherContext();
  return { ok: true, ...ctx };
}

async function analyze_track({ query, url }) {
  let resolvedUrl = url;
  let cache_key = url;
  if (!resolvedUrl && query) {
    const yt = await resolveYouTubeVideo(query).catch(() => null);
    if (!yt?.videoId) return { ok: false, error: "Could not resolve that track on YouTube." };
    resolvedUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;
    cache_key = `yt:${yt.videoId}`;
  }
  if (!resolvedUrl) return { ok: false, error: "Provide a query or url." };
  return analyzeAudio({ url: resolvedUrl, cache_key });
}

async function get_listening_profile() {
  const summary = getProfileSummary();
  return { ok: true, ...summary };
}

async function find_lyric_line({ query, k = 5 }) {
  const hits = await recall(query, { k: Math.min(10, k), types: ["lyric"] });
  return {
    ok: true,
    count: hits.length,
    results: hits.map((h) => ({
      title:     h.meta?.title || "",
      artist:    h.meta?.artist || "",
      line:      h.text,
      timestamp: h.meta?.time ?? null,
      score:     h.score,
    })),
  };
}

const handlers = {
  play_track,
  queue_track,
  search_tracks,
  transfer_device,
  set_mood,
  recall_memory,
  save_preference,
  plan_session,
  find_lyric_line,
  get_context,
  analyze_track,
  get_listening_profile,
};

async function dispatch(name, args) {
  const handler = handlers[name];
  if (!handler) return { ok: false, error: `Unknown tool: ${name}` };
  try {
    return await handler(args || {});
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { toolSchemas, handlers, dispatch };

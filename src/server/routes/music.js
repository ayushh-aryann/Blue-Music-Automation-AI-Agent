// ════════════════════════════════════════════════════════════════════════════
// MULTI-PROVIDER MUSIC ABSTRACTION
// Unified API that lets the frontend say "play this" without caring whether
// it ends up on Spotify, YouTube, or Apple Music. Provider selection follows:
//   1. Explicit provider in request
//   2. User preference (memory.preferredProvider)
//   3. Capability order: spotify → youtube → spotify-preview
// Each provider implements: play, search, queue (where supported).
// ════════════════════════════════════════════════════════════════════════════
const { readState } = require("../lib/state");
const { readJson, json } = require("../lib/http");
const {
  spotifyFetch,
  spotifyGenres,
  normalizeSpotifyTrack,
  friendlySpotifyError,
  spotifyProviderPlay,
} = require("../providers/spotify");
const { youtubeSearch, youtubeProviderPlay } = require("../providers/youtube");
const { appleProviderPlay } = require("../providers/apple");
const { classifyTrackGenre } = require("../providers/itunes");

async function musicProviderStatuses() {
  const state = readState();
  return {
    ok: true,
    providers: {
      spotify: {
        connected:     Boolean(state.spotify?.access_token || process.env.SPOTIFY_ACCESS_TOKEN),
        oauth:         Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
        capabilities:  ["play", "search", "queue", "transfer", "audio-features"],
        loginUrl:      "/api/spotify/login",
      },
      youtube: {
        connected:     true, // always available — IFrame Player is public
        hasApiKey:     Boolean(process.env.YOUTUBE_API_KEY),
        capabilities:  ["play", "search"],
      },
      apple: {
        connected:     Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY),
        capabilities:  ["play", "search"],
        setupRequired: !(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY),
      },
    },
  };
}

function chooseProvider(requested, statuses) {
  const order = [requested, "spotify", "youtube", "apple"].filter(Boolean);
  for (const name of order) {
    const p = statuses.providers[name];
    if (p?.connected) return name;
  }
  return "youtube"; // YouTube is always reachable as a search-driven fallback
}

async function runProviderPlay(name, args) {
  if (name === "spotify") return spotifyProviderPlay(args);
  if (name === "youtube") return youtubeProviderPlay(args);
  if (name === "apple")   return appleProviderPlay(args);
  return { ok: false, error: `Unknown provider ${name}` };
}

async function musicPlay(req, res) {
  try {
    const body = await readJson(req);
    const requested = (body.provider || "auto").toLowerCase();
    const query  = String(body.query  || "").trim();
    const uri    = String(body.uri    || "").trim();
    const title  = String(body.title  || "").trim();
    const artist = String(body.artist || "").trim();
    const composedQuery = query || [title, artist].filter(Boolean).join(" ");

    if (!composedQuery && !uri) {
      return json(res, { ok: false, error: "Provide a query, title, or uri." }, 400);
    }

    const statuses = await musicProviderStatuses();
    const order = requested === "auto"
      ? ["spotify", "youtube", "apple"]
      : [requested, "spotify", "youtube", "apple"];

    const seen = new Set();
    const attempts = [];
    for (const name of order) {
      if (seen.has(name)) continue;
      seen.add(name);
      const p = statuses.providers[name];
      if (!p?.connected) {
        attempts.push({ provider: name, ok: false, reason: "not connected" });
        continue;
      }
      const result = await runProviderPlay(name, { query: composedQuery, uri, title, artist }).catch((e) => ({ ok: false, error: e.message }));
      attempts.push({ provider: name, ...result });
      if (result.ok) {
        return json(res, { ok: true, provider: name, attempts, ...result });
      }
      // For preview-only outcomes, count as success
      if (result.previewUrl) {
        return json(res, { ok: true, provider: `${name}-preview`, attempts, ...result });
      }
    }
    return json(res, { ok: false, attempts, error: "No provider could play that track." });
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
}

async function musicSearch(url, res) {
  const provider = (url.searchParams.get("provider") || "auto").toLowerCase();
  const q        = url.searchParams.get("q") || "";
  if (!q.trim()) return json(res, { ok: false, error: "q is required." }, 400);

  const out = { ok: true, provider, results: [] };
  try {
    if (provider === "spotify" || provider === "auto") {
      const r = await spotifyFetch(`/search?type=track&limit=8&q=${encodeURIComponent(q)}`).catch(() => null);
      const items = r?.tracks?.items || [];
      const genres = items.length ? await spotifyGenres(items).catch(() => ({})) : {};
      out.results.push(...items.map((t) => ({
        provider: "spotify",
        ...normalizeSpotifyTrack(t, genres),
        albumArt:   t.album?.images?.[0]?.url || "",
        previewUrl: t.preview_url || null,
        uri:        t.uri,
      })));
    }
    if (provider === "youtube" || (provider === "auto" && out.results.length < 3)) {
      const yt = await youtubeSearch(q).catch(() => []);
      out.results.push(...yt.slice(0, 5).map((v) => ({
        provider: "youtube",
        title:    v.title,
        artist:   v.channel,
        videoId:  v.videoId,
        albumArt: v.thumbnail,
        embedUrl: `https://www.youtube.com/embed/${v.videoId}?autoplay=1&playsinline=1&modestbranding=1&enablejsapi=1`,
        query:    q,
      })));
    }
    json(res, out);
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
}

async function musicQueue(req, res) {
  try {
    const body = await readJson(req);
    const provider = (body.provider || "spotify").toLowerCase();
    if (provider === "spotify") {
      let uri = body.uri || "";
      if (!uri && body.query) {
        const search = await spotifyFetch(`/search?type=track&limit=1&q=${encodeURIComponent(body.query)}`);
        uri = search.tracks?.items?.[0]?.uri || "";
      }
      if (!uri) return json(res, { ok: false, error: "Need a Spotify uri or query." }, 400);
      await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: "POST" });
      return json(res, { ok: true, provider: "spotify", uri });
    }
    return json(res, { ok: false, error: `Queueing not supported for ${provider} yet.` }, 501);
  } catch (error) {
    json(res, { ok: false, error: friendlySpotifyError(error.message) }, 500);
  }
}

async function musicTransfer(req, res) {
  try {
    const body = await readJson(req);
    const deviceId = body.deviceId;
    if (!deviceId) return json(res, { ok: false, error: "deviceId required." }, 400);
    await spotifyFetch("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [deviceId], play: !!body.play }) });
    json(res, { ok: true, deviceId });
  } catch (error) {
    json(res, { ok: false, error: friendlySpotifyError(error.message) }, 500);
  }
}

async function musicIdentify(url, res) {
  const title  = url.searchParams.get("title")  || "";
  const artist = url.searchParams.get("artist") || "";
  if (!title) return json(res, { ok: false, error: "title required." }, 400);
  try {
    const result = await classifyTrackGenre({ title, artist });
    json(res, { ok: true, ...result });
  } catch (error) {
    json(res, { ok: false, error: error.message });
  }
}

module.exports = {
  musicProviderStatuses,
  chooseProvider,
  musicPlay,
  musicSearch,
  musicQueue,
  musicTransfer,
  musicIdentify,
  runProviderPlay,
};

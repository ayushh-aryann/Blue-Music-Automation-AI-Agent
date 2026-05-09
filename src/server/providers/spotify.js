const { readState, writeState } = require("../lib/state");
const { BASE_URL } = require("../lib/config");
const {
  inferMood,
  pickArtistGenre,
  inferGenreFromText,
} = require("../lib/music-text");

function spotifyRedirectUri() {
  return process.env.SPOTIFY_REDIRECT_URI || `${BASE_URL}/api/spotify/callback`;
}

async function spotifyToken() {
  if (process.env.SPOTIFY_ACCESS_TOKEN) return process.env.SPOTIFY_ACCESS_TOKEN;
  const state = readState();
  const token = state.spotify;
  if (!token?.access_token) return "";
  if (token.expires_at && Date.now() < token.expires_at - 60000) return token.access_token;
  if (!token.refresh_token) return token.access_token;

  const refreshed = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token }),
  }).then((response) => response.json());

  const next = {
    ...state,
    spotify: {
      ...token,
      ...refreshed,
      refresh_token: refreshed.refresh_token || token.refresh_token,
      expires_at: Date.now() + (refreshed.expires_in || 3600) * 1000,
    },
  };
  writeState(next);
  return next.spotify.access_token;
}

async function spotifyFetch(endpoint, options = {}) {
  const token = await spotifyToken();
  if (!token) throw new Error("Spotify is not connected.");
  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  // Spotify normally returns JSON, but some error paths (gateway pages, plain
  // "Active premium required" strings) come back as raw text. Don't let
  // JSON.parse throw — that surfaces "Unexpected token..." in the chat.
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  }
  if (!response.ok) {
    const msg = data?.error?.message || (text ? text.slice(0, 200) : `Spotify ${response.status}`);
    throw new Error(msg);
  }
  return data;
}

async function spotifyGenres(tracks) {
  const ids = [
    ...new Set(
      tracks
        .flatMap((track) => track?.artists || [])
        .map((artist) => artist.id)
        .filter(Boolean),
    ),
  ].slice(0, 50);
  if (!ids.length) return {};
  try {
    const data = await spotifyFetch(`/artists?ids=${ids.join(",")}`);
    return Object.fromEntries(
      (data.artists || []).map((artist) => [artist.id, pickArtistGenre(artist.genres || [])]),
    );
  } catch {
    return {};
  }
}

function normalizeSpotifyTrack(track, genres = {}) {
  const allArtists = track.artists || [];
  const firstArtist = allArtists[0];
  // Walk every artist on the track and bucket-vote across them.
  const bucketCounts = {};
  for (const a of allArtists) {
    const g = genres[a.id];
    if (g && g !== "Unknown") bucketCounts[g] = (bucketCounts[g] || 0) + 1;
  }
  let genre = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "Unknown";
  if (genre === "Unknown") {
    genre = inferGenreFromText(`${track.name} ${allArtists.map((a) => a.name).join(" ")}`);
  }
  return {
    id: track.id,
    title: track.name,
    artist: allArtists.map((a) => a.name).join(", "),
    band: firstArtist?.name || "",
    genre,
    mood: inferMood(`${track.name} ${genre}`) || "Chill",
    query: `${track.name} ${allArtists.map((a) => a.name).join(" ")}`,
    uri: track.uri,
    album: track.album?.name || "",
    playedAt: new Date().toISOString(),
  };
}

function spotifyMoodFromFeatures(f = {}) {
  // Map the 5 most useful features (energy, valence, danceability, tempo,
  // acousticness) onto Blue's mood vocabulary.
  if (!f || typeof f.energy !== "number") return "";
  const { energy = 0.5, valence = 0.5, danceability = 0.5, tempo = 110, acousticness = 0.4 } = f;
  if (energy > 0.78 && tempo > 120 && danceability > 0.55) return "Electric";
  if (energy < 0.35 && acousticness > 0.55) return valence > 0.45 ? "Calm" : "Reflective";
  if (energy < 0.55 && valence < 0.4)  return "Late Night";
  if (energy > 0.55 && energy < 0.78 && valence > 0.55) return "Chill";
  if (energy >= 0.6 && valence < 0.5)  return "Focused";
  return "Chill";
}

// Tracks whether we've seen the "app owner needs Premium" 403. Once seen,
// we know every Spotify call will fail with the same error for hours, so the
// agent skips Spotify and goes straight to YouTube.
let spotifyAppLockedOut = false;
function isSpotifyAppLockedOut() { return spotifyAppLockedOut; }

function friendlySpotifyError(msg = "") {
  const m = String(msg || "").toLowerCase();
  // Spotify's late-2024 policy: the developer account that registered the app
  // must itself have a Premium subscription, or every API call (even search)
  // returns 403. This error message is exact.
  if (/active premium subscription required for the owner of the app/.test(m)) {
    spotifyAppLockedOut = true;
    return "Spotify is locked out: the account that registered this Spotify app needs Premium. Until then I'll use YouTube. (Fix: upgrade that Spotify account, or re-register the app under a Premium one.)";
  }
  if (/no.*active.*device|player command failed: no active device|device not found/.test(m))
    return "No Spotify device is online — open the Spotify app on any device and press play once, then ask me again.";
  if (/premium/.test(m))
    return "Spotify Premium is required for this action. I'll fall back to YouTube.";
  if (/restrict/.test(m))
    return "Spotify says playback is restricted right now. Try pressing play once in the Spotify app, then ask me again.";
  if (/(401|expired|token|unauthorized)/.test(m))
    return "Spotify session expired. Hit Connect Spotify up top to refresh it.";
  if (/rate limit|429/.test(m))
    return "Spotify is rate-limiting us for a moment. Give it a few seconds and try again.";
  return msg || "Could not reach Spotify.";
}

// Spotify play, factored from the route handler so the multi-provider path
// can reuse it without going through HTTP. Returns the same shape musicPlay
// expects.
async function spotifyProviderPlay({ query, uri, title, artist }) {
  let trackUri = uri;
  let track = null;
  let item = null;
  if (!trackUri) {
    try {
      const search = await spotifyFetch(`/search?type=track&limit=1&q=${encodeURIComponent(query)}`);
      item = search.tracks?.items?.[0];
      if (item) {
        trackUri = item.uri;
        const genres = await spotifyGenres([item]).catch(() => ({}));
        track = normalizeSpotifyTrack(item, genres);
        track.previewUrl = item.preview_url || null;
        track.albumArt   = item.album?.images?.[0]?.url || "";
      }
    } catch (e) {
      return { ok: false, error: friendlySpotifyError(e.message) };
    }
  }
  if (!trackUri) return { ok: false, error: friendlySpotifyError("No Spotify track found.") };

  // Pick a device — and bail early with a clear message if none exist. The
  // Spotify Web API lists devices that are "Spotify Connect online", which
  // requires the desktop/mobile/web Spotify app to be open and recently
  // active. If none are online we can't route playback there.
  let deviceId = "", deviceName = "";
  let devices = [];
  try {
    const list = await spotifyFetch("/me/player/devices");
    devices = list?.devices || [];
  } catch {}

  if (!devices.length) {
    return {
      ok: false,
      track,
      previewUrl: track?.previewUrl || item?.preview_url || null,
      uri: trackUri,
      error: "No Spotify device is online. Open the Spotify app on your phone, desktop, or web player and press play once — then ask me again. Until then I'll route through YouTube.",
      noDevice: true,
    };
  }

  const active = devices.find((d) => d.is_active);
  const target = active || devices[0];
  deviceId = target.id;
  deviceName = target.name;
  if (!active) {
    try {
      await spotifyFetch("/me/player", {
        method: "PUT",
        body: JSON.stringify({ device_ids: [deviceId], play: false }),
      });
    } catch {}
  }

  try {
    const path = deviceId ? `/me/player/play?device_id=${deviceId}` : "/me/player/play";
    await spotifyFetch(path, { method: "PUT", body: JSON.stringify({ uris: [trackUri] }) });
    return {
      ok: true,
      track,
      device: deviceName,
      previewUrl: track?.previewUrl || item?.preview_url || null,
      uri: trackUri,
    };
  } catch (e) {
    // No active device or no premium — surface the preview if we have one
    return {
      ok: false,
      track,
      previewUrl: track?.previewUrl || item?.preview_url || null,
      uri: trackUri,
      error: friendlySpotifyError(e.message),
    };
  }
}

module.exports = {
  spotifyRedirectUri,
  spotifyToken,
  spotifyFetch,
  spotifyGenres,
  normalizeSpotifyTrack,
  spotifyMoodFromFeatures,
  friendlySpotifyError,
  spotifyProviderPlay,
  isSpotifyAppLockedOut,
};

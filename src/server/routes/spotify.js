const crypto = require("crypto");
const { readState, writeState } = require("../lib/state");
const { readJson, json, html } = require("../lib/http");
const {
  spotifyRedirectUri,
  spotifyFetch,
  spotifyGenres,
  normalizeSpotifyTrack,
  spotifyMoodFromFeatures,
  friendlySpotifyError,
} = require("../providers/spotify");

function spotifyLogin(res) {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return html(
      res,
      "<h1>Spotify credentials missing</h1><p>Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env, then restart Blue.</p>",
      501,
    );
  }

  const state = crypto.randomBytes(16).toString("hex");
  const saved = readState();
  writeState({ ...saved, spotifyAuthState: state });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: [
      "user-read-currently-playing",
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-recently-played",
      "user-read-private",
      "streaming",
    ].join(" "),
    redirect_uri: spotifyRedirectUri(),
    state,
  });
  res.writeHead(302, { Location: `https://accounts.spotify.com/authorize?${params}` });
  res.end();
}

async function spotifyCallback(url, res) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = readState();
  if (!code || state !== saved.spotifyAuthState) return html(res, "<h1>Spotify authorization failed</h1>", 400);

  const token = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: spotifyRedirectUri(),
    }),
  }).then((response) => response.json());

  writeState({
    ...saved,
    spotifyAuthState: undefined,
    spotify: {
      ...token,
      expires_at: Date.now() + (token.expires_in || 3600) * 1000,
    },
  });
  html(res, "<script>location.href='/'</script><p>Spotify connected. Returning to Blue...</p>");
}

async function spotifyCurrent(res) {
  try {
    const data = await spotifyFetch("/me/player/currently-playing");
    if (!data?.item) return json(res, { ok: true, track: null });
    const genres = await spotifyGenres([data.item]).catch(() => ({}));
    const track = normalizeSpotifyTrack(data.item, genres);
    const images = data.item.album?.images || [];
    track.albumArt      = images[0]?.url || images[1]?.url || "";
    track.albumArtSmall = images[2]?.url || images[1]?.url || track.albumArt;
    track.durationMs    = data.item.duration_ms || 0;
    json(res, {
      ok: true,
      isPlaying: data.is_playing,
      progressMs: data.progress_ms || 0,
      durationMs: data.item.duration_ms || 0,
      track,
    });
  } catch (error) {
    json(res, { ok: false, error: error.message }, 501);
  }
}

async function spotifyRecent(res) {
  try {
    const data = await spotifyFetch("/me/player/recently-played?limit=50");
    const tracks = (data.items || []).map((item) => item.track).filter(Boolean);
    const genres = await spotifyGenres(tracks);
    const events = (data.items || []).map((item) => ({
      ...normalizeSpotifyTrack(item.track, genres),
      playedAt: item.played_at,
    }));
    json(res, { ok: true, events });
  } catch (error) {
    json(res, { ok: false, events: [], error: error.message }, 501);
  }
}

async function spotifyPlay(req, res) {
  let trackUri = "";
  let track = null;
  let item = null;
  let searchError = null;

  try {
    const body = await readJson(req);
    trackUri = body.uri || "";

    if (!trackUri) {
      try {
        const search = await spotifyFetch(`/search?type=track&limit=1&q=${encodeURIComponent(body.query || "")}`);
        item = search.tracks?.items?.[0];
        if (item) {
          trackUri = item.uri;
          const genres = await spotifyGenres([item]).catch(() => ({}));
          track = normalizeSpotifyTrack(item, genres);
          track.previewUrl = item.preview_url || null;
        }
      } catch (e) {
        searchError = e.message;
      }
    }

    // If we never resolved a track (no uri, search blocked) we still want to
    // tell the frontend with a friendly message — never raw Spotify text.
    if (!trackUri) {
      return json(res, {
        ok: false,
        track: null,
        previewUrl: null,
        error: friendlySpotifyError(searchError || "No Spotify track found for that query."),
      });
    }

    // Pick a device — prefer active, else first available, transferring if needed.
    let deviceId = "";
    let deviceName = "";
    try {
      const list = await spotifyFetch("/me/player/devices");
      const devices = list?.devices || [];
      const active = devices.find((d) => d.is_active);
      const target = active || devices[0];
      if (target) {
        deviceId = target.id;
        deviceName = target.name;
        if (!active) {
          await spotifyFetch("/me/player", {
            method: "PUT",
            body: JSON.stringify({ device_ids: [deviceId], play: false }),
          });
        }
      }
    } catch {}

    let played = false;
    let playError = null;
    try {
      const path = deviceId ? `/me/player/play?device_id=${deviceId}` : "/me/player/play";
      await spotifyFetch(path, {
        method: "PUT",
        body: JSON.stringify({ uris: [trackUri] }),
      });
      played = true;
    } catch (e) {
      playError = e.message;
    }

    json(res, {
      ok: played,
      track,
      device: deviceName || null,
      previewUrl: track?.previewUrl || item?.preview_url || null,
      uri: trackUri,
      error: played ? undefined : friendlySpotifyError(playError),
    });
  } catch (error) {
    json(res, {
      ok: false,
      track,
      previewUrl: track?.previewUrl || item?.preview_url || null,
      error: friendlySpotifyError(error.message),
    });
  }
}

async function spotifyDevices(res) {
  try {
    const data = await spotifyFetch("/me/player/devices");
    json(res, { ok: true, devices: data?.devices || [] });
  } catch (error) {
    json(res, { ok: false, devices: [], error: friendlySpotifyError(error.message) }, 501);
  }
}

async function spotifyQueueEndpoint(req, res) {
  try {
    const body = await readJson(req);
    let uri = body.uri || "";
    if (!uri && body.query) {
      const search = await spotifyFetch(`/search?type=track&limit=1&q=${encodeURIComponent(body.query)}`);
      uri = search.tracks?.items?.[0]?.uri || "";
    }
    if (!uri) return json(res, { ok: false, error: "Need a uri or query." }, 400);
    await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: "POST" });
    json(res, { ok: true, uri });
  } catch (error) {
    json(res, { ok: false, error: friendlySpotifyError(error.message) }, 500);
  }
}

async function spotifyTransferEndpoint(req, res) {
  try {
    const body = await readJson(req);
    if (!body.deviceId) return json(res, { ok: false, error: "deviceId required." }, 400);
    await spotifyFetch("/me/player", {
      method: "PUT",
      body: JSON.stringify({ device_ids: [body.deviceId], play: !!body.play }),
    });
    json(res, { ok: true });
  } catch (error) {
    json(res, { ok: false, error: friendlySpotifyError(error.message) }, 500);
  }
}

async function spotifyFeaturesEndpoint(url, res) {
  const id = url.searchParams.get("id") || "";
  if (!id) return json(res, { ok: false, error: "id required." }, 400);
  try {
    const features = await spotifyFetch(`/audio-features/${id}`);
    json(res, { ok: true, features, mood: spotifyMoodFromFeatures(features) });
  } catch (error) {
    json(res, { ok: false, error: friendlySpotifyError(error.message) }, 500);
  }
}

async function spotifySearchEndpoint(url, res) {
  const q = url.searchParams.get("q") || "";
  const type = url.searchParams.get("type") || "track";
  const limit = url.searchParams.get("limit") || "8";
  if (!q.trim()) return json(res, { ok: false, error: "q required." }, 400);
  try {
    const r = await spotifyFetch(`/search?type=${encodeURIComponent(type)}&limit=${encodeURIComponent(limit)}&q=${encodeURIComponent(q)}`);
    const items = r?.tracks?.items || [];
    const genres = await spotifyGenres(items).catch(() => ({}));
    json(res, {
      ok: true,
      results: items.map((t) => ({
        ...normalizeSpotifyTrack(t, genres),
        albumArt:   t.album?.images?.[0]?.url || "",
        previewUrl: t.preview_url || null,
        uri:        t.uri,
      })),
    });
  } catch (error) {
    json(res, { ok: false, error: friendlySpotifyError(error.message) }, 500);
  }
}

module.exports = {
  spotifyLogin,
  spotifyCallback,
  spotifyCurrent,
  spotifyRecent,
  spotifyPlay,
  spotifyDevices,
  spotifyQueueEndpoint,
  spotifyTransferEndpoint,
  spotifyFeaturesEndpoint,
  spotifySearchEndpoint,
};

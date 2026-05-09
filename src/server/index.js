// Blue server entry point. Loads .env, constructs the http server, and
// dispatches to route handlers. Route logic lives in routes/*; this file is
// only responsible for wiring URLs to handlers.
const http = require("http");
const { loadEnv } = require("./lib/env");
loadEnv();

const { PORT, BASE_URL } = require("./lib/config");
const { json, serveStatic } = require("./lib/http");

const { health } = require("./routes/health");
const { chat, chatStream } = require("./routes/chat");
const { mediaKey } = require("./routes/system");
const {
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
} = require("./routes/spotify");
const {
  musicProviderStatuses,
  musicPlay,
  musicSearch,
  musicQueue,
  musicTransfer,
  musicIdentify,
} = require("./routes/music");
const {
  youtubeSearchEndpoint,
  youtubeResolveEndpoint,
} = require("./routes/youtube");
const { appleDeveloperTokenEndpoint } = require("./routes/apple");
const { lyrics, searchLyrics } = require("./routes/lyrics");
const { getMemory, clearMemory } = require("./routes/memory");
const {
  postEvent,
  getEvents,
  getMemoryStats,
  postMemorySearch,
} = require("./routes/events");
const { audioHealth, audioAnalyze } = require("./routes/audio");

const { warmOllama } = require("./agent/ollama");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE_URL);

    // ── Existing endpoints ────────────────────────────────────────────────
    if (url.pathname === "/api/health") return json(res, await health());
    if (url.pathname === "/api/chat" && req.method === "POST") return chat(req, res);
    if (url.pathname === "/api/system/media" && req.method === "POST") return mediaKey(req, res);
    if (url.pathname === "/api/spotify/login") return spotifyLogin(res);
    if (url.pathname === "/api/spotify/callback") return spotifyCallback(url, res);
    if (url.pathname === "/api/spotify/current") return spotifyCurrent(res);
    if (url.pathname === "/api/spotify/recent") return spotifyRecent(res);
    if (url.pathname === "/api/spotify/play" && req.method === "POST") return spotifyPlay(req, res);
    if (url.pathname === "/api/lyrics") return lyrics(url, res);
    if (url.pathname === "/api/lyrics/search" && req.method === "POST") return searchLyrics(req, res);

    // ── Streaming chat with optional tool-calling agent loop ──────────────
    if (url.pathname === "/api/chat/stream" && req.method === "POST") return chatStream(req, res);

    // ── Unified multi-provider music control ──────────────────────────────
    if (url.pathname === "/api/music/providers") return json(res, await musicProviderStatuses());
    if (url.pathname === "/api/music/play"     && req.method === "POST") return musicPlay(req, res);
    if (url.pathname === "/api/music/search")   return musicSearch(url, res);
    if (url.pathname === "/api/music/queue"    && req.method === "POST") return musicQueue(req, res);
    if (url.pathname === "/api/music/transfer" && req.method === "POST") return musicTransfer(req, res);
    if (url.pathname === "/api/music/identify") return musicIdentify(url, res);

    // ── YouTube — primary alternative provider for in-browser playback ────
    if (url.pathname === "/api/youtube/search")  return youtubeSearchEndpoint(url, res);
    if (url.pathname === "/api/youtube/resolve") return youtubeResolveEndpoint(url, res);

    // ── Spotify — extended endpoints (queue / devices / features / transfer)
    if (url.pathname === "/api/spotify/devices") return spotifyDevices(res);
    if (url.pathname === "/api/spotify/queue"   && req.method === "POST") return spotifyQueueEndpoint(req, res);
    if (url.pathname === "/api/spotify/transfer"&& req.method === "POST") return spotifyTransferEndpoint(req, res);
    if (url.pathname === "/api/spotify/features") return spotifyFeaturesEndpoint(url, res);
    if (url.pathname === "/api/spotify/search")  return spotifySearchEndpoint(url, res);

    // ── Apple MusicKit developer-token endpoint ───────────────────────────
    if (url.pathname === "/api/apple/developer-token") return appleDeveloperTokenEndpoint(res);

    // ── Conversation memory — read / clear short-term context ─────────────
    if (url.pathname === "/api/memory" && req.method === "GET")    return getMemory(req, res);
    if (url.pathname === "/api/memory" && req.method === "DELETE") return clearMemory(req, res);

    // ── Long-term memory + event log (Phase 1) ───────────────────────────
    if (url.pathname === "/api/events"        && req.method === "GET")  return getEvents(url, res);
    if (url.pathname === "/api/events"        && req.method === "POST") return postEvent(req, res);
    if (url.pathname === "/api/memory/stats"  && req.method === "GET")  return getMemoryStats(req, res);
    if (url.pathname === "/api/memory/search" && req.method === "POST") return postMemorySearch(req, res);

    // ── Audio analysis sidecar (Phase 2) ─────────────────────────────────
    if (url.pathname === "/api/audio/health"  && req.method === "GET")  return audioHealth(req, res);
    if (url.pathname === "/api/audio/analyze" && req.method === "POST") return audioAnalyze(req, res);

    return serveStatic(url.pathname, res);
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Blue is living at ${BASE_URL}`);
  warmOllama().catch(() => {});
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const ROOT = __dirname;
const STATE_PATH = path.join(ROOT, ".blue-state.json");
const ENV_PATH = path.join(ROOT, ".env");

loadEnv();

const PORT = Number(process.env.BLUE_PORT || 4175);
const BASE_URL = process.env.BLUE_BASE_URL || `http://127.0.0.1:${PORT}`;
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
let cachedOllamaModel = "";
let cachedOllamaModels = [];
let lastOllamaModelCheck = 0;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/babel; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE_URL);

    if (url.pathname === "/api/health") return json(res, await health());
    if (url.pathname === "/api/chat" && req.method === "POST") return chat(req, res);
    if (url.pathname === "/api/system/media" && req.method === "POST") return mediaKey(req, res);
    if (url.pathname === "/api/spotify/login") return spotifyLogin(res);
    if (url.pathname === "/api/spotify/callback") return spotifyCallback(url, res);
    if (url.pathname === "/api/spotify/current") return spotifyCurrent(res);
    if (url.pathname === "/api/spotify/recent") return spotifyRecent(res);
    if (url.pathname === "/api/spotify/play" && req.method === "POST") return spotifyPlay(req, res);

    return serveStatic(url.pathname, res);
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Blue is living at ${BASE_URL}`);
  warmOllama().catch(() => {});
});

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(next) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
}

async function health() {
  const state = readState();
  const provider = process.env.BLUE_LLM_PROVIDER || "ollama";
  const ollama = provider === "ollama" ? await ollamaStatus() : { online: false, model: "" };
  return {
    ok: true,
    bridge: "local",
    llm: provider,
    llmOnline: provider === "local" ? true : ollama.online,
    ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    ollamaModel: ollama.model || process.env.OLLAMA_MODEL || "llama3.2:3b",
    ollamaModels: ollama.models || [],
    spotify: Boolean(state.spotify?.access_token || process.env.SPOTIFY_ACCESS_TOKEN),
    spotifyOAuth: Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    spotifyRedirectUri: spotifyRedirectUri(),
    mediaKeys: process.platform === "win32",
  };
}

async function chat(req, res) {
  const body = await readJson(req);
  const fallback = localBlueReply(body.message, body.context || {});
  const provider = (process.env.BLUE_LLM_PROVIDER || "ollama").toLowerCase();

  if (fallback.fast || provider === "local" || !shouldUseOllama(body.message || "")) return json(res, fallback);

  try {
    if (provider === "ollama") {
      const parsed = sanitizeBlueReply(await ollamaChat(body.message, body.context || {}, fallback), fallback);
      return json(res, { ...fallback, ...parsed, ok: true, provider: "ollama" });
    }

    return json(res, { ...fallback, warning: `Unknown BLUE_LLM_PROVIDER "${provider}", using local rules.` });
  } catch (error) {
    json(res, { ...fallback, ok: true, provider: "local", warning: `Ollama unavailable: ${error.message}` });
  }
}

async function ollamaChat(message = "", context = {}, fallback = {}) {
  const model = await resolveOllamaModel();
  const compactContext = compactBlueContext(context);
  const prompt = [
    "You are Blue, Ayush's local music agent. Be natural, brief, warm.",
    "Casual chat gets casual replies. Music requests get recommendations. Play only when clearly asked.",
    "Return JSON only.",
    "Schema: {\"reply\":\"string\",\"mood\":\"Electric|Chill|Focused|Late Night|Reflective|Calm\",\"action\":\"chat|recommend|play|pause|next\",\"playQuery\":\"string\",\"track\":{\"title\":\"string\",\"artist\":\"string\",\"genre\":\"string\",\"mood\":\"string\",\"query\":\"string\"}}",
    `Recommendation: ${JSON.stringify(fallback.track || {})}`,
    `Context: ${JSON.stringify(compactContext)}`,
    `Ayush said: ${message}`,
  ].join("\n");

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
      messages: [
        {
          role: "system",
          content: "You are Blue. Always return valid compact JSON matching the requested schema.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      options: {
        temperature: Number(process.env.OLLAMA_TEMPERATURE || 0.55),
        num_ctx: Number(process.env.OLLAMA_NUM_CTX || 1024),
        num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 140),
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Ollama request failed with ${response.status}`);
  const content = data.message?.content || "";
  return parseModelJson(content);
}

async function ollamaStatus() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Ollama tags failed");
    const models = (data.models || []).map((model) => model.name || model.model).filter(Boolean);
    cachedOllamaModels = models;
    cachedOllamaModel = chooseOllamaModel(models);
    lastOllamaModelCheck = Date.now();
    return {
      online: true,
      models,
      model: cachedOllamaModel,
    };
  } catch {
    return { online: false, models: [], model: "" };
  }
}

async function resolveOllamaModel() {
  const preferred = process.env.OLLAMA_MODEL;
  if (cachedOllamaModel && Date.now() - lastOllamaModelCheck < 60_000) return cachedOllamaModel;

  const response = await fetch(`${OLLAMA_URL}/api/tags`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not list Ollama models.");
  const models = (data.models || []).map((model) => model.name || model.model).filter(Boolean);
  if (!models.length) throw new Error("No Ollama models are installed. Pull llama3.2:3b first.");
  cachedOllamaModels = models;
  cachedOllamaModel = preferred && models.includes(preferred) ? preferred : chooseOllamaModel(models);
  lastOllamaModelCheck = Date.now();
  return cachedOllamaModel;
}

async function warmOllama() {
  if ((process.env.BLUE_LLM_PROVIDER || "ollama").toLowerCase() !== "ollama") return;
  const model = await resolveOllamaModel();
  await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "Blue ready.",
      stream: false,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
      options: { num_predict: 1 },
    }),
  }).catch(() => {});
}

function compactBlueContext(context = {}) {
  return {
    mood: context.mood,
    currentTrack: context.currentTrack
      ? {
          title: context.currentTrack.title,
          artist: context.currentTrack.artist,
          mood: context.currentTrack.mood,
        }
      : null,
    topGenre: context.topGenre,
    topArtist: context.topArtist,
    recent: Array.isArray(context.recent)
      ? context.recent.slice(0, 4).map((track) => ({
          title: track.title,
          artist: track.artist,
          mood: track.mood,
        }))
      : [],
  };
}

function chooseOllamaModel(models) {
  const preferredOrder = [
    process.env.OLLAMA_MODEL,
    "llama3.2:3b",
    "qwen2.5:7b",
    "llama3.1:8b",
    "mistral",
  ].filter(Boolean);
  return preferredOrder.find((model) => models.includes(model)) || models[0] || "";
}

function localBlueReply(message = "", context = {}) {
  const text = message.toLowerCase();
  const mood = inferMood(text) || context.mood || "Electric";
  const rec = context.recommendation || {};
  const wantsPlay = /\b(play|start|put on|queue)\b/.test(text);
  const wantsNext = /\b(next|skip)\b/.test(text);
  const wantsRecommendation = /\b(recommend|suggest|song|music|hear|listen|vibe|mood|track)\b/.test(text);
  const greeting = /\b(hey|hi|hello|yo|sup|how are you|what's up|whats up)\b/.test(text);
  const casual = /^(hey|hi|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|yes|no|hmm|who are you|what can you do|can you talk|talk normally)[\s?.!]*$/i.test(message.trim());
  const playQuery = extractPlayQuery(message) || rec.query || `${rec.title || "Sweet Child O' Mine"} ${rec.artist || "Guns N' Roses"}`;

  if (wantsNext) {
    return {
      ok: true,
      provider: "local",
      reply: "Got it. I will move to the next track and keep reading the room.",
      mood,
      action: "next",
      playQuery,
      fast: true,
    };
  }

  if (wantsPlay) {
    return {
      ok: true,
      provider: "local",
      reply: `Yes. I am playing ${playQuery} and logging it to your real listening dashboard.`,
      mood,
      action: "play",
      playQuery,
      track: { title: playQuery, artist: "Requested by Ayush", mood, query: playQuery },
      fast: true,
    };
  }

  if (greeting && !wantsRecommendation) {
    return {
      ok: true,
      provider: "local",
      reply: "Hey Ayush, I am here. Tell me your mood, or just say the kind of energy you want and I will shape the next track around it.",
      mood,
      action: "chat",
      playQuery: "",
      track: rec,
      fast: true,
    };
  }

  if (casual || !wantsRecommendation) {
    return {
      ok: true,
      provider: "local",
      reply: casualBlueReply(text, mood),
      mood,
      action: "chat",
      playQuery: "",
      track: rec,
      fast: true,
    };
  }

  return {
    ok: true,
    provider: "local",
    reply: recommendationReply(mood, rec),
    mood,
    action: "recommend",
    playQuery,
    track: rec,
    fast: true,
  };
}

function shouldUseOllama(message = "") {
  const text = message.toLowerCase();
  if (/\b(play|start|put on|queue|next|skip|pause|recommend|suggest|song|music|hear|listen|vibe|mood|track)\b/.test(text)) return false;
  if (/^(hey|hi|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|yes|no|hmm)[\s?.!]*$/i.test(message.trim())) return false;
  return /\b(why|explain|compare|tell me about|who is|what is|thoughts|meaning|history|album|artist|genre)\b/.test(text);
}

function recommendationReply(mood, rec = {}) {
  const title = rec.title || "Sweet Child O' Mine";
  const artist = rec.artist ? ` by ${rec.artist}` : "";
  const lines = [
    `${mood} mode fits ${title}${artist}. Want me to put it on next?`,
    `I would go with ${title}${artist} for this vibe. Should I play it?`,
    `For ${mood.toLowerCase()}, ${title}${artist} feels right. Want that next?`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

function sanitizeBlueReply(reply = {}, fallback = {}) {
  const allowedMoods = new Set(["Electric", "Chill", "Focused", "Late Night", "Reflective", "Calm"]);
  const allowedActions = new Set(["chat", "recommend", "play", "pause", "next"]);
  return {
    ...reply,
    mood: allowedMoods.has(reply.mood) ? reply.mood : fallback.mood || "Electric",
    action: allowedActions.has(reply.action) ? reply.action : fallback.action || "chat",
    reply: reply.reply || fallback.reply || "I am here, Ayush. What should we listen to?",
    playQuery: reply.playQuery || fallback.playQuery || "",
    track: reply.track || fallback.track || {},
  };
}

function casualBlueReply(text, mood) {
  if (/how are you/.test(text)) return "I am good, Ayush. Awake, local, and ready to talk music. What are you feeling right now?";
  if (/who are you|what can you do/.test(text)) return "I am Blue, your local music agent. I can chat, read your mood, suggest songs, and help control playback.";
  if (/talk normally|can you talk/.test(text)) return "Yeah, I can. We do not have to jump into recommendations every time. Tell me what kind of day it has been.";
  if (/thanks|thank you/.test(text)) return "Anytime. I am here when you want music or just a quick vibe check.";
  if (/^(yes|ok|okay|cool|nice)/.test(text)) return "Got you. Want me to keep it chill or bring the energy up?";
  if (/^(no|hmm)/.test(text)) return "No problem. We can slow down. What do you actually feel like hearing?";
  return `Hey Ayush. I am here. Current vibe is ${mood.toLowerCase()}, but we can change it. What kind of energy do you want?`;
}

function inferMood(text) {
  if (/rock|guitar|hype|gym|party|electric|drive/.test(text)) return "Electric";
  if (/night|dark|late/.test(text)) return "Late Night";
  if (/focus|study|work|code/.test(text)) return "Focused";
  if (/sad|deep|miss|think|emotional|reflect/.test(text)) return "Reflective";
  if (/calm|peace|quiet|slow/.test(text)) return "Calm";
  if (/chill|relax|soft/.test(text)) return "Chill";
  return "";
}

function extractPlayQuery(message) {
  const match = message.match(/\b(?:play|start|put on|queue)\s+(.+)$/i);
  return match?.[1]?.replace(/[?.!]+$/, "").trim();
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Ollama did not return JSON.");
    return JSON.parse(match[0]);
  }
}

async function mediaKey(req, res) {
  const { action } = await readJson(req);
  const keys = { next: 0xb0, previous: 0xb1, playpause: 0xb3, pause: 0xb3 };
  const key = keys[action];
  if (!key) return json(res, { ok: false, error: "Unknown media action." }, 400);
  if (process.platform !== "win32") return json(res, { ok: false, error: "Media key bridge is Windows-only right now." }, 501);

  const command = [
    "$sig='[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);';",
    "$type=Add-Type -MemberDefinition $sig -Name Win32Keyboard -Namespace Blue -PassThru;",
    `$type::keybd_event(${key},0,0,[UIntPtr]::Zero);`,
    `$type::keybd_event(${key},0,2,[UIntPtr]::Zero);`,
  ].join(" ");

  execFile("powershell", ["-NoProfile", "-Command", command], { windowsHide: true }, (error) => {
    json(res, { ok: !error, error: error?.message });
  });
}

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
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error?.message || `Spotify ${response.status}`);
  return data;
}

async function spotifyCurrent(res) {
  try {
    const data = await spotifyFetch("/me/player/currently-playing");
    if (!data?.item) return json(res, { ok: true, track: null });
    const genres = await spotifyGenres([data.item]);
    json(res, { ok: true, isPlaying: data.is_playing, track: normalizeSpotifyTrack(data.item, genres) });
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
  try {
    const { query, uri } = await readJson(req);
    let trackUri = uri;
    let track = null;
    if (!trackUri) {
      const search = await spotifyFetch(`/search?type=track&limit=1&q=${encodeURIComponent(query || "")}`);
      const item = search.tracks?.items?.[0];
      if (!item) return json(res, { ok: false, error: "No Spotify track found." }, 404);
      trackUri = item.uri;
      const genres = await spotifyGenres([item]);
      track = normalizeSpotifyTrack(item, genres);
    }
    await spotifyFetch("/me/player/play", {
      method: "PUT",
      body: JSON.stringify({ uris: [trackUri] }),
    });
    json(res, { ok: true, track });
  } catch (error) {
    json(res, { ok: false, error: error.message }, 501);
  }
}

async function spotifyGenres(tracks) {
  const ids = [...new Set(tracks.flatMap((track) => track?.artists || []).map((artist) => artist.id).filter(Boolean))].slice(0, 50);
  if (!ids.length) return {};
  try {
    const data = await spotifyFetch(`/artists?ids=${ids.join(",")}`);
    return Object.fromEntries((data.artists || []).map((artist) => [artist.id, artist.genres?.[0] || "Unknown"]));
  } catch {
    return {};
  }
}

function normalizeSpotifyTrack(track, genres = {}) {
  const firstArtist = track.artists?.[0];
  const genre = firstArtist ? genres[firstArtist.id] || "Unknown" : "Unknown";
  return {
    id: track.id,
    title: track.name,
    artist: (track.artists || []).map((artist) => artist.name).join(", "),
    band: firstArtist?.name || "",
    genre,
    mood: inferMood(`${track.name} ${genre}`) || "Chill",
    query: `${track.name} ${(track.artists || []).map((artist) => artist.name).join(" ")}`,
    uri: track.uri,
    album: track.album?.name || "",
    playedAt: new Date().toISOString(),
  };
}

function serveStatic(urlPath, res) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const target = clean === "/" ? "/index.html" : clean;
  const filePath = path.resolve(ROOT, `.${target}`);
  if (!filePath.startsWith(ROOT)) return text(res, "Forbidden", 403);
  fs.readFile(filePath, (error, data) => {
    if (error) return text(res, "Not found", 404);
    const type = contentTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  });
}

function readJson(req) {
  return readText(req).then((body) => (body ? JSON.parse(body) : {}));
}

function readText(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function text(res, message, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function html(res, message, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body style="font-family:sans-serif">${message}</body></html>`);
}

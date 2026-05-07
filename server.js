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

    // ── Existing endpoints (preserved) ───────────────────────────────────
    if (url.pathname === "/api/health") return json(res, await health());
    if (url.pathname === "/api/chat" && req.method === "POST") return chat(req, res);
    if (url.pathname === "/api/system/media" && req.method === "POST") return mediaKey(req, res);
    if (url.pathname === "/api/spotify/login") return spotifyLogin(res);
    if (url.pathname === "/api/spotify/callback") return spotifyCallback(url, res);
    if (url.pathname === "/api/spotify/current") return spotifyCurrent(res);
    if (url.pathname === "/api/spotify/recent") return spotifyRecent(res);
    if (url.pathname === "/api/spotify/play" && req.method === "POST") return spotifyPlay(req, res);
    if (url.pathname === "/api/lyrics") return lyrics(url, res);

    // ── New endpoints ─────────────────────────────────────────────────────
    // Streaming chat with optional tool-calling agent loop
    if (url.pathname === "/api/chat/stream" && req.method === "POST") return chatStream(req, res);

    // Unified multi-provider music control
    if (url.pathname === "/api/music/providers") return json(res, await musicProviderStatuses());
    if (url.pathname === "/api/music/play"     && req.method === "POST") return musicPlay(req, res);
    if (url.pathname === "/api/music/search")   return musicSearch(url, res);
    if (url.pathname === "/api/music/queue"    && req.method === "POST") return musicQueue(req, res);
    if (url.pathname === "/api/music/transfer" && req.method === "POST") return musicTransfer(req, res);
    if (url.pathname === "/api/music/identify") return musicIdentify(url, res);

    // YouTube — primary alternative provider for in-browser playback
    if (url.pathname === "/api/youtube/search")  return youtubeSearchEndpoint(url, res);
    if (url.pathname === "/api/youtube/resolve") return youtubeResolveEndpoint(url, res);

    // Spotify — extended endpoints (queue / devices / audio-features / transfer)
    if (url.pathname === "/api/spotify/devices") return spotifyDevices(res);
    if (url.pathname === "/api/spotify/queue"   && req.method === "POST") return spotifyQueueEndpoint(req, res);
    if (url.pathname === "/api/spotify/transfer"&& req.method === "POST") return spotifyTransferEndpoint(req, res);
    if (url.pathname === "/api/spotify/features") return spotifyFeaturesEndpoint(url, res);
    if (url.pathname === "/api/spotify/search")  return spotifySearchEndpoint(url, res);

    // Apple MusicKit developer-token endpoint (only active when MusicKit creds present)
    if (url.pathname === "/api/apple/developer-token") return appleDeveloperTokenEndpoint(res);

    // Conversation memory — read / clear short-term context
    if (url.pathname === "/api/memory" && req.method === "GET")    return json(res, readMemory());
    if (url.pathname === "/api/memory" && req.method === "DELETE") { writeMemory({ summary: "", recent: [] }); return json(res, { ok: true }); }

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
  const appleReady = Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
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
    // ── New ──
    streaming:    true,
    youtube:      true, // always available — IFrame Player needs no key
    youtubeKeyed: Boolean(process.env.YOUTUBE_API_KEY),
    apple:        appleReady,
    appleSetupRequired: !appleReady,
    providers: {
      spotify: Boolean(state.spotify?.access_token || process.env.SPOTIFY_ACCESS_TOKEN),
      youtube: true,
      apple:   appleReady,
    },
  };
}

async function chat(req, res) {
  const body = await readJson(req);
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const fallback = localBlueReply(body.message, body.context || {}, history);
  const provider = (process.env.BLUE_LLM_PROVIDER || "ollama").toLowerCase();

  if (fallback.fast || provider === "local" || !shouldUseOllama(body.message || "")) return json(res, fallback);

  try {
    if (provider === "ollama") {
      const parsed = sanitizeBlueReply(await ollamaChat(body.message, body.context || {}, fallback, history), fallback);
      return json(res, { ...fallback, ...parsed, ok: true, provider: "ollama" });
    }

    return json(res, { ...fallback, warning: `Unknown BLUE_LLM_PROVIDER "${provider}", using local rules.` });
  } catch (error) {
    json(res, { ...fallback, ok: true, provider: "local", warning: `Ollama unavailable: ${error.message}` });
  }
}

async function ollamaChat(message = "", context = {}, fallback = {}, history = []) {
  const model = await resolveOllamaModel();
  const compactContext = compactBlueContext(context);

  const systemPrompt = [
    "You are Blue — Ayush's personal music agent. You talk like a thoughtful friend who happens to know music inside-out.",
    "Voice rules:",
    "- Sound human. Use contractions (I'm, you're, that's). Vary sentence length. Drop fillers like 'so', 'yeah', 'honestly' sparingly so it feels real.",
    "- Avoid robotic phrases like 'I am here', 'I am Blue', 'I will'. Use 'I'm', 'I'll', 'let me'.",
    "- Don't over-use Ayush's name; once every few replies is plenty.",
    "- Track the conversation. Reference what was just said when it fits. Don't repeat your last reply's structure.",
    "- Casual chat → casual short reply, no music push. Music questions → opinionated, specific. Play only when clearly asked.",
    "- Keep replies under two short sentences unless the user asked for depth.",
    "Return JSON ONLY. Schema:",
    '{"reply":"string","mood":"Electric|Chill|Focused|Late Night|Reflective|Calm","action":"chat|recommend|play|pause|next","playQuery":"string","track":{"title":"string","artist":"string","genre":"string","mood":"string","query":"string"}}',
  ].join("\n");

  const userPrompt = [
    `Suggested fallback track: ${JSON.stringify(fallback.track || {})}`,
    `Listening context: ${JSON.stringify(compactContext)}`,
    `Latest message: ${message}`,
  ].join("\n");

  const messages = [{ role: "system", content: systemPrompt }];
  for (const item of history) {
    if (!item || !item.text) continue;
    if (item.role === "user") messages.push({ role: "user", content: String(item.text).slice(0, 400) });
    else if (item.role === "blue") messages.push({ role: "assistant", content: JSON.stringify({ reply: String(item.text).slice(0, 400) }) });
  }
  messages.push({ role: "user", content: userPrompt });

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
      messages,
      options: {
        temperature: Number(process.env.OLLAMA_TEMPERATURE || 0.7),
        num_ctx: Number(process.env.OLLAMA_NUM_CTX || 1536),
        num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 160),
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

function localBlueReply(message = "", context = {}, history = []) {
  const trimmed = String(message || "").trim();
  const text = trimmed.toLowerCase();
  const mood = inferMood(text) || context.mood || "Electric";
  const rec = context.recommendation || {};
  const current = context.currentTrack || null;

  const wantsNext = /\b(next|skip|another one|something else)\b/.test(text);
  const wantsPause = /\b(pause|stop|hold)\b/.test(text);
  const wantsPlay = /\b(play|start|put on|queue|spin|throw on|hit)\b/.test(text);
  const playsCurrent = /\b(this( one|song| track)?|that( one|song| track)?|it)\b/.test(text);
  const wantsRecommendation = /\b(recommend|suggest|song|music|hear|listen|vibe|mood|track|something)\b/.test(text);
  const greeting = /^(hey|hi|hello|yo|sup|good (morning|evening|night)|howdy)\b/.test(text);
  const purelyCasual = /^(hey|hi|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|yes|yeah|yep|no|nope|hmm|who are you|what can you do|can you talk|talk normally|how are you|sure|alright|got it)[\s?.!]*$/i.test(trimmed);

  const playQuery =
    extractPlayQuery(message) ||
    (playsCurrent && current ? current.query || `${current.title} ${current.artist}` : "") ||
    rec.query ||
    (rec.title ? `${rec.title} ${rec.artist || ""}`.trim() : "");

  const lastBlue = [...history].reverse().find((m) => m && m.role === "blue")?.text || "";

  if (wantsNext) {
    return {
      ok: true,
      provider: "local",
      reply: pickReply([
        "Skipping ahead — let's see what lands better.",
        "On it. Pulling the next one.",
        "Got it, moving on.",
        "Cool, next track coming up.",
      ], lastBlue),
      mood,
      action: "next",
      playQuery,
      fast: true,
    };
  }

  if (wantsPause) {
    return {
      ok: true,
      provider: "local",
      reply: pickReply([
        "Paused. Ping me when you want it back.",
        "On pause. Take your time.",
        "Held it right there.",
      ], lastBlue),
      mood,
      action: "pause",
      playQuery: "",
      fast: true,
    };
  }

  if (wantsPlay) {
    const userPhrase = extractPlayQuery(message);
    const parsed = parsePlayPhrase(userPhrase);
    const target = userPhrase
      || (playsCurrent && current ? current.query || `${current.title} ${current.artist}` : "")
      || rec.query
      || (rec.title ? `${rec.title} ${rec.artist || ""}`.trim() : "Sweet Child O' Mine Guns N' Roses");

    let sourceTrack;
    if (playsCurrent && current) {
      sourceTrack = current;
    } else if (parsed.title) {
      // User explicitly named a track (and maybe an artist) — never bleed in
      // the recommendation's artist. That's what produced "Smells Like Teen
      // Spirit by Nirvana by Guns N' Roses".
      sourceTrack = {
        title: parsed.title,
        artist: parsed.artist || "",
        mood,
        query: target,
        genre: "Unknown",
      };
    } else {
      sourceTrack = {
        title: rec.title,
        artist: rec.artist || "",
        mood,
        query: target,
        genre: rec.genre || "Unknown",
      };
    }

    return {
      ok: true,
      provider: "local",
      reply: pickReply([
        `Putting on ${niceTitle(sourceTrack)} now.`,
        `Spinning ${niceTitle(sourceTrack)} for you.`,
        `Cool — ${niceTitle(sourceTrack)} coming through.`,
        `Done. ${niceTitle(sourceTrack)} is up.`,
      ], lastBlue),
      mood,
      action: "play",
      playQuery: target,
      track: sourceTrack,
      fast: true,
    };
  }

  if (greeting && !wantsRecommendation) {
    return {
      ok: true,
      provider: "local",
      reply: pickReply([
        "Hey. What's the energy today?",
        "Hey hey. Talk to me — what kind of day is it?",
        "Hi. What are you in the mood for?",
        "Yo. Want me to read the room or just chat?",
      ], lastBlue),
      mood,
      action: "chat",
      playQuery: "",
      track: rec,
      fast: true,
    };
  }

  if (purelyCasual || !wantsRecommendation) {
    return {
      ok: true,
      provider: "local",
      reply: casualBlueReply(text, mood, lastBlue),
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
    reply: recommendationReply(mood, rec, lastBlue),
    mood,
    action: "recommend",
    playQuery,
    track: rec,
    fast: true,
  };
}

function shouldUseOllama(message = "") {
  const text = message.toLowerCase().trim();
  if (!text) return false;
  if (/\b(play|start|put on|queue|next|skip|pause|stop)\b/.test(text)) return false;
  if (/^(hey|hi|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|yes|yeah|yep|no|nope|hmm|sure|alright|got it)[\s?.!]*$/i.test(text)) return false;
  // Anything reasonably substantive routes through the LLM for richer dialogue
  return text.length > 6;
}

function recommendationReply(mood, rec = {}, lastBlue = "") {
  const title = rec.title || "Sweet Child O' Mine";
  const artist = rec.artist ? ` by ${rec.artist}` : "";
  const moodLow = mood.toLowerCase();
  const lines = [
    `${title}${artist} — pretty solid for ${moodLow} energy. Want it on?`,
    `If you're going ${moodLow}, I'd put on ${title}${artist}. Say the word.`,
    `${title}${artist} has the right shape for this. Should I spin it?`,
    `Try ${title}${artist}. It fits where your head's at. Play it?`,
    `My pick: ${title}${artist}. Fits ${moodLow} without trying too hard.`,
  ];
  return pickReply(lines, lastBlue);
}

function pickReply(options, lastBlue = "") {
  if (!options.length) return "";
  const filtered = lastBlue ? options.filter((line) => !sharesOpening(line, lastBlue)) : options;
  const pool = filtered.length ? filtered : options;
  return pool[Math.floor(Math.random() * pool.length)];
}

function sharesOpening(a = "", b = "") {
  const head = (s) => String(s).trim().toLowerCase().split(/\s+/).slice(0, 3).join(" ");
  return head(a) === head(b);
}

function niceTitle(track = {}) {
  if (track.title && track.artist) return `${track.title} by ${track.artist}`;
  if (track.title) return track.title;
  if (track.query) return track.query;
  return "the track";
}

// Splits "Smells Like Teen Spirit by Nirvana" → { title, artist }.
// Also handles a trailing " - Artist" form. If neither matches, the whole
// phrase is treated as the title and the artist is left blank.
function parsePlayPhrase(phrase = "") {
  const s = String(phrase || "").trim();
  if (!s) return { title: "", artist: "" };
  let m = s.match(/^(.+?)\s+by\s+(.+)$/i);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };
  m = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };
  return { title: s, artist: "" };
}

function friendlySpotifyError(msg = "") {
  const m = String(msg || "").toLowerCase();
  if (/no.*active.*device|player command failed: no active device|device not found/.test(m))
    return "No Spotify device is online — open Spotify on any device, then try again. I'll run a preview here in the meantime.";
  if (/premium/.test(m))
    return "Spotify needs Premium for full playback control. I'll fall back to a 30-second preview where I can.";
  if (/restrict/.test(m))
    return "Spotify says playback is restricted right now. Try pressing play once in the Spotify app, then ask me again.";
  if (/(401|expired|token|unauthorized)/.test(m))
    return "Spotify session expired. Hit Connect Spotify up top to refresh it.";
  if (/rate limit|429/.test(m))
    return "Spotify is rate-limiting us for a moment. Give it a few seconds and try again.";
  return msg || "Could not start Spotify playback.";
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

function casualBlueReply(text, mood, lastBlue = "") {
  const moodLow = mood.toLowerCase();
  if (/how are you|how's it going|hows it going|you good/.test(text))
    return pickReply([
      "I'm good. Just sitting here picking through your taste. You?",
      "Doing fine. Caffeinated in spirit. How about you?",
      "All good on my side. What's the day been like?",
    ], lastBlue);
  if (/who are you|what can you do|what do you do/.test(text))
    return pickReply([
      "I'm Blue — I read your mood, talk music with you, and run playback when you want it.",
      "Blue. Your music brain. I chat, I recommend, I press play.",
    ], lastBlue);
  if (/talk normally|can you talk|just chat|just talk/.test(text))
    return pickReply([
      "Yeah, we can just talk. No music push. What's on your mind?",
      "Sure, let's keep it casual. How's your head today?",
    ], lastBlue);
  if (/thanks|thank you|appreciate/.test(text))
    return pickReply([
      "Anytime.",
      "You got it.",
      "No worries — say the word when you want more.",
    ], lastBlue);
  if (/^(yes|yeah|yep|ok|okay|cool|nice|sure|alright|got it)/.test(text))
    return pickReply([
      "Cool. Want me to keep this lane or shift the energy?",
      "Nice. Stay here or push it somewhere new?",
      "Good — keep going or change it up?",
    ], lastBlue);
  if (/^(no|nope|hmm|nah)/.test(text))
    return pickReply([
      "All good. Tell me what's actually pulling you right now.",
      "Fair. What would feel right instead?",
      "Okay — what's the move then?",
    ], lastBlue);
  if (/bored|tired|stressed|anxious|sad/.test(text))
    return pickReply([
      "Got it. Want me to find something soft, or pull you somewhere else entirely?",
      "Hear you. Quiet and slow, or something to break out of it?",
    ], lastBlue);
  return pickReply([
    `Vibe right now reads ${moodLow}. Want to roll with that or pivot?`,
    `I'm reading ${moodLow}. Stay in it or change lanes?`,
    "Talk to me — what's the energy?",
    "What kind of sound feels right this minute?",
  ], lastBlue);
}

function inferMood(text) {
  const v = String(text || "").toLowerCase();
  if (/rock|guitar|hype|gym|party|electric|drive|punch|loud|metal|rage/.test(v)) return "Electric";
  if (/night|dark|late|midnight|2am|3am|after.?hours/.test(v)) return "Late Night";
  if (/focus|study|work|code|deep work|lock in|grind/.test(v)) return "Focused";
  if (/sad|deep|miss|think|emotional|reflect|nostalg|melanchol|alone/.test(v)) return "Reflective";
  if (/calm|peace|quiet|slow|sufi|ambient|meditat/.test(v)) return "Calm";
  if (/chill|relax|soft|easy|lo[\s-]?fi|coffee/.test(v)) return "Chill";
  return "";
}

// ── Genre normalization ───────────────────────────────────────────────────
// Order matters: more specific buckets first so "indie rock" lands in Indie
// (not Rock), "k-pop" in K-Pop (not Pop), etc.
const GENRE_BUCKETS = [
  ["Hip-Hop",   /\b(hip[\s-]?hop|rap|trap|drill|grime|boom bap)\b/],
  ["Bollywood", /\b(bollywood|filmi|hindi|desi|punjabi|bhangra|mumbai)\b/],
  ["Sufi",      /\b(sufi|qawwali|ghazal|nasheed)\b/],
  ["K-Pop",     /\bk[\s-]?pop\b/],
  ["J-Pop",     /\bj[\s-]?pop\b/],
  ["Latin",     /\b(reggaeton|salsa|latin|bachata|cumbia|samba|mariachi|bossa nova)\b/],
  ["Reggae",    /\b(reggae|dub|ska|dancehall)\b/],
  ["Metal",     /\b(metal|metalcore|deathcore|djent)\b/],
  ["Punk",      /\b(punk|hardcore|emo|screamo)\b/],
  ["R&B",       /\b(r&b|rnb|soul|neo[\s-]?soul|funk|motown)\b/],
  ["Electronic",/\b(edm|house|techno|dubstep|trance|electronic|electronica|drum and bass|dnb|garage|breakbeat|idm|future bass|big room|electro|synthwave)\b/],
  ["Jazz",      /\b(jazz|bebop|swing|bossa|fusion)\b/],
  ["Classical", /\b(classical|opera|baroque|orchestra|symphony|chamber)\b/],
  ["Country",   /\b(country|honky tonk|nashville)\b/],
  ["Folk",      /\b(folk|americana|bluegrass|singer[\s-]?songwriter)\b/],
  ["Indie",     /\b(indie|bedroom pop|lo[\s-]?fi|chillwave|dream pop|shoegaze|slacker)\b/],
  ["Pop",       /\b(pop|disco|new wave|boy band|girl group|teen)\b/],
  ["Rock",      /\b(rock|grunge|britpop|post[\s-]?rock|psych|garage rock|stoner|alt|alternative)\b/],
];

function normalizeGenre(raw) {
  if (!raw) return "Unknown";
  const lower = String(raw).toLowerCase();
  for (const [bucket, re] of GENRE_BUCKETS) {
    if (re.test(lower)) return bucket;
  }
  return "Other";
}

function pickArtistGenre(genres = []) {
  if (!genres.length) return "Unknown";
  const counts = {};
  for (const raw of genres) {
    const bucket = normalizeGenre(raw);
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  const realKeys = Object.keys(counts).filter((k) => k !== "Unknown" && k !== "Other");
  const winner = (realKeys.length ? realKeys : Object.keys(counts))
    .sort((a, b) => counts[b] - counts[a])[0];
  return winner || "Unknown";
}

function inferGenreFromText(text = "") {
  const v = text.toLowerCase();
  if (/rahman|arijit|atif|bollywood|hindi/.test(v)) return "Bollywood";
  if (/qawwali|sufi|nusrat/.test(v))                return "Sufi";
  if (/arctic monkeys|tame impala|mac demarco|the strokes/.test(v)) return "Indie";
  if (/weeknd|dua lipa|taylor swift|harry styles|billie eilish/.test(v)) return "Pop";
  if (/kendrick|drake|travis scott|j cole|eminem|kanye/.test(v)) return "Hip-Hop";
  if (/fleetwood|guns n.? roses|led zeppelin|queen|nirvana|foo fighters/.test(v)) return "Rock";
  if (/daft punk|deadmau5|skrillex|calvin harris|tiesto/.test(v)) return "Electronic";
  return "Unknown";
}

function extractPlayQuery(message) {
  const match = String(message || "").match(/\b(?:play|start|put on|queue|spin|throw on|hit)\s+(.+)$/i);
  if (!match) return "";
  let phrase = match[1].replace(/[?.!]+$/, "").trim();
  // Strip filler that comes between the verb and the actual track:
  //   "play me X"        → "X"
  //   "play us some X"   → "X"
  //   "play me the song X" → "X"
  //   "play this song"   → ""  (referential — caller falls back to currentTrack)
  phrase = phrase
    .replace(/^(?:me|us)\s+/i, "")
    .replace(/^(?:some|a|an)\s+/i, "")
    .replace(/^(?:the\s+)?(?:song|track|tune)\s+(?:called\s+)?/i, "")
    .replace(/^(?:this|that|it|the)\s+(?:song|track|one|tune)\s*/i, "")
    .replace(/^(?:this|that|it)\s*$/i, "")
    .trim();
  return phrase;
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

// ── Lyrics (LRCLIB proxy + parser) ───────────────────────────────────────
// LRCLIB is a free, no-auth lyrics database with synced LRC timestamps for
// most popular tracks. We proxy through Blue's server so we can:
//   - cache by track to avoid re-fetching as the user replays / scrubs
//   - convert LRC to a clean { time, text } array for the client
//   - hide CORS / UA quirks behind a single shape
const LYRICS_CACHE = new Map();
const LYRICS_CACHE_MAX = 200;

async function lyrics(url, res) {
  try {
    const title    = (url.searchParams.get("title") || "").trim();
    const artist   = (url.searchParams.get("artist") || "").trim();
    const album    = (url.searchParams.get("album") || "").trim();
    const duration = Number(url.searchParams.get("duration")) || 0;

    if (!title || !artist) {
      return json(res, { ok: false, error: "title and artist are required.", synced: false, lines: [], plain: "" });
    }

    const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
    if (LYRICS_CACHE.has(key)) return json(res, LYRICS_CACHE.get(key));

    const headers = { "User-Agent": "Blue Music Agent (local, https://github.com)" };

    // Try the precise /api/get endpoint first (matches by title+artist+duration).
    const getParams = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album)    getParams.set("album_name", album);
    if (duration) getParams.set("duration",   String(Math.round(duration / 1000)));
    let result = null;
    try {
      const r = await fetch(`https://lrclib.net/api/get?${getParams}`, { headers });
      if (r.ok) {
        const data = await r.json();
        result = parseLyricsResult(data);
      }
    } catch {}

    // Fall back to /api/search if /api/get returned nothing usable.
    if (!result || (!result.lines.length && !result.plain)) {
      try {
        const sParams = new URLSearchParams({ track_name: title, artist_name: artist });
        const r = await fetch(`https://lrclib.net/api/search?${sParams}`, { headers });
        if (r.ok) {
          const arr = await r.json();
          const best = Array.isArray(arr) ? arr.find((x) => x.syncedLyrics) || arr[0] : null;
          if (best) result = parseLyricsResult(best);
        }
      } catch {}
    }

    const payload = result || { ok: true, synced: false, lines: [], plain: "" };
    payload.ok = true;
    payload.title  = title;
    payload.artist = artist;

    // Tiny LRU-ish cap so the cache doesn't grow forever.
    if (LYRICS_CACHE.size >= LYRICS_CACHE_MAX) {
      LYRICS_CACHE.delete(LYRICS_CACHE.keys().next().value);
    }
    LYRICS_CACHE.set(key, payload);
    json(res, payload);
  } catch (error) {
    json(res, { ok: false, error: error.message, synced: false, lines: [], plain: "" });
  }
}

function parseLyricsResult(data) {
  if (!data || typeof data !== "object") return { ok: true, synced: false, lines: [], plain: "" };
  if (data.syncedLyrics && typeof data.syncedLyrics === "string") {
    return { ok: true, synced: true, lines: parseLrc(data.syncedLyrics), plain: data.plainLyrics || "" };
  }
  if (data.plainLyrics && typeof data.plainLyrics === "string") {
    return { ok: true, synced: false, lines: [], plain: data.plainLyrics };
  }
  return { ok: true, synced: false, lines: [], plain: "" };
}

// Parse a standard LRC blob: lines like "[mm:ss.cc] words..." → { time(ms), text }.
// Also handles compound stamps "[00:12.45][00:48.90] same line" by emitting one
// entry per stamp. Empty/blank text becomes a "♪" so the line still renders.
function parseLrc(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const stamps = raw.match(/\[(\d+):(\d+)(?:[.:](\d{1,3}))?\]/g);
    if (!stamps) continue;
    const idx = raw.lastIndexOf("]");
    const body = (idx >= 0 ? raw.slice(idx + 1) : "").trim();
    for (const stamp of stamps) {
      const m = stamp.match(/\[(\d+):(\d+)(?:[.:](\d{1,3}))?\]/);
      if (!m) continue;
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(m[3].padEnd(3, "0").slice(0, 3)) : 0;
      const time = (min * 60 + sec) * 1000 + frac;
      out.push({ time, text: body });
    }
  }
  return out.sort((a, b) => a.time - b.time);
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

// ════════════════════════════════════════════════════════════════════════════
// CONVERSATION MEMORY
// Short-term rolling memory persisted across page reloads. We keep a tight
// "recent" window plus a compressed "summary" of older turns. The summary is
// fed back into the system prompt so Blue can recall what was discussed
// without paying full token cost.
// ════════════════════════════════════════════════════════════════════════════
const MEMORY_MAX_RECENT = 16;

function readMemory() {
  const state = readState();
  const m = state.memory || {};
  return {
    summary:       String(m.summary  || ""),
    recent:        Array.isArray(m.recent)        ? m.recent.slice(-MEMORY_MAX_RECENT) : [],
    preferredMood: m.preferredMood   || "",
    preferredProvider: m.preferredProvider || "",
    activeMood:    m.activeMood      || "",
  };
}

function writeMemory(next) {
  const state = readState();
  state.memory = {
    summary:       String(next.summary || "").slice(0, 1400),
    recent:        Array.isArray(next.recent) ? next.recent.slice(-MEMORY_MAX_RECENT) : [],
    preferredMood: next.preferredMood || "",
    preferredProvider: next.preferredProvider || "",
    activeMood:    next.activeMood    || "",
  };
  writeState(state);
  return state.memory;
}

function appendMemoryTurn(turn) {
  const memory = readMemory();
  memory.recent.push({
    role: turn.role,
    text: String(turn.text || "").slice(0, 600),
    at:   Date.now(),
  });
  if (memory.recent.length > MEMORY_MAX_RECENT) {
    const overflow = memory.recent.slice(0, memory.recent.length - MEMORY_MAX_RECENT);
    memory.recent  = memory.recent.slice(-MEMORY_MAX_RECENT);
    if (overflow.length) memory.summary = compactMemorySummary(memory.summary, overflow);
  }
  return writeMemory(memory);
}

function compactMemorySummary(prior, overflow) {
  const bullets = overflow
    .filter((t) => t && t.text)
    .map((t) => {
      const who  = t.role === "user" ? "User" : "Blue";
      const text = String(t.text).replace(/\s+/g, " ").trim().slice(0, 110);
      return `${who}: ${text}`;
    })
    .join(" | ");
  const next = (prior ? `${prior} | ` : "") + bullets;
  return next.slice(-1400);
}

// ════════════════════════════════════════════════════════════════════════════
// PROMPT CONSTRUCTION
// Blue's persona prompt + tool definitions live here so they can be reused
// across streaming and non-streaming paths.
// ════════════════════════════════════════════════════════════════════════════
function buildBlueSystemPrompt({ context = {}, memory = {}, allowTools = false } = {}) {
  const lines = [
    "You are Blue — Ayush's personal music agent and friendly conversational AI.",
    "Voice rules:",
    "- Sound like a thoughtful friend, not an assistant. Use contractions and vary sentence length.",
    "- Avoid robotic phrasing ('I am here to help', 'I will assist'). Use 'I'm', 'I'll', 'let me'.",
    "- Casual chat → casual short reply. No music push unless asked.",
    "- Music questions → opinionated, specific, concise.",
    "- Don't over-use Ayush's name.",
    "- Don't echo the user's question back; respond directly.",
    "- Topic isn't limited to music — chat about anything the user wants.",
    "- Track conversation context. Reference earlier turns naturally when relevant.",
    "- Default reply: one or two short sentences. Go longer only if depth is requested.",
  ];
  if (memory.summary) {
    lines.push("", `Earlier conversation summary: ${memory.summary}`);
  }
  if (context.mood) lines.push(`Current vibe reading: ${context.mood}.`);
  if (context.currentTrack?.title) {
    lines.push(`Currently playing: ${context.currentTrack.title}${context.currentTrack.artist ? ` by ${context.currentTrack.artist}` : ""}.`);
  }
  if (allowTools) {
    lines.push(
      "",
      "You have tools available. Use them to TAKE ACTIONS, not to answer questions about taste/opinion.",
      "Call play_track when the user wants something played. Call pause/next for transport. Call set_mood when the vibe shifts.",
      "Don't call tools for casual conversation.",
      "After tool execution, respond conversationally about what you did.",
    );
  } else {
    lines.push(
      "",
      "Return JSON ONLY. Schema:",
      '{"reply":"string","mood":"Electric|Chill|Focused|Late Night|Reflective|Calm","action":"chat|recommend|play|pause|next","playQuery":"string","provider":"auto|spotify|youtube|apple","track":{"title":"string","artist":"string","genre":"string","mood":"string","query":"string"}}',
    );
  }
  return lines.join("\n");
}

function buildBlueUserPrompt({ message, fallback, context }) {
  return [
    `Suggested fallback track: ${JSON.stringify(fallback?.track || {})}`,
    `Listening context: ${JSON.stringify(context || {})}`,
    `Latest message: ${message || ""}`,
  ].join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// STREAMING CHAT (SSE)
// Keeps full backward compat with /api/chat. Token-level streaming uses
// Ollama's stream:true + format:json. We extract the live value of the
// "reply" field from the partial JSON buffer and emit deltas. The frontend
// can speak each sentence as it completes.
// ════════════════════════════════════════════════════════════════════════════
async function chatStream(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const message = String(body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const context = body.context || {};

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": stream open\n\n");

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  // Always record the user turn in memory up-front
  if (message) appendMemoryTurn({ role: "user", text: message });

  const fallback = localBlueReply(message, context, history);
  const provider = (process.env.BLUE_LLM_PROVIDER || "ollama").toLowerCase();
  // Only short-circuit to local when the message is genuinely fast-path:
  // direct transport commands (play/pause/next) and short greetings/casuals.
  // Anything substantive — including music recommendations or open-ended
  // chat — should route through Ollama for richer, less-repetitive replies.
  const transportAction = fallback.fast && ["play", "pause", "next"].includes(fallback.action);
  const tinyGreeting    = fallback.fast && fallback.action === "chat" && message.length <= 18;
  const useLocal = provider === "local"
    || !shouldUseOllama(message)
    || transportAction
    || tinyGreeting;

  if (useLocal) {
    send("meta", { provider: "local", streaming: true });
    await streamWordsTo(send, fallback.reply || "");
    appendMemoryTurn({ role: "blue", text: fallback.reply || "" });
    send("done", { ...fallback, ok: true });
    res.end();
    return;
  }

  let streamedReply = "";
  let metaSent = false;
  try {
    const model = await resolveOllamaModel();
    const memory = readMemory();
    const compactContext = compactBlueContext(context);
    const systemPrompt = buildBlueSystemPrompt({ context: compactContext, memory });
    const userPrompt   = buildBlueUserPrompt({ message, fallback, context: compactContext });

    send("meta", { provider: "ollama", model, streaming: true });
    metaSent = true;

    const messages = [{ role: "system", content: systemPrompt }];
    for (const item of history) {
      if (!item || !item.text) continue;
      if (item.role === "user") messages.push({ role: "user", content: String(item.text).slice(0, 400) });
      else if (item.role === "blue") messages.push({ role: "assistant", content: JSON.stringify({ reply: String(item.text).slice(0, 400) }) });
    }
    messages.push({ role: "user", content: userPrompt });

    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        format: "json",
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
        messages,
        options: {
          temperature: Number(process.env.OLLAMA_TEMPERATURE || 0.7),
          num_ctx:     Number(process.env.OLLAMA_NUM_CTX     || 2048),
          num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 240),
        },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => "");
      throw new Error(`Ollama ${upstream.status}: ${txt.slice(0, 160)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let jsonContent = "";

    for await (const chunk of upstream.body) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt = null;
        try { evt = JSON.parse(trimmed); } catch { continue; }
        if (!evt) continue;
        const piece = evt.message?.content || evt.response || "";
        if (piece) {
          jsonContent += piece;
          const replyNow = extractReplyField(jsonContent);
          if (replyNow !== null && replyNow.length > streamedReply.length) {
            const delta = replyNow.slice(streamedReply.length);
            send("token", { text: delta });
            streamedReply = replyNow;
          }
        }
        if (evt.done) {
          let parsed;
          try { parsed = parseModelJson(jsonContent); } catch { parsed = {}; }
          const sanitized = sanitizeBlueReply(parsed, fallback);
          if (sanitized.reply && sanitized.reply.length > streamedReply.length) {
            send("token", { text: sanitized.reply.slice(streamedReply.length) });
            streamedReply = sanitized.reply;
          }
          appendMemoryTurn({ role: "blue", text: sanitized.reply || "" });
          send("done", { ...fallback, ...sanitized, ok: true, provider: "ollama" });
          res.end();
          return;
        }
      }
    }

    // Stream ended without explicit done — flush whatever we have
    let parsed;
    try { parsed = parseModelJson(jsonContent); } catch { parsed = {}; }
    const sanitized = sanitizeBlueReply(parsed, fallback);
    if (sanitized.reply && sanitized.reply.length > streamedReply.length) {
      send("token", { text: sanitized.reply.slice(streamedReply.length) });
    }
    appendMemoryTurn({ role: "blue", text: sanitized.reply || "" });
    send("done", { ...fallback, ...sanitized, ok: true, provider: "ollama" });
    res.end();
  } catch (error) {
    const note = `Ollama unavailable: ${error.message}`;
    // If we got nothing usable from Ollama, stream the local fallback instead.
    if (!streamedReply) {
      if (!metaSent) send("meta", { provider: "local", streaming: true });
      await streamWordsTo(send, fallback.reply || "");
      appendMemoryTurn({ role: "blue", text: fallback.reply || "" });
    }
    send("done", { ...fallback, ok: true, provider: "local", warning: note });
    try { res.end(); } catch {}
  }
}

async function streamWordsTo(send, text) {
  const parts = String(text).split(/(\s+)/);
  for (const part of parts) {
    send("token", { text: part });
    // small yield so the client gets distinct events
    await new Promise((r) => setImmediate(r));
  }
}

// Walk a partial JSON buffer to pull out the (possibly incomplete) value of
// the "reply" field. Returns the unescaped string, or null if the field
// hasn't appeared yet. We do this manually because partial JSON is, of
// course, not parseable by JSON.parse mid-stream.
function extractReplyField(json) {
  const i = json.indexOf('"reply"');
  if (i < 0) return null;
  let p = json.indexOf(":", i);
  if (p < 0) return null;
  p++;
  // Skip whitespace
  while (p < json.length && /\s/.test(json[p])) p++;
  if (json[p] !== '"') return null;
  p++;
  let out = "";
  while (p < json.length) {
    const c = json[p];
    if (c === "\\") {
      const nxt = json[p + 1];
      if (!nxt) break;
      if      (nxt === "n")  out += "\n";
      else if (nxt === "t")  out += "\t";
      else if (nxt === "r")  out += "\r";
      else if (nxt === '"')  out += '"';
      else if (nxt === "\\") out += "\\";
      else if (nxt === "/")  out += "/";
      else if (nxt === "u") {
        const hex = json.slice(p + 2, p + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        p += 6;
        continue;
      } else out += nxt;
      p += 2;
    } else if (c === '"') {
      return out;
    } else {
      out += c;
      p++;
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// MULTI-PROVIDER MUSIC ABSTRACTION
// Unified API that lets the frontend say "play this" without caring whether
// it ends up on Spotify, YouTube, or Apple Music. Provider selection follows:
//   1. Explicit provider in request
//   2. User preference (memory.preferredProvider)
//   3. Capability order: spotify → youtube → spotify-preview
// Each provider implements: play, search, queue (where supported).
// ════════════════════════════════════════════════════════════════════════════
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

async function runProviderPlay(name, args) {
  if (name === "spotify") return spotifyProviderPlay(args);
  if (name === "youtube") return youtubeProviderPlay(args);
  if (name === "apple")   return appleProviderPlay(args);
  return { ok: false, error: `Unknown provider ${name}` };
}

// Spotify play, factored from spotifyPlay() so the multi-provider path can
// reuse it without going through HTTP. Returns the same shape musicPlay expects.
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

  // Pick a device
  let deviceId = "", deviceName = "";
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

// YouTube provider. We never start playback server-side — instead we resolve
// a videoId for the query and return it. The frontend's IFrame Player loads
// that videoId. This is fully legal and works without an API key.
async function youtubeProviderPlay({ query, title, artist }) {
  const q = query || [title, artist].filter(Boolean).join(" ");
  if (!q) return { ok: false, error: "No query." };
  const result = await resolveYouTubeVideo(q).catch((e) => ({ error: e.message }));
  if (!result || !result.videoId) {
    return { ok: false, error: result?.error || "No YouTube video found." };
  }
  return {
    ok: true,
    youtube: {
      videoId:    result.videoId,
      title:      result.title || title,
      channel:    result.channel || artist,
      thumbnail:  result.thumbnail || "",
      embedUrl:   `https://www.youtube.com/embed/${result.videoId}?autoplay=1&playsinline=1&modestbranding=1&enablejsapi=1`,
      watchUrl:   `https://www.youtube.com/watch?v=${result.videoId}`,
    },
    track: {
      title:  result.title  || title  || q,
      artist: result.channel || artist || "",
      genre:  "Unknown",
      mood:   inferMood(`${result.title || ""} ${result.channel || ""}`) || "Chill",
      query:  q,
      albumArt: result.thumbnail || "",
      provider: "youtube",
    },
  };
}

// Apple Music — without the user's developer credentials we can't sign a
// developer JWT, and without a subscriber-side login we can't trigger
// playback. We return setup guidance instead of failing silently.
async function appleProviderPlay() {
  if (!process.env.APPLE_TEAM_ID || !process.env.APPLE_KEY_ID || !process.env.APPLE_PRIVATE_KEY) {
    return {
      ok: false,
      error: "Apple Music needs APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY in .env. See README.",
      setupRequired: true,
    };
  }
  // The frontend handles MusicKit play directly once it has the developer
  // token — server-side we just confirm credentials are wired. The frontend
  // will call /api/apple/developer-token then MusicKit.authorize().
  return {
    ok: false,
    apple: { ready: true, needsClientAuth: true },
    error: "Apple Music ready — sign in via the player to start playback.",
  };
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

// ════════════════════════════════════════════════════════════════════════════
// YOUTUBE PROVIDER
// Two paths — Data API v3 when YOUTUBE_API_KEY is set (clean, rate-limited),
// or HTML scraping of youtube.com/results when no key is available. The
// scraper extracts video IDs from the ytInitialData JSON blob the page ships.
// ════════════════════════════════════════════════════════════════════════════
async function youtubeSearchEndpoint(url, res) {
  const q = url.searchParams.get("q") || "";
  if (!q.trim()) return json(res, { ok: false, error: "q is required." }, 400);
  try {
    const results = await youtubeSearch(q);
    json(res, { ok: true, results });
  } catch (error) {
    json(res, { ok: false, error: error.message });
  }
}

async function youtubeResolveEndpoint(url, res) {
  const q = url.searchParams.get("q") || "";
  if (!q.trim()) return json(res, { ok: false, error: "q is required." }, 400);
  try {
    const r = await resolveYouTubeVideo(q);
    json(res, { ok: true, ...r });
  } catch (error) {
    json(res, { ok: false, error: error.message });
  }
}

async function resolveYouTubeVideo(query) {
  const results = await youtubeSearch(query);
  const first = results[0];
  if (!first) return { videoId: "", title: "", channel: "", thumbnail: "" };
  return first;
}

async function youtubeSearch(query) {
  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    try {
      const params = new URLSearchParams({
        part: "snippet",
        type: "video",
        videoCategoryId: "10", // Music
        maxResults: "8",
        q: query,
        key,
      });
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `YouTube API ${r.status}`);
      return (data.items || []).map((item) => ({
        videoId:   item.id?.videoId,
        title:     item.snippet?.title,
        channel:   item.snippet?.channelTitle,
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || "",
      })).filter((v) => v.videoId);
    } catch (error) {
      // Fall through to scraper on API error
      console.warn("YouTube Data API failed, falling back to scrape:", error.message);
    }
  }
  return scrapeYouTubeSearch(query);
}

// Pull videoIds out of youtube.com/results without an API key. This is the
// same technique used by libraries like `youtube-search-without-api-key`
// — we fetch the HTML, find ytInitialData, and walk the result list.
async function scrapeYouTubeSearch(query) {
  const params = new URLSearchParams({ search_query: query, sp: "EgIQAQ%3D%3D" /* video filter */ });
  const r = await fetch(`https://www.youtube.com/results?${params}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Blue/1.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!r.ok) throw new Error(`YouTube HTML ${r.status}`);
  const html = await r.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.videoRenderer && node.videoRenderer.videoId) {
      const v = node.videoRenderer;
      out.push({
        videoId:   v.videoId,
        title:     v.title?.runs?.[0]?.text || v.title?.simpleText || "",
        channel:   v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || "",
        thumbnail: (v.thumbnail?.thumbnails || []).slice(-1)[0]?.url || "",
        duration:  v.lengthText?.simpleText || "",
      });
      return;
    }
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(data);
  return out.slice(0, 12);
}

// ════════════════════════════════════════════════════════════════════════════
// SPOTIFY EXTENDED
// Adds queue, devices, transfer, audio-features (for mood inference), search.
// ════════════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════════════
// APPLE MUSIC DEVELOPER TOKEN
// MusicKit JS needs a developer token (signed JWT) before it can authorize a
// user. We mint that JWT here using ES256 (Apple's required algorithm). Real
// playback still requires a subscriber JWT, which MusicKit obtains client-side
// after the user signs in with their Apple ID.
// ════════════════════════════════════════════════════════════════════════════
async function appleDeveloperTokenEndpoint(res) {
  const teamId  = process.env.APPLE_TEAM_ID;
  const keyId   = process.env.APPLE_KEY_ID;
  const privKey = (process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!teamId || !keyId || !privKey) {
    return json(res, {
      ok: false,
      error: "Apple Music creds missing. Set APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY in .env.",
      setupRequired: true,
    }, 501);
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 60 * 60 * 12; // 12h
    const header  = { alg: "ES256", kid: keyId, typ: "JWT" };
    const payload = { iss: teamId, iat: now, exp };
    const token = signES256JWT(header, payload, privKey);
    json(res, { ok: true, token, expiresAt: exp });
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
}

function signES256JWT(header, payload, privateKeyPem) {
  const b64url = (buf) => Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const headerB64  = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const signer = crypto.createSign("SHA256");
  signer.update(data);
  signer.end();
  // Apple expects a JOSE-format ES256 signature (r||s, 64 bytes), but
  // crypto.createSign returns DER. Use dsaEncoding:"ieee-p1363" to get JOSE.
  const sig = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64url(sig)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// GENRE / MOOD INTELLIGENCE
// Replaces the single-bucket classifier with a multi-tag classifier that
// returns confidence scores. Falls back to MusicBrainz / iTunes Search for
// "Unknown" tracks. Multi-genre output drives the dashboard's secondary tags.
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

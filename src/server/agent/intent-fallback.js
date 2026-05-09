// Local rule-based reply engine. Runs when Ollama is offline or the user's
// message is short/transport-only and doesn't need an LLM round-trip.
const { inferMood } = require("../lib/music-text");

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

module.exports = {
  shouldUseOllama,
  recommendationReply,
  pickReply,
  sharesOpening,
  niceTitle,
  parsePlayPhrase,
  casualBlueReply,
  extractPlayQuery,
  localBlueReply,
};

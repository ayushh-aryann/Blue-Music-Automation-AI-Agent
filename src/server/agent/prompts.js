// ════════════════════════════════════════════════════════════════════════════
// PROMPT CONSTRUCTION
// Blue's persona prompt + tool definitions live here so they can be reused
// across streaming and non-streaming paths.
// ════════════════════════════════════════════════════════════════════════════

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

function buildBlueSystemPrompt({ context = {}, memory = {}, allowTools = false, worldContext = "" } = {}) {
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
  if (worldContext) {
    lines.push("", `Context: ${worldContext}`);
  }
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
      "WHEN THE USER ASKS TO PLAY MUSIC, YOU MUST CALL play_track. Do not just describe what you would play — actually call the tool. Saying 'Sure, playing X' without invoking play_track is a failure.",
      "This includes vague requests: 'play any Hindi song' → pick a specific song you'd recommend (e.g. 'Tum Hi Ho Arijit Singh'), call play_track with that as the query. 'play something chill' → pick a chill song and call play_track.",
      "Call pause/next for transport. Call set_mood when the vibe shifts.",
      "Don't call tools for casual conversation (greetings, opinions, taste discussions).",
      "play_track rules — read carefully:",
      "  • query MUST be the literal 'song title artist' as a string. Never 'this', 'that', or 'the current song'.",
      "  • If the user says 'play this on YouTube' or 'switch this to Spotify', look at the 'Currently playing' line in your context and put THAT title + artist in the query field.",
      "  • If the user is vague ('any X song', 'something Y'), pick a specific song that fits and pass its title+artist. Do NOT ask for clarification — just pick one and play it.",
      "  • Only pass provider='spotify' / 'youtube' / 'apple' when the user explicitly names that provider. Otherwise pass 'auto'.",
      "  • The ONLY case where you should NOT call play_track and instead ask is when the user uses a pronoun ('this'/'that') AND there's no Currently playing context to resolve it from.",
      "After tool execution, respond conversationally about what you did (one short sentence).",
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

module.exports = {
  compactBlueContext,
  buildBlueSystemPrompt,
  buildBlueUserPrompt,
  sanitizeBlueReply,
};

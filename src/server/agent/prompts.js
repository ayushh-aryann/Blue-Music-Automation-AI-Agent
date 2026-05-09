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

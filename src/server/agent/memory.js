// ════════════════════════════════════════════════════════════════════════════
// CONVERSATION MEMORY
// Short-term rolling memory persisted across page reloads. We keep a tight
// "recent" window plus a compressed "summary" of older turns. The summary is
// fed back into the system prompt so Blue can recall what was discussed
// without paying full token cost.
// ════════════════════════════════════════════════════════════════════════════
const { readState, writeState } = require("../lib/state");

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

module.exports = {
  MEMORY_MAX_RECENT,
  readMemory,
  writeMemory,
  appendMemoryTurn,
  compactMemorySummary,
};

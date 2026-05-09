// ════════════════════════════════════════════════════════════════════════════
// EVENT LOG
// Append-only record of every play / skip / like / mood / preference. Used
// for: (1) Phase 1 tools that recall what the user has played, (2) Phase 3
// dashboard analytics, (3) auto-feeding the vector store with embedded
// preference text.
//
// One JSON object per line at .blue-events.jsonl. We never rewrite — only
// truncate periodically when the file grows past MAX_BYTES.
// ════════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { ROOT } = require("../lib/env");
const { remember } = require("./vector-memory");

const EVENTS_PATH = path.join(ROOT, ".blue-events.jsonl");
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap

function append(record) {
  const line = JSON.stringify(record) + "\n";
  try {
    const stat = fs.statSync(EVENTS_PATH);
    if (stat.size + line.length > MAX_BYTES) {
      // Keep most recent half
      const raw = fs.readFileSync(EVENTS_PATH, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const keep = lines.slice(Math.floor(lines.length / 2));
      fs.writeFileSync(EVENTS_PATH, keep.join("\n") + "\n");
    }
  } catch {}
  fs.appendFileSync(EVENTS_PATH, line);
}

// Log an event. Some types also write to the vector memory so the agent can
// recall them via natural-language queries.
async function logEvent(type, data = {}) {
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    type: String(type),
    ...data,
  };
  append(record);

  // Auto-embed events that carry meaningful free-form text. Plays and skips
  // are noisy by themselves (we just want title+artist for recency lookups);
  // moods and preferences are user-stated and worth recalling semantically.
  try {
    if (type === "preference" && data.text) {
      await remember({ type: "preference", text: String(data.text), meta: data.meta || {} });
    } else if (type === "mood" && data.mood) {
      const ctx = data.context ? ` — context: ${data.context}` : "";
      await remember({ type: "mood", text: `User vibe: ${data.mood}${ctx}`, meta: data });
    } else if (type === "like" && (data.title || data.query)) {
      const t = data.title ? `${data.title}${data.artist ? ` by ${data.artist}` : ""}` : data.query;
      await remember({ type: "like", text: `Liked: ${t}`, meta: data });
    } else if (type === "skip" && (data.title || data.query)) {
      const t = data.title ? `${data.title}${data.artist ? ` by ${data.artist}` : ""}` : data.query;
      await remember({ type: "skip", text: `Skipped: ${t}`, meta: data });
    }
  } catch {
    // Embedding failures are non-fatal — the raw event is still in the log
  }

  return record;
}

// Read events back. Filters by type and time window.
function readEvents({ types = null, sinceMs = 0, limit = 1000 } = {}) {
  let raw;
  try { raw = fs.readFileSync(EVENTS_PATH, "utf8"); } catch { return []; }
  const out = [];
  const lines = raw.split(/\r?\n/);
  // Walk from newest → oldest so limit cuts off the right end
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    if (sinceMs && evt.at < sinceMs) break;
    if (types && !types.includes(evt.type)) continue;
    out.push(evt);
  }
  return out;
}

// Convenience: titles+artists the user has played within the last N days.
function recentTrackKeys({ days = 7 } = {}) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const plays = readEvents({ types: ["play", "like"], sinceMs: since, limit: 5000 });
  const keys = new Set();
  for (const p of plays) {
    const key = `${(p.title || p.query || "").toLowerCase()}|${(p.artist || "").toLowerCase()}`;
    if (key.trim() !== "|") keys.add(key);
  }
  return keys;
}

module.exports = { logEvent, readEvents, recentTrackKeys, EVENTS_PATH };

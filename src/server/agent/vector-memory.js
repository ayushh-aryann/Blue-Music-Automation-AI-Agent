// ════════════════════════════════════════════════════════════════════════════
// LONG-TERM VECTOR MEMORY
// Pure-JS vector store. Records persist as JSONL at .blue-vector-memory.jsonl
// (one record per line, append-only on add, full rewrite on prune). Vectors
// are computed via Ollama /api/embeddings using nomic-embed-text by default.
// Cosine similarity for retrieval.
//
// If the embedding model isn't installed we still record the text and metadata,
// just without a vector. recall() then degrades to keyword + recency.
//
// We chose pure JS over sqlite-vss / better-sqlite3 to avoid native build deps
// on Windows. At <50k records this is fast enough; we'll revisit if a user
// outgrows it.
// ════════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { ROOT } = require("../lib/env");
const { OLLAMA_URL } = require("../lib/config");

const VEC_PATH = path.join(ROOT, ".blue-vector-memory.jsonl");
const EMBED_MODEL = process.env.BLUE_EMBED_MODEL || "nomic-embed-text";
const MAX_RECORDS = 50_000;

let cache = null;       // in-memory mirror of the file
let embedAvailable = null; // tri-state: null=unknown, true/false=resolved

function loadAll() {
  if (cache) return cache;
  cache = [];
  try {
    const raw = fs.readFileSync(VEC_PATH, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { cache.push(JSON.parse(trimmed)); } catch {}
    }
  } catch {}
  return cache;
}

function appendRecord(rec) {
  loadAll();
  cache.push(rec);
  if (cache.length > MAX_RECORDS) {
    // Drop oldest 10% so we're not pruning every add
    const drop = Math.floor(MAX_RECORDS * 0.1);
    cache = cache.slice(drop);
    fs.writeFileSync(VEC_PATH, cache.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return;
  }
  fs.appendFileSync(VEC_PATH, JSON.stringify(rec) + "\n");
}

async function embed(text) {
  if (embedAvailable === false) return null;
  const body = JSON.stringify({ model: EMBED_MODEL, prompt: String(text || "") });
  try {
    const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!r.ok) {
      embedAvailable = false;
      return null;
    }
    const data = await r.json();
    if (!Array.isArray(data.embedding) || !data.embedding.length) {
      embedAvailable = false;
      return null;
    }
    embedAvailable = true;
    return data.embedding;
  } catch {
    embedAvailable = false;
    return null;
  }
}

// Add a record to long-term memory. type ∈ play|skip|like|mood|preference|lyric|note.
// Caller passes free-form text we should be able to recall later.
// dedupKey (optional) prevents duplicate inserts (e.g., same lyric line across
// repeat fetches). When present, we skip the add if any existing record shares
// the same key.
async function remember({ type, text, meta = {}, dedupKey = null }) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (dedupKey) {
    const all = loadAll();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].dedupKey === dedupKey) return all[i]; // already remembered
    }
  }
  const vector = await embed(t);
  const rec = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    type: String(type || "note"),
    text: t.slice(0, 1000),
    meta,
    dedupKey: dedupKey || undefined,
    vector: vector || null,
  };
  appendRecord(rec);
  return rec;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function keywordScore(rec, terms) {
  const hay = (rec.text || "").toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / Math.max(1, terms.length);
}

// Recall the k most relevant records for a query. If embeddings work, uses
// cosine similarity. Otherwise falls back to keyword overlap + recency.
async function recall(query, { k = 5, types = null, minScore = 0.2 } = {}) {
  const records = loadAll();
  if (!records.length) return [];

  const filtered = types ? records.filter((r) => types.includes(r.type)) : records;
  if (!filtered.length) return [];

  const qVec = await embed(query);
  if (qVec) {
    const scored = filtered
      .filter((r) => Array.isArray(r.vector))
      .map((r) => ({ rec: r, score: cosine(qVec, r.vector) }))
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    if (scored.length) return scored.map(({ rec, score }) => ({ ...rec, score: +score.toFixed(3) }));
  }

  // Fallback: keyword overlap, then recency
  const terms = String(query || "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const scored = filtered.map((r) => ({
    rec: r,
    score: terms.length ? keywordScore(r, terms) : 0,
    at: r.at || 0,
  }));
  scored.sort((a, b) => (b.score - a.score) || (b.at - a.at));
  return scored.slice(0, k).map(({ rec, score }) => ({ ...rec, score: +score.toFixed(3) }));
}

function stats() {
  const records = loadAll();
  const byType = {};
  let withVec = 0;
  for (const r of records) {
    byType[r.type] = (byType[r.type] || 0) + 1;
    if (Array.isArray(r.vector)) withVec++;
  }
  return {
    total: records.length,
    withVector: withVec,
    byType,
    embedModel: EMBED_MODEL,
    embedAvailable,
  };
}

function clearAll() {
  cache = [];
  try { fs.unlinkSync(VEC_PATH); } catch {}
}

module.exports = {
  remember,
  recall,
  embed,
  stats,
  clearAll,
  EMBED_MODEL,
  VEC_PATH,
};

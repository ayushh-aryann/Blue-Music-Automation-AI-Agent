// ════════════════════════════════════════════════════════════════════════════
// AUDIO ANALYSIS PROVIDER
// Thin client for the Python sidecar at scripts/audio_analyzer.py.
// Returns BPM + key + Camelot + energy for a track URL or file path.
// If the sidecar isn't running we degrade gracefully — every public function
// returns { ok: false, sidecar: false } so callers can show "DJ mode requires
// the audio sidecar" instead of throwing.
//
// Results are cached on disk (.blue-audio-analysis.json) keyed by query/url
// so we only pay the analysis cost once per track.
// ════════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { ROOT } = require("../lib/env");

const SIDECAR_URL = process.env.BLUE_AUDIO_URL || "http://127.0.0.1:4178";
const CACHE_PATH = path.join(ROOT, ".blue-audio-analysis.json");
const HEALTH_TTL_MS = 60_000;

let healthCache = { at: 0, ok: false };
let resultCache = null;

function loadCache() {
  if (resultCache) return resultCache;
  try {
    resultCache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    resultCache = {};
  }
  return resultCache;
}

function saveCache() {
  if (!resultCache) return;
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(resultCache, null, 2)); } catch {}
}

async function isHealthy() {
  if (Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.ok;
  try {
    const r = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(1500) });
    healthCache = { at: Date.now(), ok: r.ok };
  } catch {
    healthCache = { at: Date.now(), ok: false };
  }
  return healthCache.ok;
}

async function analyze({ url, file_path, cache_key }) {
  const ok = await isHealthy();
  if (!ok) return { ok: false, sidecar: false, error: "Audio sidecar not running. Start it with: python scripts/audio_analyzer.py" };

  const cache = loadCache();
  const key = cache_key || url || file_path;
  if (key && cache[key]) {
    return { ok: true, cached: true, ...cache[key] };
  }

  try {
    const r = await fetch(`${SIDECAR_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, file_path }),
      signal: AbortSignal.timeout(180_000),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      return { ok: false, sidecar: true, error: data.error || `sidecar ${r.status}` };
    }
    if (key) {
      cache[key] = data;
      saveCache();
    }
    return data;
  } catch (e) {
    return { ok: false, sidecar: true, error: e.message };
  }
}

// Camelot wheel adjacency — used by the "what mixes well" lookup.
function compatibleCamelot(camelot) {
  const m = String(camelot || "").match(/^(\d+)([AB])$/);
  if (!m) return [];
  const n = Number(m[1]);
  const letter = m[2];
  const other = letter === "A" ? "B" : "A";
  const wrap = (x) => ((x - 1 + 12) % 12) + 1;
  return [
    `${n}${letter}`,         // same key
    `${n}${other}`,          // relative major/minor
    `${wrap(n + 1)}${letter}`, // perfect 5th up
    `${wrap(n - 1)}${letter}`, // perfect 5th down
  ];
}

module.exports = {
  isHealthy,
  analyze,
  compatibleCamelot,
  SIDECAR_URL,
};

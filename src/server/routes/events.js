const { json, readJson } = require("../lib/http");
const { logEvent, readEvents } = require("../agent/events");
const { stats: vectorStats, recall } = require("../agent/vector-memory");

async function postEvent(req, res) {
  try {
    const body = await readJson(req);
    const type = String(body.type || "").trim();
    if (!type) return json(res, { ok: false, error: "type required." }, 400);
    const record = await logEvent(type, body);
    json(res, { ok: true, record });
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
}

function getEvents(url, res) {
  const types = url.searchParams.get("types");
  const sinceMs = Number(url.searchParams.get("since")) || 0;
  const limit = Number(url.searchParams.get("limit")) || 200;
  const events = readEvents({
    types: types ? types.split(",") : null,
    sinceMs,
    limit,
  });
  json(res, { ok: true, events });
}

function getMemoryStats(req, res) {
  json(res, { ok: true, ...vectorStats() });
}

async function postMemorySearch(req, res) {
  try {
    const body = await readJson(req);
    const query = String(body.query || "").trim();
    if (!query) return json(res, { ok: false, error: "query required." }, 400);
    const k = Math.min(20, Math.max(1, Number(body.k) || 5));
    const results = await recall(query, { k, types: body.types || null });
    json(res, { ok: true, results });
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
}

module.exports = { postEvent, getEvents, getMemoryStats, postMemorySearch };

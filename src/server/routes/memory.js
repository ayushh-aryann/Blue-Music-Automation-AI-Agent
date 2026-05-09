const { json } = require("../lib/http");
const { readMemory, writeMemory } = require("../agent/memory");

function getMemory(req, res) {
  return json(res, readMemory());
}

function clearMemory(req, res) {
  writeMemory({ summary: "", recent: [] });
  return json(res, { ok: true });
}

module.exports = { getMemory, clearMemory };

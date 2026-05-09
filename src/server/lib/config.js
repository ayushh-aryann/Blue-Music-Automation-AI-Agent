const PORT = Number(process.env.BLUE_PORT || 4175);
const BASE_URL = process.env.BLUE_BASE_URL || `http://127.0.0.1:${PORT}`;
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

module.exports = { PORT, BASE_URL, OLLAMA_URL };

const { readState } = require("../lib/state");
const { ollamaStatus } = require("../agent/ollama");
const { spotifyRedirectUri } = require("../providers/spotify");

async function health() {
  const state = readState();
  const provider = process.env.BLUE_LLM_PROVIDER || "ollama";
  const ollama = provider === "ollama" ? await ollamaStatus() : { online: false, model: "" };
  const appleReady = Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
  return {
    ok: true,
    bridge: "local",
    llm: provider,
    llmOnline: provider === "local" ? true : ollama.online,
    ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    ollamaModel: ollama.model || process.env.OLLAMA_MODEL || "llama3.2:3b",
    ollamaModels: ollama.models || [],
    spotify: Boolean(state.spotify?.access_token || process.env.SPOTIFY_ACCESS_TOKEN),
    spotifyOAuth: Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    spotifyRedirectUri: spotifyRedirectUri(),
    mediaKeys: process.platform === "win32",
    streaming:    true,
    youtube:      true, // always available — IFrame Player needs no key
    youtubeKeyed: Boolean(process.env.YOUTUBE_API_KEY),
    apple:        appleReady,
    appleSetupRequired: !appleReady,
    providers: {
      spotify: Boolean(state.spotify?.access_token || process.env.SPOTIFY_ACCESS_TOKEN),
      youtube: true,
      apple:   appleReady,
    },
  };
}

module.exports = { health };

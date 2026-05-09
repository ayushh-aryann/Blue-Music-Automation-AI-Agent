const { json, readJson } = require("../lib/http");
const { isHealthy, analyze } = require("../providers/audio-analysis");
const { resolveYouTubeVideo } = require("../providers/youtube");

async function audioHealth(req, res) {
  const ok = await isHealthy();
  json(res, { ok: true, sidecar: ok });
}

async function audioAnalyze(req, res) {
  try {
    const body = await readJson(req).catch(() => ({}));
    const url = (body.url || "").trim();
    const file_path = (body.file_path || "").trim();
    const query = (body.query || "").trim();

    let resolvedUrl = url;
    let cache_key = url || file_path;
    if (!resolvedUrl && !file_path && query) {
      const yt = await resolveYouTubeVideo(query).catch(() => null);
      if (!yt?.videoId) return json(res, { ok: false, error: "Could not resolve query to a YouTube video." }, 404);
      resolvedUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;
      cache_key = `yt:${yt.videoId}`;
    }
    if (!resolvedUrl && !file_path) {
      return json(res, { ok: false, error: "Provide url, file_path, or query." }, 400);
    }
    const result = await analyze({ url: resolvedUrl, file_path, cache_key });
    json(res, result);
  } catch (error) {
    json(res, { ok: false, error: error.message }, 500);
  }
}

module.exports = { audioHealth, audioAnalyze };

const { json } = require("../lib/http");
const { youtubeSearch, resolveYouTubeVideo } = require("../providers/youtube");

// ════════════════════════════════════════════════════════════════════════════
// YOUTUBE ROUTES
// Two paths — Data API v3 when YOUTUBE_API_KEY is set (clean, rate-limited),
// or HTML scraping of youtube.com/results when no key is available. The
// scraper extracts video IDs from the ytInitialData JSON blob the page ships.
// ════════════════════════════════════════════════════════════════════════════
async function youtubeSearchEndpoint(url, res) {
  const q = url.searchParams.get("q") || "";
  if (!q.trim()) return json(res, { ok: false, error: "q is required." }, 400);
  try {
    const results = await youtubeSearch(q);
    json(res, { ok: true, results });
  } catch (error) {
    json(res, { ok: false, error: error.message });
  }
}

async function youtubeResolveEndpoint(url, res) {
  const q = url.searchParams.get("q") || "";
  if (!q.trim()) return json(res, { ok: false, error: "q is required." }, 400);
  try {
    const r = await resolveYouTubeVideo(q);
    json(res, { ok: true, ...r });
  } catch (error) {
    json(res, { ok: false, error: error.message });
  }
}

module.exports = { youtubeSearchEndpoint, youtubeResolveEndpoint };

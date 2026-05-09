const { inferMood } = require("../lib/music-text");

async function youtubeSearch(query) {
  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    try {
      const params = new URLSearchParams({
        part: "snippet",
        type: "video",
        videoCategoryId: "10", // Music
        maxResults: "8",
        q: query,
        key,
      });
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `YouTube API ${r.status}`);
      return (data.items || []).map((item) => ({
        videoId:   item.id?.videoId,
        title:     item.snippet?.title,
        channel:   item.snippet?.channelTitle,
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || "",
      })).filter((v) => v.videoId);
    } catch (error) {
      // Fall through to scraper on API error
      console.warn("YouTube Data API failed, falling back to scrape:", error.message);
    }
  }
  return scrapeYouTubeSearch(query);
}

// Pull videoIds out of youtube.com/results without an API key. This is the
// same technique used by libraries like `youtube-search-without-api-key`
// — we fetch the HTML, find ytInitialData, and walk the result list.
async function scrapeYouTubeSearch(query) {
  const params = new URLSearchParams({ search_query: query, sp: "EgIQAQ%3D%3D" /* video filter */ });
  const r = await fetch(`https://www.youtube.com/results?${params}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Blue/1.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!r.ok) throw new Error(`YouTube HTML ${r.status}`);
  const html = await r.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.videoRenderer && node.videoRenderer.videoId) {
      const v = node.videoRenderer;
      out.push({
        videoId:   v.videoId,
        title:     v.title?.runs?.[0]?.text || v.title?.simpleText || "",
        channel:   v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || "",
        thumbnail: (v.thumbnail?.thumbnails || []).slice(-1)[0]?.url || "",
        duration:  v.lengthText?.simpleText || "",
      });
      return;
    }
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(data);
  return out.slice(0, 12);
}

async function resolveYouTubeVideo(query) {
  const results = await youtubeSearch(query);
  const first = results[0];
  if (!first) return { videoId: "", title: "", channel: "", thumbnail: "" };
  return first;
}

// YouTube provider play. We never start playback server-side — instead we
// resolve a videoId for the query and return it. The frontend's IFrame Player
// loads that videoId. Fully legal and works without an API key.
async function youtubeProviderPlay({ query, title, artist }) {
  const q = query || [title, artist].filter(Boolean).join(" ");
  if (!q) return { ok: false, error: "No query." };
  const result = await resolveYouTubeVideo(q).catch((e) => ({ error: e.message }));
  if (!result || !result.videoId) {
    return { ok: false, error: result?.error || "No YouTube video found." };
  }
  return {
    ok: true,
    youtube: {
      videoId:    result.videoId,
      title:      result.title || title,
      channel:    result.channel || artist,
      thumbnail:  result.thumbnail || "",
      embedUrl:   `https://www.youtube.com/embed/${result.videoId}?autoplay=1&playsinline=1&modestbranding=1&enablejsapi=1`,
      watchUrl:   `https://www.youtube.com/watch?v=${result.videoId}`,
    },
    track: {
      title:  result.title  || title  || q,
      artist: result.channel || artist || "",
      genre:  "Unknown",
      mood:   inferMood(`${result.title || ""} ${result.channel || ""}`) || "Chill",
      query:  q,
      albumArt: result.thumbnail || "",
      provider: "youtube",
    },
  };
}

module.exports = {
  youtubeSearch,
  scrapeYouTubeSearch,
  resolveYouTubeVideo,
  youtubeProviderPlay,
};

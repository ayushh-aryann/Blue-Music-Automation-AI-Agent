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

// Score a search hit by how likely the YouTube IFrame player can actually
// embed it. Official label uploads (VEVO, "- Official", music-company channels)
// frequently disable embedding on third-party sites, which leaves the player
// stuck on a "Watch on YouTube" link. The auto-generated "- Topic" channels
// from YouTube Music never restrict embedding, so we prefer those, followed
// by lyric videos and audio/visualizer uploads.
function rankYouTubeHit(hit) {
  const channel = (hit.channel || "").toLowerCase();
  const title   = (hit.title   || "").toLowerCase();
  let score = 0;
  if (/ - topic$|– topic$/i.test(channel)) score += 100; // gold standard
  if (/\blyrics?\b|\blyric video\b/.test(title)) score += 40;
  if (/\baudio\b|\bvisualizer\b|\bofficial audio\b/.test(title)) score += 25;
  if (/\bvevo\b/.test(channel)) score -= 50;        // notorious for blocking embeds
  if (/\bofficial music video\b/.test(title)) score -= 25;
  if (/\bmusic\b/.test(channel)) score += 5;        // labels often have "Music" suffix but mixed
  if (/\blive\b|\bconcert\b|\bperformance\b/.test(title)) score -= 10;
  if (/\bcover\b|\bremix\b/.test(title)) score -= 5;
  return score;
}

function rankYouTubeHits(hits) {
  return hits
    .map((h) => ({ ...h, _score: rankYouTubeHit(h) }))
    .sort((a, b) => b._score - a._score);
}

async function resolveYouTubeVideo(query) {
  const results = await youtubeSearch(query);
  const ranked = rankYouTubeHits(results);
  const first = ranked[0];
  if (!first) return { videoId: "", title: "", channel: "", thumbnail: "" };
  return first;
}

// YouTube provider play. We never start playback server-side — instead we
// resolve a videoId for the query and return it. The frontend's IFrame Player
// loads that videoId. Fully legal and works without an API key.
//
// We return up to 5 candidates so the frontend can fall back to the next one
// if the embed is blocked (IFrame error 101/150 "playback disabled by owner").
async function youtubeProviderPlay({ query, title, artist }) {
  const q = query || [title, artist].filter(Boolean).join(" ");
  if (!q) return { ok: false, error: "No query." };
  let results;
  try {
    results = await youtubeSearch(q);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const ranked = rankYouTubeHits(results).slice(0, 5);
  if (!ranked.length) return { ok: false, error: "No YouTube video found." };
  const pick = ranked[0];
  const candidates = ranked.map((r) => ({
    videoId:   r.videoId,
    title:     r.title,
    channel:   r.channel,
    thumbnail: r.thumbnail,
  }));
  return {
    ok: true,
    youtube: {
      videoId:    pick.videoId,
      title:      pick.title || title,
      channel:    pick.channel || artist,
      thumbnail:  pick.thumbnail || "",
      embedUrl:   `https://www.youtube.com/embed/${pick.videoId}?autoplay=1&playsinline=1&modestbranding=1&enablejsapi=1`,
      watchUrl:   `https://www.youtube.com/watch?v=${pick.videoId}`,
      candidates,
    },
    track: {
      title:  pick.title  || title  || q,
      artist: pick.channel || artist || "",
      genre:  "Unknown",
      mood:   inferMood(`${pick.title || ""} ${pick.channel || ""}`) || "Chill",
      query:  q,
      albumArt: pick.thumbnail || "",
      provider: "youtube",
    },
  };
}

module.exports = {
  youtubeSearch,
  scrapeYouTubeSearch,
  resolveYouTubeVideo,
  youtubeProviderPlay,
  rankYouTubeHits,
};

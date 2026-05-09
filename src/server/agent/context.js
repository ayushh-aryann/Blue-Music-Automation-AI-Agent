// ════════════════════════════════════════════════════════════════════════════
// CONTEXT ENGINE
// Real-world signal that flavors Blue's recommendations:
//   - time of day, day of week
//   - weather (Open-Meteo, no key required) — needs BLUE_USER_LAT/LON in .env
//   - upcoming calendar event from a local ICS feed (BLUE_ICS_PATH, optional)
//
// Surfaced two ways:
//   1. as a compact block prepended to the system prompt every turn
//   2. as a get_context tool the agent can call when it wants more detail
//
// Weather is cached for 30 min so we're not hammering Open-Meteo every chat.
// ════════════════════════════════════════════════════════════════════════════
const fs = require("fs");

let weatherCache = { at: 0, data: null };
const WEATHER_TTL_MS = 30 * 60 * 1000;

function timeContext(now = new Date()) {
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
  let bucket;
  if (hours < 5)       bucket = "late night";
  else if (hours < 9)  bucket = "early morning";
  else if (hours < 12) bucket = "morning";
  else if (hours < 14) bucket = "midday";
  else if (hours < 17) bucket = "afternoon";
  else if (hours < 20) bucket = "evening";
  else if (hours < 23) bucket = "night";
  else                 bucket = "late night";
  const isWeekend = ["Saturday", "Sunday"].includes(dayOfWeek);
  return {
    hours,
    minutes,
    dayOfWeek,
    bucket,
    isWeekend,
    iso: now.toISOString(),
  };
}

async function fetchWeather() {
  const lat = parseFloat(process.env.BLUE_USER_LAT);
  const lon = parseFloat(process.env.BLUE_USER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  if (Date.now() - weatherCache.at < WEATHER_TTL_MS && weatherCache.data) {
    return weatherCache.data;
  }

  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: "temperature_2m,weather_code,wind_speed_10m,is_day",
      timezone: "auto",
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!r.ok) return null;
    const data = await r.json();
    const c = data.current || {};
    const result = {
      tempC:        c.temperature_2m,
      windKph:      c.wind_speed_10m,
      isDay:        c.is_day === 1,
      code:         c.weather_code,
      description:  weatherCodeText(c.weather_code),
    };
    weatherCache = { at: Date.now(), data: result };
    return result;
  } catch {
    return null;
  }
}

// Open-Meteo WMO weather codes → friendly text. Just the buckets that matter
// for music vibe (rain/clear/cloudy/storm) — we don't need clinical detail.
function weatherCodeText(code) {
  if (code === 0) return "clear";
  if (code <= 3)  return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 57) return "drizzly";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "showery";
  if (code <= 86) return "snowy";
  if (code <= 99) return "stormy";
  return "";
}

// Lightweight ICS parser for the upcoming-event signal. We only need the next
// event's summary + start time, not full RFC 5545 compliance.
function nextICSEvent() {
  const path = process.env.BLUE_ICS_PATH;
  if (!path) return null;
  let raw;
  try { raw = fs.readFileSync(path, "utf8"); } catch { return null; }
  const events = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur && cur.start && cur.summary) events.push(cur);
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).split(";")[0].toUpperCase();
      const val = line.slice(idx + 1);
      if (key === "SUMMARY") cur.summary = val;
      else if (key.startsWith("DTSTART")) cur.start = parseICSDate(val);
    }
  }
  const now = Date.now();
  const upcoming = events.filter((e) => e.start && e.start.getTime() > now)
    .sort((a, b) => a.start - b.start);
  return upcoming[0] || null;
}

function parseICSDate(s) {
  // Forms: 20260509T143000Z, 20260509T143000, 20260509
  const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = "0", mm = "0", ss = "0"] = m;
  const utc = s.endsWith("Z");
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
  if (!utc) {
    // Naive local — rebuild without UTC
    return new Date(+y, +mo - 1, +d, +hh, +mm, +ss);
  }
  return dt;
}

async function gatherContext() {
  const time = timeContext();
  const [weather, calendar] = await Promise.all([
    fetchWeather(),
    Promise.resolve(nextICSEvent()),
  ]);
  return { time, weather, calendar };
}

// Render the context as a compact human-readable block for the system prompt.
function describeContext(ctx) {
  if (!ctx) return "";
  const parts = [];
  if (ctx.time) {
    parts.push(`It is ${ctx.time.bucket} on a ${ctx.time.isWeekend ? "weekend" : "weekday"} (${ctx.time.dayOfWeek}, ${String(ctx.time.hours).padStart(2, "0")}:${String(ctx.time.minutes).padStart(2, "0")}).`);
  }
  if (ctx.weather) {
    const t = Number.isFinite(ctx.weather.tempC) ? ` (${Math.round(ctx.weather.tempC)}°C)` : "";
    parts.push(`Weather: ${ctx.weather.description || "unknown"}${t}.`);
  }
  if (ctx.calendar) {
    const dt = ctx.calendar.start;
    if (dt) {
      const inMin = Math.round((dt.getTime() - Date.now()) / 60000);
      const when = inMin < 60 ? `in ${inMin} min` : `at ${dt.toLocaleString()}`;
      parts.push(`Next on calendar: "${ctx.calendar.summary}" ${when}.`);
    }
  }
  return parts.join(" ");
}

module.exports = { gatherContext, describeContext, timeContext };

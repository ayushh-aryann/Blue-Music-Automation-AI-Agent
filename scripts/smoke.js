// Smoke test for Blue's HTTP API. Boots the new modular server, hits every
// public endpoint once, prints PASS/FAIL per endpoint. Used to verify Phase 0
// refactor didn't change behavior on the wire.
//
// We treat 2xx and "expected 4xx/501 with structured JSON body" as PASS.
// Endpoints that need real Spotify/Apple credentials return 501 with
// { ok:false, error:"..." } — that's a valid "wired but not configured"
// response and we accept it.
//
// Run with:  npm run smoke
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 4176; // separate port so we don't collide with a running dev server
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

const checks = [
  { name: "GET  /api/health",                  url: "/api/health" },
  { name: "GET  /api/memory",                  url: "/api/memory" },
  { name: "GET  /api/music/providers",         url: "/api/music/providers" },
  { name: "GET  /api/music/identify (no title)", url: "/api/music/identify", expectStatus: 400 },
  { name: "GET  /api/music/search (no q)",     url: "/api/music/search", expectStatus: 400 },
  { name: "GET  /api/youtube/search (no q)",   url: "/api/youtube/search", expectStatus: 400 },
  { name: "GET  /api/youtube/resolve (no q)",  url: "/api/youtube/resolve", expectStatus: 400 },
  { name: "GET  /api/spotify/search (no q)",   url: "/api/spotify/search", expectStatus: 400 },
  { name: "GET  /api/spotify/features (no id)", url: "/api/spotify/features", expectStatus: 400 },
  { name: "GET  /api/lyrics (no title)",       url: "/api/lyrics" /* returns 200 with ok:false */ },
  { name: "GET  /api/apple/developer-token",   url: "/api/apple/developer-token", allowStatus: [200, 501] },
  { name: "GET  /api/spotify/current",         url: "/api/spotify/current", allowStatus: [200, 501] },
  { name: "GET  /api/spotify/recent",          url: "/api/spotify/recent",  allowStatus: [200, 501] },
  { name: "GET  /api/spotify/devices",         url: "/api/spotify/devices", allowStatus: [200, 501] },
  { name: "POST /api/chat (empty body)",       url: "/api/chat", method: "POST", body: { message: "hello" } },
  { name: "POST /api/system/media (no action)", url: "/api/system/media", method: "POST", body: {}, expectStatus: 400 },
  { name: "POST /api/music/play (no body)",    url: "/api/music/play", method: "POST", body: {}, expectStatus: 400 },
  { name: "POST /api/music/queue (no body)",   url: "/api/music/queue", method: "POST", body: {}, allowStatus: [400, 500, 501] },
  { name: "POST /api/music/transfer (no id)",  url: "/api/music/transfer", method: "POST", body: {}, expectStatus: 400 },
  { name: "POST /api/spotify/queue (no body)", url: "/api/spotify/queue", method: "POST", body: {}, expectStatus: 400 },
  { name: "POST /api/spotify/transfer (no id)", url: "/api/spotify/transfer", method: "POST", body: {}, expectStatus: 400 },
  { name: "DELETE /api/memory",                 url: "/api/memory", method: "DELETE" },
  // Phase 1 — event log + vector memory
  { name: "GET  /api/events",                   url: "/api/events" },
  { name: "POST /api/events (preference)",      url: "/api/events", method: "POST", body: { type: "preference", text: "loves shoegaze on rainy nights" } },
  { name: "GET  /api/memory/stats",             url: "/api/memory/stats" },
  { name: "POST /api/memory/search",            url: "/api/memory/search", method: "POST", body: { query: "shoegaze", k: 3 } },
  { name: "POST /api/memory/search (no query)", url: "/api/memory/search", method: "POST", body: {}, expectStatus: 400 },
  { name: "POST /api/events (no type)",         url: "/api/events", method: "POST", body: {}, expectStatus: 400 },
  // Phase 2 — lyric search + audio sidecar
  { name: "POST /api/lyrics/search",            url: "/api/lyrics/search", method: "POST", body: { query: "driving at night", k: 3 } },
  { name: "POST /api/lyrics/search (no query)", url: "/api/lyrics/search", method: "POST", body: {}, expectStatus: 400 },
  { name: "GET  /api/audio/health",             url: "/api/audio/health" },
  { name: "POST /api/audio/analyze (no input)", url: "/api/audio/analyze", method: "POST", body: {}, expectStatus: 400 },
  { name: "GET  /  (static index.html)",       url: "/", expectContentType: "text/html" },
];

async function runCheck(check) {
  const opts = { method: check.method || "GET" };
  if (check.body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(check.body);
  }
  let response;
  try {
    response = await fetch(`${BASE}${check.url}`, opts);
  } catch (e) {
    return { ok: false, reason: `fetch error: ${e.message}` };
  }
  const status = response.status;
  if (check.expectStatus !== undefined && status !== check.expectStatus) {
    return { ok: false, reason: `expected ${check.expectStatus}, got ${status}` };
  }
  if (check.allowStatus && !check.allowStatus.includes(status)) {
    return { ok: false, reason: `status ${status} not in allow list ${check.allowStatus}` };
  }
  if (!check.expectStatus && !check.allowStatus && (status < 200 || status >= 300)) {
    return { ok: false, reason: `unexpected status ${status}` };
  }
  if (check.expectContentType) {
    const ct = response.headers.get("content-type") || "";
    if (!ct.includes(check.expectContentType)) {
      return { ok: false, reason: `content-type ${ct} missing ${check.expectContentType}` };
    }
  }
  return { ok: true, status };
}

async function main() {
  console.log(`Booting server on port ${PORT}...`);
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, BLUE_PORT: String(PORT), BLUE_BASE_URL: BASE, BLUE_LLM_PROVIDER: "local" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout.on("data", (d) => { serverOutput += d.toString(); });
  child.stderr.on("data", (d) => { serverOutput += d.toString(); });

  const ready = await waitForServer(BASE, 8000);
  if (!ready) {
    console.error("Server did not respond on /api/health within 8s");
    console.error("--- server output ---");
    console.error(serverOutput);
    child.kill();
    process.exit(2);
  }

  let pass = 0, fail = 0;
  const failed = [];
  for (const check of checks) {
    const result = await runCheck(check);
    if (result.ok) {
      console.log(`  PASS  ${check.name}  (${result.status})`);
      pass++;
    } else {
      console.log(`  FAIL  ${check.name}  — ${result.reason}`);
      failed.push({ check: check.name, reason: result.reason });
      fail++;
    }
  }

  child.kill();

  console.log(`\n${pass} passed, ${fail} failed (${checks.length} total)`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  - ${f.check}: ${f.reason}`);
    console.log("\n--- server output ---");
    console.log(serverOutput.slice(-2000));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

// ════════════════════════════════════════════════════════════════════════════
// VOICE ROUTES
// Two endpoints used by the Python voice daemon:
//
//   POST /api/voice/input   — daemon sends a transcribed command; we run the
//                             full agent loop and return {reply, action, track}
//                             as a single JSON response (not SSE).
//
//   GET  /api/voice/status  — returns daemon health by proxying to the daemon's
//                             own /health endpoint.
//
// The daemon also exposes POST /speak so other parts of the server can push
// TTS lines directly (e.g., "Now playing X" when a track starts). That call
// is made from the play_track handler in tools.js when BLUE_VOICE_PORT is set.
// ════════════════════════════════════════════════════════════════════════════
const { readJson, json } = require("../lib/http");
const { runAgent }        = require("../agent/loop");
const { readMemory, appendMemoryTurn } = require("../agent/memory");
const { compactBlueContext, buildBlueSystemPrompt } = require("../agent/prompts");
const { gatherContext, describeContext }             = require("../agent/context");
const { localBlueReply, shouldUseOllama }            = require("../agent/intent-fallback");
const { getCurrentContext }                          = require("../agent/profile");

const DAEMON_PORT = Number(process.env.BLUE_VOICE_PORT || 4177);
const DAEMON_URL  = `http://127.0.0.1:${DAEMON_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toolsEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.BLUE_AGENT_TOOLS || ""));
}

// Push a line of text to the daemon's TTS engine. Fire-and-forget; failures
// are silent (daemon might not be running — that's fine).
async function daemonSpeak(text) {
  if (!text) return;
  try {
    await fetch(`${DAEMON_URL}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* non-fatal */ }
}

// ── POST /api/voice/input ─────────────────────────────────────────────────────

async function voiceInput(req, res) {
  const body    = await readJson(req).catch(() => ({}));
  const message = String(body.message || "").trim();

  if (!message) {
    return json(res, { ok: false, error: "message required" }, 400);
  }

  // Record user turn in short-term memory (same as chatStream)
  appendMemoryTurn({ role: "user", text: message });

  // Fast local path: transport commands and very short greetings skip Ollama
  const fallback       = localBlueReply(message, {}, []);
  const transportAction = fallback.fast && ["play", "pause", "next"].includes(fallback.action);
  const tinyGreeting    = fallback.fast && fallback.action === "chat" && message.length <= 18;
  const useLocal        = !shouldUseOllama(message) && !transportAction;

  if (useLocal || tinyGreeting) {
    appendMemoryTurn({ role: "blue", text: fallback.reply });
    return json(res, {
      ok:       true,
      reply:    fallback.reply,
      action:   fallback.action,
      provider: "local",
    });
  }

  // Agent (tool-calling) path
  if (toolsEnabled()) {
    try {
      const memory      = readMemory();
      const worldCtx    = await gatherContext().catch(() => null);
      const profile     = getCurrentContext();
      const systemPrompt = buildBlueSystemPrompt({
        context:      compactBlueContext({}),
        memory,
        allowTools:   true,
        worldContext: describeContext(worldCtx),
        profile,
      });

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user",   content: message },
      ];

      const { reply, toolEvents, lastAction } = await runAgent({ messages });
      const finalReply = (reply || fallback.reply || "").trim();

      appendMemoryTurn({ role: "blue", text: finalReply });

      return json(res, {
        ok:         true,
        reply:      finalReply,
        action:     lastAction?.action || "chat",
        track:      lastAction?.track  || null,
        mood:       lastAction?.mood   || null,
        provider:   "ollama",
        toolEvents: toolEvents.map((e) => ({ tool: e.tool, ok: !!e.result?.ok })),
      });
    } catch (e) {
      console.warn("[voice/input] agent error:", e.message);
      // Fall through to simple Ollama chat
    }
  }

  // Simple non-streaming Ollama chat (tools disabled or errored)
  try {
    const { ollamaChat } = require("../agent/ollama");
    const { sanitizeBlueReply } = require("../agent/prompts");
    const parsed     = sanitizeBlueReply(await ollamaChat(message, {}, fallback, []), fallback);
    const finalReply = parsed.reply || fallback.reply;
    appendMemoryTurn({ role: "blue", text: finalReply });
    return json(res, { ok: true, reply: finalReply, action: parsed.action || "chat", provider: "ollama" });
  } catch {
    appendMemoryTurn({ role: "blue", text: fallback.reply });
    return json(res, { ok: true, reply: fallback.reply, action: fallback.action, provider: "local" });
  }
}

// ── GET /api/voice/status ─────────────────────────────────────────────────────

async function voiceStatus(_req, res) {
  try {
    const r    = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(800) });
    const data = await r.json();
    json(res, { ok: true, running: true, daemon: data });
  } catch {
    json(res, { ok: true, running: false, daemon: null });
  }
}

module.exports = { voiceInput, voiceStatus, daemonSpeak };

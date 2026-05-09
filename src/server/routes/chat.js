// ════════════════════════════════════════════════════════════════════════════
// CHAT ROUTES (single-shot + streaming SSE)
// Streaming chat keeps full backward compat with /api/chat. Token-level
// streaming uses Ollama's stream:true + format:json. We extract the live
// value of the "reply" field from the partial JSON buffer and emit deltas.
// The frontend can speak each sentence as it completes.
// ════════════════════════════════════════════════════════════════════════════
const { OLLAMA_URL } = require("../lib/config");
const { readJson, json } = require("../lib/http");
const {
  resolveOllamaModel,
  parseModelJson,
  ollamaChat,
} = require("../agent/ollama");
const {
  compactBlueContext,
  buildBlueSystemPrompt,
  buildBlueUserPrompt,
  sanitizeBlueReply,
} = require("../agent/prompts");
const {
  shouldUseOllama,
  localBlueReply,
} = require("../agent/intent-fallback");
const {
  readMemory,
  appendMemoryTurn,
} = require("../agent/memory");
const { runAgent } = require("../agent/loop");
const { gatherContext, describeContext } = require("../agent/context");
const { inferMood } = require("../lib/music-text");

// Tools mode is opt-in via env. We probe at first use and remember the result
// for the rest of the process (one model, one capability).
let toolsCapable = null; // null=untried, true/false=resolved
function toolsEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.BLUE_AGENT_TOOLS || ""));
}

async function chat(req, res) {
  const body = await readJson(req);
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const fallback = localBlueReply(body.message, body.context || {}, history);
  const provider = (process.env.BLUE_LLM_PROVIDER || "ollama").toLowerCase();

  if (fallback.fast || provider === "local" || !shouldUseOllama(body.message || "")) return json(res, fallback);

  try {
    if (provider === "ollama") {
      const parsed = sanitizeBlueReply(await ollamaChat(body.message, body.context || {}, fallback, history), fallback);
      return json(res, { ...fallback, ...parsed, ok: true, provider: "ollama" });
    }

    return json(res, { ...fallback, warning: `Unknown BLUE_LLM_PROVIDER "${provider}", using local rules.` });
  } catch (error) {
    json(res, { ...fallback, ok: true, provider: "local", warning: `Ollama unavailable: ${error.message}` });
  }
}

async function chatStream(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const message = String(body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const context = body.context || {};

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": stream open\n\n");

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  // Always record the user turn in memory up-front
  if (message) appendMemoryTurn({ role: "user", text: message });

  const fallback = localBlueReply(message, context, history);
  const provider = (process.env.BLUE_LLM_PROVIDER || "ollama").toLowerCase();
  const tools = toolsEnabled() && toolsCapable !== false;

  // Routing gate. With tools off (legacy JSON mode), the local rule engine
  // handles transport commands and short greetings to avoid LLM round-trips.
  // With tools ON, transport commands MUST go through the agent loop —
  // otherwise the local engine's templated "Done." reply ships but no tool
  // ever fires, so nothing actually plays. We only keep ultra-short greetings
  // on the local fast path in tools mode.
  const transportAction = fallback.fast && ["play", "pause", "next"].includes(fallback.action);
  const tinyGreeting    = fallback.fast && fallback.action === "chat" && message.length <= 18;
  const useLocal = provider === "local"
    || (!tools && !shouldUseOllama(message))
    || (!tools && transportAction)
    || (!tools && tinyGreeting)
    || (tools  && tinyGreeting && message.length <= 8);

  if (useLocal) {
    send("meta", { provider: "local", streaming: true });
    await streamWordsTo(send, fallback.reply || "");
    appendMemoryTurn({ role: "blue", text: fallback.reply || "" });
    send("done", { ...fallback, ok: true });
    res.end();
    return;
  }

  // ── Agent (tool-calling) path ────────────────────────────────────────────
  // Opt-in via BLUE_AGENT_TOOLS=1. If the model rejects tools we fall back to
  // JSON mode for this and all future requests in this process.
  if (tools) {
    try {
      await runAgentPath({ message, history, context, fallback, send, res });
      return;
    } catch (e) {
      if (e.toolsUnsupported) {
        toolsCapable = false;
        console.warn("Agent tools unsupported by current model — falling back to JSON mode:", e.message);
      } else {
        console.warn("Agent loop errored, falling back to JSON mode:", e.message);
      }
      // Fall through to JSON-mode path below
    }
  }

  let streamedReply = "";
  let metaSent = false;
  try {
    const model = await resolveOllamaModel();
    const memory = readMemory();
    const compactContext = compactBlueContext(context);
    const systemPrompt = buildBlueSystemPrompt({ context: compactContext, memory });
    const userPrompt   = buildBlueUserPrompt({ message, fallback, context: compactContext });

    send("meta", { provider: "ollama", model, streaming: true });
    metaSent = true;

    const messages = [{ role: "system", content: systemPrompt }];
    for (const item of history) {
      if (!item || !item.text) continue;
      if (item.role === "user") messages.push({ role: "user", content: String(item.text).slice(0, 400) });
      else if (item.role === "blue") messages.push({ role: "assistant", content: JSON.stringify({ reply: String(item.text).slice(0, 400) }) });
    }
    messages.push({ role: "user", content: userPrompt });

    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        format: "json",
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
        messages,
        options: {
          temperature: Number(process.env.OLLAMA_TEMPERATURE || 0.7),
          num_ctx:     Number(process.env.OLLAMA_NUM_CTX     || 2048),
          num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 240),
        },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => "");
      throw new Error(`Ollama ${upstream.status}: ${txt.slice(0, 160)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let jsonContent = "";

    for await (const chunk of upstream.body) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt = null;
        try { evt = JSON.parse(trimmed); } catch { continue; }
        if (!evt) continue;
        const piece = evt.message?.content || evt.response || "";
        if (piece) {
          jsonContent += piece;
          const replyNow = extractReplyField(jsonContent);
          if (replyNow !== null && replyNow.length > streamedReply.length) {
            const delta = replyNow.slice(streamedReply.length);
            send("token", { text: delta });
            streamedReply = replyNow;
          }
        }
        if (evt.done) {
          let parsed;
          try { parsed = parseModelJson(jsonContent); } catch { parsed = {}; }
          const sanitized = sanitizeBlueReply(parsed, fallback);
          if (sanitized.reply && sanitized.reply.length > streamedReply.length) {
            send("token", { text: sanitized.reply.slice(streamedReply.length) });
            streamedReply = sanitized.reply;
          }
          appendMemoryTurn({ role: "blue", text: sanitized.reply || "" });
          send("done", { ...fallback, ...sanitized, ok: true, provider: "ollama" });
          res.end();
          return;
        }
      }
    }

    // Stream ended without explicit done — flush whatever we have
    let parsed;
    try { parsed = parseModelJson(jsonContent); } catch { parsed = {}; }
    const sanitized = sanitizeBlueReply(parsed, fallback);
    if (sanitized.reply && sanitized.reply.length > streamedReply.length) {
      send("token", { text: sanitized.reply.slice(streamedReply.length) });
    }
    appendMemoryTurn({ role: "blue", text: sanitized.reply || "" });
    send("done", { ...fallback, ...sanitized, ok: true, provider: "ollama" });
    res.end();
  } catch (error) {
    const note = `Ollama unavailable: ${error.message}`;
    // If we got nothing usable from Ollama, stream the local fallback instead.
    if (!streamedReply) {
      if (!metaSent) send("meta", { provider: "local", streaming: true });
      await streamWordsTo(send, fallback.reply || "");
      appendMemoryTurn({ role: "blue", text: fallback.reply || "" });
    }
    send("done", { ...fallback, ok: true, provider: "local", warning: note });
    try { res.end(); } catch {}
  }
}

// ─── Agent loop wrapper ──────────────────────────────────────────────────
// Runs the tool-calling agent and streams the final reply back through the
// same SSE shape (meta/token/done) the existing frontend already understands.
// Tool execution surfaces as bonus tool_call/tool_result events the frontend
// can ignore today and consume later.
async function runAgentPath({ message, history, context, fallback, send, res }) {
  const memory = readMemory();
  const compactContext = compactBlueContext(context);
  const worldCtx = await gatherContext().catch(() => null);
  const systemPrompt = buildBlueSystemPrompt({
    context: compactContext,
    memory,
    allowTools: true,
    worldContext: describeContext(worldCtx),
  });

  const messages = [{ role: "system", content: systemPrompt }];
  for (const item of history) {
    if (!item || !item.text) continue;
    if (item.role === "user") messages.push({ role: "user", content: String(item.text).slice(0, 400) });
    else if (item.role === "blue") messages.push({ role: "assistant", content: String(item.text).slice(0, 400) });
  }
  messages.push({ role: "user", content: message || "" });

  send("meta", { provider: "ollama", mode: "tools", streaming: true });

  const { reply, toolEvents, lastAction } = await runAgent({
    messages,
    onEvent: (event, data) => send(event, data),
  });

  toolsCapable = true;

  const finalReply = (reply || fallback.reply || "").trim();
  await streamWordsTo(send, finalReply);

  // Build a legacy-shaped done payload so the frontend's existing handlers
  // pick up actions (play/queue/mood) without changes.
  const action = lastAction?.action
    || (toolEvents.find((e) => e.tool === "play_track")    ? "play"   : null)
    || (toolEvents.find((e) => e.tool === "set_mood")       ? "chat"   : null)
    || (toolEvents.find((e) => e.tool === "plan_session")   ? "chat"   : null)
    || "chat";

  const mood = lastAction?.mood
    || inferMood(`${message} ${finalReply}`)
    || fallback.mood
    || "Chill";

  const done = {
    ...fallback,
    ok: true,
    provider: "ollama",
    mode: "tools",
    reply: finalReply,
    mood,
    action,
    playQuery: lastAction?.playQuery || fallback.playQuery || "",
    track: lastAction?.track || fallback.track || {},
    toolEvents: toolEvents.map((e) => ({
      tool: e.tool,
      ok: !!e.result?.ok,
      args: e.args,
      result: stripAction(e.result),
    })),
  };

  appendMemoryTurn({ role: "blue", text: finalReply });
  send("done", done);
  res.end();
}

function stripAction(result) {
  if (!result || typeof result !== "object") return result;
  const { __action, ...rest } = result;
  return rest;
}

async function streamWordsTo(send, text) {
  const parts = String(text).split(/(\s+)/);
  for (const part of parts) {
    send("token", { text: part });
    // small yield so the client gets distinct events
    await new Promise((r) => setImmediate(r));
  }
}

// Walk a partial JSON buffer to pull out the (possibly incomplete) value of
// the "reply" field. Returns the unescaped string, or null if the field
// hasn't appeared yet. We do this manually because partial JSON is, of
// course, not parseable by JSON.parse mid-stream.
function extractReplyField(json) {
  const i = json.indexOf('"reply"');
  if (i < 0) return null;
  let p = json.indexOf(":", i);
  if (p < 0) return null;
  p++;
  // Skip whitespace
  while (p < json.length && /\s/.test(json[p])) p++;
  if (json[p] !== '"') return null;
  p++;
  let out = "";
  while (p < json.length) {
    const c = json[p];
    if (c === "\\") {
      const nxt = json[p + 1];
      if (!nxt) break;
      if      (nxt === "n")  out += "\n";
      else if (nxt === "t")  out += "\t";
      else if (nxt === "r")  out += "\r";
      else if (nxt === '"')  out += '"';
      else if (nxt === "\\") out += "\\";
      else if (nxt === "/")  out += "/";
      else if (nxt === "u") {
        const hex = json.slice(p + 2, p + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        p += 6;
        continue;
      } else out += nxt;
      p += 2;
    } else if (c === '"') {
      return out;
    } else {
      out += c;
      p++;
    }
  }
  return out;
}

module.exports = { chat, chatStream };

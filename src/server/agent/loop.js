// ════════════════════════════════════════════════════════════════════════════
// AGENT LOOP
// Tool-calling chat orchestrator. Asks Ollama to chat with tools enabled,
// executes any tool calls server-side, feeds the results back, and keeps
// looping until the model produces a final text reply (or the iteration cap
// is hit).
//
// Non-streaming for the tool dance — Ollama's stream:true + tools is finicky
// across models, and the user-visible UX is that the final reply streams
// word-by-word at the end (same effect as the local-fallback path).
// Tool calls and results are surfaced as their own SSE events so the UI can
// show "Blue is searching… Blue is queueing X…" if it wants to.
// ════════════════════════════════════════════════════════════════════════════
const { OLLAMA_URL } = require("../lib/config");
const { resolveOllamaModel } = require("./ollama");
const { toolSchemas, dispatch } = require("./tools");

const MAX_ITERATIONS = 5;

async function ollamaChatWithTools({ model, messages, tools, signal }) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
      messages,
      tools,
      options: {
        temperature: Number(process.env.OLLAMA_TEMPERATURE || 0.7),
        num_ctx:     Number(process.env.OLLAMA_NUM_CTX     || 4096),
        num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 320),
      },
    }),
    signal,
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`Ollama ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    err.body = text;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Ollama returned non-JSON: ${text.slice(0, 200)}`);
  }
  return data;
}

// Some Ollama versions return tool_calls.function.arguments as a string, others
// as an object. Normalize.
function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

// Run the full tool-calling loop. Returns:
//   { reply, toolEvents: [{tool, args, result}], lastAction }
// The chatStream route uses this to construct the SSE done payload.
async function runAgent({ messages, onEvent = () => {} }) {
  const model = await resolveOllamaModel();
  const conv = messages.slice();
  const toolEvents = [];
  let lastAction = null; // { action, track, playQuery, mood, ... }
  let finalReply = "";

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let response;
    try {
      response = await ollamaChatWithTools({ model, messages: conv, tools: toolSchemas });
    } catch (e) {
      // Model probably doesn't support tools — surface the error so the
      // caller can fall back to JSON mode.
      const err = new Error(`agent.loop: ${e.message}`);
      err.cause = e;
      err.toolsUnsupported = /tool|function/i.test(e.body || e.message || "");
      throw err;
    }

    const msg = response.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (!toolCalls.length) {
      finalReply = (msg.content || "").trim();
      break;
    }

    // Persist the assistant turn (with its tool_calls) so subsequent tool
    // messages have the right reference.
    conv.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });

    // Execute each tool call sequentially. In practice models emit one or two
    // per turn — sequential keeps state predictable (e.g., set_mood before
    // recall_memory).
    for (const call of toolCalls) {
      const fn = call.function || {};
      const name = fn.name || "";
      const args = parseArgs(fn.arguments);

      onEvent("tool_call", { tool: name, args });
      const result = await dispatch(name, args);
      onEvent("tool_result", { tool: name, ok: !!result?.ok, summary: summarizeResult(name, result) });
      toolEvents.push({ tool: name, args, result });

      // Track the most recent user-visible action so chatStream can build a
      // legacy-shaped done payload.
      if (result && result.__action) {
        lastAction = { ...(lastAction || {}), ...result.__action };
      }

      // Strip the bulky __action marker so we don't leak it into the prompt
      const { __action, ...resultForModel } = result || {};
      conv.push({
        role: "tool",
        content: JSON.stringify(resultForModel).slice(0, 4000),
      });
    }
  }

  // Safety net: smaller models sometimes call search_tracks, get results,
  // then narrate "Playing X" in text without ever calling play_track. Detect
  // that case and auto-chain into play_track using the top search result, so
  // a user request to play actually results in playback.
  const userMsg = [...conv].reverse().find((m) => m.role === "user")?.content || "";
  const wantedToPlay = /\b(play|put on|spin|throw on|queue up|hit play|start)\b/i.test(userMsg);
  const playedSomething = toolEvents.some((e) => e.tool === "play_track" && e.result?.ok);
  const searchEvent = toolEvents.find((e) => e.tool === "search_tracks");

  if (wantedToPlay && !playedSomething) {
    // Prefer the search result if we have one — that's what the model
    // intended to play. Otherwise fall back to the search query itself
    // (covers 0-hit cases like a bad search), and finally to a quoted
    // title from the model's own text reply if all else fails.
    let query = "";
    let requestedProvider = "auto";
    if (searchEvent?.result?.results?.length) {
      const top = searchEvent.result.results[0];
      query = top.title && top.artist
        ? `${top.title} ${top.artist}`
        : (top.title || "");
      requestedProvider = searchEvent.args?.provider && searchEvent.args.provider !== "auto"
        ? searchEvent.args.provider
        : (top.provider || "auto");
    } else if (searchEvent?.args?.query) {
      query = searchEvent.args.query;
      requestedProvider = searchEvent.args.provider || "auto";
    } else {
      // Last-resort: pull a "Title — Artist" or quoted phrase out of the
      // model's text reply. Handles cases where the model narrated a play
      // without calling any tool at all.
      const quoted = finalReply.match(/["']([^"']{3,80})["']/);
      const byArtist = finalReply.match(/([A-Z][\w '&-]+?)\s+by\s+([A-Z][\w '&-]+)/);
      if (byArtist) query = `${byArtist[1]} ${byArtist[2]}`;
      else if (quoted) query = quoted[1];
      const providerMention = /\bon\s+(youtube|spotify|apple)\b/i.exec(userMsg);
      if (providerMention) requestedProvider = providerMention[1].toLowerCase();
    }
    if (query) {
      onEvent("tool_call", { tool: "play_track", args: { query, provider: requestedProvider }, auto: true });
      const playResult = await dispatch("play_track", { query, provider: requestedProvider });
      onEvent("tool_result", { tool: "play_track", ok: !!playResult?.ok, summary: summarizeResult("play_track", playResult), auto: true });
      toolEvents.push({ tool: "play_track", args: { query, provider: requestedProvider }, result: playResult });
      if (playResult?.__action) {
        lastAction = { ...(lastAction || {}), ...playResult.__action };
      }
      if (playResult?.ok) {
        finalReply = `Playing ${playResult.track?.title || query}${playResult.track?.artist ? " — " + playResult.track.artist : ""}.`;
      }
    }
  }

  // If we hit the iteration cap without the model producing free text, ask
  // it once more without tools to get a closing line.
  if (!finalReply) {
    try {
      const closing = await ollamaChatWithTools({
        model,
        messages: conv.concat([{ role: "user", content: "Now reply in one or two sentences. No more tool calls." }]),
        tools: [],
      });
      finalReply = (closing.message?.content || "").trim();
    } catch {}
  }

  return { reply: finalReply, toolEvents, lastAction };
}

function summarizeResult(name, result) {
  if (!result) return "(no result)";
  if (result.ok === false) return `error: ${result.error || "unknown"}`;
  switch (name) {
    case "play_track":
      return result.track ? `playing ${result.track.title || ""}${result.track.artist ? " — " + result.track.artist : ""}` : "ok";
    case "queue_track":
      return result.uri ? `queued ${result.uri}` : "queued";
    case "search_tracks":
      return `${result.results?.length || 0} hits`;
    case "set_mood":
      return `mood = ${result.mood}`;
    case "recall_memory":
      return `${result.count || 0} memories`;
    case "save_preference":
      return `saved`;
    case "plan_session":
      return result.queue ? `${result.queue.length} tracks (${result.estimated_minutes || "?"} min)` : "planned";
    case "find_lyric_line":
      return `${result.count || 0} lyric matches`;
    case "analyze_track":
      return result.bpm ? `${result.bpm} BPM, ${result.key || "?"} (${result.camelot || "?"})` : "no analysis";
    case "get_context":
      return `${result.time?.bucket || "?"}${result.weather ? ", " + result.weather.description : ""}`;
    case "transfer_device":
      return `→ ${result.device_id}`;
    default:
      return "ok";
  }
}

module.exports = { runAgent, MAX_ITERATIONS };

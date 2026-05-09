const { OLLAMA_URL } = require("../lib/config");
const { compactBlueContext } = require("./prompts");

let cachedOllamaModel = "";
let cachedOllamaModels = [];
let lastOllamaModelCheck = 0;

function chooseOllamaModel(models) {
  const preferredOrder = [
    process.env.OLLAMA_MODEL,
    "llama3.2:3b",
    "qwen2.5:7b",
    "llama3.1:8b",
    "mistral",
  ].filter(Boolean);
  return preferredOrder.find((model) => models.includes(model)) || models[0] || "";
}

async function ollamaStatus() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Ollama tags failed");
    const models = (data.models || []).map((model) => model.name || model.model).filter(Boolean);
    cachedOllamaModels = models;
    cachedOllamaModel = chooseOllamaModel(models);
    lastOllamaModelCheck = Date.now();
    return {
      online: true,
      models,
      model: cachedOllamaModel,
    };
  } catch {
    return { online: false, models: [], model: "" };
  }
}

async function resolveOllamaModel() {
  const preferred = process.env.OLLAMA_MODEL;
  if (cachedOllamaModel && Date.now() - lastOllamaModelCheck < 60_000) return cachedOllamaModel;

  const response = await fetch(`${OLLAMA_URL}/api/tags`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not list Ollama models.");
  const models = (data.models || []).map((model) => model.name || model.model).filter(Boolean);
  if (!models.length) throw new Error("No Ollama models are installed. Pull llama3.2:3b first.");
  cachedOllamaModels = models;
  cachedOllamaModel = preferred && models.includes(preferred) ? preferred : chooseOllamaModel(models);
  lastOllamaModelCheck = Date.now();
  return cachedOllamaModel;
}

async function warmOllama() {
  if ((process.env.BLUE_LLM_PROVIDER || "ollama").toLowerCase() !== "ollama") return;
  const model = await resolveOllamaModel();
  await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "Blue ready.",
      stream: false,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
      options: { num_predict: 1 },
    }),
  }).catch(() => {});
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Ollama did not return JSON.");
    return JSON.parse(match[0]);
  }
}

// Single-shot chat (legacy, non-streaming). Streaming chat lives in
// routes/chat.js because it's tightly coupled to SSE response writing.
async function ollamaChat(message = "", context = {}, fallback = {}, history = []) {
  const model = await resolveOllamaModel();
  const compactContext = compactBlueContext(context);

  const systemPrompt = [
    "You are Blue — Ayush's personal music agent. You talk like a thoughtful friend who happens to know music inside-out.",
    "Voice rules:",
    "- Sound human. Use contractions (I'm, you're, that's). Vary sentence length. Drop fillers like 'so', 'yeah', 'honestly' sparingly so it feels real.",
    "- Avoid robotic phrases like 'I am here', 'I am Blue', 'I will'. Use 'I'm', 'I'll', 'let me'.",
    "- Don't over-use Ayush's name; once every few replies is plenty.",
    "- Track the conversation. Reference what was just said when it fits. Don't repeat your last reply's structure.",
    "- Casual chat → casual short reply, no music push. Music questions → opinionated, specific. Play only when clearly asked.",
    "- Keep replies under two short sentences unless the user asked for depth.",
    "Return JSON ONLY. Schema:",
    '{"reply":"string","mood":"Electric|Chill|Focused|Late Night|Reflective|Calm","action":"chat|recommend|play|pause|next","playQuery":"string","track":{"title":"string","artist":"string","genre":"string","mood":"string","query":"string"}}',
  ].join("\n");

  const userPrompt = [
    `Suggested fallback track: ${JSON.stringify(fallback.track || {})}`,
    `Listening context: ${JSON.stringify(compactContext)}`,
    `Latest message: ${message}`,
  ].join("\n");

  const messages = [{ role: "system", content: systemPrompt }];
  for (const item of history) {
    if (!item || !item.text) continue;
    if (item.role === "user") messages.push({ role: "user", content: String(item.text).slice(0, 400) });
    else if (item.role === "blue") messages.push({ role: "assistant", content: JSON.stringify({ reply: String(item.text).slice(0, 400) }) });
  }
  messages.push({ role: "user", content: userPrompt });

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
      messages,
      options: {
        temperature: Number(process.env.OLLAMA_TEMPERATURE || 0.7),
        num_ctx: Number(process.env.OLLAMA_NUM_CTX || 1536),
        num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 160),
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Ollama request failed with ${response.status}`);
  const content = data.message?.content || "";
  return parseModelJson(content);
}

module.exports = {
  ollamaStatus,
  resolveOllamaModel,
  warmOllama,
  chooseOllamaModel,
  parseModelJson,
  ollamaChat,
};

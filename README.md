# Blue — Local-first AI Music Companion

Blue is a conversational music agent that runs entirely on your machine. The brain is Ollama, the voice is the browser, and music can be routed through Spotify, YouTube, or Apple Music. The agent UI lives at `http://127.0.0.1:4175`.

## Quick start

```powershell
ollama pull qwen2.5:7b   # recommended (better tool use + dialogue)
# or:
ollama pull llama3.2:3b  # smaller, faster, less rich

cp .env.example .env     # then edit values you need
npm start
```

If Ollama isn't running, Blue falls back to its built-in intent engine — the app still works, it just won't hold long open-ended conversations.

## Voice

The mic toggles **continuous mode**: press once to turn it on, press again to turn it off. While it's hot:

- speak naturally — short pauses are tolerated, no need to retrigger
- a live caption shows what Blue is hearing
- replies stream token-by-token; sentences are spoken as they complete
- talking interrupts the in-flight reply (Blue stops mid-sentence to listen)

If your browser denies mic permission, type instead — same routes.

## Music providers

Blue talks to multiple providers and auto-falls-back when one is unreachable.

### Spotify (recommended primary)

Requires a Spotify developer app with the redirect URI registered exactly as:

```
http://127.0.0.1:4175/api/spotify/callback
```

Set in `.env`:

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:4175/api/spotify/callback
```

Then click **Connect Spotify** in the app. Playback control needs Spotify Premium; without Premium you'll get 30-second previews routed to a local audio element instead of being bounced to Spotify's site.

### YouTube

Always available — the IFrame Player works without any credentials. Search defaults to a public-page scraper that pulls `videoId`s from the same JSON YouTube ships to its results page. For higher-quality search and rate limit headroom, set:

```env
YOUTUBE_API_KEY=AIza...
```

### Apple Music

Apple Music's MusicKit JS requires Apple Developer credentials before it can play anything. There's no way around this. To enable it:

1. Sign up at [developer.apple.com](https://developer.apple.com) ($99/yr).
2. In *Certificates, Identifiers & Profiles* → *Keys*, create a key with the **MusicKit** capability. Download the resulting `.p8` file (you only get to download it once).
3. Note your **Team ID** (top-right of the developer portal) and the **Key ID** (next to the key you just created).
4. Drop them into `.env`:

   ```env
   APPLE_TEAM_ID=ABCDE12345
   APPLE_KEY_ID=ABCDE12345
   APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----\n"
   ```

   The private key must be a single-line value with newlines escaped as `\n`. Blue mints the developer JWT server-side via `GET /api/apple/developer-token`.

5. Reload the app and pick **Apple** in the provider chips. The first play will prompt you to sign in with your Apple ID (you need an active Apple Music subscription to actually hear music).

If any of those creds are missing, Apple stays a dim chip with a "Needs setup" tooltip — nothing else breaks.

## Architecture

```
                    ┌─────────────────────────┐
  Browser UI  ◀──▶  │ Node HTTP server (4175) │  ◀──▶  Ollama (11434)
  React JSX         └────┬────────┬────────┬──┘
                          │        │        │
                       Spotify  YouTube  iTunes / MusicBrainz
                       (OAuth)  (IFrame  (genre lookups)
                                 + scrape)
```

- **Streaming chat (`POST /api/chat/stream`)** — Server-Sent Events. The frontend
  reads the stream with `fetch` + `getReader`, appending tokens to a live bubble
  and piping each completed sentence into `SpeechSynthesis`.
- **Conversation memory (`/api/memory`)** — A short-term rolling memory persists
  to `.blue-state.json`. The 16 most recent turns stay raw; older ones are
  compressed into a summary that's fed back into the system prompt.
- **Multi-provider music (`/api/music/*`)** — One endpoint, multiple providers.
  `POST /api/music/play` walks Spotify → YouTube → Apple → preview, returning
  the first one that succeeds.
- **Smarter genre tagging (`/api/music/identify`)** — Multi-tag classification
  with confidence scores. Falls back to iTunes Search and MusicBrainz when
  artist genres aren't enough.

## Agent mode (Phase 1 — tool calling)

Blue can run as a tool-calling agent: instead of producing JSON the server has to interpret, the model directly calls server-side tools (`play_track`, `queue_track`, `recall_memory`, `plan_session`, etc.) and the loop feeds results back until it produces a final reply.

Enable it:

```env
BLUE_AGENT_TOOLS=1
```

Requires a tool-capable model (most modern Ollama models support tools — `qwen2.5`, `llama3.1`, `llama3.2`, `mistral`, `phi4`). If the active model rejects tools, Blue falls back to JSON mode automatically and remembers for the rest of the session.

The eight tools are documented in `src/server/agent/tools.js`. The agent loop is capped at 5 iterations per turn.

## Long-term memory (Phase 1)

Two files persist alongside `.blue-state.json`:

- `.blue-events.jsonl` — append-only event log (plays, skips, likes, moods, preferences). Drives the `recall_memory` tool and Phase 3 dashboard.
- `.blue-vector-memory.jsonl` — embedded preferences/moods/likes for semantic recall.

Embeddings come from Ollama. Pull the embedding model once:

```powershell
ollama pull nomic-embed-text
```

If you skip this, Blue still records events — `recall_memory` just falls back to keyword + recency search instead of semantic similarity.

New endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/events?types=play,skip&since=...&limit=...` | Read raw event log |
| POST | `/api/events` | Append an event (`{type, ...payload}`) |
| GET  | `/api/memory/stats` | Vector store size + per-type breakdown |
| POST | `/api/memory/search` | Recall: `{query, k?, types?}` |

## Music intelligence (Phase 2)

### Lyric semantic search

Every time Blue fetches lyrics from LRCLIB, each timestamped line is embedded into the vector store (type `lyric`). You can then ask Blue *"play the song with the line about driving at night"* — it calls `find_lyric_line`, finds the match, and queues the track at the correct timestamp.

```
POST /api/lyrics/search { "query": "driving at night", "k": 5 }
→ { ok, results: [{ title, artist, line, timestamp, score }, ...] }
```

### Mood & context engine

Blue can factor in real-world signal — time of day, weather, upcoming calendar events — when it picks music. The agent has a `get_context` tool, and a one-line summary is also injected into every system prompt.

Set in `.env` (all optional):

```env
BLUE_USER_LAT=12.97       # Open-Meteo (no key required)
BLUE_USER_LON=77.59
BLUE_ICS_PATH=C:\path\to\calendar.ics   # local ICS file (optional)
```

Without `LAT`/`LON` weather is skipped silently. Time of day always works.

### Audio analysis sidecar (BPM + key)

A separate Python process exposes BPM, musical key (Camelot wheel), and energy detection on YouTube tracks. The agent's `analyze_track` tool calls into it. The sidecar is optional — Blue degrades to "audio sidecar not running" when it's absent.

```powershell
# one-time setup
python -m venv .venv-audio
.venv-audio\Scripts\pip install librosa numpy soundfile yt-dlp

# run alongside Blue
.venv-audio\Scripts\python scripts\audio_analyzer.py
```

Tracks are downloaded to `.blue-audio-cache/` and analyses are cached in `.blue-audio-analysis.json` so each track is only analyzed once.

```
POST /api/audio/analyze { "query": "Coldplay Yellow" }
→ { bpm, key, camelot, beats_sec, rms_energy, ... }
```

## Environment variables

```env
# Server
BLUE_PORT=4175
BLUE_BASE_URL=http://127.0.0.1:4175

# LLM — Ollama is the default
BLUE_LLM_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b           # or llama3.2:3b, mistral, deepseek-r1, phi4
OLLAMA_KEEP_ALIVE=30m
OLLAMA_TEMPERATURE=0.7
OLLAMA_NUM_CTX=2048
OLLAMA_NUM_PREDICT=240

# Spotify (optional but recommended)
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:4175/api/spotify/callback

# YouTube (optional — unauthenticated scrape works without)
YOUTUBE_API_KEY=

# Apple Music (optional — needs Apple Developer creds)
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=

# Agent / memory (Phase 1)
BLUE_AGENT_TOOLS=0           # set to 1 to enable tool-calling agent loop
BLUE_EMBED_MODEL=nomic-embed-text

# Context engine (Phase 2)
BLUE_USER_LAT=                # for weather via Open-Meteo
BLUE_USER_LON=
BLUE_ICS_PATH=                # path to a local .ics calendar (optional)

# Audio sidecar (Phase 2)
BLUE_AUDIO_URL=http://127.0.0.1:4178
BLUE_AUDIO_PORT=4178
```

## Recommended Ollama models

| Model | Size | What it's good at |
|---|---|---|
| `qwen2.5:7b` | 4.7 GB | Best balance — long dialogue, tool use, low repetition |
| `llama3.1:8b` | 4.7 GB | Strong reasoning, slightly more verbose |
| `llama3.2:3b` | 2.0 GB | Fastest reply latency, OK conversation |
| `mistral` | 4.1 GB | Good prose voice, weaker at structured output |
| `deepseek-r1:7b` | 4.7 GB | Very chatty + reasoning trace |
| `phi4` | 9.1 GB | Solid all-rounder, larger memory footprint |

If multiple models are installed, Blue prefers `OLLAMA_MODEL` if you set one; otherwise it picks in this order: `qwen2.5:7b` → `llama3.2:3b` → `llama3.1:8b` → `mistral`.

## Endpoints reference

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/health` | Bridge + provider status |
| POST | `/api/chat` | Single-shot chat (legacy) |
| POST | `/api/chat/stream` | SSE streaming chat |
| GET  | `/api/memory` | Read short-term memory |
| DELETE | `/api/memory` | Clear short-term memory |
| GET  | `/api/music/providers` | Per-provider connection state |
| POST | `/api/music/play` | Unified play (provider auto-selected) |
| GET  | `/api/music/search?q=...&provider=...` | Cross-provider search |
| POST | `/api/music/queue` | Queue track on supported providers |
| POST | `/api/music/transfer` | Transfer Spotify playback to a device |
| GET  | `/api/music/identify?title=...&artist=...` | Multi-tag genre classification |
| GET  | `/api/youtube/search?q=...` | YouTube search (key or scrape) |
| GET  | `/api/youtube/resolve?q=...` | First-hit videoId for a query |
| GET  | `/api/spotify/devices` | List Spotify devices |
| POST | `/api/spotify/queue` | Queue track |
| POST | `/api/spotify/transfer` | Transfer playback |
| GET  | `/api/spotify/features?id=...` | Audio features for a Spotify track |
| GET  | `/api/spotify/search?q=...&type=track` | Spotify search |
| GET  | `/api/apple/developer-token` | MusicKit JS developer JWT |
| POST | `/api/system/media` | Windows media-key bridge |
| GET  | `/api/lyrics?title=...&artist=...` | Synced lyrics via LRCLIB |

## Troubleshooting

- **"redirect_uri: Not matching configuration"** — the URI in your Spotify
  developer dashboard must match `SPOTIFY_REDIRECT_URI` exactly, including the
  port and trailing slash.
- **"No active Spotify device"** — open the Spotify app on any device and press
  play once. Blue can then route through that device. Without a Premium account
  Blue uses 30-second previews instead.
- **"YouTube HTML 429"** — the unauthenticated scraper got rate-limited. Set
  `YOUTUBE_API_KEY` to use the official Data API.
- **Apple Music chip stays dim** — credentials in `.env` aren't loading. Confirm
  `APPLE_PRIVATE_KEY` has its newlines escaped as `\n`, and restart the server.
- **Mic doesn't auto-restart** — Chrome only allows continuous SpeechRecognition
  on `https://` and `http://localhost`/`http://127.0.0.1`. If you bind to a
  non-loopback host, the mic will work for one phrase and then stop.

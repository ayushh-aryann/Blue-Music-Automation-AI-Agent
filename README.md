# Blue Local Setup

Blue is local-first. The music agent UI runs at `http://127.0.0.1:4175`, and the brain is Ollama on your computer.

## Ollama

Install Ollama, then pull a model:

```powershell
ollama pull qwen2.5:7b
```

Use a smaller model if your computer struggles:

```powershell
ollama pull llama3.2:3b
```

Create `.env` from `.env.example`, then keep:

```env
BLUE_LLM_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b
```

Start Blue:

```powershell
npm start
```

If Ollama is not running, Blue falls back to its local intent engine, so the app still works.

## Spotify

Spotify control still needs Spotify OAuth because Spotify protects playback control. Add a Spotify developer app with this redirect URI:

```text
http://127.0.0.1:4175/api/spotify/callback
```

Then add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to `.env`.

If Spotify says `redirect_uri: Not matching configuration`, the URI in Spotify's dashboard must match this exactly:

```text
http://127.0.0.1:4175/api/spotify/callback
```

Or set `SPOTIFY_REDIRECT_URI` in `.env` to the exact callback URI you registered in Spotify.

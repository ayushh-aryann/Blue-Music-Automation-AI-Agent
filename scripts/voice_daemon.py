#!/usr/bin/env python3
"""
Blue Voice Daemon — always-on "Hey Blue" wake word + Whisper STT + TTS.

Listens continuously via webrtcvad. When a speech segment ends, runs
faster-whisper on it. If the transcript starts with "hey blue", strips the
wake phrase and sends the rest to Blue's /api/voice/input endpoint. The reply
is spoken back (pyttsx3 by default, edge-tts for better quality).

Architecture
------------
  mic → sounddevice callback → _audio_q
  recognition_loop pulls from _audio_q, runs VAD→Whisper→wake detect→command
  TTS worker thread drains _tts_q, keeps pyttsx3 on one dedicated thread
  HTTP server (port 4177) accepts /speak from Node, POST /health from anyone

Setup
-----
  python -m venv .venv-voice
  .venv-voice\\Scripts\\pip install faster-whisper webrtcvad-wheels sounddevice numpy pyttsx3
  .venv-voice\\Scripts\\python scripts/voice_daemon.py

  # For neural-quality TTS (optional):
  .venv-voice\\Scripts\\pip install edge-tts
  # then set BLUE_VOICE_TTS=edge in .env

Environment (read from .env automatically)
------------------------------------------
  BLUE_PORT=4175            Blue Node server port
  BLUE_VOICE_PORT=4177      This daemon's own HTTP port
  BLUE_VOICE_DEVICE=        Mic device index (blank = system default)
  BLUE_WHISPER_MODEL=tiny   faster-whisper size: tiny / base / small
  BLUE_VOICE_LANG=en        Whisper language code
  BLUE_VOICE_TTS=pyttsx3    TTS backend: pyttsx3 | edge | win32
  BLUE_VOICE_NAME=en-US-AriaNeural  Edge-TTS voice (only for edge backend)
"""
from __future__ import annotations

# Force UTF-8 output on Windows so print() never raises UnicodeEncodeError
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import asyncio
import json
import os
import queue
import re
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ── Bootstrap: load .env, read config ────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent


def _load_env():
    p = ROOT / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_env()

BLUE_PORT     = int(os.environ.get("BLUE_PORT",           "4175"))
DAEMON_PORT   = int(os.environ.get("BLUE_VOICE_PORT",     "4177"))
WHISPER_MODEL = os.environ.get("BLUE_WHISPER_MODEL",     "tiny")
VOICE_LANG    = os.environ.get("BLUE_VOICE_LANG",        "en")
VOICE_DEVICE  = os.environ.get("BLUE_VOICE_DEVICE",      None)  # int index or None
TTS_ENGINE    = os.environ.get("BLUE_VOICE_TTS",         "pyttsx3").lower()
EDGE_VOICE    = os.environ.get("BLUE_VOICE_NAME",        "en-US-AriaNeural")
BLUE_URL      = f"http://127.0.0.1:{BLUE_PORT}"

# Wake-word listening is opt-in. With it off the daemon still serves /speak
# (so spoken track announcements work) but doesn't open the mic or run Whisper.
# Use the browser's voice chat button in the UI for talking to Blue.
WAKE_ENABLED  = bool(re.match(r"^(1|true|yes|on)$",
                              os.environ.get("BLUE_VOICE_WAKE", "0"),
                              flags=re.I))

# ── Audio constants (must satisfy webrtcvad requirements) ─────────────────────
#   Frame sizes allowed: 10 / 20 / 30 ms at 8000 / 16000 / 32000 Hz.
#   We use 30 ms @ 16 kHz → 480 samples → 960 bytes (int16).

SAMPLE_RATE    = 16_000
FRAME_MS       = 30
FRAME_SAMPLES  = SAMPLE_RATE * FRAME_MS // 1000   # 480
FRAME_BYTES    = FRAME_SAMPLES * 2                 # 960 (int16 → 2 B/sample)

VAD_MODE       = 1    # 0–3; higher = more aggressive silence trimming (1 = permissive)

# Minimum RMS of collected audio before we bother calling Whisper.
# int16 range is 0–32768; background hiss is ~5–50, faint noise ~50–150, real
# speech starts around 200+. This gate prevents hallucination-loops where the
# LM echoes initial_prompt words back on silence frames.
MIN_SPEECH_RMS = 200

# Silence thresholds (in frames) for each recording phase
SILENCE_WAKE   = int(0.7 * 1000 / FRAME_MS)   # 0.7 s → end wake-detect segment
SILENCE_CMD    = int(1.5 * 1000 / FRAME_MS)   # 1.5 s → end command segment

# Length caps (in frames)
MAX_WAKE       = int(3.5 * 1000 / FRAME_MS)   # 3.5 s max for wake window
MAX_CMD        = int(8.0 * 1000 / FRAME_MS)   # 8 s max for command

# Wake phrases — lowercase, handled as substrings
WAKE_PHRASES   = {
    "hey blue", "hey, blue", "hi blue", "hay blue", "hey blu",
    # Phonetic variants the tiny model produces for Indian-English accents
    "eblu", "e blue", "a blue", "hey eblu", "hey eblue", "eblue",
    "he blue", "hay eblu",
}

# ── Shared inter-thread state ─────────────────────────────────────────────────

_audio_q: queue.Queue[bytes] = queue.Queue(maxsize=600)
_tts_q:   queue.Queue[str | None] = queue.Queue()

# Set while TTS is actively speaking → recognition loop drains mic to avoid echo
_speaking = threading.Event()

_state = {"value": "idle"}   # idle | detecting | listening | transcribing | processing | speaking


def set_state(s: str):
    _state["value"] = s


# ── Lazy model singletons ─────────────────────────────────────────────────────

_whisper     = None
_whisper_lck = threading.Lock()
_vad         = None


def get_whisper():
    global _whisper
    if _whisper is None:
        with _whisper_lck:
            if _whisper is None:
                from faster_whisper import WhisperModel  # type: ignore
                print(f"[voice] Loading faster-whisper ({WHISPER_MODEL!r})…", flush=True)
                _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
                print("[voice] Whisper ready.", flush=True)
    return _whisper


def get_vad():
    global _vad
    if _vad is None:
        import webrtcvad  # type: ignore
        _vad = webrtcvad.Vad(VAD_MODE)
    return _vad


# ── Amplitude helpers ─────────────────────────────────────────────────────────

def _rms(raw: bytes) -> float:
    """Return RMS amplitude of int16 PCM bytes (0–32768 scale)."""
    import numpy as np
    if len(raw) < 2:
        return 0.0
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    return float(np.sqrt(np.mean(a * a)))


# ── Transcription ─────────────────────────────────────────────────────────────

def transcribe(raw: bytes, is_command: bool = False) -> str:
    """Convert raw int16 PCM bytes → text string via faster-whisper."""
    import numpy as np  # type: ignore
    model = get_whisper()
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32_768.0
    # initial_prompt steers the LM toward the right vocabulary so tiny doesn't
    # hallucinate non-English spellings for Indian-English accents (e.g. "Eblu").
    # Keep the wake prompt short — a long list of commands gives the LM more
    # material to loop on when audio is ambiguous.
    prompt = (
        "Hey Blue."
        if not is_command else
        "Play music, skip, pause, volume up, what time is it."
    )
    segs, _ = model.transcribe(
        audio,
        language="en",
        beam_size=5,
        best_of=5,
        temperature=0.0,
        condition_on_previous_text=False,
        vad_filter=False,           # we already gated on webrtcvad; don't double-filter
        initial_prompt=prompt,
        no_speech_threshold=0.6,    # return "" rather than hallucinate on silence
        log_prob_threshold=-0.8,    # drop low-confidence output
        compression_ratio_threshold=1.8,  # reject repetitive loops (play music×50)
    )
    return " ".join(s.text for s in segs).strip()


# ── Speech segment collector ──────────────────────────────────────────────────

def collect_segment(silence_limit: int, max_frames: int) -> bytes | None:
    """
    Pull frames from _audio_q until `silence_limit` consecutive silent frames
    follow at least one voiced frame, or `max_frames` total are collected.

    While TTS is speaking, drain the queue without accumulating (prevents
    echo feedback from triggering a false wake word).

    Returns concatenated PCM bytes, or None if no voice was detected.
    """
    vad      = get_vad()
    frames   = []
    silent   = 0
    voiced   = False

    while len(frames) < max_frames:
        if _speaking.is_set():
            # Drain stale audio while TTS plays; reset collection state
            while True:
                try:
                    _audio_q.get_nowait()
                except queue.Empty:
                    break
            frames = []
            silent = 0
            voiced = False
            time.sleep(0.02)
            continue

        try:
            frame = _audio_q.get(timeout=0.05)
        except queue.Empty:
            continue

        # webrtcvad is strict about frame size; drop malformed frames
        if len(frame) != FRAME_BYTES:
            continue

        frames.append(frame)

        try:
            is_speech = vad.is_speech(frame, SAMPLE_RATE)
        except Exception:
            is_speech = False

        if is_speech:
            voiced = True
            silent = 0
        else:
            silent += 1
            if voiced and silent >= silence_limit:
                break   # clean end of utterance

    return b"".join(frames) if voiced else None


# ── TTS backends ──────────────────────────────────────────────────────────────

def _tts_pyttsx3_worker():
    """Dedicated thread for pyttsx3 (must init and run on same thread)."""
    import pyttsx3  # type: ignore
    engine = pyttsx3.init()
    engine.setProperty("rate", 170)
    # Prefer a natural-sounding voice on Windows (Zira, natural, Hazel…)
    voices = engine.getProperty("voices") or []
    for v in voices:
        name = (v.name or "").lower()
        if any(k in name for k in ("zira", "natural", "hazel", "aria")):
            engine.setProperty("voice", v.id)
            break

    while True:
        text = _tts_q.get()
        if text is None:
            break
        _speaking.set()
        try:
            engine.say(text)
            engine.runAndWait()
        except Exception as exc:
            print(f"[voice] pyttsx3 error: {exc}", flush=True)
        finally:
            _speaking.clear()


def _tts_edge_worker():
    """edge-tts → PyAV MP3 decode → sounddevice playback. No temp files, no subprocess."""
    import io
    import av          # type: ignore  (installed with faster-whisper)
    import numpy as np # type: ignore
    import sounddevice as sd # type: ignore

    async def _speak_async(text: str):
        import edge_tts  # type: ignore
        chunks: list[bytes] = []
        # edge-tts 7.x removed the codec kwarg; stream() always returns MP3
        comm = edge_tts.Communicate(text, EDGE_VOICE)
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        if not chunks:
            return

        # Decode MP3 bytes → float32 PCM via PyAV
        raw_mp3 = b"".join(chunks)
        buf = io.BytesIO(raw_mp3)
        pcm_frames: list[np.ndarray] = []
        sample_rate = 24_000
        with av.open(buf, format="mp3") as container:
            audio_st = next((s for s in container.streams if s.type == "audio"), None)
            if audio_st is None:
                return
            sample_rate = audio_st.sample_rate
            for frame in container.decode(audio_st):
                arr = frame.to_ndarray()          # (channels, samples) float32 planar
                if arr.ndim == 2:
                    arr = arr.mean(axis=0)        # mix to mono
                pcm_frames.append(arr.astype(np.float32))

        if not pcm_frames:
            return
        audio = np.concatenate(pcm_frames)
        sd.play(audio, samplerate=sample_rate)
        sd.wait()

    while True:
        text = _tts_q.get()
        if text is None:
            break
        _speaking.set()
        try:
            asyncio.run(_speak_async(text))
        except Exception as exc:
            print(f"[voice] edge-tts error: {exc}", flush=True)
        finally:
            _speaking.clear()


def _tts_win32_worker():
    """No-dependency TTS via Windows PowerShell SpeechSynthesizer."""
    import subprocess

    while True:
        text = _tts_q.get()
        if text is None:
            break
        _speaking.set()
        try:
            safe = re.sub(r"[\"'`]", "", text)[:500]
            ps = (
                "Add-Type -AssemblyName System.Speech; "
                f"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                f"$s.Speak('{safe}')"
            )
            subprocess.run(
                ["powershell", "-WindowStyle", "Hidden", "-NonInteractive", "-c", ps],
                capture_output=True, timeout=90,
            )
        except Exception as exc:
            print(f"[voice] win32 TTS error: {exc}", flush=True)
        finally:
            _speaking.clear()


def speak(text: str):
    """Queue text for asynchronous TTS playback."""
    _tts_q.put(text)


def _start_tts_worker():
    workers = {
        "edge":   _tts_edge_worker,
        "win32":  _tts_win32_worker,
        "pyttsx3": _tts_pyttsx3_worker,
    }
    fn = workers.get(TTS_ENGINE, _tts_pyttsx3_worker)
    t = threading.Thread(target=fn, daemon=True, name="tts-worker")
    t.start()
    return t


# ── HTTP server: /health + /speak ─────────────────────────────────────────────

class DaemonHandler(BaseHTTPRequestHandler):
    def _j(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode())
        except Exception:
            return {}

    def do_GET(self):
        if self.path == "/health":
            self._j(200, {"ok": True, "state": _state["value"], "model": WHISPER_MODEL, "tts": TTS_ENGINE})
        else:
            self._j(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        body = self._body()
        if self.path == "/speak":
            text = (body.get("text") or "").strip()
            if text:
                speak(text)
            self._j(200, {"ok": True})
        else:
            self._j(404, {"ok": False, "error": "unknown path"})

    def log_message(self, *_):
        pass  # suppress default stdout logging


# ── Blue server communication ─────────────────────────────────────────────────

def query_blue(message: str) -> dict:
    payload = json.dumps({"message": message}).encode()
    req = urllib.request.Request(
        f"{BLUE_URL}/api/voice/input",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except Exception as exc:
        print(f"[voice] Blue query error: {exc}", flush=True)
        return {"reply": "I couldn't reach Blue right now."}


# ── Mic capture thread ────────────────────────────────────────────────────────

def _mic_thread(device):
    import sounddevice as sd  # type: ignore

    dev = int(device) if device not in (None, "", "default") else None

    def callback(indata, frames, time_info, status):
        try:
            _audio_q.put_nowait(bytes(indata))
        except queue.Full:
            pass  # drop frame rather than block

    with sd.RawInputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
        blocksize=FRAME_SAMPLES,
        device=dev,
        callback=callback,
    ):
        print("[voice] Microphone open. Listening for 'Hey Blue'...", flush=True)
        while True:
            time.sleep(1)


# ── Main recognition loop ─────────────────────────────────────────────────────

def recognition_loop():
    while True:
        set_state("idle")

        # 1. Collect a short segment for wake-word detection
        seg = collect_segment(SILENCE_WAKE, MAX_WAKE)
        if seg is None:
            continue

        # 2. Energy gate — skip Whisper entirely if audio is too quiet.
        #    Background hiss and room noise pass VAD but are far below real speech.
        energy = _rms(seg)
        if energy < MIN_SPEECH_RMS:
            continue  # silent segment; don't waste a Whisper call

        # 3. Transcribe and check for wake phrase
        set_state("detecting")
        try:
            raw_text = transcribe(seg)
        except Exception as exc:
            print(f"[voice] Transcription error: {exc}", flush=True)
            continue

        lower = raw_text.lower()
        # Always log what Whisper heard — helps diagnose recognition issues
        print(f"[voice] heard: {raw_text!r}", flush=True)
        if not any(p in lower for p in WAKE_PHRASES):
            continue

        # ── Wake word detected ────────────────────────────────────────────────
        # Extract any suffix that follows the wake phrase in the same utterance
        suffix = raw_text.strip()
        for phrase in WAKE_PHRASES:
            idx = suffix.lower().find(phrase)
            if idx != -1:
                suffix = suffix[idx + len(phrase):].lstrip(" ,.")
                break

        print(f"[voice] Wake! raw={raw_text!r}  suffix={suffix!r}", flush=True)
        set_state("listening")

        # Brief acknowledgment cue
        speak("Mm?")

        # 4. Decide where to get the command text
        if len(suffix.split()) >= 2:
            # User included the command in the same breath as the wake phrase
            command = suffix
        else:
            # Wait for a separate command utterance
            cmd_seg = collect_segment(SILENCE_CMD, MAX_CMD)
            if not cmd_seg or len(cmd_seg) < FRAME_BYTES * 8:
                set_state("idle")
                continue

            set_state("transcribing")
            try:
                command = transcribe(cmd_seg, is_command=True)
                # Strip repeated wake phrase prefix ("hey blue play…" → "play…")
                command = re.sub(r"^hey[,\s]*blue[!.,]?\s*", "", command, flags=re.I).strip()
            except Exception as exc:
                print(f"[voice] Command transcription error: {exc}", flush=True)
                speak("I didn't catch that — try again.")
                continue

        if not command:
            speak("I didn't catch that.")
            continue

        print(f"[voice] Command: {command!r}", flush=True)
        set_state("processing")

        # 5. Send to Blue, speak the reply
        response = query_blue(command)
        reply = (response.get("reply") or "").strip() or "Something went wrong."

        print(f"[voice] Reply: {reply!r}", flush=True)
        set_state("speaking")
        speak(reply)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    mode = "wake+tts" if WAKE_ENABLED else "tts-only"
    print(f"[voice] Blue Voice Daemon  mode={mode}  tts={TTS_ENGINE}  port={DAEMON_PORT}", flush=True)

    # HTTP server so Node can push /speak requests
    http_srv = ThreadingHTTPServer(("127.0.0.1", DAEMON_PORT), DaemonHandler)
    threading.Thread(target=http_srv.serve_forever, daemon=True, name="http").start()
    print(f"[voice] HTTP -> http://127.0.0.1:{DAEMON_PORT}", flush=True)

    # TTS worker (dedicated thread — required by pyttsx3)
    _start_tts_worker()

    if not WAKE_ENABLED:
        # No mic, no Whisper. Daemon just serves /speak for spoken replies.
        # The UI's voice chat button uses browser SpeechRecognition independently.
        set_state("tts-only")
        print("[voice] Wake word disabled (BLUE_VOICE_WAKE=0). Use the UI voice chat button to talk to Blue.", flush=True)
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            print("\n[voice] Shutting down.", flush=True)
            _tts_q.put(None)
            http_srv.shutdown()
        return

    print(f"[voice] model={WHISPER_MODEL}  device={VOICE_DEVICE or 'default'}", flush=True)

    # Pre-warm Whisper so the first wake word is instant
    threading.Thread(target=get_whisper, daemon=True, name="whisper-warmup").start()

    # Microphone capture
    threading.Thread(target=_mic_thread, args=(VOICE_DEVICE,), daemon=True, name="mic").start()

    # Recognition loop runs on the main thread
    try:
        recognition_loop()
    except KeyboardInterrupt:
        print("\n[voice] Shutting down.", flush=True)
        _tts_q.put(None)
        http_srv.shutdown()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Blue audio-analysis sidecar.

A tiny HTTP server that Blue's Node app calls to extract BPM + key + energy
+ beat grid from a track. Downloads via yt-dlp when given a URL, or analyzes
a local file directly.

Endpoints
---------
GET  /health                     {ok: true, version}
POST /analyze {"url"|"file_path"} -> analysis JSON
POST /download {"url"}            -> {ok, file_path}

Analysis payload shape
----------------------
{
  "ok": true,
  "duration_sec": 213.4,
  "bpm": 128.0,
  "beats_sec": [0.5, 0.97, 1.43, ...],
  "key": "Cm",
  "camelot": "5A",
  "rms_energy": 0.18,
  "spectral_centroid_hz": 2210.5
}

Setup
-----
  python -m venv .venv-audio
  .venv-audio\\Scripts\\pip install librosa numpy soundfile yt-dlp
  .venv-audio\\Scripts\\python scripts/audio_analyzer.py
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".blue-audio-cache"
CACHE_DIR.mkdir(exist_ok=True)
PORT = int(os.environ.get("BLUE_AUDIO_PORT", "4178"))
HOST = "127.0.0.1"
VERSION = "0.1"

# ── Lazy import so /health works even if librosa isn't installed yet ─────
def _lazy_librosa():
    import librosa  # noqa: F401
    return librosa

def _lazy_numpy():
    import numpy as np
    return np


# ── Camelot wheel mapping ─────────────────────────────────────────────────
# Standard musical key → Camelot notation, used by DJs for harmonic mixing.
KEY_TO_CAMELOT = {
    "B":  "1B",  "G#m": "1A",  "Abm": "1A",
    "F#": "2B",  "Gb":  "2B",  "D#m": "2A",  "Ebm": "2A",
    "Db": "3B",  "C#":  "3B",  "A#m": "3A",  "Bbm": "3A",
    "Ab": "4B",  "Fm":  "4A",
    "Eb": "5B",  "D#":  "5B",  "Cm":  "5A",
    "Bb": "6B",  "A#":  "6B",  "Gm":  "6A",
    "F":  "7B",  "Dm":  "7A",
    "C":  "8B",  "Am":  "8A",
    "G":  "9B",  "Em":  "9A",
    "D":  "10B", "Bm":  "10A",
    "A":  "11B", "F#m": "11A", "Gbm": "11A",
    "E":  "12B", "C#m": "12A", "Dbm": "12A",
}

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def estimate_key(y, sr) -> tuple[str, str]:
    """Krumhansl-Schmuckler key estimation via chroma. Cheap, ~80% accurate
    on pop/electronic; good enough as a DJ-mode hint, not a music-theory tool."""
    librosa = _lazy_librosa()
    np = _lazy_numpy()

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, bins_per_octave=36)
    chroma_mean = chroma.mean(axis=1)

    major_profile = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor_profile = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    best_score = -1.0
    best_key = "C"
    best_mode = "major"
    for i in range(12):
        rolled = np.roll(chroma_mean, -i)
        for profile, mode in ((major_profile, "major"), (minor_profile, "minor")):
            score = float(np.corrcoef(rolled, profile)[0, 1])
            if score > best_score:
                best_score = score
                best_key = PITCH_NAMES[i]
                best_mode = mode
    key_label = best_key + ("m" if best_mode == "minor" else "")
    camelot = KEY_TO_CAMELOT.get(key_label, "")
    return key_label, camelot


def analyze_file(file_path: str) -> dict:
    librosa = _lazy_librosa()
    np = _lazy_numpy()

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    # librosa 0.10 returns scalar tempo; older versions return ndarray
    bpm = float(tempo) if np.isscalar(tempo) else float(tempo[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    rms = float(np.mean(librosa.feature.rms(y=y)))
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    key_label, camelot = estimate_key(y, sr)

    return {
        "ok": True,
        "duration_sec": round(duration, 2),
        "bpm": round(bpm, 1),
        "beats_sec": [round(t, 3) for t in beat_times[:512]],  # cap so JSON stays manageable
        "key": key_label,
        "camelot": camelot,
        "rms_energy": round(rms, 4),
        "spectral_centroid_hz": round(centroid, 1),
    }


def cache_path_for(url: str) -> Path:
    h = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return CACHE_DIR / f"{h}.m4a"


def download(url: str) -> str:
    """Download via yt-dlp, audio-only, m4a. Cache by URL hash."""
    target = cache_path_for(url)
    if target.exists():
        return str(target)
    if not shutil.which("yt-dlp"):
        raise RuntimeError("yt-dlp not on PATH. Install with: pip install yt-dlp")
    cmd = [
        "yt-dlp",
        "--quiet", "--no-warnings",
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "-o", str(target),
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0 or not target.exists():
        # yt-dlp may have written under a different extension; resolve glob
        for ext in ("m4a", "webm", "mp3", "opus"):
            alt = target.with_suffix(f".{ext}")
            if alt.exists():
                return str(alt)
        raise RuntimeError(f"yt-dlp failed: {proc.stderr.strip()[:200] or proc.stdout.strip()[:200]}")
    return str(target)


# ── HTTP server ──────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "version": VERSION, "cache_dir": str(CACHE_DIR)})
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            body = self._read_json()
            if self.path == "/download":
                url = (body.get("url") or "").strip()
                if not url:
                    return self._send(400, {"ok": False, "error": "url required"})
                fp = download(url)
                return self._send(200, {"ok": True, "file_path": fp})
            if self.path == "/analyze":
                fp = (body.get("file_path") or "").strip()
                url = (body.get("url") or "").strip()
                if not fp and url:
                    fp = download(url)
                if not fp:
                    return self._send(400, {"ok": False, "error": "url or file_path required"})
                if not Path(fp).exists():
                    return self._send(404, {"ok": False, "error": f"file not found: {fp}"})
                result = analyze_file(fp)
                result["file_path"] = fp
                return self._send(200, result)
            return self._send(404, {"ok": False, "error": "not found"})
        except Exception as e:
            return self._send(500, {"ok": False, "error": str(e)})

    def log_message(self, format, *args):
        # Quieter than default
        sys.stderr.write(f"[audio] {self.address_string()} {format % args}\n")


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Blue audio sidecar on http://{HOST}:{PORT}", flush=True)
    print(f"Cache dir: {CACHE_DIR}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()

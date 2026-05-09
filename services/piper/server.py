"""Piper TTS HTTP server using the Python API (supports DirectML GPU on Windows).

Endpoints
---------
POST /synthesize          – returns a complete WAV file (backward-compatible)
POST /tts/synthesize      – streams raw int16LE PCM per sentence; headers carry
                            X-Sample-Rate, X-Channels, X-Bit-Depth
GET  /health              – {"status": "ok"}
POST /shutdown            – graceful shutdown

Environment variables
---------------------
PIPER_VOICES_DIR      Path to directory containing .onnx voice model files.
PIPER_USE_DIRECTML    Set to "1" to enable DirectML GPU acceleration (Windows).
PIPER_DIRECTML_DEVICE DirectML device index (default: 0).
"""

import asyncio
import io
import logging
import os
import signal
import wave
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from piper.voice import PiperVoice
from piper.config import SynthesisConfig

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI()

# ── Configuration ────────────────────────────────────────────────────────────

_VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", r"C:\Programme\piper\voices")
_USE_DML    = os.environ.get("PIPER_USE_DIRECTML",   "0") == "1"
_DML_DEVICE = int(os.environ.get("PIPER_DIRECTML_DEVICE", "0"))

_MODELS = {
    "high":      os.path.join(_VOICES_DIR, "de_DE-thorsten-high.onnx"),
    "emotional": os.path.join(_VOICES_DIR, "de_DE-thorsten_emotional-medium.onnx"),
}

# Speaker IDs for "emotional" model only:
#  0=Fröhlich  1=Wütend  2=Angewidert  3=Betrunken
#  4=Neutral   5=Schläfrig  6=Überrascht  7=Flüsternd

# ── Model loading (once at startup) ─────────────────────────────────────────

VOICES: dict[str, PiperVoice] = {}

@app.on_event("startup")
def _load_voices() -> None:
    provider = "DirectML" if _USE_DML else "CPU"
    log.info("Loading Piper voices with %s provider …", provider)
    for name, path in _MODELS.items():
        if not os.path.exists(path):
            log.warning("Model not found, skipping: %s", path)
            continue
        VOICES[name] = PiperVoice.load(
            path,
            use_directml=_USE_DML,
            directml_device_id=_DML_DEVICE,
        )
        log.info("Loaded voice '%s' from %s", name, path)
    if not VOICES:
        raise RuntimeError(f"No voice models found in {_VOICES_DIR}")

# ── Request schema ───────────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text:         str
    model:        str   = "emotional"
    speaker_id:   int   = 4
    length_scale: float = Field(default=1.0,   ge=0.1, le=3.0)
    noise_scale:  float = Field(default=0.667, ge=0.0, le=1.0)
    noise_w_scale: float = Field(default=0.8,  ge=0.0, le=1.0)

def _get_voice(model: str) -> PiperVoice:
    voice = VOICES.get(model) or VOICES.get(next(iter(VOICES)))
    if voice is None:
        raise HTTPException(status_code=503, detail="No voice model loaded")
    return voice

def _syn_config(req: TTSRequest, voice: PiperVoice) -> SynthesisConfig:
    speaker_id = req.speaker_id if voice.config.num_speakers > 1 else None
    return SynthesisConfig(
        speaker_id=speaker_id,
        length_scale=req.length_scale,
        noise_scale=req.noise_scale,
        noise_w_scale=req.noise_w_scale,
    )

# ── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/synthesize")
async def synthesize(req: TTSRequest) -> Response:
    """Return a complete WAV file (backward-compatible with previous server)."""
    voice = _get_voice(req.model)
    syn   = _syn_config(req, voice)

    buf = io.BytesIO()
    wav_file: wave.Wave_write = wave.open(buf, "wb")
    first = True
    with wav_file:
        for chunk in voice.synthesize(req.text, syn):
            if first:
                wav_file.setframerate(chunk.sample_rate)
                wav_file.setsampwidth(chunk.sample_width)
                wav_file.setnchannels(chunk.sample_channels)
                first = False
            wav_file.writeframes(chunk.audio_int16_bytes)

    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.post("/tts/synthesize")
async def synthesize_stream(req: TTSRequest) -> StreamingResponse:
    """Stream raw int16LE PCM per sentence as it is synthesized.

    Response headers:
        X-Sample-Rate   e.g. 22050
        X-Channels      1  (always mono)
        X-Bit-Depth     16
    """
    voice = _get_voice(req.model)
    syn   = _syn_config(req, voice)

    sample_rate = voice.config.sample_rate

    async def _generate() -> AsyncGenerator[bytes, None]:
        loop = asyncio.get_running_loop()
        gen = voice.synthesize(req.text, syn)
        _DONE = object()

        def _next_chunk():
            # StopIteration must NOT cross the Future boundary (PEP 479) —
            # catch it here inside the thread and return a sentinel instead.
            try:
                return next(gen)
            except StopIteration:
                return _DONE

        while True:
            chunk = await loop.run_in_executor(None, _next_chunk)
            if chunk is _DONE:
                break
            yield chunk.audio_int16_bytes

    return StreamingResponse(
        _generate(),
        media_type="application/octet-stream",
        headers={
            "X-Sample-Rate": str(sample_rate),
            "X-Channels":    "1",
            "X-Bit-Depth":   "16",
        },
    )


@app.get("/health")
async def health() -> dict:
    loaded = list(VOICES.keys())
    return {"status": "ok", "voices": loaded, "directml": _USE_DML}


@app.post("/shutdown")
async def shutdown() -> dict:
    os.kill(os.getpid(), signal.SIGINT)
    return {"status": "shutting down"}

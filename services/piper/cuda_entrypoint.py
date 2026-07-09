"""CUDA/Linux entrypoint shim for the Piper TTS server.

The Windows deployment loads voices through a DirectML fork of ``piper-tts``
whose ``PiperVoice.load()`` accepts ``use_directml`` / ``directml_device_id``.
DirectML does not exist on Linux, so the container installs *upstream*
``piper-tts`` (which exposes ``use_cuda`` instead) plus ``onnxruntime-gpu``.

This module monkeypatches ``PiperVoice.load`` to translate the DirectML kwargs
into the upstream CUDA flag and then re-exports the **unmodified** FastAPI app
so it can be served with ``uvicorn cuda_entrypoint:app``. ``server.py`` itself
stays byte-for-byte identical to the Windows version.

Behaviour:
  * ``PIPER_USE_DIRECTML=0`` (the Linux default) → DirectML stays off.
  * CUDA is enabled when ``PIPER_USE_CUDA=1`` (default). If no CUDA execution
    provider is available, onnxruntime transparently falls back to CPU — Piper
    is light enough that CPU still works, just slower.
"""

import os

from piper.voice import PiperVoice

_orig_load = PiperVoice.load


def _load_cuda(model_path, *args, use_directml=False, directml_device_id=0, **kwargs):
    # DirectML flags are meaningless on Linux. Enable CUDA when either the
    # (legacy) DirectML switch was on or PIPER_USE_CUDA is set (default on).
    use_cuda = bool(use_directml) or os.environ.get("PIPER_USE_CUDA", "1") == "1"
    try:
        return _orig_load(model_path, *args, use_cuda=use_cuda, **kwargs)
    except TypeError:
        # Upstream build without a `use_cuda` parameter → load with defaults.
        return _orig_load(model_path, *args, **kwargs)


PiperVoice.load = staticmethod(_load_cuda)

# Import AFTER patching so server.py's startup handler uses the patched loader.
from server import app  # noqa: E402,F401  (re-exported for uvicorn)

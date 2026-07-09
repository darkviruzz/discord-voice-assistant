# Piper TTS — CUDA/Linux build.
#
# The Windows host uses a DirectML fork of piper-tts. Linux has no DirectML, so
# this image installs *upstream* piper-tts + onnxruntime-gpu and bridges the API
# difference (use_directml → use_cuda) in cuda_entrypoint.py. server.py is
# unchanged.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIPER_USE_DIRECTML=0 \
    PIPER_USE_CUDA=1 \
    PIPER_VOICES_DIR=/voices

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip espeak-ng ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# requirements.txt pins fastapi/uvicorn. piper-tts + onnxruntime-gpu are the
# Linux/CUDA counterpart of the Windows DirectML fork and are installed here so
# the Windows requirements.txt stays the source of truth for that platform.
COPY requirements.txt ./
RUN pip3 install --upgrade pip \
    && pip3 install -r requirements.txt "piper-tts>=1.3.0" \
    && (pip3 uninstall -y onnxruntime || true) \
    && pip3 install onnxruntime-gpu

COPY server.py cuda_entrypoint.py ./

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
    CMD curl -fsS http://localhost:5000/health || exit 1

CMD ["python3", "-m", "uvicorn", "cuda_entrypoint:app", "--host", "0.0.0.0", "--port", "5000"]

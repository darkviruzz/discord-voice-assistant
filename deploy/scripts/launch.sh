#!/usr/bin/env bash
# One entrypoint that adapts to the host environment ("self-start, anywhere").
#
#   Linux + NVIDIA GPU   → CUDA docker stack (this deploy/), via start.sh
#   Windows / AMD GPU    → use the native stack: scripts/Start-VoiceAssistant.ps1
#   AMD GPU on Linux     → not bundled yet (see README); current AMD path is PS1
#   No GPU               → guidance for CPU-only testing
#
# The orchestration server and the .env config schema are identical across
# profiles; only the STT/LLM/TTS backends differ per environment.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(uname -s)" != "Linux" ]; then
  echo "Non-Linux host detected."
  echo "On the Windows/AMD desktop use the native stack:"
  echo "    powershell -File scripts/Start-VoiceAssistant.ps1"
  exit 0
fi

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  echo "NVIDIA GPU detected → starting the CUDA docker stack."
  exec "$SCRIPT_DIR/start.sh" "$@"
fi

if [ -e /dev/kfd ] || command -v rocminfo >/dev/null 2>&1; then
  echo "AMD ROCm GPU detected on Linux."
  echo "The supported AMD profile is the native stack (Start-VoiceAssistant.ps1 on"
  echo "Windows). AMD-on-Linux (ROCm images in Docker) is not bundled yet — ask to"
  echo "add it and I will build ollama:rocm + a Vulkan whisper image + CPU piper."
  exit 1
fi

echo "No supported GPU detected on this Linux host."
echo "The stack expects an NVIDIA GPU + NVIDIA Container Toolkit. For CPU-only"
echo "smoke tests, override the images with CPU variants (see deploy/README.md)."
exit 1

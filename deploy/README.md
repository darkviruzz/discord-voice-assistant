# Cloud GPU Deployment

Containerised, reproducible deployment of the **server-side** voice-assistant
stack for **temporary** GPU cloud instances (RunPod / Vast.ai / TensorDock).
Spin an instance up for a session (~6 h/week), run the stack, copy the
transcripts off, destroy the instance.

The **bot stays local** (Linux/systemd, `apps/bot/`) and connects to the server
over a WireGuard/Tailscale tunnel — see [Networking](#networking). Nothing in
this stack is exposed to the public internet.

```
                 home network                    │   GPU cloud instance
  ┌───────────────────────────────┐              │  ┌──────────────────────────┐
  │ Proxmox (control plane)        │   WireGuard  │  │ docker compose (deploy/)  │
  │  └─ discord-bot (systemd) ─────┼──────────────┼─▶│  server :7440             │
  │     SERVER_BASE_URL=wg-ip:7440 │   tunnel     │  │   ├─ whisper :8080 (CUDA) │
  └───────────────────────────────┘              │  │   ├─ ollama  :11434       │
                                                  │  │   ├─ piper   :5000 (CUDA) │
                                                  │  │   └─ (rag    Phase 4)     │
                                                  │  └──────────────────────────┘
```

The instance does **not** join the Proxmox cluster (Corosync over the internet
is fragile). It is just a Docker host reachable over the tunnel.

---

## Prerequisites on the instance

- NVIDIA GPU + driver
- Docker + Compose v2 with the **NVIDIA Container Toolkit** (`nvidia-ctk`)
  configured so `docker run --gpus all` works
- WireGuard (`wg`) or Tailscale

Quick GPU sanity check:

```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

---

## Quick start

```bash
git clone <repo> && cd discord-voice-assistant/deploy

# 1. Configure
cp .env.example .env
#   - set CONTROL_BEARER (openssl rand -hex 32) — must match the bot's .env
#   - set SERVER_BIND to the instance's WireGuard IP once the tunnel is up
# Optional: full server tuning (wake word, finalize, live-context, …)
cp ../apps/server/.env.example server.env   # loaded as an optional env_file

# 2. Start (builds images, downloads models on first run, waits for health)
./scripts/start.sh

# 3. Health any time
./scripts/healthcheck.sh

# 4. Before destroying the instance: stop + back up session data
./scripts/stop.sh                      # keeps model volumes
./scripts/stop.sh --backup /mnt/out    # custom backup target
./scripts/stop.sh --purge              # also drop model/voice volumes
```

`start.sh` is idempotent: models already on the persistent volumes are not
re-downloaded, so subsequent starts on the **same** instance are fast. A
**fresh** instance always re-downloads (volumes are local to the instance).

---

## Services

| Service | Image / build                         | Port  | GPU | Notes |
|---------|---------------------------------------|-------|-----|-------|
| whisper | `deploy/whisper/Dockerfile` (CUDA)    | 8080  | ✅  | whisper.cpp HTTP server, built from source |
| ollama  | `ollama/ollama:latest`                | 11434 | ✅  | model pulled on first start |
| piper   | `services/piper/Dockerfile` (CUDA)    | 5000  | ✅  | upstream piper-tts + onnxruntime-gpu |
| server  | `apps/server/Dockerfile` (Node 22)    | 7440  | ❌  | only published port (bind to tunnel) |
| rag     | Phase 4 — placeholder in compose      | —     | —   | `RAG_URL` already wired in the server |

Services talk to each other over the internal `voice` network by name
(`http://whisper:8080`, `http://ollama:11434`, `http://piper:5000`). The server
reads those URLs from environment variables set in `docker-compose.yml`.

### whisper image: build-from-source vs. official

The stack **builds whisper.cpp from source** (`deploy/whisper/Dockerfile`,
`-DGGML_CUDA=ON`) so the `whisper-server` binary sits at a known path and the
stack runs on any instance unchanged. First build takes a few minutes.

To use the official image instead, edit `docker-compose.yml`: comment the
whisper `build:` block and uncomment the `image:` / `entrypoint:` / `command:`
lines (`ghcr.io/ggml-org/whisper.cpp:main-cuda`). Verify the server binary is on
`PATH` for the tag you pick.

### piper: DirectML → CUDA

The Windows build uses a DirectML fork of `piper-tts`. Linux has no DirectML, so
the image installs **upstream `piper-tts` + `onnxruntime-gpu`** and bridges the
API (`use_directml` → `use_cuda`) in `services/piper/cuda_entrypoint.py`.
`services/piper/server.py` is unchanged and runs with `PIPER_USE_DIRECTML=0`. If
no CUDA provider is available, onnxruntime falls back to CPU (Piper is light).

---

## Models

Downloaded to **persistent named volumes** on first `start.sh` (kept small
images, load once):

| Volume          | Content |
|-----------------|---------|
| `whisper-models`| `${WHISPER_MODEL_FILE}` (default `ggml-medium-q5_0.bin`) |
| `piper-voices`  | `de_DE-thorsten-high` + `de_DE-thorsten_emotional-medium` (`.onnx` + `.onnx.json`) |
| `ollama-models` | `${OLLAMA_MODEL}` pulled via `ollama pull` |

Change models in `.env` (`WHISPER_MODEL_FILE`, `OLLAMA_MODEL`). To swap an
Ollama model on a running stack:

```bash
docker compose -p va exec ollama ollama pull <model>
```

Output volumes copied off the instance by `stop.sh`:

| Volume        | Content |
|---------------|---------|
| `transcripts` | finalize uploads (`/data/uploads`) |
| `archive`     | long-term audio + transcript archive (`/data/archive`) |

---

## GPU assignment & the staging plan

Every GPU service requests an NVIDIA GPU; **which physical GPU** each uses is set
per-service via `*_VISIBLE_DEVICES` in `.env` (mapped to `NVIDIA_VISIBLE_DEVICES`
in compose). `GPU_TYPE` is documentation only — it switches nothing.

| Phase | Hardware        | Ollama        | Whisper | Piper | Idea |
|-------|-----------------|---------------|---------|-------|------|
| 1     | RTX 4090 (24 GB)| `0`           | `0`     | `0`   | infra + STT/TTS + small LLM (4–8B) |
| 2     | 2× A100 80 GB   | `0,1`         | `0`     | `0`   | 120B model sharded; rest on GPU 0 |
| 3     | H200 141 GB     | `0`           | `0`     | `0`   | 120B on one GPU, less sharding |

Example (Phase 2) in `.env`:

```ini
GPU_TYPE=a100x2
OLLAMA_VISIBLE_DEVICES=0,1
WHISPER_VISIBLE_DEVICES=0
PIPER_VISIBLE_DEVICES=0
OLLAMA_MODEL=<your-120b-model>
```

No compose edits needed between phases — only `.env`.

---

## Networking

Only the **server** port is published, and it should be bound to the tunnel
interface, never `0.0.0.0` on a public IP. Set `SERVER_BIND` in `.env` to the
instance's WireGuard IP (e.g. `10.10.0.2`). Default `127.0.0.1` keeps it
host-local until the tunnel is up.

### Option A — WireGuard

On the instance, `/etc/wireguard/wg0.conf`:

```ini
[Interface]
# Instance address inside the tunnel
Address = 10.10.0.2/24
PrivateKey = <INSTANCE_PRIVATE_KEY>
ListenPort = 51820

[Peer]
# Home gateway (Proxmox / router running WireGuard)
PublicKey = <HOME_PUBLIC_KEY>
Endpoint  = <HOME_PUBLIC_IP_OR_DDNS>:51820
AllowedIPs = 10.10.0.0/24
PersistentKeepalive = 25
```

On the home side, add the instance as a peer:

```ini
[Peer]
# GPU cloud instance
PublicKey = <INSTANCE_PUBLIC_KEY>
AllowedIPs = 10.10.0.2/32
```

Bring it up and verify:

```bash
sudo wg-quick up wg0
wg show
```

Then set `SERVER_BIND=10.10.0.2` in `.env` and (re)run `./scripts/start.sh`.

Generate a keypair:

```bash
wg genkey | tee privatekey | wg pubkey > publickey
```

> The instance dials **out** to the home endpoint (`PersistentKeepalive`), so no
> inbound port on the cloud provider is required.

### Option B — Tailscale (lighter)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                 # authenticate once
tailscale ip -4                   # → e.g. 100.x.y.z
```

Set `SERVER_BIND=100.x.y.z` in `.env`. `start.sh` detects an active tunnel
either way.

### Bot side (home, unchanged)

The bot's only change is where it points — no code change:

```ini
# apps/bot/.env
SERVER_BASE_URL=ws://10.10.0.2:7440      # WireGuard IP (or 100.x.y.z Tailscale)
CONTROL_BEARER=<same secret as deploy/.env>
```

---

## Data privacy

Only the audio chunks and (Phase 4) RAG results needed for a request leave the
home network over the tunnel. The Obsidian vault and Nextcloud stay local; the
future `apps/rag/` service is expected to send **chunks only**. Transcripts and
the audio archive live on instance volumes and are pulled back by `stop.sh`
before the instance is destroyed.

---

## What is NOT changed

- `apps/bot/` — unchanged, runs locally as a systemd service
- `apps/server/src/` and `services/piper/server.py` — unchanged (only Docker
  packaging around them)
- `.env` configuration — identical keys; only service URLs differ (point at
  internal service names / tunnel IPs)
- `scripts/Start-VoiceAssistant.ps1` — stays for local Windows operation

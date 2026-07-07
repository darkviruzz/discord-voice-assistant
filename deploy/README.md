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

The **AI-server bundles server + STT + LLM + TTS** and runs wherever you point
it. The orchestration server and the `.env` schema are identical everywhere;
only the GPU backend changes per environment.

---

## Deployment profiles (same config, different backend)

| Profile | Host | GPU backend | How to start | Self-start |
|---------|------|-------------|--------------|------------|
| **Cloud / Linux + NVIDIA** | rented GPU instance | whisper CUDA · ollama CUDA · piper CUDA | `./scripts/launch.sh` → `start.sh` | compose `restart: unless-stopped` + healthcheck wait |
| **Desktop / Windows + AMD** (current) | your desktop (RX 6800 XT) | whisper Vulkan · ollama · piper DirectML | `scripts/Start-VoiceAssistant.ps1` | the PS1 checks each port and starts what's down |

`scripts/launch.sh` auto-detects the environment: NVIDIA on Linux → the CUDA
docker stack; Windows → it tells you to use the PowerShell stack. **Nothing in
the new cloud work touches the desktop path** — `apps/server/src`,
`services/piper/server.py`, and `Start-VoiceAssistant.ps1` are unchanged, so the
desktop keeps working exactly as today.

> **Why AMD uses the native stack:** an AMD GPU can't be passed into Docker on
> Windows (no CUDA, no DirectML-in-container, no ROCm-on-Windows). So on the
> desktop the bundle is the existing native processes, not containers. If you
> ever move the desktop to **Linux**, I can add an AMD-on-Linux docker profile
> (`ollama:rocm` + a Vulkan whisper image + CPU piper) — ask and I'll build it.

The data source/sink config below is shared by both profiles: on the desktop you
point the paths at local folders (your OneDrive/Nextcloud client syncs them); in
the cloud you let `start.sh`/`stop.sh` pull/push via rclone.

---

## Choosing a provider

Two design goals drive the choice: **portability** (what you debug on a cheap
GPU must run unchanged on a big one) and **security** (no public exposure,
ideally EU jurisdiction for the P&P data).

**Portability is solved by version-pinned images, not by the provider.** CI
publishes `va-server` / `va-piper` / `va-whisper` to GHCR; you pin `IMAGE_TAG`
and `docker compose pull` the *exact same bytes* on any host — RTX 4090 today,
H100/H200 next month. See [Portable images](#portable-images-the-transfer-guarantee).

That leaves one real decision: **does the host give you a Docker daemon?**

| Model | Providers | Compose runs as-is? | WireGuard (kernel) | Notes |
|-------|-----------|--------------------|--------------------|-------|
| **Real VM / root + Docker** ✅ recommended | **TensorDock**, **DataCrunch/Verda** (EU 🇫🇮), **Hetzner** (EU 🇩🇪), Lambda, Paperspace Core | **Yes** — `compose pull && up` | Yes | Maximum portability + control; this `deploy/` stack works directly |
| **Container pod (no Docker-in-Docker)** | RunPod, Vast.ai | No (needs one bundled image) | No (use Tailscale userspace) | Cheapest 4090s, but not the recommended path here |

### Recommendation

1. **Iterate cheap on TensorDock RTX 4090 (~$0.35/hr).** Root VM + Docker
   pre-installed → this Compose stack runs with zero changes; real WireGuard
   works. Validate the whole pipeline here.
2. **Scale on the same provider** to A100 (~$0.75–0.95/hr) / H100 (~$1.99–2.25/hr)
   for the 120B model — *same image tag, same compose, no rework.*
3. **If EU data residency matters** (it likely does for the campaign data —
   you're on a `uni-jena.de` address): prefer **DataCrunch/Verda** (Finland) or
   **Hetzner** (Germany/Finland, GDPR by default). Both are real-VM hosts, so
   the workflow is identical.

> Prices are early-2026 ballparks and move constantly — check the live page
> before you launch. H200 availability is thinner than H100/A100; if your Phase 3
> target GPU is unavailable, H100 80GB is the practical large tier.

RunPod/Vast stay viable if you want the absolute cheapest compute, but they
need a single bundled image + Tailscale-in-userspace instead of WireGuard. Ask
and I'll add that image target; it's intentionally **not** the default because
it trades portability and the simple WireGuard story for ~$0.30/hr.

---

## Portable images (the transfer guarantee)

CI (`.github/workflows/build-images.yml`) builds and pushes three images to GHCR
on every push to the deploy branch and on `v*` tags:

```
ghcr.io/darkviruzz/discord-voice-assistant/va-server:<tag>
ghcr.io/darkviruzz/discord-voice-assistant/va-piper:<tag>
ghcr.io/darkviruzz/discord-voice-assistant/va-whisper:<tag>
```

On the target host you **pull instead of build** — fast, and bit-for-bit
identical across GPU tiers:

```bash
# deploy/.env
REGISTRY=ghcr.io/darkviruzz/discord-voice-assistant
IMAGE_TAG=v1.4.1        # pin a release/SHA, not "latest", for reproducibility

docker compose pull && docker compose up -d
```

`start.sh` still works for build-on-host; pulling is just faster and guarantees
the cheap-GPU test == big-GPU run. Make GHCR packages private and log in once
per instance with a read-only PAT (`docker login ghcr.io`) — see Security below.

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

By default `start.sh` **pulls** the version-pinned images CI already published
to GHCR (seconds, no compile) — this is what makes a fresh instance fast too.
Pass `./scripts/start.sh --build` to compile from source instead (only needed
when iterating on `deploy/whisper/Dockerfile` or `services/piper/Dockerfile`
themselves).

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

## Campaign data (in) & finished output (out)

Both endpoints are **configurable and optional**, local or cloud, via `rclone`
(Nextcloud = WebDAV, OneDrive, S3, …). Persistent campaign data and transcripts
never need to *live* on the rented instance — they pass through it for the
session and land back in your own storage.

```
                 start.sh (pull)            stop.sh (push)
  CAMPAIGN_REMOTE ───rclone──▶ campaign vol      transcripts+archive vols ──rclone──▶ OUTPUT_REMOTE
  (nextcloud:DnD/Campaign)      (server reads,    (server writes)            (nextcloud:DnD/Sessions)
                                 read-only)
```

Configure once, then it's automatic:

```bash
rclone config                                  # create remotes: nextcloud / onedrive / …
cp ~/.config/rclone/rclone.conf deploy/rclone.conf

# deploy/.env
RCLONE_CONFIG=./rclone.conf
CAMPAIGN_REMOTE=nextcloud:DnD/Campaign         # pulled on start (empty = skip)
CAMPAIGN_CONTEXT_FILE=CAMPAIGN.md              # file the LLM context is read from
OUTPUT_REMOTE=nextcloud:DnD/Sessions           # pushed on stop  (empty = skip)
```

- **Empty values = pure-local.** On the **desktop** leave them empty and point
  the server's paths at local folders; your OneDrive/Nextcloud *client* syncs
  them. Same config keys, no rclone needed.
- **Set values = cloud.** On an **ephemeral instance**, `start.sh` pulls the
  campaign folder into the read-only `campaign` volume and `stop.sh` pushes
  `transcripts`/`archive` to `OUTPUT_REMOTE` before you destroy the box. `stop.sh`
  also keeps a local tarball backup regardless.

`rclone.conf` holds credentials — it's git-ignored; mount it read-only and treat
it like a secret.

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

#### Zero-touch: Verda startup script

Verda instances support a "startup script" that runs automatically on first
boot (`verda startup-script add` or via the dashboard). `deploy/scripts/gen-verda-startup.sh`
generates one that brings up the WireGuard tunnel, clones the repo, writes
`deploy/.env`, logs into GHCR, and runs `start.sh` — so a fresh instance is
fully healthy by the time you SSH in, no manual setup at all.

The generator itself holds no secrets (safe to commit); it reads them from
env vars and bakes them into its *output*, which you must **not** commit:

```bash
WG_PRIVATE_KEY=...      # reuse the SAME key across instances — see below
WG_HOME_PUBKEY=...      # Proxmox's public key (from `wg show` on the instance)
WG_ENDPOINT=yourdomain.myfritz.net:51820 \
GH_USER=... GH_PAT=...  # read:packages + repo scope, give it a real expiry
CONTROL_BEARER=...      # must match apps/bot/.env
IMAGE_TAG=...           \
./deploy/scripts/gen-verda-startup.sh > verda-startup.sh
```

Paste `verda-startup.sh`'s content into Verda's startup-script field. Reuse
the **same** `WG_PRIVATE_KEY` on every regeneration — that's what lets
Proxmox's peer entry stay untouched forever; only its matching public key
needs to be registered on Proxmox once (see "Bot side" below).

> **Security note:** Verda's startup scripts are stored as plain text (no
> encrypted secret store) — same trust tier as the SSH key already living
> there. Rotate `GH_PAT` periodically and scope it to `read:packages` only.

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

### Web UI access (live transcripts)

The server also serves a small web UI (live transcript view, bubble-flow
layout) on the same port, at `/transcript` — no separate port or container.
It's protected by HTTP Basic auth (`TRANSCRIPT_UI_USER`/`_PASS` in
`deploy/server.env`, default `greyhawk`/`greyhawk`; `TRANSCRIPT_UI_AUTH=off`
disables auth entirely).

`10.10.0.2` only exists inside the WireGuard tunnel, so a browser on the home
LAN can't reach it directly — same problem as the bot container earlier.
Since the bot host already has a route to `10.10.0.0/24` (see the container
routing fix above), reuse it: run a small nginx reverse proxy **on the bot
host**, bound to its LAN IP, forwarding to the tunnel IP:

```bash
# on the bot host (e.g. 192.168.20.21):
sudo apt-get update && sudo apt-get install -y nginx

sudo tee /etc/nginx/sites-available/va-transcript <<'EOF'
server {
    listen 192.168.20.21:7440;

    location / {
        proxy_pass http://10.10.0.2:7440;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_buffering off;        # SSE (/transcript/live) must not be buffered
        proxy_read_timeout 3600s;   # keep long-lived SSE connections open
    }
}
EOF

sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/va-transcript /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx && sudo systemctl enable nginx
```

Then browse to `http://192.168.20.21:7440/transcript/` from anywhere on the
home LAN. No per-instance changes needed — the tunnel IP (`10.10.0.2`) is
fixed regardless of which GPU instance is behind it.

> **Before exposing this beyond the home LAN** (e.g. via an existing
> Cloudflared tunnel + your own domain): change `TRANSCRIPT_UI_USER`/`_PASS`
> away from the `greyhawk`/`greyhawk` default first. Basic auth over a public
> Cloudflared hostname with default credentials is publishing an open login.

---

## Security checklist

Ephemeral cloud instances are only as safe as their exposure surface. The stack
is built so that, done right, **nothing is reachable from the public internet**.

- **No public ports.** Only the server's `7440` is published, and `SERVER_BIND`
  pins it to the WireGuard/Tailscale IP. Never set `SERVER_BIND=0.0.0.0` on a
  public IP. The internal `voice` network keeps whisper/ollama/piper unreachable
  from outside the host entirely.
- **Provider firewall.** Close everything except your WireGuard UDP port (and
  SSH, ideally key-only and IP-restricted) in the provider's firewall/security
  group as a second layer.
- **Bearer secret.** `CONTROL_BEARER` (uplink + control WS) must be a long random
  value (`openssl rand -hex 32`), identical in `deploy/.env` and the bot.
- **Prefer a dedicated machine.** On marketplace/community tiers you may share a
  physical host. For the campaign data, prefer real-VM hosts and, ideally, EU
  jurisdiction (DataCrunch/Verda, Hetzner).
- **Private images.** Keep the GHCR packages private; `docker login ghcr.io` on
  the instance with a **read-only** Personal Access Token (`read:packages`).
- **Web UI credentials.** Before exposing `/transcript` beyond the home LAN
  (Cloudflared or any other public tunnel), change `TRANSCRIPT_UI_USER`/`_PASS`
  away from the `greyhawk`/`greyhawk` default — see "Web UI access" above.
- **Destroy, don't just stop.** After a session, pull the data back (`stop.sh`)
  and **terminate** the instance so no disk lingers on the provider. Persist only
  the model volume (no session data) if you want fast restarts.
- **Data minimisation.** Only per-request audio chunks and (Phase 4) RAG chunks
  leave home — see below.

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

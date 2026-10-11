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

## The `va` CLI (one entry point for every deploy)

`deploy/va` wraps all of the above behind one command
(contract: `docs/deploy-architecture.md`):

```bash
va local  up|down|status|logs   [--profile cuda|windows-native] [--ref R]
va remote up|down|status|logs|ssh [--slot prod|test] [--ref R] [--image-tag T] [--dry-run]
va bot    update|switch R|status|logs      # run ON the bot host
va env    show [--profile P] [--slot S]    # effective layered env, secrets masked
```

- **`va local up`** — this machine. `cuda` merges the env layers into
  `deploy/.env` and runs `start.sh` (same path the instance takes);
  `windows-native` (auto-picked on Windows) delegates to `deploy/va.ps1`,
  which wraps `scripts/Start-VoiceAssistant.ps1`.
- **`va remote up --slot test --ref feat/x`** — boots a parallel test
  instance with that branch; prod keeps running. `va remote down --slot test`
  destroys it again.
- **`va bot switch feat/x`** — checkout + `npm ci` + restart on the bot host.
  Works because all secrets/host config live OUTSIDE the worktree in
  `~/.config/va/deploy.env` (layering: flags/process env → deploy.env →
  `deploy/env/<profile>.env` → `deploy/.env.example`).

---

## Choosing a provider

Two design goals drive the choice: **portability** (what you debug on a cheap
GPU must run unchanged on a big one) and **security** (no public exposure,
ideally EU jurisdiction for the P&P data).

**Portability is solved by version-pinned images, not by the provider.** CI
publishes `va-server` / `va-rag` / `va-piper` / `va-whisper` to GHCR; you pin `IMAGE_TAG`
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

CI (`.github/workflows/build-images.yml`) builds and pushes four images to GHCR
on every branch push (`branch-<slug>` tags) and on `v*` tags — see the tag
scheme in `docs/deploy-architecture.md`:

```
ghcr.io/darkviruzz/discord-voice-assistant/va-server:<tag>
ghcr.io/darkviruzz/discord-voice-assistant/va-rag:<tag>
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
the cheap-GPU test == big-GPU run. Repo and GHCR packages are public since
2026-07 — pulls and clones are anonymous, no PAT anywhere. (If you ever flip
them private again, set `GH_USER`/`GH_PAT` in `~/.config/va/deploy.env` and the
startup script re-enables `docker login` + credentialed clone automatically.)

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

Output volumes copied off the instance by `stop.sh` (now the manual fallback —
the finished `archive` is pulled back to the bot host automatically after each
finalize, see [Data privacy](#data-privacy)):

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

#### Zero-touch: Verda startup script (dynamic, per launch)

Verda instances support a "startup script" that runs automatically on first
boot. You do **not** manage these by hand anymore: `cloud-start.sh` generates
one per launch (via `deploy/scripts/gen-verda-startup.sh`), registers it
through `POST /v1/scripts` as `va-<slot>-<slug>-<epoch>`, boots the instance
with it, and afterwards deletes older `va-<slot>-*` scripts. The script brings
up the WireGuard tunnel, clones the requested git ref, writes `deploy/.env`
(with the matching image tag), and runs `start.sh` — a fresh instance is fully
healthy by the time you could SSH in.

Because registration happens per launch, deploying a branch or a new release
needs **no dashboard visit and no re-registration ritual** — the old
`VERDA_STARTUP_SCRIPT_ID` config knob is gone entirely. Inputs come from the
per-host env file `~/.config/va/deploy.env` (see the launch section below).

Reuse the **same** WireGuard key per slot forever (`VA_WG_KEY_PROD` /
`VA_WG_KEY_TEST`) — that's what lets Proxmox's peer entries stay untouched;
only each slot's public key is registered on Proxmox once (see "Bot side").

> **Security note:** Verda's startup scripts are stored as plain text (no
> encrypted secret store) — same trust tier as the SSH key already living
> there. With the repo and GHCR packages public, no `GH_PAT` is baked in at
> all (anonymous clone + pull); only the WireGuard key and `CONTROL_BEARER`
> remain in that store, and both are rotatable without touching the repo.
> Inspect what gets baked with `cloud-start.sh --dry-run` — it prints the
> generated script with every secret value replaced by `«redacted»` and makes
> no API calls.

#### Bot-triggered launch (`SERVER_START_CMD`)

The bot already has a generic "start the server if it's offline" hook
(`SERVER_START_CMD` in `apps/bot/.env`, see `apps/bot/src/serverAutoStart.js`):
on `/join`, if `SERVER_BASE_URL` isn't reachable, it runs that command
fire-and-forget, then polls until reachable or `SERVER_START_TIMEOUT_MS`
elapses. `deploy/scripts/cloud-start.sh` is built to be that command for the
Verda path — it launches a fresh instance via the Verda Cloud API, so the bot
can bring its own server up with no manual step.

Configuration lives in the per-host deploy env file `~/.config/va/deploy.env`
(chmod 0600, **outside the worktree** so branch switches never touch it;
override the path with `VA_DEPLOY_ENV`). Process/systemd env always wins over
the file — the file only fills gaps, so the same script works under the bot's
systemd unit and standalone over SSH. Full schema in
`docs/deploy-architecture.md`; the essentials:

```ini
# Verda API (console.verda.com -> Keys)
VERDA_CLIENT_ID=...
VERDA_CLIENT_SECRET=...
VERDA_SSH_KEY_ID=...              # one-time: register your pubkey, note the ID
# Fixed per-slot WireGuard identities (NEVER rotate without updating the Proxmox peer)
VA_WG_KEY_PROD=...                # legacy fallback name: WG_PRIVATE_KEY
VA_WG_KEY_TEST=...                # only needed once you use --slot test
WG_HOME_PUBKEY=...
WG_ENDPOINT=yourdomain.myfritz.net:51820
CONTROL_BEARER=...                # must match apps/bot/.env
# Optional knobs (defaults shown):
#VERDA_LOCATION_PREFIX=FIN        # only locations starting with this (FIN-01/02/03 all match)
#VERDA_OS_IMAGE=ubuntu-22.04-cuda-12.4-docker  # bare "ubuntu-22.04" has no CUDA/docker and fails mid-bootstrap
#VERDA_OS_VOLUME_SIZE_GB=100
#VERDA_MIN_VRAM_GB=24
#VERDA_MAX_HOURLY=1.00            # refuses to launch above this — no silent overspend
#VERDA_ALLOW_SPOT=false           # true = rank by spot_price instead of on-demand price
```

**Slots** — a slot is a fixed remote identity; prod and test can run in
parallel (test a feature branch while the group plays on prod):

| Slot | Hostname | Tunnel IP | WG key |
|---|---|---|---|
| `prod` (default) | `va-gpu` | `10.10.0.2` | `VA_WG_KEY_PROD` |
| `test` | `va-gpu-test` | `10.10.0.3` | `VA_WG_KEY_TEST` |

**Refs** — any git ref is deployable; the image tag is derived automatically
(`main` → `latest`, `vX.Y.Z` → itself, branch → `branch-<slug>`, matching what
CI publishes; override with `--image-tag`):

```bash
./deploy/scripts/cloud-start.sh                                  # prod, main, latest
./deploy/scripts/cloud-start.sh --slot test --ref feat/my-branch # parallel branch test
# or, same thing through the CLI wrapper:
./deploy/va remote up --slot test --ref feat/my-branch
./deploy/va remote status --slot test    # instance state + tunnel reachability
./deploy/va remote down --slot test      # destroy when done testing
```

> **Currency caveat:** the API has been observed returning `usd` for an
> instance type the Verda dashboard shows in `eur` for the same SKU/location —
> `VERDA_MAX_HOURLY` is compared against whatever currency that specific type
> reports (logged on every run), it is not currency-normalized. Check the
> logged currency, don't assume it matches the dashboard's display currency.

Safety properties baked in: **idempotent** (won't create a second instance if
one with `VERDA_HOSTNAME` is already running/provisioning — safe against a
double `/join`); **location-scoped** (only considers instance types actually
orderable — via `GET /v1/instance-availability` — in a location matching
`VERDA_LOCATION_PREFIX`, which is also why the unscoped instance-types listing
shows SKUs you can't actually order from FIN); **on-demand by default**
(ranked by `price_per_hour` and `is_spot` sent as `false`, unless
`VERDA_ALLOW_SPOT=true` switches ranking to `spot_price` and sends `is_spot: true`);
and **price-capped** (picks the cheapest qualifying type, then aborts instead of
launching if that price exceeds `VERDA_MAX_HOURLY`). Test with
`cloud-start.sh --dry-run` first — it prints the exact API payload without
creating anything, and re-sourcing your env file before each `--dry-run` run
is all that's needed to pick up config changes (no service restart required
for manual testing — that's only for when `SERVER_START_CMD` runs through the
bot's systemd environment, see below).

Then in `apps/bot/.env`:

```ini
SERVER_START_CMD=/path/to/deploy/scripts/cloud-start.sh
SERVER_START_TIMEOUT_MS=300000    # cold boot: provisioning + startup script + image pull, ~3 min observed
```

> Field names in `cloud-start.sh` (`instance_type`, `gpu_memory.size_in_gigabytes`,
> `price_per_hour`, `ssh_key_ids`, `startup_script_id`, …) were verified
> against live Verda API responses (2026-07). The `POST /v1/scripts` response
> shape is parsed defensively (`.id` / `.script.id`) — if Verda changes it,
> the error message includes the raw (secret-redacted) body.

#### Bot-triggered shutdown (`SERVER_STOP_CMD`)

The counterpart to the above: `deploy/scripts/cloud-stop.sh` is built to be
`SERVER_STOP_CMD` — once a session ends, the bot waits `SERVER_STOP_DELAY_MS`
of idle time and then runs this command to tear the instance back down, so a
finished session doesn't keep billing until someone remembers to destroy it
by hand. Idempotent like `cloud-start.sh`: it finds every Verda instance whose
hostname **exactly** matches the slot's (`va-gpu` for prod — a running
`va-gpu-test` is never touched) in a running/provisioning/ordered state and
destroys each one it finds; if none match, it logs that and exits 0, so it's
safe to call speculatively. Same `--slot` flag as `cloud-start.sh`; no
arguments means prod, so the bot's config stays a bare script path.

```ini
SERVER_STOP_CMD=/path/to/deploy/scripts/cloud-stop.sh
SERVER_STOP_DELAY_MS=900000       # default: 15 min idle after session end
```

The bot cancels the pending stop if a new `/join` comes in, or if a finalize
is still in flight, during that delay window — so a quick reconnect or a slow
transcript upload never gets its server destroyed out from under it. Test
with `cloud-stop.sh --dry-run` first — it reports which instance(s) it would
destroy without calling the delete API.

> **This permanently destroys the instance, not just stops it.** Verda bills
> for the instance and its disk regardless of power state, so per "Destroy,
> don't just stop" above, `cloud-stop.sh` deletes it outright — there is no
> paused state to resume, and the next `/join` cold-boots a brand new instance
> via `cloud-start.sh`. Data safety for that destruction: session transcript
> events already stream to the bot host live during the session (not just at
> the end), and the archive pull-back after a successful finalize brings the
> full audio/transcript bundle back to the bot host automatically
> (`BOT_ARCHIVE_DIR`, default `~/archive`) — `deploy/scripts/stop.sh --backup`
> is now only a manual pre-destroy fallback for anything left on the volumes
> outside that flow (e.g. a session that was never finalized).

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
- **Destroy, don't just stop.** The finished archive and live transcript already
  made it back to the bot host automatically (see [Data privacy](#data-privacy));
  after a session, **terminate** the instance so no disk lingers on the provider —
  `stop.sh --backup` remains the manual fallback for anything else left on the
  volumes. Persist only the model volume (no session data) if you want fast
  restarts.
- **Data minimisation.** Only per-request audio chunks and (Phase 4) RAG chunks
  leave home — see below.

---

## Data privacy

Only the audio chunks and (Phase 4) RAG results needed for a request leave the
home network over the tunnel. The Obsidian vault and Nextcloud stay local; the
future `apps/rag/` service is expected to send **chunks only**. Live transcript
events stream to the bot host throughout the session (not just at the end),
and the finished audio archive is pulled back there automatically right after
a successful finalize (`BOT_ARCHIVE_DIR`, default `~/archive`, each file
sha256-verified). `stop.sh --backup` remains a manual fallback for anything
left on the instance volumes before it's destroyed.

---

## What is NOT changed

- `apps/bot/` — unchanged, runs locally as a systemd service
- `apps/server/src/` and `services/piper/server.py` — unchanged (only Docker
  packaging around them)
- `.env` configuration — identical keys; only service URLs differ (point at
  internal service names / tunnel IPs)
- `scripts/Start-VoiceAssistant.ps1` — stays for local Windows operation

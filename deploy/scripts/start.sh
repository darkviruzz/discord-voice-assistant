#!/usr/bin/env bash
# Start the voice-assistant stack on a fresh GPU cloud instance.
#   - sanity-check the WireGuard/Tailscale tunnel
#   - bring the Compose stack up
#   - download models/voices on first run (persistent volumes → only once)
#   - wait for every service to report healthy
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

PROJECT="${COMPOSE_PROJECT_NAME:-va}"
COMPOSE=(docker compose -p "$PROJECT")

# Model sources (overridable via .env).
HF="https://huggingface.co"
WHISPER_MODEL_URL_DEFAULT="$HF/ggerganov/whisper.cpp/resolve/main"
PIPER_VOICE_BASE="$HF/rhasspy/piper-voices/resolve/main/de/de_DE"

c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_cyan=$'\033[36m'; c_off=$'\033[0m'
step() { printf '%s==>%s %s\n' "$c_cyan" "$c_off" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$c_yellow" "$c_off" "$*" >&2; }
die()  { printf '%s[err]%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

# ── 0. Preconditions ─────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"
[ -f "$DEPLOY_DIR/.env" ] || die "deploy/.env missing — copy deploy/.env.example and set CONTROL_BEARER"
# shellcheck disable=SC1091
set -a; . "$DEPLOY_DIR/.env"; set +a
[ -n "${CONTROL_BEARER:-}" ] || die "CONTROL_BEARER is empty in deploy/.env"

WHISPER_MODEL_FILE="${WHISPER_MODEL_FILE:-ggml-medium-q5_0.bin}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2}"
WHISPER_MODEL_URL="${WHISPER_MODEL_URL:-$WHISPER_MODEL_URL_DEFAULT/$WHISPER_MODEL_FILE}"

# ── 1. Tunnel check (soft) ───────────────────────────────────────────────────
step "Checking VPN tunnel (WireGuard / Tailscale)"
if command -v wg >/dev/null 2>&1 && wg show 2>/dev/null | grep -q interface; then
  ok "WireGuard interface up: $(wg show interfaces 2>/dev/null)"
elif command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  ok "Tailscale up: $(tailscale ip -4 2>/dev/null | head -n1)"
else
  warn "No WireGuard/Tailscale tunnel detected."
  warn "SERVER_BIND=${SERVER_BIND:-127.0.0.1} — the bot can only reach the server over the tunnel."
fi

# ── 2. Download models onto the persistent volumes (first run only) ──────────
vol_has() { # vol_has <volume> <relpath>
  docker run --rm -v "${PROJECT}_$1:/v" alpine:latest test -s "/v/$2" 2>/dev/null
}
fetch_to_vol() { # fetch_to_vol <volume> <relpath> <url>
  local vol="$1" rel="$2" url="$3"
  if vol_has "$vol" "$rel"; then ok "$rel already present"; return; fi
  step "Downloading $rel"
  docker run --rm -v "${PROJECT}_$vol:/v" alpine:latest sh -c \
    "mkdir -p \"/v/\$(dirname '$rel')\" && wget -q -O '/v/$rel' '$url'" \
    || die "download failed: $url"
  ok "fetched $rel"
}

step "Ensuring models/voices are present"
# whisper.cpp model
fetch_to_vol whisper-models "$WHISPER_MODEL_FILE" "$WHISPER_MODEL_URL"
# Piper voices (.onnx + .onnx.json)
fetch_to_vol piper-voices "de_DE-thorsten-high.onnx" \
  "$PIPER_VOICE_BASE/thorsten/high/de_DE-thorsten-high.onnx"
fetch_to_vol piper-voices "de_DE-thorsten-high.onnx.json" \
  "$PIPER_VOICE_BASE/thorsten/high/de_DE-thorsten-high.onnx.json"
fetch_to_vol piper-voices "de_DE-thorsten_emotional-medium.onnx" \
  "$PIPER_VOICE_BASE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx"
fetch_to_vol piper-voices "de_DE-thorsten_emotional-medium.onnx.json" \
  "$PIPER_VOICE_BASE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx.json"

# ── 2b. Pull campaign data into the campaign volume (local or remote) ────────
# CAMPAIGN_REMOTE empty  → use whatever is already in the campaign volume
#                          (bind a local dir, or copy files in manually).
# CAMPAIGN_REMOTE set     → rclone copy from e.g. nextcloud:DnD/Campaign or
#                          onedrive:DnD/Campaign, using RCLONE_CONFIG.
pull_campaign() {
  if [ -z "${CAMPAIGN_REMOTE:-}" ]; then
    ok "No CAMPAIGN_REMOTE set — using the campaign volume as-is"
    return
  fi
  [ -f "${RCLONE_CONFIG:-}" ] || die "RCLONE_CONFIG not found: ${RCLONE_CONFIG:-<unset>}"
  step "Pulling campaign data from $CAMPAIGN_REMOTE"
  docker run --rm \
    -v "$(readlink -f "$RCLONE_CONFIG"):/config/rclone/rclone.conf:ro" \
    -v "${PROJECT}_campaign:/data" \
    rclone/rclone copy "$CAMPAIGN_REMOTE" /data --transfers=8 \
    || die "campaign pull failed (check rclone remote + RCLONE_CONFIG)"
  ok "campaign data synced into volume"
}
pull_campaign

# ── 3. Build + start ─────────────────────────────────────────────────────────
step "Building images (first run may take a while: whisper.cpp CUDA build)"
"${COMPOSE[@]}" build

step "Starting Ollama and pulling model: $OLLAMA_MODEL"
"${COMPOSE[@]}" up -d ollama
# Ollama runs without a model; pull into the persistent volume.
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T ollama ollama list >/dev/null 2>&1 && break
  sleep 2
done
"${COMPOSE[@]}" exec -T ollama ollama pull "$OLLAMA_MODEL" || warn "ollama pull failed — pull manually later"

step "Starting the full stack"
"${COMPOSE[@]}" up -d

# ── 4. Wait for health ───────────────────────────────────────────────────────
step "Waiting for services to become healthy"
if "$SCRIPT_DIR/healthcheck.sh" --wait; then
  ok "All services healthy."
  "${COMPOSE[@]}" ps
  printf '\n%sServer reachable at%s %s:%s (bind: %s)\n' \
    "$c_green" "$c_off" "${SERVER_BIND:-127.0.0.1}" "${SERVER_PORT:-7440}" "${SERVER_BIND:-127.0.0.1}"
  printf 'Point the bot SERVER_BASE_URL at the WireGuard IP of this instance.\n'
else
  warn "Some services are not healthy yet — check: ${COMPOSE[*]} logs -f"
  exit 1
fi

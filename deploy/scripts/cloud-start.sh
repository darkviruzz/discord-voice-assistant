#!/usr/bin/env bash
# Launches a fresh Verda GPU instance for the voice-assistant stack. Meant to
# be wired in as the bot's SERVER_START_CMD (apps/bot/.env — see
# apps/bot/.env.example): the bot runs this fire-and-forget when it needs a
# server and none is reachable, then polls SERVER_BASE_URL itself until the
# WireGuard tunnel + stack come up (the tunnel IP is fixed, so nothing here
# needs to report an IP back to the bot).
#
# Safety properties:
#   - Idempotent: skips creation if an instance with VERDA_HOSTNAME already
#     exists in a running/provisioning/ordered state (no duplicate billing
#     from a double /join or a retry).
#   - Price-capped: picks the CHEAPEST instance type that meets the VRAM
#     floor, then aborts (does not launch) if that price exceeds
#     VERDA_MAX_HOURLY — never silently pays more than expected.
#
# Requires: curl, jq
#
# One-time setup (see deploy/README.md):
#   verda ssh-key add            # your existing pubkey -> VERDA_SSH_KEY_ID
#   verda startup-script add     # output of gen-verda-startup.sh -> VERDA_STARTUP_SCRIPT_ID
#
# Config (env vars — put in e.g. deploy/verda.env and source it before
# running, or export in the environment the bot/systemd unit runs under):
#   VERDA_CLIENT_ID / VERDA_CLIENT_SECRET   Cloud API credentials
#                                            (console.verda.com, under Keys)
#   VERDA_SSH_KEY_ID          from `verda ssh-key add`
#   VERDA_STARTUP_SCRIPT_ID   from `verda startup-script add`
#   VERDA_LOCATION            default FIN-01
#   VERDA_HOSTNAME            default va-gpu       — identity for idempotency
#   VERDA_OS_IMAGE            default ubuntu-22.04 — verify the exact image
#                             name against `verda instance-types`/console
#                             before relying on this unattended
#   VERDA_MIN_VRAM_GB         default 24  — filters out GPUs too small for
#                             the stack (whisper medium + ollama model)
#   VERDA_MAX_HOURLY          default 1.00 — same currency the API returns
#                             (usually eur/usd per instance type; check the
#                             `currency` field the script logs)
#
# Usage: ./cloud-start.sh [--dry-run]
#
# NOTE: field names below (instance_type, gpu_memory.size_in_gigabytes,
# price_per_hour, currency, hostname, status, ssh_key_ids, startup_script_id)
# are taken from Verda's published API docs, not yet verified against a real
# response. Run with --dry-run first and check the printed payload / a real
# `GET /v1/instance-types` response before wiring this into SERVER_START_CMD.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

: "${VERDA_CLIENT_ID:?set VERDA_CLIENT_ID}"
: "${VERDA_CLIENT_SECRET:?set VERDA_CLIENT_SECRET}"
: "${VERDA_SSH_KEY_ID:?set VERDA_SSH_KEY_ID}"
: "${VERDA_STARTUP_SCRIPT_ID:?set VERDA_STARTUP_SCRIPT_ID}"
VERDA_LOCATION="${VERDA_LOCATION:-FIN-01}"
VERDA_HOSTNAME="${VERDA_HOSTNAME:-va-gpu}"
VERDA_OS_IMAGE="${VERDA_OS_IMAGE:-ubuntu-22.04}"
VERDA_MIN_VRAM_GB="${VERDA_MIN_VRAM_GB:-24}"
VERDA_MAX_HOURLY="${VERDA_MAX_HOURLY:-1.00}"

API="https://api.verda.com/v1"
log() { printf '[cloud-start] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

command -v curl >/dev/null || die "curl not found"
command -v jq >/dev/null || die "jq not found"

# ── 1. Auth ──────────────────────────────────────────────────────────────────
TOKEN=$(curl -fsS -X POST "$API/oauth2/token" \
  -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"${VERDA_CLIENT_ID}\",\"client_secret\":\"${VERDA_CLIENT_SECRET}\",\"grant_type\":\"client_credentials\"}" \
  | jq -r '.access_token // empty') || die "auth request failed"
[ -n "$TOKEN" ] || die "no access_token in auth response — check VERDA_CLIENT_ID/SECRET"
auth() { curl -fsS -H "Authorization: Bearer $TOKEN" "$@"; }

# ── 2. Idempotency: skip if an instance is already up/coming up ────────────
EXISTING=$(auth "$API/instances" \
  | jq -r --arg h "$VERDA_HOSTNAME" \
    '[.[] | select(.hostname == $h and (.status == "running" or .status == "provisioning" or .status == "ordered"))] | .[0].id // empty')
if [ -n "$EXISTING" ]; then
  log "instance '$VERDA_HOSTNAME' already exists (id=$EXISTING) — not creating another"
  exit 0
fi

# ── 3. Pick the cheapest GPU type that meets the VRAM floor ─────────────────
PICK=$(auth "$API/instance-types" \
  | jq -c --argjson minvram "$VERDA_MIN_VRAM_GB" \
    '[.[] | select(.gpu_memory.size_in_gigabytes >= $minvram)] | sort_by(.price_per_hour | tonumber) | .[0] // empty')
[ -n "$PICK" ] || die "no instance type with >= ${VERDA_MIN_VRAM_GB}GB VRAM found"

INSTANCE_TYPE=$(jq -r '.instance_type' <<<"$PICK")
PRICE=$(jq -r '.price_per_hour' <<<"$PICK")
CURRENCY=$(jq -r '.currency' <<<"$PICK")
log "cheapest match: $INSTANCE_TYPE ($(jq -r '.name' <<<"$PICK")) at ${PRICE} ${CURRENCY}/h"

# ── 4. Price safety gate — abort rather than silently overspend ────────────
if awk -v p="$PRICE" -v max="$VERDA_MAX_HOURLY" 'BEGIN { exit !(p > max) }'; then
  die "price ${PRICE} ${CURRENCY}/h exceeds VERDA_MAX_HOURLY=${VERDA_MAX_HOURLY} — refusing to launch. Raise the cap or lower VERDA_MIN_VRAM_GB if that's acceptable."
fi

# ── 5. Create the instance ──────────────────────────────────────────────────
PAYLOAD=$(jq -n \
  --arg it "$INSTANCE_TYPE" --arg img "$VERDA_OS_IMAGE" --arg loc "$VERDA_LOCATION" \
  --arg host "$VERDA_HOSTNAME" --arg sk "$VERDA_SSH_KEY_ID" --arg sid "$VERDA_STARTUP_SCRIPT_ID" \
  '{instance_type:$it, image:$img, location_code:$loc, hostname:$host,
    description:"voice-assistant auto-launch", ssh_key_ids:[$sk], startup_script_id:$sid}')

if [ "$DRY_RUN" = 1 ]; then
  log "DRY RUN — would POST $API/instances with:"
  jq . <<<"$PAYLOAD"
  exit 0
fi

RESP=$(auth -X POST "$API/instances" -H 'Content-Type: application/json' -d "$PAYLOAD")
log "launched: $(jq -r '.id // .' <<<"$RESP")"

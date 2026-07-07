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
#   - Location-scoped: only considers instance types actually orderable in a
#     location starting with VERDA_LOCATION_PREFIX (default FIN — EU
#     jurisdiction), via GET /v1/instance-availability. This is also why the
#     unscoped /v1/instance-types listing shows SKUs you won't see/can't
#     order from the FIN region in the dashboard.
#   - On-demand by default: is_spot is explicitly false unless
#     VERDA_ALLOW_SPOT=true — a spot instance can be pre-empted mid-session.
#   - Price-capped: among the location-filtered, VRAM-qualifying types, tries
#     the CHEAPEST first, skipping any candidate above VERDA_MAX_HOURLY —
#     never silently pays more than expected.
#   - Resilient to transient stock-outs: a "service_unavailable" response
#     (observed in practice, especially for spot — capacity can vanish
#     between the availability check and the actual order) is retried a few
#     times, then falls through to the next-cheapest candidate still under
#     the price cap. Any other error aborts immediately (not transient).
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
#   VERDA_LOCATION_PREFIX     default FIN — restricts candidates to
#                             locations whose code starts with this
#                             (FIN-01/02/03 all match; whichever is cheapest
#                             AND has the type in stock wins)
#   VERDA_HOSTNAME            default va-gpu       — identity for idempotency
#   VERDA_OS_IMAGE            default ubuntu-22.04-cuda-12.4-docker — a bare
#                             "ubuntu-22.04" image has NO nvidia driver/CUDA/
#                             docker preinstalled and will fail at `docker
#                             login` partway through the startup script
#                             (confirmed in testing); verify the exact image
#                             slug via `GET /v1/images` if you change it
#   VERDA_OS_VOLUME_SIZE_GB   default 100 — OS/NVMe disk size
#   VERDA_MIN_VRAM_GB         default 24  — filters out GPUs too small for
#                             the stack (whisper medium + ollama model)
#   VERDA_MAX_HOURLY          default 1.00 — compared against whatever
#                             currency THAT instance type reports (the
#                             `currency` field the script logs) — the API has
#                             been observed returning usd for a type the
#                             Verda dashboard displays in eur for the same
#                             SKU/location, so the cap isn't currency-normalized;
#                             check the logged currency before trusting the cap
#   VERDA_ALLOW_SPOT          default false — ranks candidates by spot_price
#                             instead of price_per_hour when true (spot is
#                             cheaper but the instance can be reclaimed
#                             mid-session; leave off for live play)
#   VERDA_RETRY_ATTEMPTS      default 3 — retries per candidate on a
#                             "service_unavailable" (no capacity) response
#   VERDA_RETRY_DELAY_S       default 5 — seconds between those retries
#
# Usage: ./cloud-start.sh [--dry-run]
# --dry-run prints the payload for the cheapest candidate only (no retry/
# fallback loop — that only matters for the real creation call).
#
# NOTE: field/endpoint names verified against a real Verda API response
# (2026-07). Re-check with --dry-run after any Verda API changes.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

: "${VERDA_CLIENT_ID:?set VERDA_CLIENT_ID}"
: "${VERDA_CLIENT_SECRET:?set VERDA_CLIENT_SECRET}"
: "${VERDA_SSH_KEY_ID:?set VERDA_SSH_KEY_ID}"
: "${VERDA_STARTUP_SCRIPT_ID:?set VERDA_STARTUP_SCRIPT_ID}"
VERDA_LOCATION_PREFIX="${VERDA_LOCATION_PREFIX:-FIN}"
VERDA_HOSTNAME="${VERDA_HOSTNAME:-va-gpu}"
VERDA_OS_IMAGE="${VERDA_OS_IMAGE:-ubuntu-22.04-cuda-12.4-docker}"
VERDA_OS_VOLUME_SIZE_GB="${VERDA_OS_VOLUME_SIZE_GB:-100}"
VERDA_MIN_VRAM_GB="${VERDA_MIN_VRAM_GB:-24}"
VERDA_MAX_HOURLY="${VERDA_MAX_HOURLY:-1.00}"
VERDA_ALLOW_SPOT="${VERDA_ALLOW_SPOT:-false}"

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

# ── 3. Rank ALL GPU types that are (a) orderable in a matching location and
#      (b) meet the VRAM floor, cheapest first ─────────────────────────────
AVAILABILITY=$(auth "$API/instance-availability")
TYPES=$(auth "$API/instance-types")

# When VERDA_ALLOW_SPOT=true, rank by spot_price (and only consider types
# that actually have one) instead of the on-demand price_per_hour — otherwise
# enabling spot never changed the pick, only the is_spot flag sent below.
CANDIDATES=$(jq -n --argjson avail "$AVAILABILITY" --argjson types "$TYPES" \
  --arg prefix "$VERDA_LOCATION_PREFIX" --argjson minvram "$VERDA_MIN_VRAM_GB" \
  --argjson spot "$VERDA_ALLOW_SPOT" '
  ($types | map({(.instance_type): .}) | add) as $bytype
  | [ $avail[] | select(.location_code | startswith($prefix)) | .location_code as $loc
      | .availabilities[] as $it
      | ($bytype[$it]) as $t
      | select($t != null and $t.gpu_memory.size_in_gigabytes >= $minvram)
      | (if $spot then $t.spot_price else $t.price_per_hour end) as $price
      | select($price != null)
      | {location_code: $loc, instance_type: $it, price: $price, currency: $t.currency, name: $t.name}
    ]
  | sort_by(.price | tonumber)
')
NUM_CANDIDATES=$(jq 'length' <<<"$CANDIDATES")
[ "$NUM_CANDIDATES" -gt 0 ] || die "no instance type >= ${VERDA_MIN_VRAM_GB}GB VRAM orderable in a '${VERDA_LOCATION_PREFIX}*' location$([ "$VERDA_ALLOW_SPOT" = true ] && echo ' with spot pricing')"

# ── 4/5. Try candidates cheapest-first. Skip anything over VERDA_MAX_HOURLY.
#         A transient "service_unavailable" (no capacity right now — common
#         for spot) is retried a few times before moving to the next
#         candidate; any other error aborts immediately (not transient). ───
RETRY_ATTEMPTS="${VERDA_RETRY_ATTEMPTS:-3}"
RETRY_DELAY_S="${VERDA_RETRY_DELAY_S:-5}"
auth_raw() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }

CREATED=0
for i in $(seq 0 $((NUM_CANDIDATES - 1))); do
  C=$(jq -c ".[$i]" <<<"$CANDIDATES")
  LOCATION_CODE=$(jq -r '.location_code' <<<"$C")
  INSTANCE_TYPE=$(jq -r '.instance_type' <<<"$C")
  PRICE=$(jq -r '.price' <<<"$C")
  CURRENCY=$(jq -r '.currency' <<<"$C")
  NAME=$(jq -r '.name' <<<"$C")

  if awk -v p="$PRICE" -v max="$VERDA_MAX_HOURLY" 'BEGIN { exit !(p > max) }'; then
    log "skipping $INSTANCE_TYPE in $LOCATION_CODE at ${PRICE} ${CURRENCY}/h — exceeds VERDA_MAX_HOURLY=${VERDA_MAX_HOURLY}"
    continue
  fi

  log "trying $INSTANCE_TYPE ($NAME) in $LOCATION_CODE at ${PRICE} ${CURRENCY}/h ($([ "$VERDA_ALLOW_SPOT" = true ] && echo spot || echo on-demand))"

  PAYLOAD=$(jq -n \
    --arg it "$INSTANCE_TYPE" --arg img "$VERDA_OS_IMAGE" --arg loc "$LOCATION_CODE" \
    --arg host "$VERDA_HOSTNAME" --arg sk "$VERDA_SSH_KEY_ID" --arg sid "$VERDA_STARTUP_SCRIPT_ID" \
    --arg volname "${VERDA_HOSTNAME}-os" \
    --argjson volsize "$VERDA_OS_VOLUME_SIZE_GB" --argjson spot "$VERDA_ALLOW_SPOT" \
    '{instance_type:$it, image:$img, location_code:$loc, hostname:$host,
      description:"voice-assistant auto-launch", ssh_key_ids:[$sk], startup_script_id:$sid,
      os_volume:{name:$volname, size:$volsize}, is_spot:$spot}')

  if [ "$DRY_RUN" = 1 ]; then
    log "DRY RUN — would POST $API/instances with:"
    jq . <<<"$PAYLOAD"
    exit 0
  fi

  for attempt in $(seq 1 "$RETRY_ATTEMPTS"); do
    HTTP_BODY=$(mktemp)
    HTTP_CODE=$(auth_raw -o "$HTTP_BODY" -w '%{http_code}' -X POST "$API/instances" -H 'Content-Type: application/json' -d "$PAYLOAD")
    if [ "$HTTP_CODE" -lt 400 ]; then
      log "launched: $(jq -r '.id // .' "$HTTP_BODY")"
      rm -f "$HTTP_BODY"
      CREATED=1
      break 2
    fi
    ERR_CODE=$(jq -r '.code // empty' "$HTTP_BODY" 2>/dev/null || true)
    ERR_MSG=$(jq -r '.message // empty' "$HTTP_BODY" 2>/dev/null || true)
    rm -f "$HTTP_BODY"
    if [ "$ERR_CODE" = "service_unavailable" ]; then
      log "attempt $attempt/$RETRY_ATTEMPTS: $ERR_MSG — retrying in ${RETRY_DELAY_S}s"
      sleep "$RETRY_DELAY_S"
      continue
    fi
    die "instance creation failed (HTTP $HTTP_CODE): ${ERR_MSG:-${ERR_CODE:-unknown error}}"
  done
  log "$INSTANCE_TYPE in $LOCATION_CODE still unavailable after $RETRY_ATTEMPTS attempts — trying next-cheapest option"
done

[ "$CREATED" = 1 ] || die "no candidate under VERDA_MAX_HOURLY=${VERDA_MAX_HOURLY} could be launched (all out of capacity or above the cap)"

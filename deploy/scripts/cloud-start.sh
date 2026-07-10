#!/usr/bin/env bash
# Launches a fresh Verda GPU instance for the voice-assistant stack. Meant to
# be wired in as the bot's SERVER_START_CMD (apps/bot/.env — see
# apps/bot/.env.example): the bot runs this fire-and-forget when it needs a
# server and none is reachable, then polls SERVER_BASE_URL itself until the
# WireGuard tunnel + stack come up (the tunnel IP is fixed per slot, so nothing
# here needs to report an IP back to the bot).
#
# Slots (a slot is a fixed remote identity — prod and test can run in parallel):
#   --slot prod   (default, also VA_SLOT)  hostname va-gpu      WG 10.10.0.2/24
#                                          key VA_WG_KEY_PROD
#                                          (fallback WG_PRIVATE_KEY)
#   --slot test                            hostname va-gpu-test WG 10.10.0.3/24
#                                          key VA_WG_KEY_TEST
# Called with no arguments it means prod — so the bot's SERVER_START_CMD stays a
# bare path to this script.
#
# Ref / image tag:
#   --ref R        (default main, also VA_REF)  git ref cloned on the instance
#   --image-tag T  (also VA_IMAGE_TAG)          GHCR tag to pull; default is
#                  derived from the ref: main->latest, v*->the ref itself,
#                  otherwise branch-<slug(ref)> (slug rule = docs/deploy-architecture.md).
#
# Startup script (dynamic, per launch — VERDA_STARTUP_SCRIPT_ID is GONE):
#   The startup script is generated in-memory via gen-verda-startup.sh, POSTed
#   to /v1/scripts as va-<slot>-<slug>-<epoch>, its id used for the instance,
#   and after a successful launch every OTHER va-<slot>-* script is deleted
#   (best effort). GH_PAT is optional: set it only for a private repo/GHCR
#   (docker login + credential clone); unset means public anonymous clone.
#
# Env layering: process env / systemd wins; the file $VA_DEPLOY_ENV (default
# ~/.config/va/deploy.env) only fills gaps. See deploy/scripts/lib-env.sh.
#
# Safety properties:
#   - Idempotent: skips creation if an instance with the slot's EXACT hostname
#     already exists in a running/provisioning/ordered state (no duplicate
#     billing). Exact match means va-gpu never counts va-gpu-test and vice
#     versa, so both slots can coexist.
#   - Location-scoped: only considers instance types actually orderable in a
#     location starting with VERDA_LOCATION_PREFIX (default FIN — EU
#     jurisdiction), via GET /v1/instance-availability.
#   - On-demand by default: is_spot is explicitly false unless
#     VERDA_ALLOW_SPOT=true — a spot instance can be pre-empted mid-session.
#   - Price-capped: among the location-filtered, VRAM-qualifying types, tries
#     the CHEAPEST first, skipping any candidate above VERDA_MAX_HOURLY.
#   - Resilient to transient stock-outs: a "service_unavailable" response is
#     retried a few times, then falls through to the next-cheapest candidate
#     still under the price cap. Any other error aborts immediately.
#
# Requires: curl, jq
#
# Config (env vars — put secrets/host overrides in $VA_DEPLOY_ENV, default
# ~/.config/va/deploy.env, chmod 0600):
#   VERDA_CLIENT_ID / VERDA_CLIENT_SECRET   Cloud API credentials (Keys page)
#   VERDA_SSH_KEY_ID          from `verda ssh-key add`
#   VA_WG_KEY_PROD / VA_WG_KEY_TEST   fixed per-slot WireGuard private keys
#   WG_HOME_PUBKEY / WG_ENDPOINT      Proxmox peer pubkey + endpoint host:port
#   CONTROL_BEARER            must match apps/bot/.env on Proxmox
#   GH_USER / GH_PAT          OPTIONAL — only for a private repo/GHCR
#   VERDA_LOCATION_PREFIX     default FIN — location code prefix filter
#   VERDA_OS_IMAGE            default ubuntu-22.04-cuda-12.4-docker — a bare
#                             "ubuntu-22.04" image has NO nvidia driver/CUDA/
#                             docker preinstalled; verify slugs via GET /v1/images
#   VERDA_OS_VOLUME_SIZE_GB   default 100 — OS/NVMe disk size
#   VERDA_MIN_VRAM_GB         default 24  — filters out GPUs too small
#   VERDA_MAX_HOURLY          default 1.00 — compared against whatever currency
#                             THAT instance type reports (NOT currency-normalized;
#                             the API has returned usd where the dashboard shows
#                             eur for the same SKU — check the logged currency)
#   VERDA_ALLOW_SPOT          default false — ranks by spot_price instead of
#                             price_per_hour when true
#   VERDA_RETRY_ATTEMPTS      default 3 — retries per candidate on a
#                             "service_unavailable" (no capacity) response
#   VERDA_RETRY_DELAY_S       default 5 — seconds between those retries
#
# Usage: ./cloud-start.sh [--slot prod|test] [--ref R] [--image-tag T] [--dry-run]
#
# --dry-run makes NO API calls at all (works offline, no reachable Verda API
# and no credentials needed). It generates the startup script and prints BOTH
# the instance payload AND the generated script, with every secret value
# (WireGuard key, CONTROL_BEARER, GH_PAT) replaced by «redacted». Because there
# is no availability query, the candidate is FAKED from --instance-type /
# VERDA_INSTANCE_TYPE (default a placeholder) and VERDA_LOCATION_CODE (default
# <PREFIX>-01) purely to render a representative payload.
#
# NOTE: field/endpoint names verified against a real Verda API response
# (2026-07). The /v1/scripts response shape (POST returns .id or .script.id) is
# parsed defensively. Re-check with --dry-run after any Verda API changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-env.sh
. "$SCRIPT_DIR/lib-env.sh"

API="https://api.verda.com/v1"
log() { printf '[cloud-start] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

command -v curl >/dev/null || die "curl not found"
command -v jq >/dev/null || die "jq not found"

# slug rule — MUST stay identical to docs/deploy-architecture.md (and the CI
# image tags). Do not "improve" it independently.
va_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-40 | sed -E 's/-+$//'
}

# ── 0. Env layering, then flags (flags/process env win over the file) ──────
va_load_env

DRY_RUN=0
SLOT="${VA_SLOT:-prod}"
VA_REF="${VA_REF:-main}"
CLI_IMAGE_TAG=""
CLI_INSTANCE_TYPE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --slot)          SLOT="${2:?--slot needs an argument}"; shift 2 ;;
    --slot=*)        SLOT="${1#*=}"; shift ;;
    --ref)           VA_REF="${2:?--ref needs an argument}"; shift 2 ;;
    --ref=*)         VA_REF="${1#*=}"; shift ;;
    --image-tag)     CLI_IMAGE_TAG="${2:?--image-tag needs an argument}"; shift 2 ;;
    --image-tag=*)   CLI_IMAGE_TAG="${1#*=}"; shift ;;
    --instance-type) CLI_INSTANCE_TYPE="${2:?--instance-type needs an argument}"; shift 2 ;;
    --instance-type=*) CLI_INSTANCE_TYPE="${1#*=}"; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       sed -n '1,120p' "$0" | grep -E '^# ' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               die "unknown argument: $1 (see --help)" ;;
  esac
done

# ── 1. Resolve the slot (hostname, WG address, per-slot WireGuard key) ──────
case "$SLOT" in
  prod) VA_HOSTNAME="va-gpu";      WG_ADDRESS="10.10.0.2/24"; WG_KEY="${VA_WG_KEY_PROD:-${WG_PRIVATE_KEY:-}}" ;;
  test) VA_HOSTNAME="va-gpu-test"; WG_ADDRESS="10.10.0.3/24"; WG_KEY="${VA_WG_KEY_TEST:-}" ;;
  *)    die "unknown slot: $SLOT (use prod or test)" ;;
esac

# ── 2. Resolve the image tag (CLI flag > VA_IMAGE_TAG > derived from ref) ───
if [ -n "$CLI_IMAGE_TAG" ]; then
  IMAGE_TAG="$CLI_IMAGE_TAG"
elif [ -n "${VA_IMAGE_TAG:-}" ]; then
  IMAGE_TAG="$VA_IMAGE_TAG"
else
  case "$VA_REF" in
    main) IMAGE_TAG="latest" ;;
    v*)   IMAGE_TAG="$VA_REF" ;;
    *)    IMAGE_TAG="branch-$(va_slug "$VA_REF")" ;;
  esac
fi

# ── 3. Inputs needed to GENERATE the startup script (dry-run needs these too,
#       but NOT the Verda API credentials) ──────────────────────────────────
[ -n "$WG_KEY" ] || die "no WireGuard key for slot $SLOT — set VA_WG_KEY_$(printf '%s' "$SLOT" | tr a-z A-Z)$([ "$SLOT" = prod ] && printf ' (or legacy WG_PRIVATE_KEY)')"
: "${WG_HOME_PUBKEY:?set WG_HOME_PUBKEY (Proxmox public key)}"
: "${WG_ENDPOINT:?set WG_ENDPOINT (e.g. host.myfritz.net:51820)}"
: "${CONTROL_BEARER:?set CONTROL_BEARER (must match apps/bot/.env on Proxmox)}"
GH_USER="${GH_USER:-}"
GH_PAT="${GH_PAT:-}"

VERDA_LOCATION_PREFIX="${VERDA_LOCATION_PREFIX:-FIN}"
VERDA_OS_IMAGE="${VERDA_OS_IMAGE:-ubuntu-22.04-cuda-12.4-docker}"
VERDA_OS_VOLUME_SIZE_GB="${VERDA_OS_VOLUME_SIZE_GB:-100}"
VERDA_MIN_VRAM_GB="${VERDA_MIN_VRAM_GB:-24}"
VERDA_MAX_HOURLY="${VERDA_MAX_HOURLY:-1.00}"
VERDA_ALLOW_SPOT="${VERDA_ALLOW_SPOT:-false}"

# Mask every real secret value in any text we print (dry-run output, error
# bodies). Empty secrets are skipped so we never blanket-replace "".
redact() {
  local text="$1" s
  for s in "${WG_KEY:-}" "${CONTROL_BEARER:-}" "${GH_PAT:-}"; do
    [ -n "$s" ] && text="${text//"$s"/«redacted»}"
  done
  printf '%s' "$text"
}

# ── 4. Generate the startup-script content (in memory) ─────────────────────
SCRIPT_NAME="va-${SLOT}-$(va_slug "$VA_REF")-$(date +%s)"
SCRIPT_CONTENT=$(
  WG_PRIVATE_KEY="$WG_KEY" \
  WG_HOME_PUBKEY="$WG_HOME_PUBKEY" \
  WG_ENDPOINT="$WG_ENDPOINT" \
  WG_ADDRESS="$WG_ADDRESS" \
  CONTROL_BEARER="$CONTROL_BEARER" \
  GIT_BRANCH="$VA_REF" \
  IMAGE_TAG="$IMAGE_TAG" \
  GH_USER="$GH_USER" \
  GH_PAT="$GH_PAT" \
  "$SCRIPT_DIR/gen-verda-startup.sh"
) || die "startup-script generation failed"

# ── 5. Dry-run: print payload + script (secrets redacted), NO API calls ────
if [ "$DRY_RUN" = 1 ]; then
  DRY_INSTANCE_TYPE="${CLI_INSTANCE_TYPE:-${VERDA_INSTANCE_TYPE:-<instance-type>}}"
  DRY_LOCATION_CODE="${VERDA_LOCATION_CODE:-${VERDA_LOCATION_PREFIX}-01}"
  PAYLOAD=$(jq -n \
    --arg it "$DRY_INSTANCE_TYPE" --arg img "$VERDA_OS_IMAGE" --arg loc "$DRY_LOCATION_CODE" \
    --arg host "$VA_HOSTNAME" --arg sk "${VERDA_SSH_KEY_ID:-<ssh-key-id>}" \
    --arg sid "(registered at launch as $SCRIPT_NAME)" \
    --arg volname "${VA_HOSTNAME}-os" \
    --argjson volsize "$VERDA_OS_VOLUME_SIZE_GB" --argjson spot "$VERDA_ALLOW_SPOT" \
    '{instance_type:$it, image:$img, location_code:$loc, hostname:$host,
      description:"voice-assistant auto-launch", ssh_key_ids:[$sk], startup_script_id:$sid,
      os_volume:{name:$volname, size:$volsize}, is_spot:$spot}')
  log "DRY RUN — slot=$SLOT ref=$VA_REF image_tag=$IMAGE_TAG (no API calls)"
  log "DRY RUN — would POST $API/scripts as name=$SCRIPT_NAME, then POST $API/instances with:"
  redact "$(jq . <<<"$PAYLOAD")"; printf '\n'
  log "DRY RUN — generated startup script (secrets redacted):"
  redact "$SCRIPT_CONTENT"; printf '\n'
  exit 0
fi

# ─────────────────── everything below is REAL-run only ─────────────────────
: "${VERDA_CLIENT_ID:?set VERDA_CLIENT_ID}"
: "${VERDA_CLIENT_SECRET:?set VERDA_CLIENT_SECRET}"
: "${VERDA_SSH_KEY_ID:?set VERDA_SSH_KEY_ID}"

# ── 6. Auth ────────────────────────────────────────────────────────────────
TOKEN=$(curl -fsS -X POST "$API/oauth2/token" \
  -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"${VERDA_CLIENT_ID}\",\"client_secret\":\"${VERDA_CLIENT_SECRET}\",\"grant_type\":\"client_credentials\"}" \
  | jq -r '.access_token // empty') || die "auth request failed"
[ -n "$TOKEN" ] || die "no access_token in auth response — check VERDA_CLIENT_ID/SECRET"
auth() { curl -fsS -H "Authorization: Bearer $TOKEN" "$@"; }
auth_raw() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }

# ── 7. Idempotency: skip if the slot's EXACT hostname is already up/coming up ─
EXISTING=$(auth "$API/instances" \
  | jq -r --arg h "$VA_HOSTNAME" \
    '[.[] | select(.hostname == $h and (.status == "running" or .status == "provisioning" or .status == "ordered"))] | .[0].id // empty')
if [ -n "$EXISTING" ]; then
  log "instance '$VA_HOSTNAME' (slot $SLOT) already exists (id=$EXISTING) — not creating another"
  exit 0
fi

# ── 8. Rank ALL GPU types that are (a) orderable in a matching location and
#      (b) meet the VRAM floor, cheapest first ─────────────────────────────
AVAILABILITY=$(auth "$API/instance-availability")
TYPES=$(auth "$API/instance-types")

# When VERDA_ALLOW_SPOT=true, rank by spot_price (and only consider types that
# actually have one) instead of the on-demand price_per_hour — otherwise
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

# ── 9. Register the startup script for this launch (POST /v1/scripts) ──────
REG_BODY=$(mktemp)
REG_CODE=$(auth_raw -o "$REG_BODY" -w '%{http_code}' -X POST "$API/scripts" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg name "$SCRIPT_NAME" --arg script "$SCRIPT_CONTENT" '{name:$name, script:$script}')")
if [ "$REG_CODE" -ge 400 ]; then
  MSG=$(redact "$(cat "$REG_BODY")"); rm -f "$REG_BODY"
  die "POST /scripts failed (HTTP $REG_CODE): $MSG"
fi
SCRIPT_ID=$(jq -r '.id // .script.id // empty' "$REG_BODY" 2>/dev/null || true)
if [ -z "$SCRIPT_ID" ]; then
  MSG=$(redact "$(cat "$REG_BODY")"); rm -f "$REG_BODY"
  die "could not parse script id from POST /scripts response (.id / .script.id): $MSG"
fi
rm -f "$REG_BODY"
log "registered startup script $SCRIPT_NAME (id=$SCRIPT_ID)"

# ── 10. Try candidates cheapest-first. Skip anything over VERDA_MAX_HOURLY.
#        A transient "service_unavailable" is retried a few times before moving
#        to the next candidate; any other error aborts immediately. ─────────
RETRY_ATTEMPTS="${VERDA_RETRY_ATTEMPTS:-3}"
RETRY_DELAY_S="${VERDA_RETRY_DELAY_S:-5}"

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
    --arg host "$VA_HOSTNAME" --arg sk "$VERDA_SSH_KEY_ID" --arg sid "$SCRIPT_ID" \
    --arg volname "${VA_HOSTNAME}-os" \
    --argjson volsize "$VERDA_OS_VOLUME_SIZE_GB" --argjson spot "$VERDA_ALLOW_SPOT" \
    '{instance_type:$it, image:$img, location_code:$loc, hostname:$host,
      description:"voice-assistant auto-launch", ssh_key_ids:[$sk], startup_script_id:$sid,
      os_volume:{name:$volname, size:$volsize}, is_spot:$spot}')

  for attempt in $(seq 1 "$RETRY_ATTEMPTS"); do
    HTTP_BODY=$(mktemp)
    HTTP_CODE=$(auth_raw -o "$HTTP_BODY" -w '%{http_code}' -X POST "$API/instances" -H 'Content-Type: application/json' -d "$PAYLOAD")
    if [ "$HTTP_CODE" -lt 400 ]; then
      INSTANCE_ID=$(jq -r '.id // empty' "$HTTP_BODY" 2>/dev/null || true)
      if [ -n "$INSTANCE_ID" ]; then
        log "launched: $INSTANCE_ID"
      else
        log "launched (HTTP $HTTP_CODE, response wasn't parseable JSON — raw body follows)"
        redact "$(cat "$HTTP_BODY")" >&2; printf '\n' >&2
      fi
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

# ── 11. Cleanup: delete every OTHER va-<slot>-* script (best effort) ───────
CLEAN_BODY=$(auth "$API/scripts" 2>/dev/null || true)
if [ -n "$CLEAN_BODY" ]; then
  OLD_IDS=$(jq -r --arg slot "$SLOT" --arg keep "$SCRIPT_ID" '
    (if type=="array" then . else (.scripts // .data // []) end)
    | .[]? | select((.name? // "") | startswith("va-\($slot)-")) | select(.id != $keep) | .id
  ' <<<"$CLEAN_BODY" 2>/dev/null || true)
  while IFS= read -r OID; do
    [ -n "$OID" ] || continue
    DEL_CODE=$(auth_raw -o /dev/null -w '%{http_code}' -X DELETE "$API/scripts/$OID" 2>/dev/null || printf '000')
    case "$DEL_CODE" in
      2*) log "cleaned up old startup script $OID" ;;
      *)  log "script cleanup: DELETE $OID returned HTTP $DEL_CODE (ignored)" ;;
    esac
  done <<<"$OLD_IDS"
fi

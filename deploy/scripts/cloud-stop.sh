#!/usr/bin/env bash
# Destroys the Verda GPU instance running the voice-assistant stack. Meant to
# be wired in as the bot's SERVER_STOP_CMD (apps/bot/.env — see
# apps/bot/.env.example): the bot runs this fire-and-forget after
# SERVER_STOP_DELAY_MS of idle time following the end of a session, so a
# forgotten session doesn't keep billing.
#
# Slots (mirror cloud-start.sh — prod and test are independent instances):
#   --slot prod   (default, also VA_SLOT)  hostname va-gpu
#   --slot test                            hostname va-gpu-test
# Called with no arguments it means prod, so the bot's SERVER_STOP_CMD stays a
# bare path to this script (only the prod instance is ever touched by default —
# a running va-gpu-test is left alone).
#
# IMPORTANT — this DESTROYS the instance, it does not just stop it. Verda bills
# for as long as the instance (and its disk) exists, running or not, so a mere
# "stop" would keep costing money. Per deploy/README.md's "Destroy, don't just
# stop" policy, this deletes the instance outright — the OS volume goes with
# it, and the next /join has to go through cloud-start.sh again (fresh instance,
# cold boot).
#
# Data safety for that destruction: session transcript events already stream to
# the bot host LIVE during the session, an automatic archive pull-back after
# finalize brings the full audio/transcript bundle back too, and
# deploy/scripts/stop.sh --backup remains available as a manual pre-destroy
# fallback if you want a volume tarball before calling this by hand.
#
# Env layering: process env / systemd wins; the file $VA_DEPLOY_ENV (default
# ~/.config/va/deploy.env) only fills gaps. See deploy/scripts/lib-env.sh.
#
# Safety properties:
#   - Idempotent: if no instance with the slot's EXACT hostname is running/
#     provisioning/ordered, this is a no-op (exit 0) — safe to call
#     speculatively from an idle timer that might race a fresh /join.
#   - Exact hostname match: --slot prod (va-gpu) never matches or destroys a
#     va-gpu-test instance and vice versa — the two slots can coexist.
#   - Destroys every match, not just the first: guards against the (rare) case
#     of two instances ending up with the same hostname.
#
# Requires: curl, jq
#
# Config (env vars — same conventions as cloud-start.sh; secrets/host overrides
# in $VA_DEPLOY_ENV, default ~/.config/va/deploy.env):
#   VERDA_CLIENT_ID / VERDA_CLIENT_SECRET   Cloud API credentials (Keys page)
#
# Usage: ./cloud-stop.sh [--slot prod|test] [--dry-run]
# --dry-run looks up matching instances and logs what would be destroyed,
# without sending any delete request.
#
# NOTE: the delete contract (PUT /instances with {action:delete,id}) mirrors
# Verda's published API for instance actions; confirm with --dry-run against a
# real instance before relying on this unattended.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-env.sh
. "$SCRIPT_DIR/lib-env.sh"

API="https://api.verda.com/v1"
log() { printf '[cloud-stop] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

command -v curl >/dev/null || die "curl not found"
command -v jq >/dev/null || die "jq not found"

# ── 0. Env layering, then flags (flags/process env win over the file) ──────
va_load_env

DRY_RUN=0
SLOT="${VA_SLOT:-prod}"
while [ $# -gt 0 ]; do
  case "$1" in
    --slot)    SLOT="${2:?--slot needs an argument}"; shift 2 ;;
    --slot=*)  SLOT="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '1,60p' "$0" | grep -E '^# ' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown argument: $1 (see --help)" ;;
  esac
done

# ── 1. Resolve the slot (hostname only — stop just needs the identity) ─────
case "$SLOT" in
  prod) VA_HOSTNAME="va-gpu" ;;
  test) VA_HOSTNAME="va-gpu-test" ;;
  *)    die "unknown slot: $SLOT (use prod or test)" ;;
esac

: "${VERDA_CLIENT_ID:?set VERDA_CLIENT_ID}"
: "${VERDA_CLIENT_SECRET:?set VERDA_CLIENT_SECRET}"

# ── 2. Auth ────────────────────────────────────────────────────────────────
TOKEN=$(curl -fsS -X POST "$API/oauth2/token" \
  -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"${VERDA_CLIENT_ID}\",\"client_secret\":\"${VERDA_CLIENT_SECRET}\",\"grant_type\":\"client_credentials\"}" \
  | jq -r '.access_token // empty') || die "auth request failed"
[ -n "$TOKEN" ] || die "no access_token in auth response — check VERDA_CLIENT_ID/SECRET"
auth() { curl -fsS -H "Authorization: Bearer $TOKEN" "$@"; }
auth_raw() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }

# ── 3. Find every instance with the slot's EXACT hostname that is up/coming up ─
IDS=$(auth "$API/instances" \
  | jq -r --arg h "$VA_HOSTNAME" \
    '[.[] | select(.hostname == $h and (.status == "running" or .status == "provisioning" or .status == "ordered"))] | .[].id')

if [ -z "$IDS" ]; then
  log "no running instance named $VA_HOSTNAME (slot $SLOT) — nothing to stop"
  exit 0
fi

# ── 4. --dry-run: report what would be destroyed, do not call the API ──────
if [ "$DRY_RUN" = 1 ]; then
  while IFS= read -r ID; do
    [ -n "$ID" ] || continue
    log "DRY RUN — would destroy instance $ID (hostname=$VA_HOSTNAME, slot=$SLOT)"
  done <<<"$IDS"
  exit 0
fi

# ── 5. Destroy every match ─────────────────────────────────────────────────
while IFS= read -r ID; do
  [ -n "$ID" ] || continue

  PAYLOAD=$(jq -n --arg id "$ID" '{action:"delete", id:$id}')
  HTTP_BODY=$(mktemp)
  HTTP_CODE=$(auth_raw -o "$HTTP_BODY" -w '%{http_code}' -X PUT "$API/instances" -H 'Content-Type: application/json' -d "$PAYLOAD")
  if [ "$HTTP_CODE" -lt 400 ]; then
    log "destroyed instance $ID (slot $SLOT)"
    rm -f "$HTTP_BODY"
  else
    ERR_CODE=$(jq -r '.code // empty' "$HTTP_BODY" 2>/dev/null || true)
    ERR_MSG=$(jq -r '.message // empty' "$HTTP_BODY" 2>/dev/null || true)
    rm -f "$HTTP_BODY"
    die "instance deletion failed for $ID (HTTP $HTTP_CODE): ${ERR_MSG:-${ERR_CODE:-unknown error}}"
  fi
done <<<"$IDS"

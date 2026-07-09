#!/usr/bin/env bash
# Destroys the Verda GPU instance running the voice-assistant stack. Meant to
# be wired in as the bot's SERVER_STOP_CMD (apps/bot/.env — see
# apps/bot/.env.example): the bot runs this fire-and-forget after
# SERVER_STOP_DELAY_MS of idle time following the end of a session (no active
# /join, no in-flight finalize), so a forgotten session doesn't keep billing.
#
# IMPORTANT — this DESTROYS the instance, it does not just stop it. Verda
# bills for as long as the instance (and its disk) exists, running or not, so
# a mere "stop" would keep costing money. Per deploy/README.md's "Destroy,
# don't just stop" policy, this script deletes the instance outright — the OS
# volume goes with it, and there is no server left to reconnect to; the next
# /join has to go through cloud-start.sh again (a fresh instance, cold boot).
#
# Data safety for that destruction: session transcript events already stream
# to the bot host LIVE during the session (not just at the end), an upcoming
# automatic archive pull-back after finalize is meant to bring the full
# audio/transcript bundle back too, and deploy/scripts/stop.sh --backup
# remains available as a manual pre-destroy fallback if you want a volume
# tarball before calling this script by hand.
#
# Safety properties:
#   - Idempotent: if no instance named VERDA_HOSTNAME is running/provisioning/
#     ordered, this is a no-op (exit 0) — safe to call speculatively, e.g.
#     from a bot-side idle timer that might race a fresh /join.
#   - Destroys every match, not just the first: guards against the (rare)
#     case of two instances ending up with the same hostname.
#
# Requires: curl, jq
#
# Config (env vars — same conventions as cloud-start.sh: put in e.g.
# deploy/verda.env and source it before running, or export in the
# environment the bot/systemd unit runs under):
#   VERDA_CLIENT_ID / VERDA_CLIENT_SECRET   Cloud API credentials
#                                            (console.verda.com, under Keys)
#   VERDA_HOSTNAME            default va-gpu — identity to look up and
#                             destroy (must match what cloud-start.sh used)
#
# Usage: ./cloud-stop.sh [--dry-run]
# --dry-run looks up matching instances and logs what would be destroyed,
# without sending any delete request.
#
# NOTE: the delete contract (PUT /instances with {action:delete,id}) mirrors
# Verda's published API for instance actions; confirm with --dry-run against
# a real instance before relying on this unattended — same caution as
# cloud-start.sh's field names.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

: "${VERDA_CLIENT_ID:?set VERDA_CLIENT_ID}"
: "${VERDA_CLIENT_SECRET:?set VERDA_CLIENT_SECRET}"
VERDA_HOSTNAME="${VERDA_HOSTNAME:-va-gpu}"

API="https://api.verda.com/v1"
log() { printf '[cloud-stop] %s\n' "$*" >&2; }
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
auth_raw() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }

# ── 2. Find every instance named VERDA_HOSTNAME that is up or coming up ────
IDS=$(auth "$API/instances" \
  | jq -r --arg h "$VERDA_HOSTNAME" \
    '[.[] | select(.hostname == $h and (.status == "running" or .status == "provisioning" or .status == "ordered"))] | .[].id')

if [ -z "$IDS" ]; then
  log "no running instance named $VERDA_HOSTNAME — nothing to stop"
  exit 0
fi

# ── 3. --dry-run: report what would be destroyed, do not call the API ──────
if [ "$DRY_RUN" = 1 ]; then
  while IFS= read -r ID; do
    [ -n "$ID" ] || continue
    log "DRY RUN — would destroy instance $ID (hostname=$VERDA_HOSTNAME)"
  done <<<"$IDS"
  exit 0
fi

# ── 4. Destroy every match ───────────────────────────────────────────────────
while IFS= read -r ID; do
  [ -n "$ID" ] || continue

  PAYLOAD=$(jq -n --arg id "$ID" '{action:"delete", id:$id}')
  HTTP_BODY=$(mktemp)
  HTTP_CODE=$(auth_raw -o "$HTTP_BODY" -w '%{http_code}' -X PUT "$API/instances" -H 'Content-Type: application/json' -d "$PAYLOAD")
  if [ "$HTTP_CODE" -lt 400 ]; then
    log "destroyed instance $ID"
    rm -f "$HTTP_BODY"
  else
    ERR_CODE=$(jq -r '.code // empty' "$HTTP_BODY" 2>/dev/null || true)
    ERR_MSG=$(jq -r '.message // empty' "$HTTP_BODY" 2>/dev/null || true)
    rm -f "$HTTP_BODY"
    die "instance deletion failed for $ID (HTTP $HTTP_CODE): ${ERR_MSG:-${ERR_CODE:-unknown error}}"
  fi
done <<<"$IDS"

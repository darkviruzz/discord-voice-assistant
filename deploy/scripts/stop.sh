#!/usr/bin/env bash
# Stop the stack and back up session data before the instance is destroyed.
#   stop.sh                tear down containers (volumes/models kept)
#   stop.sh --backup DIR   copy transcripts + archive to DIR first
#   stop.sh --purge        also remove the named volumes (models, voices, …)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

PROJECT="${COMPOSE_PROJECT_NAME:-va}"
COMPOSE=(docker compose -p "$PROJECT")

c_green=$'\033[32m'; c_cyan=$'\033[36m'; c_off=$'\033[0m'
step() { printf '%s==>%s %s\n' "$c_cyan" "$c_off" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$c_green" "$c_off" "$*"; }

BACKUP_DIR=""
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP_DIR="${2:?--backup needs a target directory}"; shift 2 ;;
    --purge)  PURGE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default: back up to ./backups/<timestamp> unless told otherwise.
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="$DEPLOY_DIR/backups/$(date +%Y%m%d-%H%M%S)"

backup_vol() { # backup_vol <volume> <tarname>
  local vol="$1" tar="$2"
  docker volume inspect "${PROJECT}_$vol" >/dev/null 2>&1 || return 0
  docker run --rm -v "${PROJECT}_$vol:/src:ro" -v "$BACKUP_DIR:/dst" \
    alpine:latest sh -c "cd /src && tar czf /dst/$tar ." 2>/dev/null \
    && ok "backed up $vol -> $BACKUP_DIR/$tar"
}

step "Backing up transcripts + archive"
mkdir -p "$BACKUP_DIR"
backup_vol transcripts "transcripts.tar.gz"
backup_vol archive     "archive.tar.gz"
backup_vol server-data "server-data.tar.gz"

# Push finished data to a remote (Nextcloud / OneDrive / …) if configured.
# OUTPUT_REMOTE empty → keep the local tarball backup only.
push_outputs() {
  [ -n "${OUTPUT_REMOTE:-}" ] || { ok "No OUTPUT_REMOTE set — keeping local backup only"; return; }
  [ -f "${RCLONE_CONFIG:-}" ] || { echo "RCLONE_CONFIG not found: ${RCLONE_CONFIG:-<unset>}" >&2; return; }
  local rc; rc="$(readlink -f "$RCLONE_CONFIG")"
  for v in transcripts archive; do
    docker volume inspect "${PROJECT}_$v" >/dev/null 2>&1 || continue
    step "Pushing $v -> $OUTPUT_REMOTE/$v"
    docker run --rm \
      -v "$rc:/config/rclone/rclone.conf:ro" \
      -v "${PROJECT}_$v:/data:ro" \
      rclone/rclone copy /data "$OUTPUT_REMOTE/$v" --transfers=8 \
      && ok "pushed $v" || echo "[warn] push of $v failed" >&2
  done
}

# Load .env so OUTPUT_REMOTE / RCLONE_CONFIG are available.
# shellcheck disable=SC1091
[ -f "$DEPLOY_DIR/.env" ] && { set -a; . "$DEPLOY_DIR/.env"; set +a; }
push_outputs

step "Stopping the stack"
if [ "$PURGE" -eq 1 ]; then
  "${COMPOSE[@]}" down -v
  ok "Stack stopped and volumes removed (models will re-download next start)."
else
  "${COMPOSE[@]}" down
  ok "Stack stopped. Named volumes (models/voices) preserved."
fi

printf '\n%sBackup saved to:%s %s\n' "$c_green" "$c_off" "$BACKUP_DIR"
printf 'Copy it off the instance before destroying it, e.g.:\n'
printf '  scp -r <instance>:%s ./\n' "$BACKUP_DIR"

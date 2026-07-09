#!/usr/bin/env bash
# Health-check every service in the stack by curling its /health (or equivalent)
# from inside the container — no ports need to be published.
#   healthcheck.sh           one-shot check, exit 0 if all healthy
#   healthcheck.sh --wait    poll up to ~5 min until all healthy
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

PROJECT="${COMPOSE_PROJECT_NAME:-va}"
COMPOSE=(docker compose -p "$PROJECT")

c_green=$'\033[32m'; c_red=$'\033[31m'; c_off=$'\033[0m'

# name : "service|command-inside-container"
CHECKS=(
  "whisper|whisper|curl -fsS -o /dev/null http://localhost:8080/"
  "ollama|ollama|ollama list"
  "piper|piper|curl -fsS http://localhost:5000/health"
  "server|server|curl -fsS http://localhost:7440/health"
)

check_one() { # check_one <service> <command...>
  local svc="$1"; shift
  "${COMPOSE[@]}" exec -T "$svc" sh -c "$*" >/dev/null 2>&1
}

run_round() { # run_round [quiet]
  local quiet="${1:-}" all_ok=0
  for entry in "${CHECKS[@]}"; do
    IFS='|' read -r name svc cmd <<<"$entry"
    if check_one "$svc" "$cmd"; then
      [ -n "$quiet" ] || printf '  %-9s %sOK%s\n' "$name" "$c_green" "$c_off"
    else
      [ -n "$quiet" ] || printf '  %-9s %sDOWN%s\n' "$name" "$c_red" "$c_off"
      all_ok=1
    fi
  done
  return $all_ok
}

if [ "${1:-}" = "--wait" ]; then
  for _ in $(seq 1 60); do   # ~5 min (60 * 5s)
    if run_round quiet; then echo; run_round; exit 0; fi
    printf '.'; sleep 5
  done
  echo; echo "timed out waiting for services" >&2
  run_round
  exit 1
fi

echo "=== Voice Assistant service health ==="
run_round

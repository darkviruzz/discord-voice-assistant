#!/usr/bin/env bash
# Shared helper for the Verda deploy scripts (cloud-start.sh / cloud-stop.sh).
# Source it — do not execute it directly.
#
# va_load_env: layer the per-host deploy env file UNDER the process
# environment. Precedence (highest wins): process env / systemd EnvironmentFile
# / CLI flags  >  the file. In other words the file only fills GAPS — a value
# already present in the environment (even if empty) is never overwritten. This
# is what lets the exact same script work both under systemd (env from the unit
# file) and standalone/SSH (env from the file).
#
# File location: $VA_DEPLOY_ENV, default ~/.config/va/deploy.env (expanded
# under $HOME). A missing file is not an error — the caller's own :?/default
# guards decide what is actually required.
#
# The file is parsed line-by-line, NOT sourced: no arbitrary code from the file
# is ever executed (no eval, no command substitution). Only lines of the form
#   KEY=VALUE      (optionally prefixed with "export ")
# with KEY matching [A-Z_][A-Z0-9_]* are honoured; blank lines, comments
# (leading '#') and anything else are ignored. One layer of surrounding
# matching single/double quotes around VALUE is stripped; a trailing CR (from a
# CRLF file) is stripped. Everything else in VALUE is taken verbatim — so a
# base64 WireGuard key ending in '=' or containing '/'/'+' survives intact.

va_load_env() {
  local file="${VA_DEPLOY_ENV:-$HOME/.config/va/deploy.env}"
  # allow a leading ~/ in an explicit VA_DEPLOY_ENV
  case "$file" in "~/"*) file="$HOME/${file#\~/}" ;; esac
  [ -f "$file" ] || return 0

  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                                  # tolerate CRLF
    line="${line#"${line%%[![:space:]]*}"}"               # strip leading blanks
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac                 # full-line comment
    case "$line" in "export "*) line="${line#export }" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac           # must contain '='

    key="${line%%=*}"
    # KEY must match [A-Z_][A-Z0-9_]* exactly, else skip (no eval risk).
    case "$key" in [A-Z_]*) ;; *) continue ;; esac
    case "$key" in *[!A-Z0-9_]*) continue ;; esac

    # Fill gaps only: never overwrite an already-set process env variable.
    [ -n "${!key+x}" ] && continue

    val="${line#*=}"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    export "$key=$val"
  done < "$file"
}

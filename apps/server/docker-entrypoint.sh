#!/bin/sh
# Container entrypoint for the Discord voice server.
#
# Why this exists: the process runs as the unprivileged `app` user (uid 10001),
# but Docker creates fresh *named volumes* owned by root:root. The app user then
# cannot write into them — this is the root cause of every EACCES bug seen on
# the cloud instance, e.g. `transcript: log error: EACCES: permission denied,
# mkdir '/data/transcripts'` on practically every event.
#
# So the container now starts as root, fixes ownership of the /data mount
# points, then drops to `app` before exec-ing the real command.
set -eu

# ── Fix /data ownership so the `app` user can write to the mounted volumes ────
#
# Scope: /data itself + each DIRECT child only — deliberately NOT recursive.
# The archive volume grows to several GB over a campaign; a recursive chown
# would slow down every single container start. Because /data itself becomes
# app-owned, any new subdirectory the server creates later (e.g. transcripts/,
# speaker-map.json) is already owned by `app` — no recursion needed.
#
# /data may be absent on a purely local run without volumes → skip and just
# start the process instead of crashing.
if [ -d /data ]; then
    chown app:app /data

    # Each direct child (globs cover normal and dotfile entries; the `-e` guard
    # skips the pattern itself when nothing matches). The campaign volume is
    # mounted read-only (`campaign:/data/campaign:ro` in docker-compose.yml), so
    # chowning it fails with EROFS. Tolerate a failure PER ENTRY with `|| true`
    # and keep going — this is scoped to the mount-point chowns ON PURPOSE. We
    # do NOT disable errexit globally: the privilege drop below must still hard-
    # fail the container if it ever breaks, rather than silently running as root.
    for entry in /data/* /data/.[!.]*; do
        [ -e "$entry" ] || continue
        chown app:app "$entry" || true
    done
fi

# ── Drop root and run the real command (CMD: `node src/index.js`) as `app` ────
#
# setpriv is part of util-linux and ships in node:22-slim (verify in the build:
# `docker run --rm --entrypoint sh <img> -c "command -v setpriv"`). If it were
# ever missing, the fallback is gosu (`apt-get install -y gosu` then
# `exec gosu app "$@"`); setpriv is the primary path used here.
#
# exec keeps this process as PID 1 and preserves the current WORKDIR
# (/app/apps/server), so the relative `src/index.js` argument still resolves.
exec setpriv --reuid=app --regid=app --clear-groups -- "$@"

# Discord Voice Server — Node 22.
#
# Build context is the repository ROOT (npm workspaces hoist node_modules to the
# repo root), so build from deploy/docker-compose.yml with `context: ..`:
#
#   docker build -f apps/server/Dockerfile -t voice-server .
#
# ── deps stage: install only the apps/server workspace (no devDependencies) ──
FROM node:22-slim AS build
WORKDIR /app

# Build tools for @discordjs/opus in case no prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy the lockfile + every workspace manifest so `npm ci` can resolve the tree.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/bot/package.json apps/bot/

RUN npm ci --omit=dev -w apps/server

# ── runtime stage ───────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 -m app

COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/server ./apps/server

# The entrypoint starts as root, fixes /data volume ownership, then drops to the
# `app` user (uid 10001) itself — so there is no `USER app` here on purpose.
# chmod here so the image works regardless of the file's git-index mode bit.
COPY apps/server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Fail the BUILD (not the container start at 3am) if a future base-image bump
# ships without setpriv — the entrypoint's privilege drop depends on it.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && command -v setpriv >/dev/null \
    || { echo "setpriv missing from base image — install util-linux or switch the entrypoint to gosu" >&2; exit 1; }

WORKDIR /app/apps/server

EXPOSE 7440

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD curl -fsS http://localhost:7440/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]

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

USER app
WORKDIR /app/apps/server

EXPOSE 7440

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD curl -fsS http://localhost:7440/health || exit 1

CMD ["node", "src/index.js"]

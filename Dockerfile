# Parallax and its team gateway, in one file with two runnable targets:
#
#   docker build --target parallax     -t parallax .
#   docker build --target team-gateway -t parallax-team-gateway .
#
# docker-compose.yml builds both. Nothing here has been built or run yet.
# Node 22.13 or newer is required (Parallax uses the built-in node:sqlite).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build the app ----------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- the gateway: no dependencies, so it needs nothing but its own folder ----
FROM ${NODE_IMAGE} AS team-gateway
ENV NODE_ENV=production
WORKDIR /gateway
COPY --chown=node:node team-gateway/package.json ./package.json
COPY --chown=node:node team-gateway/src ./src
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.js"]

# ---- Parallax itself (last, so it is the default target) ---------------------
FROM ${NODE_IMAGE} AS parallax
# ffmpeg gives Parallax poster frames and the length of compressed audio. It works without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    PARALLAX_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/seed ./seed
COPY --from=build --chown=node:node /app/mock-media ./mock-media
# The database and every file members make live here. Mount a volume on it.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]

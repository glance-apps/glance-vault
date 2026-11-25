# Combined image: the GLANCEvault server (this repo) + a read-only GLANCEvault
# MCP host (#2280) in one container, two ports. Build from the repo root:
#   docker build -f examples/mcp-vault-host/Dockerfile -t glancevault-mcp .
#
# npm >=9 resolves the dayglance-mcp/mcp-host peer range with the legacy flag;
# drop it once the packages ship aligned releases.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build toolchain for better-sqlite3 in case a prebuilt binary is unavailable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm install --legacy-peer-deps \
  @glance-apps/mcp-host@^0.2.0 \
  @glance-apps/dayglance-mcp@^0.1.0 \
  @glance-apps/dayglance-vault@^0.1.0 \
  @glance-apps/sync@^2.4.0 \
  @glance-apps/agenda-core@^0.1.0 \
  @glance-apps/obsidian-format@^0.1.0 \
  @modelcontextprotocol/server@^2.3.1 \
  @modelcontextprotocol/node@^2.1.1 \
  zod@^4.6.7

RUN npm prune --omit=dev --legacy-peer-deps

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

ENV GLANCEVAULT_STORAGE_PATH=/data/glancevault.db
ENV GLANCEVAULT_PORT=8080
ENV MCP_HOST_PORT=7893
ENV MCP_HOST_DATA_DIR=/data/mcp-host

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --chown=node:node examples/mcp-vault-host/mcp-host.js ./mcp-host.js

# The server and the host both run as the unprivileged node user (uid 1000);
# /data must be writable by it (a named volume inherits this; a bind mount does not).
RUN mkdir -p /data /data/mcp-host && chown -R node:node /data
USER node

EXPOSE 8080 7893

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GLANCEVAULT_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "mcp-host.js"]

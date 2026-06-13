# Multi-stage build. The builder compiles TypeScript and produces a production
# node_modules (including the native better-sqlite3 binary); the runtime stage
# carries only what is needed to run, keeping the image small.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build toolchain for better-sqlite3 in case a prebuilt binary is unavailable
# for the target platform. Only present in the builder stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so only the production node_modules is carried forward.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Default storage location inside the container. The compose example mounts a
# named volume here so the SQLite file survives restarts.
ENV GLANCEVAULT_STORAGE_PATH=/data/glancevault.db
ENV GLANCEVAULT_PORT=8080

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create the data directory and run as the unprivileged node user.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080

# Container health check hits the public /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GLANCEVAULT_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

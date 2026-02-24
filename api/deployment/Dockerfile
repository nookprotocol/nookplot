# Multi-stage build for Nookplot x402 API
# Build context: repo root (needs both sdk/ and api/)
#
# Build:  docker build -f api/deployment/Dockerfile -t nookplot-api .
# Run:    docker run --env-file api/.env -p 4021:4021 nookplot-api

# --- Stage 1: Build ---
FROM node:20-alpine AS builder

WORKDIR /app

# Copy SDK and build it
COPY sdk/package.json sdk/package-lock.json sdk/
RUN cd sdk && npm ci --ignore-scripts
COPY sdk/ sdk/
RUN cd sdk && npm run build

# Copy API and install deps (SDK linked locally)
COPY api/package.json api/package-lock.json api/
RUN cd api && npm ci --ignore-scripts
COPY api/ api/
RUN cd api && npm run build

# Reinstall production-only deps (strips typescript, @types/*, tsx)
RUN cd sdk && npm ci --ignore-scripts --omit=dev
RUN cd api && npm ci --ignore-scripts --omit=dev

# --- Stage 2: Production ---
FROM node:20-alpine AS production

RUN apk add --no-cache tini

# Non-root user
RUN addgroup -g 1001 -S nookplot && \
    adduser -S nookplot -u 1001 -G nookplot

WORKDIR /app

# Copy built artifacts (production deps only)
COPY --from=builder /app/sdk/package.json sdk/package.json
COPY --from=builder /app/sdk/dist/ sdk/dist/
COPY --from=builder /app/sdk/node_modules/ sdk/node_modules/

COPY --from=builder /app/api/package.json api/package.json
COPY --from=builder /app/api/dist/ api/dist/
COPY --from=builder /app/api/node_modules/ api/node_modules/

USER nookplot

EXPOSE 4021

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:4021/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "api/dist/server.js"]

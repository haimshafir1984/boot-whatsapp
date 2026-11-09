# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY scripts/patch-baileys-prelogin-ack.js ./scripts/patch-baileys-prelogin-ack.js
RUN npm ci
# tsc only needs tsconfig + src (tsconfig "include": ["src/**/*"]). Copying just
# those keeps this layer's cache from being busted by unrelated root files
# (.migration/, root *.md, .tmp-*, design-prototype/, tmp/).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app

# Chromium + fonts for Hebrew text rendering
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-ipafont-gothic \
  fonts-wqy-zenhei \
  fonts-freefont-ttf \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# dist is built in the builder; the static asset dirs come straight from the
# build context now that the builder no longer does `COPY . .`.
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY owner-public ./owner-public
COPY site-public ./site-public
COPY scripts ./scripts
COPY package*.json ./
RUN npm ci --omit=dev

EXPOSE 3001

# Liveness probe. start-period is generous: a large Postgres DB needs time for
# applyMigrations + loadSnapshot before /health/live can answer. Re-calibrate
# against the real boot->storage.ready time after the next deploy.
# 2026-11-09: a busy-but-working client (event loop blocked for seconds by a big Excel export / large outbox writes) failed three 5s
# probes in a row and was killed (exit 137), dropping in-memory conversations and blocking the shared Meta number for ~4.5 minutes.
# Now 15s per probe and 5 consecutive failures (about 2.5-3 minutes of real unresponsiveness) before the kill. Event-loop lag is on /health.
HEALTHCHECK --interval=20s --timeout=15s --start-period=100s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]

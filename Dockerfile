# syntax=docker/dockerfile:1

# Bun installs dependencies and runs the build scripts. Kru itself runs on
# Node, which provides the built-in node:sqlite module.
FROM oven/bun:1.4.2 AS bun

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 \
    KRU_STANDALONE=1
RUN bun run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    KRU_DATA_DIR=/data

# Application files stay owned by root; the server can only write /data and
# Next's cache.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/scripts/reset-account.mjs ./scripts/reset-account.mjs
# The crew's personalities, read at runtime by lib/hq/bots/souls.ts.
COPY --from=build /app/bots ./bots
RUN mkdir -p /data .next/cache \
 && chown node:node /data .next/cache \
 && chmod 700 /data

USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]

# Two stages. The builder compiles TypeScript on the build machine's own
# architecture (no emulation under buildx); the production stage installs the
# runtime dependencies natively for the target architecture and copies in only
# the compiled output, so the image never carries the compiler or dev tools.
FROM --platform=$BUILDPLATFORM node:26-alpine AS builder

WORKDIR /app

# --ignore-scripts: nothing in the dependency tree needs an install hook.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

FROM node:26-alpine AS production

# Supplied by the release workflow; the labels at the end carry them.
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"

RUN addgroup -g 1001 -S cwmanage && \
    adduser -S cwmanage -u 1001 -G cwmanage

WORKDIR /app

# Runtime dependencies only, resolved from the same lockfile the gate ran against.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
# The permission check runs from inside the image:
#   docker compose run --rm connectwise-mcp node scripts/check-permissions.mjs
COPY scripts/check-permissions.mjs ./scripts/

# Everything under /app is owned by root and read-only to the service user.
RUN chown -R root:root /app

# The image is read-only at runtime (nothing is written under /app); run with
# --read-only and a tmpfs on /tmp.
USER cwmanage

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# Bind every interface inside the container; host exposure is the `ports`
# entry in compose (loopback). Startup refuses to run unless MCP_BEARER_TOKEN,
# MCP_S2S_SECRET or OAuth is configured, so 0.0.0.0 is never reachable
# unauthenticated. CW_WRITE_MODE defaults to read-only in the code; set it to
# write in .env deliberately.
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=env

CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.title="connectwise-manage-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for ConnectWise Manage (PSA), maintained by ECMSI"
LABEL org.opencontainers.image.vendor="ECMSI"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/ecmsi/connectwise-manage-mcp"
LABEL org.opencontainers.image.licenses="Apache-2.0"

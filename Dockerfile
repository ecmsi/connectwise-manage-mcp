# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

# Build arguments
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (--ignore-scripts prevents 'prepare' from running before source is copied)
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:26-alpine AS production

# Create a non-root user for security
RUN addgroup -g 1001 -S cwmanage && \
    adduser -S cwmanage -u 1001 -G cwmanage

# Set working directory
WORKDIR /app

# Copy package files and built application from builder stage
COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Prune dev dependencies
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force && chown -R root:root /app

# Switch to non-root user. The image is read-only at runtime (nothing is
# written under /app); run with --read-only and a tmpfs on /tmp.
USER cwmanage

# Expose port for HTTP transport
EXPOSE 8080

# Health check against the HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# Bind every interface inside the container; host exposure is the `ports`
# entry in compose (loopback). Startup refuses to run unless MCP_BEARER_TOKEN,
# CONDUIT_S2S_SECRET or OAuth is configured, so 0.0.0.0 is never reachable
# unauthenticated. CW_WRITE_MODE defaults to read-only in the code; set it to
# write in .env deliberately.
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=env

# Start the application
CMD ["node", "dist/index.js"]

# Labels for metadata
LABEL version="${VERSION}"
LABEL description="ConnectWise Manage MCP Server (ECMSI fork) - Model Context Protocol server for ConnectWise PSA"
LABEL org.opencontainers.image.title="connectwise-manage-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for ConnectWise Manage (PSA) integration"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/ecmsi/connectwise-manage-mcp"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# ============================================================
# Hytale Server Manager - Dockerfile
# Multi-stage build: Frontend + Backend (Node.js/TypeScript)
# ============================================================
# Build context MUST be the manager directory (docker-compose: context: ./manager).
# COPY paths (frontend/, backend/, entrypoint.sh) are relative to that context.
# ============================================================

# Stage 1: Build Frontend (Debian base so Rollup's optional native binary installs; Alpine + optional deps often fail)
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend

# Copy package files (lockfile = fast install like local)
COPY frontend/package.json frontend/package-lock.json ./

# Install dependencies (slim has glibc so @rollup/rollup-linux-x64-gnu installs and Vite build works)
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-timeout 120000 && \
    npm ci

# Copy frontend source
COPY frontend/ ./

# Build for production
RUN npm run build


# Stage 2: Build Backend
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend

# Copy package files
COPY backend/package.json ./

# Install dependencies (including dev for build; timeout so build fails instead of hanging)
RUN npm config set fetch-timeout 300000 && \
    npm install --loglevel verbose --timing

# Copy backend source
COPY backend/ ./

# Build TypeScript
RUN npm run build


# Stage 3: Production Image
FROM node:20-alpine

LABEL maintainer="Hytale Server Manager"
LABEL description="Web-based management tool for Hytale servers"

# Install wget for healthcheck, dumb-init for signal handling, gosu for user switching
RUN apk add --no-cache wget dumb-init gosu shadow

# Create non-root user for security
# Using same UID/GID 9999 as hytale container for shared volume access
# This ensures both containers can read/write files without permission issues
RUN addgroup -g 9999 -S hytale && \
    adduser -u 9999 -S manager -G hytale

WORKDIR /app

# Copy package files and install production dependencies only
COPY backend/package.json ./
RUN npm install --omit=dev --loglevel verbose && npm cache clean --force

# Copy built backend from builder
COPY --from=backend-builder /app/backend/dist ./dist

# Copy assets (plugins, etc.)
COPY --from=backend-builder /app/backend/assets ./assets

# Copy frontend build from frontend builder
COPY --from=frontend-builder /app/static ./static

# Create data directory with proper ownership
RUN mkdir -p /app/data && \
    chown -R manager:hytale /app

# Copy entrypoint script
COPY --chmod=755 entrypoint.sh /app/entrypoint.sh

# Environment variables
ENV NODE_ENV=production
ENV MANAGER_PORT=18080

# NOTE: We start as root, then the entrypoint script drops to
# the manager user (UID 9999, same as hytale container)

# Expose port
EXPOSE 18080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --quiet --tries=1 -O /dev/null http://localhost:18080/api/health || exit 1

# Use dumb-init + our entrypoint for proper signal handling and permission fixing
ENTRYPOINT ["dumb-init", "--", "/app/entrypoint.sh"]

# Run the application
CMD ["node", "dist/index.js"]

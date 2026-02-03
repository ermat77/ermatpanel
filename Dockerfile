# ============================================================
# Hytale Dedicated Server - Docker Image
# Fully automated - downloads server files on first start
# ============================================================

FROM eclipse-temurin:25-jdk-noble

LABEL maintainer="Ermat"
LABEL description="Hytale Dedicated Server - Auto-Setup"
LABEL version="2.0"

# ============================================================
# Environment Variables
# ============================================================
ENV JAVA_MIN_RAM="3G" \
    JAVA_MAX_RAM="4G" \
    SERVER_PORT="5520" \
    SERVER_BIND="0.0.0.0" \
    ENABLE_BACKUP="false" \
    BACKUP_FREQUENCY="30" \
    TZ="Europe/Paris" \
    # Option 1: Direct URLs to server files
    SERVER_JAR_URL="" \
    ASSETS_URL="" \
    # Option 2: Use official Hytale Downloader
    USE_HYTALE_DOWNLOADER="false" \
    HYTALE_PATCHLINE="release" \
    # Auto-update on container restart
    AUTO_UPDATE="false" \
    ENABLE_SFTP="false" \
    SFTP_PASSWORD=""

# ============================================================
# Install dependencies
# ============================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    unzip \
    jq \
    tzdata \
    gosu \
    ca-certificates \
    dbus \
    openssh-server \
    && rm -rf /var/lib/apt/lists/*
# Note: Timezone is set at runtime in entrypoint.sh using TZ env variable

# ============================================================
# Create user and directories
# ============================================================
# Use UID 9999 to avoid conflicts with existing users
# hytale home = server path so SFTP sessions land in game data dir
RUN groupadd -g 9999 hytale \
    && useradd -u 9999 -g hytale -m -d /opt/hytale/server -s /bin/bash hytale \
    && mkdir -p /opt/hytale/server \
    && chown -R hytale:hytale /opt/hytale \
    && mkdir -p /etc/ssh/sshd_config.d

WORKDIR /opt/hytale

# ============================================================
# SFTP: drop-in config (SFTP only, no shell, no password by default)
# ============================================================
COPY configs/sshd_sftp.conf /etc/ssh/sshd_config.d/sftp.conf

# ============================================================
# Copy scripts
# ============================================================
COPY --chmod=755 scripts/entrypoint.sh /opt/hytale/entrypoint.sh
COPY --chmod=755 scripts/start-server.sh /opt/hytale/start-server.sh
COPY --chmod=755 scripts/backup.sh /opt/hytale/backup.sh

# ============================================================
# Persistent data: mount /opt/hytale/server via compose (bind or named volume).
# No VOLUME here to avoid anonymous volume IDs when bind mount is used.
# ============================================================

# ============================================================
# Expose ports: UDP game, TCP SFTP
# ============================================================
EXPOSE 5520/udp 22/tcp

# ============================================================
# Health check
# ============================================================
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
    CMD pgrep -f "HytaleServer.jar" > /dev/null || exit 1

ENTRYPOINT ["/opt/hytale/entrypoint.sh"]

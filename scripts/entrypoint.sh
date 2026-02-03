#!/bin/bash
# ============================================================
# Hytale Server - Entrypoint
# ============================================================

# ============================================================
# Set timezone at runtime from TZ environment variable
# ============================================================
if [ -n "$TZ" ] && [ -f "/usr/share/zoneinfo/$TZ" ]; then
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
    echo "[INFO] Timezone set to: $TZ"
else
    echo "[WARN] Invalid or missing TZ variable, using default timezone"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║       Hytale Dedicated Server - Docker Container         ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Java:     $(java -version 2>&1 | head -1 | cut -d'"' -f2)                                   ║"
echo "║  RAM:      ${JAVA_MIN_RAM} - ${JAVA_MAX_RAM}                                ║"
echo "║  Port:     ${SERVER_PORT}/udp                                  ║"
echo "║  Timezone: ${TZ}                                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ============================================================
# Fix permissions
# ============================================================
echo "[INFO] Setting up directories..."
# Set umask 002 so all new files are group-writable (for manager container access)
umask 002
chown -R hytale:hytale /opt/hytale
# Make existing files group-writable for manager container
chmod -R g+rw /opt/hytale 2>/dev/null || true

# ============================================================
# Create folders at server root (worlds is created by HytaleServer.jar)
# ============================================================
SERVER_ROOT="/opt/hytale/server"
# If "universe" exists but is not a directory (e.g. file or broken symlink from host), remove it so Hytale can create it
if [ -e "$SERVER_ROOT/universe" ] && [ ! -d "$SERVER_ROOT/universe" ]; then
    echo "[WARN] Removing non-directory 'universe' so server can create it as a directory"
    rm -f "$SERVER_ROOT/universe"
fi
mkdir -p "$SERVER_ROOT/mods" "$SERVER_ROOT/universe" "$SERVER_ROOT/backups" "$SERVER_ROOT/logs" "$SERVER_ROOT/auth"

AUTH_DIR="$SERVER_ROOT/auth"
MACHINE_ID_FILE="${AUTH_DIR}/.machine-id"

# Setup persistent machine-id for encrypted auth
if [ ! -f "$MACHINE_ID_FILE" ]; then
    echo "[INFO] Generating persistent machine-id..."
    cat /proc/sys/kernel/random/uuid | tr -d '-' > "$MACHINE_ID_FILE"
    chown hytale:hytale "$MACHINE_ID_FILE"
fi

# Link to /etc/machine-id (used by Hytale for encryption key)
if [ -f "$MACHINE_ID_FILE" ]; then
    cp "$MACHINE_ID_FILE" /etc/machine-id
    chmod 444 /etc/machine-id
    # Also setup dbus machine-id
    mkdir -p /var/lib/dbus
    cp "$MACHINE_ID_FILE" /var/lib/dbus/machine-id
    chmod 444 /var/lib/dbus/machine-id
    echo "[INFO] Machine-ID configured for auth persistence"
fi

# ============================================================
# Check server files (provided by manager or manual copy)
# ============================================================
echo "[INFO] Checking server files..."

SERVER_JAR="/opt/hytale/server/HytaleServer.jar"
ASSETS_FILE="/opt/hytale/server/Assets.zip"

if [ -f "$SERVER_JAR" ] && [ -f "$ASSETS_FILE" ]; then
    echo "[INFO] Server files found!"
else
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  SERVER FILES NOT FOUND!                                 ║"
    echo "╠══════════════════════════════════════════════════════════╣"
    echo "║  Provide files via the manager setup wizard, or copy:    ║"
    echo "║    docker cp HytaleServer.jar <container>:/opt/hytale/server/ ║"
    echo "║    docker cp Assets.zip <container>:/opt/hytale/server/  ║"
    echo "║    docker restart <container>                            ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "[WAIT] Waiting for server files..."

    while true; do
        if [ -f "$SERVER_JAR" ] && [ -f "$ASSETS_FILE" ]; then
            echo "[INFO] Files detected! Continuing..."
            break
        fi
        sleep 5
    done
fi

# ============================================================
# Final check
# ============================================================
if [ ! -f "$SERVER_JAR" ] || [ ! -f "$ASSETS_FILE" ]; then
    echo "[ERROR] Server files still missing!"
    echo "[ERROR] Expected: $SERVER_JAR"
    echo "[ERROR] Expected: $ASSETS_FILE"
    echo ""
    echo "Contents of /opt/hytale/server/:"
    ls -la /opt/hytale/server/ || true
    exit 1
fi

echo "[INFO] Server files verified!"

chown -R hytale:hytale /opt/hytale
chmod -R g+rw /opt/hytale 2>/dev/null || true

# ============================================================
# SFTP (optional): persist host keys, set password, start sshd
# ============================================================
if [ "${ENABLE_SFTP:-false}" = "true" ]; then
    echo "[INFO] Setting up SFTP access..."
    HOST_KEYS_DIR="/opt/hytale/server/.ssh_host_keys"
    mkdir -p "$HOST_KEYS_DIR"
    for keytype in ed25519 rsa ecdsa; do
        keyfile="$HOST_KEYS_DIR/ssh_host_${keytype}_key"
        if [ ! -f "$keyfile" ]; then
            ssh-keygen -t "$keytype" -f "$keyfile" -N "" -q
        fi
        cp -f "$keyfile" "${keyfile}.pub" /etc/ssh/ 2>/dev/null || true
    done
    chown root:root /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub 2>/dev/null || true
    chmod 600 /etc/ssh/ssh_host_*_key 2>/dev/null || true
    chmod 644 /etc/ssh/ssh_host_*_key.pub 2>/dev/null || true

    if [ -n "$SFTP_PASSWORD" ]; then
        echo "hytale:${SFTP_PASSWORD}" | chpasswd
        echo "[INFO] SFTP password set for user 'hytale'"
    else
        echo "[WARN] SFTP enabled but SFTP_PASSWORD not set - use SSH keys in /opt/hytale/server/.ssh/authorized_keys"
    fi

    mkdir -p /opt/hytale/server/.ssh /opt/hytale/server/logs
    chown hytale:hytale /opt/hytale/server/.ssh
    chmod 700 /opt/hytale/server/.ssh
    touch /opt/hytale/server/logs/sshd.log
    chown hytale:hytale /opt/hytale/server/logs/sshd.log

    # sshd needs /run/sshd for PID file (missing in minimal container)
    mkdir -p /run/sshd
    chmod 0755 /run/sshd

    # -E: log to file; run in background so it survives exec below
    nohup /usr/sbin/sshd -E /opt/hytale/server/logs/sshd.log </dev/null >>/opt/hytale/server/logs/sshd.log 2>&1 &
    sleep 1
    if pgrep -x sshd >/dev/null; then
        echo "[INFO] SFTP server listening on port 22 (logs: server/logs/sshd.log)"
    else
        echo "[WARN] SFTP sshd failed to start; check server/logs/sshd.log"
    fi
fi

# ============================================================
# Start server
# ============================================================
echo "[INFO] Starting Hytale Server..."
echo ""
exec gosu hytale /opt/hytale/start-server.sh

#!/bin/sh
# ============================================================
# Manager Container Entrypoint
# Switches to manager user (UID 9999, same as hytale container)
# ============================================================

set -e

# UID/GID 9999 = same as hytale container for shared volume access
MANAGER_UID=9999
SHARED_GID=9999

echo "[Manager] Starting as UID $(id -u)..."

# Check if we're running as root (needed for user switching)
if [ "$(id -u)" = "0" ]; then
    # Set umask to ensure new files are group-writable
    umask 002

    # Add docker socket group to manager user for container management
    if [ -S /var/run/docker.sock ]; then
        DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
        echo "[Manager] Docker socket GID: $DOCKER_GID"
        echo "[Manager] Docker socket permissions: $(stat -c '%a' /var/run/docker.sock)"

        # Get the group name for this GID (might be 'docker' or something else)
        DOCKER_GROUP_NAME=$(getent group "$DOCKER_GID" | cut -d: -f1)
        
        if [ -z "$DOCKER_GROUP_NAME" ]; then
            # Group doesn't exist, create it with the socket's GID
            echo "[Manager] Creating docker group with GID: $DOCKER_GID"
            groupadd -g "$DOCKER_GID" docker 2>/dev/null || {
                # If groupadd fails, try to find existing group name
                DOCKER_GROUP_NAME="docker"
                # Try to create with a different name or use existing
                if ! getent group docker >/dev/null 2>&1; then
                    echo "[Manager] Warning: Could not create docker group, will try to use existing"
                fi
            }
            DOCKER_GROUP_NAME="docker"
        else
            echo "[Manager] Found existing group: $DOCKER_GROUP_NAME (GID: $DOCKER_GID)"
        fi

        # Add manager user to the docker group
        echo "[Manager] Adding manager user to group: $DOCKER_GROUP_NAME"
        if usermod -aG "$DOCKER_GROUP_NAME" manager 2>/dev/null; then
            echo "[Manager] Successfully added manager to $DOCKER_GROUP_NAME group"
        else
            echo "[Manager] Warning: Failed to add manager to $DOCKER_GROUP_NAME group"
            echo "[Manager] Attempting alternative: changing socket permissions..."
            # Fallback: temporarily make socket group-readable (less secure but works)
            chmod 666 /var/run/docker.sock 2>/dev/null || {
                echo "[Manager] Error: Cannot modify socket permissions. Docker operations may fail."
            }
        fi

        # Verify group membership
        if id -nG manager | grep -qw "$DOCKER_GROUP_NAME"; then
            echo "[Manager] Verified: manager is in $DOCKER_GROUP_NAME group"
        else
            echo "[Manager] Warning: Could not verify group membership"
        fi
    else
        echo "[Manager] Warning: Docker socket not found at /var/run/docker.sock"
    fi

    echo "[Manager] Switching to manager user (UID: $MANAGER_UID)..."
    
    # Test socket access as manager user before switching
    if [ -S /var/run/docker.sock ]; then
        echo "[Manager] Testing Docker socket access..."
        if gosu manager test -r /var/run/docker.sock && gosu manager test -w /var/run/docker.sock; then
            echo "[Manager] ✅ Docker socket is accessible"
        else
            echo "[Manager] ⚠️  Warning: Docker socket may not be fully accessible"
            echo "[Manager]    Socket permissions: $(stat -c '%a %U:%G' /var/run/docker.sock)"
            echo "[Manager]    Manager groups: $(id -nG manager)"
        fi
    fi
    
    # gosu properly handles supplementary groups
    exec gosu manager "$@"
else
    # Already running as non-root, set umask and run
    umask 002
    exec "$@"
fi

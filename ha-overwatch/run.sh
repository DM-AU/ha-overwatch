#!/bin/sh
# HA-Overwatch — Add-on startup script
# /config is mapped to the HA config directory (persistent across updates)
# All user data lives under /config/ha-overwatch/

set -e

DATA_DIR="/config/ha-overwatch"

echo "[HA-Overwatch] Starting up..."
echo "[HA-Overwatch] Data directory: ${DATA_DIR}"

# Create persistent data directories if they don't exist
mkdir -p "${DATA_DIR}/config/zones"
mkdir -p "${DATA_DIR}/img"

# Seed default config on first run (never overwrite existing user config)
if [ ! -f "${DATA_DIR}/config/ui.yaml" ]; then
    echo "[HA-Overwatch] First run — seeding default config..."
    cp /app/defaults/config/ui.yaml "${DATA_DIR}/config/ui.yaml"
fi

if [ ! -f "${DATA_DIR}/config/zones/index.json" ]; then
    echo "[HA-Overwatch] First run — seeding zones index..."
    cp /app/defaults/config/zones/index.json "${DATA_DIR}/config/zones/index.json"
fi

echo "[HA-Overwatch] Launching server on port 8099..."
exec node /app/server.js 8099 "${DATA_DIR}"

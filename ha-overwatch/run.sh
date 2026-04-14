#!/usr/bin/with-contenv bashio
# HA-Overwatch — Add-on startup script
# bashio is provided by the HA base image for add-on helpers

DATA_DIR="/config/ha-overwatch"

bashio::log.info "HA-Overwatch starting..."
bashio::log.info "Data directory: ${DATA_DIR}"

# Create persistent data directories
mkdir -p "${DATA_DIR}/config/zones"
mkdir -p "${DATA_DIR}/img"

# Seed defaults on first run
if [ ! -f "${DATA_DIR}/config/ui.yaml" ]; then
    bashio::log.info "First run — seeding default config..."
    cp /app/defaults/config/ui.yaml "${DATA_DIR}/config/ui.yaml"
fi

if [ ! -f "${DATA_DIR}/config/zones/index.json" ]; then
    bashio::log.info "First run — seeding zones index..."
    cp /app/defaults/config/zones/index.json "${DATA_DIR}/config/zones/index.json"
fi

bashio::log.info "Launching server on port 8099..."

# Run node in foreground — s6 keeps this process alive
node /app/server.js 8099 "${DATA_DIR}"

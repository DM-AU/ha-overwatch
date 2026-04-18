ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js (LTS)
RUN apk add --no-cache nodejs npm

# App lives at /app (static files, never changes between runs)
WORKDIR /app
COPY dashboard/ /app/

# Copy custom component source so server.js can install it to /config/custom_components/
COPY custom_components/ /app/custom_components/

# Copy the startup script and make it the s6 service entrypoint
COPY run.sh /etc/services.d/ha-overwatch/run
RUN chmod +x /etc/services.d/ha-overwatch/run

# Store default config files separately so run.sh can seed DATA_DIR on first boot
RUN mkdir -p /app/defaults/config/zones
COPY dashboard/config/ui.yaml          /app/defaults/config/ui.yaml
COPY dashboard/config/zones/index.json /app/defaults/config/zones/index.json

EXPOSE 8099
ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js (LTS)
RUN apk add --no-cache nodejs npm

# App lives at /app (static files, never changes between runs)
WORKDIR /app
COPY dashboard/ /app/

# Copy the startup script (lives at add-on root, not inside dashboard/)
COPY run.sh /app/run.sh
RUN chmod +x /app/run.sh

# Store default config files separately so run.sh can seed DATA_DIR on first boot
RUN mkdir -p /app/defaults/config/zones
COPY dashboard/config/ui.yaml          /app/defaults/config/ui.yaml
COPY dashboard/config/zones/index.json /app/defaults/config/zones/index.json

EXPOSE 8099

CMD ["/bin/sh", "/app/run.sh"]

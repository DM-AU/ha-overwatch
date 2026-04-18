"""Constants for HA Overwatch integration."""

DOMAIN = "ha_overwatch"
DEFAULT_URL = "http://localhost:8099"

# Entity prefixes — must match server.js slug logic exactly
ENTITY_PREFIX = "overwatch"

# Poll interval for entity state refresh from add-on (seconds)
# Used as fallback if push fails
POLL_INTERVAL = 30

# Coordinator update interval
UPDATE_INTERVAL = 30

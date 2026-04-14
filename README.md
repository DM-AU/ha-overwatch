# HA-Overwatch

A floor plan based alarm and monitoring dashboard for Home Assistant, designed as a full-screen wall-mounted panel for tablets and phones.

## Features

- **Interactive floor plan** with zone overlays that flash when triggered
- **Live HA integration** via WebSocket — real-time sensor state updates
- **Per-zone device linking** — sensors, cameras, lights, sirens per zone
- **Zone arm/disarm toggles** with master override
- **HA entity mirroring** — exposes zone state as `input_boolean` entities for automations
- **Event log** with category filters (system / zones / entities / HA)
- **Configurable alarm labels**, colours per entity type, fade duration
- **Works on older devices** — no heavy frameworks, plain HTML/JS

## Installation

### Add to Home Assistant

1. In HA, go to **Settings → Add-ons → Add-on Store**
2. Click **⋮ → Repositories**
3. Add: `https://github.com/DM-AU/ha-overwatch`
4. Find **HA-Overwatch** in the store and click **Install**
5. Start the add-on — dashboard available on port **8099**

### Standalone (without HA Add-on)

```bash
cd ha-overwatch/dashboard
node server.js 8099
# Open http://localhost:8099
```

## HA Entity IDs created (for automations)

| Entity | Description |
|--------|-------------|
| `input_boolean.overwatch_master_armed` | Master arm state |
| `input_boolean.overwatch_master_triggered` | Master triggered state |
| `input_boolean.overwatch_zone_<name>_armed` | Per-zone arm state |
| `input_boolean.overwatch_zone_<name>_triggered` | Per-zone triggered state |

Run **☁ Setup HA** in the Zones editor to create these entities.

## Configuration

Settings are stored in `/config/ha-overwatch/config/ui.yaml` (HA Add-on) or `config/ui.yaml` (standalone). Edit via the Settings panel in the dashboard.

## Updating

Bump `version` in `ha-overwatch/config.yaml` and push to GitHub. HA will show an update available.

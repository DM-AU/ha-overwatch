# HA-Overwatch — Project Context

## What this project is
HA-Overwatch is a Home Assistant floor-plan-based alarm and monitoring dashboard designed for full-screen wall-mounted panels, tablets, and phones.

The project provides:
- Interactive floor plan with zone overlays
- Live Home Assistant integration over WebSocket
- Per-zone device linking (sensors, cameras, lights, sirens)
- Zone arm/disarm toggles with master override
- HA entity mirroring for automations
- Event log filtering and alarm visualisation
- A lightweight frontend intended to work on older devices

## Repository / runtime model
Primary repository:
- https://github.com/DM-AU/ha-overwatch

Known structure from current project discussions:
- `server.js` handles backend / API / config / HA-facing support logic
- `app.js` handles core client-side dashboard behaviour and UI state
- Dashboard is designed to run as a Home Assistant add-on and also standalone
- Config is persisted in `config/ui.yaml` (or HA add-on path equivalent)

## Core app concepts
### Zones
A zone is the primary monitoring unit in the UI.
A zone can have:
- sensors
- doors / windows
- cameras
- lights
- sirens
- linked Home Assistant area metadata
- armed / disarmed state
- triggered / cooldown state

### Trigger sources
Triggers can come from:
- doors / windows
- motion / occupancy / presence sensors
- other linked entities intended to drive zone activation

Trigger handling must be strict enough to ignore junk or mislinked helper rows, while still allowing legitimate door/window and sensor events to raise zones and cameras.

### Cameras
Camera presentation is state-driven.
Current design direction from recent work:
- camera grid should react to triggered zones/cameras
- low-res and high-res camera options should be supported where practical
- camera visibility should respect user toggles and cooldown rules
- dynamic entity lookup in editor fields is preferred over static/manual-only entry

### Doors / multi-zone logic
Doors may logically belong to more than one zone, especially for perimeter transitions between outside and inside spaces.
Design direction already discussed:
- keep simple default workflow
- add door to a zone normally
- optionally tag/link the same door to additional zones
- avoid over-complicated floor restrictions unless a real need appears

## UI / UX priorities
The dashboard is not a generic admin app; it is an operational wall panel.
Important behavioural priorities:
- fast visual response
- clear trigger state visibility
- dynamic camera wall behaviour
- minimal friction on tablets
- sidebar should stay out of the way by default unless actively needed
- avoid regressions in live status refresh behaviour

## Performance / stability constraints
This project is used on real dashboards and older devices, so performance matters.
Known practical constraints from prior work:
- avoid heavy frameworks unless clearly justified
- prefer targeted fixes over large rewrites
- preserve responsiveness on low-power tablets and wall panels
- avoid websocket/UI logic that only refreshes after user interaction

## Output expectations when working on this repo
When generating changes for this project:
- full files only unless explicitly told otherwise
- no patch snippets
- no partial edits that require manual stitching
- do not assume intent if requirements are ambiguous; ask one targeted question if blocked
- preserve existing behaviour unless the task explicitly changes it
- call out risks / regressions directly

## Canonical sources of truth
When using Copilot on this repo, treat these as the primary context files:
- `docs/copilot/CONTEXT.md`
- `docs/copilot/DECISIONS.md`
- `docs/copilot/ACTIVE-WORK.md`
- `docs/copilot/WORKING-AGREEMENTS.md`
- active GitHub issues / recent commits

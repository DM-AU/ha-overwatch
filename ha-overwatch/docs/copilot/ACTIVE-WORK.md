# HA-Overwatch — Active Work

> This file is a rolling snapshot. Update it at the end of each task/session.

## Current branch / repo
- Repo: `DM-AU/ha-overwatch`
- Default branch assumed: `main`

## Current priorities
1. Fix dynamic entity lookup regressions in the Zone Editor
2. Stabilise live UI refresh so linked lights/sensors update without requiring manual interaction
3. Ensure sidebar default state is closed on refresh
4. Finalise door multi-zone linking workflow in admin UI
5. Protect trigger logic so doors/zones/cameras behave correctly under cooldown and filtering rules

## Open work items

### AW-001 — Low-res camera field lacks dynamic HA lookup
**Problem:** Zone Editor camera low-res option does not dynamically query Home Assistant entities while typing.  
**Expected:** Autocomplete / live lookup behaviour similar to other dynamic entity fields.  
**Likely touchpoints:** `app.js` admin/editor logic, any backend lookup endpoint used by the UI.  
**Priority:** High

### AW-002 — Mapping HA area to Overwatch zone is not dynamically resolved well enough
**Problem:** Mapping an HA area to an Overwatch zone needs better dynamic area lookup/selection support.  
**Expected:** Cleaner lookup flow and reliable binding to HA areas.  
**Likely touchpoints:** editor UI, data model persistence, lookup APIs.  
**Priority:** High

### AW-003 — Zone panel light/sensor status does not refresh dynamically enough
**Problem:** Zone panel appears to refresh linked light status only after toggling a light; may affect sensor status too.  
**Expected:** Linked entities should reflect HA state changes live without requiring a user action to force repaint/state sync.  
**Likely touchpoints:** websocket event handling, state store mutation, UI render/update logic in `app.js`.  
**Priority:** High

### AW-004 — Sidebar opens on browser refresh
**Problem:** Sidebar defaults open after refresh.  
**Expected:** Sidebar starts closed unless explicitly opened by the user or a specific admin action.  
**Likely touchpoints:** initial UI state bootstrap in `app.js`, persisted settings logic if any.  
**Priority:** Medium

### AW-005 — Door multi-zone linking UX
**Problem:** Doors may need to participate in multiple zones, especially perimeter transitions.  
**Expected:** Simple workflow: assign door normally, optionally link/tag additional zones via small settings affordance.  
**Likely touchpoints:** door edit UI, zone config schema, trigger resolution logic, runtime event fan-out.  
**Priority:** Medium

### AW-006 — Zone/camera trigger regression hardening
**Problem:** Prior trigger-source filtering changes either caused or aligned with cameras failing to appear when a door triggered a zone.  
**Expected:** Legitimate door/window and sensor triggers continue to raise zone state and camera visibility correctly, while junk helper rows are ignored.  
**Likely touchpoints:** trigger source classification, cooldown handling, camera display update path.  
**Priority:** Critical whenever trigger logic is modified

## Known regression risks
- Breaking door-triggered camera display while filtering invalid entities
- Fixing lookup UX but desynchronising persisted config format
- Over-caching editor lookup results and hiding recent HA changes
- Initial UI state fixes accidentally affecting tablet runtime views
- Live status refresh fixes causing websocket flood or redundant renders

## Test checklist for any relevant change
Use these checks before considering a task complete:

### Trigger / camera tests
- Door opens -> correct zone triggers
- Triggered zone displays expected camera(s)
- Camera clears correctly after cooldown
- Disarmed zone visual behaviour is still correct
- Invalid/non-trigger helper entity rows do not raise zone/camera events

### Editor / lookup tests
- Typing in low-res camera field returns live HA entities
- HA area mapping list is current and selectable
- Saved config persists and reloads correctly
- Existing rows still render after schema/UI changes

### UI state / refresh tests
- Sidebar is closed on clean refresh
- Zone panel lights update when HA state changes externally
- Sensor/linked entity state updates without manual toggles
- Tablet/full-screen layout still behaves correctly

## Session checkpoint template
Copy this block at the end of each work session:

```md
## Session Checkpoint
Date:
Topic:
Files touched:
What changed:
Known regressions:
Validation performed:
Next step:
Open question:
```

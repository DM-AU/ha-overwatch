/* ─── CONFIG DEFAULTS ─────────────────────────────────────── */
/* v0.05.35.21: floorplan faults visible while disarmed; zone popup click-toggle/drag guard. */
let uiConfig = {
  floorplan: "img/floorplan.png",
  sidebar_position: "right",
  hide_zone_status:   false,   // per-device: hide zone status dropdown button
  hide_camera_status: false,   // per-device: hide camera status dropdown button
  sidebar_collapsed: false,
  theme: "system",
  sidebar_icon_size: 28,
  sidebar_icon_padding: 12,
  map_icon_size: 24,
  polling_interval: 5,
  status: "HA-Overwatch",

  // HA connection
  ha_url: "",
  ha_token: "",
  ha_websocket: true,
  alarm_entity: "",
  alarm_entity_inverted: false,  // if true: entity OFF = armed, ON = disarmed
  alarm_label_armed:    "Armed",
  alarm_label_disarmed: "Disarmed",

  // Triggered zone colours — ALARM ON (alarm system is armed/triggered)
  color_on_person:  "#ff3b30",
  color_on_motion:  "#ff9500",
  color_on_door:    "#ff6b35",
  color_on_window:  "#ff9f0a",
  color_on_smoke:   "#ff2d55",
  color_on_co:      "#bf5af2",
  color_on_animal:  "#ff6b00",
  color_on_vehicle: "#ff3b80",
  color_on_default: "#ff3b30",

  // Triggered zone colours — ALARM OFF (alarm disarmed; sensor still active)
  color_off_person:  "#4cd964",
  color_off_motion:  "#5ac8fa",
  color_off_door:    "#ffcc00",
  color_off_window:  "#ffcc00",
  color_off_smoke:   "#ff6b6b",
  color_off_co:      "#cc73f8",
  color_off_animal:  "#aad400",
  color_off_vehicle: "#00c7be",
  color_off_default: "#4cd964",

  // Legacy keys kept for backward compat
  color_triggered_person:  "#ff3b30",
  color_triggered_motion:  "#ff9500",
  color_triggered_door:    "#ff6b35",
  color_triggered_window:  "#ff9f0a",
  color_triggered_smoke:   "#ff2d55",
  color_triggered_co:      "#bf5af2",
  color_triggered_default: "#ff3b30",

  // Zone state colours
  color_zone_normal:    "rgba(0,150,255,0.18)",
  color_zone_triggered: "rgba(255,59,48,0.45)",
  color_zone_fault:     "rgba(255,149,0,0.45)",
  color_zone_bypassed:  "rgba(100,100,100,0.35)",
  color_zone_armed:     "rgba(0,200,100,0.25)",

  // Zone fade-out after trigger clears (issue 9)
  zone_fade_duration: 3,  // seconds to fade from full to transparent after trigger clears

  // Camera dashboard
  cam_default_mode:       "snapshot",  // "snapshot" | "live"
  cam_snapshot_interval: 1,      // snapshot-grid-v1.2: browser refresh default seconds
  cam_cooldown:           30,          // seconds camera stays visible after zone clears
  cam_max_visible:        0,           // 0 = unlimited
  cam_sort_order:         "recent_first",
  cam_fail_hide_seconds:  30,
  cam_low_res_map:        "{}",        // JSON: { "camera.high_res": "camera.low_res" }
  cam_pinned:             "[]",        // JSON: ["camera.entity_id", ...]
};

let zoom = { scale: 1, x: 0, y: 0 };
let lastConfig = "";
let pollingTimer = null;

/* ─── ZONES STATE ─────────────────────────────────────────── */
let zones = [];
let groups = [];          // Zone groups
let floors = [];          // Floor definitions [{id, name, floorplan}]
let activeFloorId = null; // Currently displayed floor id
// v0.05.35.07: suppress floor navigation while HA area assignment/sync refreshes data.
window._owSuppressFloorChange = window._owSuppressFloorChange || false;
let lights     = [];      // Map light pins [{id, name, entity_id, floor_id, x, y, direction}]
let sirens     = [];      // Map siren pins [{id, name, entity_id, floor_id, x, y}]
let cameraPins = [];      // Map camera pins [{id, name, entity_id, floor_id, x, y}]
let doorPins   = [];      // Map door pins [{id, name, sensor_entity, control_entity, floor_id, x, y, rotation}]
let camLowResMap = {};    // { "camera.high": "camera.low" } — persisted to ui.yaml


/* ─── DOOR PIN HELPERS moved to modules/ow-door-pins.js ───────────────────────── */
function getCamLowRes(highResId) {
  const forceHigh = localStorage.getItem('ow_cam_always_high_res') === 'true';
  if (forceHigh) return highResId;
  return camLowResMap[highResId] || highResId;
}

async function saveCamLowResMap() {
  uiConfig.cam_low_res_map = JSON.stringify(camLowResMap);
  // Save to a dedicated file so we don't need to rebuild all of ui.yaml
  try {
    await fetch(apiPath("ow/save-config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "config/cam_low_res.json", content: JSON.stringify(camLowResMap, null, 2) })
    });
    // Sync to cameras.js internal map
    if (window.setCamLowResMap) window.setCamLowResMap(camLowResMap);
    if (window.OW) window.OW.uiConfig = uiConfig;
  } catch(e) { console.warn('Failed to save cam low res map', e); }
}

// Multi-panel state
let activePanelIdx = 0;   // Which floor panel is "selected" (zoom/reset target)
let panelZooms = [        // Per-panel zoom state
  { scale: 1, x: 0, y: 0 },
  { scale: 1, x: 0, y: 0 },
];

/* ─── FLOOR PANEL TOP HELPERS moved to modules/ow-floors.js ───────────────────────── */
let selectedZoneId  = null;
let selectedGroupId = null; // "group" or "zone" selection in editor
let editorMode = false;
let undoStack = [];
let isCreatingZone = false;
let currentNewZone = null;
let draggingHandle = null;
let draggingZone = null;
let dragStart = null;
let isEditingPoints = false;

/* ─── SEARCH STATE ────────────────────────────────────────── */
let searchOpen = false;
let settingsOpen = false;
let highlightedZoneId  = null;
let highlightedUntil   = 0;
let highlightedGroupId = null;
let highlightedGroupUntil = 0;
let searchDebounce = null;

/* ─── HA STATE ────────────────────────────────────────────── */
let haSocket = null;
let haConnected = false;
let haEverConnected = false;  // true after first successful auth_ok
let haStates = {};        // entity_id -> state object
let haStatesLoaded = false; // true after first successful get_states response

// HA registry — floors, areas, devices, entities from HA config registries
let _haRegistry = { floors: [], areas: [], devices: [], entities: [], loaded: false };

// Returns true if entity is ghosted (excluded) in any zone — hides from search/automations
function isEntityGhosted(entityId) {
  return zones.some(z => (z.ha_excluded_entities||[]).includes(entityId));
}

function haRegistryFingerprint(reg = _haRegistry) {
  const areas = (reg.areas || []).map(a => `${a.area_id}:${a.floor_id || ''}`).sort().join('|');
  const devices = (reg.devices || []).map(d => `${d.id}:${d.area_id || ''}`).sort().join('|');
  const entities = (reg.entities || []).map(e => `${e.entity_id}:${e.area_id || ''}:${e.device_id || ''}:${e.disabled_by || ''}:${e.hidden_by || ''}`).sort().join('|');
  return `${reg.refresh_id || 0}::${areas}::${devices}::${entities}`;
}

async function loadHARegistry(force = false) {
  const beforeFingerprint = haRegistryFingerprint();
  try {
    let refreshInfo = null;
    if (force) {
      const rr = await fetch(apiPath('ow/ha-registry/refresh'), { method: 'POST', cache: 'no-store' }).catch(() => null);
      if (rr?.ok) refreshInfo = await rr.json().catch(() => null);
    }

    const attempts = force ? 24 : 1;
    for (let i = 0; i < attempts; i++) {
      const r = await fetch(apiPath('ow/ha-registry') + '?v=' + Date.now(), { cache: 'no-store' });
      if (r.ok) {
        const nextRegistry = await r.json();
        _haRegistry = nextRegistry;
        const freshEnough = !force
          || (nextRegistry.loaded && !nextRegistry.refreshing && (
            (refreshInfo?.refresh_id && nextRegistry.refresh_id >= refreshInfo.refresh_id)
            || haRegistryFingerprint(nextRegistry) !== beforeFingerprint
            || refreshInfo?.completed === true
          ));
        if (freshEnough) break;
      }
      if (force) await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (force) {
      try {
        const sr = await fetch(apiPath('ow/states') + '?v=' + Date.now(), { cache: 'no-store' });
        if (sr.ok) {
          const states = await sr.json();
          Object.values(states || {}).forEach(st => { if (st?.entity_id) haStates[st.entity_id] = st; });
          haStatesLoaded = Object.keys(haStates).length > 0;
        }
      } catch {}
    }
    if (_haRegistry.loaded) {
      await autoAddNewHAAreas();
      if (force) await syncHAAreaZoneEntitiesFromRegistry();
    }

    if (force) {
      if (window.OW_Automations?.refreshEntityCache) await window.OW_Automations.refreshEntityCache(true).catch(()=>{});
      const prevActiveFloorId = activeFloorId;
      const prevSelectedZoneId = selectedZoneId;
      const prevSelectedGroupId = selectedGroupId;
      const prevSuppressFloorChange = window._owSuppressFloorChange === true;
      window._owSuppressFloorChange = true;
      try {
        await loadZones();
        await loadGroups();
        await loadFloors();
        if (prevActiveFloorId && floors.some(f => f.id === prevActiveFloorId)) activeFloorId = prevActiveFloorId;
        if (activeFloorId) localStorage.setItem("ow_active_floor", activeFloorId);
        if (prevSelectedZoneId && zones.some(z => z.id === prevSelectedZoneId)) selectedZoneId = prevSelectedZoneId;
        if (prevSelectedGroupId && groups.some(g => g.id === prevSelectedGroupId)) selectedGroupId = prevSelectedGroupId;
      } finally {
        window._owSuppressFloorChange = prevSuppressFloorChange;
      }
      subscribeHAEntities();
      renderZones();
      if (editorMode) renderZonesEditorStable(true);
      if (window._updateFloorBtn) window._updateFloorBtn();
      logEvent('ok', `HA registry sync complete: ${(_haRegistry.areas || []).length} areas, ${(_haRegistry.devices || []).length} devices, ${(_haRegistry.entities || []).length} entities.`, 'ha');
    }
  } catch (e) {
    if (force) logEvent('warn', `HA registry sync failed: ${e.message || e}`, 'ha');
    _haRegistry = { floors: [], areas: [], devices: [], entities: [], loaded: false, refreshing: false };
  }
}

// Check each linked floor for new HA areas and auto-create zones if ha_auto_add_areas is on
async function autoAddNewHAAreas() {
  for (const floor of floors) {
    if (!floor.ha_floor_id || floor.ha_auto_add_areas === false) continue;
    const haAreas = (_haRegistry.areas || []).filter(a => a.floor_id === floor.ha_floor_id);
    if (!floor.ha_linked_area_ids) floor.ha_linked_area_ids = [];
    for (const area of haAreas) {
      if (floor.ha_linked_area_ids.includes(area.area_id)) continue; // already linked
      // New area — auto-create zone and add to linked list
      floor.ha_linked_area_ids.push(area.area_id);
      const existing = zones.find(z => z.ha_area_id === area.area_id);
      if (!existing) {
        await createZoneFromHAArea(area.area_id, area.name, floor.id);
      }
      await saveFloor(floor);
      logEvent('info', `Auto-created zone for new HA area "${area.name}"`, 'system');
    }
  }
}

// Get all entity registry entries for a given area_id
function haEntitiesForArea(areaId) {
  if (!areaId || !_haRegistry.loaded) return [];
  // Find devices in this area
  const deviceIds = new Set(_haRegistry.devices.filter(d => d.area_id === areaId).map(d => d.id));
  // Get entities assigned directly to area OR via their device
  return _haRegistry.entities.filter(e =>
    e.area_id === areaId || (e.device_id && deviceIds.has(e.device_id))
  ).filter(e => !e.disabled_by && !e.hidden_by); // skip disabled/hidden entities
}

// Device class filters per OW tab
const HA_DOOR_CLASSES = new Set(['door','window','garage_door','opening','gate']);
const HA_ZONE_SENSOR_CLASSES = new Set([
  'motion','occupancy','presence','vibration','sound','moisture','smoke','carbon_monoxide','heat','cold','gas','tamper','connectivity','power','problem','safety','update','moving'
]);
// Camera/object-detection binary sensors often have no useful device_class.
// Include common AI/object detection entity names from cameras/NVRs when syncing HA areas.
const HA_OBJECT_DETECTION_RE = /(^|[._\s-])(person|people|human|animal|pet|dog|cat|vehicle|car|truck|bike|bicycle|motorbike|motorcycle|package|parcel|object)[._\s-]*(detect|detected|detection|occupancy|presence|alarm|motion)?([._\s-]|$)|(^|[._\s-])(detect|detected|detection)[._\s-]*(person|people|human|animal|pet|dog|cat|vehicle|car|truck|bike|bicycle|motorbike|motorcycle|package|parcel|object)([._\s-]|$)/;

// HA Area sync filter only. Runtime triggering must respect whatever the user has
// intentionally left in Sensors or Doors & Windows unless that entity is ghosted.
const HA_DOOR_INCLUDE_RE = /(^|[._\s-])((garage[._\s-]*door)|(screen[._\s-]*door)|(roller[._\s-]*door)|(door[._\s-]*(sensor|contact))|(window[._\s-]*(sensor|contact))|gate|garage_door|door|window|opening|reed|contact)([._\s-]|$)/;
const HA_DOOR_EXCLUDE_RE = /(^|[._\s-])(battery|batt|charger|chargers|charging|charge|status|controller|physical[._\s-]*switch|switch|light|lights|motion|occupancy|presence|illuminance|lux|temperature|humidity|voltage|current|power|energy|rssi|lqi|linkquality|signal|tamper|problem|update)([._\s-]|$)/;

function haEntityDeviceClass(e) {
  return String(e?.device_class || e?.original_device_class || haStates[e?.entity_id]?.attributes?.device_class || '').toLowerCase();
}

function haEntityText(e) {
  const st = haStates[e?.entity_id];
  return [e?.entity_id, e?.name, e?.original_name, st?.attributes?.friendly_name, haEntityDeviceClass(e)]
    .filter(Boolean).join(' ').toLowerCase();
}

function isHADoorEntity(e) {
  const eid = String(e?.entity_id || '').toLowerCase();
  const dc = haEntityDeviceClass(e);
  const text = haEntityText(e);
  if (!eid.startsWith('binary_sensor.')) return false;
  if (HA_DOOR_CLASSES.has(dc)) return true;
  return HA_DOOR_INCLUDE_RE.test(text) && !HA_DOOR_EXCLUDE_RE.test(text);
}

const HA_AREA_FILTERS = {
  sensors: e => {
    const eid = String(e?.entity_id || '').toLowerCase();
    const dc = haEntityDeviceClass(e);
    const text = haEntityText(e);
    return eid.startsWith('binary_sensor.')
      && !eid.startsWith('binary_sensor.overwatch_')
      && !isHADoorEntity(e)
      && (HA_ZONE_SENSOR_CLASSES.has(dc) || HA_OBJECT_DETECTION_RE.test(text));
  },
  cameras: e => String(e?.entity_id || '').startsWith('camera.'),
  lights: e => String(e?.entity_id || '').startsWith('light.'),
  sirens: e => String(e?.entity_id || '').startsWith('siren.'),
  doors: e => isHADoorEntity(e),
};

function haAreaEntitiesByKind(areaId, kind) {
  const filter = HA_AREA_FILTERS[kind];
  if (!filter) return [];
  return haEntitiesForArea(areaId).filter(filter).map(e => e.entity_id).filter(Boolean).sort((a,b)=>a.localeCompare(b, undefined, { sensitivity:'base', numeric:true }));
}

async function syncHAAreaZoneEntitiesFromRegistry() {
  if (!_haRegistry.loaded) return { changed: 0, added: 0 };
  let changed = 0;
  let added = 0;
  for (const zone of zones) {
    if (!zone?.ha_area_id) continue;
    const excluded = new Set((zone.ha_excluded_entities || []).map(String));
    let zoneChanged = false;
    for (const kind of ['sensors', 'cameras', 'lights', 'sirens']) {
      const current = new Set((zone[kind] || []).map(String).filter(Boolean));
      const candidates = haAreaEntitiesByKind(zone.ha_area_id, kind).filter(entityId => !excluded.has(entityId));
      for (const entityId of candidates) {
        if (current.has(entityId)) continue;
        current.add(entityId);
        zoneChanged = true;
        added++;
      }
      zone[kind] = [...current].sort((a,b)=>a.localeCompare(b, undefined, { sensitivity:'base', numeric:true }));
    }
    if (zoneChanged) {
      changed++;
      await saveZone(zone);
    }
  }
  if (changed) logEvent('ok', `HA area sync added ${added} entities across ${changed} zone${changed === 1 ? '' : 's'}.`, 'ha');
  return { changed, added };
}
let haMsgId = 1;
let haPendingCmds = {};
let mapLocked = localStorage.getItem('ow_map_locked') === 'true'; // prevent pan/zoom when true

// Client IP — injected by server.js into the HTML as a meta tag
const CLIENT_IP = document.querySelector('meta[name="ow-client-ip"]')?.content || '';

// Allowed IPs loaded from server (config/arm_allowed_ips.json)
let _armAllowedIps = [];

async function loadArmAllowedIps() {
  try {
    const r = await fetch(apiPath('ow/arm-allowed-ips') + '?v=' + Date.now());
    if (r.ok) { const d = await r.json(); _armAllowedIps = d.ips || []; }
  } catch { _armAllowedIps = []; }
}

async function saveArmAllowedIps(ipsArray) {
  _armAllowedIps = ipsArray;
  await fetch(apiPath('ow/arm-allowed-ips'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ips: ipsArray })
  });
}

// Returns true if this device is allowed to arm/disarm zones
function canArmDisarm() {
  if (!_armAllowedIps.length) return false; // no IPs configured → no devices allowed
  return _armAllowedIps.some(ip => CLIENT_IP === ip || CLIENT_IP.startsWith(ip));
}
let haReconnectTimer = null;
let haReconnectDelay = 1000;   // exponential backoff: 1s→2s→4s→8s→30s max
let haSubscribedEntities = new Set();

/* ─── MODULE LOADER ───────────────────────────────────────── */
async function loadModule(targetId, file) {
  const target = document.getElementById(targetId);
  if (!target) return;

  const urls = [
    `modules/${file}?v=${Date.now()}`,
    `${file}?v=${Date.now()}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      // Detect HA ingress session expiry — HA frontend HTML served instead of our module
      if (text.includes("home-assistant") || text.includes("<!DOCTYPE html>")) {
        console.error("[HA-Overwatch] Ingress session expired — reloading...");
        setTimeout(() => window.location.reload(), 1500);
        return;
      }
      target.innerHTML = text;
      return;
    } catch {
      // try next
    }
  }

  console.error(`[HA-Overwatch] Failed to load module: ${file} (tried /modules and root)`);
}


/* ─── YAML PARSER (flat key: value, handles colon-containing values) ── */
function parseYaml(text) {
  const lines = text.split("\n");
  const out = {};
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "ui:") continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!key || key.includes(" ")) continue;
    const vRaw = line.slice(colonIdx + 1).trim();
    let v = vRaw.replace(/\s+#.*$/, "");           // strip inline comments
    v = v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"); // strip quotes
    if (v === "")      { out[key] = "";    continue; }
    if (v === "true")  { out[key] = true;  continue; }
    if (v === "false") { out[key] = false; continue; }
    const num = Number(v);
    out[key] = (!isNaN(num) && v !== "") ? num : v;
  }
  return out;
}

/* ─── LOAD CONFIG ─────────────────────────────────────────── */
let lastConfigHash = "";

async function loadConfig() {
  try {
    const res = await fetch(apiPath("config/ui.yaml") + "?v=" + Date.now());
    if (!res.ok) return;
    const text = await res.text();
    // Simple hash to detect changes
    const hash = text.length + "|" + text.slice(0, 120) + text.slice(-60);
    if (hash === lastConfigHash) return;
    lastConfigHash = hash;
    lastConfig = text;
    const parsed = parseYaml(text);
    uiConfig = { ...uiConfig, ...parsed };
    applyConfig();
  } catch { /* ignore */ }
}


function getSidebarCollapsedPreference() {
  const saved = localStorage.getItem("ow_sidebar_collapsed");
  if (saved === "true") return true;
  if (saved === "false") return false;
  // Dashboard-safe default: first load starts with the sidebar closed.
  return true;
}

function setSidebarCollapsedPreference(collapsed) {
  localStorage.setItem("ow_sidebar_collapsed", collapsed ? "true" : "false");
  uiConfig.sidebar_collapsed = !!collapsed;
}

/* ─── APPLY CONFIG ────────────────────────────────────────── */
function applyConfig() {
  const root = document.documentElement;
  root.style.setProperty("--sidebar-icon-size", uiConfig.sidebar_icon_size + "px");
  root.style.setProperty("--sidebar-icon-padding", uiConfig.sidebar_icon_padding + "px");
  root.style.setProperty("--map-icon-size", uiConfig.map_icon_size + "px");

  // Apply colour overrides from config
  const colorMap = {
    "--color-triggered-person":  "color_triggered_person",
    "--color-triggered-motion":  "color_triggered_motion",
    "--color-triggered-door":    "color_triggered_door",
    "--color-triggered-window":  "color_triggered_window",
    "--color-triggered-smoke":   "color_triggered_smoke",
    "--color-triggered-co":      "color_triggered_co",
    "--color-triggered-default": "color_triggered_default",
    "--color-zone-normal":       "color_zone_normal",
    "--color-zone-triggered":    "color_zone_triggered",
    "--color-zone-fault":        "color_zone_fault",
    "--color-zone-bypassed":     "color_zone_bypassed",
    "--color-zone-armed":        "color_zone_armed",
    "--color-door-open":         "color_on_door",
    "--color-door-closed":       "color_off_door",
  };
  for (const [cssVar, cfgKey] of Object.entries(colorMap)) {
    // Check localStorage override first (set by settings colour pickers)
    const lsKey = 'ow_' + cfgKey;
    const val = localStorage.getItem(lsKey) || uiConfig[cfgKey];
    if (val) root.style.setProperty(cssVar, val);
  }

  const statusEl = document.getElementById("statusText");
  if (statusEl) statusEl.textContent = uiConfig.status;

  const fp = document.getElementById("floorplanImage");
  if (fp && uiConfig.floorplan) {
    // v0.05.35.07: if floors are loaded, the active floor owns the image.
    // Prevent config polling from reverting the map image to the default floorplan.
    const activeFloorPlan = (typeof activeFloor === 'function' ? activeFloor()?.floorplan : null) || uiConfig.floorplan;
    const fpPath   = apiPath(activeFloorPlan);
    const newBase  = fpPath.split("?")[0];
    const curBase  = fp.src.split("?")[0].replace(window.location.origin, "").replace(/^\/api\/hassio_ingress\/[^/]+/, "");
    if (!fp.dataset.loaded || !fp.src.includes(encodeURIComponent(activeFloorPlan).replace(/%20/g, " ").split("/").pop().split("?")[0])) {
      fp.src = fpPath + "?v=" + Date.now();
      fp.dataset.loaded = "1";
      fp.onload = initFloorplan;
    } else if (!fp.dataset.initialized) {
      fp.dataset.initialized = "1";
      initFloorplan();
    }
  }

  const sidebar = document.getElementById("sidebarEl");
  if (sidebar) {
    sidebar.classList.remove("left", "right");
    sidebar.classList.add(uiConfig.sidebar_position || "right");

    // Per-browser dashboard preference. If no preference exists yet, default closed.
    // Do not let ui.yaml polling reopen the sidebar on wall dashboards.
    const collapsed = getSidebarCollapsedPreference();
    uiConfig.sidebar_collapsed = collapsed;
    if (collapsed) {
      sidebar.classList.add("collapsed");
      updateExpandBtn(true);
    } else {
      sidebar.classList.remove("collapsed");
      updateExpandBtn(false);
    }
  }

  restartPolling();

  // Re-connect HA if credentials changed — skip in Direct Mode (backend handles HA), add-on mode, or already connected
  if (!IS_DIRECT_MODE && !haConnected && isAddonMode === false && uiConfig.ha_url && uiConfig.ha_token) {
    connectHA();
  }

  // Re-apply alarm status in case alarm_entity or alarm_entity_inverted changed in config
  if (haConnected) {
    const alarmEntity = uiConfig.alarm_entity;
    if (alarmEntity && haStates[alarmEntity]) {
      updateStatusFromAlarm(alarmEntity, haStates[alarmEntity]);
    } else {
      const autoAlarm = Object.keys(haStates).find(id => id.startsWith("alarm_control_panel."));
      if (autoAlarm) updateStatusFromAlarm(autoAlarm, haStates[autoAlarm]);
    }
    subscribeHAEntities(); // re-register alarm entity in subscription set
  }

  applyStatusVisibility();
}

function applyStatusVisibility() {
  // Zone status bar + dropdown
  const hideZone = localStorage.getItem("ow_hide_zone_status") === "true";
  const statusBar = document.getElementById("statusBar");
  const statusDd  = document.getElementById("statusDropdown");
  if (statusBar) statusBar.style.display = hideZone ? "none" : "";
  if (statusDd && hideZone) statusDd.style.display = "none";

  // Camera status — button rendered by cameras.js; hide by known IDs or sibling of dropdown
  const hideCam  = localStorage.getItem("ow_hide_camera_status") === "true";
  const camStatusDd  = document.getElementById("camStatusDd");
  // Try known wrapper ID first, then fall back to the dropdown's parent
  const camStatusBar = document.getElementById("camStatusBar")
    || (camStatusDd ? camStatusDd.previousElementSibling : null);
  if (camStatusBar) camStatusBar.style.display = hideCam ? "none" : "";
  if (camStatusDd) camStatusDd.style.display = hideCam ? "none" : (camStatusDd.style.display === "none" ? "none" : "");
}

/* ─── EXPAND / COLLAPSE SIDEBAR ───────────────────────────── */
/* updateExpandBtn moved to modules/ow-sidebar.js */
/* bindSidebarToggle moved to modules/ow-sidebar.js */
/* ─── ZOOM / PAN ──────────────────────────────────────────── */
// Strategy: transform the entire #floorplanWrapper (image + SVG overlay together).
// This means zones ALWAYS align perfectly at any zoom/pan — no coordinate math needed for rendering.
// Points are stored in "natural image px" space (image at scale=1, origin top-left of wrapper).

function applyTransform() {
  const wrapper = document.getElementById("floorplanWrapper");
  if (wrapper) wrapper.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  if (editorMode) renderZones();
}

function saveZoom() {
  localStorage.setItem("zoomScale", zoom.scale);
  localStorage.setItem("zoomX", zoom.x);
  localStorage.setItem("zoomY", zoom.y);
}

function loadZoom() {
  zoom.scale = Number(localStorage.getItem("zoomScale")) || 1;
  zoom.x     = Number(localStorage.getItem("zoomX"))     || 0;
  zoom.y     = Number(localStorage.getItem("zoomY"))     || 0;
  applyTransform();
}

function bindZoomControls() {
  const zoomIn    = document.getElementById("zoomIn");
  const zoomOut   = document.getElementById("zoomOut");
  const zoomReset = document.getElementById("zoomReset");
  if (!zoomIn) return;

  function zoomAroundCenter(factor) {
    if (mapLocked && !editorMode) return;
    const panel = document.getElementById("mapPanel");
    const vw = (panel && panel.offsetWidth > 0) ? panel.offsetWidth : window.innerWidth;
    const vh = (panel && panel.offsetHeight > 0) ? panel.offsetHeight : window.innerHeight;
    const cx = vw / 2, cy = vh / 2;
    zoom.x = cx - (cx - zoom.x) * factor;
    zoom.y = cy - (cy - zoom.y) * factor;
    zoom.scale = Math.min(10, Math.max(0.1, zoom.scale * factor));
    applyTransform(); saveZoom();
  }

  zoomIn.onclick    = () => zoomAroundCenter(1.15);
  zoomOut.onclick   = () => zoomAroundCenter(1 / 1.15);
  zoomReset.onclick = () => {
    if (mapLocked && !editorMode) return;
    const wrapper = document.getElementById("floorplanWrapper");
    const img     = document.getElementById("floorplanImage");
    if (wrapper && img) {
      const panel = document.getElementById("mapPanel");
      const vw = (panel && panel.offsetWidth > 0) ? panel.offsetWidth : window.innerWidth;
      const vh = (panel && panel.offsetHeight > 0) ? panel.offsetHeight : window.innerHeight;
      const iw = img.naturalWidth  || img.offsetWidth;
      const ih = img.naturalHeight || img.offsetHeight;
      zoom.scale = Math.min(vw / iw, vh / ih, 1);
      zoom.x = (vw - iw * zoom.scale) / 2;
      zoom.y = (vh - ih * zoom.scale) / 2;
    } else {
      zoom.scale = 1; zoom.x = 0; zoom.y = 0;
    }
    applyTransform(); saveZoom();
  };

  // Map lock button
  const lockBtn = document.getElementById('mapLockBtn');
  function applyLockState() {
    const icon = document.getElementById('mapLockIcon');
    if (!icon) return;
    if (mapLocked) {
      // Locked padlock
      icon.innerHTML = `
        <rect x="5" y="11" width="14" height="10" rx="2" stroke="rgba(255,200,0,0.9)" stroke-width="2"/>
        <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="rgba(255,200,0,0.9)" stroke-width="2" stroke-linecap="round"/>
        <circle cx="12" cy="16" r="1.5" fill="rgba(255,200,0,0.9)"/>`;
      lockBtn?.classList.add('active');
    } else {
      // Unlocked padlock
      icon.innerHTML = `
        <rect x="5" y="11" width="14" height="10" rx="2" stroke="rgba(255,255,255,0.9)" stroke-width="2"/>
        <path d="M8 11V7a4 4 0 0 1 7.9-.9" stroke="rgba(255,255,255,0.9)" stroke-width="2" stroke-linecap="round"/>
        <circle cx="12" cy="16" r="1.5" fill="rgba(255,255,255,0.9)"/>`;
      lockBtn?.classList.remove('active');
    }
  }
  if (lockBtn) {
    applyLockState();
    lockBtn.onclick = () => {
      mapLocked = !mapLocked;
      localStorage.setItem('ow_map_locked', mapLocked ? 'true' : 'false');
      applyLockState();
      // Update handle cursors
      const splitH = document.getElementById('splitHandle');
      if (splitH) splitH.style.cursor = mapLocked ? 'default' : '';
      document.querySelectorAll('.floor-panel-handle').forEach(h => {
        h.style.cursor = mapLocked ? 'default' : '';
      });
    };
  }
}

function bindPan() {
  const outer = document.querySelector(".main") || document.body;
  let dragging = false, startX = 0, startY = 0;

  outer.addEventListener("pointerdown", e => {
    // In multi-panel mode, floor panels handle their own pan
    if (getNumPanels() > 1 && e.target.closest('.floor-panel')) return;
    // Don't pan when interacting with map pins
    if (e.target.closest('[data-pin]')) return;
    // Don't pan when map is locked
    if (mapLocked && !editorMode) return;
    if (editorMode) {
      const t = e.target;
      // Don't start pan if clicking zone handles, polygons, or the zones-editor panel
      if (t.classList.contains("zone-handle") || t.classList.contains("zone-polygon")) return;
      if (isCreatingZone) return;
      if (e.target.closest(".zones-editor")) return;
    }
    if (e.target.closest(".search-panel, .settings-panel, .log-panel, .sidebar, .zoom-controls, .status-bar, .expand-btn")) return;
    dragging = true;
    startX = e.clientX - zoom.x;
    startY = e.clientY - zoom.y;
    outer.setPointerCapture(e.pointerId);
  });

  outer.addEventListener("pointermove", e => {
    if (!dragging) return;
    if (getNumPanels() > 1) { dragging = false; return; }
    zoom.x = e.clientX - startX;
    zoom.y = e.clientY - startY;
    applyTransform();
  });

  outer.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    saveZoom();
  });

  // Issue 6: mouse wheel zoom around cursor
  outer.addEventListener("wheel", e => {
    if (e.target.closest(".zones-editor, .search-panel, .settings-panel, .log-panel, .sidebar, .zoom-controls")) return;
    if (mapLocked && !editorMode) return; // locked
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const rect   = outer.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const newScale = Math.min(10, Math.max(0.1, zoom.scale * factor));
    // Zoom around cursor
    zoom.x = cx - (cx - zoom.x) * (newScale / zoom.scale);
    zoom.y = cy - (cy - zoom.y) * (newScale / zoom.scale);
    zoom.scale = newScale;
    // Clamp so map can't fly off-screen
    const img = document.getElementById('floorplanImage') || document.querySelector('.fp-img');
    if (img && img.naturalWidth) {
      const iw = img.naturalWidth * zoom.scale;
      const ih = img.naturalHeight * zoom.scale;
      const margin = 100;
      zoom.x = Math.min(rect.width  - margin, Math.max(-(iw - margin), zoom.x));
      zoom.y = Math.min(rect.height - margin, Math.max(-(ih - margin), zoom.y));
    }
    applyTransform();
    saveZoom();
  }, { passive: false });
}

/* ─── POLLING ─────────────────────────────────────────────── */
function restartPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(loadConfig, uiConfig.polling_interval * 1000);
}

/* ─── COORDINATE HELPERS ──────────────────────────────────── */
// Convert viewport screen coords → wrapper-local image coords
function screenToFloorplan(sx, sy) {
  return {
    x: (sx - zoom.x) / zoom.scale,
    y: (sy - zoom.y) / zoom.scale,
  };
}

// Not needed for rendering (SVG is inside the transformed wrapper)
// but kept for focusZone / animateZoomTo compatibility
function floorplanToScreen(fx, fy) {
  return {
    x: fx * zoom.scale + zoom.x,
    y: fy * zoom.scale + zoom.y,
  };
}

/* ─── ZONES STORAGE ───────────────────────────────────────── */
const ZONES_DIR = "config/zones/";

function zoneFilename(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".yaml";
}

function hexToRgba(hex, alpha) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}


const ZONE_ENTITY_LIST_KEYS = ['sensors', 'cameras', 'lights', 'sirens'];
const zonePersistedEntitySnapshot = new Map();
function cloneZoneEntityLists(zone) {
  const out = { ha_area_id: zone?.ha_area_id || '' };
  ZONE_ENTITY_LIST_KEYS.forEach(key => {
    out[key] = Array.isArray(zone?.[key]) ? zone[key].map(String).filter(Boolean) : [];
  });
  return out;
}
function rememberZoneEntitySnapshot(zone) {
  if (!zone?.id) return;
  zonePersistedEntitySnapshot.set(zone.id, cloneZoneEntityLists(zone));
}
function rememberAllZoneEntitySnapshots() {
  zones.forEach(rememberZoneEntitySnapshot);
}
function mergeUniqueEntityList(existing, incoming) {
  return [...new Set([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
    .map(String).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b, undefined, { sensitivity:'base', numeric:true }));
}
function preserveEntitiesOnHAAreaAssignment(zone) {
  if (!zone?.id || !zone.ha_area_id) return false;
  const previous = zonePersistedEntitySnapshot.get(zone.id);
  if (!previous) return false;
  // Only apply this guard when a HA area is newly assigned or changed. Normal manual deletes after
  // the zone already has the same HA area must still be respected.
  if ((previous.ha_area_id || '') === (zone.ha_area_id || '')) return false;
  let changed = false;
  ZONE_ENTITY_LIST_KEYS.forEach(key => {
    const before = JSON.stringify(zone[key] || []);
    zone[key] = mergeUniqueEntityList(zone[key], previous[key]);
    if (JSON.stringify(zone[key] || []) !== before) changed = true;
  });
  if (changed) logEvent('info', `Preserved existing zone entities while assigning HA area to ${zone.name || zone.id}.`, 'ha');
  return changed;
}

function zoneToYaml(z) {
  let out = `id: ${z.id}\n`;
  out += `name: "${(z.name || "").replace(/"/g, '\\"')}"\n`;
  out += `color: "${z.colorHex || "#0096ff"}"\n`;
  out += `enabled: ${z.enabled !== false}\n`;
  out += `hidden: ${z.hidden === true}\n`;
  if (z.floor_id)    out += `floor_id: ${z.floor_id}\n`;
  if (z.ha_area_id)  out += `ha_area_id: ${z.ha_area_id}\n`;
  out += `points:\n`;
  (z.points || []).forEach(p => { out += ` - [${Math.round(p.x)}, ${Math.round(p.y)}]\n`; });
  out += `sensors:\n`;
  (z.sensors || []).forEach(s => { out += ` - ${s}\n`; });
  out += `cameras:\n`;
  (z.cameras || []).forEach(s => { out += ` - ${s}\n`; });
  out += `lights:\n`;
  (z.lights || []).forEach(s => { out += ` - ${s}\n`; });
  out += `sirens:\n`;
  (z.sirens || []).forEach(s => { out += ` - ${s}\n`; });
  if ((z.ha_excluded_entities || []).length) {
    out += `ha_excluded_entities:\n`;
    (z.ha_excluded_entities || []).forEach(s => { out += ` - ${s}\n`; });
  }
  return out;
}

function parseZoneYaml(text) {
  const z = { points: [], sensors: [], cameras: [], lights: [], sirens: [], ha_excluded_entities: [], enabled: true, hidden: false };
  let section = "";

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "points:")               { section = "points";               continue; }
    if (line === "sensors:")              { section = "sensors";              continue; }
    if (line === "cameras:")              { section = "cameras";              continue; }
    if (line === "lights:")               { section = "lights";               continue; }
    if (line === "sirens:")               { section = "sirens";               continue; }
    if (line === "ha_excluded_entities:") { section = "ha_excluded_entities"; continue; }

    if (line.startsWith("-")) {
      const val = line.slice(1).trim();
      if (section === "points") {
        const m = val.match(/\[\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*\]/);
        if (m) z.points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
      } else if (section === "sensors")              { z.sensors.push(val); }
      else if (section === "cameras")                { z.cameras.push(val); }
      else if (section === "lights")                 { z.lights.push(val); }
      else if (section === "sirens")                 { z.sirens.push(val); }
      else if (section === "ha_excluded_entities")   { z.ha_excluded_entities.push(val); }
      continue;
    }

    if (line.includes(":")) {
      section = "";
      const colonIdx = line.indexOf(":");
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (key === "id")                     z.id              = val;
      else if (key === "name")              z.name            = val;
      else if (key === "enabled")           z.enabled         = val !== "false";
      else if (key === "hidden")            z.hidden          = val === "true";
      else if (key === "floor_id")          z.floor_id        = val;
      else if (key === "ha_area_id")        z.ha_area_id      = val;
      else if (key === "color")             { z.colorHex = val; z.color = hexToRgba(val, 0.25); }
    }
  }

  if (!z.colorHex) z.colorHex = "#0096ff";
  if (!z.color)    z.color    = hexToRgba(z.colorHex, 0.25);
  return z;
}

async function loadZones() {
  try {
    const idxRes = await fetch(ZONES_DIR + "index.json?v=" + Date.now());
    if (!idxRes.ok) throw new Error("no index");
    const index = await idxRes.json();
    // Skip group files and index files that may have been added by saveGroup
    const zoneFiles = index.filter(f =>
      !f.startsWith("group_") && f !== "groups_index.json" && f.endsWith(".yaml")
    );
    const results = await Promise.all(zoneFiles.map(async filename => {
      const r = await fetch(ZONES_DIR + filename + "?v=" + Date.now());
      if (!r.ok) return null;
      return parseZoneYaml(await r.text());
    }));
    zones = results.filter(Boolean);
    rememberAllZoneEntitySnapshots();
  } catch {
    try { zones = JSON.parse(localStorage.getItem("zones") || "[]"); }
    catch { zones = []; }
    rememberAllZoneEntitySnapshots();
  }
}

async function saveZone(zone) {
  preserveEntitiesOnHAAreaAssignment(zone);
  const filename = zoneFilename(zone.id);
  try {
    const res = await fetch(apiPath("ow/save-zone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, content: zoneToYaml(zone) })
    });
    if (!res.ok) throw new Error(res.statusText);
    // Update dataVersion baseline so we don't self-sync
    try { const h = await fetch(apiPath("ow/health"),{cache:"no-store"}); const d = await h.json(); if(d.dataVersion) _lastDataVersion = d.dataVersion; } catch{}
    rememberZoneEntitySnapshot(zone);
    showSaveToast('Zone');
  } catch {
    localStorage.setItem("zones", JSON.stringify(zones));
    rememberZoneEntitySnapshot(zone);
    showSaveToast('Zone');
  }
}

async function deleteZoneFile(zoneId) {
  const filename = zoneFilename(zoneId);
  try {
    const res = await fetch(apiPath("ow/delete-zone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename })
    });
    if (!res.ok) throw new Error(res.statusText);
  } catch {
    localStorage.setItem("zones", JSON.stringify(zones));
  }
}

function saveZones() {
  zones.forEach(z => saveZone(z));
  localStorage.setItem("zones", JSON.stringify(zones));
}

/* ─── ZONE GROUPS ─────────────────────────────────────────── */
function groupFilename(id) { return `group_${id}.yaml`; }

function groupToYaml(g) {
  let out = `id: ${g.id}\n`;
  out += `name: "${(g.name || "").replace(/"/g, '\\"')}"\n`;
  out += `color: "${g.colorHex || "#ff3b30"}"\n`;
  out += `zone_ids:\n`;
  (g.zone_ids || []).forEach(id => { out += ` - ${id}\n`; });
  return out;
}

function parseGroupYaml(text) {
  const g = { zone_ids: [] };
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "zone_ids:") { section = "zone_ids"; continue; }
    if (line.startsWith("-") && section === "zone_ids") {
      g.zone_ids.push(line.slice(1).trim());
      continue;
    }
    if (line.includes(":")) {
      section = "";
      const ci = line.indexOf(":");
      const key = line.slice(0, ci).trim();
      let val = line.slice(ci + 1).trim().replace(/^"(.*)"$/, "$1");
      if (key === "id")    g.id    = val;
      if (key === "name")  g.name  = val;
      if (key === "color") g.colorHex = val;
    }
  }
  return g;
}

async function loadGroups() {
  try {
    const res = await fetch(apiPath("config/zones/groups_index.json") + "?v=" + Date.now());
    if (!res.ok) { groups = []; return; }
    const index = await res.json();
    const loaded = await Promise.all(index.map(async fname => {
      try {
        const r = await fetch(apiPath("config/zones/" + fname) + "?v=" + Date.now());
        if (!r.ok) return null;
        return parseGroupYaml(await r.text());
      } catch { return null; }
    }));
    groups = loaded.filter(Boolean);
  } catch { groups = []; }
}

/* ─── LIGHTS & SIRENS ─────────────────────────────────────── */
async function loadLights() {
  try {
    const res = await fetch(apiPath("ow/lights") + "?v=" + Date.now());
    lights = res.ok ? await res.json() : [];
  } catch { lights = []; }
}
async function loadSirens() {
  try {
    const res = await fetch(apiPath("ow/sirens") + "?v=" + Date.now());
    sirens = res.ok ? await res.json() : [];
  } catch { sirens = []; }
}
async function saveLight(pin) {
  await fetch(apiPath("ow/save-light"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pin) });
  showSaveToast('Light');
  // Update our dataVersion baseline so we don't re-sync our own change
  try { const h = await fetch(apiPath("ow/health"),{cache:"no-store"}); const d = await h.json(); if(d.dataVersion) _lastDataVersion = d.dataVersion; } catch{}
}
async function saveSiren(pin) {
  await fetch(apiPath("ow/save-siren"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pin) });
  showSaveToast('Siren');
  try { const h = await fetch(apiPath("ow/health"),{cache:"no-store"}); const d = await h.json(); if(d.dataVersion) _lastDataVersion = d.dataVersion; } catch{}
}
async function deleteLight(id) {
  lights = lights.filter(p => p.id !== id);
  await fetch(apiPath("ow/delete-light"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
}
async function deleteSiren(id) {
  sirens = sirens.filter(p => p.id !== id);
  await fetch(apiPath("ow/delete-siren"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
}

/* ─── CAMERA PINS ─────────────────────────────────────────── */
async function loadCameraPins() {
  try {
    const res = await fetch(apiPath("ow/camera-pins") + "?v=" + Date.now());
    cameraPins = res.ok ? await res.json() : [];
  } catch { cameraPins = []; }
}
async function saveCameraPin(pin) {
  await fetch(apiPath("ow/save-camera-pin"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pin) });
  showSaveToast('Camera');
  try { const h = await fetch(apiPath("ow/health"),{cache:"no-store"}); const d = await h.json(); if(d.dataVersion) _lastDataVersion = d.dataVersion; } catch{}
}
async function deleteCameraPin(id) {
  cameraPins = cameraPins.filter(p => p.id !== id);
  await fetch(apiPath("ow/delete-camera-pin"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
}

/* ─── DOOR PIN STORAGE moved to modules/ow-door-pins.js ───────────────────────── */
/* ─── PIN SERVICE HELPERS moved to modules/ow-pins.js ───────────────────────── */
/* ─── DOOR PIN DISPLAY/CONTROL moved to modules/ow-door-pins.js ───────────────────────── */
/* ─── FLOOR STORAGE AND MULTI-PANEL RUNTIME moved to modules/ow-floors.js ───────────────────────── */
async function saveGroup(group) {
  const fname = groupFilename(group.id);
  try {
    // Save group YAML via save-zone route (same directory)
    await fetch(apiPath("ow/save-zone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: fname, content: groupToYaml(group) })
    });
    // Update groups_index.json
    const indexRes = await fetch(apiPath("config/zones/groups_index.json") + "?v=" + Date.now());
    let index = indexRes.ok ? await indexRes.json() : [];
    if (!index.includes(fname)) {
      index.push(fname);
      await fetch(apiPath("ow/save-zone"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "groups_index.json", content: JSON.stringify(index, null, 2) })
      });
    }
    showSaveToast('Group');
  } catch { /* ignore */ }
}

async function deleteGroup(groupId) {
  const fname = groupFilename(groupId);
  try {
    await fetch(apiPath("ow/delete-zone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: fname })
    });
    // Remove from groups_index.json
    const indexRes = await fetch(apiPath("config/zones/groups_index.json") + "?v=" + Date.now());
    let index = indexRes.ok ? await indexRes.json() : [];
    index = index.filter(f => f !== fname);
    await fetch(apiPath("ow/save-zone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "groups_index.json", content: JSON.stringify(index, null, 2) })
    });
  } catch { /* ignore */ }
}

/* Group state helpers */
function getGroupState(group) {
  const members = (group.zone_ids || []).map(id => zones.find(z => z.id === id)).filter(Boolean);
  if (!members.length) return { anyTriggered: false, anyArmed: false, allDisarmed: true };
  const anyTriggered = members.some(z => getZoneState(z) === "triggered");
  const anyArmed     = members.some(z => getZoneState(z) !== "disabled");
  const allDisarmed  = members.every(z => getZoneState(z) === "disabled");
  return { anyTriggered, anyArmed, allDisarmed };
}


function currentGroupIdForZone(zoneId) {
  const group = groups.find(g => (g.zone_ids || []).includes(zoneId));
  return group ? group.id : '';
}

async function setZoneGroup(zoneId, groupId) {
  const changed = [];
  groups.forEach(g => {
    const before = (g.zone_ids || []).slice();
    g.zone_ids = before.filter(id => id !== zoneId);
    if (before.length !== g.zone_ids.length) changed.push(g);
  });
  if (groupId) {
    const target = groups.find(g => g.id === groupId);
    if (target && !(target.zone_ids || []).includes(zoneId)) {
      target.zone_ids = [...(target.zone_ids || []), zoneId];
      if (!changed.includes(target)) changed.push(target);
      localStorage.setItem(`zedGroup_${target.id}`, 'expanded');
    }
  }
  for (const g of changed) await saveGroup(g);
  selectedGroupId = null;
  renderZones();
  renderZonesEditorStable(true);
}

function setGroupArmed(groupId, armed) {
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  // Toggle each member zone switch in HA
  (group.zone_ids || []).forEach(zoneId => {
    const z = zones.find(z => z.id === zoneId);
    if (z) owCallSwitch(`switch.overwatch_zone_${zoneSlug(z)}`, armed);
  });
  // Toggle the group switch in HA
  owCallSwitch(`switch.overwatch_zone_group_${groupSlug(group)}`, armed);
  renderZonesEditorStable();
}

/* ─── UNDO ────────────────────────────────────────────────── */
function pushUndo() {
  undoStack.push(JSON.stringify(zones));
  if (undoStack.length > 50) undoStack.shift();
}

function undoZones() {
  if (!undoStack.length) return;
  try {
    zones = JSON.parse(undoStack.pop());
    saveZones();
    renderZones();
    renderZonesEditorStable();
  } catch { /* ignore */ }
}

/* ─── HA ENTITY TYPE DETECTION ───────────────────────────── */
function detectEntityType(entityId) {
  const id = (entityId || "").toLowerCase();
  if (id.startsWith("binary_sensor.") || id.startsWith("sensor.")) {
    if (id.includes("person") || id.includes("presence")) return "person";
    if (id.includes("animal") || id.includes("pet") || id.includes("dog") || id.includes("cat")) return "animal";
    if (id.includes("vehicle") || id.includes("car") || id.includes("truck")) return "vehicle";
    if (id.includes("motion") || id.includes("occupancy")) return "motion";
    if (id.includes("door")) return "door";
    if (id.includes("window")) return "window";
    if (id.includes("smoke")) return "smoke";
    if (id.includes("co") || id.includes("carbon_monoxide")) return "co";
  }
  if (id.startsWith("person.")) return "person";
  return "default";
}

/* ─── ALARM STATE HELPERS ─────────────────────────────────── */
function isAlarmArmed() {
  const alarmEntity = uiConfig.alarm_entity;
  const checkId = alarmEntity || Object.keys(haStates).find(id => id.startsWith("alarm_control_panel."));
  if (!checkId) {
    return typeof masterSwitchEnabled === "function"
      ? masterSwitchEnabled() && zones.some(zoneSwitchEnabledIgnoringMaster)
      : masterEnabled;
  }
  const st = haStates[checkId];
  if (!st) {
    return typeof masterSwitchEnabled === "function"
      ? masterSwitchEnabled() && zones.some(zoneSwitchEnabledIgnoringMaster)
      : masterEnabled;
  }
  const s = (st.state || "").toLowerCase();
  const inverted = !!uiConfig.alarm_entity_inverted;
  // Standard alarm panel states — not affected by inversion
  if (s === "armed_home" || s === "armed_away" || s === "armed_night" ||
      s === "triggered" || s === "pending" || s === "arming") return true;
  if (s === "disarmed") return false;
  // Generic on/off entity — inversion swaps the meaning
  if (inverted) return s === "off";  // off = armed when inverted
  return s === "on";                  // on = armed normally
}

// v0.05.02 — effective Overwatch monitoring state.
// This is separate from Home Assistant's alarm_control_panel state.
// It resolves whether Overwatch is monitoring all configured zones, some zones, or none.
function zoneSwitchEnabledIgnoringMaster(zone) {
  if (!zone) return false;
  if (!zoneUseServerState()) {
    return localStorage.getItem(ZONE_LOCAL_PREFIX + zone.id) !== 'false';
  }
  const switchState = haStates[`switch.overwatch_zone_${zoneSlug(zone)}`];
  return switchState ? switchState.state !== "off" : zone.enabled !== false;
}

function masterSwitchEnabled() {
  if (!zoneUseServerState()) {
    return localStorage.getItem(ZONE_LOCAL_MASTER) !== 'false';
  }
  const masterSwitch = haStates["switch.overwatch_zone_master"];
  return masterSwitch ? masterSwitch.state !== "off" : masterEnabled;
}

function getEffectiveMonitoringState() {
  const monitoredZones = zones.filter(Boolean); // hidden is visual-only and must not affect alarm state
  const masterOn = masterSwitchEnabled();
  const anyTriggered = monitoredZones.some(z => getZoneState(z) === "triggered");
  const anyFault = monitoredZones.some(z => getZoneState(z) === "fault");

  if (!masterOn || monitoredZones.length === 0) {
    return {
      state: "disarmed",
      label: "Disarmed",
      colour: "#32d74b",
      armedCount: 0,
      disarmedCount: monitoredZones.length,
      total: monitoredZones.length,
      anyTriggered,
      anyFault
    };
  }

  const armedCount = monitoredZones.filter(zoneSwitchEnabledIgnoringMaster).length;
  const disarmedCount = monitoredZones.length - armedCount;

  if (anyTriggered) {
    return {
      state: "triggered",
      label: "Triggered",
      colour: "#ff3b30",
      armedCount,
      disarmedCount,
      total: monitoredZones.length,
      anyTriggered,
      anyFault
    };
  }

  if (armedCount === 0) {
    return {
      state: "disarmed",
      label: "Disarmed",
      colour: "#32d74b",
      armedCount,
      disarmedCount,
      total: monitoredZones.length,
      anyTriggered,
      anyFault
    };
  }

  if (disarmedCount > 0 || anyFault) {
    return {
      state: "armed_partial",
      label: "Armed Partial",
      colour: "#ff9500",
      armedCount,
      disarmedCount,
      total: monitoredZones.length,
      anyTriggered,
      anyFault
    };
  }

  return {
    state: "armed_full",
    label: "Armed Full",
    colour: "#ff3b30",
    armedCount,
    disarmedCount,
    total: monitoredZones.length,
    anyTriggered,
    anyFault
  };
}

function refreshMonitoringStatusBar() {
  const statusEl = document.getElementById("statusText");
  const dotEl = document.getElementById("statusDot");
  const eff = getEffectiveMonitoringState();

  if (statusEl) {
    const detail = eff.total > 0 ? ` (${eff.armedCount}/${eff.total})` : "";
    statusEl.textContent = eff.label + detail;
  }

  if (dotEl) {
    dotEl.className = "status-dot";
    dotEl.classList.add(`ow-${eff.state}`);
    if (eff.state === "triggered") dotEl.classList.add("triggered");
  }

  const masterDot = document.getElementById("masterStateDot");
  if (masterDot) {
    masterDot.style.background = eff.colour;
    masterDot.style.opacity = eff.state === "disarmed" ? "0.85" : "1";
    masterDot.classList.toggle("flashing", eff.state === "triggered");
  }

  const masterState = document.getElementById("masterStateLabel");
  if (masterState) {
    masterState.textContent = eff.label.toLowerCase().replace(" ", "_");
    masterState.style.color = eff.colour;
    masterState.style.opacity = "0.85";
  }
}

function entityTypeColour(type) {
  const armed  = isAlarmArmed();
  // If alarm is disarmed but smoke/CO always-armed is enabled, treat smoke & CO as armed
  const treatAsArmed = armed || (
    (type === 'smoke' || type === 'co') &&
    localStorage.getItem('ow_smoke_co_always_armed') === 'true'
  );
  const prefix = treatAsArmed ? "color_on_" : "color_off_";
  const newKey = prefix + type;
  // localStorage override → uiConfig value → hard-coded default
  const lsKey  = 'ow_' + newKey;
  return localStorage.getItem(lsKey) || uiConfig[newKey] || (treatAsArmed ? "#ff3b30" : "#4cd964");
}

// Always returns the disarmed (off) colour regardless of alarm state
function entityTypeColourOff(type) {
  const lsKey = 'ow_color_off_' + type;
  return localStorage.getItem(lsKey) || uiConfig[`color_off_${type}`] || "#4cd964";
}

/* ─── ZONE FADE STATE ─────────────────────────────────────── */
// When a zone's trigger clears, we fade it out over zone_fade_duration seconds
const zoneFadeState = {}; // zoneId -> { startedAt: ms, hex: string }

function startZoneFade(zoneId, hex) {
  zoneFadeState[zoneId] = { startedAt: Date.now(), hex };
}

function getZoneFadeAlpha(zoneId) {
  const fade = zoneFadeState[zoneId];
  if (!fade) return 0;
  // Read duration: localStorage overrides uiConfig, minimum 0.1s to avoid instant clear
  const _fadeLs = localStorage.getItem('ow_fade_duration');
  const _fadeCfg = parseFloat(uiConfig.zone_fade_duration);
  const _fadeVal = _fadeLs !== null ? parseFloat(_fadeLs) : (!isNaN(_fadeCfg) ? _fadeCfg : 3);
  const dur = Math.max(0.1, isNaN(_fadeVal) ? 3 : _fadeVal) * 1000;
  const elapsed = Date.now() - fade.startedAt;
  if (elapsed >= dur) {
    delete zoneFadeState[zoneId];
    return 0;
  }
  return 0.55 * (1 - elapsed / dur);
}

/* ─── MASTER ALARM STATE ──────────────────────────────────── */
// masterEnabled reads from the HA switch entity (switch.overwatch_zone_master).
// Falls back to localStorage for initial render before HA connects.
let masterEnabled = localStorage.getItem("masterEnabled") !== "false";

/* ─── ZONE TOGGLE SOURCE ──────────────────────────────────── */
// 'server' (default) = HA entities are source of truth, toggles call HA switches
// 'device'           = localStorage per-device, toggles don't affect HA
const ZONE_MODE_KEY        = 'ow_zone_source';
const ZONE_LOCAL_PREFIX    = 'ow_zone_enabled_';
const ZONE_LOCAL_MASTER    = 'ow_zone_master';
const ZONE_LOCAL_GROUP     = 'ow_zone_group_';

function zoneUseServerState() {
  return localStorage.getItem(ZONE_MODE_KEY) !== 'device';
}

// Read zone enabled state — from HA entities (server mode) or localStorage (device mode)
function zoneIsEnabled(zoneOrId) {
  const zone = typeof zoneOrId === 'string' ? zones.find(z => z.id === zoneOrId) : zoneOrId;
  if (!zoneUseServerState()) {
    return localStorage.getItem(ZONE_LOCAL_PREFIX + (zone?.id || zoneOrId)) !== 'false';
  }
  // Server mode — read from haStates (same as getZoneState does)
  return getZoneState(zone) !== 'disabled';
}

function setMasterEnabled(val) {
  masterEnabled = !!val;
  localStorage.setItem("masterEnabled", masterEnabled);
  if (zoneUseServerState()) {
    // Server mode: call HA switch, cascade to all groups and zones
    owCallSwitch("switch.overwatch_zone_master", val);
    for (const g of groups) owCallSwitch(`switch.overwatch_zone_group_${groupSlug(g)}`, val);
    for (const z of zones)  owCallSwitch(`switch.overwatch_zone_${zoneSlug(z)}`, val);
  } else {
    // Device mode: store in localStorage
    localStorage.setItem(ZONE_LOCAL_MASTER, val ? 'true' : 'false');
    for (const z of zones) localStorage.setItem(ZONE_LOCAL_PREFIX + z.id, val ? 'true' : 'false');
    for (const g of groups) localStorage.setItem(ZONE_LOCAL_GROUP + g.id, val ? 'true' : 'false');
  }
  updateStatusDropdownInPlace();
  renderZones();
  refreshMonitoringStatusBar();
  logEvent("info", val ? "Master alarm enabled." : "Master alarm disabled.", "system");
}

function setZoneEnabled(zoneId, val) {
  const zone = zones.find(z => z.id === zoneId);
  if (!zone) return;
  if (zoneUseServerState()) {
    owCallSwitch(`switch.overwatch_zone_${zoneSlug(zone)}`, !!val);
  } else {
    localStorage.setItem(ZONE_LOCAL_PREFIX + zoneId, val ? 'true' : 'false');
    updateStatusDropdownInPlace();
    renderZones();
  }
  refreshMonitoringStatusBar();
  logEvent(
    "info",
    val ? `Zone enabled: ${zone.name || zone.id}` : `Zone disabled: ${zone.name || zone.id}`,
    "zone",
    { zoneName: zone.name || zone.id, zoneColour: zone.colorHex || "#0096ff" }
  );
}

// Issue 30: hide/show a zone visually — no HA entity, no alarm impact
function setZoneHidden(zoneId, hidden) {
  const zone = zones.find(z => z.id === zoneId);
  if (!zone) return;
  zone.hidden = !!hidden;
  saveZone(zone);
  updateStatusDropdownInPlace();
  renderZones();
  logEvent(
    "info",
    hidden ? `Zone hidden: ${zone.name || zone.id}` : `Zone visible: ${zone.name || zone.id}`,
    "zone",
    { zoneName: zone.name || zone.id, zoneColour: zone.colorHex || "#0096ff" }
  );
}

/* ─── ENTITY SYNC (dashboard → HA via service call) ──────── */
// Toggle a zone/group/master switch entity in HA directly.
// The dashboard reads the state back from haStates (WS subscription).
// Trigger HA to reload the Overwatch integration so new entities appear without HA restart.
// Debounced — multiple saves in quick succession only trigger one reload.
let _haReloadTimer = null;
function scheduleHAReload(delayMs = 3000) {
  if (_haReloadTimer) clearTimeout(_haReloadTimer);
  _haReloadTimer = setTimeout(async () => {
    try {
      await fetch(apiPath("ow/reload"), { method: "POST" });
      logEvent("info", "HA integration reloaded — new entities now active.", "system");
    } catch {}
  }, delayMs);
}

// Convert friendly name to HA entity ID slug
// "Asphalt Right" -> "asphalt_right" -> switch.overwatch_zone_asphalt_right
// Must match the nameSlug() function in server.js /ow/zones endpoint
function nameSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function zoneSlug(zone)  { return nameSlug(zone.name)  || zone.id; }
function groupSlug(group) { return nameSlug(group.name) || group.id; }

function owCallSwitch(entityId, on) {
  if (IS_DIRECT_MODE) {
    // Direct Mode: no WebSocket — call HA via backend REST proxy
    fetch("ow/call-service", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "switch", service: on ? "turn_on" : "turn_off", entity_id: entityId }),
    }).catch(e => console.warn("[OW] owCallSwitch REST failed:", e.message));
    return;
  }
  if (!haConnected || !haSocket) {
    console.warn("[OW] owCallSwitch skipped — not connected:", entityId);
    return;
  }
  console.log(`[OW] owCallSwitch: ${on ? "turn_on" : "turn_off"} ${entityId}`);
  sendHA({
    type: "call_service",
    domain: "switch",
    service: on ? "turn_on" : "turn_off",
    service_data: { entity_id: entityId },
  });
}

function zoneEntityId(zone) {
  return `switch.overwatch_zone_${zoneSlug(zone)}`;
}

function masterEntityId() {
  return "switch.overwatch_zone_master";
}

function syncZoneToHA(zone, zoneState) {
  const on = zoneState !== "disabled";
  owCallSwitch(zoneEntityId(zone), on);
}

function syncMasterToHA(armed) {
  owCallSwitch(masterEntityId(), armed);
}

/* ─── ZONE STATE COMPUTATION ──────────────────────────────── */
function isEntityTriggered(entityId) {
  const st = haStates[entityId];
  if (!st) return false;
  const s = (st.state || "").toLowerCase();
  return s === "on" || s === "open" || s === "opening" || s === "detected" || s === "home" || s === "triggered" || s === "unlocked";
}
function zoneTriggerEntities(zone) {
  if (!zone) return [];
  // Door pins are evaluated via isDoorTriggered() (sensor OR optional control).
  // This returns zone-linked sensor entities only.
  return (zone.sensors || []).filter(e => !isEntityGhosted(e));
}

function zoneActiveTriggerEntity(zone) {
  if (!zone) return '';
  const s = (zone.sensors || []).filter(e => !isEntityGhosted(e)).find(isEntityTriggered);
  if (s) return s;
  const dp = doorPins
    .filter(p => doorPinZoneIds(p).includes(zone.id))
    .find(p => isDoorTriggered(p));
  return dp ? (doorPinTriggerSourceEntity(dp) || dp.sensor_entity || dp.control_entity || '') : '';
}


/* Track previous zone states to detect trigger→normal transitions */
const zonePrevState = {};

function getZoneState(zone) {
  // Read enabled state — from localStorage (device mode) or HA switch entities (server mode)
  let enabled, masterOn;
  if (!zoneUseServerState()) {
    enabled  = localStorage.getItem(ZONE_LOCAL_PREFIX + zone.id) !== 'false';
    masterOn = localStorage.getItem(ZONE_LOCAL_MASTER) !== 'false';
  } else {
    const switchState = haStates[`switch.overwatch_zone_${zoneSlug(zone)}`];
    enabled = switchState ? switchState.state !== "off" : zone.enabled !== false;
    const masterSwitch = haStates["switch.overwatch_zone_master"];
    masterOn = masterSwitch ? masterSwitch.state !== "off" : masterEnabled;
  }

  if (!enabled || !masterOn) return "disabled";
  if (!haConnected) return "normal";
  const sensors = (zone.sensors || []).filter(e => !isEntityGhosted(e));
  const zoneDoorPins = doorPins.filter(p => doorPinZoneIds(p).includes(zone.id));
  if (!sensors.length && !zoneDoorPins.length) return "normal";
  const anyTriggered = sensors.some(isEntityTriggered) || zoneDoorPins.some(isDoorTriggered);
  // Only fault if haStates has loaded (>50 entities) — avoids false fault at startup
  // before the get_states response arrives. Also allow a brief grace period via
  // haStatesLoaded flag set after the first successful states fetch.
  const statesReady = haStatesLoaded || Object.keys(haStates).length > 50;
  const anyUnavailable = statesReady && sensors.some(id => {
    const st = haStates[id];
    return !st || st.state === "unavailable";
  });
  if (anyTriggered)   return "triggered";
  if (anyUnavailable) return "fault";
  return "normal";
}

/* ─── ZONE STATE CHANGE TRACKING & LOGGING ────────────────── */
// Called after every HA state update (not from the render loop).
// Compares all zone states against previous, logs transitions, starts fades.
function checkZoneStateChanges() {
  if (!haConnected) return;
  for (const zone of zones) {
    const sensors = zoneTriggerEntities(zone);
    const zoneDoorPins = doorPins.filter(p => doorPinZoneIds(p).includes(zone.id));
    // Compute raw state without the prev-state side effects
    let state = "normal";
    if (getZoneState(zone) === "disabled") {
      state = "disabled";
    } else {
      const anyTriggered = sensors.some(isEntityTriggered) || zoneDoorPins.some(isDoorTriggered);
      const statesReady2   = haStatesLoaded || Object.keys(haStates).length > 50;
      const anyUnavailable = statesReady2 && sensors.length > 0 && sensors.some(id => {
        const st = haStates[id];
        return !st || (st.state || "").toLowerCase() === "unavailable";
      });
      if (anyTriggered)   state = "triggered";
      else if (anyUnavailable) state = "fault";
    }

    const prev = zonePrevState[zone.id];

    // Normal → Triggered: clear any stale fade (zone is lit up again)
    if (prev !== "triggered" && state === "triggered") {
      delete zoneFadeState[zone.id]; // cancel any in-progress fade
      const triggeredEntity = sensors.find(isEntityTriggered) || sensors[0];
      const type            = detectEntityType(triggeredEntity || "");
      const zoneColour      = resolveColour(entityTypeColour(type));
      const armedStr        = isAlarmArmed()
        ? (uiConfig.alarm_label_armed    || "Armed")
        : (uiConfig.alarm_label_disarmed || "Disarmed");
      logEvent(
        "warn",
        `Triggered — ${triggeredEntity || "unknown"} [${armedStr}]`,
        "zone",
        { zoneName: zone.name || zone.id, zoneColour, entityId: triggeredEntity }
      );
      syncZoneToHA(zone, "triggered");
    }

    // Triggered → anything else (cleared): always start a fresh fade
    if (prev === "triggered" && state !== "triggered") {
      const type       = detectEntityType(sensors[0] || "");
      const zoneColour = resolveColour(entityTypeColour(type));
      startZoneFade(zone.id, zoneColour); // always fresh — prev trigger cleared
      logEvent(
        "ok",
        `Cleared`,
        "zone",
        { zoneName: zone.name || zone.id, zoneColour }
      );
      syncZoneToHA(zone, state);
    }

    // Normal → Fault (new offline entity)
    if (prev !== "fault" && state === "fault") {
      const offlineEntity = sensors.find(id => {
        const st = haStates[id];
        return !st || (st.state || "").toLowerCase() === "unavailable";
      });
      logEvent(
        "warn",
        `Fault — entity unavailable: ${offlineEntity || "unknown"}`,
        "zone",
        { zoneName: zone.name || zone.id, zoneColour: "#ff9500", entityId: offlineEntity }
      );
      syncZoneToHA(zone, "fault");
    }

    // Fault → normal/cleared
    if (prev === "fault" && state === "normal") {
      logEvent(
        "ok",
        `Fault cleared`,
        "zone",
        { zoneName: zone.name || zone.id, zoneColour: "#ff9500" }
      );
      syncZoneToHA(zone, "normal");
    }

    zonePrevState[zone.id] = state;
  }

  // ── Auto floor switching ──────────────────────────────────────
  if (floors.length > 1 && localStorage.getItem("ow_auto_floor") === "true") {
    _evaluateAutoFloor();
  }
}

// Auto floor switch state
let _autoFloorStayTimer   = null;
let _autoFloorReturnTimer = null;
let _autoFloorLocked      = false; // true while stay timer is running

function _evaluateAutoFloor() {
  // Find all currently triggered zones and their floors
  const triggered = zones.filter(z => {
    const state = getZoneState(z);
    return state === "triggered";
  });

  if (triggered.length === 0) {
    // Nothing triggered — if we're not locked, nothing to do
    // If stay timer already running, let it run
    return;
  }

  // Collision resolution: armed beats disarmed, then most recent sensor change
  function zoneScore(z) {
    const isArmed  = getZoneState(z) !== "disabled";
    const sensors  = z.sensors || [];
    const lastSeen = sensors.reduce((best, sid) => {
      const st = haStates[sid];
      if (!st) return best;
      const ts = new Date(st.last_changed || 0).getTime();
      return ts > best ? ts : best;
    }, 0);
    return { isArmed, lastSeen };
  }

  const winner = triggered.sort((a, b) => {
    const sa = zoneScore(a), sb = zoneScore(b);
    if (sa.isArmed !== sb.isArmed) return sa.isArmed ? -1 : 1;
    return sb.lastSeen - sa.lastSeen;
  })[0];

  const fi    = floors.findIndex(f => f.id === winner.floor_id) >= 0
    ? floors.findIndex(f => f.id === winner.floor_id)
    : 0;
  const targetFloorId = floors[fi]?.id;

  if (!targetFloorId || targetFloorId === activeFloorId) {
    // Already on the right floor — reset stay timer
    if (_autoFloorStayTimer) { clearTimeout(_autoFloorStayTimer); _autoFloorStayTimer = null; }
    _startStayTimer();
    return;
  }

  // Switch to winning floor
  _autoFloorLocked = true;
  if (_autoFloorReturnTimer) { clearTimeout(_autoFloorReturnTimer); _autoFloorReturnTimer = null; }
  setActiveFloor(targetFloorId);
  renderZones();
  if (editorMode) renderZonesEditorStable();
  if (document.getElementById("floorFlyout")) renderFloorFlyout();

  _startStayTimer();
}

function _startStayTimer() {
  if (_autoFloorStayTimer) clearTimeout(_autoFloorStayTimer);
  const staySecs = parseInt(localStorage.getItem("ow_floor_stay_secs") || "30");
  _autoFloorStayTimer = setTimeout(() => {
    _autoFloorStayTimer = null;
    _startReturnTimer();
  }, staySecs * 1000);
}

function _startReturnTimer() {
  if (_autoFloorReturnTimer) clearTimeout(_autoFloorReturnTimer);
  const returnSecs = parseInt(localStorage.getItem("ow_floor_return_secs") || "60");
  _autoFloorReturnTimer = setTimeout(() => {
    _autoFloorReturnTimer = null;
    _autoFloorLocked = false;
    const defaultFloorId = localStorage.getItem("ow_default_floor") || floors[0]?.id;
    if (defaultFloorId && defaultFloorId !== activeFloorId) {
      setActiveFloor(defaultFloorId);
      renderZones();
      if (editorMode) renderZonesEditorStable();
      if (document.getElementById("floorFlyout")) renderFloorFlyout();
    }
  }, returnSecs * 1000);
}
// Flash phase: alternates between high/low opacity — JS-driven, no CSS animation needed
let flashPhase = false;
setInterval(() => {
  flashPhase = !flashPhase;
  if (haConnected || Object.keys(zoneFadeState).length > 0) renderZones();

  // Live-update all dots in the dropdown if it's open
  if (haConnected) {
    const dd = document.getElementById("statusDropdown");
    if (dd && dd.style.display !== "none") {

      // ── Zone member dots ───────────────────────────────────
      dd.querySelectorAll(".zone-list-dot[data-zone-id]").forEach(dot => {
        const zone = zones.find(z => z.id === dot.dataset.zoneId);
        if (!zone) return;
        const st = getZoneState(zone);
        const isOff = getZoneState(zone) === "disabled";
        const activeEntity = zoneActiveTriggerEntity(zone);
        const anyActive = !!activeEntity;
        const isDisarmedActive = isOff && anyActive;
        const isTriggered = st === "triggered";
        dot.classList.toggle("flashing", isTriggered || isDisarmedActive);
        dot.style.background = isTriggered
          ? "#ff3b30"
          : isDisarmedActive
          ? resolveColour(entityTypeColourOff(detectEntityType(activeEntity || "door")))
          : st === "fault" ? "#ff9500"
          : isOff ? (zone.colorHex || "#0096ff")  // disarmed + clear → zone colour dimmed
          :          "#ff3b30";                     // armed + clear → red
        dot.style.opacity = (isOff && !isDisarmedActive) ? "0.3" : "1";
      });

      // ── Group dots ─────────────────────────────────────────
      dd.querySelectorAll(".zone-list-dot[data-group-dot]").forEach(dot => {
        const gid = dot.dataset.groupDot;
        let members;
        if (gid === "__ungrouped") {
          const groupedIds = new Set(groups.flatMap(g => g.zone_ids || []));
          members = zones.filter(z => !groupedIds.has(z.id));
        } else {
          const group = groups.find(g => g.id === gid);
          if (!group) return;
          members = (group.zone_ids || []).map(id => zones.find(z => z.id === id)).filter(Boolean);
          dot._groupHex = group.colorHex || "#ff3b30";
        }
        const groupHex = dot._groupHex || "#888";

        if (!members.length) {
          dot.style.background = groupHex;
          dot.style.opacity = "0.3";
          dot.classList.remove("flashing");
          return;
        }

        const anyTriggered  = members.some(z => getZoneState(z) === "triggered");
        const allArmed      = members.every(z => getZoneState(z) !== 'disabled');
        const allDisarmed   = members.every(z => getZoneState(z) === "disabled");
        const someArmed     = !allArmed && !allDisarmed; // mixed

        // Colour logic:
        // All armed            → red (solid or flashing if triggered)
        // Mixed armed/disarmed → orange (solid or flashing if triggered)
        // All disarmed         → group colour (dimmed)
        const colour  = allDisarmed ? groupHex
                      : someArmed   ? "#ff9500"  // orange = mixed
                      :               "#ff3b30";  // red = all armed
        const opacity = allDisarmed ? 0.35 : 1;
        const flash   = anyTriggered && !allDisarmed;

        dot.classList.toggle("flashing", flash);
        dot.style.background = colour;
        dot.style.opacity    = String(opacity);
      });
    }

    // Update status bar dot
    const dotEl = document.getElementById("statusDot");
    if (dotEl) {
      const anyTriggered = zones.some(z => getZoneState(z) === "triggered");
      if (anyTriggered) dotEl.classList.add("triggered");
      else if (!dotEl.classList.contains("armed-away") && !dotEl.classList.contains("armed-home")) {
        dotEl.classList.remove("triggered");
      }
    }
    refreshMonitoringStatusBar();
  }
}, 700);

function renderZones() {
  if (_pinDragging) return; // never re-render during drag — would remove dragged element
  // In multi-panel mode, render to each panel's SVG instead of the single zonesSvg
  if (getNumPanels() > 1 && document.querySelector('.floor-panel')) {
    renderAllPanelZones();
    return;
  }
  _renderZonesInternal();
  renderPins(); // render lights & sirens on single panel
}

// Internal zone drawing — draws into whatever element currently has id="zonesSvg"
// Called by renderZones() (single panel) and renderPanelZones() (multi-panel via ID swap)
function _renderZonesInternal(targetSvg) {
  const svg = targetSvg || document.getElementById("zonesSvg");
  if (!svg) return;
  // Clear SVG — but preserve any pin element currently being dragged
  if (_pinDragging) {
    // Remove everything EXCEPT the currently dragged pin element
    Array.from(svg.childNodes).forEach(child => {
      if (child.dataset?.pinId !== undefined && child === svg.querySelector(`[data-pin-id="${_draggingPinId}"]`)) return;
      svg.removeChild(child);
    });
  } else {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  const now = Date.now();
  const showHighlight      = highlightedZoneId  && now < highlightedUntil;
  const showGroupHighlight = highlightedGroupId && now < highlightedGroupUntil;

  // ── Group member highlight layer ────────────────────────────
  // Works in both editor mode (selectedGroupId) and live mode (highlightedGroupId from dropdown).
  const _curFloorId   = activeFloorId;
  const _isFirstFloor = !_curFloorId || floors.length === 0 || floors[0]?.id === _curFloorId;
  const activeGrpId  = (editorMode && selectedGroupId) ? selectedGroupId
                     : showGroupHighlight ? highlightedGroupId : null;
  if (activeGrpId) {
    const activeGrp = groups.find(g => g.id === activeGrpId);
    if (activeGrp) {
      const grpHex = activeGrp.colorHex || "#ff3b30";

      // Single fill-only pass — no per-polygon strokes so overlaps never show seams
      const fillGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      fillGroup.setAttribute("fill", grpHex);
      fillGroup.setAttribute("fill-opacity", "0.72");
      fillGroup.setAttribute("stroke", "none");
      fillGroup.setAttribute("style", `filter: drop-shadow(0 0 3px ${grpHex})`);

      let hasMembers = false;
      (activeGrp.zone_ids || []).forEach(zid => {
        const zone = zones.find(z => z.id === zid);
        if (!zone || !zone.points?.length || zone.hidden) return;
        // Filter by floor: zones with floor_id only show on their assigned floor
        if (floors.length > 1 && zone.floor_id && zone.floor_id !== _curFloorId) return;
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", zone.points.map(p => `${p.x},${p.y}`).join(" "));
        fillGroup.appendChild(poly);
        hasMembers = true;
      });

      if (hasMembers) svg.appendChild(fillGroup);
    }
  }

  // Flash mode: 'zone' = only the triggered zone flashes, 'group' = all zones in the group flash
  const flashMode = localStorage.getItem('ow_flash_mode') || 'zone';
  const groupFlashZoneIds = new Set();
  if (flashMode === 'group') {
    zones.forEach(zone => {
      if (haConnected && getZoneState(zone) === 'triggered') {
        // Find which group this zone belongs to and add all member zones
        const parentGroup = groups.find(g => (g.zone_ids || []).includes(zone.id));
        if (parentGroup) {
          (parentGroup.zone_ids || []).forEach(id => groupFlashZoneIds.add(id));
        } else {
          groupFlashZoneIds.add(zone.id); // ungrouped — flash itself
        }
      }
    });
  }

  // Filter to active floor — zones with no floor_id belong to the first floor
  // Exception: in multi-panel mode, unassigned zones show on ALL panels so
  // panels aren't empty before users assign zones to floors.
  const currentFloorId = _curFloorId;
  const isFirstFloor   = _isFirstFloor;
  const inMultiPanel   = getNumPanels() > 1 && document.querySelector('.floor-panel');

  zones.forEach(zone => {
    const zoneFloor = zone.floor_id;
    if (currentFloorId && floors.length > 1) {
      // Zones with floor_id: only show on their assigned floor's panel
      if (zoneFloor && zoneFloor !== currentFloorId) return;
      // Zones without floor_id: belong to first floor only
      if (!zoneFloor && !isFirstFloor) return;
    }

    const pts = zone.points || [];
    if (!pts.length) return;


    const isSelected     = zone.id === selectedZoneId;
    const isHighlight    = showHighlight && zone.id === highlightedZoneId;
    const zoneState    = getZoneState(zone);
    const isDisabled   = zoneState === "disabled";
    const isHidden     = zone.hidden === true;
    const isTriggered  = haConnected && zoneState === "triggered";
    // Fault visibility is independent of armed/disarmed state. getZoneState()
    // intentionally returns "disabled" for disarmed zones, so compute raw
    // sensor availability here for map display.
    const zoneFaultSensors = (zone.sensors || []).filter(e => !isEntityGhosted(e));
    const zoneFaultStatesReady = haStatesLoaded || Object.keys(haStates).length > 50;
    const hasUnavailableSensor = zoneFaultStatesReady && zoneFaultSensors.some(id => {
      const st = haStates[id];
      return !st || String(st.state || '').toLowerCase() === "unavailable";
    });
    const isFault      = haConnected && (zoneState === "fault" || hasUnavailableSensor);
    const fadeAlpha    = getZoneFadeAlpha(zone.id);
    const isFading     = fadeAlpha > 0;
    const showInLive   = isHighlight || isTriggered || isFault || isFading;

    // Hidden zones: never show in live mode, show faded outline in editor only
    if (isHidden && !editorMode) return;
    // In live mode: show all non-hidden zones (disarmed zones show with off-colours)
    if (!editorMode && !pts.length) return;

    // Group member zones are already rendered by the group layer above.
    // Skip individual rendering for them (unless they are also the selected zone).
    const activeGrp2 = (editorMode && selectedGroupId) ? groups.find(g => g.id === selectedGroupId)
                     : (showGroupHighlight && highlightedGroupId) ? groups.find(g => g.id === highlightedGroupId)
                     : null;
    if (activeGrp2 && (activeGrp2.zone_ids || []).includes(zone.id) && !isSelected && editorMode) return;

    const pointsStr = pts.map(p => `${p.x},${p.y}`).join(" ");

    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", pointsStr || "0,0");
    poly.dataset.zoneId = zone.id;

    let cls = "zone-polygon";
    if (editorMode && isSelected) cls += " selected";
    if (isHighlight) cls += " zone-highlight";
    poly.setAttribute("class", cls);

    if (isHighlight) {
      // Highlight: zone's own colour at strong opacity + glow, matching editor selected-zone style
      const hex = zone.colorHex || "#0096ff";
      poly.style.fill        = hexToRgba(hex, 0.72);
      poly.style.stroke      = hex;
      poly.style.strokeWidth = String(2.5 / zoom.scale);
      poly.style.filter      = `drop-shadow(0 0 4px ${hex})`;

    } else if (isHidden && editorMode) {
      // Hidden zone in editor: very faint dotted outline, not interactive
      poly.style.fill             = "rgba(80,80,80,0.06)";
      poly.style.stroke           = "rgba(80,80,80,0.20)";
      poly.style.strokeWidth      = String(1 / zoom.scale);
      poly.style.strokeDasharray  = String(4 / zoom.scale) + " " + String(6 / zoom.scale);
      poly.style.pointerEvents    = "none";

    } else if (isDisabled && editorMode) {
      // Disarmed zone in editor: preserve the configured zone colour, but dim/dash it
      // so the user can still see/edit zone geometry without implying the zone is armed.
      const hex = zone.colorHex || "#0096ff";
      if (isSelected) {
        poly.style.fill        = hexToRgba(hex, 0.55);
        poly.style.stroke      = hex;
        poly.style.strokeWidth = String(2.5 / zoom.scale);
      } else {
        poly.style.fill        = hexToRgba(hex, 0.16);
        poly.style.stroke      = hexToRgba(hex, 0.48);
        poly.style.strokeWidth = String(1 / zoom.scale);
      }
      poly.style.strokeDasharray = String(6 / zoom.scale) + " " + String(4 / zoom.scale);

    } else if (!editorMode && (isTriggered || (flashMode === 'group' && groupFlashZoneIds.has(zone.id) && haConnected))) {
      const triggeredEntity = zoneActiveTriggerEntity(zone)
        || zoneActiveTriggerEntity(zones.find(z => groupFlashZoneIds.has(z.id) && getZoneState(z) === 'triggered'));
      const type = detectEntityType(triggeredEntity || "door");
      const hex  = resolveColour(entityTypeColour(type));
      const fillAlpha   = flashPhase ? 0.18 : 0.65;
      poly.style.transition  = 'none'; // bypass CSS transition so flash is instant
      poly.style.fill        = hexToRgba(hex, fillAlpha);
      poly.style.stroke      = hexToRgba(hex, fillAlpha * 0.7);
      poly.style.strokeWidth = String(1 / zoom.scale);

    } else if (isFading) {
      const fadeHex = zoneFadeState[zone.id]?.hex || "#ff3b30";
      // Stroke fades in exact lockstep with fill
      poly.style.fill        = hexToRgba(fadeHex, fadeAlpha * 0.75);
      poly.style.stroke      = hexToRgba(fadeHex, fadeAlpha * 0.4);
      poly.style.strokeWidth = String(1 / zoom.scale);

    } else if (isFault) {
      // Fault: flash between dark orange and bright yellow for clear distinction
      poly.style.transition  = 'none';
      poly.style.fill        = flashPhase ? 'rgba(255,200,0,0.65)' : 'rgba(255,120,0,0.28)';
      poly.style.stroke      = flashPhase ? 'rgba(255,220,0,0.9)'  : 'rgba(255,120,0,0.5)';
      poly.style.strokeWidth = String(1.5 / zoom.scale);

    } else if (editorMode) {
      const hex = zone.colorHex || "#0096ff";
      if (isSelected) {
        // Selected zone: strong highlight matching group member style
        poly.style.fill        = hexToRgba(hex, 0.72);
        poly.style.stroke      = hex;
        poly.style.strokeWidth = String(2.5 / zoom.scale);
      } else {
        poly.style.fill        = hexToRgba(hex, 0.18);
        poly.style.stroke      = hexToRgba(hex, 0.35);
        poly.style.strokeWidth = String(1 / zoom.scale);
      }
    } else {
      // Live mode — transparent unless a sensor/door/window is active
      const activeEntity = zoneActiveTriggerEntity(zone);
      const anyActive = !!activeEntity;
      const hideDisarmedFlash = localStorage.getItem('ow_hide_disarmed_flash') === 'true';
      if (anyActive && isDisabled && !hideDisarmedFlash) {
        // Disarmed zone with active sensor/door/window — flash in off-colour
        const type = detectEntityType(activeEntity || "door");
        const hex  = resolveColour(entityTypeColourOff(type));
        const fillAlpha = flashPhase ? 0.15 : 0.45;
        poly.style.fill        = hexToRgba(hex, fillAlpha);
        poly.style.stroke      = hexToRgba(hex, fillAlpha * 0.8);
        poly.style.strokeWidth = String(1 / zoom.scale);
      } else {
        // Clear zone — invisible but must still receive clicks
        poly.style.fill   = 'rgba(0,0,0,0)';
        poly.style.stroke = 'none';
      }
      // ALL live-mode polygons must be clickable to open the zone popup
      poly.style.pointerEvents = 'all';
    }

    svg.appendChild(poly);
    // In live mode, every zone polygon must be clickable to open the zone popup
    if (!editorMode && !isHidden) poly.style.pointerEvents = 'all';

    // Handles shown when editing points OR when actively creating this zone
    if (editorMode && isSelected && (isEditingPoints || (isCreatingZone && zone.id === currentNewZone?.id))) {
      const handleR = 7 / zoom.scale;
      pts.forEach((p, idx) => {
        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        c.setAttribute("cx", p.x);
        c.setAttribute("cy", p.y);
        c.setAttribute("r", handleR);
        c.setAttribute("class", "zone-handle");
        c.dataset.zoneId = zone.id;
        c.dataset.index  = idx;
        svg.appendChild(c);
      });
    }
  });
}

// Resolve a colour value — if it's a CSS var, look it up from uiConfig directly
function resolveColour(col) {
  if (!col) return "#ff3b30";
  if (col.startsWith("#")) return col;
  // Fallback: return a safe default
  return "#ff3b30";
}

/* ─── YAML EXPORT ─────────────────────────────────────────── */
function generateZonesYaml() {
  let out = "zones:\n";
  zones.forEach(z => {
    out += ` - id: ${z.id}\n`;
    out += `   name: "${(z.name || "").replace(/"/g, '\\"')}"\n`;
    out += `   color: "${z.colorHex || "#0096ff"}"\n`;
    out += `   enabled: ${z.enabled !== false}\n`;
    out += `   points:\n`;
    (z.points  || []).forEach(p => { out += `     - [${Math.round(p.x)}, ${Math.round(p.y)}]\n`; });
    out += `   sensors:\n`;
    (z.sensors || []).forEach(s => { out += `     - ${s}\n`; });
    out += `   cameras:\n`;
    (z.cameras || []).forEach(s => { out += `     - ${s}\n`; });
    out += `   lights:\n`;
    (z.lights  || []).forEach(s => { out += `     - ${s}\n`; });
    out += `   sirens:\n`;
    (z.sirens  || []).forEach(s => { out += `     - ${s}\n`; });
  });
  return out;
}

/* ─── ENTITY DOT REFRESH (issue 11 — avoids full re-render while typing) ── */
function refreshEntityStateDots(container) {
  if (!container) return;
  // Update state class on each entity dot without touching inputs
  container.querySelectorAll(".ha-entity-row").forEach(row => {
    const entityId = row.dataset.entityId;
    if (!entityId) return;
    const dot = row.querySelector(".ha-entity-state");
    const lbl = row.querySelector(".ha-entity-type");
    const st = haStates[entityId];
    const stateStr = st ? st.state : (haConnected ? "unavailable" : "—");
    const stateClass = st ? (isEntityTriggered(entityId) ? "on" : "off") : "unavailable";
    if (dot) { dot.className = "ha-entity-state " + stateClass; }
    if (lbl) lbl.textContent = stateStr;
  });
}

/* ─── ZONE EDITOR DOM PRESERVATION ─────────────────────── */
function captureZoneEditorScrollState(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll('.zed-list, .zed-right-content, .ha-entity-list, #groupMemberList'))
    .map(el => ({ selector: el.id ? `#${CSS.escape(el.id)}` : `.${Array.from(el.classList).map(c => CSS.escape(c)).join('.')}`, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft }));
}
function restoreZoneEditorScrollState(container, state) {
  if (!container || !state?.length) return;
  requestAnimationFrame(() => state.forEach(s => { const el = container.querySelector(s.selector); if (el) { el.scrollTop = s.scrollTop; el.scrollLeft = s.scrollLeft; } }));
}
function zoneEditorHasActiveControl(container) {
  const panel = container?.querySelector('.zones-editor');
  const activeEl = document.activeElement;
  if (!panel || !activeEl || !panel.contains(activeEl)) return false;
  return activeEl.matches('input, textarea, select, [contenteditable="true"]') || !!activeEl.closest('.entity-search-results, .zone-handle, .ha-device-tabs');
}
function renderZonesEditorStable(force = false) {
  const root = document.getElementById('zonesEditorContainer') || document;
  const state = captureZoneEditorScrollState(root);
  const active = document.activeElement;
  const activeId = active?.id || '';
  const activeName = active?.getAttribute?.('name') || '';
  const activeValue = active && 'value' in active ? active.value : null;
  renderZonesEditor(force);
  restoreZoneEditorScrollState(root, state);
  requestAnimationFrame(() => {
    if (activeId) document.getElementById(activeId)?.focus?.({ preventScroll:true });
    else if (activeName) root.querySelector(`[name="${CSS.escape(activeName)}"]`)?.focus?.({ preventScroll:true });
    if (activeValue !== null) {
      const next = document.activeElement;
      if (next && 'value' in next && next.value === activeValue) {
        try { next.setSelectionRange(active.selectionStart || 0, active.selectionEnd || 0); } catch {}
      }
    }
  });
}

/* ─── ZONE EDITOR DRAGGABLE PANEL HELPER moved to modules/ow-zone-editor.js ───────────────────────── */
/* ─── PIN RENDERING AND DRAGGING moved to modules/ow-pins.js ───────────────────────── */
/* ─── ZONE DETAIL POPUP ───────────────────────────────────── */
let _zonePopupZoneId = null;
let _zonePopupEl     = null;
let _zonePopupTimer  = null; // for camera snapshot refresh

function openZonePopup(zoneId, clientX, clientY) {
  closeZonePopup();
  _zonePopupZoneId = zoneId;

  const popup = document.createElement('div');
  popup.id = 'zonePopup';
  popup.style.cssText = `
    position:fixed; z-index:8000;
    background:rgba(14,14,14,0.97);
    border:1px solid rgba(255,255,255,0.12);
    border-radius:12px;
    box-shadow:0 8px 32px rgba(0,0,0,0.6);
    width:300px; max-height:80vh;
    overflow-y:auto;
    font-size:13px; color:#e0e0e0;
    pointer-events:all;
    user-select:none;
  `;
  document.body.appendChild(popup);
  _zonePopupEl = popup;

  // Position: prefer right of click, flip left if near right edge
  const pw = 308;
  let left = clientX + 12;
  let top  = clientY - 40;
  if (left + pw > window.innerWidth  - 10) left = clientX - pw - 12;
  if (top  + 500 > window.innerHeight - 10) top  = window.innerHeight - 510;
  if (top  < 10) top = 10;
  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';

  // ── Make draggable via title bar ─────────────────────────
  renderZonePopupContent();

  // ── Click-outside to close ────────────────────────────────
  // Defer by one frame so the opening click doesn't immediately close it
  requestAnimationFrame(() => {
    function _outsideClose(e) {
      // Zone polygons are handled by the map click-toggle logic. Do not close here
      // first, otherwise clicking the same zone cannot reliably toggle the popup closed.
      if (e.target?.classList?.contains('zone-polygon')) return;
      if (_zonePopupEl && !_zonePopupEl.contains(e.target)) {
        closeZonePopup();
        document.removeEventListener('pointerdown', _outsideClose, true);
      }
    }
    document.addEventListener('pointerdown', _outsideClose, true);
    // Store ref so closeZonePopup can remove it if called programmatically
    popup._outsideClose = _outsideClose;
  });

  // Attach drag after content is rendered (need the titlebar)
  requestAnimationFrame(() => {
    const titlebar = popup.querySelector('#zpTitlebar');
    if (!titlebar) return;
    let dragging = false, ox = 0, oy = 0;
    titlebar.style.cursor = 'grab';
    titlebar.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return; // don't drag on button clicks
      dragging = true;
      ox = e.clientX - popup.offsetLeft;
      oy = e.clientY - popup.offsetTop;
      titlebar.style.cursor = 'grabbing';
      titlebar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    titlebar.addEventListener('pointermove', e => {
      if (!dragging) return;
      let nx = e.clientX - ox;
      let ny = e.clientY - oy;
      nx = Math.max(0, Math.min(window.innerWidth  - popup.offsetWidth,  nx));
      ny = Math.max(0, Math.min(window.innerHeight - popup.offsetHeight, ny));
      popup.style.left = nx + 'px';
      popup.style.top  = ny + 'px';
    });
    titlebar.addEventListener('pointerup',    () => { dragging = false; titlebar.style.cursor = 'grab'; });
    titlebar.addEventListener('pointercancel',() => { dragging = false; titlebar.style.cursor = 'grab'; });
  });
}

function closeZonePopup() {
  if (_zonePopupTimer) { clearInterval(_zonePopupTimer); _zonePopupTimer = null; }
  if (_zonePopupEl) {
    if (_zonePopupEl._outsideClose) {
      document.removeEventListener('pointerdown', _zonePopupEl._outsideClose, true);
    }
    _zonePopupEl.remove();
    _zonePopupEl = null;
  }
  _zonePopupZoneId = null;
}

function renderZonePopupContent() {
  const popup = _zonePopupEl;
  if (!popup || !_zonePopupZoneId) return;
  const zone = zones.find(z => z.id === _zonePopupZoneId);
  if (!zone) { closeZonePopup(); return; }

  const showThumbs = localStorage.getItem('ow_zone_popup_thumbs') === 'true';
  const zState     = getZoneState(zone);
  const isArmed    = zState !== 'disabled';
  const sensors_   = (zone.sensors || []).filter(e => !isEntityGhosted(e));
  const doors_     = doorPins.filter(p => doorPinZoneIds(p).includes(zone.id) && (p.sensor_entity || p.control_entity) && !isEntityGhosted(p.sensor_entity) && !isEntityGhosted(p.control_entity));
  const lights_    = (zone.lights  || []).filter(e => !isEntityGhosted(e));
  const sirens_    = (zone.sirens  || []).filter(e => !isEntityGhosted(e));
  const cameras_   = (zone.cameras || []).filter(e => !isEntityGhosted(e));

  // ── Arm/Disarm row ────────────────────────────────────────
  const showArmDisarm = canArmDisarm();
  const armHtml = `
    <div id="zpTitlebar" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <div style="font-weight:600;font-size:14px;color:#fff;flex:1;">🏠 ${escapeHtml(zone.name)}</div>
      <div style="display:flex;gap:5px;margin-left:8px;">
        ${showArmDisarm ? `
        <button id="zpArm"    style="background:${isArmed   ? 'rgba(0,150,255,0.3)'  : 'rgba(255,255,255,0.06)'};border:1px solid ${isArmed   ? 'rgba(0,150,255,0.6)'  : 'rgba(255,255,255,0.12)'};color:${isArmed   ? '#4db8ff' : '#666'};border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;">Armed</button>
        <button id="zpDisarm" style="background:${!isArmed  ? 'rgba(255,59,48,0.3)'  : 'rgba(255,255,255,0.06)'};border:1px solid ${!isArmed  ? 'rgba(255,59,48,0.6)'  : 'rgba(255,255,255,0.12)'};color:${!isArmed  ? '#ff6b6b' : '#666'};border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;">Disarmed</button>
        ` : `<span id="zpArmStatus" style="font-size:11px;color:#555;padding:4px 6px;">${isArmed ? '🔵 Armed' : '⚪ Disarmed'}</span>`}
        <button id="zpClose"  style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#888;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;line-height:1;">✕</button>
      </div>
    </div>`;

  // ── Sensors ───────────────────────────────────────────────
  const sensorHtml = sensors_.length ? `
    <div style="margin-bottom:10px;">
      <div style="font-size:10px;text-transform:uppercase;color:#555;letter-spacing:0.1em;margin-bottom:4px;">Sensors</div>
      ${sensors_.map(e => {
        const triggered = isEntityTriggered(e);
        const state = haStates[e]?.state || '—';
        return `<div data-sensor-id="${escapeHtml(e)}" style="display:flex;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span class="sensor-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${triggered ? '#ff3b30' : '#34c759'};margin-right:7px;flex-shrink:0;"></span>
          <span style="flex:1;color:#ccc;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(e.split('.').pop())}</span>
          <span class="sensor-state" style="color:${triggered ? '#ff6b6b' : '#34c759'};font-size:11px;font-weight:600;margin-left:6px;">${escapeHtml(state.toUpperCase())}</span>
        </div>`;
      }).join('')}
    </div>` : '';

  // ── Doors & Windows ───────────────────────────────────────
  const doorHtml = doors_.length ? `
    <div style="margin-bottom:10px;">
      <div style="font-size:10px;text-transform:uppercase;color:#555;letter-spacing:0.1em;margin-bottom:4px;">Doors & Windows</div>
      ${doors_.map(pin => {
        const sensorId = pin.sensor_entity || '';
        const state = doorPinDisplayState(pin);
        const open = pin.sensor_entity ? doorPinIsOpen(pin) : false;
        const info = doorControlInfo(pin);
        const label = pin.name || sensorId.split('.').pop() || pin.control_entity || 'door/window';
        return `<div class="zp-door-row" data-door-pin-id="${escapeHtml(pin.id)}" data-door-sensor-id="${escapeHtml(sensorId)}" style="display:flex;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);gap:6px;">
          <span class="door-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${open ? '#ff9500' : '#34c759'};flex-shrink:0;"></span>
          <span title="${escapeHtml(sensorId)}" style="flex:1;color:#ccc;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🚪 ${escapeHtml(label)}</span>
          <span class="door-state" style="color:${open ? '#ff9500' : '#34c759'};font-size:11px;font-weight:600;margin-left:4px;">${escapeHtml(String(state).toUpperCase())}</span>
          ${info ? `<button class="zp-door-control" data-pin-id="${escapeHtml(pin.id)}" style="background:rgba(0,150,255,0.15);border:1px solid rgba(0,150,255,0.35);color:#4db8ff;border-radius:5px;padding:3px 8px;cursor:pointer;font-size:11px;flex-shrink:0;">${escapeHtml(info.label)}</button>` : ''}
        </div>`;
      }).join('')}
    </div>` : '';

  // ── Lights ────────────────────────────────────────────────
  const allLightsOn  = lights_.length && lights_.every(e => haStates[e]?.state === 'on');
  const someLight    = lights_.some(e => haStates[e]?.state === 'on');
  const lightHtml = lights_.length ? `
    <div style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;margin-bottom:4px;">
        <div style="font-size:10px;text-transform:uppercase;color:#555;letter-spacing:0.1em;flex:1;">Lights</div>
        ${lights_.length > 1 ? `<button class="zp-all-lights" data-on="${allLightsOn ? '0' : '1'}"
          style="background:${someLight ? 'rgba(255,204,0,0.2)' : 'rgba(255,255,255,0.06)'};border:1px solid ${someLight ? 'rgba(255,204,0,0.4)' : 'rgba(255,255,255,0.1)'};color:${someLight ? '#ffcc00' : '#888'};border-radius:5px;padding:2px 8px;cursor:pointer;font-size:10px;font-weight:600;">
          ${allLightsOn ? 'All OFF' : 'All ON'}</button>` : ''}
      </div>
      ${lights_.map(e => {
        const on = haStates[e]?.state === 'on';
        return `<div style="display:flex;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span style="flex:1;color:#ccc;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">💡 ${escapeHtml(e.split('.').pop())}</span>
          <button class="zp-light-toggle" data-entity="${escapeHtml(e)}"
            style="background:${on ? 'rgba(255,204,0,0.2)' : 'rgba(255,255,255,0.06)'};border:1px solid ${on ? 'rgba(255,204,0,0.5)' : 'rgba(255,255,255,0.12)'};color:${on ? '#ffcc00' : '#888'};border-radius:5px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:600;min-width:40px;">
            ${on ? 'ON' : 'OFF'}</button>
        </div>`;
      }).join('')}
    </div>` : '';

  // ── Sirens ────────────────────────────────────────────────
  const allSirensOn  = sirens_.length && sirens_.every(e => haStates[e]?.state === 'on');
  const someSiren    = sirens_.some(e => haStates[e]?.state === 'on');
  const sirenHtml = sirens_.length ? `
    <div style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;margin-bottom:4px;">
        <div style="font-size:10px;text-transform:uppercase;color:#555;letter-spacing:0.1em;flex:1;">Sirens</div>
        ${sirens_.length > 1 ? `<button class="zp-all-sirens" data-on="${allSirensOn ? '0' : '1'}"
          style="background:${someSiren ? 'rgba(255,59,48,0.2)' : 'rgba(255,255,255,0.06)'};border:1px solid ${someSiren ? 'rgba(255,59,48,0.4)' : 'rgba(255,255,255,0.1)'};color:${someSiren ? '#ff6b6b' : '#888'};border-radius:5px;padding:2px 8px;cursor:pointer;font-size:10px;font-weight:600;">
          ${allSirensOn ? 'All OFF' : 'All ON'}</button>` : ''}
      </div>
      ${sirens_.map(e => {
        const on = haStates[e]?.state === 'on';
        return `<div style="display:flex;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span style="flex:1;color:#ccc;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🔊 ${escapeHtml(e.split('.').pop())}</span>
          <button class="zp-siren-toggle" data-entity="${escapeHtml(e)}"
            style="background:${on ? 'rgba(255,59,48,0.2)' : 'rgba(255,255,255,0.06)'};border:1px solid ${on ? 'rgba(255,59,48,0.5)' : 'rgba(255,255,255,0.12)'};color:${on ? '#ff6b6b' : '#888'};border-radius:5px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:600;min-width:40px;">
            ${on ? 'ON' : 'OFF'}</button>
        </div>`;
      }).join('')}
    </div>` : '';

  // ── Cameras ───────────────────────────────────────────────
  const cameraHtml = cameras_.length ? `
    <div style="margin-bottom:6px;">
      <div style="font-size:10px;text-transform:uppercase;color:#555;letter-spacing:0.1em;margin-bottom:4px;">Cameras</div>
      ${cameras_.map(e => {
        const resolvedId = getCamLowRes(e);
        const thumbUrl = showThumbs
          ? ((window.OW && window.OW.apiPath)
              ? window.OW.apiPath(`ow/snap-cache/${encodeURIComponent(resolvedId)}`)
              : `ow/snap-cache/${encodeURIComponent(resolvedId)}`) + `?t=${Date.now()}`
          : null;
        return `<div style="margin-bottom:6px;">
          ${showThumbs ? `<img data-cam="${escapeHtml(e)}" data-resolved-cam="${escapeHtml(resolvedId)}" src="${thumbUrl}" style="width:100%;height:120px;object-fit:cover;border-radius:6px;background:#111;display:block;margin-bottom:4px;" onerror="this.style.display='none'">` : ''}
          <div style="display:flex;align-items:center;padding:2px 0;">
            <span style="flex:1;color:#ccc;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📷 ${escapeHtml(e.split('.').pop())}</span>
            <button class="zp-cam-view" data-entity="${escapeHtml(e)}" style="background:rgba(0,150,255,0.15);border:1px solid rgba(0,150,255,0.35);color:#0096ff;border-radius:5px;padding:3px 10px;cursor:pointer;font-size:11px;">▶ View</button>
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

  popup.innerHTML = `<div style="padding:14px;">${armHtml}${sensorHtml}${doorHtml}${lightHtml}${sirenHtml}${cameraHtml}</div>`;

  // ── Wire events ───────────────────────────────────────────
  popup.querySelector('#zpClose')?.addEventListener('click', closeZonePopup);

  popup.querySelectorAll('.zp-door-control').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pin = doorPins.find(p => p.id === btn.dataset.pinId);
      if (!pin) return;
      callDoorPinControl(pin);
      setTimeout(refreshZonePopupIfOpen, 250);
    });
  });

  popup.querySelectorAll('.zp-door-links').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openDoorLinksPopover(btn.dataset.pinId, btn); });
  });

  // Arm/Disarm — optimistic: flip the zone switch in haStates immediately
  // Arm/Disarm — only for IPs in the allowed list
  const zSwitchId = `switch.overwatch_zone_${zoneSlug(zone)}`;
  if (canArmDisarm()) {
    popup.querySelector('#zpArm')?.addEventListener('click', () => {
      owCallSwitch(zSwitchId, true);
      if (haStates[zSwitchId]) haStates[zSwitchId] = { ...haStates[zSwitchId], state: 'on' };
      else haStates[zSwitchId] = { state: 'on' };
      refreshZonePopupIfOpen();
    });
    popup.querySelector('#zpDisarm')?.addEventListener('click', () => {
      owCallSwitch(zSwitchId, false);
      if (haStates[zSwitchId]) haStates[zSwitchId] = { ...haStates[zSwitchId], state: 'off' };
      else haStates[zSwitchId] = { state: 'off' };
      refreshZonePopupIfOpen();
    });
  }

  // Individual light toggles — optimistic
  popup.querySelectorAll('.zp-light-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const e = btn.dataset.entity;
      const on = haStates[e]?.state === 'on';
      if (haStates[e]) haStates[e] = { ...haStates[e], state: on ? 'off' : 'on' };
      _callService(e, on ? 'turn_off' : 'turn_on');
      refreshZonePopupIfOpen();
    });
  });

  // All lights on/off
  popup.querySelector('.zp-all-lights')?.addEventListener('click', btn => {
    const turnOn = btn.currentTarget.dataset.on === '1';
    lights_.forEach(e => {
      if (haStates[e]) haStates[e] = { ...haStates[e], state: turnOn ? 'on' : 'off' };
      _callService(e, turnOn ? 'turn_on' : 'turn_off');
    });
    refreshZonePopupIfOpen();
  });

  // Individual siren toggles — optimistic
  popup.querySelectorAll('.zp-siren-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const e = btn.dataset.entity;
      const on = haStates[e]?.state === 'on';
      if (haStates[e]) haStates[e] = { ...haStates[e], state: on ? 'off' : 'on' };
      _callService(e, on ? 'turn_off' : 'turn_on');
      refreshZonePopupIfOpen();
    });
  });

  // All sirens on/off
  popup.querySelector('.zp-all-sirens')?.addEventListener('click', btn => {
    const turnOn = btn.currentTarget.dataset.on === '1';
    sirens_.forEach(e => {
      if (haStates[e]) haStates[e] = { ...haStates[e], state: turnOn ? 'on' : 'off' };
      _callService(e, turnOn ? 'turn_on' : 'turn_off');
    });
    refreshZonePopupIfOpen();
  });

  // Camera view buttons
  popup.querySelectorAll('.zp-cam-view').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.openCameraModal) window.openCameraModal(btn.dataset.entity);
    });
  });

  // Re-attach drag (titlebar was recreated)
  const titlebar = popup.querySelector('#zpTitlebar');
  if (titlebar && !titlebar._dragBound) {
    titlebar._dragBound = true;
    let dragging = false, ox = 0, oy = 0;
    titlebar.style.cursor = 'grab';
    titlebar.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true; ox = e.clientX - popup.offsetLeft; oy = e.clientY - popup.offsetTop;
      titlebar.style.cursor = 'grabbing'; titlebar.setPointerCapture(e.pointerId); e.preventDefault();
    });
    titlebar.addEventListener('pointermove', e => {
      if (!dragging) return;
      popup.style.left = Math.max(0, Math.min(window.innerWidth  - popup.offsetWidth,  e.clientX - ox)) + 'px';
      popup.style.top  = Math.max(0, Math.min(window.innerHeight - popup.offsetHeight, e.clientY - oy)) + 'px';
    });
    titlebar.addEventListener('pointerup',    () => { dragging = false; titlebar.style.cursor = 'grab'; });
    titlebar.addEventListener('pointercancel',() => { dragging = false; titlebar.style.cursor = 'grab'; });
  }

  // Thumbnail refresh — match snapshot interval setting, only update <img> srcs (don't re-render whole popup)
  if (_zonePopupTimer) { clearInterval(_zonePopupTimer); _zonePopupTimer = null; }
  if (showThumbs && cameras_.length) {
    const intervalMs = (parseInt(localStorage.getItem('ow_snap_interval') || window.OW?.uiConfig?.cam_snapshot_interval || 2) || 2) * 1000;
    _zonePopupTimer = setInterval(() => {
      popup.querySelectorAll('img[data-cam]').forEach(img => {
        const e    = img.dataset.cam;
        const res  = getCamLowRes(e);
        const base = (window.OW && window.OW.apiPath)
          ? window.OW.apiPath(`ow/snap-cache/${encodeURIComponent(res)}`)
          : `ow/snap-cache/${encodeURIComponent(res)}`;
        img.src = `${base}?t=${Date.now()}`;
        img.style.display = 'block';
      });
    }, intervalMs);
  }
}

// Surgical refresh — update button states/sensor dots WITHOUT rebuilding img tags
function refreshZonePopupIfOpen() {
  const popup = _zonePopupEl;
  if (!popup || !_zonePopupZoneId) return;
  const zone = zones.find(z => z.id === _zonePopupZoneId);
  if (!zone) { closeZonePopup(); return; }

  // Arm/Disarm buttons (only exist if canArmDisarm() was true when popup opened)
  const zState  = getZoneState(zone);
  const isArmed = zState !== 'disabled';
  if (canArmDisarm()) {
    const btnArm    = popup.querySelector('#zpArm');
    const btnDisarm = popup.querySelector('#zpDisarm');
    if (btnArm) {
      btnArm.style.background   = isArmed ? 'rgba(0,150,255,0.3)'  : 'rgba(255,255,255,0.06)';
      btnArm.style.borderColor  = isArmed ? 'rgba(0,150,255,0.6)'  : 'rgba(255,255,255,0.12)';
      btnArm.style.color        = isArmed ? '#4db8ff' : '#666';
    }
    if (btnDisarm) {
      btnDisarm.style.background  = !isArmed ? 'rgba(255,59,48,0.3)'  : 'rgba(255,255,255,0.06)';
      btnDisarm.style.borderColor = !isArmed ? 'rgba(255,59,48,0.6)'  : 'rgba(255,255,255,0.12)';
      btnDisarm.style.color       = !isArmed ? '#ff6b6b' : '#666';
    }
  } else {
    // View-only — update the status text
    const statusSpan = popup.querySelector('#zpArmStatus');
    if (statusSpan) statusSpan.textContent = isArmed ? '🔵 Armed' : '⚪ Disarmed';
  }

  // Sensor dots + state text
  popup.querySelectorAll('[data-sensor-id]').forEach(row => {
    const e = row.dataset.sensorId;
    const triggered = isEntityTriggered(e);
    const state = haStates[e]?.state || '—';
    const dot  = row.querySelector('.sensor-dot');
    const text = row.querySelector('.sensor-state');
    if (dot)  { dot.style.background = triggered ? '#ff3b30' : '#34c759'; }
    if (text) { text.textContent = state.toUpperCase(); text.style.color = triggered ? '#ff6b6b' : '#34c759'; }
  });

  // Door/window rows + control button labels
  popup.querySelectorAll('[data-door-pin-id]').forEach(row => {
    const pin = doorPins.find(p => p.id === row.dataset.doorPinId);
    if (!pin) return;
    const state = doorPinDisplayState(pin);
    const open = pin.sensor_entity ? doorPinIsOpen(pin) : false;
    const dot = row.querySelector('.door-dot');
    const text = row.querySelector('.door-state');
    const btn = row.querySelector('.zp-door-control');
    const info = doorControlInfo(pin);
    if (dot)  { dot.style.background = open ? '#ff9500' : '#34c759'; }
    if (text) { text.textContent = String(state).toUpperCase(); text.style.color = open ? '#ff9500' : '#34c759'; }
    if (btn && info) btn.textContent = info.label;
  });

  // Light buttons
  popup.querySelectorAll('.zp-light-toggle').forEach(btn => {
    const on = haStates[btn.dataset.entity]?.state === 'on';
    btn.style.background   = on ? 'rgba(255,204,0,0.2)'     : 'rgba(255,255,255,0.06)';
    btn.style.borderColor  = on ? 'rgba(255,204,0,0.5)'     : 'rgba(255,255,255,0.12)';
    btn.style.color        = on ? '#ffcc00' : '#888';
    btn.textContent        = on ? 'ON' : 'OFF';
  });

  // Siren buttons
  popup.querySelectorAll('.zp-siren-toggle').forEach(btn => {
    const on = haStates[btn.dataset.entity]?.state === 'on';
    btn.style.background   = on ? 'rgba(255,59,48,0.2)'     : 'rgba(255,255,255,0.06)';
    btn.style.borderColor  = on ? 'rgba(255,59,48,0.5)'     : 'rgba(255,255,255,0.12)';
    btn.style.color        = on ? '#ff6b6b' : '#888';
    btn.textContent        = on ? 'ON' : 'OFF';
  });

  // All-on/off buttons
  const lights_ = zone.lights || [];
  const sirens_ = zone.sirens || [];
  const allLightsOn = lights_.length && lights_.every(e => haStates[e]?.state === 'on');
  const allSirensOn = sirens_.length && sirens_.every(e => haStates[e]?.state === 'on');
  const allLightsBtn = popup.querySelector('.zp-all-lights');
  const allSirensBtn = popup.querySelector('.zp-all-sirens');
  if (allLightsBtn) { allLightsBtn.textContent = allLightsOn ? 'All OFF' : 'All ON'; allLightsBtn.dataset.on = allLightsOn ? '0' : '1'; }
  if (allSirensBtn) { allSirensBtn.textContent = allSirensOn ? 'All OFF' : 'All ON'; allSirensBtn.dataset.on = allSirensOn ? '0' : '1'; }
}

/* ─── PIN ANIMATION LOOP moved to modules/ow-pins.js ───────────────────────── */
/* ─── ZONE EDITOR UI moved to modules/ow-zone-editor.js ───────────────────────── */
function bindZonesSvgEvents() {
  const svg = document.getElementById("zonesSvg");
  if (!svg) return;

  svg.addEventListener("pointerdown", e => {
    const target = e.target;
    const sx = e.clientX, sy = e.clientY;
    const fp = screenToFloorplan(sx, sy);

    // In live mode — defer zone popup until pointerup so map drags do not open it.
    if (!editorMode) {
      if (target.classList.contains("zone-polygon")) {
        const zoneId = target.dataset.zoneId;
        const zone   = zones.find(z => z.id === zoneId);
        if (zone?.hidden) { e.stopPropagation(); return; }
        svg._owLiveZonePointer = { zoneId, x: sx, y: sy, moved: false, clientX: e.clientX, clientY: e.clientY };
        // Do not stop propagation: the outer map pan handler must still be able to drag.
      }
      return;
    }

    // 0) Place a new light/siren pin
    if (placingPinType) {
      placePinAtFloorplanCoord(fp.x, fp.y, activeFloorId);
      e.stopPropagation(); return;
    }

    // 1) Dragging a vertex handle — capture and block pan
    if (target.classList.contains("zone-handle")) {
      draggingHandle = { zoneId: target.dataset.zoneId, idx: Number(target.dataset.index) };
      svg.setPointerCapture(e.pointerId);
      e.stopPropagation();
      return;
    }

    // 2) Drawing a new zone — add point BEFORE polygon selection.
    // While creating, every floorplan click is point placement. Other zones must not steal the click.
    if (isCreatingZone && currentNewZone) {
      pushUndo();
      currentNewZone.points.push({ x: fp.x, y: fp.y });
      saveZone(currentNewZone);
      renderZones();
      const countSpan = document.querySelector(`.zones-list-item[data-zone-id="${currentNewZone.id}"] span:last-child`);
      if (countSpan) countSpan.textContent = `${currentNewZone.points.length}pts`;
      e.stopPropagation();
      return;
    }

    // 3) Inserting a point (Edit Points mode)
    // Click outside the selected zone → insert new point at exact click position on closest edge.
    // If another zone is under the cursor, it is ignored; edit mode belongs to selectedZoneId only.
    if (isEditingPoints && selectedZoneId) {
      const zone = zones.find(z => z.id === selectedZoneId);
      if (zone && (zone.points || []).length >= 2) {
        const insideSelectedZone = isPointInPolygon(fp.x, fp.y, zone.points);
        if (!insideSelectedZone) {
          const info = closestEdgeInfo(zone, fp.x, fp.y);
          if (info) {
            pushUndo();
            // Insert at exact clicked position, not snapped to edge midpoint.
            zone.points.splice(info.insertAfter + 1, 0, { x: Math.round(fp.x), y: Math.round(fp.y) });
            saveZone(zone);
            renderZones();
            renderZonesEditorStable();
            e.stopPropagation();
            return;
          }
        }
        // Click inside selected zone but on a different overlapping polygon: drag selected zone, not the other zone.
        if (insideSelectedZone && target.classList.contains("zone-polygon") && target.dataset.zoneId !== selectedZoneId) {
          draggingZone = { zoneId: selectedZoneId, startPoints: zone.points.map(p => ({ ...p })) };
          dragStart = { x: sx, y: sy };
          svg.setPointerCapture(e.pointerId);
          e.stopPropagation();
          return;
        }
        // Click inside selected zone — fall through to polygon handler to start drag when target is selected polygon.
      }
    }

    // 4) Clicking a polygon — in live mode open zone popup, in editor mode select it.
    if (target.classList.contains("zone-polygon")) {
      const zoneId = target.dataset.zoneId;
      const zone   = zones.find(z => z.id === zoneId);
      if (zone?.hidden) { e.stopPropagation(); return; }

      // LIVE MODE is handled above by pointerdown/pointerup click-toggle logic.
      if (!editorMode) return;

      // Point editing is isolated to the selected zone. Other zones cannot be selected or dragged.
      if (isEditingPoints && selectedZoneId && zoneId !== selectedZoneId) {
        e.stopPropagation();
        return;
      }
      // Toggle — clicking same zone deselects it
      if (selectedZoneId === zoneId && !isEditingPoints) {
        selectedZoneId = null;
        renderZones(); renderZonesEditorStable();
        e.stopPropagation(); return;
      }
      selectedZoneId  = zoneId;
      selectedGroupId = null;
      activePinId = null; activePinType = null;
      // In edit points mode: clicking inside zone starts a drag of the whole zone
      if (isEditingPoints && zone) {
        draggingZone = { zoneId, startPoints: zone.points.map(p => ({ ...p })) };
        dragStart = { x: sx, y: sy };
        svg.setPointerCapture(e.pointerId);
      }
      renderZones();
      renderZonesEditorStable();
      e.stopPropagation();
      return;
    }

    // 5) Empty canvas click — deselect BUT let the event propagate so bindPan can pan
    selectedZoneId    = null;
    selectedGroupId   = null;
    highlightedZoneId = null; highlightedUntil      = 0;
    highlightedGroupId = null; highlightedGroupUntil = 0;
    isEditingPoints = false;
    activePinId = null; activePinType = null;
    placingPinType = null;
    const svgEl = document.getElementById('zonesSvg');
    if (svgEl) svgEl.style.cursor = '';
    renderZones();
    renderZonesEditorStable();
    // Do NOT stopPropagation here — outer pan handler will pick it up
  });

  svg.addEventListener("pointermove", e => {
    if (!editorMode) {
      const livePtr = svg._owLiveZonePointer;
      if (livePtr) {
        const dx = Math.abs(e.clientX - livePtr.x);
        const dy = Math.abs(e.clientY - livePtr.y);
        if (dx > 7 || dy > 7) livePtr.moved = true;
      }
      return;
    }
    const sx = e.clientX, sy = e.clientY;
    if (draggingHandle) {
      const zone = zones.find(z => z.id === draggingHandle.zoneId);
      if (!zone) return;
      zone.points[draggingHandle.idx] = screenToFloorplan(sx, sy);
      saveZone(zone);
      renderZones();
    } else if (draggingZone && dragStart) {
      const zone = zones.find(z => z.id === draggingZone.zoneId);
      if (!zone) return;
      const dxF = (sx - dragStart.x) / zoom.scale;
      const dyF = (sy - dragStart.y) / zoom.scale;
      zone.points = draggingZone.startPoints.map(p => ({ x: p.x + dxF, y: p.y + dyF }));
      saveZone(zone);
      renderZones();
    }
  });

  svg.addEventListener("pointerup", e => {
    if (!editorMode) {
      const livePtr = svg._owLiveZonePointer;
      svg._owLiveZonePointer = null;
      if (livePtr && !livePtr.moved) {
        const zone = zones.find(z => z.id === livePtr.zoneId);
        if (zone && !zone.hidden) {
          if (_zonePopupEl && _zonePopupZoneId === livePtr.zoneId) closeZonePopup();
          else openZonePopup(livePtr.zoneId, livePtr.clientX, livePtr.clientY);
          e.stopPropagation();
        }
      }
      return;
    }
    if (draggingHandle || draggingZone) {
      try { svg.releasePointerCapture(e.pointerId); } catch {}
    }
    draggingHandle = null;
    draggingZone   = null;
    dragStart      = null;
  });

  svg.addEventListener("pointercancel", () => { svg._owLiveZonePointer = null; });

  svg.addEventListener("dblclick", e => {
    if (!editorMode || !isCreatingZone || !currentNewZone) return;
    if (currentNewZone.points.length < 3) { alert("A zone needs at least 3 points."); return; }
    isCreatingZone = false;
    currentNewZone = null;
    saveZones();
    renderZonesEditorStable();
    scheduleHAReload(); // zone is now complete — create HA entity
    e.stopPropagation();
  });

  svg.addEventListener("contextmenu", e => {
    if (!editorMode) return;
    e.preventDefault();
    const target = e.target;
    if (target.classList.contains("zone-handle") && isEditingPoints) {
      const zone = zones.find(z => z.id === target.dataset.zoneId);
      if (!zone || zone.points.length <= 3) return;
      pushUndo();
      zone.points.splice(Number(target.dataset.index), 1);
      saveZone(zone);
      renderZones();
      renderZonesEditorStable();
    }
  });
}

/* ─── CONNECTION LOG PANEL moved to modules/ow-log.js ───────────────────────── */
function apiPath(rel) {
  return BASE_PATH ? `${BASE_PATH}/${rel}` : rel;
}

/* ─── SERVER HEALTH AND HA STATUS HELPERS moved to modules/ow-log.js ───────────────────────── */
function connectHA() {
  if (haSocket && (haSocket.readyState === WebSocket.OPEN || haSocket.readyState === WebSocket.CONNECTING)) return;
  if (haReconnectTimer) clearTimeout(haReconnectTimer);

  let wsUrl;
  const pageIsHttps = window.location.protocol === "https:";

  if (isAddonMode) {
    // Add-on / direct LAN mode: connect to our own server's WebSocket proxy.
    // The proxy handles auth server-side.
    const proto = pageIsHttps ? "wss:" : "ws:";
    const host  = window.location.host;
    // Direct mode has no BASE_PATH — just use the host directly
    wsUrl = `${proto}//${host}${BASE_PATH}/ws/api/websocket`;
    logEvent("info", IS_DIRECT_MODE
      ? "Connecting to HA via direct WebSocket proxy…"
      : "Connecting to HA via add-on WebSocket proxy…", "ha");
  } else {
    // Standalone mode: connect directly to HA WebSocket
    if (!uiConfig.ha_url) return;
    if (!uiConfig.ha_token) {
      logEvent("warn", "HA token required in standalone mode. Enter it in Settings.", "ha");
      return;
    }
    let haUrl = uiConfig.ha_url.replace(/\/$/, "");
    if (pageIsHttps && haUrl.startsWith("http://")) {
      haUrl = haUrl.replace("http://", "https://");
    }
    wsUrl = haUrl.replace(/^http/, "ws") + "/api/websocket";
    logEvent("info", `Connecting to HA at ${haUrl}…`, "ha");
  }

  try {
    haSocket = new WebSocket(wsUrl);
  } catch (e) {
    logEvent("error", "WebSocket creation failed: " + e.message, "ha");
    setHAStatus("error");
    scheduleReconnect();
    return;
  }

  haSocket.onopen = () => {
    logEvent("info", "WebSocket opened, awaiting HA auth…", "ha");
  };

  haSocket.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === "auth_required") {
      if (isAddonMode) {
        // Proxy will intercept this and replace with the real stored token server-side.
        // We send a placeholder so the browser participates in the auth flow normally.
        haSocket.send(JSON.stringify({ type: "auth", access_token: "addon-proxy" }));
      } else {
        haSocket.send(JSON.stringify({ type: "auth", access_token: uiConfig.ha_token }));
      }
    }

    if (msg.type === "auth_ok") {
      haConnected = true;
      haEverConnected = true;
      haReconnectDelay = 1000;     // reset exponential backoff
      showReconnectBanner(false);
      setHAStatus("connected");
      logEvent("ok", "Connected to Home Assistant (" + (msg.ha_version || "?") + ")", "ha");
      fetchAllStates();
      subscribeHAEntities();
      // Clear camera failure state on reconnect so cameras auto-recover
      if (window.camResetHidden) window.camResetHidden();
      // Re-render panels now that haConnected=true so zone states are visible
      if (getNumPanels() > 1) renderAllPanelZones(); else renderZones();
    }

    if (msg.type === "auth_invalid") {
      haConnected = false;
      setHAStatus("error");
      // Only show error toast if we've connected before — suppresses noise on first load
      if (haEverConnected) {
        logEvent("error", "HA authentication failed. Check your Long-Lived Access Token.", "ha");
      }
      haSocket.close();
    }

    if (msg.type === "result" && msg.success && Array.isArray(msg.result)) {
      for (const st of msg.result) {
        haStates[st.entity_id] = st;
      }
      haStatesLoaded = true; // mark states as fully loaded — safe to show fault state now
      logEvent("info", `Fetched ${msg.result.length} entity states from HA.`, "ha");

      // Re-run subscribeHAEntities now that haStates is populated —
      // the first call (at auth_ok) had an empty haStates so auto-detection was blind
      subscribeHAEntities();

      // Apply alarm entity state immediately
      const alarmEntity = uiConfig.alarm_entity;
      if (alarmEntity && haStates[alarmEntity]) {
        updateStatusFromAlarm(alarmEntity, haStates[alarmEntity]);
      } else {
        const autoAlarm = Object.keys(haStates).find(id => id.startsWith("alarm_control_panel."));
        if (autoAlarm) updateStatusFromAlarm(autoAlarm, haStates[autoAlarm]);
      }
      checkOfflineZoneEntities();
      checkZoneStateChanges();   // log any zones already triggered at connect time
      renderZones();
        if (editorMode && !document.activeElement?.closest('.zed-right')) renderZonesEditorStable();
      // Notify camera page if loaded
      if (window.OW && window.camUpdate) window.camUpdate();
    }

    if (msg.type === "result" && !msg.success) {
      logEvent("warn", `HA command failed (id=${msg.id}): ${msg.error?.message || "unknown error"}`, "ha");
    }

    if (msg.type === "event" && msg.event?.event_type === "state_changed") {
      const data = msg.event.data;
      if (data?.new_state) {
        const prev = haStates[data.entity_id];
        haStates[data.entity_id] = data.new_state;

        // Sync masterEnabled when the HA master switch changes
        if (data.entity_id === "switch.overwatch_zone_master") {
          const newMaster = (data.new_state.state || "").toLowerCase() !== "off";
          if (masterEnabled !== newMaster) {
            masterEnabled = newMaster;
            localStorage.setItem("masterEnabled", masterEnabled);
          }
          // Cascade master to all zones and groups
          const on = newMaster;
          for (const g of groups) owCallSwitch(`switch.overwatch_zone_group_${groupSlug(g)}`, on);
          for (const z of zones)  owCallSwitch(`switch.overwatch_zone_${zoneSlug(z)}`, on);
        }

        // When a ZONE group switch changes in HA, cascade to member zones
        if (data.entity_id.startsWith("switch.overwatch_zone_group_")) {
          const groupSwitchId = data.entity_id; // e.g. switch.overwatch_zone_group_house
          const on = (data.new_state.state || "").toLowerCase() !== "off";
          // Find which group this is
          const matchGroup = groups.find(g =>
            `switch.overwatch_zone_group_${groupSlug(g)}` === groupSwitchId);
          if (matchGroup) {
            (matchGroup.zone_ids || []).forEach(zid => {
              const z = zones.find(z => z.id === zid);
              if (z) owCallSwitch(`switch.overwatch_zone_${zoneSlug(z)}`, on);
            });
          }
        }

        // When a CAMERA group switch changes in HA, cascade to member zones and cameras
        if (data.entity_id.startsWith("switch.overwatch_camera_group_")) {
          const on = (data.new_state.state || "").toLowerCase() !== "off";
          const matchGroup = groups.find(g =>
            `switch.overwatch_camera_group_${groupSlug(g)}` === data.entity_id);
          if (matchGroup) {
            (matchGroup.zone_ids || []).forEach(zid => {
              const z = zones.find(z => z.id === zid);
              if (z && (z.cameras || []).length > 0) {
                owCallSwitch(`switch.overwatch_camera_zone_${nameSlug(z.name) || z.id}`, on);
                (z.cameras || []).forEach(camId => {
                  const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
                  owCallSwitch(`switch.overwatch_camera_${safe}`, on);
                });
              }
            });
          }
        }

        // When a CAMERA zone switch changes in HA, cascade to member cameras
        if (data.entity_id.startsWith("switch.overwatch_camera_zone_")) {
          const on = (data.new_state.state || "").toLowerCase() !== "off";
          const slug = data.entity_id.replace("switch.overwatch_camera_zone_", "");
          const matchZone = zones.find(z => (nameSlug(z.name) || z.id) === slug);
          if (matchZone) {
            (matchZone.cameras || []).forEach(camId => {
              const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
              owCallSwitch(`switch.overwatch_camera_${safe}`, on);
            });
          }
        }

        // When a ZONE floor switch changes, cascade to all zones on that floor
        if (data.entity_id.startsWith("switch.overwatch_zone_floor_")) {
          const on = (data.new_state.state || "").toLowerCase() !== "off";
          const fid = data.entity_id.replace("switch.overwatch_zone_floor_", "");
          const isFirstFloor1 = floors.length === 0 || floors[0].id === fid;
          zones.filter(z => z.floor_id === fid || (!z.floor_id && isFirstFloor1)).forEach(z => {
            owCallSwitch(`switch.overwatch_zone_${zoneSlug(z)}`, on);
          });
        }

        // When a CAMERA floor switch changes, cascade to zones + cameras on that floor
        if (data.entity_id.startsWith("switch.overwatch_camera_floor_")) {
          const on = (data.new_state.state || "").toLowerCase() !== "off";
          const fid = data.entity_id.replace("switch.overwatch_camera_floor_", "");
          const isFirstFloor2 = floors.length === 0 || floors[0].id === fid;
          zones.filter(z => (z.floor_id === fid || (!z.floor_id && isFirstFloor2)) && (z.cameras || []).length > 0).forEach(z => {
            owCallSwitch(`switch.overwatch_camera_zone_${nameSlug(z.name) || z.id}`, on);
            (z.cameras || []).forEach(camId => {
              const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
              owCallSwitch(`switch.overwatch_camera_${safe}`, on);
            });
          });
        }

        // When camera_all changes in HA, cascade to all zones and cameras
        if (data.entity_id === "switch.overwatch_camera_all") {
          const on = (data.new_state.state || "").toLowerCase() !== "off";
          zones.forEach(z => {
            if ((z.cameras || []).length > 0) {
              owCallSwitch(`switch.overwatch_camera_zone_${nameSlug(z.name) || z.id}`, on);
              (z.cameras || []).forEach(camId => {
                const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
                owCallSwitch(`switch.overwatch_camera_${safe}`, on);
              });
            }
          });
        }

        // Re-render when any overwatch switch changes
        if (data.entity_id.startsWith("switch.overwatch_")) {
          updateStatusDropdownInPlace();
          refreshMonitoringStatusBar();
          renderZones();
          // Re-render camera status bar when a camera switch changes
          if (window.renderCameraStatusBar &&
              data.entity_id.startsWith("switch.overwatch_camera_")) {
            window.renderCameraStatusBar();
          }
        }

        // Always update status bar for the configured alarm entity or any alarm_control_panel
        // This runs regardless of haSubscribedEntities to prevent missed status updates
        const alarmEntity = uiConfig.alarm_entity || "";
        const isAlarmEnt  = alarmEntity
          ? data.entity_id === alarmEntity
          : data.entity_id.startsWith("alarm_control_panel.");
        if (isAlarmEnt) {
          updateStatusFromAlarm(data.entity_id, data.new_state);
          renderStatusDropdown();
        }

        // Log zone entity online/offline transitions
        const isZoneEntity = haSubscribedEntities.has(data.entity_id) &&
                             !data.entity_id.startsWith("alarm_control_panel.");
        if (isZoneEntity) {
          const newSt  = (data.new_state.state || "").toLowerCase();
          const prevSt = (prev?.state || "").toLowerCase();
          if (newSt === "unavailable" && prevSt !== "unavailable") {
            logEvent("warn", `Entity offline: ${data.entity_id}`, "entity", { entityId: data.entity_id });
          } else if (prevSt === "unavailable" && newSt !== "unavailable") {
            logEvent("ok", `Entity back online: ${data.entity_id} (${data.new_state.state})`, "entity", { entityId: data.entity_id });
          }
        }

        // Keep an open zone popup live for all HA state changes. This covers lights/sensors/doors
        // even if the entity was not in haSubscribedEntities when the popup was opened.
        refreshZonePopupIfOpen();

        // Render zones + check for zone state transitions when a subscribed entity changes
        if (haSubscribedEntities.has(data.entity_id)) {
          checkZoneStateChanges();
          renderZones();
          if (editorMode) renderZonesEditorStable();
          if (window.camUpdate) window.camUpdate();
        }

        // Start pin animation loop when a light or siren entity changes state
        const isPinEntity = [...lights, ...sirens].some(p => p.entity_id === data.entity_id)
          || doorPins.some(p => p.sensor_entity === data.entity_id || p.control_entity === data.entity_id);
        if (isPinEntity) { startPinAnimLoop(); renderZones(); }
      }
    }
  };

  haSocket.onclose = (ev) => {
    haConnected = false;
    haStatesLoaded = false; // reset so fault check pauses until states reload
    setHAStatus("disconnected");
    showReconnectBanner(true);
    const reason = ev.reason ? ` (${ev.reason})` : "";
    if (haEverConnected) {
      logEvent("warn", `HA WebSocket disconnected (code ${ev.code})${reason}. Retrying in ${Math.round(haReconnectDelay/1000)}s…`, "ha");
    }
    // Code 1006 = abnormal closure (HA restarting/not ready).
    // Use a longer delay to avoid hammering HA with failed auth attempts
    // which generate "Login attempt failed" notifications.
    if (ev.code === 1006 && haReconnectDelay < 5000) {
      haReconnectDelay = 5000;
    }
    scheduleReconnect();
  };

  haSocket.onerror = () => {
    setHAStatus("error");
    if (haEverConnected) {
      logEvent("error", "HA WebSocket error. Is the HA URL correct and reachable?", "ha");
    }
  };
}

function scheduleReconnect() {
  if (IS_DIRECT_MODE) return; // Direct Mode uses poller, not WebSocket reconnect
  if (haReconnectTimer) clearTimeout(haReconnectTimer);
  haReconnectTimer = setTimeout(() => {
    connectHA();
    // Exponential backoff: double delay up to 30s
    haReconnectDelay = Math.min(haReconnectDelay * 2, 30000);
  }, haReconnectDelay);
}

// Direct Mode state poller — replaces WebSocket in Direct Mode.
// Polls /ow/states every 1s, populates haStates identically to the WS path.
let directModePollTimer = null;
function startDirectModePoller() {
  if (!IS_DIRECT_MODE) return;
  async function poll() {
    let nextPoll = 1000;
    try {
      const res = await fetch("ow/states", { cache: "no-store" });
      if (res.ok) {
        const states = await res.json();
        const entityCount = Object.keys(states).length;

        if (entityCount === 0) {
          // Cache not ready yet — retry quickly
          nextPoll = 500;
        } else {
          Object.values(states).forEach(st => {
            if (st.entity_id) haStates[st.entity_id] = st;
          });

          if (!haConnected) {
            haConnected = true;
            haEverConnected = true;
            setHAStatus("connected");
            logEvent("ok", `Direct Mode: ${entityCount} entity states loaded from backend.`, "ha");
            subscribeHAEntities(); // builds the entity set (no WS send in direct mode)
            // Re-render panels now that haConnected=true
            if (getNumPanels() > 1) renderAllPanelZones(); else renderZones();
          }

          // Always re-render on each poll so zone colours and alarm state stay live
          checkZoneStateChanges();
          renderZones();
          // Sync masterEnabled from haStates so master toggle reflects HA state
          const masterSwitch = haStates["switch.overwatch_zone_master"];
          if (masterSwitch) masterEnabled = masterSwitch.state !== "off";
          // Re-render zone status dropdown so toggles reflect latest haStates
          updateStatusDropdownInPlace();
          refreshMonitoringStatusBar();
          // Keep the open zone popup live in Direct Mode (/ow/states polling).
          refreshZonePopupIfOpen();
          // Re-render camera status bar and grid so toggle states reflect latest haStates
          if (window.renderCameraStatusBar) { window.renderCameraStatusBar(); applyStatusVisibility(); }
          if (window.camUpdate) window.camUpdate();
          // Refresh floor flyout dots if open
          if (document.getElementById("floorFlyout")) renderFloorFlyout();
          const alarmEntity = uiConfig.alarm_entity ||
            Object.keys(haStates).find(id => id.startsWith("alarm_control_panel."));
          if (alarmEntity && haStates[alarmEntity]) {
            updateStatusFromAlarm(alarmEntity, haStates[alarmEntity]);
          }
        }
      }
    } catch (e) {
      if (haConnected) {
        haConnected = false;
        setHAStatus("error");
        logEvent("warn", "Direct Mode: lost contact with backend.", "ha");
      }
    }
    directModePollTimer = setTimeout(poll, nextPoll);
  }
  poll();
}

function showReconnectBanner(show) {
  let banner = document.getElementById("owReconnectBanner");
  if (show) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "owReconnectBanner";
      banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(255,149,0,0.92);color:#000;font-size:12px;font-weight:600;text-align:center;padding:4px 8px;pointer-events:none;";
      banner.textContent = "⚡ Reconnecting to Home Assistant…";
      document.body.appendChild(banner);
    }
  } else {
    if (banner) banner.remove();
  }
}

function sendHA(payload) {
  if (!haSocket || haSocket.readyState !== WebSocket.OPEN) return;
  payload.id = haMsgId++;
  haSocket.send(JSON.stringify(payload));
}

function fetchAllStates() {
  sendHA({ type: "get_states" });
}

// Fetch a single entity's current state from HA and insert into haStates.
// Used when a new entity is added to a zone that wasn't in the initial get_states response.
function fetchSingleEntityState(entityId) {
  sendHA({
    type: "get_states",
    id: undefined, // sendHA assigns the id
  });
  // Simpler: use the REST API via our proxy
  fetch(apiPath("ow/states") + "?v=" + Date.now())
    .then(r => r.ok ? r.json() : null)
    .then(states => {
      if (!states) return;
      // states is an object: entity_id -> state_obj
      if (states[entityId]) {
        haStates[entityId] = states[entityId];
      } else {
        // Entity genuinely doesn't exist in HA — insert a placeholder so !st doesn't fault
        haStates[entityId] = { entity_id: entityId, state: "unknown", attributes: {} };
      }
      renderZones();
    })
    .catch(() => {
      // On failure insert placeholder so !st doesn't permanently fault
      if (!haStates[entityId]) {
        haStates[entityId] = { entity_id: entityId, state: "unknown", attributes: {} };
      }
    });
}

function subscribeHAEntities() {
  if (!haConnected) return;

  // Subscribe to ALL state_changed events once — one sub covers everything
  if (!haSubscribedEntities.has("__subscribed__")) {
    haSubscribedEntities.add("__subscribed__");
    sendHA({ type: "subscribe_events", event_type: "state_changed" });
  }

  // Rebuild the set of entities we care about (does NOT cancel the subscription above)
  // We keep "__subscribed__" so the guard above still works on future calls
  haSubscribedEntities.clear();
  haSubscribedEntities.add("__subscribed__");

  // Alarm panel entity (any domain — could be input_boolean, switch, etc.)
  if (uiConfig.alarm_entity) haSubscribedEntities.add(uiConfig.alarm_entity);

  // Auto-detect alarm_control_panel entities
  Object.keys(haStates).forEach(id => {
    if (id.startsWith("alarm_control_panel.")) haSubscribedEntities.add(id);
  });

  // All zone device entities
  for (const zone of zones) {
    for (const s of (zone.sensors || []))  haSubscribedEntities.add(s);
    for (const s of (zone.cameras || []))  haSubscribedEntities.add(s);
    for (const s of (zone.lights  || []))  haSubscribedEntities.add(s);
    for (const s of (zone.sirens  || []))  haSubscribedEntities.add(s);
    // Zone arm switch — so armed/disarmed changes from HA/dashboard update the editor and suppress logic
    const zSwitchId = `switch.overwatch_zone_${zoneSlug(zone)}`;
    haSubscribedEntities.add(zSwitchId);
  }
  // Master arm switch
  haSubscribedEntities.add('switch.overwatch_zone_master');

  // Door pin sensor entities
  for (const pin of doorPins) {
    if (pin.sensor_entity)  haSubscribedEntities.add(pin.sensor_entity);
    if (pin.control_entity) haSubscribedEntities.add(pin.control_entity);
  }

  // Map pin entities (lights and sirens placed on map)
  for (const pin of lights) if (pin.entity_id) haSubscribedEntities.add(pin.entity_id);
  for (const pin of sirens) if (pin.entity_id) haSubscribedEntities.add(pin.entity_id);
}

/* Track last logged alarm state to avoid duplicate entries on reconnect */
let lastLoggedAlarmState = null;

function updateStatusFromAlarm(entityId, newState) {
  const alarmEntity = uiConfig.alarm_entity || "";
  const isAlarm = alarmEntity
    ? entityId === alarmEntity
    : entityId.startsWith("alarm_control_panel.");
  if (!isAlarm) return;

  const rawState = (newState?.state || "").toLowerCase();
  const inverted  = !!uiConfig.alarm_entity_inverted;

  // For generic on/off entities, apply inversion to get effective state
  let effectiveArmed;
  if (rawState === "on")  effectiveArmed = !inverted;
  else if (rawState === "off") effectiveArmed = inverted;
  else effectiveArmed = isAlarmArmed();

  const statusEl = document.getElementById("statusText");
  const dotEl    = document.getElementById("statusDot");

  // Human-readable label for this state
  const labelArmed    = uiConfig.alarm_label_armed    || "Armed";
  const labelDisarmed = uiConfig.alarm_label_disarmed || "Disarmed";

  const labels = {
    disarmed:    labelDisarmed,
    armed_home:  `${labelArmed} Home`,
    armed_away:  `${labelArmed} Away`,
    armed_night: `${labelArmed} Night`,
    triggered:   "⚠ TRIGGERED",
    pending:     "Pending…",
    arming:      "Arming…",
    unavailable: "Unavailable",
  };
  let label = labels[rawState];
  if (!label) {
    if (rawState === "on")       label = inverted ? labelDisarmed : labelArmed;
    else if (rawState === "off") label = inverted ? labelArmed    : labelDisarmed;
    else                         label = rawState || uiConfig.status;
  }

  if (statusEl) statusEl.textContent = label;

  if (dotEl) {
    dotEl.className = "status-dot";
    // Only pulse when a zone is actually triggered — not just because system is armed
    const anyZoneTriggered = haConnected && zones.some(z => getZoneState(z) === "triggered");
    if (rawState === "triggered" || anyZoneTriggered) {
      dotEl.classList.add("triggered");         // red + pulse
    } else if (rawState === "armed_away") {
      dotEl.classList.add("armed-away");         // solid colour, no pulse
    } else if (rawState === "armed_home" || rawState === "armed_night") {
      dotEl.classList.add("armed-home");
    } else if (rawState === "pending" || rawState === "arming") {
      dotEl.classList.add("pending");
    } else if (effectiveArmed) {
      dotEl.classList.add("armed-away");         // generic armed — solid, no pulse
    }
  }

  // Issue 27: log alarm state changes — only when state actually changes
  refreshMonitoringStatusBar();

  if (rawState !== lastLoggedAlarmState) {
    lastLoggedAlarmState = rawState;

    // Pick log level: triggered = error, everything else = info
    let level = "info";
    if (rawState === "triggered") level = "error";
    else if (rawState === "disarmed" || rawState === "off") level = "ok";

    logEvent(level, `Alarm: ${label} (${entityId})`, "ha");
  }
}

/* ─── SETTINGS PANEL ──────────────────────────────────────── */
/* ─── SETTINGS PANEL moved to modules/ow-settings.js ───────────────────────── */
/* makeDraggable moved to modules/ow-settings.js */
/* ─── SEARCH ──────────────────────────────────────────────── */
function setSearchOpen(open) {
  searchOpen = open;
  const panel = document.getElementById("searchPanel");
  if (!panel) return;
  if (open) {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    const input = document.getElementById("searchInput");
    if (input) setTimeout(() => input.focus(), 0);
    runSearch(document.getElementById("searchInput")?.value || "");
  } else {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }
}

/* ─── escapeHtml moved to modules/ow-utils.js ───────────────────────── */
function runSearch(q) {
  const resultsEl = document.getElementById("searchResults");
  if (!resultsEl) return;
  const query = (q || "").trim().toLowerCase();
  if (!query) { resultsEl.innerHTML = ""; return; }

  const hits = [];
  for (const z of zones) {
    const zid   = (z.id || "").toLowerCase();
    const zname = (z.name || "").toLowerCase();
    if (zid.includes(query) || zname.includes(query)) {
      hits.push({ type: "zone", zoneId: z.id, title: z.name || z.id, sub: `Zone` });
    }
    for (const s of (z.sensors || [])) {
      if (isEntityGhosted(s)) continue; // skip ghosted
      if (String(s).toLowerCase().includes(query)) {
        hits.push({ type: "entity", zoneId: z.id, title: s, sub: `Sensor in ${z.name || z.id}` });
      }
    }
    for (const c of (z.cameras || [])) {
      if (isEntityGhosted(c)) continue; // skip ghosted
      const friendly = haStates[c]?.attributes?.friendly_name || c;
      if (String(c).toLowerCase().includes(query) || friendly.toLowerCase().includes(query)) {
        hits.push({ type: "camera", zoneId: z.id, title: friendly, sub: `Camera in ${z.name || z.id}` });
      }
    }
  }

  const seen = new Set();
  const uniq = hits.filter(h => {
    const key = `${h.type}|${h.zoneId}|${h.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    const order = { zone: 0, camera: 1, entity: 2 };
    if (a.type !== b.type) return (order[a.type] ?? 9) - (order[b.type] ?? 9);
    return a.title.localeCompare(b.title);
  });

  resultsEl.innerHTML = uniq.slice(0, 60).map(h => `
    <div class="search-result" data-zone-id="${escapeHtml(h.zoneId)}">
      <div class="search-result-title">${escapeHtml(h.title)}</div>
      <div class="search-result-sub">${escapeHtml(h.sub)}</div>
    </div>
  `).join("");

  resultsEl.querySelectorAll(".search-result").forEach(el => {
    el.onclick = () => focusZone(el.getAttribute("data-zone-id"));
  });

  // Append automation results from automations.js if registered
  if (window.OW?.automationSearch) {
    const autoHits = window.OW.automationSearch(query);
    if (autoHits.length) {
      const autoFrag = document.createDocumentFragment();
      const sep = document.createElement('div');
      sep.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#444;padding:6px 10px 2px;';
      sep.textContent = 'Automations';
      autoFrag.appendChild(sep);
      autoHits.slice(0, 10).forEach(h => {
        const el = document.createElement('div');
        el.className = 'search-result';
        el.innerHTML = `<div class="search-result-title">${escapeHtml(h.label)}</div><div class="search-result-sub">${escapeHtml(h.sublabel||'')}</div>`;
        el.onclick = () => { setSearchOpen(false); h.action?.(); };
        autoFrag.appendChild(el);
      });
      resultsEl.appendChild(autoFrag);
    }
  }
}

function focusZone(zoneId) {
  const z = zones.find(zz => zz.id === zoneId);
  if (!z || !(z.points || []).length) return;

  // Issue 2: highlight only — do NOT move/zoom the map
  highlightedZoneId = zoneId;
  highlightedUntil  = Date.now() + 15000;
  renderZones();
  setTimeout(() => renderZones(), 15100);

  selectedZoneId = zoneId;
  activePinId = null; activePinType = null;
  if (editorMode) { renderZonesEditorStable(); renderZones(); }
  setSearchOpen(false);
}

function setHighlightFromDropdown(zoneId) {
  highlightedZoneId    = zoneId;
  highlightedUntil     = Date.now() + 15000;
  highlightedGroupId   = null;
  highlightedGroupUntil = 0;
  renderZones();
  setTimeout(() => renderZones(), 15100);
}

function setGroupHighlightFromDropdown(groupId) {
  highlightedGroupId    = groupId;
  highlightedGroupUntil = Date.now() + 15000;
  highlightedZoneId     = null;
  highlightedUntil      = 0;
  renderZones();
  setTimeout(() => renderZones(), 15100);
}

function clearDropdownHighlight() {
  highlightedZoneId     = null;
  highlightedUntil      = 0;
  highlightedGroupId    = null;
  highlightedGroupUntil = 0;
  renderZones();
}

function animateZoomTo(scale, x, y, durationMs) {
  const start = performance.now();
  const s0 = zoom.scale, x0 = zoom.x, y0 = zoom.y;
  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const e = ease(t);
    zoom.scale = s0 + (scale - s0) * e;
    zoom.x = x0 + (x - x0) * e;
    zoom.y = y0 + (y - y0) * e;
    applyTransform();
    if (t < 1) requestAnimationFrame(step);
    else saveZoom();
  }

  requestAnimationFrame(step);
}

/* ─── STATUS BAR DROPDOWN (issue 20) ─────────────────────── */
/* ─── IN-PLACE STATUS DROPDOWN UPDATE ────────────────────────
 * Updates dots, toggles, eye buttons, and state labels without
 * rebuilding the list — preserves scroll position.
 * Falls back to full re-render if dropdown isn't open.
 * ─────────────────────────────────────────────────────────── */
function updateStatusDropdownInPlace() {
  const dd = document.getElementById("statusDropdown");
  if (!dd || dd.style.display === "none") return;
  const body = document.getElementById("statusDropdownBody");
  if (!body) return;

  const eyeOpen   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 12 5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>`;
  const eyeClosed = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 12 5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

  // Master toggle
  const masterChk = body.querySelector("#masterToggleChk");
  if (masterChk) {
    masterChk.checked  = masterSwitchEnabled();
    const mLocked = !canArmDisarm();
    masterChk.disabled = mLocked;
    if (masterChk.closest('label')) masterChk.closest('label').style.opacity = mLocked ? '0.4' : '';
  }
  refreshMonitoringStatusBar();

  // Per-zone: toggle, eye, dot, state label
  body.querySelectorAll(".zone-enabled-chk[data-zone-id]").forEach(chk => {
    const zone = zones.find(z => z.id === chk.dataset.zoneId);
    if (!zone) return;
    const _zst  = getZoneState(zone);
    const zLocked = !canArmDisarm();
    chk.checked  = _zst !== "disabled";
    chk.disabled = zLocked;
    if (chk.closest('label')) chk.closest('label').style.opacity = zLocked ? '0.4' : '';

    const row = chk.closest(".status-dd-zone");
    if (!row) return;
    const isOff = _zst === "disabled";
    const st    = getZoneState(zone);
    const isTriggeredZone = st === "triggered";
    const activeEntity = haConnected ? zoneActiveTriggerEntity(zone) : '';
    const anyActive = !!activeEntity;
    const isDisarmedActive = isOff && anyActive;

    const dotColour = isTriggeredZone ? "#ff3b30"
      : isDisarmedActive ? resolveColour(entityTypeColourOff(detectEntityType(activeEntity || "door")))
      : st === "fault" ? "#ff9500"
      : isOff ? (zone.colorHex || "#0096ff")
      :          "#ff3b30";
    const dotOpacity = (isOff && !isDisarmedActive) ? 0.3 : 1;
    const stateLabel = isTriggeredZone ? "triggered" : st === "fault" ? "fault" : isOff ? "disarmed" : "armed";

    const dot = row.querySelector(`.zone-list-dot[data-zone-id="${zone.id}"]`);
    if (dot) { dot.style.background = dotColour; dot.style.opacity = String(dotOpacity); }

    const stateEl = row.querySelector(".status-dd-state");
    if (stateEl) { stateEl.textContent = stateLabel; stateEl.style.color = dotColour; stateEl.style.opacity = (isOff && !isDisarmedActive) ? "0.4" : "0.8"; }

    const nameEl = row.querySelector(".status-dd-zname");
    if (nameEl) nameEl.style.opacity = zone.hidden ? "0.35" : isOff && !isDisarmedActive ? "0.5" : "1";

    const eyeBtn = row.querySelector(`.zone-eye-btn[data-zone-id="${zone.id}"]`);
    if (eyeBtn) {
      eyeBtn.innerHTML = zone.hidden ? eyeClosed : eyeOpen;
      eyeBtn.style.color = zone.hidden ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.65)";
    }
  });

  // Per-group: toggle, eye, dot
  body.querySelectorAll(".group-armed-chk[data-group-id]").forEach(chk => {
    const group = groups.find(g => g.id === chk.dataset.groupId);
    if (!group) return;
    const members = (group.zone_ids || []).map(id => zones.find(z => z.id === id)).filter(Boolean);
    const allArmed = members.length > 0 && members.every(z => getZoneState(z) !== 'disabled');
    const gLocked = !canArmDisarm();
    chk.checked  = allArmed;
    chk.disabled = gLocked;
    if (chk.closest('label')) chk.closest('label').style.opacity = gLocked ? '0.4' : '';

    const hdr = chk.closest(".status-dd-group-header");
    if (!hdr) return;
    const allDisarmed  = members.every(z => getZoneState(z) === "disabled");
    const someArmed    = !allArmed && !allDisarmed;
    const anyTriggered = members.some(z => getZoneState(z) === "triggered");
    const gHex  = group.colorHex || "#ff3b30";
    const colour = allDisarmed ? gHex : someArmed ? "#ff9500" : "#ff3b30";
    const opacity = allDisarmed ? 0.35 : 1;

    const dot = hdr.querySelector(`.zone-list-dot[data-group-dot="${group.id}"]`);
    if (dot) { dot.style.background = colour; dot.style.opacity = String(opacity); dot.classList.toggle("flashing", anyTriggered && !allDisarmed); }

    const allMembHidden = members.length > 0 && members.every(z => z.hidden);
    const eyeBtn = hdr.querySelector(".group-eye-btn");
    if (eyeBtn) { eyeBtn.innerHTML = allMembHidden ? eyeClosed : eyeOpen; eyeBtn.style.color = allMembHidden ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.65)"; }
  });

  // Ungrouped toggle + dot
  const ungroupedChk = body.querySelector(".ungrouped-armed-chk");
  if (ungroupedChk) {
    const groupedIds = new Set(groups.flatMap(g => g.zone_ids || []));
    const ung = zones.filter(z => !groupedIds.has(z.id));
    const allArmed   = ung.length > 0 && ung.every(z => getZoneState(z) !== 'disabled');
    const allDisarmed = ung.every(z => getZoneState(z) === "disabled");
    const someArmed  = !allArmed && !allDisarmed;
    const anyTriggered = ung.some(z => getZoneState(z) === "triggered");
    ungroupedChk.checked = allArmed;
    const hdr = ungroupedChk.closest(".status-dd-group-header");
    if (hdr) {
      const colour  = allDisarmed ? "#888" : someArmed ? "#ff9500" : "#ff3b30";
      const opacity = allDisarmed ? 0.35 : 1;
      const dot = hdr.querySelector(".zone-list-dot[data-group-dot='__ungrouped']");
      if (dot) { dot.style.background = colour; dot.style.opacity = String(opacity); dot.classList.toggle("flashing", anyTriggered && !allDisarmed); }
      const allHidn = ung.length > 0 && ung.every(z => z.hidden);
      const eyeBtn  = hdr.querySelector(".ungrouped-eye-btn");
      if (eyeBtn) { eyeBtn.innerHTML = allHidn ? eyeClosed : eyeOpen; eyeBtn.style.color = allHidn ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.65)"; }
    }
  }

  // Master eye
  const allHidden = zones.length > 0 && zones.every(z => z.hidden);
  const masterEye = body.querySelector("#masterEyeBtn");
  if (masterEye) { masterEye.innerHTML = allHidden ? eyeClosed : eyeOpen; masterEye.style.color = allHidden ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.65)"; }
}

function renderStatusDropdown() {
  const body = document.getElementById("statusDropdownBody");
  if (!body) return;

  const eyeOpen   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 12 5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>`;
  const eyeClosed = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 12 5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

  const allHidden = zones.length > 0 && zones.every(z => z.hidden);

  // Build zone row HTML (shared by group members and ungrouped)
  function zoneRow(z, indented = false) {
    const state = getZoneState(z);
    const isOff = getZoneState(z) === 'disabled';
    const isTriggeredZone = state === "triggered";
    const activeEntity = haConnected ? zoneActiveTriggerEntity(z) : '';
    const anyActive = !!activeEntity;
    const isDisarmedActive = isOff && anyActive;
    // Locked = server mode on a Direct Mode browser (no WS to call HA switches)
    const zoneLocked = !canArmDisarm();
    const dotColour = isTriggeredZone ? "#ff3b30"
      : isDisarmedActive ? resolveColour(entityTypeColourOff(detectEntityType(activeEntity || "door")))
      : state === "fault" ? "#ff9500"
      : isOff ? (z.colorHex || "#0096ff")  // disarmed + clear → zone colour (dimmed by opacity)
      :          "#ff3b30";                  // armed + clear → red
    const dotFlashing = isTriggeredZone || isDisarmedActive;
    const dotOpacity  = (isOff && !isDisarmedActive) ? 0.3 : 1;
    const stateLabel  = isTriggeredZone ? "triggered" : state === "fault" ? "fault" : isOff ? "disarmed" : "armed";
    return `
      <div class="status-dd-zone status-dd-zone-indented">
        <div class="zone-list-dot${dotFlashing ? ' flashing' : ''}" data-zone-id="${z.id}" style="background:${dotColour};flex-shrink:0;opacity:${dotOpacity};"></div>
        <span class="status-dd-zname" style="opacity:${z.hidden ? 0.35 : isOff && !isDisarmedActive ? 0.5 : 1}">${escapeHtml(z.name || z.id)}</span>
        <span class="status-dd-state" style="color:${dotColour};opacity:${isOff && !isDisarmedActive ? 0.4 : 0.8}">${stateLabel}</span>
        <button class="zone-eye-btn" data-zone-id="${z.id}"
          style="background:none;border:none;padding:0 2px;cursor:pointer;color:${z.hidden ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.65)'};line-height:0;flex-shrink:0;"
        >${z.hidden ? eyeClosed : eyeOpen}</button>
        <label class="zone-toggle-switch" style="flex-shrink:0;${zoneLocked ? 'opacity:0.4;' : ''}">
          <input type="checkbox" class="zone-enabled-chk" data-zone-id="${z.id}" ${getZoneState(z) !== "disabled" ? "checked" : ""} ${zoneLocked ? "disabled" : ""}>
          <span class="zone-toggle-track"></span>
        </label>
      </div>`;
  }

  // Build group section
  function groupSection(g) {
    const members = (g.zone_ids || [])
      .map(id => zones.find(z => z.id === id))
      .filter(Boolean)
      .sort((a, b) => (a.name||a.id).localeCompare(b.name||b.id));
    const allArmed    = members.length > 0 && members.every(z => getZoneState(z) !== 'disabled');
    const allDisarmed = members.length === 0 || members.every(z => getZoneState(z) === 'disabled');
    const anyTriggered = members.some(z => getZoneState(z) === "triggered");
    const allMembHidden = members.length > 0 && members.every(z => z.hidden);
    const gHex        = g.colorHex || "#ff3b30";
    const anyArmed    = !allDisarmed;
    const someArmed   = anyArmed && !allArmed;   // mixed
    const gDotColour  = allDisarmed ? gHex
                      : someArmed   ? "#ff9500"   // orange = mixed
                      :               "#ff3b30";  // red = all armed
    const gDotOpacity = allDisarmed ? 0.35 : 1;
    const gDotFlash   = anyTriggered && !allDisarmed;
    const storageKey  = `ddGroup_${g.id}`;
    const collapsed   = localStorage.getItem(storageKey) !== "expanded";
    return `
      <div class="status-dd-group-header" data-group-id="${g.id}" data-storage-key="${storageKey}">
        <span class="status-dd-chevron" style="font-size:9px;color:#555;width:10px;flex-shrink:0;transition:transform 0.2s;display:inline-block;transform:rotate(${collapsed ? '-90' : '0'}deg);">▾</span>
        <div class="zone-list-dot${gDotFlash ? ' flashing' : ''}" data-group-dot="${g.id}"
          style="background:${gDotColour};opacity:${gDotOpacity};flex-shrink:0;width:8px;height:8px;border-radius:50%;"></div>
        <span style="flex:1;font-size:11px;font-weight:600;color:#999;letter-spacing:0.04em;">${escapeHtml(g.name || g.id)}</span>
        <span class="status-dd-state" style="opacity:0;user-select:none;">——</span>
        <button class="zone-eye-btn group-eye-btn" data-group-id="${g.id}"
          style="background:none;border:none;padding:0 2px;cursor:pointer;color:${allMembHidden ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.65)'};line-height:0;flex-shrink:0;"
        >${allMembHidden ? eyeClosed : eyeOpen}</button>
        <label class="zone-toggle-switch" style="flex-shrink:0;${!canArmDisarm() ? 'opacity:0.4;pointer-events:none;' : ''}">
          <input type="checkbox" class="group-armed-chk" data-group-id="${g.id}" ${allArmed ? "checked" : ""} ${!canArmDisarm() ? "disabled" : ""}>
          <span class="zone-toggle-track"></span>
        </label>
      </div>
      <div class="status-dd-group-members" data-group-id="${g.id}" style="${collapsed ? 'display:none;' : ''}">
        ${members.map(z => zoneRow(z, true)).join("") || `<div style="padding:4px 14px 4px 32px;font-size:11px;color:#444;">No members</div>`}
      </div>`;
  }

  function ungroupedSection(ungroupedZones) {
    const storageKey  = "ddGroup___ungrouped";
    const collapsed   = localStorage.getItem(storageKey) !== "expanded";
    const allArmed    = ungroupedZones.length > 0 && ungroupedZones.every(z => getZoneState(z) !== 'disabled');
    const allDisarmed = ungroupedZones.every(z => z.enabled === false || !masterEnabled);
    const anyTriggered = ungroupedZones.some(z => getZoneState(z) === "triggered");
    const someArmed   = !allArmed && !allDisarmed;
    const allHidn     = ungroupedZones.length > 0 && ungroupedZones.every(z => z.hidden);
    const dotColour   = allDisarmed ? "#888"
                      : someArmed   ? "#ff9500"
                      :               "#ff3b30";
    const dotOpacity  = allDisarmed ? 0.35 : 1;
    const dotFlash    = anyTriggered && !allDisarmed;
    return `
      <div class="status-dd-group-header ungrouped-header" data-group-id="__ungrouped" data-storage-key="${storageKey}">
        <span class="status-dd-chevron" style="font-size:9px;color:#555;width:10px;flex-shrink:0;transition:transform 0.2s;display:inline-block;transform:rotate(${collapsed ? '-90' : '0'}deg);">▾</span>
        <div class="zone-list-dot${dotFlash ? ' flashing' : ''}" data-group-dot="__ungrouped"
          style="background:${dotColour};opacity:${dotOpacity};flex-shrink:0;width:8px;height:8px;border-radius:50%;"></div>
        <span style="flex:1;font-size:11px;font-weight:600;color:#666;letter-spacing:0.04em;">Ungrouped</span>
        <span class="status-dd-state" style="opacity:0;user-select:none;">——</span>
        <button class="zone-eye-btn ungrouped-eye-btn"
          style="background:none;border:none;padding:0 2px;cursor:pointer;color:${allHidn ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.65)'};line-height:0;flex-shrink:0;"
        >${allHidn ? eyeClosed : eyeOpen}</button>
        <label class="zone-toggle-switch" style="flex-shrink:0;${!canArmDisarm() ? 'opacity:0.4;pointer-events:none;' : ''}">
          <input type="checkbox" class="ungrouped-armed-chk" ${allArmed ? "checked" : ""} ${!canArmDisarm() ? "disabled" : ""}>
          <span class="zone-toggle-track"></span>
        </label>
      </div>
      <div class="status-dd-group-members" data-group-id="__ungrouped" style="${collapsed ? 'display:none;' : ''}">
        ${ungroupedZones.map(z => zoneRow(z, true)).join("")}
      </div>`;
  }

  const groupedZoneIds = new Set(groups.flatMap(g => g.zone_ids || []));
  const ungroupedZones = zones
    .filter(z => !groupedZoneIds.has(z.id))
    .sort((a, b) => (a.name||a.id).localeCompare(b.name||b.id));
  const sortedGroups = [...groups].sort((a, b) => (a.name||"").localeCompare(b.name||""));
  const masterMon = getEffectiveMonitoringState();
  const masterStateText = masterMon.label.toLowerCase().replace(" ", "_");

  body.innerHTML = `
    <div class="status-dd-zones">
      <div class="status-dd-master">
        <span style="width:10px;flex-shrink:0;"></span>
        <div id="masterStateDot" class="zone-list-dot${masterMon.state === 'triggered' ? ' flashing' : ''}" style="background:${masterMon.colour};width:8px;height:8px;border-radius:50%;flex-shrink:0;opacity:${masterMon.state === 'disarmed' ? 0.85 : 1};"></div>
        <span style="flex:1;font-size:11px;font-weight:600;color:#aaa;">Master</span>
        <span id="masterStateLabel" class="status-dd-state" style="color:${masterMon.colour};opacity:0.85;">${masterStateText}</span>
        <button class="zone-eye-btn" id="masterEyeBtn"
          style="background:none;border:none;padding:0 2px;cursor:pointer;color:${allHidden ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.65)'};line-height:0;flex-shrink:0;"
        >${allHidden ? eyeClosed : eyeOpen}</button>
        <label class="zone-toggle-switch" style="flex-shrink:0;${!canArmDisarm() ? 'opacity:0.4;pointer-events:none;' : ''}">
          <input type="checkbox" id="masterToggleChk" ${masterEnabled ? "checked" : ""} ${!canArmDisarm() ? "disabled" : ""}>
          <span class="zone-toggle-track"></span>
        </label>
      </div>
      <div style="height:1px;background:rgba(255,255,255,0.06);margin:0 14px 4px;"></div>
      ${sortedGroups.map(g => groupSection(g)).join("")}
      ${ungroupedZones.length > 0 ? ungroupedSection(ungroupedZones) : ""}
      ${zones.length === 0 ? `<div class="status-dd-empty">No zones configured</div>` : ""}
    </div>
  `;

  // Master toggle
  document.getElementById("masterToggleChk")?.addEventListener("change", e => { if (canArmDisarm()) setMasterEnabled(e.target.checked); });

  // Master eye
  document.getElementById("masterEyeBtn")?.addEventListener("click", e => {
    e.stopPropagation();
    const anyVisible = zones.some(z => !z.hidden);
    zones.forEach(z => setZoneHidden(z.id, anyVisible));
  });

  // Group header collapse toggle + highlight on expand
  body.querySelectorAll(".status-dd-group-header").forEach(hdr => {
    hdr.addEventListener("click", e => {
      if (e.target.closest("button,input,label")) return;
      const gid = hdr.dataset.groupId;
      const key = hdr.dataset.storageKey;
      const membersEl = body.querySelector(`.status-dd-group-members[data-group-id="${gid}"]`);
      const chevron = hdr.querySelector(".status-dd-chevron");
      if (!membersEl) return;
      const wasCollapsed = membersEl.style.display === "none";
      membersEl.style.display = wasCollapsed ? "" : "none";
      if (chevron) chevron.style.transform = `rotate(${wasCollapsed ? "0" : "-90"}deg)`;
      localStorage.setItem(key, wasCollapsed ? "expanded" : "collapsed");
      // Highlight group on map when expanding (not collapsing), skip __ungrouped
      if (wasCollapsed && gid && gid !== "__ungrouped") {
        setGroupHighlightFromDropdown(gid);
      } else if (!wasCollapsed) {
        clearDropdownHighlight();
      }
    });
  });

  // Zone row click → highlight zone on map
  body.querySelectorAll(".status-dd-zone").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest("button,input,label")) return;
      const dot = row.querySelector(".zone-list-dot[data-zone-id]");
      if (!dot) return;
      const zid = dot.dataset.zoneId;
      if (zid) setHighlightFromDropdown(zid);
    });
  });

  // Group eye buttons
  body.querySelectorAll(".group-eye-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const gid = btn.dataset.groupId;
      const group = groups.find(g => g.id === gid);
      if (!group) return;
      const members = (group.zone_ids || []).map(id => zones.find(z => z.id === id)).filter(Boolean);
      const anyVisible = members.some(z => !z.hidden);
      members.forEach(z => setZoneHidden(z.id, anyVisible));
    });
  });

  // Group arm toggles
  body.querySelectorAll(".group-armed-chk").forEach(chk => {
    chk.addEventListener("change", e => { if (canArmDisarm()) setGroupArmed(e.target.dataset.groupId, e.target.checked); });
  });

  // Ungrouped eye toggle
  body.querySelector(".ungrouped-eye-btn")?.addEventListener("click", e => {
    e.stopPropagation();
    const groupedIds = new Set(groups.flatMap(g => g.zone_ids || []));
    const ung = zones.filter(z => !groupedIds.has(z.id));
    const anyVisible = ung.some(z => !z.hidden);
    ung.forEach(z => setZoneHidden(z.id, anyVisible));
  });

  // Ungrouped arm toggle
  body.querySelector(".ungrouped-armed-chk")?.addEventListener("change", e => {
    if (!canArmDisarm()) return;
    const groupedIds = new Set(groups.flatMap(g => g.zone_ids || []));
    const ung = zones.filter(z => !groupedIds.has(z.id));
    ung.forEach(z => setZoneEnabled(z.id, e.target.checked));
  });

  // Zone eye buttons
  body.querySelectorAll(".zone-eye-btn[data-zone-id]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const zone = zones.find(z => z.id === btn.dataset.zoneId);
      if (zone) setZoneHidden(btn.dataset.zoneId, !zone.hidden);
    });
  });

  // Zone arm toggles
  body.querySelectorAll(".zone-enabled-chk").forEach(chk => {
    chk.addEventListener("change", e => { if (canArmDisarm()) setZoneEnabled(e.target.dataset.zoneId, e.target.checked); });
  });
}

function bindStatusBar() {
  const bar      = document.getElementById("statusBar");
  const dropdown = document.getElementById("statusDropdown");
  if (!bar || !dropdown) return;

  bar.style.cursor = "pointer";
  bar.addEventListener("click", e => {
    e.stopPropagation();
    const isOpen = dropdown.style.display !== "none";
    dropdown.style.display = isOpen ? "none" : "block";
    if (!isOpen) {
      renderStatusDropdown();
      refreshMonitoringStatusBar();
    }
  });

  document.addEventListener("pointerdown", e => {
    if (!bar.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = "none";
    }
  });
}

/* ─── SEARCH UI BINDINGS ──────────────────────────────────── */
/* bindCommonSidebarButtons moved to modules/ow-sidebar.js */
// ── Floor switcher flyout ────────────────────────────────────
function bindFloorSwitcher() {
  const btn = document.getElementById("floorsBtn");
  if (!btn) return;

  // Show/hide button based on floor count
  function updateFloorBtn() {
    btn.style.display = floors.length > 1 ? "" : "none";
    // Update active state
    btn.classList.toggle("active", document.getElementById("floorFlyout") !== null);
  }
  updateFloorBtn();
  // Re-check when floors change
  window._updateFloorBtn = updateFloorBtn;

  btn.onclick = (e) => {
    e.stopPropagation();
    const existing = document.getElementById("floorFlyout");
    if (existing) { existing.remove(); btn.classList.remove("active"); return; }
    btn.classList.add("active");
    renderFloorFlyout();
  };
}

/* ─── FLOOR CONFIG PANEL moved to modules/ow-settings.js ───────────────────────── */
/* ─── HA AREA SYNC HELPERS moved to modules/ow-settings.js ───────────────────────── */
function renderFloorFlyout() {
  const existing = document.getElementById("floorFlyout");
  if (existing) existing.remove();

  const btn     = document.getElementById("floorsBtn");
  const sidebar = document.getElementById("sidebarEl");
  if (!btn || !sidebar) return;

  const flyout = document.createElement("div");
  flyout.id = "floorFlyout";
  flyout.style.cssText = `
    position:fixed;
    background:rgba(14,14,14,0.97);
    border:1px solid rgba(255,255,255,0.12);
    border-radius:12px;
    padding:8px;
    z-index:500;
    min-width:180px;
    box-shadow:0 8px 32px rgba(0,0,0,0.6);
    backdrop-filter:blur(10px);
  `;

  // Position next to the button
  const btnRect     = btn.getBoundingClientRect();
  const isLeft      = sidebar.classList.contains("left");
  flyout.style.top  = Math.round(btnRect.top) + "px";
  if (isLeft) {
    flyout.style.left = Math.round(btnRect.right + 8) + "px";
  } else {
    flyout.style.right = Math.round(window.innerWidth - btnRect.left + 8) + "px";
  }

  // Build floor items
  floors.forEach((f, fi) => {
    const floorZones  = zones.filter(z => z.floor_id === f.id || (!z.floor_id && fi === 0));
    const hasTriggered = floorZones.some(z => getZoneState(z) === "triggered");
    const allDisabled  = floorZones.length > 0 && floorZones.every(z => getZoneState(z) === "disabled");
    const hasFault     = floorZones.some(z => getZoneState(z) === "fault");
    const dotColour    = hasTriggered ? "#ff3b30" : hasFault ? "#ff9500" : allDisabled ? "#555" : "#32d74b";

    const row = document.createElement("button");
    const isActive = f.id === activeFloorId;
    row.style.cssText = `
      display:flex;align-items:center;gap:10px;width:100%;
      background:${isActive ? "rgba(0,150,255,0.15)" : "transparent"};
      border:1px solid ${isActive ? "rgba(0,150,255,0.35)" : "transparent"};
      border-radius:8px;padding:8px 10px;cursor:pointer;
      color:${isActive ? "#fff" : "rgba(255,255,255,0.7)"};
      font-size:13px;font-weight:${isActive ? "600" : "400"};
      text-align:left;transition:background 0.15s;
    `;
    row.onmouseover = () => { if (!isActive) row.style.background = "rgba(255,255,255,0.06)"; };
    row.onmouseout  = () => { if (!isActive) row.style.background = "transparent"; };

    row.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${dotColour};flex-shrink:0;display:inline-block;${hasTriggered ? "animation:pulse-dot 0.8s infinite;" : ""}"></span>
      <span style="flex:1;">${escapeHtml(f.name)}</span>
      <span style="font-size:10px;color:#555;">${floorZones.length} zone${floorZones.length !== 1 ? "s" : ""}</span>
    `;

    row.onclick = () => {
      setActiveFloor(f.id);
      if (editorMode) renderZonesEditorStable();
      flyout.remove();
      document.getElementById("floorsBtn")?.classList.remove("active");
    };

    flyout.appendChild(row);
  });

  document.body.appendChild(flyout);

  // Dismiss on outside click
  setTimeout(() => {
    document.addEventListener("pointerdown", function dismiss(e) {
      if (!flyout.contains(e.target) && e.target.id !== "floorsBtn") {
        flyout.remove();
        document.getElementById("floorsBtn")?.classList.remove("active");
        document.removeEventListener("pointerdown", dismiss);
      }
    });
  }, 0);
}

function bindSearchUI() {
  const searchPanelHtml = `
    <div class="search-panel" id="searchPanel" aria-hidden="true">
      <div class="search-header" id="searchTitlebar">
        <span class="search-title">Search</span>
        <button class="search-close" id="searchCloseBtn">✕</button>
      </div>
      <input type="text" class="search-input" id="searchInput" placeholder="Zone name or entity…" autocomplete="off">
      <div class="search-results" id="searchResults"></div>
      <div class="search-hint">Search zones and entities</div>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", searchPanelHtml);

  // Make search panel draggable (issue 9)
  const panel    = document.getElementById("searchPanel");
  const titlebar = document.getElementById("searchTitlebar");
  makeDraggable(panel, titlebar, "searchPanel");

  const searchBtn   = document.getElementById("searchBtn");

  if (searchBtn)   searchBtn.onclick   = () => setSearchOpen(!searchOpen);

  document.getElementById("searchCloseBtn").onclick = () => setSearchOpen(false);
  panel.addEventListener("pointerdown", e => e.stopPropagation());

  const input = document.getElementById("searchInput");
  input.oninput = () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(input.value), 80);
  };
  input.onkeydown = e => { if (e.key === "Escape") setSearchOpen(false); };

  document.addEventListener("pointerdown", e => {
    if (!searchOpen) return;
    if (panel.contains(e.target)) return;
    if (searchBtn && searchBtn.contains(e.target)) return;
    setSearchOpen(false);
  });
}


/* ─── ZONE EDITOR MAP INTERACTION HELPERS ─────────────────── */
function setZoneSvgInteractionState() {
  const enabled = editorMode ? 'all' : 'none';
  document.querySelectorAll('#zonesSvg, .fp-svg').forEach(svg => {
    svg.style.pointerEvents = enabled;
    if (!editorMode) svg.style.cursor = '';
  });
}

function clearZoneEditorSelection(render = true) {
  selectedZoneId = null;
  selectedGroupId = null;
  highlightedZoneId = null;
  highlightedUntil = 0;
  highlightedGroupId = null;
  highlightedGroupUntil = 0;
  isEditingPoints = false;
  activePinId = null;
  activePinType = null;
  placingPinType = null;
  placingEntityId = null;
  placingZoneId = null;
  _placingExistingPinId = null;
  document.querySelectorAll('#zonesSvg, .fp-svg').forEach(svg => { svg.style.cursor = ''; });
  if (render) {
    renderZones();
    renderZonesEditorStable();
  }
}

/* ─── ZONES BUTTON ACTIVE STATE ───────────────────────────── */
function bindZonesButton() {
  const zonesBtn = document.getElementById("zonesBtn");
  if (!zonesBtn) return;
  zonesBtn.onclick = () => {
    editorMode = !editorMode;
    isCreatingZone = false;
    isEditingPoints = false;
    currentNewZone = null;
    if (editorMode) {
      editorPosRestored = false; // allow position restore on open
      // Load HA registry for floor/area linking (non-blocking)
      if (!_haRegistry.loaded) loadHARegistry().then(() => renderZonesEditorStable());
    }
    zonesBtn.classList.toggle("active", editorMode);
    setZoneSvgInteractionState();
    renderZonesEditorStable();
    renderZones();
  };
}

/* ─── LIVE REFRESH ────────────────────────────────────────── */
// Zone flash interval is declared alongside renderZones above.
// This stub kept for clarity.
function startLiveRefresh() { /* flash driven by interval in renderZones block */ }

/* ─── INIT ────────────────────────────────────────────────── */
function initFloorplan() {
  const img     = document.getElementById("floorplanImage");
  const wrapper = document.getElementById("floorplanWrapper");
  const svg     = document.getElementById("zonesSvg");
  if (!img || !wrapper || !svg) return;

  function getPanelSize() {
    // Use the map panel dimensions — not the full viewport
    const panel = document.getElementById("mapPanel") || document.querySelector(".split-panel-map");
    if (panel && panel.offsetWidth > 0) {
      return { vw: panel.offsetWidth, vh: panel.offsetHeight };
    }
    return { vw: window.innerWidth, vh: window.innerHeight };
  }

  function onLoad() {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return;

    wrapper.style.width  = iw + "px";
    wrapper.style.height = ih + "px";
    svg.setAttribute("width",  iw);
    svg.setAttribute("height", ih);
    svg.setAttribute("viewBox", `0 0 ${iw} ${ih}`);

    if (!localStorage.getItem("zoomScale")) {
      const { vw, vh } = getPanelSize();
      zoom.scale = Math.min(vw / iw, vh / ih, 1);
      zoom.x = (vw - iw * zoom.scale) / 2;
      zoom.y = (vh - ih * zoom.scale) / 2;
      applyTransform();
    } else {
      loadZoom();
    }
    renderZones();
  }

  if (img.complete && img.naturalWidth) {
    onLoad();
  } else {
    img.onload = onLoad;
  }
}

async function init() {
  // Unified page — always load floorplan sidebar
  await loadModule("sidebarContainer", "sidebar.html");

  if (!document.getElementById("sidebarEl")) {
    console.warn('[HA-Overwatch] sidebarEl not found — check module paths');
  }

  await loadModule("expandBtnContainer", "expand-btn.html");
  await loadModule("statusContainer", "status.html");
  await loadModule("zonesEditorContainer", "zones-editor.html");

  bindZoomControls();
  bindZoomControlsMultiPanel(); // wraps zoom/reset for multi-panel mode
  bindPan();
  // initFloorplan() called after loadFloors() so the saved floor image is used
  bindZonesButton();
  bindStatusBar();
  refreshMonitoringStatusBar();
  applyStatusVisibility(); // apply hide prefs after DOM is ready
  bindSearchUI();

  bindSidebarToggle();
  bindCommonSidebarButtons();
  bindFloorSwitcher();
  initViewToggle();  // apply startup view mode, wire split handle drag
  // Hide zones editor button for non-admin (direct browser access)
  if (IS_DIRECT_MODE) {
    const zonesBtn = document.getElementById("zonesBtn");
    if (zonesBtn) zonesBtn.style.display = "none";
  }

  // Automations button — admin only (hidden in direct/public mode)
  const automationsBtn = document.getElementById("automationsBtn");
  if (automationsBtn) {
    if (IS_DIRECT_MODE) {
      automationsBtn.style.display = "none"; // hide completely in direct/public mode
    } else {
      automationsBtn.onclick = () => {
        if (window.OW_Automations?.toggle) {
          window.OW_Automations.toggle();
        }
      };
    }
  }

  
  // Alarms button — admin only (hidden in direct/public mode)
  const alarmsBtn = document.getElementById("alarmsBtn");
  if (alarmsBtn) {
    if (IS_DIRECT_MODE) {
      alarmsBtn.style.display = "none";
    } else {
      alarmsBtn.onclick = () => {
        if (window.OW_Alarms?.toggle) window.OW_Alarms.toggle();
      };
    }
  }

await loadZones();
  await loadGroups();
  await loadFloors();   // sets activeFloorId, loads correct floor image, calls initFloorplan
  await loadLights();
  await loadSirens();
  await loadCameraPins();
  await loadDoorPins();
  // Load low-res camera map from dedicated file
  try {
    const r = await fetch(apiPath("ow/cam-low-res-map") + "?v=" + Date.now());
    camLowResMap = r.ok ? await r.json() : {};
  } catch { try { camLowResMap = JSON.parse(uiConfig.cam_low_res_map || '{}'); } catch { camLowResMap = {}; } }
  if (window.setCamLowResMap) window.setCamLowResMap(camLowResMap);
  if (window.OW) window.OW.uiConfig = { ...uiConfig, cam_low_res_map: JSON.stringify(camLowResMap) };

  await loadArmAllowedIps();
  window._updateFloorBtn?.(); // show/hide floor switcher based on floor count
  bindZonesSvgEvents();
  applyFloorPanels();   // build single or multi-panel layout based on saved settings
  renderZonesEditorStable();
  renderZones();
  await loadConfig();

  await startServerHealthCheck();

  if (!haConnected) {
    if (IS_DIRECT_MODE) {
      startDirectModePoller(); // Direct Mode: poll /ow/states, no WebSocket
    } else {
      connectHA();             // Ingress Mode: WebSocket via proxy
    }
  }

  startLiveRefresh();
  logEvent("info", "HA-Overwatch initialised.", "system");

  subscribeHAEntities();

  // ── Expose shared state for cameras.js ─────────────────────
  // These are live references — cameras.js reads them directly.
  window.OW = {
    get zones()         { return zones; },
    get groups()        { return groups; },
    get floors()        { return floors; },
    get activeFloorId() { return activeFloorId; },
    activeFloor,
    setActiveFloor,
    get haStates()      { return haStates; },
    get haConnected()   { return haConnected; },
    get uiConfig()      { return uiConfig; },
    get masterEnabled() { return masterEnabled; },
    get isAddonMode()   { return isAddonMode; },
    isEntityTriggered,
    zoneTriggerEntities,
    zoneActiveTriggerEntity,
    isEntityGhosted,
    preserveEntitiesOnHAAreaAssignment,
    getZoneState,
    apiPath,
    logEvent,
    renderSettingsPanel,
    renderLogPanel,
    getHASocket: () => haSocket,
    // sendHA shared with cameras.js — MUST use this, not raw haSocket.send,
    // to avoid "Identifier values have to increase" errors (shared haMsgId counter)
    sendHA,
  };
  window.renderSettingsPanel      = renderSettingsPanel;
  window.renderLogPanel           = renderLogPanel;
  window.isAddonMode              = isAddonMode;
  window.bindSidebarToggle        = bindSidebarToggle;
  window.bindCommonSidebarButtons = bindCommonSidebarButtons;
  window.setViewMode              = setViewMode;   // so cameras.js view buttons work
}

/* ─── VIEW MODE (Map / Split / Cameras) ───────────────────── */
const VIEW_MODES = ['map', 'split', 'cameras'];

function getViewMode() {
  const saved = localStorage.getItem('ow_view_mode') || 'map';
  return VIEW_MODES.includes(saved) ? saved : 'map';
}

function setViewMode(mode) {
  localStorage.setItem('ow_view_mode', mode);
  // Remove all view classes, add the right one
  document.body.classList.remove('view-map', 'view-cameras', 'view-split');
  document.body.classList.add(`view-${mode}`);
  // Update toggle button states
  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  // Resize floorplan if switching to map or split
  if (mode === 'map' || mode === 'split') {
    setTimeout(() => fitFloorplanToPanel(), 50);
  }
  // Notify cameras.js
  if (window.camUpdate) window.camUpdate();
}

function initViewToggle() {
  // Restore split direction and apply startup view — no floating widget
  const savedDir = localStorage.getItem('ow_split_dir') || 'h';
  document.body.setAttribute('data-split-dir', savedDir);
  applySplitPct(parseFloat(localStorage.getItem('ow_split_pos') || '50'));

  // Apply startup view mode — default to split-h if nothing saved
  const startMode = localStorage.getItem('ow_view_mode') || 'split';
  setViewMode(startMode);

  // Split handle drag
  const handle = document.getElementById('splitHandle');
  if (handle) {
    let dragging = false, startPos = 0, startPct = 50;
    let rafPending = false;

    handle.addEventListener('pointerdown', e => {
      if (mapLocked) return; // locked
      dragging  = true;
      handle.classList.add('dragging');
      const isV = document.body.getAttribute('data-split-dir') === 'v';
      startPos  = isV ? e.clientY : e.clientX;
      startPct  = parseFloat(localStorage.getItem('ow_split_pos') || '50');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const root  = document.getElementById('splitRoot');
      if (!root) return;
      const isV   = document.body.getAttribute('data-split-dir') === 'v';
      const total = isV ? root.offsetHeight : root.offsetWidth;
      const delta = isV ? e.clientY - startPos : e.clientX - startPos;
      const pct   = Math.max(20, Math.min(80, startPct + (delta / total * 100)));
      applySplitPct(pct);
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; fitFloorplanToPanel(); });
      }
    });

    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      const root = document.getElementById('splitRoot');
      const pct  = parseFloat(root?.style.getPropertyValue('--split-pct') || '50');
      localStorage.setItem('ow_split_pos', pct.toFixed(1));
      fitFloorplanToPanel();
    });
  }
}
function fitFloorplanToPanel() {
  // Multi-panel mode — fit each panel independently
  if (getNumPanels() > 1 && document.querySelector('.floor-panel')) {
    const n = getNumPanels();
    for (let i = 0; i < n; i++) fitPanelToContainer(i);
    return;
  }
  const img = document.getElementById('floorplanImage');
  if (!img || !img.naturalWidth) return;
  const panel = document.getElementById('mapPanel');
  const vw = (panel && panel.offsetWidth  > 0) ? panel.offsetWidth  : window.innerWidth;
  const vh = (panel && panel.offsetHeight > 0) ? panel.offsetHeight : window.innerHeight;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  zoom.scale = Math.min(vw / iw, vh / ih, 1);
  zoom.x = (vw - iw * zoom.scale) / 2;
  zoom.y = (vh - ih * zoom.scale) / 2;
  applyTransform();
  renderZones();
}

function applySplitPct(pct) {
  const root = document.getElementById('splitRoot');
  if (root) root.style.setProperty('--split-pct', `${pct.toFixed(1)}%`);
}


window.addEventListener("DOMContentLoaded", init);
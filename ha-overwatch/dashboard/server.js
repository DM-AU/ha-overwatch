// HA-Overwatch 0.05.35.30-turn-off-editor-filter-and-stale-zone-target-prune: paired Turn OFF automation hidden by metadata/id only; stale zone-scoped target entities pruned during generation.
/* ============================================================
 * HA-Overwatch — server.js
 *
 * Lightweight Node.js server:
 *  - Serves static files (app.js, style.css, modules/, etc.)
 *  - Provides API endpoints for config/zone file management
 *  - Provides API endpoints for HA entity (input_boolean) management
 *
 * Usage:
 *   Standalone:  node server.js [port]
 *   HA Add-on:   node server.js 8099 /config/ha-overwatch
 *
 * Arguments:
 *   argv[2] = port         (default 8099)
 *   argv[3] = data dir     (default: same as script dir)
 *             Static app files always served from script dir.
 *             Config, zones, and uploads read/written from data dir.
 * ============================================================ */

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const net     = require("net");
const { URL } = require("url");

const PORT     = parseInt(process.argv[2] || process.env.PORT || "8099", 10);
const APP_DIR  = __dirname;                          // static files (app.js, style.css, …)
const DATA_DIR = process.argv[3] || __dirname;       // persistent data (config, zones, img)
const SERVER_BUILD_ID = Date.now();                  // unique per server start — triggers client reload
let dataVersion = Date.now();                        // bumped on every data write — triggers client data refresh
function bumpDataVersion() { dataVersion = Date.now(); }

/* ─── MIME TYPES ──────────────────────────────────────────── */
const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml":  "text/yaml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
};

/* ─── HELPERS ─────────────────────────────────────────────── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function err(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

// Safely resolve a path under DATA_DIR (prevents path traversal)
function safeDataPath(rel) {
  const abs = path.resolve(DATA_DIR, rel);
  if (!abs.startsWith(path.resolve(DATA_DIR))) throw new Error("Path traversal denied");
  return abs;
}

/* ─── CONFIG ──────────────────────────────────────────────── */
function loadConfig() {
  try {
    const text = fs.readFileSync(path.join(DATA_DIR, "config", "ui.yaml"), "utf8");
    const cfg  = {};
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim();
      if (!key || key.includes(" ")) continue;
      let v = line.slice(colonIdx + 1).trim().replace(/\s+#.*$/, "");
      v = v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      cfg[key] = v;
    }
    return cfg;
  } catch {
    return {};
  }
}

// Returns HA connection config — prefers supervisor injection when running as add-on
function getHAConfig(userCfg) {
  const supervisorToken = process.env.SUPERVISOR_TOKEN;
  if (supervisorToken) {
    // Running as HA add-on — use internal supervisor API (no user config needed)
    return {
      ha_url:   "http://supervisor/core",
      ha_token: supervisorToken,
      isAddon:  true,
    };
  }
  // Standalone mode — use values from ui.yaml
  return {
    ha_url:   userCfg.ha_url   || "",
    ha_token: userCfg.ha_token || "",
    isAddon:  false,
  };
}

/* ─── ZONES ───────────────────────────────────────────────── */
function loadZones() {
  try {
    const idxPath = path.join(DATA_DIR, "config", "zones", "index.json");
    const index   = JSON.parse(fs.readFileSync(idxPath, "utf8"));
    return index
      .filter(f => !f.startsWith("group_") && f.endsWith(".yaml"))
      .map(filename => {
        try {
          const text = fs.readFileSync(path.join(DATA_DIR, "config", "zones", filename), "utf8");
          return parseZoneYaml(text);
        } catch { return null; }
      }).filter(z => z && z.id && !z.id.startsWith("grp_"));
  } catch { return []; }
}

function parseZoneYaml(text) {
  const z = { enabled: true, sensors: [], cameras: [], lights: [], sirens: [], ha_excluded_entities: [] };
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // List section headers
    if (line === "sensors:") { section = "sensors"; continue; }
    if (line === "cameras:") { section = "cameras"; continue; }
    if (line === "lights:")  { section = "lights";  continue; }
    if (line === "sirens:")  { section = "sirens";  continue; }
    if (line === "ha_excluded_entities:") { section = "ha_excluded_entities"; continue; }
    if (line === "points:")  { section = "points";  continue; }
    // List items
    if (line.startsWith("- ") && section) {
      const val = line.slice(2).trim();
      if (section === "sensors") z.sensors.push(val);
      else if (section === "cameras") z.cameras.push(val);
      else if (section === "lights")  z.lights.push(val);
      else if (section === "sirens")  z.sirens.push(val);
      else if (section === "ha_excluded_entities") z.ha_excluded_entities.push(val);
      continue;
    }
    // Key: value pairs reset the section
    if (!line.includes(":")) continue;
    section = "";
    const colonIdx = line.indexOf(":");
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim()
                    .replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if      (key === "id")       z.id       = val;
    else if (key === "name")     z.name     = val;
    else if (key === "enabled")  z.enabled  = val !== "false";
    else if (key === "floor_id") z.floor_id = val;
  }
  const excluded = new Set((z.ha_excluded_entities || []).map(String));
  z.sensors = (z.sensors || []).filter(entityId => !excluded.has(String(entityId)));
  z.cameras = (z.cameras || []).filter(entityId => !excluded.has(String(entityId)));
  z.lights  = (z.lights  || []).filter(entityId => !excluded.has(String(entityId)));
  z.sirens  = (z.sirens  || []).filter(entityId => !excluded.has(String(entityId)));
  return z;
}

/* ─── LIGHTS & SIRENS (MAP PINS) ──────────────────────────── */
// Stored as config/lights.json and config/sirens.json
// Each pin: { id, name, entity_id, floor_id, x, y, direction }
function pinsFile(type) {
  return path.join(DATA_DIR, "config", `${type}.json`);
}
function loadPins(type) {
  try { return JSON.parse(fs.readFileSync(pinsFile(type), "utf8")); }
  catch { return []; }
}
function savePin(type, pin) {
  const pins = loadPins(type);
  const idx  = pins.findIndex(p => p.id === pin.id);
  if (idx >= 0) pins[idx] = pin; else pins.push(pin);
  fs.mkdirSync(path.dirname(pinsFile(type)), { recursive: true });
  fs.writeFileSync(pinsFile(type), JSON.stringify(pins, null, 2), "utf8");
  bumpDataVersion();
}
function deletePin(type, id) {
  const pins = loadPins(type).filter(p => p.id !== id);
  fs.writeFileSync(pinsFile(type), JSON.stringify(pins, null, 2), "utf8");
  bumpDataVersion();
}


const FLOORS_FILE = () => path.join(DATA_DIR, "config", "floors.json");

function loadFloors() {
  try {
    return JSON.parse(fs.readFileSync(FLOORS_FILE(), "utf8"));
  } catch {
    // No floors file yet — return a single default floor using the existing floorplan
    const cfg = loadConfig();
    return [{ id: "floor_default", name: "Ground Floor", floorplan: cfg.floorplan || "img/floorplan.png" }];
  }
}

function saveFloors(floors) {
  fs.mkdirSync(path.dirname(FLOORS_FILE()), { recursive: true });
  fs.writeFileSync(FLOORS_FILE(), JSON.stringify(floors, null, 2), "utf8");
  bumpDataVersion();
}

// ── Alarms (config/alarms.json) ─────────────────────────────
const ALARMS_FILE = () => path.join(DATA_DIR, "config", "alarms.json");
function defaultAlarms() {
  return [
    { id: "away", name: "Away", role: "away", builtin: true, locked: true, default_armed: true,
      members: { floor_ids: ["*"], group_ids: ["*"], zone_ids: ["*"] } },
    { id: "home", name: "Home", role: "home", builtin: true, locked: false, default_armed: false,
      members: { floor_ids: [], group_ids: [], zone_ids: [] } },
  ];
}
function loadAlarms() {
  try {
    const txt = fs.readFileSync(ALARMS_FILE(), "utf8");
    const data = JSON.parse(txt);
    const alarms = Array.isArray(data) ? data : (data.alarms || []);
    return alarms.length ? alarms : defaultAlarms();
  } catch {
    return defaultAlarms();
  }
}
function saveAlarms(alarms) {
  const p = ALARMS_FILE();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.isArray(alarms) ? alarms : [], null, 2), "utf8");
  bumpDataVersion();
}

// ── Ghost-safe triggered-state and alarm effective-state helpers ─────────
function isTriggeredStateValue(state) {
  return ["on", "open", "opening", "detected", "home", "triggered", "motion", "unlocked"].includes(String(state || "").toLowerCase());
}

function buildTriggeredSnapshot() {
  const out = {};
  for (const zone of loadZones()) {
    const slug = nameSlug(zone.name) || zone.id;
    out[slug] = (zone.sensors || []).some(entityId => {
      const st = serverHaStates[entityId];
      return st ? isTriggeredStateValue(st.state) : false;
    });
  }
  return out;
}

function buildTriggeredDetailSnapshot() {
  const out = {};
  for (const zone of loadZones()) {
    const slug = nameSlug(zone.name) || zone.id;
    const sensors = (zone.sensors || []).map(entityId => {
      const st = serverHaStates[entityId];
      return {
        entity_id: entityId,
        state: st ? st.state : "unknown",
        triggered: st ? isTriggeredStateValue(st.state) : false,
        last_changed: st ? st.last_changed : null,
        last_updated: st ? st.last_updated : null,
      };
    });
    out[slug] = {
      zone_id: zone.id,
      zone_name: zone.name || zone.id,
      triggered: sensors.some(s => s.triggered),
      sensors,
    };
  }
  return out;
}

function stateEntityOnAny(entityIds, fallback = false) {
  for (const entityId of entityIds || []) {
    const st = serverHaStates[entityId];
    if (!st || st.state == null) continue;
    const s = String(st.state).toLowerCase();
    return !(s === "off" || s === "false" || s === "0" || s === "unavailable" || s === "unknown");
  }
  return !!fallback;
}

function canonicalIds(obj) {
  const slug = nameSlug(obj?.name) || obj?.id;
  return new Set([obj?.id, obj?.raw_id, slug].filter(Boolean).map(String));
}

function setHasAny(set, values) {
  for (const v of values || []) if (set.has(String(v))) return true;
  return false;
}

function alarmSwitchEntityIds(alarm) {
  // Frontend ow-alarms.js uses alarm name slug for the HA switch entity.
  // Prioritise that canonical entity first so stale raw-id entities cannot override it.
  const ids = [];
  const add = entityId => { if (entityId && !ids.includes(entityId)) ids.push(entityId); };
  const slug = nameSlug(alarm?.name) || alarm?.id;
  add(slug ? `switch.overwatch_alarm_${slug}` : null);
  add(alarm?.id ? `switch.overwatch_alarm_${alarm.id}` : null);
  add(alarm?.raw_id ? `switch.overwatch_alarm_${alarm.raw_id}` : null);
  return ids;
}

function zoneSwitchEntityIds(zone) {
  // Frontend app.js uses zone name slug for the HA switch entity.
  // Prioritise that canonical entity first so stale raw-id entities cannot mask manual disarm.
  const ids = [];
  const add = entityId => { if (entityId && !ids.includes(entityId)) ids.push(entityId); };
  const slug = nameSlug(zone?.name) || zone?.id;
  add(slug ? `switch.overwatch_zone_${slug}` : null);
  add(zone?.id ? `switch.overwatch_zone_${zone.id}` : null);
  add(zone?.raw_id ? `switch.overwatch_zone_${zone.raw_id}` : null);
  return ids;
}

function zonesForFloorId(zones, floors, floorId) {
  const isFirstFloor = floors.length === 0 || floors[0]?.id === floorId;
  return zones.filter(z => z.floor_id === floorId || (!z.floor_id && isFirstFloor));
}

function alarmSelectedZones(alarm, zones, groups, floors) {
  const members = alarm.members || {};
  const zoneIds = members.zone_ids || [];
  const groupIds = members.group_ids || [];
  const floorIds = members.floor_ids || [];
  const includeAllZones = zoneIds.includes("*") || groupIds.includes("*") || floorIds.includes("*");
  const selected = new Map();
  const addZone = zone => { if (zone && zone.id) selected.set(zone.id, zone); };

  if (includeAllZones) {
    zones.forEach(addZone);
    return [...selected.values()];
  }

  zones.forEach(zone => {
    if (setHasAny(canonicalIds(zone), zoneIds)) addZone(zone);
  });

  groups.forEach(group => {
    if (!setHasAny(canonicalIds(group), groupIds)) return;
    (group.zone_ids || []).forEach(zid => {
      const zone = zones.find(z => z.id === zid || canonicalIds(z).has(String(zid)));
      addZone(zone);
    });
  });

  floors.forEach(floor => {
    if (!setHasAny(canonicalIds(floor), floorIds)) return;
    zonesForFloorId(zones, floors, floor.id).forEach(addZone);
  });

  return [...selected.values()];
}

function buildAlarmEffectiveState() {
  const zones = loadZones();
  const groups = loadGroups();
  const floors = loadFloors();
  const alarms = loadAlarms();

  const selectedByAlarm = new Map();
  const armedByAlarm = new Map();

  alarms.forEach(alarm => {
    selectedByAlarm.set(alarm.id, alarmSelectedZones(alarm, zones, groups, floors));
    armedByAlarm.set(alarm.id, stateEntityOnAny(alarmSwitchEntityIds(alarm), alarm.default_armed === true));
  });

  return {
    alarms: alarms.map(alarm => {
      const selectedZones = selectedByAlarm.get(alarm.id) || [];
      const isArmed = armedByAlarm.get(alarm.id) === true;
      const suppressedZoneIds = new Set();
      const suppressionReasons = [];

      if (isArmed) {
        selectedZones.forEach(zone => {
          const zoneArmed = stateEntityOnAny(zoneSwitchEntityIds(zone), zone.enabled !== false);
          if (!zoneArmed) {
            suppressedZoneIds.add(zone.id);
            suppressionReasons.push({
              zone_id: nameSlug(zone.name) || zone.id,
              zone_raw_id: zone.id,
              zone_name: zone.name || zone.id,
              reason: "manual_zone_disarm",
              source: zoneSwitchEntityIds(zone)[0],
            });
          }
        });

        alarms.forEach(other => {
          if (other.id === alarm.id || armedByAlarm.get(other.id) === true) return;
          const otherSelectedIds = new Set((selectedByAlarm.get(other.id) || []).map(z => z.id));
          selectedZones.forEach(zone => {
            if (!otherSelectedIds.has(zone.id) || suppressedZoneIds.has(zone.id)) return;
            suppressedZoneIds.add(zone.id);
            suppressionReasons.push({
              zone_id: nameSlug(zone.name) || zone.id,
              zone_raw_id: zone.id,
              zone_name: zone.name || zone.id,
              reason: "overlap_disarmed_alarm",
              source_alarm: nameSlug(other.name) || other.id,
              source_alarm_raw_id: other.id,
              source_alarm_name: other.name || other.id,
            });
          });
        });
      }

      const selectedCount = selectedZones.length;
      const suppressedCount = isArmed ? suppressedZoneIds.size : 0;
      const activeCount = isArmed ? Math.max(0, selectedCount - suppressedCount) : 0;
      const state = !isArmed ? "disarmed" : (suppressedCount > 0 ? "armed_partial" : "armed_full");

      return {
        id: nameSlug(alarm.name) || alarm.id,
        raw_id: alarm.id,
        name: alarm.name || alarm.id,
        role: alarm.role || null,
        builtin: !!alarm.builtin,
        state,
        selected_zones: selectedCount,
        active_zones: activeCount,
        suppressed_zones: suppressedCount,
        suppression_reasons: suppressionReasons,
      };
    }),
    generated_at: new Date().toISOString(),
  };
}


// ── Alarm triggered-state evaluation (0.05.18) ─────────────────────────────
const ALARM_TRIGGER_FILTER_KEYS = ["person","animal","motion","door","window","vehicle","smoke","gas"];

function normaliseAlarmTriggerFilters(filters) {
  const f = (filters && typeof filters === "object") ? filters : {};
  const out = {};
  ALARM_TRIGGER_FILTER_KEYS.forEach(k => {
    const v = f[k];
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = ["true", "1", "on", "yes"].includes(v.toLowerCase());
    else out[k] = true;
  });
  return out;
}

function classifyAlarmTriggerType(entityId, st) {
  const id = String(entityId || "").toLowerCase();
  const friendly = String(st?.attributes?.friendly_name || "").toLowerCase();
  const dc = String(st?.attributes?.device_class || "").toLowerCase();
  const combined = `${id} ${friendly}`;

  if (id.startsWith("person.")) return "person";
  if (["door", "garage_door", "gate", "opening"].includes(dc)) return "door";
  if (dc === "window") return "window";
  if (dc === "smoke") return "smoke";
  if (["gas", "carbon_monoxide", "co"].includes(dc)) return "gas";
  if (["motion", "occupancy", "presence"].includes(dc)) return "motion";

  if (combined.includes("vehicle") || combined.includes("car")) return "vehicle";
  if (combined.includes("person") || combined.includes("human")) return "person";
  if (combined.includes("animal") || combined.includes("dog") || combined.includes("cat")) return "animal";
  if (combined.includes("door")) return "door";
  if (combined.includes("window")) return "window";
  if (combined.includes("smoke")) return "smoke";
  if (combined.includes("gas") || combined.includes("carbon monoxide") || combined.includes("co ")) return "gas";
  if (combined.includes("motion") || combined.includes("occupancy") || combined.includes("presence")) return "motion";

  return null;
}

function zoneAlarmTriggerMatches(zone, allowedTypes) {
  const matches = [];
  for (const entityId of (zone?.sensors || [])) {
    const st = serverHaStates[entityId];
    if (!st || !isTriggeredStateValue(st.state)) continue;
    const type = classifyAlarmTriggerType(entityId, st);
    if (!type) continue;
    if (allowedTypes && allowedTypes.size && !allowedTypes.has(type)) continue;
    matches.push({
      entity_id: entityId,
      type,
      state: st.state,
      name: st?.attributes?.friendly_name || null,
      last_changed: st?.last_changed || null,
      last_updated: st?.last_updated || null,
    });
  }
  return matches;
}

function buildAlarmTriggeredState() {
  const zones = loadZones();
  const groups = loadGroups();
  const floors = loadFloors();
  const alarms = loadAlarms();

  const selectedByAlarm = new Map();
  const armedByAlarm = new Map();

  alarms.forEach(alarm => {
    selectedByAlarm.set(alarm.id, alarmSelectedZones(alarm, zones, groups, floors));
    armedByAlarm.set(alarm.id, stateEntityOnAny(alarmSwitchEntityIds(alarm), alarm.default_armed === true));
  });

  const selectedIdsByAlarm = new Map();
  alarms.forEach(alarm => selectedIdsByAlarm.set(alarm.id, new Set((selectedByAlarm.get(alarm.id) || []).map(z => z.id))));

  return {
    alarms: alarms.map(alarm => {
      const selectedZones = selectedByAlarm.get(alarm.id) || [];
      const isArmed = armedByAlarm.get(alarm.id) === true;
      const filters = normaliseAlarmTriggerFilters(alarm.trigger_filters || alarm.filters || null);
      const enabledTypes = new Set(ALARM_TRIGGER_FILTER_KEYS.filter(k => filters[k]));
      const warn_no_filters = enabledTypes.size === 0;

      const suppressedZoneIds = new Set();
      if (isArmed) {
        selectedZones.forEach(zone => {
          const zoneArmed = stateEntityOnAny(zoneSwitchEntityIds(zone), zone.enabled !== false);
          if (!zoneArmed) suppressedZoneIds.add(zone.id);
        });
        alarms.forEach(other => {
          if (other.id === alarm.id || armedByAlarm.get(other.id) === true) return;
          const otherSelectedIds = selectedIdsByAlarm.get(other.id) || new Set();
          selectedZones.forEach(zone => { if (otherSelectedIds.has(zone.id)) suppressedZoneIds.add(zone.id); });
        });
      }

      const zonesToCheck = isArmed ? selectedZones.filter(z => !suppressedZoneIds.has(z.id)) : selectedZones;
      let triggered_armed = false;
      let triggered_disarmed = false;
      const triggered_zones = [];

      if (!warn_no_filters) {
        for (const zone of zonesToCheck) {
          const matches = zoneAlarmTriggerMatches(zone, enabledTypes);
          if (!matches.length) continue;
          triggered_zones.push({
            zone_id: nameSlug(zone.name) || zone.id,
            zone_raw_id: zone.id,
            zone_name: zone.name || zone.id,
            matches,
          });
          if (isArmed) triggered_armed = true;
          else triggered_disarmed = true;
        }
      }

      const state = triggered_armed ? "triggered_armed" : (triggered_disarmed ? "triggered_disarmed" : "clear");
      return {
        id: nameSlug(alarm.name) || alarm.id,
        raw_id: alarm.id,
        name: alarm.name || alarm.id,
        role: alarm.role || null,
        builtin: !!alarm.builtin,
        warn_no_filters,
        filters,
        triggered_armed,
        triggered_disarmed,
        state,
        triggered_zones,
      };
    }),
    generated_at: new Date().toISOString(),
  };
}


/* ─── GROUPS ──────────────────────────────────────────────── */
function loadGroups() {
  try {
    const idxPath = path.join(DATA_DIR, "config", "zones", "groups_index.json");
    const index   = JSON.parse(fs.readFileSync(idxPath, "utf8"));
    return index.map(filename => {
      try {
        const text = fs.readFileSync(path.join(DATA_DIR, "config", "zones", filename), "utf8");
        return parseGroupYaml(text);
      } catch { return null; }
    }).filter(g => g && g.id);
  } catch { return []; }
}

function parseGroupYaml(text) {
  const g = { zone_ids: [] };
  let section = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "zone_ids:") { section = "zone_ids"; continue; }
    if (line.startsWith("- ") && section === "zone_ids") {
      g.zone_ids.push(line.slice(2).trim()); continue;
    }
    section = null;
    if (!line.includes(":")) continue;
    const colonIdx = line.indexOf(":");
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if      (key === "id")      g.id       = val;
    else if (key === "name")    g.name     = val;
    else if (key === "enabled") g.enabled  = val !== "false";
    else if (key === "colorHex") g.colorHex = val;
  }
  return g;
}

// Update the enabled: field in a zone's YAML file so the dashboard sees the change
/* ─── NAME SLUG ────────────────────────────────────────────── */
// "Asphalt Right" -> "asphalt_right" — used for predictable entity IDs
// Must match nameSlug() in /ow/zones endpoint and app.js
function nameSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Zone triggered states — written by startHAListener, read by /ow/triggered endpoint
// HA registry cache — populated by startHAListener on auth_ok
const haRegistry = { floors: [], areas: [], devices: [], entities: [], loaded: false, refreshing: false, refresh_id: 0, requested_at: null, completed_at: null };
const haRegistryCallbacks = {}; // msgId -> type being fetched
let haMsgId = 1; // module-scoped so IDs are unique across restarts
let haListenerSend = null; // set by startHAListener once connected — used to trigger re-fetches

// Trigger a fresh fetch of all registry data from HA
function refetchHARegistry() {
  if (!haListenerSend) return false;
  haRegistry.loaded = false;
  haRegistry.refreshing = true;
  haRegistry.refresh_id = (haRegistry.refresh_id || 0) + 1;
  haRegistry.requested_at = new Date().toISOString();
  haRegistry.completed_at = null;
  haRegistry._got_floors = false; haRegistry._got_areas = false;
  haRegistry._got_devices = false; haRegistry._got_entities = false;
  haRegistry.floors = []; haRegistry.areas = []; haRegistry.devices = []; haRegistry.entities = [];
  Object.keys(haRegistryCallbacks).forEach(k => delete haRegistryCallbacks[k]);

  const requestRegistry = (kind, type) => {
    const msgId = haListenerSend({ type });
    if (msgId == null) return false;
    haRegistryCallbacks[msgId] = kind;
    return true;
  };

  const ok = [
    requestRegistry('floors',   'config/floor_registry/list'),
    requestRegistry('areas',    'config/area_registry/list'),
    requestRegistry('devices',  'config/device_registry/list'),
    requestRegistry('entities', 'config/entity_registry/list'),
  ].every(Boolean);

  if (!ok) {
    haRegistry.refreshing = false;
    haRegistry.loaded = false;
  }
  return ok;
}

function waitForHARegistryRefresh(refreshId, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      const done = haRegistry.loaded && !haRegistry.refreshing && haRegistry.refresh_id >= refreshId;
      if (done) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Full HA entity state cache — written by startHAListener, read by /ow/states endpoint
// Keyed by entity_id, value is the full HA state object {entity_id, state, attributes, ...}
const serverHaStates = {};

/* ── Camera snapshot cache ───────────────────────────────────────
 * Shared across all browser clients — 5 browsers requesting the same
 * camera snapshot within the TTL window get one upstream HA request.
 * ────────────────────────────────────────────────────────────── */
const SNAPSHOT_CACHE_TTL_MS   = 1000;   // snapshot-grid-v1.3: per-camera upstream min interval
const SNAPSHOT_STALE_TTL_MS   = 45000;  // v1.3: longer stale fallback for slow 180 cameras
const CAMERA_429_BACKOFF_MS   = 8000;   // v1.3: short 429 backoff; stale served during backoff
const CAMERA_ERROR_BACKOFF_MS = 3000;   // v1.3: transient error backoff

const cameraSnapshotCache   = new Map(); // entityId → { buf, contentType, fetchedAt }
const cameraSnapshotInflight = new Map(); // entityId → Promise<void>
const cameraBackoff         = new Map(); // entityId → { until, reason, lastStatus }

const SNAPSHOT_MAX_BYTES = 12 * 1024 * 1024; // v1.3: Reolink 180 snapshots can be >5MB
const SNAPSHOT_GLOBAL_CONCURRENCY = 3;
let snapshotActiveFetches = 0;
const snapshotQueue = [];

function snapshotCorsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    ...extra,
  };
}

function sendSnapshotPlaceholder(res, entity, status = 503, reason = "snapshot_unavailable") {
  const safe = String(entity || 'camera').replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="506" viewBox="0 0 900 506">
    <rect width="900" height="506" fill="#101010"/>
    <rect x="36" y="36" width="828" height="434" rx="18" fill="#151515" stroke="#333" stroke-width="2"/>
    <text x="450" y="214" fill="#aaa" font-family="Arial, sans-serif" font-size="28" text-anchor="middle">Snapshot temporarily unavailable</text>
    <text x="450" y="258" fill="#666" font-family="Arial, sans-serif" font-size="16" text-anchor="middle">${safe}</text>
    <text x="450" y="300" fill="#555" font-family="Arial, sans-serif" font-size="14" text-anchor="middle">${reason}</text>
  </svg>`;
  const buf = Buffer.from(svg, 'utf8');
  res.writeHead(status, snapshotCorsHeaders({
    "Content-Type": "image/svg+xml;charset=utf-8",
    "Content-Length": buf.length,
    "X-OW-Snapshot-Cache": reason,
  }));
  res.end(buf);
}

function sendSnapshotBuffer(res, entity, entry, cacheState) {
  res.writeHead(200, snapshotCorsHeaders({
    "Content-Type": entry.contentType || "image/jpeg",
    "Content-Length": entry.buf.length,
    "X-OW-Snapshot-Cache": cacheState,
    "X-OW-Snapshot-Age-Ms": String(Date.now() - entry.fetchedAt),
  }));
  res.end(entry.buf);
}

function scheduleSnapshotJob(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      snapshotActiveFetches++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        snapshotActiveFetches--;
        const next = snapshotQueue.shift();
        if (next) next();
      });
    };
    if (snapshotActiveFetches < SNAPSHOT_GLOBAL_CONCURRENCY) run();
    else snapshotQueue.push(run);
  });
}

function fetchSnapshotFromHA(entity) {
  const cfg = getHAConfig(loadConfig());
  if (!cfg.ha_url || !cfg.ha_token) return Promise.reject(new Error("HA not configured"));
  const userCfg = loadConfig();
  const userToken = userCfg.ha_token || "";
  const proxyHaUrl = (userToken ? userCfg.ha_url : cfg.ha_url || "").replace(/\/$/, "");
  const authToken = userToken || cfg.ha_token;
  let parsed;
  try { parsed = new URL(proxyHaUrl); } catch { return Promise.reject(new Error("Invalid HA URL")); }
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;
  const endpoint = `/api/camera_proxy/${entity}`;
  return scheduleSnapshotJob(() => new Promise((resolve, reject) => {
    const haReq = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: endpoint,
      method: "GET",
      headers: { "Authorization": `Bearer ${authToken}`, "Accept": "image/jpeg,image/*,*/*" },
    }, haRes => {
      const status = haRes.statusCode || 0;
      const chunks = [];
      let total = 0;
      haRes.on("data", c => {
        total += c.length;
        if (total > SNAPSHOT_MAX_BYTES) { haReq.destroy(new Error("snapshot too large")); return; }
        chunks.push(c);
      });
      haRes.on("end", () => {
        if (status === 429) { const e = new Error("snapshot 429"); e.statusCode = 429; reject(e); return; }
        if (status < 200 || status >= 300) { const e = new Error(`snapshot upstream ${status}`); e.statusCode = status; reject(e); return; }
        const buf = Buffer.concat(chunks);
        if (!buf.length) { reject(new Error("empty snapshot")); return; }
        resolve({ buf, contentType: haRes.headers["content-type"] || "image/jpeg", fetchedAt: Date.now() });
      });
    });
    haReq.setTimeout(6000, () => haReq.destroy(new Error("snapshot timeout")));
    haReq.on("error", reject);
    haReq.end();
  }));
}

function refreshSnapshotSingleFlight(entity) {
  if (cameraSnapshotInflight.has(entity)) return cameraSnapshotInflight.get(entity);
  const p = fetchSnapshotFromHA(entity)
    .then(entry => { cameraSnapshotCache.set(entity, entry); cameraBackoff.delete(entity); return entry; })
    .catch(e => {
      const status = e.statusCode || 0;
      const backoffMs = status === 429 ? CAMERA_429_BACKOFF_MS : CAMERA_ERROR_BACKOFF_MS;
      cameraBackoff.set(entity, { until: Date.now() + backoffMs, reason: e.message, lastStatus: status });
      throw e;
    })
    .finally(() => cameraSnapshotInflight.delete(entity));
  cameraSnapshotInflight.set(entity, p);
  return p;
}


// Declared at module scope so /ow/triggered works before startHAListener connects
const globalTriggeredZones = {};

/* ── Parse HA automations.yaml without a YAML library ─────────
 * HA's automations.yaml is a YAML list of objects. We need to
 * extract enough fields to identify and round-trip OW automations:
 * id, alias, description, triggers/trigger, conditions/condition,
 * actions/action, mode, state.
 * We use JSON.parse on the description field which is stored as a
 * JSON string inside the YAML.
 * Rather than writing a full YAML parser, we use the fact that HA
 * writes automations.yaml in a predictable format when using the
 * config flow, and we can safely use a line-by-line state machine
 * for the fields we care about. For the full structure we rely on
 * the REST API to provide the parsed version when individual
 * automations are fetched by ID.
 *
 * Returns array of {id, alias, description, state, _raw_yaml}
 * The _raw_yaml is the per-automation YAML block for later parsing.
 * ──────────────────────────────────────────────────────────────── */
function parseAutomationsYaml(yamlText) {
  const results = [];
  // Split into individual automation blocks — each starts with "- " or "- id:"
  // at column 0 (list items at root level)
  const lines = yamlText.split("\n");
  let currentBlock = [];
  let currentObj = {};

  function commitBlock() {
    if (!currentBlock.length) return;
    const blockText = currentBlock.join("\n");
    // Extract simple scalar fields via regex
    const getId    = blockText.match(/^(?:\s*-\s+)?id:\s*['""]?([^\s'""\n]+)['""]?/m);
    const getAlias = blockText.match(/^(?:\s+)?alias:\s*(.+)/m);
    const getDesc  = blockText.match(/^(?:\s+)?description:\s*(.+)/m);
    const getMode  = blockText.match(/^(?:\s+)?mode:\s*(.+)/m);
    const getState = blockText.match(/^(?:\s+)?state:\s*(.+)/m);
    // Extract ow_id/ow_name from variables block (new metadata format)
    const getVarOwId   = blockText.match(/^\s+ow_id:\s*(.+)/m);
    const getVarOwName = blockText.match(/^\s+ow_name:\s*(.+)/m);

    function unquote(s) {
      if (!s) return "";
      s = s.trim();
      if ((s.startsWith("'") && s.endsWith("'")) ||
          (s.startsWith('"') && s.endsWith('"'))) {
        return s.slice(1,-1);
      }
      return s;
    }

    const obj = {
      id:          getId   ? unquote(getId[1])    : "",
      alias:       getAlias? unquote(getAlias[1]) : "",
      description: getDesc ? unquote(getDesc[1])  : "",
      mode:        getMode ? unquote(getMode[1])  : "single",
      state:       getState? unquote(getState[1]) : "on",
      variables:   getVarOwId ? { ow_id: unquote(getVarOwId[1]), ow_name: getVarOwName ? unquote(getVarOwName[1]) : "" } : null,
      _raw_yaml:   blockText,
    };

    // description may be a JSON string with escaped quotes — try unescaping
    try {
      // HA writes: description: '{"ow_meta":"1",...}'
      // or:        description: "{\"ow_meta\":\"1\",...}"
      if (obj.description.includes("ow_meta")) {
        // already readable
      }
    } catch {}

    if (obj.id || obj.alias) results.push(obj);
    currentBlock = [];
  }

  for (const line of lines) {
    // A new root-level list item starts a new automation block
    if (line.match(/^- /) || line.match(/^- *$/)) {
      commitBlock();
      currentBlock.push(line);
    } else {
      currentBlock.push(line);
    }
  }
  commitBlock();
  return results;
}



/* ─── AUTOMATION TRACE / ERROR MONITOR ────────────────────── */
const AUTOMATION_ERROR_LOG_REL = path.join("config", "automation_errors.json");
const AUTOMATION_TRACE_SCAN_REL = path.join("config", "automation_trace_scan.json");
const AUTOMATION_TRACE_SCAN_INTERVAL_MS = Math.max(60000, parseInt(process.env.OW_TRACE_SCAN_INTERVAL_MS || "300000", 10));
const AUTOMATION_ERROR_MAX_ENTRIES = Math.max(100, parseInt(process.env.OW_AUTOMATION_ERROR_MAX_ENTRIES || "500", 10));
let automationTraceScanTimer = null;
function _readJsonFile(filePath, fallback) { try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; } }
function _writeJsonFile(filePath, data) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8"); }
function automationErrorLogPath() { return safeDataPath(AUTOMATION_ERROR_LOG_REL); }
function automationTraceScanStatePath() { return safeDataPath(AUTOMATION_TRACE_SCAN_REL); }
function loadAutomationErrors() { const data = _readJsonFile(automationErrorLogPath(), []); return Array.isArray(data) ? data : []; }
function saveAutomationErrors(entries) { _writeJsonFile(automationErrorLogPath(), (entries || []).sort((a,b)=>String(b.time || '').localeCompare(String(a.time || ''))).slice(0, AUTOMATION_ERROR_MAX_ENTRIES)); }
function loadAutomationTraceScanState() { const data = _readJsonFile(automationTraceScanStatePath(), { seen: [] }); if (!Array.isArray(data.seen)) data.seen = []; return data; }
function saveAutomationTraceScanState(state) { state.seen = [...new Set(state.seen || [])].slice(-2000); state.last_scan = new Date().toISOString(); _writeJsonFile(automationTraceScanStatePath(), state); }
function automationTraceCandidatePaths() {
  return [...new Set([
    process.env.OW_HA_TRACE_FILE,
    path.join(DATA_DIR, ".storage", "trace.saved_traces"),
    path.join(DATA_DIR, "..", ".storage", "trace.saved_traces"),
    path.join(DATA_DIR, "..", "..", ".storage", "trace.saved_traces"),
    "/config/.storage/trace.saved_traces",
    "/homeassistant/.storage/trace.saved_traces",
    "/mnt/data/supervisor/homeassistant/.storage/trace.saved_traces",
  ].filter(Boolean).map(p => path.resolve(p)))];
}
function findAutomationTraceFile() { return automationTraceCandidatePaths().find(p => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }) || null; }
function _safeString(v) { if (v === null || v === undefined) return ""; if (typeof v === "string") return v; try { return JSON.stringify(v); } catch { return String(v); } }
function _walkTraceObjects(root, cb, pathParts = [], depth = 0) {
  if (depth > 16 || root === null || root === undefined) return;
  if (Array.isArray(root)) { root.forEach((item, idx) => _walkTraceObjects(item, cb, pathParts.concat(String(idx)), depth + 1)); return; }
  if (typeof root !== "object") return;
  cb(root, pathParts);
  Object.entries(root).forEach(([k, v]) => { if (v && typeof v === "object") _walkTraceObjects(v, cb, pathParts.concat(k), depth + 1); });
}
function _traceLooksLikeRun(obj) { return !!(obj && typeof obj === "object" && (obj.trace || obj.script_execution || obj.last_step || obj.run_id || obj.context || obj.timestamp || obj.config)); }
function _extractAutomationTraceInfo(trace, tracePath) {
  const config = trace.config || trace.trace?.config || trace.automation_config || {};
  const variables = trace.variables || trace.trace?.variables || config.variables || {};
  const owDraft = variables.ow_draft || config.variables?.ow_draft || {};
  const owId = variables.ow_id || config.variables?.ow_id || owDraft.id || trace.ow_id || "";
  const owName = variables.ow_name || config.variables?.ow_name || owDraft.name || trace.ow_name || config.alias || trace.alias || "";
  const alias = config.alias || trace.alias || trace.automation_alias || owName || "";
  const entityId = trace.entity_id || trace.automation_entity_id || trace.item_id || tracePath.find(p => p.startsWith("automation.")) || "";
  const runId = trace.run_id || trace.trace_id || trace.context?.id || tracePath.join("/");
  const time = trace.timestamp || trace.last_triggered || trace.start_time || trace.run_start || trace.context?.created_at || new Date().toISOString();
  const scriptExecution = String(trace.script_execution || trace.trace?.script_execution || trace.result?.script_execution || "");
  return { owId, owName, alias, entityId, runId, time, scriptExecution };
}
function _isOwAutomationTrace(info) {
  return !!(info.owId || String(info.alias || "").startsWith("HA-Overwatch") || String(info.owName || "").startsWith("HA-Overwatch") || String(info.entityId || "").startsWith("automation.ha_overwatch"));
}
function _extractTraceFailure(trace) {
  const failures = [];
  const exec = String(trace.script_execution || trace.trace?.script_execution || trace.result?.script_execution || "").toLowerCase();
  if (exec && exec !== "finished" && exec !== "cancelled" && /fail|error|exception|timeout|stopped|abort/.test(exec)) failures.push({ message: `script_execution=${exec}`, key: "script_execution" });
  _walkTraceObjects(trace, (obj, p) => {
    for (const key of ["error", "exception", "error_message", "message"]) {
      if (obj[key] && /error|fail|exception|unavailable|not found|timeout|invalid|service/i.test(_safeString(obj[key]))) failures.push({ message: _safeString(obj[key]).slice(0, 500), key, step: p.join("/") });
    }
    const result = _safeString(obj.result || obj.status || obj.state || "");
    if (/error|failed|exception|timeout/i.test(result)) failures.push({ message: result.slice(0, 500), key: "result", step: p.join("/") });
  });
  return failures;
}
function _extractFailedServiceAndEntity(trace) {
  let service = "", entityId = "", step = "";
  _walkTraceObjects(trace, (obj, p) => {
    if (service && entityId) return;
    const rawAction = obj.action || obj.service || obj.call_service || (obj.domain && obj.service ? `${obj.domain}.${obj.service}` : "");
    const targetEntity = obj.entity_id || obj.target?.entity_id || obj.data?.entity_id || obj.service_data?.entity_id || "";
    if (rawAction && !service) { service = Array.isArray(rawAction) ? rawAction.join(",") : String(rawAction); step = p.join("/"); }
    if (targetEntity && !entityId) { entityId = Array.isArray(targetEntity) ? targetEntity.join(",") : String(targetEntity); step = step || p.join("/"); }
  });
  return { service, entityId, step };
}
function collectAutomationTraceErrors() {
  const traceFile = findAutomationTraceFile();
  if (!traceFile) return { ok: false, traceFile: null, scanned: 0, added: 0, message: "trace.saved_traces not found" };
  const raw = _readJsonFile(traceFile, null);
  if (!raw) return { ok: false, traceFile, scanned: 0, added: 0, message: "trace.saved_traces unreadable" };
  const state = loadAutomationTraceScanState();
  const seen = new Set(state.seen || []);
  const existing = loadAutomationErrors();
  const existingKeys = new Set(existing.map(e => e.key).filter(Boolean));
  const additions = [];
  let scanned = 0;
  _walkTraceObjects(raw.data || raw, (obj, pathParts) => {
    if (!_traceLooksLikeRun(obj)) return;
    scanned++;
    const info = _extractAutomationTraceInfo(obj, pathParts);
    if (!_isOwAutomationTrace(info)) return;
    const failures = _extractTraceFailure(obj);
    if (!failures.length) return;
    const svc = _extractFailedServiceAndEntity(obj);
    const key = [info.owId || info.entityId || info.alias || "unknown", info.runId || info.time || pathParts.join("/"), failures[0].step || failures[0].key || "failure"].join("::");
    if (seen.has(key) || existingKeys.has(key)) return;
    seen.add(key);
    additions.push({ id:`autoerr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, key, time:info.time, level:"error", category:"automation", source:"ha_trace", ow_id:info.owId, ow_name:info.owName || info.alias, ha_entity_id:info.entityId, run_id:info.runId, status:info.scriptExecution || failures[0].key || "error", failed_step:failures[0].step || svc.step || "", service:svc.service, entity_id:svc.entityId, message:failures[0].message || "Automation trace indicates a failed run" });
  });
  if (additions.length) saveAutomationErrors(existing.concat(additions));
  state.seen = [...seen]; state.trace_file = traceFile; state.scanned = scanned; state.added_last_scan = additions.length; saveAutomationTraceScanState(state);
  if (additions.length) bumpDataVersion();
  return { ok: true, traceFile, scanned, added: additions.length };
}
function startAutomationTraceMonitor() {
  if (automationTraceScanTimer) clearInterval(automationTraceScanTimer);
  setTimeout(() => { try { console.log("[HA-Overwatch] automation trace scan", collectAutomationTraceErrors()); } catch (e) { console.warn(`[HA-Overwatch] automation trace scan failed: ${e.message}`); } }, 15000);
  automationTraceScanTimer = setInterval(() => { try { collectAutomationTraceErrors(); } catch (e) { console.warn(`[HA-Overwatch] automation trace scan failed: ${e.message}`); } }, AUTOMATION_TRACE_SCAN_INTERVAL_MS);
}

/* ─── REQUEST HANDLER ─────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Safely parse the request URL — ingress sends malformed URLs like '//' for health probes
  let pathname;
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    pathname = url.pathname;
  } catch {
    // Malformed URL (e.g. '//' from ingress) — treat as root, serve index.html
    pathname = "/";
  }
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  // Collapse double slashes to single (ingress sometimes sends //)
  pathname = pathname.replace(/\/\/+/g, "/");

  // Log every request for debugging
  console.log(`[HA-Overwatch] ${req.method} ${pathname}`);

  /* ── /ow/health ──────────────────────────────────────────── */
  if (pathname === "/ow/health" || pathname === "ow/health") {
    const isAddon = !!process.env.SUPERVISOR_TOKEN;
    json(res, {
      ok: true,
      app: "ha-overwatch",
      version: "0.10",
      buildId: SERVER_BUILD_ID,
      dataVersion,
      isAddon,
      appDir:  APP_DIR,
      dataDir: DATA_DIR,
    });
    return;
  }


  /* ── /ow/automation-errors ───────────────────────────────── */
  if (pathname === "/ow/automation-errors" && req.method === "GET") {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const owId = url.searchParams.get("ow_id") || "";
      const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "100", 10)));
      let entries = loadAutomationErrors();
      if (owId) entries = entries.filter(e => e.ow_id === owId || e.ha_entity_id === owId || e.ow_name === owId);
      json(res, { ok: true, entries: entries.slice(0, limit), count: entries.length });
    } catch (e) { err(res, e.message); }
    return;
  }

  /* ── /ow/automation-errors/scan ──────────────────────────── */
  if (pathname === "/ow/automation-errors/scan" && req.method === "POST") {
    try { json(res, collectAutomationTraceErrors()); }
    catch (e) { err(res, e.message); }
    return;
  }

  /* ── /ow/automation-errors/status ────────────────────────── */
  if (pathname === "/ow/automation-errors/status" && req.method === "GET") {
    try {
      const state = loadAutomationTraceScanState();
      json(res, { ok: true, traceFile: findAutomationTraceFile(), candidates: automationTraceCandidatePaths(), state, errorCount: loadAutomationErrors().length });
    } catch (e) { err(res, e.message); }
    return;
  }

  /* ── /api/save-config ────────────────────────────────────── */
  if (pathname === "/ow/save-config" && req.method === "POST") {
    try {
      const body     = await readBody(req);
      const filePath = safeDataPath(body.filename);
      console.log(`[HA-Overwatch] save-config → ${filePath}`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body.content, "utf8");
      console.log(`[HA-Overwatch] save-config ✓ saved ${filePath}`);
      bumpDataVersion();
      json(res, { ok: true });
    } catch (e) {
      console.error(`[HA-Overwatch] save-config ✗ ${e.message}`);
      err(res, e.message);
    }
    return;
  }

  /* ── /api/save-zone ──────────────────────────────────────── */
  if (pathname === "/ow/save-zone" && req.method === "POST") {
    try {
      const body     = await readBody(req);
      const fname    = path.basename(body.filename);
      const filePath = safeDataPath(path.join("config", "zones", fname));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body.content, "utf8");

      // Keep index.json up to date
      const idxPath = safeDataPath(path.join("config", "zones", "index.json"));
      let index = [];
      try { index = JSON.parse(fs.readFileSync(idxPath, "utf8")); } catch {}
      if (!index.includes(fname)) {
        index.push(fname);
        fs.writeFileSync(idxPath, JSON.stringify(index, null, 2), "utf8");
      }
      bumpDataVersion();
      json(res, { ok: true });
    } catch (e) { err(res, e.message); }
    return;
  }

  /* ── /api/delete-zone ────────────────────────────────────── */
  if (pathname === "/ow/delete-zone" && req.method === "POST") {
    try {
      const body  = await readBody(req);
      const fname = path.basename(body.filename);
      try { fs.unlinkSync(safeDataPath(path.join("config", "zones", fname))); } catch {}

      const idxPath = safeDataPath(path.join("config", "zones", "index.json"));
      let index = [];
      try { index = JSON.parse(fs.readFileSync(idxPath, "utf8")); } catch {}
      index = index.filter(f => f !== fname);
      fs.writeFileSync(idxPath, JSON.stringify(index, null, 2), "utf8");
      bumpDataVersion();
      json(res, { ok: true });
    } catch (e) { err(res, e.message); }
    return;
  }

  /* ── /ow/lights & /ow/sirens — map pin CRUD ─────────────── */
  if (pathname === "/ow/lights"  && req.method === "GET") { json(res, loadPins("lights"));  return; }
  if (pathname === "/ow/sirens"  && req.method === "GET") { json(res, loadPins("sirens"));  return; }
  if (pathname === "/ow/save-light"   && req.method === "POST") {
    try { const b = await readBody(req); savePin("lights", b); json(res, { ok: true }); }
    catch (e) { err(res, e.message); } return;
  }
  if (pathname === "/ow/save-siren"   && req.method === "POST") {
    try { const b = await readBody(req); savePin("sirens", b); json(res, { ok: true }); }
    catch (e) { err(res, e.message); } return;
  }
  if (pathname === "/ow/delete-light" && req.method === "POST") {
    try { const b = await readBody(req); deletePin("lights", b.id); json(res, { ok: true }); }
    catch (e) { err(res, e.message); } return;
  }
  if (pathname === "/ow/delete-siren" && req.method === "POST") {
    try { const b = await readBody(req); deletePin("sirens", b.id); json(res, { ok: true }); }
    catch (e) { err(res, e.message); } return;
  }

  /* ── /ow/camera-pins ─────────────────────────────────────── */
  if (pathname === "/ow/camera-pins" && req.method === "GET") { json(res, loadPins("camera_pins")); return; }
  if (pathname === "/ow/cam-low-res-map" && req.method === "GET") {
    const f = path.join(DATA_DIR, "config", "cam_low_res.json");
    try { json(res, JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch { json(res, {}); }
    return;
  }

  /* ── /ow/arm-allowed-ips ─────────────────────────────────── */
  if (pathname === "/ow/arm-allowed-ips" && req.method === "GET") {
    const f = path.join(DATA_DIR, "config", "arm_allowed_ips.json");
    try { json(res, JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch { json(res, { ips: [] }); }
    return;
  }

  /* ── /ow/alarms — alarm definitions ─────────────────────── */
  if (pathname === "/ow/alarms" && req.method === "GET") {
    json(res, loadAlarms());
    return;
  }
  if (pathname === "/ow/alarms" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const alarms = Array.isArray(body) ? body : (body?.alarms || []);
      saveAlarms(alarms);
      let response_sync = null;
      try { response_sync = await syncAlarmResponseAutomations(alarms); }
      catch (syncErr) {
        console.warn("[OW-AlarmResponse] sync after alarm save failed:", syncErr.message);
        response_sync = { ok: false, errors: [{ error: syncErr.message }] };
      }
      json(res, { ok: true, response_sync });
    } catch (e) { err(res, e.message, 500); }
    return;
  }

  if (pathname === "/ow/alarms/effective" && req.method === "GET") {
    try { json(res, buildAlarmEffectiveState()); }
    catch (e) { err(res, e.message, 500); }
    return;
  }

if (pathname === "/ow/alarms/triggered" && req.method === "GET") {
try { json(res, buildAlarmTriggeredState()); }
catch (e) { err(res, e.message, 500); }
return;
}

if (pathname === "/ow/alarms/responses/sync" && req.method === "POST") {
  try { json(res, await syncAlarmResponseAutomations(loadAlarms())); }
  catch (e) { err(res, e.message, 500); }
  return;
}



  /* ── /ow/cam-pinned ──────────────────────────────────────── */
  if (pathname === "/ow/cam-pinned" && req.method === "GET") {
    const f = path.join(DATA_DIR, "config", "cam_pinned.json");
    try { json(res, JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch { json(res, []); }
    return;
  }
  if (pathname === "/ow/arm-allowed-ips" && req.method === "POST") {
    try {
      const b = await readBody(req);
      const f = path.join(DATA_DIR, "config", "arm_allowed_ips.json");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(b, null, 2), "utf8");
      bumpDataVersion();
      json(res, { ok: true });
    } catch(e) { err(res, e.message); }
    return;
  }
  if (pathname === "/ow/save-camera-pin" && req.method === "POST") {
    try { const b = await readBody(req); savePin("camera_pins", b); json(res, { ok: true }); }
    catch (e) { err(res, e.message); } return;
  }
  if (pathname === "/ow/delete-camera-pin" && req.method === "POST") {
    try { const b = await readBody(req); deletePin("camera_pins", b.id); json(res, { ok: true }); }
    catch (e) { err(res, e.message); } return;
  }

  /* ── /ow/door-pins ───────────────────────────────────────── */
  if (pathname === "/ow/door-pins" && req.method === "GET") { json(res, loadPins("door_pins")); return; }
  if (pathname === "/ow/save-door-pin" && req.method === "POST") {
    try { const b = await readBody(req); savePin("door_pins", b); json(res, { ok: true }); }
    catch (e) { err(res, e.message); } return;
  }
  if (pathname === "/ow/delete-door-pin" && req.method === "POST") {
    try { const b = await readBody(req); deletePin("door_pins", b.id); json(res, { ok: true }); }
    catch (e) { err(res, e.message); } return;
  }

  /* ── /api/upload-floorplan ───────────────────────────────── */
  if (pathname === "/ow/upload-floorplan" && req.method === "POST") {
    const imgDir = safeDataPath("img");
    fs.mkdirSync(imgDir, { recursive: true });

    const boundary = (req.headers["content-type"] || "").split("boundary=")[1];
    if (!boundary) { err(res, "No boundary"); return; }

    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
        const sep = Buffer.from("\r\n--" + boundary);
        let start = raw.indexOf("--" + boundary) + boundary.length + 4;
        while (start < raw.length) {
          const end = raw.indexOf(sep, start);
          if (end < 0) break;
          const part      = raw.slice(start, end);
          const headerEnd = part.indexOf("\r\n\r\n");
          if (headerEnd >= 0) {
            const header    = part.slice(0, headerEnd).toString();
            const fileData  = part.slice(headerEnd + 4);
            const nameMatch = header.match(/filename="([^"]+)"/);
            if (nameMatch) {
              const fname   = path.basename(nameMatch[1]);
              const outPath = path.join(imgDir, fname);
              fs.writeFileSync(outPath, fileData);
              json(res, { ok: true, path: "img/" + fname });
              return;
            }
          }
          start = end + sep.length + 2;
        }
        err(res, "No file found in upload");
      } catch (e) { err(res, e.message); }
    });
    return;
  }

  /* ── /ow/triggered — coordinator polls for zone triggered states ── */
  if (pathname === "/ow/triggered" && req.method === "GET") {
    try { json(res, buildTriggeredSnapshot()); }
    catch (e) { err(res, e.message, 500); }
    return;
  }

  /* ── /ow/triggered-detail — debug why a zone is considered triggered ── */
  if (pathname === "/ow/triggered-detail" && req.method === "GET") {
    try { json(res, buildTriggeredDetailSnapshot()); }
    catch (e) { err(res, e.message, 500); }
    return;
  }

  /* ── /ow/states — direct mode frontend polls for full HA entity states ── */
  if (pathname === "/ow/states" && req.method === "GET") {
    // If the HA listener hasn't populated the cache yet, do a one-shot REST fetch
    if (Object.keys(serverHaStates).length === 0 && process.env.SUPERVISOR_TOKEN) {
      const haReq = http.request({
        hostname: "supervisor",
        port:     80,
        path:     "/core/api/states",
        method:   "GET",
        headers: {
          "Authorization": `Bearer ${process.env.SUPERVISOR_TOKEN}`,
          "Content-Type":  "application/json",
        },
      }, haRes => {
        let body = "";
        haRes.on("data", c => body += c);
        haRes.on("end", () => {
          try {
            const states = JSON.parse(body);
            if (Array.isArray(states)) {
              states.forEach(st => { if (st.entity_id) serverHaStates[st.entity_id] = st; });
              console.log(`[HA-Overwatch] /ow/states eager fetch: ${states.length} entities`);
            }
          } catch {}
          json(res, serverHaStates);
        });
      });
      haReq.on("error", () => json(res, serverHaStates));
      haReq.end();
      return;
    }
    json(res, serverHaStates);
    return;
  }

  /* ── /ow/call-service — direct mode frontend calls HA services via backend ── */
  if (pathname === "/ow/call-service" && req.method === "POST") {
    if (!process.env.SUPERVISOR_TOKEN) { res.writeHead(503); res.end("Not in addon mode"); return; }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { domain, service, entity_id } = JSON.parse(body);
        const payload = JSON.stringify({ entity_id });
        const haReq = http.request({
          hostname: "supervisor", port: 80,
          path: `/core/api/services/${domain}/${service}`,
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.SUPERVISOR_TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        }, haRes => { haRes.resume(); res.writeHead(haRes.statusCode); res.end(); });
        haReq.on("error", () => { res.writeHead(502); res.end(); });
        haReq.write(payload);
        haReq.end();
      } catch { res.writeHead(400); res.end("Bad request"); }
    });
    return;
  }

  /* ── /ow/automations — local index r/w (id list only) ──────── */
  if (pathname === "/ow/automations" && req.method === "GET") {
    const p = path.join(DATA_DIR, "config", "automations.json");
    try {
      json(res, JSON.parse(fs.readFileSync(p, "utf8")));
    } catch {
      json(res, []);
    }
    return;
  }

  if (pathname === "/ow/automations" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : [];
      const p = path.join(DATA_DIR, "config", "automations.json");
      fs.mkdirSync(path.join(DATA_DIR, "config"), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(list, null, 2), "utf8");
      json(res, { ok: true });
    } catch(e) {
      console.error("[OW-Auto] Failed to save automations:", e.message);
      err(res, "Failed to save automations", 500);
    }
    return;
  }

  /* ── /ow/ha-automations — read HA-Overwatch automations ──────── */
  if (pathname === "/ow/ha-automations" && req.method === "GET") {
    try {
      // Strategy 1: Read automation files directly from HA config dir (add-on mode)
      // HA stores automations in /config/automations.yaml or /config/automations/*.yaml
      const haConfigDir = process.env.SUPERVISOR_TOKEN ? "/config" : null;
      let allAutomations = [];
      let readFromDisk = false;

      if (haConfigDir) {
        // Try /config/automations.yaml first (single file)
        const singleFile = path.join(haConfigDir, "automations.yaml");
        const autoDir    = path.join(haConfigDir, "automations");

        try {
          const raw = fs.readFileSync(singleFile, "utf8");
          // Parse YAML manually — only need to extract objects, use simple approach
          allAutomations = parseAutomationsYaml(raw);
          readFromDisk = true;
        } catch {}

        if (!readFromDisk) {
          // Try /config/automations/ directory with individual files
          try {
            const files = fs.readdirSync(autoDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
            for (const file of files) {
              try {
                const raw = fs.readFileSync(path.join(autoDir, file), "utf8");
                const autos = parseAutomationsYaml(raw);
                allAutomations.push(...autos);
                readFromDisk = true;
              } catch {}
            }
          } catch {}
        }
      }

      if (!readFromDisk) {
        // Strategy 2: HA REST — use /api/states to find automation.* entities,
        // then fetch each config individually
        // Note: GET /api/config/automation/config is not a list endpoint in all HA versions
        // Instead, use states to get the list of automation entity IDs
        const cfg = getHAConfig(loadConfig());
        if (!cfg.ha_url && !process.env.SUPERVISOR_TOKEN) { json(res, []); return; }
        let hostname, port, basePath, token;
        if (process.env.SUPERVISOR_TOKEN) {
          hostname = "supervisor"; port = 80; basePath = "/core"; token = process.env.SUPERVISOR_TOKEN;
        } else {
          const u = new URL(cfg.ha_url.replace(/\/$/, ""));
          hostname = u.hostname; port = parseInt(u.port)||(u.protocol==="https:"?443:80);
          basePath = ""; token = cfg.ha_token;
        }
        // Read from serverHaStates cache if available (avoids extra HTTP round-trip)
        const owStates = Object.values(serverHaStates).filter(st =>
          st.entity_id?.startsWith("automation.") &&
          (st.attributes?.friendly_name||"").startsWith("HA-Overwatch")
        );
        if (owStates.length > 0) {
          // Build minimal automation objects from states
          allAutomations = owStates.map(st => ({
            id:          st.attributes?.id || st.entity_id.replace("automation.",""),
            alias:       st.attributes?.friendly_name || "",
            description: st.attributes?.description || "",
            state:       st.state,
          }));
        } else {
          // Full REST fetch of states
          await new Promise((resolve) => {
            const haReq = (process.env.SUPERVISOR_TOKEN ? http : https).request({
              hostname, port, method: "GET",
              path: `${basePath}/api/states`,
              headers: { "Authorization": `Bearer ${token}` },
            }, haRes => {
              let d = "";
              haRes.on("data", c => d += c);
              haRes.on("end", () => {
                try {
                  const states = JSON.parse(d);
                  allAutomations = states
                    .filter(st => st.entity_id?.startsWith("automation.") &&
                      (st.attributes?.friendly_name||"").startsWith("HA-Overwatch"))
                    .map(st => ({
                      id:          st.attributes?.id || st.entity_id.replace("automation.",""),
                      alias:       st.attributes?.friendly_name || "",
                      description: st.attributes?.description || "",
                      state:       st.state,
                    }));
                } catch {}
                resolve();
              });
            });
            haReq.on("error", () => resolve());
            haReq.end();
          });
        }
      }

      // Filter to HA-Overwatch parent automations only.
      // Generated child automations such as paired Turn OFF are managed by the parent
      // and must not be shown as editable rows in the HA-O Automation Editor.
      // Do not filter by alias text; users can legitimately name automations "- Turn OFF".
      const ours = allAutomations.filter(a =>
        ((a.alias || "").startsWith("HA-Overwatch") ||
        (a.description || "").includes("ow_meta:") ||
        a.variables?.ow_id) &&
        !_isTurnOffAutomationConfig(a)
      );

      // For each found automation, fetch the full config from HA REST if we only have partial data
      const fullAutomations = await Promise.all(ours.map(async (a) => {
        // If we already have triggers/actions from YAML parse, use as-is
        if (a.triggers || a.trigger || a.actions || a.action) return a;
        // Otherwise fetch full config by ID
        if (!a.id) return a;
        try {
          const cfg2 = getHAConfig(loadConfig());
          let hostname2, port2, basePath2, token2;
          if (process.env.SUPERVISOR_TOKEN) {
            hostname2 = "supervisor"; port2 = 80; basePath2 = "/core"; token2 = process.env.SUPERVISOR_TOKEN;
          } else {
            const u2 = new URL((cfg2.ha_url||"").replace(/\/$/, ""));
            hostname2 = u2.hostname; port2 = parseInt(u2.port)||(u2.protocol==="https:"?443:80);
            basePath2 = ""; token2 = cfg2.ha_token;
          }
          const full = await new Promise((resolve) => {
            const r = (process.env.SUPERVISOR_TOKEN ? http : https).request({
              hostname: hostname2, port: port2, method: "GET",
              path: `${basePath2}/api/config/automation/config/${a.id}`,
              headers: { "Authorization": `Bearer ${token2}` },
            }, haRes2 => {
              let d2 = "";
              haRes2.on("data", c => d2 += c);
              haRes2.on("end", () => {
                try { resolve(JSON.parse(d2)); } catch { resolve(a); }
              });
            });
            r.on("error", () => resolve(a));
            r.end();
          });
          // Merge: keep our id/alias/description if HA doesn't return them
          return { ...a, ...full, id: a.id || full.id };
        } catch { return a; }
      }));

      const visibleAutomations = fullAutomations.filter(a => !_isTurnOffAutomationConfig(a));
      console.log(`[OW-Auto] ha-automations: found ${visibleAutomations.length} OW parent automations (${readFromDisk?"disk":"REST"}); hidden ${fullAutomations.length - visibleAutomations.length} generated child automations`);
      json(res, visibleAutomations);
    } catch(e) {
      console.error("[OW-Auto] /ow/ha-automations error:", e.message);
      json(res, []);
    }
    return;
  }

  /* ── /ow/ha-registry — return HA floor/area/device/entity registry ── */
  if (pathname === "/ow/ha-registry" && req.method === "GET") {
    // Return cached registry data (populated by startHAListener on auth_ok)
    if (haRegistry.loaded) {
      json(res, haRegistry);
      return;
    }
    // Not loaded yet (direct mode or not connected) — try REST API fallback
    // HA REST doesn't expose registries directly, so return empty with a flag
    json(res, { floors: [], areas: [], devices: [], entities: [], loaded: false, error: "Registry not available — ensure add-on is connected to HA" });
    return;
  }

  /* ── /ow/ha-registry/refresh — re-fetch registry from HA ── */
  if (pathname === "/ow/ha-registry/refresh" && req.method === "POST") {
    const ok = refetchHARegistry();
    const refreshId = haRegistry.refresh_id || 0;
    const completed = ok ? await waitForHARegistryRefresh(refreshId, 5000) : false;
    json(res, {
      ok,
      completed,
      refresh_id: refreshId,
      loaded: haRegistry.loaded,
      refreshing: haRegistry.refreshing,
      requested_at: haRegistry.requested_at,
      completed_at: haRegistry.completed_at,
      counts: {
        floors: haRegistry.floors.length,
        areas: haRegistry.areas.length,
        devices: haRegistry.devices.length,
        entities: haRegistry.entities.length,
      },
      message: ok
        ? (completed ? "Registry refresh completed" : "Registry refresh triggered but did not complete before timeout")
        : "Not connected to HA — registry will reload on next connection",
    });
    return;
  }

  /* ── /ow/ha-services — fetch HA service list (filtered by domain) ── */
  if (pathname === "/ow/ha-services" && req.method === "GET") {
    const domain = (new URLSearchParams((req.url||"").split("?")[1]||"")).get("domain") || "";
    try {
      const cfg = getHAConfig(loadConfig());
      if (!cfg.ha_url && !process.env.SUPERVISOR_TOKEN) { json(res, []); return; }
      let hostname, port, basePath, token;
      if (process.env.SUPERVISOR_TOKEN) {
        hostname = "supervisor"; port = 80; basePath = "/core"; token = process.env.SUPERVISOR_TOKEN;
      } else {
        const u = new URL(cfg.ha_url.replace(/\/$/, ""));
        hostname = u.hostname; port = parseInt(u.port)||(u.protocol==="https:"?443:80);
        basePath = ""; token = cfg.ha_token;
      }
      const haReq = (process.env.SUPERVISOR_TOKEN ? http : https).request({
        hostname, port, method: "GET",
        path: `${basePath}/api/services`,
        headers: { "Authorization": `Bearer ${token}` },
      }, haRes => {
        let d = "";
        haRes.on("data", c => d += c);
        haRes.on("end", () => {
          try {
            const all = JSON.parse(d);
            const filtered = domain
              ? all.filter(s => s.domain === domain)
              : all;
            json(res, filtered);
          } catch(e) { json(res, []); }
        });
      });
      haReq.on("error", e => { json(res, []); });
      haReq.end();
    } catch(e) { json(res, []); }
    return;
  }

  /* ── /ow/push-automation — push one automation to HA REST API ── */
  if (pathname === "/ow/push-automation" && req.method === "POST") {
    try {
      const auto = await readBody(req);
      const cfg  = getHAConfig(loadConfig());
      if (!cfg.ha_url && !process.env.SUPERVISOR_TOKEN) {
        err(res, "HA not configured", 503); return;
      }

      const haAutos = buildHAAutomationSet(auto, loadZones(), loadGroups());
      const generatedIds = new Set(haAutos.map(a => String(a.id)));
      const staleTurnOffId = _automationTurnOffId(auto.id);

      let hostname, port, basePath, token, lib;
      if (process.env.SUPERVISOR_TOKEN) {
        hostname = "supervisor"; port = 80; basePath = "/core"; token = process.env.SUPERVISOR_TOKEN; lib = http;
      } else {
        const u = new URL(cfg.ha_url.replace(/\/$/, ""));
        hostname = u.hostname; port = parseInt(u.port) || (u.protocol === "https:" ? 443 : 80);
        basePath = ""; token = cfg.ha_token; lib = u.protocol === "https:" ? https : http;
      }

      function automationConfigRequest(method, id, payload = null) {
        const body = payload == null ? "" : JSON.stringify(payload);
        return new Promise((resolve, reject) => {
          const haReq = lib.request({
            hostname, port, method, path: `${basePath}/api/config/automation/config/${id}`,
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          }, haRes => {
            let d = "";
            haRes.on("data", c => d += c);
            haRes.on("end", () => resolve({ status: haRes.statusCode || 0, body: d }));
          });
          haReq.on("error", reject);
          if (body) haReq.write(body);
          haReq.end();
        });
      }
      function reloadAutomations() {
        return new Promise(resolve => {
          const reloadReq = lib.request({
            hostname, port, method: "POST",
            path: `${basePath}/api/services/automation/reload`,
            headers: { "Authorization": `Bearer ${token}`, "Content-Length": "0" },
          }, r => { r.resume(); resolve(); });
          reloadReq.on("error", () => resolve());
          reloadReq.end();
        });
      }

      const pushed = [];
      for (const haAuto of haAutos) {
        const result = await automationConfigRequest("POST", String(haAuto.id), haAuto);
        pushed.push({ id: haAuto.id, status: result.status, detail: result.body });
        if (result.status < 200 || result.status >= 300) {
          console.warn(`[OW-Auto] HA rejected automation ${haAuto.id}: ${result.status} — ${result.body}`);
          json(res, { ok: false, ha_status: result.status, pushed, detail: result.body });
          return;
        }
      }

      const deleted = [];
      if (staleTurnOffId && !generatedIds.has(staleTurnOffId)) {
        try {
          const del = await automationConfigRequest("DELETE", staleTurnOffId, null);
          deleted.push({ id: staleTurnOffId, status: del.status, missing: del.status === 404 || (del.status === 400 && /Resource not found/i.test(String(del.body || ""))) });
        } catch (e) {
          deleted.push({ id: staleTurnOffId, error: e.message });
        }
      }

      await reloadAutomations();
      console.log(`[OW-Auto] Push automation "${auto.name}" → HA ${pushed.map(p => `${p.id}:${p.status}`).join(', ')}`);
      json(res, { ok: true, ha_status: pushed[0]?.status || 200, pushed, deleted });
    } catch(e) {
      console.error("[OW-Auto] Push-automation error:", e.message);
      err(res, e.message, 500);
    }
    return;
  }

  
/* ── /ow/delete-automation — remove from HA ─────────────────── */
  if (pathname === "/ow/delete-automation" && req.method === "POST") {
    try {
      const { id } = await readBody(req);
      const cfg = getHAConfig(loadConfig());
      if (!cfg.ha_url && !process.env.SUPERVISOR_TOKEN) { json(res, { ok: true }); return; }
      let hostname, port, basePath, token, lib;
      if (process.env.SUPERVISOR_TOKEN) {
        hostname = "supervisor"; port = 80; basePath = "/core"; token = process.env.SUPERVISOR_TOKEN; lib = http;
      } else {
        const u = new URL(cfg.ha_url.replace(/\/$/, ""));
        hostname = u.hostname; port = parseInt(u.port) || (u.protocol === "https:" ? 443 : 80);
        basePath = ""; token = cfg.ha_token; lib = u.protocol === "https:" ? https : http;
      }

      function deleteAutomationConfig(deleteId) {
        return new Promise(resolve => {
          const haReq = lib.request({
            hostname, port, method: "DELETE",
            path: `${basePath}/api/config/automation/config/${deleteId}`,
            headers: { "Authorization": `Bearer ${token}`, "Content-Length": "0" },
          }, haRes => {
            let d = "";
            haRes.on("data", c => d += c);
            haRes.on("end", () => resolve({ id: deleteId, status: haRes.statusCode || 0, detail: d }));
          });
          haReq.on("error", e => resolve({ id: deleteId, error: e.message }));
          haReq.end();
        });
      }
      function reloadAutomations() {
        return new Promise(resolve => {
          const reloadReq = lib.request({
            hostname, port, method: "POST",
            path: `${basePath}/api/services/automation/reload`,
            headers: { "Authorization": `Bearer ${token}`, "Content-Length": "0" },
          }, r => { r.resume(); resolve(); });
          reloadReq.on("error", () => resolve());
          reloadReq.end();
        });
      }

      const ids = [...new Set([String(id || ''), _automationTurnOffId(id)].filter(Boolean))];
      const deleted = [];
      for (const deleteId of ids) deleted.push(await deleteAutomationConfig(deleteId));
      await reloadAutomations();
      console.log(`[OW-Auto] Delete automation ${id} → HA ${deleted.map(d => `${d.id}:${d.status || d.error}`).join(', ')}`);
      json(res, { ok: true, ha_status: deleted[0]?.status || 200, deleted });
    } catch(e) {
      err(res, e.message, 500);
    }
    return;
  }

  
/* ── /ow/floors — floor list r/w ───────────────────────────── */
  if (pathname === "/ow/floors" && req.method === "GET") {
    json(res, loadFloors());
    return;
  }

  if (pathname === "/ow/save-floor" && req.method === "POST") {
    try {
      const body   = await readBody(req);
      const floors = loadFloors();
      const idx    = floors.findIndex(f => f.id === body.id);
      if (idx >= 0) {
        floors[idx] = { ...floors[idx], ...body };
      } else {
        // New floor — generate id from name
        const id = "floor_" + (body.name || "floor").toLowerCase().replace(/[^a-z0-9]+/g, "_") + "_" + Date.now();
        floors.push({ id, name: body.name || "New Floor", floorplan: body.floorplan || "" });
      }
      saveFloors(floors);
      json(res, { ok: true, floors });
    } catch (e) { err(res, e.message); }
    return;
  }

  if (pathname === "/ow/delete-floor" && req.method === "POST") {
    try {
      const body   = await readBody(req);
      const floors = loadFloors().filter(f => f.id !== body.id);
      saveFloors(floors);
      json(res, { ok: true, floors });
    } catch (e) { err(res, e.message); }
    return;
  }

  if (pathname === "/ow/reorder-floors" && req.method === "POST") {
    try {
      const body = await readBody(req); // expects { ids: ["floor_a", "floor_b", ...] }
      const floors = loadFloors();
      const ordered = (body.ids || []).map(id => floors.find(f => f.id === id)).filter(Boolean);
      // Append any floors not in the ids list at the end
      floors.forEach(f => { if (!ordered.find(o => o.id === f.id)) ordered.push(f); });
      saveFloors(ordered);
      json(res, { ok: true, floors: ordered });
    } catch (e) { err(res, e.message); }
    return;
  }

  /* ── /ow/reload — trigger HA to reload ha_overwatch config entries ── */
  if (pathname === "/ow/reload" && req.method === "POST") {
    if (!process.env.SUPERVISOR_TOKEN) { json(res, { ok: false, reason: "not in addon mode" }); return; }
    // Step 1: GET /api/config/config_entries to find the ha_overwatch entry_id
    const listReq = http.request({
      hostname: "supervisor", port: 80,
      path: "/core/api/config/config_entries",
      method: "GET",
      headers: { "Authorization": `Bearer ${process.env.SUPERVISOR_TOKEN}` },
    }, listRes => {
      let body = "";
      listRes.on("data", c => body += c);
      listRes.on("end", () => {
        try {
          const entries = JSON.parse(body);
          const entry = entries.find(e => e.domain === "ha_overwatch");
          if (!entry) {
            console.warn("[HA-Overwatch] /ow/reload: ha_overwatch config entry not found");
            json(res, { ok: false, reason: "entry not found" });
            return;
          }
          // Step 2: POST /api/config/config_entries/{entry_id}/reload
          const reloadReq = http.request({
            hostname: "supervisor", port: 80,
            path: `/core/api/config/config_entries/${entry.entry_id}/reload`,
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.SUPERVISOR_TOKEN}` },
          }, reloadRes => {
            reloadRes.resume();
            console.log(`[HA-Overwatch] /ow/reload → entry ${entry.entry_id} → HA responded ${reloadRes.statusCode}`);
            json(res, { ok: reloadRes.statusCode < 300 });
          });
          reloadReq.on("error", e => { console.error("[HA-Overwatch] /ow/reload error:", e.message); json(res, { ok: false, reason: e.message }); });
          reloadReq.end();
        } catch (e) {
          console.error("[HA-Overwatch] /ow/reload parse error:", e.message);
          json(res, { ok: false, reason: e.message });
        }
      });
    });
    listReq.on("error", e => json(res, { ok: false, reason: e.message }));
    listReq.end();
    return;
  }

  /* ── /ow/zones — component fetches zone/group/camera structure ── */
  if (pathname === "/ow/zones" && req.method === "GET") {
    try {
      const zones  = loadZones();
      const groups = loadGroups();
      const cameraSet = new Set();
      zones.forEach(z => (z.cameras || []).forEach(c => cameraSet.add(c)));

      // Use name-based slugs for friendly entity IDs:
      // "Asphalt Right" -> "asphalt_right" -> switch.overwatch_zone_asphalt_right
      const nameSlug = name => (name || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

      const floors = loadFloors();
      json(res, {
        zones: zones.map(z => ({
          id:       nameSlug(z.name) || z.id,
          name:     z.name || z.id,
          raw_id:   z.id,
          floor_id: z.floor_id || null,
        })),
        floors: floors.map(f => ({
          id:   f.id,
          name: f.name,
        })),
        groups: groups.map(g => ({
          id:       nameSlug(g.name) || g.id,
          name:     g.name || g.id,
          raw_id:   g.id,
          zone_ids: (g.zone_ids || []).map(zid => {
            const z = zones.find(z => z.id === zid);
            return z ? (nameSlug(z.name) || zid) : zid;
          }),
        })),
        alarms: loadAlarms().map(a => ({
          id:       nameSlug(a.name) || a.id,
          name:     a.name || a.id,
          raw_id:   a.id,
          builtin:  !!a.builtin,
          role:     a.role || null,
        })),
        camera_groups: groups
          .filter(g => (g.zone_ids || []).some(zid =>
            zones.find(z => z.id === zid && (z.cameras || []).length > 0)))
          .map(g => ({ id: nameSlug(g.name) || g.id, name: g.name || g.id })),
        camera_zones: zones
          .filter(z => (z.cameras || []).length > 0)
          .map(z => ({ id: nameSlug(z.name) || z.id, name: z.name || z.id })),
        cameras: [...cameraSet].map(camId => ({
          id:   camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_'),
          name: camId.replace(/^camera\./, '').replace(/_/g, ' '),
          raw_id: camId,
        })),
      });
    } catch (e) { err(res, e.message, 500); }
    return;
  }

  /* ── /ow/snap-cache-status — inspect cache freshness/debug ───── */
  if (pathname === "/ow/snap-cache-status" && req.method === "GET") {
    const now = Date.now();
    const entries = {};
    for (const [entity, entry] of cameraSnapshotCache.entries()) {
      const backoff = cameraBackoff.get(entity);
      entries[entity] = {
        bytes: entry?.buf?.length || 0,
        contentType: entry?.contentType || "",
        ageMs: entry?.fetchedAt ? now - entry.fetchedAt : null,
        inflight: cameraSnapshotInflight.has(entity),
        backoffUntilMs: backoff ? Math.max(0, backoff.until - now) : 0,
        backoffReason: backoff?.reason || "",
        lastStatus: backoff?.lastStatus || 0,
      };
    }
    json(res, {
      ok: true,
      version: "snapshot-grid-v1.3",
      ttlMs: SNAPSHOT_CACHE_TTL_MS,
      staleTtlMs: SNAPSHOT_STALE_TTL_MS,
      maxBytes: SNAPSHOT_MAX_BYTES,
      globalConcurrency: SNAPSHOT_GLOBAL_CONCURRENCY,
      activeFetches: snapshotActiveFetches,
      queuedFetches: snapshotQueue.length,
      entries,
    });
    return;
  }

  /* ── Snapshot-grid-v1.3 camera cache ─────────────────────── */
  if (pathname.startsWith("/ow/snap-cache/")) {
    const entity = decodeURIComponent(pathname.slice("/ow/snap-cache/".length).split("?")[0] || "");
    if (!entity) { sendSnapshotPlaceholder(res, "camera", 400, "missing_entity"); return; }
    const now = Date.now();
    const cached = cameraSnapshotCache.get(entity);
    const backoff = cameraBackoff.get(entity);
    if (cached && (now - cached.fetchedAt) < SNAPSHOT_CACHE_TTL_MS) { sendSnapshotBuffer(res, entity, cached, "hit"); return; }
    if (backoff && backoff.until > now) {
      if (cached && (now - cached.fetchedAt) < SNAPSHOT_STALE_TTL_MS) sendSnapshotBuffer(res, entity, cached, `stale-backoff-${backoff.lastStatus || 'err'}`);
      else sendSnapshotPlaceholder(res, entity, 200, `backoff_${backoff.lastStatus || 'error'}`);
      return;
    }
    if (!cached) {
      try { const fresh = await refreshSnapshotSingleFlight(entity); sendSnapshotBuffer(res, entity, fresh, "miss-filled"); }
      catch (e) { console.warn(`[SNAP CACHE] initial fetch failed ${entity}: ${e.message}`); sendSnapshotPlaceholder(res, entity, 200, e.statusCode === 429 ? "protect_429" : "fetch_failed"); }
      return;
    }
    if (!cameraSnapshotInflight.has(entity)) {
      refreshSnapshotSingleFlight(entity).catch(e => console.warn(`[SNAP CACHE] background refresh failed ${entity}: ${e.message}`));
    }
    sendSnapshotBuffer(res, entity, cached, "stale-refreshing");
    return;
  }

  /* ── Old HA camera proxy routes disabled in snapshot-grid-v1.3 ─ */
  if (pathname.startsWith("/ow/camera_proxy")) {
    res.writeHead(410, snapshotCorsHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "camera_proxy_disabled", message: "snapshot-grid-v1.3 uses /ow/snap-cache/<entity>; HA live stream proxy is disabled." }));
    return;
  }

  /* ── Static file serving ─────────────────────────────────── */
  let reqPath = pathname === "/" ? "/index.html" : pathname;
  reqPath = reqPath.replace(/\.\./g, "");
  // Decode URL encoding so filenames with spaces work (e.g. Arial%20Image.png)
  try { reqPath = decodeURIComponent(reqPath); } catch { /* keep as-is */ }

  // Resolve file path — try DATA_DIR first for data paths, then APP_DIR
  let filePath;
  const isDataPath = reqPath.startsWith("/config/") || reqPath.startsWith("/img/");

  if (isDataPath) {
    const dataCandidate = path.join(DATA_DIR, reqPath);
    if (!dataCandidate.startsWith(path.resolve(DATA_DIR))) { err(res, "Forbidden", 403); return; }
    // Try DATA_DIR first, fall back to APP_DIR (e.g. placeholder floorplan)
    filePath = fs.existsSync(dataCandidate) ? dataCandidate : path.join(APP_DIR, reqPath);
  } else {
    filePath = path.join(APP_DIR, reqPath);
    if (!filePath.startsWith(path.resolve(APP_DIR))) { err(res, "Forbidden", 403); return; }
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");

    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";

    // For HTML pages: inject <base> tag for ingress routing, or a data attribute for direct access
    if (ext === ".html") {
      let html = fs.readFileSync(filePath, "utf8");
      const ingressPath = req.headers["x-ingress-path"] || "";
      // Detect client IP — check x-forwarded-for first (ingress proxy), then socket
      const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim().replace(/^::ffff:/, "");
      if (ingressPath) {
        const base = ingressPath.replace(/\/?$/, "/");
        html = html.replace("<head>", `<head>\n    <base href="${base}" />\n    <meta name="ow-client-ip" content="${clientIp}" />`);
      } else {
        // Direct port access OR reverse proxy — both treated as non-admin (no SUPERVISOR_TOKEN)
        html = html.replace("<head>", `<head>\n    <meta name="ow-direct" content="true" />\n    <meta name="ow-client-ip" content="${clientIp}" />`);
      }
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
      res.end(html);
      return;
    }

    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type":  mime,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(content);
  } catch {
    console.log(`[HA-Overwatch] 404 ${pathname} (tried: ${filePath})`);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found: " + pathname);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HA-Overwatch] Server running at http://0.0.0.0:${PORT}`);
  console.log(`[HA-Overwatch] App directory:  ${APP_DIR}`);
  console.log(`[HA-Overwatch] Data directory: ${DATA_DIR}`);
  writeCustomComponent();
  setTimeout(startHAListener, 3000);
  startAutomationTraceMonitor();
});

/* ─── EMBEDDED CUSTOM COMPONENT FILES ─────────────────────── */
const COMPONENT_FILES = {
  "__init__.py": `"""HA Overwatch integration."""
from __future__ import annotations
import logging
from datetime import timedelta
import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SWITCH, Platform.BINARY_SENSOR, Platform.SENSOR]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    url = entry.data[CONF_URL]

    # Zone structure coordinator — polls /ow/zones hourly
    zone_coordinator = ZoneCoordinator(hass, url)
    try:
        await zone_coordinator.async_config_entry_first_refresh()
    except Exception as err:
        raise ConfigEntryNotReady(f"Cannot reach HA Overwatch add-on: {err}") from err

    # Triggered state coordinator — polls /ow/triggered every 5s
    triggered_coordinator = TriggeredCoordinator(hass, url)
    await triggered_coordinator.async_config_entry_first_refresh()

    # Alarm effective-state coordinator — read-only sensors, no switch writes/cascade
    alarm_effective_coordinator = AlarmEffectiveCoordinator(hass, url)
    await alarm_effective_coordinator.async_config_entry_first_refresh()

    alarm_triggered_coordinator = AlarmTriggeredCoordinator(hass, url)
    await alarm_triggered_coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {
        "zone_coordinator":       zone_coordinator,
        "triggered_coordinator":  triggered_coordinator,
        "alarm_effective_coordinator": alarm_effective_coordinator,
        "alarm_triggered_coordinator": alarm_triggered_coordinator,
    }
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


class ZoneCoordinator(DataUpdateCoordinator):
    """Fetches zone/group/camera structure — changes rarely."""

    def __init__(self, hass: HomeAssistant, url: str) -> None:
        super().__init__(hass, _LOGGER, name="HA Overwatch Zones",
            update_interval=timedelta(seconds=30))
        self.url = url

    async def _async_update_data(self) -> dict:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.url}/ow/zones",
                    timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status != 200:
                        raise UpdateFailed(f"Add-on returned {resp.status}")
                    data = await resp.json(content_type=None)
                    _LOGGER.info("Overwatch: %d zones, %d groups, %d cameras",
                        len(data.get("zones", [])),
                        len(data.get("groups", [])),
                        len(data.get("cameras", [])))
                    return data
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Cannot reach add-on: {err}") from err


class TriggeredCoordinator(DataUpdateCoordinator):
    """Polls /ow/triggered every 5s for zone triggered states."""

    def __init__(self, hass: HomeAssistant, url: str) -> None:
        super().__init__(hass, _LOGGER, name="HA Overwatch Triggered",
            update_interval=timedelta(seconds=5))
        self.url = url

    async def _async_update_data(self) -> dict:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.url}/ow/triggered",
                    timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    if resp.status != 200:
                        return {}
                    return await resp.json(content_type=None)
        except aiohttp.ClientError:
            return {}


class AlarmEffectiveCoordinator(DataUpdateCoordinator):
    """Polls /ow/alarms/effective for read-only alarm effective-state sensors."""

    def __init__(self, hass: HomeAssistant, url: str) -> None:
        super().__init__(hass, _LOGGER, name="HA Overwatch Alarm Effective State",
            update_interval=timedelta(seconds=5))
        self.url = url

    async def _async_update_data(self) -> dict:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.url}/ow/alarms/effective",
                    timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    if resp.status != 200:
                        return {"alarms": []}
                    data = await resp.json(content_type=None)
                    if not isinstance(data, dict):
                        return {"alarms": []}
                    if not isinstance(data.get("alarms"), list):
                        data["alarms"] = []
                    return data
        except aiohttp.ClientError:
            return {"alarms": []}


class AlarmTriggeredCoordinator(DataUpdateCoordinator):
    """Polls /ow/alarms/triggered for alarm triggered states."""

    def __init__(self, hass: HomeAssistant, url: str) -> None:
        super().__init__(hass, _LOGGER, name="HA Overwatch Alarm Triggered", update_interval=timedelta(seconds=5))
        self.url = url

    async def _async_update_data(self) -> dict:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.url}/ow/alarms/triggered", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    if resp.status != 200:
                        return {"alarms": []}
                    data = await resp.json(content_type=None)
                    if not isinstance(data, dict):
                        return {"alarms": []}
                    if not isinstance(data.get("alarms"), list):
                        data["alarms"] = []
                    return data
        except aiohttp.ClientError:
            return {"alarms": []}
`,
  "const.py": `"""Constants for HA Overwatch integration."""
DOMAIN = "ha_overwatch"
DEFAULT_URL = "http://localhost:8099"
`,
  "config_flow.py": `"""Config flow for HA Overwatch integration."""
from __future__ import annotations
import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.const import CONF_URL
from .const import DOMAIN, DEFAULT_URL


class OverwatchConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")
        errors = {}
        if user_input is not None:
            url = user_input[CONF_URL].rstrip("/")
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(f"{url}/ow/health",
                        timeout=aiohttp.ClientTimeout(total=5)) as resp:
                        if resp.status == 200:
                            data = await resp.json(content_type=None)
                            if data.get("ok"):
                                await self.async_set_unique_id(DOMAIN)
                                self._abort_if_unique_id_configured()
                                return self.async_create_entry(title="HA Overwatch", data={CONF_URL: url})
                errors["base"] = "cannot_connect"
            except Exception:
                errors["base"] = "cannot_connect"
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_URL, default=DEFAULT_URL): str}),
            errors=errors)
`,
  "switch.py": `"""Switch platform for HA Overwatch.

Switch entities store their state in HA directly (restored across restarts).
async_turn_on/off just writes the state — HA is the single source of truth.
The dashboard reads switch states from haStates via the existing WS proxy.
Entity IDs are set explicitly to ensure predictable naming.
"""
from __future__ import annotations
import logging
from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.core import callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN
from . import ZoneCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: ZoneCoordinator = hass.data[DOMAIN][entry.entry_id]["zone_coordinator"]

    # Track which unique_ids have already been added so we can add new ones dynamically
    known_unique_ids: set[str] = set()

    def _build_entities(data: dict) -> list:
        entities = []
        # Master (always one)
        entities.append(OverwatchMasterSwitch(coordinator))
        for a in data.get("alarms", []):
            entities.append(OverwatchAlarmSwitch(coordinator, a))
        for g in data.get("groups", []):
            entities.append(OverwatchGroupSwitch(coordinator, g))
        for z in data.get("zones", []):
            entities.append(OverwatchZoneSwitch(coordinator, z))
        for f in data.get("floors", []):
            entities.append(OverwatchZoneFloorSwitch(coordinator, f))
        entities.append(OverwatchCameraAllSwitch(coordinator))
        for g in data.get("camera_groups", []):
            entities.append(OverwatchCameraGroupSwitch(coordinator, g))
        for z in data.get("camera_zones", []):
            entities.append(OverwatchCameraZoneSwitch(coordinator, z))
        for f in data.get("floors", []):
            entities.append(OverwatchCameraFloorSwitch(coordinator, f))
        for c in data.get("cameras", []):
            entities.append(OverwatchCameraSwitch(coordinator, c))
        return entities

    def _sync_entities() -> None:
        """Called on every coordinator update — adds new and removes deleted entities."""
        data = coordinator.data or {}
        all_entities = _build_entities(data)
        current_unique_ids = {e._attr_unique_id for e in all_entities}

        # Add new entities
        new_entities = [e for e in all_entities if e._attr_unique_id not in known_unique_ids]
        if new_entities:
            _LOGGER.info("Overwatch: adding %d new switch entities dynamically", len(new_entities))
            for e in new_entities:
                known_unique_ids.add(e._attr_unique_id)
            async_add_entities(new_entities, update_before_add=False)

        # Remove deleted entities from the entity registry
        removed = known_unique_ids - current_unique_ids - {"overwatch_zone_master", "overwatch_camera_all"}
        if removed:
            registry = er.async_get(hass)
            for uid in removed:
                entity_id = registry.async_get_entity_id("switch", "ha_overwatch", uid)
                if entity_id:
                    registry.async_remove(entity_id)
                    _LOGGER.info("Overwatch: removed deleted switch entity %s (uid=%s)", entity_id, uid)
            known_unique_ids.difference_update(removed)

    # Initial add
    _sync_entities()

    # Re-run on every coordinator refresh so new/deleted zones appear without HA restart
    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))


def _dev(coordinator: ZoneCoordinator) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "overwatch")},
        name="HA Overwatch",
        manufacturer="HA Overwatch",
        model="Floor Plan Dashboard",
        configuration_url=coordinator.url,
    )


class OWSwitch(CoordinatorEntity, SwitchEntity, RestoreEntity):
    """Base switch — state lives in HA, restored across restarts.
    
    entity_id is set explicitly so it is always predictable regardless
    of device name or HA naming conventions.
    """
    _attr_should_poll = False

    def __init__(self, coordinator, entity_id: str, unique_id: str, name: str, icon: str = "mdi:shield"):
        super().__init__(coordinator)
        # Set entity_id explicitly — this overrides HA's auto-generation
        self.entity_id = entity_id
        self._attr_unique_id = unique_id
        self._attr_name = name
        self._attr_icon = icon
        self._attr_device_info = _dev(coordinator)
        self._is_on = True

    @property
    def is_on(self) -> bool:
        return self._is_on

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if (state := await self.async_get_last_state()) is not None:
            self._is_on = state.state != "off"

    async def async_turn_on(self, **kwargs) -> None:
        self._is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self._is_on = False
        self.async_write_ha_state()

    @callback
    def _handle_coordinator_update(self) -> None:
        # Do not republish state on coordinator refresh — state is authoritative in HA
        pass


class OverwatchMasterSwitch(OWSwitch):
    def __init__(self, c):
        super().__init__(c,
            entity_id="switch.overwatch_zone_master",
            unique_id="overwatch_zone_master",
            name="Overwatch Zone Master",
            icon="mdi:shield-home")


class OverwatchAlarmSwitch(OWSwitch):
    def __init__(self, c, a):
        aid = a["id"]
        super().__init__(c,
            entity_id=f"switch.overwatch_alarm_{aid}",
            unique_id=f"overwatch_alarm_{aid}",
            name=f"Alarm: {a.get('name', aid)}",
            icon="mdi:shield-alert")


class OverwatchGroupSwitch(OWSwitch):
    def __init__(self, c, g):
        gid = g["id"]
        super().__init__(c,
            entity_id=f"switch.overwatch_zone_group_{gid}",
            unique_id=f"overwatch_zone_group_{gid}",
            name=f"Zone Group: {g.get('name', gid)}",
            icon="mdi:layers")


class OverwatchZoneSwitch(OWSwitch):
    def __init__(self, c, z):
        zid = z["id"]
        super().__init__(c,
            entity_id=f"switch.overwatch_zone_{zid}",
            unique_id=f"overwatch_zone_{zid}",
            name=f"Zone: {z.get('name', zid)}",
            icon="mdi:map-marker-radius")


class OverwatchZoneFloorSwitch(OWSwitch):
    def __init__(self, c, f):
        fid = f["id"]
        super().__init__(c,
            entity_id=f"switch.overwatch_zone_floor_{fid}",
            unique_id=f"overwatch_zone_floor_{fid}",
            name=f"Zone Floor: {f.get('name', fid)}",
            icon="mdi:floor-plan")


class OverwatchCameraFloorSwitch(OWSwitch):
    def __init__(self, c, f):
        fid = f["id"]
        super().__init__(c,
            entity_id=f"switch.overwatch_camera_floor_{fid}",
            unique_id=f"overwatch_camera_floor_{fid}",
            name=f"Camera Floor: {f.get('name', fid)}",
            icon="mdi:cctv")


class OverwatchCameraAllSwitch(OWSwitch):
    def __init__(self, c):
        super().__init__(c,
            entity_id="switch.overwatch_camera_all",
            unique_id="overwatch_camera_all",
            name="Camera All",
            icon="mdi:cctv")


class OverwatchCameraGroupSwitch(OWSwitch):
    def __init__(self, c, g):
        gid = g["id"]
        super().__init__(c,
            entity_id=f"switch.overwatch_camera_group_{gid}",
            unique_id=f"overwatch_camera_group_{gid}",
            name=f"Camera Group: {g.get('name', gid)}",
            icon="mdi:cctv")


class OverwatchCameraZoneSwitch(OWSwitch):
    def __init__(self, c, z):
        zid = z["id"]
        super().__init__(c,
            entity_id=f"switch.overwatch_camera_zone_{zid}",
            unique_id=f"overwatch_camera_zone_{zid}",
            name=f"Camera Zone: {z.get('name', zid)}",
            icon="mdi:cctv")


class OverwatchCameraSwitch(OWSwitch):
    def __init__(self, c, cam):
        cid = cam["id"]
        bare = cid[len("camera."):] if cid.startswith("camera.") else cid
        safe = bare.replace(".", "_").replace("-", "_")
        super().__init__(c,
            entity_id=f"switch.overwatch_camera_{safe}",
            unique_id=f"overwatch_camera_{safe}",
            name=f"Camera: {cam.get('name', cid)}",
            icon="mdi:cctv")
`,
  "binary_sensor.py": `"""Binary sensor platform for HA Overwatch.

Reads zone trigger state from /ow/triggered and alarm trigger state from
/ow/alarms/triggered. Alarm triggered entities dynamically add new renamed
entities and remove stale deleted/renamed registry entries.
"""
from __future__ import annotations
import logging
from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN
from . import TriggeredCoordinator, ZoneCoordinator, AlarmTriggeredCoordinator

_LOGGER = logging.getLogger(__name__)


def _dev(url: str) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "overwatch")},
        name="HA Overwatch",
        manufacturer="HA Overwatch",
        model="Floor Plan Dashboard",
        configuration_url=url,
    )


def _registry_entries(registry):
    return list(getattr(registry, "entities", {}).values())


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    data = hass.data[DOMAIN][entry.entry_id]
    zone_coordinator: ZoneCoordinator = data["zone_coordinator"]
    trig_coordinator: TriggeredCoordinator = data["triggered_coordinator"]
    alarm_trig_coordinator: AlarmTriggeredCoordinator | None = data.get("alarm_triggered_coordinator")
    known_unique_ids: set[str] = set()

    def _build_entities() -> list:
        zone_data = zone_coordinator.data or {}
        groups = zone_data.get("groups", [])
        zones = zone_data.get("zones", [])
        entities = [OverwatchMasterTriggered(trig_coordinator, zone_coordinator)]
        entities.extend(OverwatchGroupTriggered(trig_coordinator, g) for g in groups)
        entities.extend(OverwatchZoneTriggered(trig_coordinator, z) for z in zones)
        if alarm_trig_coordinator:
            alarms = (alarm_trig_coordinator.data or {}).get("alarms", [])
            entities.extend(OverwatchAlarmTriggeredArmed(alarm_trig_coordinator, a) for a in alarms)
            entities.extend(OverwatchAlarmTriggeredDisarmed(alarm_trig_coordinator, a) for a in alarms)
        return entities

    def _remove_stale_registry_entries(current_unique_ids: set[str]) -> None:
        registry = er.async_get(hass)
        for reg_entry in _registry_entries(registry):
            if getattr(reg_entry, "platform", None) != DOMAIN:
                continue
            if getattr(reg_entry, "domain", None) != "binary_sensor":
                continue
            uid = getattr(reg_entry, "unique_id", "") or ""
            is_alarm_trigger = uid.startswith("overwatch_alarm_") and (uid.endswith("_triggered_armed") or uid.endswith("_triggered_disarmed"))
            if not is_alarm_trigger:
                continue
            if uid in current_unique_ids:
                continue
            entity_id = getattr(reg_entry, "entity_id", None)
            if entity_id:
                registry.async_remove(entity_id)
                _LOGGER.info("Overwatch: removed stale alarm triggered binary sensor %s (uid=%s)", entity_id, uid)
            known_unique_ids.discard(uid)

    def _sync_entities() -> None:
        entities = _build_entities()
        current_unique_ids = {e._attr_unique_id for e in entities}
        _remove_stale_registry_entries(current_unique_ids)

        new_entities = [e for e in entities if e._attr_unique_id not in known_unique_ids]
        if new_entities:
            _LOGGER.info("Overwatch: adding %d binary sensor entities", len(new_entities))
            for e in new_entities:
                known_unique_ids.add(e._attr_unique_id)
            async_add_entities(new_entities, update_before_add=False)

        removed = known_unique_ids - current_unique_ids - {"overwatch_zone_master_triggered"}
        if removed:
            registry = er.async_get(hass)
            for uid in removed:
                entity_id = registry.async_get_entity_id("binary_sensor", DOMAIN, uid)
                if entity_id:
                    registry.async_remove(entity_id)
                    _LOGGER.info("Overwatch: removed deleted binary sensor %s (uid=%s)", entity_id, uid)
            known_unique_ids.difference_update(removed)

    _sync_entities()
    entry.async_on_unload(zone_coordinator.async_add_listener(_sync_entities))
    if alarm_trig_coordinator:
        entry.async_on_unload(alarm_trig_coordinator.async_add_listener(_sync_entities))


class OWSensor(CoordinatorEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.MOTION
    _attr_should_poll = False

    def __init__(self, coord, entity_id: str, unique_id: str, name: str, url: str) -> None:
        super().__init__(coord)
        self._attr_unique_id = unique_id
        self._attr_name = name
        self.entity_id = entity_id
        self._attr_device_info = _dev(url)


class OverwatchMasterTriggered(OWSensor):
    def __init__(self, trig: TriggeredCoordinator, zone_coord: ZoneCoordinator) -> None:
        super().__init__(trig,
            entity_id="binary_sensor.overwatch_zone_master_triggered",
            unique_id="overwatch_zone_master_triggered",
            name="Overwatch Zone Master Triggered",
            url=trig.url)
        self._zone_coord = zone_coord

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return any(bool(v) for v in data.values())


class OverwatchGroupTriggered(OWSensor):
    def __init__(self, trig: TriggeredCoordinator, g: dict) -> None:
        gid = g["id"]
        super().__init__(trig,
            entity_id=f"binary_sensor.overwatch_zone_group_{gid}_triggered",
            unique_id=f"overwatch_zone_group_{gid}_triggered",
            name=f"Zone Group Triggered: {g.get('name', gid)}",
            url=trig.url)
        self._zone_ids = g.get("zone_ids", [])

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return any(bool(data.get(zid)) for zid in self._zone_ids)


class OverwatchZoneTriggered(OWSensor):
    def __init__(self, trig: TriggeredCoordinator, z: dict) -> None:
        zid = z["id"]
        sid = z.get("slug") or z.get("id")
        super().__init__(trig,
            entity_id=f"binary_sensor.overwatch_zone_{sid}_triggered",
            unique_id=f"overwatch_zone_{sid}_triggered",
            name=f"Zone Triggered: {z.get('name', zid)}",
            url=trig.url)
        self._zid = sid

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get(self._zid))


class OverwatchAlarmTriggeredBase(CoordinatorEntity, BinarySensorEntity):
    _attr_should_poll = False
    _attr_device_class = BinarySensorDeviceClass.MOTION

    def __init__(self, coord: AlarmTriggeredCoordinator, alarm: dict, suffix: str, name_suffix: str) -> None:
        super().__init__(coord)
        aid = str(alarm.get("id") or alarm.get("raw_id") or alarm.get("name") or "alarm")
        self._alarm_id = aid
        self.entity_id = f"binary_sensor.overwatch_alarm_{aid}_{suffix}"
        self._attr_unique_id = f"overwatch_alarm_{aid}_{suffix}"
        self._attr_name = f"Alarm: {alarm.get('name') or aid} {name_suffix}"
        self._attr_device_info = _dev(coord.url)

    def _alarm_state(self) -> dict:
        for a in (self.coordinator.data or {}).get("alarms", []):
            if str(a.get("id") or a.get("raw_id") or "") == self._alarm_id:
                return a
        return {}

    @property
    def extra_state_attributes(self) -> dict:
        a = self._alarm_state()
        return {
            "alarm_id": a.get("id"),
            "raw_id": a.get("raw_id"),
            "warn_no_filters": a.get("warn_no_filters", False),
            "filters": a.get("filters", {}),
            "triggered_zones": a.get("triggered_zones", []),
            "state": a.get("state"),
            "generated_at": (self.coordinator.data or {}).get("generated_at"),
        }


class OverwatchAlarmTriggeredArmed(OverwatchAlarmTriggeredBase):
    def __init__(self, coord: AlarmTriggeredCoordinator, alarm: dict) -> None:
        super().__init__(coord, alarm, "triggered_armed", "Triggered Armed")

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_state().get("triggered_armed"))


class OverwatchAlarmTriggeredDisarmed(OverwatchAlarmTriggeredBase):
    def __init__(self, coord: AlarmTriggeredCoordinator, alarm: dict) -> None:
        super().__init__(coord, alarm, "triggered_disarmed", "Triggered Disarmed")

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_state().get("triggered_disarmed"))
`,
  "sensor.py": `"""Sensor platform for HA Overwatch alarm effective states.

Read-only alarm effective-state sensors. Alarm effective sensors dynamically add
new renamed entities and remove stale deleted/renamed registry entries, matching
switch/platform lifecycle behaviour.
"""
from __future__ import annotations
import logging
import re
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN
from . import AlarmEffectiveCoordinator

_LOGGER = logging.getLogger(__name__)


def _slug(value: str) -> str:
    raw = str(value or "").lower()
    raw = re.sub(r"[^a-z0-9]+", "_", raw).strip("_")
    return raw or "alarm"


def _alarm_slug(alarm: dict) -> str:
    # Server alarm payload id is the current HA-facing alarm slug.
    return _slug(alarm.get("id") or alarm.get("name") or alarm.get("raw_id") or "alarm")


def _dev(url: str) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "overwatch")},
        name="HA Overwatch",
        manufacturer="HA Overwatch",
        model="Floor Plan Dashboard",
        configuration_url=url,
    )


def _registry_entries(registry):
    return list(getattr(registry, "entities", {}).values())


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: AlarmEffectiveCoordinator = hass.data[DOMAIN][entry.entry_id]["alarm_effective_coordinator"]
    known_unique_ids: set[str] = set()

    def _build_entities() -> list[OverwatchAlarmEffectiveSensor]:
        alarms = (coordinator.data or {}).get("alarms", [])
        return [OverwatchAlarmEffectiveSensor(coordinator, alarm) for alarm in alarms]

    def _remove_stale_registry_entries(current_unique_ids: set[str]) -> None:
        registry = er.async_get(hass)
        for reg_entry in _registry_entries(registry):
            if getattr(reg_entry, "platform", None) != DOMAIN:
                continue
            if getattr(reg_entry, "domain", None) != "sensor":
                continue
            uid = getattr(reg_entry, "unique_id", "") or ""
            if not (uid.startswith("overwatch_alarm_") and uid.endswith("_effective_state")):
                continue
            if uid in current_unique_ids:
                continue
            entity_id = getattr(reg_entry, "entity_id", None)
            if entity_id:
                registry.async_remove(entity_id)
                _LOGGER.info("Overwatch: removed stale alarm effective sensor %s (uid=%s)", entity_id, uid)
            known_unique_ids.discard(uid)

    def _sync_entities() -> None:
        entities = _build_entities()
        current_unique_ids = {e._attr_unique_id for e in entities}
        _remove_stale_registry_entries(current_unique_ids)

        new_entities = [e for e in entities if e._attr_unique_id not in known_unique_ids]
        if new_entities:
            _LOGGER.info("Overwatch: adding %d alarm effective sensor entities", len(new_entities))
            for e in new_entities:
                known_unique_ids.add(e._attr_unique_id)
            async_add_entities(new_entities, update_before_add=False)

        removed = known_unique_ids - current_unique_ids
        if removed:
            registry = er.async_get(hass)
            for uid in removed:
                entity_id = registry.async_get_entity_id("sensor", DOMAIN, uid)
                if entity_id:
                    registry.async_remove(entity_id)
                    _LOGGER.info("Overwatch: removed deleted alarm effective sensor %s (uid=%s)", entity_id, uid)
            known_unique_ids.difference_update(removed)

    _sync_entities()
    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))


class OverwatchAlarmEffectiveSensor(CoordinatorEntity, SensorEntity):
    """Read-only effective state sensor for one HA-Overwatch alarm profile."""

    _attr_should_poll = False
    _attr_icon = "mdi:shield-alert"

    def __init__(self, coordinator: AlarmEffectiveCoordinator, alarm: dict) -> None:
        super().__init__(coordinator)
        self._slug = _alarm_slug(alarm)
        self._attr_unique_id = f"overwatch_alarm_{self._slug}_effective_state"
        self._attr_name = f"Alarm: {alarm.get('name') or self._slug}"
        self.entity_id = f"sensor.overwatch_alarm_{self._slug}"
        self._attr_device_info = _dev(coordinator.url)

    def _alarm(self) -> dict:
        for alarm in (self.coordinator.data or {}).get("alarms", []):
            if _alarm_slug(alarm) == self._slug:
                return alarm
        return {}

    @property
    def native_value(self) -> str:
        alarm = self._alarm()
        return str(alarm.get("state") or "unknown")

    @property
    def extra_state_attributes(self) -> dict:
        alarm = self._alarm()
        return {
            "raw_id": alarm.get("raw_id"),
            "alarm_id": alarm.get("id", self._slug),
            "name": alarm.get("name"),
            "role": alarm.get("role"),
            "builtin": alarm.get("builtin"),
            "selected_zones": alarm.get("selected_zones", 0),
            "active_zones": alarm.get("active_zones", 0),
            "suppressed_zones": alarm.get("suppressed_zones", 0),
            "suppression_reasons": alarm.get("suppression_reasons", []),
            "generated_at": (self.coordinator.data or {}).get("generated_at"),
        }
`,
  "manifest.json": `{
  "domain": "ha_overwatch",
  "name": "HA Overwatch",
  "version": "1.14.8",
  "documentation": "https://github.com/DM-AU/ha-overwatch",
  "issue_tracker": "https://github.com/DM-AU/ha-overwatch/issues",
  "codeowners": [],
  "requirements": [],
  "dependencies": [],
  "after_dependencies": [],
  "config_flow": true,
  "iot_class": "local_push",
  "icon": "mdi:security"
}
`,
  "strings.json": `{
  "config": {
    "step": {
      "user": {
        "title": "HA Overwatch",
        "description": "Connect to the HA Overwatch add-on. Make sure it is installed and running.",
        "data": { "url": "Add-on URL" }
      }
    },
    "error": { "cannot_connect": "Cannot connect to HA Overwatch add-on.", "unknown": "Unexpected error." },
    "abort": { "already_configured": "HA Overwatch is already configured." }
  }
}
`,
  "translations/en.json": `{
  "config": {
    "step": {
      "user": {
        "title": "HA Overwatch",
        "description": "Connect to the HA Overwatch add-on. Make sure it is installed and running.",
        "data": { "url": "Add-on URL" }
      }
    },
    "error": { "cannot_connect": "Cannot connect to HA Overwatch add-on.", "unknown": "Unexpected error." },
    "abort": { "already_configured": "HA Overwatch is already configured." }
  }
}
`,
  // Icon written as binary Buffer — picked up by HA for the integration card
  "icon.png": Buffer.from("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", "base64"),
};
/* ─── CUSTOM COMPONENT WRITER ──────────────────────────────── */
// Files embedded directly in server.js — no external source files needed.
function writeCustomComponent() {
  if (!process.env.SUPERVISOR_TOKEN) return;
  const destDir = "/config/custom_components/ha_overwatch";
  try {
    fs.mkdirSync(path.join(destDir, "translations"), { recursive: true });
    let written = 0;
    for (const [fname, content] of Object.entries(COMPONENT_FILES)) {
      const dest = path.join(destDir, fname);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (Buffer.isBuffer(content)) {
        fs.writeFileSync(dest, content); // binary — no encoding
      } else {
        fs.writeFileSync(dest, content, "utf8");
      }
      written++;
    }
    console.log(`[HA-Overwatch] Custom component written to ${destDir} (${written} files)`);

    // Also write icon to /config/www/brands/ — this is where HA loads custom integration icons from
    const brandsDir = "/config/www/brands/ha_overwatch";
    fs.mkdirSync(brandsDir, { recursive: true });
    const iconBuf = COMPONENT_FILES["icon.png"];
    if (Buffer.isBuffer(iconBuf)) {
      fs.writeFileSync(path.join(brandsDir, "icon.png"),  iconBuf);
      fs.writeFileSync(path.join(brandsDir, "logo.png"),  iconBuf);
      console.log(`[HA-Overwatch] Brand icon written to ${brandsDir}`);
    }

    console.log(`[HA-Overwatch] Restart Home Assistant to activate the HA Overwatch integration.`);
  } catch (e) {
    console.error("[HA-Overwatch] Failed to write custom component:", e.message);
  }
}


/* ─── SERVER-SIDE HA WEBSOCKET LISTENER ────────────────────── */
// Maintains a persistent server-to-HA WebSocket connection.
// Watches zone sensor states and updates serverState.triggeredZones,
// then pushes binary_sensor states to HA whenever a zone triggers/clears.
/* ─── SERVER-SIDE HA STATE LISTENER ────────────────────────── */
// Watches HA entity state changes via supervisor WebSocket API.
// When a zone's sensors trigger/clear, pushes binary_sensor state to HA.
// Uses supervisor token + internal supervisor API — no login warnings.

// Calculate byte length of a WebSocket frame (used by startHAListener)
function frameLength(buf) {
  if (buf.length < 2) return -1;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return -1;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    // 8-byte extended payload length (used for messages > 65535 bytes e.g. get_states response)
    if (buf.length < 10) return -1;
    // JS can't handle full 64-bit ints safely; upper 4 bytes should be 0 for any realistic payload
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    if (hi > 0) return -1; // >4GB payload — not realistic, bail
    len = lo;
    offset = 10;
  }
  const masked = (buf[1] & 0x80) !== 0;
  if (masked) offset += 4;
  return offset + len;
}

function startHAListener() {
  if (!process.env.SUPERVISOR_TOKEN) return;

  let reconnectDelay = 5000;
  function connect() {
    const crypto = require("crypto");
    const wsKey  = crypto.randomBytes(16).toString("base64");

    // Use supervisor internal hostname — avoids "login failed" warnings
    const haReq = http.request({
      hostname: "supervisor",
      port:     80,
      path:     "/core/api/websocket",
      headers: {
        "Host":                  "supervisor",
        "Upgrade":               "websocket",
        "Connection":            "Upgrade",
        "Sec-WebSocket-Key":     wsKey,
        "Sec-WebSocket-Version": "13",
        "Authorization":         `Bearer ${process.env.SUPERVISOR_TOKEN}`,
      },
    });

    haReq.on("upgrade", (haRes, sock) => {
      console.log("[HA-Overwatch] HA listener connected via supervisor API");
      reconnectDelay = 5000;
      let buf = Buffer.alloc(0);
      let connected = true;

      function send(obj) {
        const id = haMsgId++;
        sendWsFrame(sock, JSON.stringify({ ...obj, id }));
        return id;
      }
      haListenerSend = send; // expose for registry refresh endpoint

      // Send a ping every 30s to keep connection alive
      const pingTimer = setInterval(() => {
        if (!connected) { clearInterval(pingTimer); return; }
        try {
          // WS ping frame: opcode 0x9, no payload
          sock.write(Buffer.from([0x89, 0x00]));
        } catch { clearInterval(pingTimer); }
      }, 30000);

      sock.on("data", chunk => {
        if (!connected || buf === null) return;
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const used = frameLength(buf);
          if (used <= 0 || buf.length < used) break;
          const frame = buf.slice(0, used);
          buf = buf.slice(used);
          const text = extractWsPayload(frame);
          if (text !== null) {
            try { handleMsg(JSON.parse(text), send, sock); } catch {}
          }
          // Non-text frames (ping/pong/close) are silently consumed
        }
      });

      sock.on("close", () => {
        if (!connected) return;
        connected = false;
        haListenerSend = null;
        clearInterval(pingTimer);
        buf = null; // release buffer memory
        console.log("[HA-Overwatch] HA listener disconnected");
        scheduleReconnect();
      });
      sock.on("error", e => {
        if (!connected) return;
        connected = false;
        haListenerSend = null;
        clearInterval(pingTimer);
        buf = null; // release buffer memory
        console.error("[HA-Overwatch] HA listener error:", e.message);
        scheduleReconnect();
      });
    });

    haReq.on("error", e => {
      console.error("[HA-Overwatch] HA listener connect error:", e.message);
      scheduleReconnect();
    });

    haReq.end();
  }

  const triggeredZones = {};  // "zone.id::sensor_id" -> bool, "zone.id" -> bool
  let   cachedZones    = [];  // refreshed every 60s and on auth_ok
  let   sensorToZones  = {};  // entityId -> [zone, ...] for fast lookup
  let   zoneCacheTimer = null; // tracked so we don't stack intervals on reconnect

  function refreshZoneCache() {
    cachedZones   = loadZones();
    sensorToZones = {};
    cachedZones.forEach(zone => {
      (zone.sensors || []).forEach(sid => {
        if (!sensorToZones[sid]) sensorToZones[sid] = [];
        sensorToZones[sid].push(zone);
      });
    });
    const sensorCount = Object.keys(sensorToZones).length;
    console.log(`[HA-Overwatch] Zone cache: ${cachedZones.length} zones, ${sensorCount} unique sensors tracked`);
  }

  function handleMsg(msg, send, sock) {
    if (msg.type === "auth_required") {
      sendWsFrame(sock, JSON.stringify({
        type: "auth", access_token: process.env.SUPERVISOR_TOKEN,
      }));
      return;
    }
    if (msg.type === "auth_ok") {
      refreshZoneCache();
      if (zoneCacheTimer) clearInterval(zoneCacheTimer);
      zoneCacheTimer = setInterval(refreshZoneCache, 60000); // keep cache fresh
      send({ type: "subscribe_events", event_type: "state_changed" });
      // Fetch all current entity states into cache for /ow/states endpoint
      send({ type: "get_states" });
      // Fetch HA registries through the same forced-refresh path used by the Sync button.
      // This keeps message IDs/callbacks consistent and avoids stale area/device/entity mappings.
      refetchHARegistry();
      return;
    }
    // Populate serverHaStates from get_states response
    // Also handle registry responses
    if (msg.type === "result" && Array.isArray(msg.result)) {
      const regType = haRegistryCallbacks[msg.id];
      if (regType) {
        delete haRegistryCallbacks[msg.id];
        haRegistry[regType] = msg.result;
        // Mark loaded once we have all four responses (even if some are empty arrays)
        haRegistry[`_got_${regType}`] = true;
        if (haRegistry._got_floors && haRegistry._got_areas && haRegistry._got_devices && haRegistry._got_entities) {
          haRegistry.loaded = true;
          haRegistry.refreshing = false;
          haRegistry.completed_at = new Date().toISOString();
          console.log(`[HA-Overwatch] Registry loaded: ${haRegistry.floors.length} floors, ${haRegistry.areas.length} areas, ${haRegistry.devices.length} devices, ${haRegistry.entities.length} entities`);
        }
        return;
      }
      msg.result.forEach(st => { if (st.entity_id) serverHaStates[st.entity_id] = st; });
      console.log(`[HA-Overwatch] State cache populated: ${Object.keys(serverHaStates).length} entities`);
      // Seed triggered zone state from current HA states — catches sensors already on at startup
      // Without this, zones stay un-triggered until the next state_changed event
      let seeded = 0;
      Object.values(serverHaStates).forEach(st => {
        if (st.entity_id && st.state) {
          if (sensorToZones[st.entity_id]) {
            onStateChanged(st.entity_id, st.state);
            seeded++;
          }
        }
      });
      if (seeded > 0) console.log(`[HA-Overwatch] Seeded triggered state for ${seeded} zone sensors`);
      return;
    }
    if (msg.type === "event" && msg.event?.event_type === "state_changed") {
      const { entity_id, new_state } = msg.event.data || {};
      if (!entity_id || !new_state) return;
      // Keep full state cache up to date
      serverHaStates[entity_id] = new_state;
      const inZone = !!sensorToZones[entity_id]?.length;
      if (inZone) {
        console.log(`[HA-Overwatch] state_changed: ${entity_id} → ${new_state.state} (zone sensor)`);
      }
      onStateChanged(entity_id, new_state.state || "");
      // Cascade switch state changes server-side so /ow/states stays consistent
      // without relying on any browser being connected
      cascadeSwitchState(entity_id, new_state.state || "");
    }

    // Log a heartbeat every 50 events so we can confirm events are flowing
    if (msg.type === "event") {
      haListenerEventCount = (haListenerEventCount || 0) + 1;
      if (haListenerEventCount === 1) {
        console.log(`[HA-Overwatch] HA listener: first state_changed event received`);
      }
      if (haListenerEventCount % 50 === 0) {
        console.log(`[HA-Overwatch] HA listener: ${haListenerEventCount} events received`);
      }
    }
  }

  // Call a HA switch service via supervisor REST API (fire-and-forget)
  function callHASwitch(entityId, on) {
    if (!process.env.SUPERVISOR_TOKEN) return;
    // Update local cache immediately so next /ow/states poll reflects it
    // Create a stub if entity not yet in cache (e.g. newly created floor entity)
    serverHaStates[entityId] = {
      ...(serverHaStates[entityId] || { entity_id: entityId, attributes: {} }),
      state: on ? 'on' : 'off',
    };
    const body = JSON.stringify({ entity_id: entityId });
    const req = http.request({
      hostname: 'supervisor', port: 80,
      path: `/core/api/services/switch/${on ? 'turn_on' : 'turn_off'}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPERVISOR_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => res.resume());
    req.on('error', e => console.error(`[HA-Overwatch] callHASwitch error (${entityId}):`, e.message));
    req.write(body);
    req.end();
  }

  // Cascade switch state changes server-side — mirrors what app.js does in the browser
  // This ensures /ow/states is always consistent regardless of any browser being open
  function cascadeSwitchState(entityId, state) {
    // Only process overwatch switch entities — skip sensors, cameras, etc.
    if (!entityId.startsWith('switch.overwatch_')) return;
    const on = (state || '').toLowerCase() !== 'off';

    // Zone master → all groups + zones
    if (entityId === 'switch.overwatch_zone_master') {
      console.log(`[HA-Overwatch] Cascade: zone master → ${on ? 'on' : 'off'}`);
      const allZones  = loadZones();
      const allGroups = loadGroups();
      allGroups.forEach(g => callHASwitch(`switch.overwatch_zone_group_${nameSlug(g.name) || g.id}`, on));
      allZones.forEach(z  => callHASwitch(`switch.overwatch_zone_${nameSlug(z.name) || z.id}`, on));
      return;
    }

    // Zone group → member zones
    if (entityId.startsWith('switch.overwatch_zone_group_')) {
      const slug = entityId.replace('switch.overwatch_zone_group_', '');
      const allGroups = loadGroups();
      const allZones  = loadZones();
      const group = allGroups.find(g => (nameSlug(g.name) || g.id) === slug);
      if (group) {
        console.log(`[HA-Overwatch] Cascade: zone group ${slug} → ${on ? 'on' : 'off'}`);
        (group.zone_ids || []).forEach(zid => {
          const z = allZones.find(z => z.id === zid);
          if (z) callHASwitch(`switch.overwatch_zone_${nameSlug(z.name) || z.id}`, on);
        });
      }
      return;
    }

    // Camera all → all camera zones + cameras
    if (entityId === 'switch.overwatch_camera_all') {
      console.log(`[HA-Overwatch] Cascade: camera all → ${on ? 'on' : 'off'}`);
      const allZones = loadZones();
      allZones.forEach(z => {
        if ((z.cameras || []).length > 0) {
          callHASwitch(`switch.overwatch_camera_zone_${nameSlug(z.name) || z.id}`, on);
          (z.cameras || []).forEach(camId => {
            const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
            callHASwitch(`switch.overwatch_camera_${safe}`, on);
          });
        }
      });
      return;
    }

    // Camera group → member camera zones + cameras
    if (entityId.startsWith('switch.overwatch_camera_group_')) {
      const slug = entityId.replace('switch.overwatch_camera_group_', '');
      const allGroups = loadGroups();
      const allZones  = loadZones();
      const group = allGroups.find(g => (nameSlug(g.name) || g.id) === slug);
      if (group) {
        console.log(`[HA-Overwatch] Cascade: camera group ${slug} → ${on ? 'on' : 'off'}`);
        (group.zone_ids || []).forEach(zid => {
          const z = allZones.find(z => z.id === zid);
          if (z && (z.cameras || []).length > 0) {
            callHASwitch(`switch.overwatch_camera_zone_${nameSlug(z.name) || z.id}`, on);
            (z.cameras || []).forEach(camId => {
              const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
              callHASwitch(`switch.overwatch_camera_${safe}`, on);
            });
          }
        });
      }
      return;
    }

    // Camera zone → member cameras
    if (entityId.startsWith('switch.overwatch_camera_zone_')) {
      const slug = entityId.replace('switch.overwatch_camera_zone_', '');
      const allZones = loadZones();
      const zone = allZones.find(z => (nameSlug(z.name) || z.id) === slug);
      if (zone && (zone.cameras || []).length > 0) {
        console.log(`[HA-Overwatch] Cascade: camera zone ${slug} → ${on ? 'on' : 'off'}`);
        (zone.cameras || []).forEach(camId => {
          const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
          callHASwitch(`switch.overwatch_camera_${safe}`, on);
        });
      }
      return;
    }

    // Zone floor → all zones on that floor
    if (entityId.startsWith('switch.overwatch_zone_floor_')) {
      const fid = entityId.replace('switch.overwatch_zone_floor_', '');
      const allZones  = loadZones();
      const allFloors = loadFloors();
      const isFirstFloor = allFloors.length === 0 || allFloors[0].id === fid;
      // Zones with no floor_id belong to the first floor
      const floorZones = allZones.filter(z => z.floor_id === fid || (!z.floor_id && isFirstFloor));
      console.log(`[HA-Overwatch] Zone floor cascade: fid=${fid}, allZones=${allZones.length}, matched=${floorZones.length}`);
      floorZones.forEach(z => callHASwitch(`switch.overwatch_zone_${nameSlug(z.name) || z.id}`, on));
      return;
    }

    // Camera floor → all camera zones + cameras on that floor
    if (entityId.startsWith('switch.overwatch_camera_floor_')) {
      const fid = entityId.replace('switch.overwatch_camera_floor_', '');
      const allZones  = loadZones();
      const allFloors = loadFloors();
      const isFirstFloor = allFloors.length === 0 || allFloors[0].id === fid;
      // Zones with no floor_id belong to the first floor
      const floorZones = allZones.filter(z =>
        (z.floor_id === fid || (!z.floor_id && isFirstFloor)) && (z.cameras || []).length > 0);
      console.log(`[HA-Overwatch] Camera floor cascade: fid=${fid}, allZones=${allZones.length}, matched=${floorZones.length}`);
      floorZones.forEach(z => {
        callHASwitch(`switch.overwatch_camera_zone_${nameSlug(z.name) || z.id}`, on);
        (z.cameras || []).forEach(camId => {
          const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
          callHASwitch(`switch.overwatch_camera_${safe}`, on);
        });
      });
      return;
    }
  }

  function onStateChanged(entityId, state) {
    const zones = sensorToZones[entityId];
    if (!zones || !zones.length) return; // not a tracked sensor — fast exit

    console.log(`[HA-Overwatch] Sensor state: ${entityId} → ${state} (affects ${zones.length} zone(s))`);
    const triggered = ["on","open","detected","home","triggered","motion"]
      .includes((state || "").toLowerCase());

    zones.forEach(zone => {
      const wasTriggered = !!triggeredZones[zone.id];
      triggeredZones[`${zone.id}::${entityId}`] = triggered;
      const zoneNowTriggered = (zone.sensors || []).some(sid =>
        triggeredZones[`${zone.id}::${sid}`] === true);
      if (zoneNowTriggered !== wasTriggered) {
        triggeredZones[zone.id] = zoneNowTriggered;
        // Update global state so /ow/triggered endpoint reflects current state
        const slug = nameSlug(zone.name) || zone.id;
        globalTriggeredZones[slug] = zoneNowTriggered;
        pushBinarySensor(zone, zoneNowTriggered);
      }
    });
  }

  function pushBinarySensor(zone, isTriggered) {
    // Disabled in 0.05.06-server-hotfix1: generated binary_sensor entities poll /ow/triggered.
    // Direct /api/states pushes can leave stale triggered states after entity exclusions/reloads.
    return;
    if (!process.env.SUPERVISOR_TOKEN) return;
    const slug     = nameSlug(zone.name) || zone.id;
    const entityId = `binary_sensor.overwatch_zone_${slug}_triggered`;
    const name     = `Zone Triggered: ${zone.name || zone.id}`;
    console.log(`[HA-Overwatch] Binary sensor push: ${entityId} → ${isTriggered ? "on" : "off"}`);
    const body = JSON.stringify({
      state: isTriggered ? "on" : "off",
      attributes: { friendly_name: name, device_class: "motion" },
    });
    const req = http.request({
      hostname: "supervisor",
      port:     80,
      path:     `/core/api/states/${entityId}`,
      method:   "POST",
      headers:  {
        "Authorization":  `Bearer ${process.env.SUPERVISOR_TOKEN}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      console.log(`[HA-Overwatch] Binary sensor push response: ${res.statusCode} for ${entityId}`);
      res.resume();
    });
    req.on("error", e => console.error(`[HA-Overwatch] Binary sensor push error: ${e.message}`));
    req.write(body);
    req.end();
  }

  let reconnectScheduled = false;
  function scheduleReconnect() {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    setTimeout(() => { reconnectScheduled = false; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  }

  connect();
}

// WebSocket proxy — only active in add-on mode (SUPERVISOR_TOKEN present).
// Uses the ha_token stored in ui.yaml (entered once by user in Settings).
// This is the only reliable way to authenticate with HA Core WebSocket from an add-on.
server.on("upgrade", (req, socket, head) => {
  const supervisorToken = process.env.SUPERVISOR_TOKEN;
  if (!supervisorToken) { socket.destroy(); return; }

  const url = req.url || "";
  if (!url.includes("websocket")) { socket.destroy(); return; }

  console.log("[HA-Overwatch] WebSocket → proxying to HA");

  // Cache browser WS key before async operations
  socket._cachedKey = req.headers["sec-websocket-key"] || "";

  // Load ha_token from ui.yaml — the user enters this once in Settings
  const cfg      = loadConfig();
  const haToken  = cfg.ha_token || "";

  if (!haToken) {
    console.log("[HA-Overwatch] WS proxy: no ha_token in ui.yaml — browser must connect directly");
    // Don't proxy — let browser handle it (will fail without token, shows message to user)
    socket.destroy();
    return;
  }

  openWSProxy(socket, haToken);
});

function openWSProxy(socket, haToken) {
  const crypto     = require("crypto");
  const browserKey = socket._cachedKey || "";

  // Complete the browser WebSocket handshake
  const acceptKey = crypto.createHash("sha1")
    .update(browserKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    "\r\n"
  );

  // Connect via supervisor API — avoids external auth/login warning events
  const supervisorTok = process.env.SUPERVISOR_TOKEN || "";
  const haReq = http.request({
    hostname: "supervisor",
    port:     80,
    path:     "/core/api/websocket",
    headers: {
      "Host":                  "supervisor",
      "Upgrade":               "websocket",
      "Connection":            "Upgrade",
      "Sec-WebSocket-Key":     crypto.randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
      "Authorization":         `Bearer ${supervisorTok}`,
    },
  });

  haReq.on("upgrade", (haRes, haSocket, haHead) => {
    console.log("[HA-Overwatch] WS proxy: HA upgrade successful");

    let authState = "waiting_for_ha"; // waiting_for_ha → forwarded_to_browser → done
    let haBuf     = haHead.length > 0 ? Buffer.from(haHead) : Buffer.alloc(0);
    let broBuf    = Buffer.alloc(0); // browser data buffer during auth

    // HA → Browser
    function processHAData(chunk) {
      if (authState === "done") { try { socket.write(chunk); } catch {} return; }
      haBuf = Buffer.concat([haBuf, chunk]);
      const payload = extractWsPayload(haBuf);
      if (payload === null) return;

      try {
        const msg = JSON.parse(payload);
        console.log("[HA-Overwatch] WS proxy HA msg:", msg.type);

        if (authState === "waiting_for_ha" && msg.type === "auth_required") {
          // Self-auth using SUPERVISOR_TOKEN — don't involve browser
          const tok = process.env.SUPERVISOR_TOKEN || haToken;
          sendWsFrame(haSocket, JSON.stringify({ type: "auth", access_token: tok }));
          haBuf = Buffer.alloc(0);
          authState = "forwarded_to_browser";
          return;
        }

        if (msg.type === "auth_ok" || msg.type === "auth_invalid") {
          console.log("[HA-Overwatch] WS proxy: auth result from HA:", msg.type);
          try { socket.write(haBuf); } catch {}
          haBuf = Buffer.alloc(0);
          authState = "done";
          // Flush any buffered browser data
          if (broBuf.length > 0) { try { haSocket.write(broBuf); } catch {} broBuf = Buffer.alloc(0); }
          return;
        }
      } catch {}

      try { socket.write(haBuf); } catch {}
      haBuf = Buffer.alloc(0);
      authState = "done";
    }

    // Browser → HA: intercept auth message and replace token
    function processBrowserData(chunk) {
      // Always inspect browser data for auth messages first — even after authState=done.
      // The browser sends its auth token AFTER receiving auth_ok (because it processed
      // auth_required → sends auth token). By then authState is already "done" and without
      // this guard the browser's auth message gets forwarded to HA, which closes the
      // connection with code 1000 since it already authenticated successfully.
      const parsed = tryParseWsFrame(chunk);
      if (parsed !== null) {
        try {
          const msg = JSON.parse(parsed);
          if (msg.type === "auth") {
            // Silently discard — proxy already authenticated via SUPERVISOR_TOKEN.
            // Never forward browser auth messages to HA regardless of authState.
            if (authState !== "done") broBuf = Buffer.alloc(0);
            console.log("[HA-Overwatch] WS proxy: suppressed browser auth message (authState=" + authState + ")");
            return;
          }
        } catch {}
      }

      if (authState === "done") { try { haSocket.write(chunk); } catch {} return; }

      // Buffer browser data during auth exchange
      broBuf = Buffer.concat([broBuf, chunk]);
      const payload = extractWsPayload(broBuf);
      if (payload === null) return;

      try {
        const msg = JSON.parse(payload);
        if (msg.type === "auth") {
          // Discard — already authed with SUPERVISOR_TOKEN when HA sent auth_required
          console.log("[HA-Overwatch] WS proxy: discarding browser auth (already authed via supervisor)");
          broBuf = Buffer.alloc(0);
          return;
        }
      } catch {}

      // Not an auth message — forward as-is
      try { haSocket.write(broBuf); } catch {}
      broBuf = Buffer.alloc(0);
    }

    if (haBuf.length > 0) processHAData(Buffer.alloc(0));
    haSocket.on("data",  processHAData);
    haSocket.on("end",   () => { try { socket.end();     } catch {} });
    haSocket.on("error", e  => { console.error("[HA-Overwatch] WS HA error:", e.message); socket.destroy(); });

    socket.on("data",  processBrowserData);
    socket.on("end",   () => { try { haSocket.end();    } catch {} });
    socket.on("error", () => { haSocket.destroy(); });
  });

  haReq.on("error", e => {
    console.error("[HA-Overwatch] WS proxy request error:", e.message);
    socket.destroy();
  });
  haReq.end();
}

// Extract payload string from a WebSocket frame (text frames only, unmasked)
// Try to parse the FIRST WebSocket text frame from buf (handles masked browser frames).
// Returns the payload string if a complete frame is found, null otherwise.
// Unlike extractWsPayload, this handles masked frames from the browser side.
function tryParseWsFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode !== 1) return null; // only text frames
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2); const lo = buf.readUInt32BE(6);
    if (hi > 0) return null;
    len = lo; offset = 10;
  }
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.slice(offset, offset + len));
  if (masked) {
    const mask = buf.slice(offset - 4, offset);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return payload.toString("utf8");
}

function extractWsPayload(buf) {
  if (buf.length < 2) return null;
  const firstByte  = buf[0];
  const secondByte = buf[1];
  const opcode     = firstByte & 0x0f;
  if (opcode !== 1) return null; // only handle text frames
  const masked = (secondByte & 0x80) !== 0;
  let len    = secondByte & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    // 8-byte extended length — used for large frames like get_states response
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    if (hi > 0) return null; // >4GB, not realistic
    len = lo;
    offset = 10;
  }
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.slice(offset, offset + len));
  if (masked) {
    const mask = buf.slice(offset - 4, offset);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return payload.toString("utf8");
}

// Write an unmasked WebSocket text frame to a socket
function sendWsFrame(sock, text) {
  const payload = Buffer.from(text, "utf8");
  const len     = payload.length;
  let   header;
  if      (len < 126)   header = Buffer.from([0x81, len]);
  else if (len < 65536) header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  else return;
  try { sock.write(Buffer.concat([header, payload])); } catch {}
}



/* ── Managed alarm response automations (0.05.22) ────────────── */
const ALARM_RESPONSE_SCOPES = ["shared", "triggered_armed", "triggered_disarmed"];
const ALARM_RESPONSE_ACTION_KEYS = ["notify", "lights", "scripts", "automations", "sirens"];

function _cleanList(value) {
  return (Array.isArray(value) ? value : [])
    .map(v => typeof v === "string" ? v : (v?.entity_id || v?.id || v?.name || ""))
    .map(v => String(v || "").trim())
    .filter(Boolean);
}

function _duration(value, fallback = "00:00:00") {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!m) return fallback;
  return [m[1], m[2], m[3]].map(v => String(Math.max(0, parseInt(v, 10) || 0)).padStart(2, "0")).join(":");
}
function _durationForHA(value) { const d = _duration(value); return d === "00:00:00" ? null : d; }
function alarmResponseAction(action, fallbackType = "light") {
  const a = (action && typeof action === "object") ? action : {};
  const entities = _cleanList(a.entities);
  const targets  = _cleanList(a.targets);
  const type = String(a.type || a.kind || fallbackType || "light");
  const enabled = !!a.enabled || !!a.auto_zones || entities.length > 0 || targets.length > 0 || !!a.title || !!a.message || (a.clear_mode && a.clear_mode !== "none");
  return { id:String(a.id || `resp_${Math.random().toString(36).slice(2,9)}`), type, enabled, entities, targets, title:String(a.title || ''), message:String(a.message || ''), auto_zones:!!a.auto_zones, trigger_for:_duration(a.trigger_for || a.for_duration || "00:00:00"), clear_mode:String(a.clear_mode || "none"), clear_for:_duration(a.clear_for || "00:00:00"), condition_mode:String(a.condition_mode || "always"), time_after:String(a.time_after || "00:00"), time_before:String(a.time_before || "23:59"), condition_entity:String(a.condition_entity || "") };
}
function _legacyResponseActions(raw) { const out = []; const add = (key, type) => { if (!raw?.[key]) return; const a = alarmResponseAction(raw[key], type); if (a.enabled) out.push(a); }; add("notify", "notify"); add("sirens", "siren"); add("lights", "light"); add("scripts", "script"); add("automations", "automation"); return out; }
function alarmResponseSet(alarm, scope) { const responses = (alarm?.responses && typeof alarm.responses === "object") ? alarm.responses : {}; const raw = (responses[scope] && typeof responses[scope] === "object") ? responses[scope] : {}; const actions = Array.isArray(raw.actions) ? raw.actions.map(a => alarmResponseAction(a, a?.type || "light")) : _legacyResponseActions(raw); return { actions }; }

function alarmResponseAutomationId(alarm, scope) {
  const slug = nameSlug(alarm?.name) || alarm?.id || "alarm";
  return `ow_alarm_${slug}_${scope}_response`;
}

function alarmTriggerBinaryEntity(alarm, scope) {
  const slug = nameSlug(alarm?.name) || alarm?.id || "alarm";
  return `binary_sensor.overwatch_alarm_${slug}_${scope}`;
}

function _asTargetValue(ids) {
  const list = _cleanList(ids);
  return list.length === 1 ? list[0] : list;
}

function _pushDomainServiceActions(actions, entityIds, fallbackDomain, service = "turn_on") {
  const byDomain = new Map();
  _cleanList(entityIds).forEach(entityId => {
    const domain = entityId.includes(".") ? entityId.split(".")[0] : fallbackDomain;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(entityId);
  });
  for (const [domain, ids] of byDomain.entries()) {
    if (!ids.length) continue;
    actions.push({ action: `${domain}.${service}`, target: { entity_id: _asTargetValue(ids) } });
  }
}

function _cameraToOverwatchSwitch(entityId) {
  const id = String(entityId || "").trim();
  if (!id) return "";
  if (id.startsWith("switch.overwatch_camera_")) return id;
  if (!id.startsWith("camera.")) return id;
  const bare = id.slice("camera.".length).replace(/[.-]/g, "_");
  return `switch.overwatch_camera_${bare}`;
}


function _serverEntityHidden(entityId) { const id = String(entityId || ""); if (!id) return true; const st = serverHaStates[id]; if (st?.attributes?.hidden_by || st?.attributes?.disabled_by) return true; try { const reg = (haRegistry.entities || []).find(e => e.entity_id === id || e.id === id); if (reg?.hidden_by || reg?.disabled_by) return true; } catch {} return false; }
function _zoneResponseEntities(zone, key) { const hidden = new Set((zone?.ha_excluded_entities || zone?.hidden_entities || zone?.excluded_entities || []).map(String)); return _cleanList(zone?.[key] || []).filter(entityId => !hidden.has(String(entityId))).filter(entityId => !_serverEntityHidden(entityId)); }
function resolveAlarmResponseEntities(alarm, responseKey, action) { const manual = _cleanList(action?.entities || []); if (!action?.auto_zones) return [...new Set(manual)].filter(entityId => !_serverEntityHidden(entityId)); const selectedZones = alarmSelectedZones(alarm, loadZones(), loadGroups(), loadFloors()); const fromZones = selectedZones.flatMap(zone => _zoneResponseEntities(zone, responseKey)); return [...new Set([...fromZones, ...manual])].filter(entityId => !_serverEntityHidden(entityId)); }
function alarmCleanupAutomationId(alarm, scope) { const slug = nameSlug(alarm?.name) || alarm?.id || "alarm"; return `ow_alarm_${slug}_${scope}_cleanup_response`; }
function _scopeTriggerEntities(alarm, scope) { if (scope === "shared") return [alarmTriggerBinaryEntity(alarm, "triggered_armed"), alarmTriggerBinaryEntity(alarm, "triggered_disarmed")]; return [alarmTriggerBinaryEntity(alarm, scope)]; }
function _scopeLabel(scope) { if (scope === "shared") return "Triggered Armed & Disarmed"; return scope === "triggered_armed" ? "Triggered Armed" : "Triggered Disarmed"; }
function _responseActionConditions(action) { const mode = action.condition_mode || "always"; if (mode === "night") return [{ condition:"state", entity_id:"sun.sun", state:"below_horizon" }]; if (mode === "time") { const cond = { condition:"time" }; if (action.time_after) cond.after = action.time_after; if (action.time_before) cond.before = action.time_before; return [cond]; } if (mode === "entity" && action.condition_entity) return [{ condition:"state", entity_id: action.condition_entity, state:"on" }]; return []; }
function _responseActionTargets(alarm, action) { if (action.type === "light") return resolveAlarmResponseEntities(alarm, "lights", action); if (action.type === "siren") return resolveAlarmResponseEntities(alarm, "sirens", action); if (action.type === "script") return _cleanList(action.entities); if (action.type === "automation") return _cleanList(action.entities); return _cleanList(action.entities); }
function _serviceSequenceForResponseAction(alarm, scope, action) { const alarmName = alarm?.name || alarm?.id || "Alarm"; const seq = []; if (action.type === "notify") { const targets = action.targets.length ? action.targets : ["notify.notify"]; targets.forEach(target => { const svc = String(target || "notify.notify").startsWith("notify.") ? String(target).slice("notify.".length) : String(target || "notify"); const title = (action.title || `HA-Overwatch - Alarm - ${alarmName}`).replace(/\{\{\s*alarm_name\s*\}\}/g, alarmName).replace(/\{\{\s*trigger_scope\s*\}\}/g, scope); const message = (action.message || (scope === "triggered_armed" ? `Alarm ${alarmName} triggered while armed.` : `Alarm ${alarmName} triggered while disarmed.`)).replace(/\{\{\s*alarm_name\s*\}\}/g, alarmName).replace(/\{\{\s*trigger_scope\s*\}\}/g, scope); seq.push({ action: `notify.${svc}`, data: { title, message } }); }); } else if (action.type === "light") _pushDomainServiceActions(seq, _responseActionTargets(alarm, action), "light", "turn_on"); else if (action.type === "siren") _pushDomainServiceActions(seq, _responseActionTargets(alarm, action), "siren", "turn_on"); else if (action.type === "script") _pushDomainServiceActions(seq, _responseActionTargets(alarm, action), "script", "turn_on"); else if (action.type === "automation") { const ids = _responseActionTargets(alarm, action); if (ids.length) seq.push({ action: "automation.trigger", target: { entity_id: _asTargetValue(ids) }, data: { skip_condition: true } }); } return seq; }
function _cleanupSequenceForResponseAction(alarm, action) { const seq = []; if (!action.clear_mode || action.clear_mode === "none") return seq; if (action.type === "light") _pushDomainServiceActions(seq, _responseActionTargets(alarm, action), "light", "turn_off"); if (action.type === "siren") _pushDomainServiceActions(seq, _responseActionTargets(alarm, action), "siren", "turn_off"); return seq; }
function _triggerWithFor(entity_id, fields = {}, duration = "00:00:00") { const t = { trigger: "state", entity_id, ...fields }; const f = _durationForHA(duration); if (f) t.for = f; return t; }
function buildAlarmCleanupAutomation(alarm, scope) { const candidates = (alarmResponseSet(alarm, scope).actions || []).filter(a => a.enabled && a.clear_mode && a.clear_mode !== "none" && _cleanupSequenceForResponseAction(alarm, a).length); if (!candidates.length) return null; const alarmSwitch = alarmSwitchEntityIds(alarm)[0]; const triggerEntities = _scopeTriggerEntities(alarm, scope); const triggers = [], choices = []; candidates.forEach((a, idx) => { const idBase = `cleanup_${a.id || idx}`; if (a.clear_mode === "when_alarm_clears" || a.clear_mode === "when_alarm_clears_or_disarmed") triggerEntities.forEach((entityId, entityIdx) => triggers.push({ ..._triggerWithFor(entityId, { from:"on", to:"off" }, a.clear_for), id: `${idBase}_clear_${entityIdx}` })); if ((a.clear_mode === "when_alarm_disarmed" || a.clear_mode === "when_alarm_clears_or_disarmed") && alarmSwitch) triggers.push({ ..._triggerWithFor(alarmSwitch, { to:"off" }, a.clear_for), id: `${idBase}_disarm` }); choices.push({ conditions: [{ condition:"trigger", id:[`${idBase}_clear_0`, `${idBase}_clear_1`, `${idBase}_disarm`] }, ..._responseActionConditions(a)], sequence:_cleanupSequenceForResponseAction(alarm, a) }); }); if (!triggers.length || !choices.length) return null; const autoId = alarmCleanupAutomationId(alarm, scope); const alarmName = alarm?.name || alarm?.id || "Alarm"; return { id:autoId, alias:`HA-Overwatch - Alarm - ${alarmName} - ${_scopeLabel(scope)} Response Cleanup`, description:"Managed by HA-Overwatch alarm response cleanup profile", variables:{ ow_id:autoId, ow_name:`Alarm ${alarmName} ${scope} response cleanup`, ow_managed:true, ow_type:"alarm_response", ow_alarm_id:alarm?.id || null, ow_alarm_name:alarmName, ow_trigger_scope:scope, ow_cleanup:true }, mode:"restart", triggers, conditions:[], actions:[{ choose: choices }] }; }

function buildAlarmResponseActions(alarm, scope) { return (alarmResponseSet(alarm, scope).actions || []).filter(a => a.enabled).map(a => ({ action:a, sequence:_serviceSequenceForResponseAction(alarm, scope, a) })).filter(x => x.sequence.length); }
function buildAlarmResponseAutomation(alarm, scope) { const autoId = alarmResponseAutomationId(alarm, scope); const alarmName = alarm?.name || alarm?.id || "Alarm"; const triggerEntities = _scopeTriggerEntities(alarm, scope); const responseSteps = buildAlarmResponseActions(alarm, scope); if (!responseSteps.length) return null; const triggers = []; responseSteps.forEach((step, idx) => triggerEntities.forEach((entityId, entityIdx) => triggers.push({ ..._triggerWithFor(entityId, { to:"on" }, step.action.trigger_for), id:`response_${step.action.id || idx}_${entityIdx}` }))); const choices = responseSteps.map((step, idx) => ({ conditions:[{ condition:"trigger", id:triggerEntities.map((_, entityIdx) => `response_${step.action.id || idx}_${entityIdx}`) }, ..._responseActionConditions(step.action)], sequence:step.sequence })); return { id:autoId, alias:`HA-Overwatch - Alarm - ${alarmName} - ${_scopeLabel(scope)} Response`, description:"Managed by HA-Overwatch alarm response profile", variables:{ ow_id:autoId, ow_name:`Alarm ${alarmName} ${scope} response`, ow_managed:true, ow_type:"alarm_response", ow_alarm_id:alarm?.id || null, ow_alarm_name:alarmName, ow_trigger_scope:scope }, mode:"parallel", triggers, conditions:[], actions:[{ choose: choices }] }; }

function _getHARequestConfig() {
  const cfg = getHAConfig(loadConfig());
  if (!cfg.ha_url && !process.env.SUPERVISOR_TOKEN) throw new Error("HA not configured");
  if (process.env.SUPERVISOR_TOKEN) {
    return { lib: http, hostname: "supervisor", port: 80, basePath: "/core", token: process.env.SUPERVISOR_TOKEN };
  }
  const u = new URL(cfg.ha_url.replace(/\/$/, ""));
  return { lib: u.protocol === "https:" ? https : http, hostname: u.hostname, port: parseInt(u.port) || (u.protocol === "https:" ? 443 : 80), basePath: "", token: cfg.ha_token };
}

function _haApiRequest(method, apiPath, payload = null) {
  const { lib, hostname, port, basePath, token } = _getHARequestConfig();
  const body = payload == null ? "" : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname,
      port,
      method,
      path: `${basePath}${apiPath}`,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function _reloadHAAutomations() {
  try { await _haApiRequest("POST", "/api/services/automation/reload", null); }
  catch (e) { console.warn("[OW-AlarmResponse] automation.reload failed:", e.message); }
}

async function _pushManagedAlarmAutomation(haAuto) {
  const res = await _haApiRequest("POST", `/api/config/automation/config/${haAuto.id}`, haAuto);
  if (res.status < 200 || res.status >= 300) throw new Error(`HA rejected ${haAuto.id}: ${res.status} ${res.body}`);
  return { id: haAuto.id, status: res.status };
}

async function _deleteManagedAlarmAutomation(id) {
  const res = await _haApiRequest("DELETE", `/api/config/automation/config/${id}`, null);
  // 404 and HA's 400 "Resource not found" are acceptable for stale/non-existing generated automations.
  if (res.status === 404 || (res.status === 400 && /Resource not found/i.test(String(res.body || "")))) {
    return { id, status: res.status, missing: true };
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`HA delete rejected ${id}: ${res.status} ${res.body}`);
  return { id, status: res.status };
}


function isManagedAlarmResponseAutomationId(id) {
  return /^ow_alarm_.+_(?:shared|triggered_(?:armed|disarmed))(?:_cleanup)?_response$/.test(String(id || ""));
}

function readAlarmResponseAutomationIdsFromDisk() {
  const ids = new Set();
  const candidates = [
    "/config/automations.yaml",
    path.join(DATA_DIR, "automations.yaml"),
    path.join(DATA_DIR, "config", "automations.yaml"),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const re = /(?:^|\n)\s*(?:-\s*)?id:\s*["']?(ow_alarm_[A-Za-z0-9_]+_(?:shared|triggered_(?:armed|disarmed))(?:_cleanup)?_response)["']?/g;
      let m;
      while ((m = re.exec(text))) ids.add(m[1]);
    } catch (e) {
      console.warn(`[OW-AlarmResponse] failed scanning ${file}: ${e.message}`);
    }
  }
  return [...ids];
}

async function listManagedAlarmResponseAutomationIds() {
  const ids = new Set();

  // Preferred: HA automation config API. It returns parsed automation configs including id/variables.
  try {
    const res = await _haApiRequest("GET", "/api/config/automation/config", null);
    if (res.status >= 200 && res.status < 300 && res.body) {
      const parsed = JSON.parse(res.body);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.automations) ? parsed.automations : []);
      for (const auto of list) {
        const id = String(auto?.id || "");
        const vars = auto?.variables || {};
        if (isManagedAlarmResponseAutomationId(id) || vars.ow_type === "alarm_response") {
          if (id) ids.add(id);
        }
      }
    }
  } catch (e) {
    console.warn(`[OW-AlarmResponse] HA automation list scan failed: ${e.message}`);
  }

  // Fallback/backup: direct disk scan in add-on mode.
  readAlarmResponseAutomationIdsFromDisk().forEach(id => ids.add(id));
  return [...ids];
}

async function syncAlarmResponseAutomations(alarms = loadAlarms()) {
  const pushed = [];
  const deleted = [];
  const stale_deleted = [];
  const errors = [];
  const expectedIds = new Set();

  for (const alarm of (alarms || [])) {
    for (const scope of ALARM_RESPONSE_SCOPES) {
      const autoId = alarmResponseAutomationId(alarm, scope);
      const cleanupId = alarmCleanupAutomationId(alarm, scope);
      expectedIds.add(autoId);
      expectedIds.add(cleanupId);
      const haAuto = buildAlarmResponseAutomation(alarm, scope);
      const cleanupAuto = buildAlarmCleanupAutomation(alarm, scope);
      try {
        if (haAuto) pushed.push(await _pushManagedAlarmAutomation(haAuto));
        else deleted.push(await _deleteManagedAlarmAutomation(autoId));
      } catch (e) {
        console.warn(`[OW-AlarmResponse] ${autoId}: ${e.message}`);
        errors.push({ id: autoId, error: e.message });
      }
      try {
        if (cleanupAuto) pushed.push(await _pushManagedAlarmAutomation(cleanupAuto));
        else deleted.push(await _deleteManagedAlarmAutomation(cleanupId));
      } catch (e) {
        console.warn(`[OW-AlarmResponse] ${cleanupId}: ${e.message}`);
        errors.push({ id: cleanupId, error: e.message });
      }
    }
  }

  // Delete generated alarm response automations for alarms that no longer exist, or old IDs left behind after rename.
  try {
    const existingGeneratedIds = await listManagedAlarmResponseAutomationIds();
    for (const id of existingGeneratedIds) {
      if (expectedIds.has(id)) continue;
      try {
        stale_deleted.push(await _deleteManagedAlarmAutomation(id));
      } catch (e) {
        console.warn(`[OW-AlarmResponse] stale ${id}: ${e.message}`);
        errors.push({ id, error: e.message });
      }
    }
  } catch (e) {
    console.warn(`[OW-AlarmResponse] stale automation cleanup failed: ${e.message}`);
    errors.push({ id: "stale_alarm_response_cleanup", error: e.message });
  }

  await _reloadHAAutomations();
  return { ok: errors.length === 0, pushed, deleted, stale_deleted, errors };
}

/* ── Automation action controls ───────────────────────────── */
function _autoDuration(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const out = [m[1], m[2], m[3]].map(v => String(Math.max(0, parseInt(v,10)||0)).padStart(2,'0')).join(':');
  return out === '00:00:00' ? null : out;
}
function _automationActionConditions(a) {
  const mode = String(a?.condition_mode || 'always');
  if (mode === 'night') return [{ condition:'state', entity_id:'sun.sun', state:'below_horizon' }];
  if (mode === 'time') {
    const c = { condition:'time' };
    if (a.time_after) c.after = a.time_after;
    if (a.time_before) c.before = a.time_before;
    return [c];
  }
  if (mode === 'entity' && a.condition_entity) return [{ condition:'state', entity_id:a.condition_entity, state:'on' }];
  return [];
}
function _turnOffActionFor(actionObj) {
  const action = String(actionObj?.action || actionObj?.service || '');
  const dot = action.indexOf('.');
  if (dot < 0) return null;
  const domain = action.slice(0, dot);
  if (!['light','siren','switch'].includes(domain)) return null;
  return { action: `${domain}.turn_off`, target: actionObj.target || {} };
}
function _jinjaString(value) {
  return String(value || '').replace(/'/g, "\\'");
}
function _sourceClearExpr(sourceClearSources = []) {
  const seen = new Set();
  const parts = [];
  (sourceClearSources || []).forEach(src => {
    const entityId = String(src?.entity_id || '').trim();
    const activeState = String(src?.active_state || 'on').trim();
    if (!entityId) return;
    const key = `${entityId}::${activeState}`;
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(`not is_state('${_jinjaString(entityId)}', '${_jinjaString(activeState)}')`);
  });
  return parts.length ? parts.join(' and ') : "is_state(trigger.entity_id, 'off')";
}
function _sourceClearTemplate(sourceClearSources = []) {
  return `{{ ${_sourceClearExpr(sourceClearSources)} }}`;
}
function _clearTemplateForAction(a, sourceClearSources = []) {
  const conds = Array.isArray(a?.clear_conditions) && a.clear_conditions.length ? a.clear_conditions : ['source_clear'];
  const parts = [];
  if (conds.includes('source_clear')) parts.push(_sourceClearExpr(sourceClearSources));
  if (conds.includes('alarm_not_triggered')) parts.push("states.binary_sensor | selectattr('entity_id','match','binary_sensor\\.overwatch_alarm_.*triggered') | selectattr('state','eq','on') | list | count == 0");
  if (!parts.length) parts.push(_sourceClearExpr(sourceClearSources));
  const op = (a?.clear_match === 'any') ? ' or ' : ' and ';
  return `{{ ${parts.join(op)} }}`;
}
function _withContinueOnError(actionObj) {
  if (actionObj && actionObj.action) actionObj.continue_on_error = true;
  return actionObj;
}
function _pushDynamicTurnOff(seq, a, actionObj, sourceClearSources = []) {
  const clearMode = String(a?.clear_mode || 'none');
  const offAction = _turnOffActionFor(actionObj);
  if (!offAction || clearMode === 'none') return;
  const clearFor = _autoDuration(a?.clear_for) || '00:00:00';

  // Source-clear/condition cleanup is generated as a paired "Turn OFF"
  // automation. Do not leave wait/delay/turn_off behind the ON automation;
  // restart mode can cancel cleanup before turn_off runs.
  if (clearMode === 'source_clears' || clearMode === 'conditions') return;

  if (clearMode === 'after_delay') {
    if (clearFor !== '00:00:00') seq.push({ delay: clearFor });
    seq.push(_withContinueOnError(offAction));
  }
}
function buildAutomationActionBranch(a, actionObj, sourceClearSources = []) {
  const seq = [];
  const startDelay = _autoDuration(a?.trigger_for);
  if (startDelay) seq.push({ delay: startDelay });
  seq.push(_withContinueOnError(actionObj));
  _pushDynamicTurnOff(seq, a, actionObj, sourceClearSources);
  const conditions = _automationActionConditions(a);
  if (conditions.length) return { choose: [{ conditions, sequence: seq }] };
  return { sequence: seq };
}
function pushAutomationAction(actions, a, actionObj, sourceClearSources = []) {
  actions.push(buildAutomationActionBranch(a, actionObj, sourceClearSources));
}

function _resolveAutomationScopedEntityIds(a, key, zoneList, groupList, floorList) {
  const out = new Set();
  const hiddenForZone = zone => new Set((zone?.ha_excluded_entities || zone?.hidden_entities || zone?.excluded_entities || []).map(String));
  const addFromZone = zone => {
    if (!zone) return;
    const hidden = hiddenForZone(zone);
    (zone[key] || []).forEach(entityId => {
      if (entityId && !hidden.has(String(entityId)) && !_serverEntityHidden(entityId)) out.add(entityId);
    });
  };
  (a?.zone_ids || []).forEach(zid => addFromZone(zoneList.find(z => z.id === zid)));
  (a?.group_ids || []).forEach(gid => {
    const g = groupList.find(g => g.id === gid);
    (g?.zone_ids || []).forEach(zid => addFromZone(zoneList.find(z => z.id === zid)));
  });
  const selectedFloors = new Set(a?.floor_ids || []);
  if (selectedFloors.size) {
    (floorList || []).forEach((f, idx) => {
      if (!selectedFloors.has(f.id)) return;
      const isFirst = idx === 0;
      zoneList.filter(z => z.floor_id === f.id || (!z.floor_id && isFirst)).forEach(addFromZone);
    });
  }
  return [...out];
}

function _serverEntityKnown(entityId) {
  const id = String(entityId || '').trim();
  if (!id) return false;
  if (serverHaStates[id]) return true;
  try {
    return (haRegistry.entities || []).some(e => e?.entity_id === id || e?.id === id);
  } catch {
    return false;
  }
}
function _automationHasScopeSelection(a) {
  return !!((a?.zone_ids || []).length || (a?.group_ids || []).length || (a?.floor_ids || []).length);
}
function _pruneZoneStoredEntityIds(a, key, zoneList, groupList, floorList) {
  const stored = [...new Set([...(a?.entity_ids_zone || [])].filter(Boolean))];
  if (!stored.length) return [];
  const currentScoped = new Set(_resolveAutomationScopedEntityIds(a, key, zoneList, groupList, floorList));

  // If the action has selected zones/groups/floors, entity_ids_zone is only a
  // UI cache of zone-derived targets. Do not let removed/replaced zone devices
  // remain in generated HA targets after zone membership changes.
  if (_automationHasScopeSelection(a)) {
    return stored.filter(entityId => currentScoped.has(entityId));
  }

  // If no scope is selected, retain standalone zone-list selections only while
  // Home Assistant still knows the entity. This removes HA-deleted stale IDs.
  return stored.filter(entityId => _serverEntityKnown(entityId) && !_serverEntityHidden(entityId));
}

function _automationRunMode(auto) {
  const requested = String(auto?.run_mode || 'auto');
  if (['single','restart','queued','parallel'].includes(requested)) return requested;
  return (auto?.actions || []).some(a => String(a?.clear_mode || 'none') === 'source_clears') ? 'restart' : 'single';
}

function _automationTurnOffId(autoOrId) {
  const id = typeof autoOrId === 'string' ? autoOrId : String(autoOrId?.id || '');
  return id ? `${id}_turn_off` : '';
}
function _isTurnOffAutomationConfig(a) {
  const id = String(a?.id || a?.variables?.ow_id || '');
  // Do not hide by alias suffix. Users can legitimately create their own
  // automations ending with "- Turn OFF".
  return id.endsWith('_turn_off') || a?.variables?.ow_cleanup === true || a?.variables?.ow_child_type === 'turn_off';
}
function _flattenEntityIds(value) {
  if (!value) return [];
  return [...new Set((Array.isArray(value) ? value : [value]).filter(Boolean).map(String))];
}
function _durationObject(value) {
  const s = _autoDuration(value) || '00:00:00';
  const [hours, minutes, seconds] = s.split(':').map(v => Math.max(0, parseInt(v, 10) || 0));
  return { hours, minutes, seconds };
}
function _sourceClearSourcesFromTriggers(triggers = []) {
  const out = [];
  const seen = new Set();
  (triggers || []).forEach(t => {
    if (!t || (t.trigger || t.platform) !== 'state') return;
    const activeState = String(t.to || 'on');
    _flattenEntityIds(t.entity_id).forEach(entityId => {
      const key = `${entityId}::${activeState}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ entity_id: entityId, active_state: activeState });
    });
  });
  return out;
}
function _canUseSimpleStateClearTrigger(sourceClearSources = []) {
  return sourceClearSources.length === 1 && String(sourceClearSources[0]?.active_state || 'on') === 'on';
}
function _clearTriggerIdForAction(a) {
  return `clear_${a?.id || 'action'}`;
}
function _offTriggerForAction(a, sourceClearSources = []) {
  const clearMode = String(a?.clear_mode || 'none');
  if (clearMode !== 'source_clears' && clearMode !== 'conditions') return null;
  const id = _clearTriggerIdForAction(a);
  const clearFor = _durationObject(a?.clear_for);

  if (clearMode === 'source_clears' && _canUseSimpleStateClearTrigger(sourceClearSources)) {
    return {
      trigger: 'state',
      entity_id: [sourceClearSources[0].entity_id],
      from: sourceClearSources[0].active_state,
      to: 'off',
      for: clearFor,
      id,
    };
  }

  return {
    trigger: 'template',
    value_template: clearMode === 'source_clears'
      ? _sourceClearTemplate(sourceClearSources)
      : _clearTemplateForAction(a, sourceClearSources),
    for: clearFor,
    id,
  };
}
function _turnOffChooseBranchForAction(a, actionObj) {
  const clearMode = String(a?.clear_mode || 'none');
  if (clearMode !== 'source_clears' && clearMode !== 'conditions') return null;
  const offAction = _turnOffActionFor(actionObj);
  if (!offAction) return null;
  const clearId = _clearTriggerIdForAction(a);
  return { triggerId: clearId, branch: { conditions: [{ condition: 'trigger', id: clearId }], sequence: [_withContinueOnError(offAction)] } };
}
function buildHAAutomationTurnOff(auto, allZones, allGroups, mainAutomation = null) {
  const main = mainAutomation || buildHAAutomation(auto, allZones, allGroups);
  const sourceClearSources = _sourceClearSourcesFromTriggers(main.triggers || main.trigger || []);
  if (!sourceClearSources.length) return null;

  const zoneList  = allZones  || [];
  const groupList = allGroups || [];
  const floorList = loadFloors();
  function uniq(ids) { return [...new Set((ids || []).filter(Boolean))]; }
  function targetFor(ids) { return { entity_id: uniq(ids) }; }

  const triggers = [];
  const choices = [];
  const seenTriggerIds = new Set();
  function addTurnOff(a, actionObj) {
    const trig = _offTriggerForAction(a, sourceClearSources);
    const branchWrap = _turnOffChooseBranchForAction(a, actionObj);
    if (!trig || !branchWrap) return;
    if (!seenTriggerIds.has(trig.id)) { seenTriggerIds.add(trig.id); triggers.push(trig); }
    choices.push(branchWrap.branch);
  }

  for (const a of (auto.actions || [])) {
    if (a.type === 'siren') {
      const ids = uniq([..._resolveAutomationScopedEntityIds(a, 'sirens', zoneList, groupList, floorList), ..._pruneZoneStoredEntityIds(a, 'sirens', zoneList, groupList, floorList), ...(a.entity_ids || []), ...(a.entity_ids_extra || [])]);
      if (ids.length) addTurnOff(a, { action:`siren.${a.service || 'turn_on'}`, target: targetFor(ids) });
    } else if (a.type === 'light') {
      const ids = uniq([..._resolveAutomationScopedEntityIds(a, 'lights', zoneList, groupList, floorList), ..._pruneZoneStoredEntityIds(a, 'lights', zoneList, groupList, floorList), ...(a.entity_ids_other || []), ...(a.entity_ids || [])]);
      if (ids.length) addTurnOff(a, { action:`light.${a.service || 'turn_on'}`, target: targetFor(ids) });
    } else if (a.type === 'camera_view') {
      const ids = uniq([..._resolveAutomationScopedEntityIds(a, 'cameras', zoneList, groupList, floorList), ..._pruneZoneStoredEntityIds(a, 'cameras', zoneList, groupList, floorList), ...(a.entity_ids || [])]);
      if (ids.length) addTurnOff(a, { action:`switch.${a.service || 'turn_on'}`, target: targetFor(ids) });
    } else if (a.type === 'entity' && a.entity_id) {
      const domain = a.entity_id.split('.')[0];
      addTurnOff(a, { action:`${domain}.${a.service || 'turn_on'}`, target:{ entity_id:[a.entity_id] } });
    } else if (a.type === 'arm') {
      const ids = uniq(a.entity_ids || []);
      if (ids.length) addTurnOff(a, { action:`switch.${a.service || 'turn_on'}`, target: targetFor(ids) });
    }
  }

  if (!triggers.length || !choices.length) return null;
  return {
    id: _automationTurnOffId(auto),
    alias: `HA-Overwatch — ${auto.name} - Turn OFF`,
    description: 'Created by HA-Overwatch',
    variables: { ow_id: _automationTurnOffId(auto), ow_name: `${auto.name} - Turn OFF`, ow_draft: auto, ow_cleanup: true, ow_child_type: 'turn_off', ow_parent_automation_id: auto.id },
    mode: 'single',
    triggers,
    conditions: [],
    actions: [{ choose: choices }],
  };
}
function buildHAAutomationSet(auto, allZones, allGroups) {
  const main = buildHAAutomation(auto, allZones, allGroups);
  const turnOff = buildHAAutomationTurnOff(auto, allZones, allGroups, main);
  return turnOff ? [main, turnOff] : [main];
}

/* ── Build HA automation config from OW draft ─────────────── */
function buildHAAutomation(auto, allZones, allGroups) {
  const zoneList  = allZones  || [];
  const groupList = allGroups || [];
  const floorList = loadFloors();

  function zoneById(id)  { return zoneList.find(z => z.id === id); }
  function zoneSlugById(id) {
    const z = zoneById(id);
    return z ? (nameSlug(z.name) || z.id) : nameSlug(id);
  }
  function groupSlugById(id) {
    const g = groupList.find(g => g.id === id);
    return g ? (nameSlug(g.name) || g.id) : nameSlug(id);
  }

  const triggers   = [];
  const conditions = [];
  const actions    = [];
  const sourceClearSources = [];
  function _uniqList(ids) { return [...new Set((ids || []).filter(Boolean))]; }
  function _addSourceClearSources(entityIds, activeState) {
    _uniqList(Array.isArray(entityIds) ? entityIds : [entityIds]).forEach(entityId => {
      sourceClearSources.push({ entity_id: entityId, active_state: activeState || 'on' });
    });
  }
  function _zoneIdsForFloor(fid) {
    const isFirstFloor = floorList.length === 0 || floorList[0]?.id === fid;
    return zoneList.filter(z => z.floor_id === fid || (!z.floor_id && isFirstFloor)).map(z => z.id);
  }

  // OW metadata stored in 'variables' — a valid HA field, not shown in UI, survives round-trips
  const owMeta = { ow_id: auto.id, ow_name: auto.name, ow_draft: auto };

  for (const t of (auto.triggers || [])) {
    const forDur = t.for_duration || null;

    if (t.type === 'zone' || t.type === 'zone_arm') {
      const isArm   = t.type === 'zone_arm';
      const toState = isArm
        ? (t.state === 'armed' ? 'on' : 'off')
        : (t.event === 'triggered' ? 'on' : 'off');
      let entityIds = [];
      (t.floor_ids || []).forEach(fid => {
        if (isArm) entityIds.push(`switch.overwatch_zone_floor_${fid}`);
        else _zoneIdsForFloor(fid).forEach(zid => entityIds.push(`binary_sensor.overwatch_zone_${zoneSlugById(zid)}_triggered`));
      });
      (t.group_ids || []).forEach(gid => {
        const slug = groupSlugById(gid);
        entityIds.push(isArm ? `switch.overwatch_zone_group_${slug}` : `binary_sensor.overwatch_zone_group_${slug}_triggered`);
      });
      (t.zone_ids || []).forEach(zid => {
        const slug = zoneSlugById(zid);
        entityIds.push(isArm ? `switch.overwatch_zone_${slug}` : `binary_sensor.overwatch_zone_${slug}_triggered`);
      });
      entityIds = _uniqList(entityIds);
      if (entityIds.length > 0) {
        _addSourceClearSources(entityIds, toState);
        const trig = { trigger:"state", entity_id: entityIds, to:toState };
        if (forDur) trig.for = forDur;
        triggers.push(trig);
      } else {
        const fallback = isArm ? "switch.overwatch_zone_master" : "binary_sensor.overwatch_zone_master_triggered";
        _addSourceClearSources(fallback, toState);
        triggers.push({ trigger:"state", entity_id:[fallback], to:toState });
      }
    } else if (t.type === 'person' || t.type === 'device') {
      if ((t.entity_ids||[]).length) {
        const entityIds = _uniqList(t.entity_ids);
        const toState = t.state || 'home';
        _addSourceClearSources(entityIds, toState);
        const trig = { trigger:"state", entity_id:entityIds, to:toState };
        if (forDur) trig.for = forDur;
        triggers.push(trig);
      }
    } else if (t.type === 'entity') {
      if (t.entity_id) {
        const toState = t.to || 'on';
        _addSourceClearSources(t.entity_id, toState);
        const trig = { trigger:"state", entity_id:[t.entity_id], to:toState };
        if (forDur) trig.for = forDur;
        triggers.push(trig);
      }
    } else if (t.type === 'door' || t.type === 'window' || t.type === 'sensor') {
      if ((t.entity_ids||[]).length) {
        const entityIds = _uniqList(t.entity_ids);
        const toState = t.state || 'on';
        _addSourceClearSources(entityIds, toState);
        const trig = { trigger:"state", entity_id:entityIds, to:toState };
        if (forDur) trig.for = forDur;
        triggers.push(trig);
      }
    }
  }

  
  for (const c of (auto.conditions || [])) {
    if (c.type === 'time') {
      if (c.time_mode === 'entity' && c.time_entity) {
        conditions.push({ condition:"template", value_template:`{{ now().strftime('%H:%M') == states('${c.time_entity}')[:5] }}` });
      } else {
        const cond = { condition:"time" };
        if (c.after)  cond.after  = c.after;
        if (c.before) cond.before = c.before;
        conditions.push(cond);
      }
    } else if (c.type === 'entity' && c.entity_id) {
      conditions.push({ condition:"state", entity_id:c.entity_id, state:c.state||'on' });
    } else if (c.type === 'person' && (c.entity_ids||[]).length) {
      c.entity_ids.forEach(eid => {
        conditions.push({ condition:"state", entity_id:eid, state:c.state||'home' });
      });
    } else if (c.type === 'device' && (c.entity_ids||[]).length) {
      c.entity_ids.forEach(eid => {
        conditions.push({ condition:"state", entity_id:eid, state:c.state||'home' });
      });
    }
  }

  const actionBranches = [];
  function uniq(ids) { return [...new Set((ids || []).filter(Boolean))]; }
  function targetFor(ids) {
    const u = uniq(ids);
    return { entity_id: u.length === 1 ? u[0] : u };
  }
  function addActionBranch(a, actionObj) {
    actionBranches.push(buildAutomationActionBranch(a, actionObj, sourceClearSources));
  }

  for (const a of (auto.actions || [])) {
    if (a.type === 'siren') {
      const ids = uniq([..._resolveAutomationScopedEntityIds(a, 'sirens', zoneList, groupList, floorList), ..._pruneZoneStoredEntityIds(a, 'sirens', zoneList, groupList, floorList), ...(a.entity_ids || []), ...(a.entity_ids_extra || [])]);
      if (ids.length) addActionBranch(a, { action:`siren.${a.service || 'turn_on'}`, target: targetFor(ids) });
    } else if (a.type === 'light') {
      const ids = uniq([..._resolveAutomationScopedEntityIds(a, 'lights', zoneList, groupList, floorList), ..._pruneZoneStoredEntityIds(a, 'lights', zoneList, groupList, floorList), ...(a.entity_ids_other || []), ...(a.entity_ids || [])]);
      if (ids.length) addActionBranch(a, { action:`light.${a.service || 'turn_on'}`, target: targetFor(ids) });
    } else if (a.type === 'notify') {
      const target = a.target || 'notify.notify';
      const svc = target.startsWith('notify.') ? target.slice(7) : target;
      addActionBranch(a, { action:`notify.${svc}`, data:{ message:a.message || '', title:a.title || 'HA-Overwatch Alert' } });
    } else if (a.type === 'arm') {
      const ids = uniq(a.entity_ids || []);
      if (ids.length) addActionBranch(a, { action:`switch.${a.service || 'turn_on'}`, target: targetFor(ids) });
      else if (a.entity_id) addActionBranch(a, { action:`alarm_control_panel.${a.service || 'alarm_arm_away'}`, target:{ entity_id:a.entity_id } });
    } else if (a.type === 'camera') {
      const ids = uniq([..._resolveAutomationScopedEntityIds(a, 'cameras', zoneList, groupList, floorList), ...(a.entity_ids || [])]);
      if (ids.length && a.service) {
        const act = { action:`camera.${a.service}`, target: targetFor(ids) };
        if (a.service_data && Object.keys(a.service_data).length) act.data = a.service_data;
        addActionBranch(a, act);
      }
    } else if (a.type === 'camera_view') {
      const ids = uniq([..._resolveAutomationScopedEntityIds(a, 'cameras', zoneList, groupList, floorList), ..._pruneZoneStoredEntityIds(a, 'cameras', zoneList, groupList, floorList), ...(a.entity_ids || [])]);
      if (ids.length) addActionBranch(a, { action:`switch.${a.service || 'turn_on'}`, target: targetFor(ids) });
    } else if (a.type === 'entity') {
      if (a.entity_id) {
        const domain = a.entity_id.split('.')[0];
        addActionBranch(a, { action:`${domain}.${a.service || 'turn_on'}`, target:{ entity_id:a.entity_id } });
      }
    }
  }

  if (actionBranches.length === 1) actions.push(actionBranches[0]);
  else if (actionBranches.length > 1) actions.push({ parallel: actionBranches });

  return {
    id:          auto.id,
    alias:       `HA-Overwatch — ${auto.name}`,
    description: 'Created by HA-Overwatch',
    variables:   owMeta,
    // Source-clears actions need restart mode so new trigger events reset the clear/cooldown timer.
    // Keep all other automations as single to preserve existing behaviour.
    mode:        _automationRunMode(auto),
    triggers:    triggers,
    conditions:  conditions,
    actions:     actions,
  };
}

function parseHAAutomation(ha, allZones, allGroups) {
  const warnings  = [];
  if (ha?.variables?.ow_draft && typeof ha.variables.ow_draft === "object") {
    const restored = JSON.parse(JSON.stringify(ha.variables.ow_draft));
    restored._ha_parse_warnings = [];
    return { draft: restored, warnings: [] };
  }
  const zoneList  = allZones  || [];
  const groupList = allGroups || [];

  let owId=null, owName=null;
  // Try variables first (new format), fall back to description JSON (old format)
  try {
    if (ha.variables?.ow_id) { owId=ha.variables.ow_id; owName=ha.variables.ow_name||null; }
    else { const m=JSON.parse(ha.description||"{}"); owId=m.ow_id||null; owName=m.ow_name||null; }
  } catch {}

  const alias = ha.alias||"";
  const displayName = owName || alias.replace(/^HA-Overwatch\s*[-–—]?\s*/i,"").trim();

  const draft = {
    id:       owId || uid_simple(),
    name:     displayName,
    enabled:  ha.state !== "off",
    triggers: [], conditions: [], actions: [],
    _ha_parse_warnings: [],
  };

  function zoneBySlug(slug) {
    return zoneList.find(z => (nameSlug(z.name)||z.id)===slug || z.id===slug);
  }
  function groupBySlug(slug) {
    return groupList.find(g => (nameSlug(g.name)||g.id)===slug || g.id===slug);
  }

  const rawTriggers = ha.triggers || ha.trigger || [];
  for (const t of (Array.isArray(rawTriggers)?rawTriggers:[rawTriggers])) {
    const trigPlatform = t.platform || t.trigger || ""; // HA 2024.x uses "trigger" key, older uses "platform"
    if (!t || trigPlatform !== "state") { if (t) warnings.push(`Unsupported trigger: ${trigPlatform||JSON.stringify(t)}`); continue; }
    const ids = Array.isArray(t.entity_id)?t.entity_id:(t.entity_id?[t.entity_id]:[]);
    const forDur = t.for||null;

    const zoneTriggIds = ids.filter(id=>/^binary_sensor\.overwatch_zone_(?!group).+_triggered$/.test(id));
    const groupTriggIds = ids.filter(id=>/^binary_sensor\.overwatch_zone_group_.+_triggered$/.test(id));
    const zoneArmIds   = ids.filter(id=>/^switch\.overwatch_zone_(?!group)[^_]/.test(id));
    const groupArmIds  = ids.filter(id=>/^switch\.overwatch_zone_group_/.test(id));
    const nonOW        = ids.filter(id=>!id.includes('overwatch_zone'));

    if (zoneTriggIds.length||groupTriggIds.length) {
      const zIds = zoneTriggIds.map(id=>{const sl=id.replace(/^binary_sensor\.overwatch_zone_/,"").replace(/_triggered$/,"");return (zoneBySlug(sl)||{}).id||null;}).filter(Boolean);
      const gIds = groupTriggIds.map(id=>{const sl=id.replace(/^binary_sensor\.overwatch_zone_group_/,"").replace(/_triggered$/,"");return (groupBySlug(sl)||{}).id||null;}).filter(Boolean);
      draft.triggers.push({ id:uid_simple(), type:'zone', zone_ids:zIds, group_ids:gIds, event:t.to==='off'?'cleared':'triggered', for_duration:forDur });
    } else if (zoneArmIds.length||groupArmIds.length) {
      const zIds = zoneArmIds.map(id=>{const sl=id.replace(/^switch\.overwatch_zone_/,"");return (zoneBySlug(sl)||{}).id||null;}).filter(Boolean);
      const gIds = groupArmIds.map(id=>{const sl=id.replace(/^switch\.overwatch_zone_group_/,"");return (groupBySlug(sl)||{}).id||null;}).filter(Boolean);
      draft.triggers.push({ id:uid_simple(), type:'zone_arm', zone_ids:zIds, group_ids:gIds, state:t.to==='off'?'disarmed':'armed', for_duration:forDur });
    } else if (nonOW.length) {
      const domain = nonOW[0].split('.')[0];
      if (domain==='person') draft.triggers.push({ id:uid_simple(), type:'person', entity_ids:nonOW, state:t.to||'home', for_duration:forDur });
      else if (domain==='device_tracker') draft.triggers.push({ id:uid_simple(), type:'device', entity_ids:nonOW, state:t.to||'home', for_duration:forDur });
      else { draft.triggers.push({ id:uid_simple(), type:'entity', entity_id:nonOW[0], to:t.to||'on', for_duration:forDur }); if(nonOW.length>1) warnings.push(`Multi-entity trigger partially imported`); }
    }
  }

  const rawConds = ha.conditions||ha.condition||[];
  for (const c of (Array.isArray(rawConds)?rawConds:[rawConds])) {
    if (!c) continue;
    if (c.condition==='time') draft.conditions.push({ id:uid_simple(), type:'time', time_mode:'manual', after:c.after||'00:00', before:c.before||'23:59' });
    else if (c.condition==='state') draft.conditions.push({ id:uid_simple(), type:'entity', entity_id:c.entity_id||'', state:c.state||'on' });
    else if (c.condition==='template') { const m=(c.value_template||'').match(/states\('([^']+)'\)/); if(m) draft.conditions.push({id:uid_simple(),type:'time',time_mode:'entity',time_entity:m[1]}); else warnings.push(`Unsupported template condition`); }
    else warnings.push(`Unsupported condition: ${c.condition}`);
  }

  const rawActions = ha.actions||ha.action||[];
  for (const a of (Array.isArray(rawActions)?rawActions:[rawActions])) {
    if (!a) continue;
    const actionKey = a.action||a.service||'';
    const dotIdx = actionKey.indexOf('.');
    const domain = dotIdx>=0?actionKey.slice(0,dotIdx):'';
    const svc    = dotIdx>=0?actionKey.slice(dotIdx+1):'';
    const tids   = a.target?.entity_id ? (Array.isArray(a.target.entity_id)?a.target.entity_id:[a.target.entity_id]) : [];

    if (domain==='siren') draft.actions.push({ id:uid_simple(), type:'siren', entity_ids:tids, service:svc });
    else if (domain==='light') draft.actions.push({ id:uid_simple(), type:'light', entity_ids_zone:tids, entity_ids_other:[], entity_ids:[], service:svc });
    else if (domain==='notify') draft.actions.push({ id:uid_simple(), type:'notify', target:`notify.${svc}`, message:a.data?.message||'', title:a.data?.title||'' });
    else if (domain==='alarm_control_panel') draft.actions.push({ id:uid_simple(), type:'arm', service:svc, entity_id:tids[0]||'' });
    else if (domain==='camera') draft.actions.push({ id:uid_simple(), type:'camera', service:svc, entity_ids:tids, service_data:a.data||{} });
    else draft.actions.push({ id:uid_simple(), type:'entity', entity_id:tids[0]||'', service:actionKey });
  }

  draft._ha_parse_warnings = warnings;
  return { draft, warnings };
}

function uid_simple() { return 'auto_' + Math.random().toString(36).slice(2,9); }

function nameSlug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`[HA-Overwatch] Port ${PORT} already in use. Try: node server.js ${PORT + 1}`);
  } else {
    console.error("[HA-Overwatch] Server error:", e.message);
  }
  process.exit(1);
});
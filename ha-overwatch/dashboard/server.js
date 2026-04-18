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
    return index.map(filename => {
      try {
        const text = fs.readFileSync(path.join(DATA_DIR, "config", "zones", filename), "utf8");
        return parseZoneYaml(text);
      } catch { return null; }
    }).filter(z => z && z.id);
  } catch { return []; }
}

function parseZoneYaml(text) {
  const z = { enabled: true };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes(":")) continue;
    const colonIdx = line.indexOf(":");
    const key = line.slice(0, colonIdx).trim();
    let   val = line.slice(colonIdx + 1).trim()
                   .replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if      (key === "id")      z.id      = val;
    else if (key === "name")    z.name    = val;
    else if (key === "enabled") z.enabled = val !== "false";
  }
  return z;
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

/* ─── ENTITY STATE FILE ────────────────────────────────────── */
const ENTITY_STATE_FILE = path.join(DATA_DIR, "config", "entity_state.json");

function loadEntityState() {
  try {
    return JSON.parse(fs.readFileSync(ENTITY_STATE_FILE, "utf8"));
  } catch {
    return { master: true, groups: {}, zones: {}, cameras: {} };
  }
}

function saveEntityState(state) {
  try {
    fs.mkdirSync(path.dirname(ENTITY_STATE_FILE), { recursive: true });
    fs.writeFileSync(ENTITY_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("[HA-Overwatch] Failed to save entity_state.json:", e.message);
  }
}

// Runtime state — triggered zones populated by server-side HA WS listener
const serverState = { triggeredZones: {} };

function buildEntityPayload() {
  const state  = loadEntityState();
  const zones  = loadZones();
  const groups = loadGroups();
  const triggered = serverState.triggeredZones;

  // All unique cameras across zones
  const cameraSet = new Set();
  zones.forEach(z => (z.cameras || []).forEach(c => cameraSet.add(c)));

  return {
    master: state.master !== false,
    groups: groups.map(g => ({
      id: g.id, name: g.name || g.id, zone_ids: g.zone_ids || [],
      enabled: state.groups[g.id] !== false,
    })),
    zones: zones.map(z => ({
      id: z.id, name: z.name || z.id,
      enabled:   state.zones[z.id] !== false,
      triggered: !!triggered[z.id],
    })),
    camera_groups: groups
      .filter(g => (g.zone_ids || []).some(zid => zones.find(z => z.id === zid && (z.cameras||[]).length > 0)))
      .map(g => ({ id: g.id, name: g.name || g.id, enabled: state.groups["cam_" + g.id] !== false })),
    camera_zones: zones
      .filter(z => (z.cameras || []).length > 0)
      .map(z => ({ id: z.id, name: z.name || z.id, enabled: state.zones["cam_" + z.id] !== false })),
    cameras: [...cameraSet].map(camId => ({
      id: camId, name: camId.replace(/^camera\./, "").replace(/_/g, " "),
      enabled: state.cameras[camId] !== false,
    })),
  };
}

async function pushStateToHA(payload) {
  const cfg = getHAConfig(loadConfig());
  if (!cfg.ha_token) return;
  const masterTriggered = payload.zones.some(z => z.triggered);
  const pushes = [
    haRestCall("POST", "/api/states/binary_sensor.overwatch_master_triggered",
      { state: masterTriggered ? "on" : "off",
        attributes: { friendly_name: "Overwatch Master Triggered", device_class: "motion" } }, cfg),
  ];
  payload.zones.forEach(z => {
    pushes.push(haRestCall("POST", `/api/states/binary_sensor.overwatch_zone_${z.id}_triggered`,
      { state: z.triggered ? "on" : "off",
        attributes: { friendly_name: `${z.name} Triggered`, device_class: "motion" } }, cfg));
  });
  payload.groups.forEach(g => {
    const gTriggered = (g.zone_ids || []).some(zid => payload.zones.find(z => z.id === zid)?.triggered);
    pushes.push(haRestCall("POST", `/api/states/binary_sensor.overwatch_group_${g.id}_triggered`,
      { state: gTriggered ? "on" : "off",
        attributes: { friendly_name: `${g.name} Triggered`, device_class: "motion" } }, cfg));
  });
  try { await Promise.all(pushes); } catch (e) {
    console.error("[HA-Overwatch] pushStateToHA error:", e.message);
  }
}

/* ─── HA REST API ─────────────────────────────────────────── */
function haRestCall(method, endpoint, body, cfg) {
  return new Promise((resolve, reject) => {
    const haUrl   = (cfg.ha_url || "").replace(/\/$/, "");
    const haToken = cfg.ha_token || "";
    if (!haUrl || !haToken) return reject(new Error("HA URL or token not configured"));

    let parsed;
    try { parsed = new URL(haUrl); } catch { return reject(new Error("Invalid HA URL")); }

    const isHttps   = parsed.protocol === "https:";
    const lib       = isHttps ? https : http;
    const bodyStr   = body ? JSON.stringify(body) : "";

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     endpoint,
      method,
      headers: {
        "Authorization":  `Bearer ${haToken}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };

    const req = lib.request(options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/* ─── ZONE ENTITY NAMING ──────────────────────────────────── */
// Must match haZoneSlug() in app.js exactly
function zoneSlug(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "zone";
}

function zoneEntityIds(zone) {
  const slug = zoneSlug(zone.name || zone.id);
  return {
    armed:     `input_boolean.overwatch_zone_${slug}_armed`,
    triggered: `input_boolean.overwatch_zone_${slug}_triggered`,
    slug,
  };
}

/* ─── HA ENTITY SETUP ─────────────────────────────────────── */
async function setupHAEntities(zones, cfg) {
  const results = [];
  const errors  = [];

  // Master entities
  const masterEntities = [
    { id: "input_boolean.overwatch_master_armed",     name: "Overwatch Master Armed",     icon: "mdi:shield-home",  state: "off" },
    { id: "input_boolean.overwatch_master_triggered", name: "Overwatch Master Triggered", icon: "mdi:shield-alert", state: "off" },
  ];

  for (const e of masterEntities) {
    try {
      const r = await haRestCall("POST", `/api/states/${e.id}`,
        { state: e.state, attributes: { friendly_name: e.name, icon: e.icon } }, cfg);
      results.push({ entity_id: e.id, status: r.status });
    } catch (ex) { errors.push({ entity_id: e.id, error: ex.message }); }
  }

  // Per-zone entities
  for (const zone of zones) {
    const ids = zoneEntityIds(zone);
    for (const [key, entityId] of [["armed", ids.armed], ["triggered", ids.triggered]]) {
      const isArmed     = key === "armed";
      const name        = `Overwatch Zone ${zone.name || zone.id} ${isArmed ? "Armed" : "Triggered"}`;
      const icon        = isArmed ? "mdi:shield-check" : "mdi:shield-alert";
      const initialState = isArmed ? (zone.enabled !== false ? "on" : "off") : "off";
      try {
        const r = await haRestCall("POST", `/api/states/${entityId}`,
          { state: initialState, attributes: { friendly_name: name, icon, zone_id: zone.id, zone_slug: ids.slug } }, cfg);
        results.push({ entity_id: entityId, status: r.status });
      } catch (ex) { errors.push({ entity_id: entityId, error: ex.message }); }
    }
  }

  return { results, errors };
}

/* ─── ZONE STATE SYNC ─────────────────────────────────────── */
async function syncZoneState(zoneId, zoneName, state, cfg) {
  const ids = zoneEntityIds({ id: zoneId, name: zoneName });
  const isTriggered = state === "triggered";
  const isDisabled  = state === "disabled" || state === "off";
  await haRestCall("POST", `/api/states/${ids.triggered}`,
    { state: isTriggered ? "on" : "off",
      attributes: { friendly_name: `Overwatch Zone ${zoneName} Triggered`, icon: "mdi:shield-alert", zone_id: zoneId } }, cfg);
  await haRestCall("POST", `/api/states/${ids.armed}`,
    { state: isDisabled ? "off" : "on",
      attributes: { friendly_name: `Overwatch Zone ${zoneName} Armed`, icon: "mdi:shield-check", zone_id: zoneId } }, cfg);
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
      isAddon,
      appDir:  APP_DIR,
      dataDir: DATA_DIR,
    });
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
      json(res, { ok: true });
    } catch (e) { err(res, e.message); }
    return;
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

  /* ── /api/ha-setup-zones ─────────────────────────────────── */
  if (pathname === "/ow/ha-setup-zones" && req.method === "POST") {
    try {
      const cfg   = getHAConfig(loadConfig());
      const zones = loadZones();
      if (!cfg.ha_url || !cfg.ha_token) {
        err(res, "HA URL or token not configured. Save settings first (standalone mode only).", 400);
        return;
      }
      const { results, errors } = await setupHAEntities(zones, cfg);
      const entityMap = {
        master: {
          armed:     "input_boolean.overwatch_master_armed",
          triggered: "input_boolean.overwatch_master_triggered",
        },
        zones: zones.map(z => ({ id: z.id, name: z.name, ...zoneEntityIds(z) })),
      };
      json(res, { ok: true, created: results.length, errors, entityMap, isAddon: cfg.isAddon });
    } catch (e) { err(res, e.message, 500); }
    return;
  }

  /* ── /api/ha-sync-zone ───────────────────────────────────── */
  if (pathname === "/ow/ha-sync-zone" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const cfg  = getHAConfig(loadConfig());
      if (!cfg.ha_url || !cfg.ha_token) { json(res, { ok: true, skipped: true }); return; }
      await syncZoneState(body.zoneId, body.zoneName, body.state, cfg);
      json(res, { ok: true });
    } catch (e) {
      console.error("[HA-Overwatch] ha-sync-zone error:", e.message);
      err(res, e.message, 500);
    }
    return;
  }

  /* ── /api/ha-sync-master ─────────────────────────────────── */
  if (pathname === "/ow/ha-sync-master" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const cfg  = getHAConfig(loadConfig());
      if (!cfg.ha_url || !cfg.ha_token) { json(res, { ok: true, skipped: true }); return; }
      await haRestCall("POST", "/api/states/input_boolean.overwatch_master_armed",
        { state: body.armed ? "on" : "off",
          attributes: { friendly_name: "Overwatch Master Armed", icon: "mdi:shield-home" } }, cfg);
      json(res, { ok: true });
    } catch (e) { err(res, e.message, 500); }
    return;
  }

  /* ── /ow/register-webhook — HA integration registers its webhook URL ── */
  if (pathname === "/ow/register-webhook" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (body.url) {
        haWebhookUrl = body.url;
        console.log("[HA-Overwatch] Webhook registered:", haWebhookUrl);
      }
      json(res, { ok: true });
    } catch (e) { err(res, e.message); }
    return;
  }

  /* ── /ow/entity-states — HA component polls this ─────────── */
  if (pathname === "/ow/entity-states" && req.method === "GET") {
    try {
      json(res, buildEntityPayload());
    } catch (e) { err(res, e.message, 500); }
    return;
  }

  /* ── /ow/entity-set — browser or HA component sets state ─── */
  if (pathname === "/ow/entity-set" && req.method === "POST") {
    try {
      const body  = await readBody(req);
      const { type, key, state } = body; // type: master|group|zone|camera_all|camera_group|camera_zone|camera
      const es = loadEntityState();

      if (type === "master") {
        es.master = !!state;
        // Propagate to all groups and zones
        const zones  = loadZones();
        const groups = loadGroups();
        groups.forEach(g => { es.groups[g.id] = !!state; });
        zones.forEach(z => { es.zones[z.id] = !!state; });
      } else if (type === "group") {
        es.groups[key] = !!state;
        // Propagate to member zones
        const groups = loadGroups();
        const group  = groups.find(g => g.id === key);
        if (group) group.zone_ids.forEach(zid => { es.zones[zid] = !!state; });
      } else if (type === "zone") {
        es.zones[key] = !!state;
      } else if (type === "camera_all") {
        const zones = loadZones();
        const cams  = new Set();
        zones.forEach(z => (z.cameras || []).forEach(c => cams.add(c)));
        cams.forEach(c => { es.cameras[c] = !!state; });
        const groups = loadGroups();
        groups.forEach(g => { es.groups["cam_" + g.id] = !!state; });
        zones.forEach(z => { es.zones["cam_" + z.id] = !!state; });
      } else if (type === "camera_group") {
        es.groups["cam_" + key] = !!state;
        const groups = loadGroups();
        const group  = groups.find(g => g.id === key);
        if (group) {
          const zones = loadZones();
          group.zone_ids.forEach(zid => {
            es.zones["cam_" + zid] = !!state;
            const z = zones.find(z => z.id === zid);
            if (z) (z.cameras || []).forEach(c => { es.cameras[c] = !!state; });
          });
        }
      } else if (type === "camera_zone") {
        es.zones["cam_" + key] = !!state;
        const zones = loadZones();
        const zone  = zones.find(z => z.id === key);
        if (zone) (zone.cameras || []).forEach(c => { es.cameras[c] = !!state; });
      } else if (type === "camera") {
        es.cameras[key] = !!state;
      }

      saveEntityState(es);

      // Build updated payload
      const payload = buildEntityPayload();

      // Push to HA coordinator via webhook (instant) and via HA REST for binary sensors
      pushToHAWebhook(payload);
      pushStateToHA(payload).catch(() => {});

      json(res, { ok: true, state: payload });
    } catch (e) { err(res, e.message, 500); }
    return;
  }

  /* ── Camera proxy ────────────────────────────────────────── */
  if (pathname.startsWith("/ow/camera_proxy")) {
    try {
      const cfg      = getHAConfig(loadConfig());
      if (!cfg.ha_url || !cfg.ha_token) { err(res, "HA not configured", 503); return; }
      const isStream = pathname.startsWith("/ow/camera_proxy_stream");
      const prefix   = isStream ? "/ow/camera_proxy_stream/" : "/ow/camera_proxy/";
      const entity   = pathname.slice(prefix.length).split("?")[0];
      if (!entity) { err(res, "Missing entity", 400); return; }

      // Camera proxy uses external HA URL + user long-lived token
      // (supervisor token blocked by Unifi Protect and some other integrations)
      const userCfg    = loadConfig();
      const userToken  = userCfg.ha_token || "";
      const proxyHaUrl = (userToken ? userCfg.ha_url : cfg.ha_url || "").replace(/\/$/, "");
      const authToken  = userToken || cfg.ha_token;

      const endpoint = isStream
        ? `/api/camera_proxy_stream/${entity}`
        : `/api/camera_proxy/${entity}`;

      console.log(`[CAM PROXY] ${isStream ? "stream" : "snap"} → ${entity}`);

      let parsed;
      try { parsed = new URL(proxyHaUrl); } catch { err(res, "Invalid HA URL", 500); return; }
      const isHttps = parsed.protocol === "https:";
      const lib     = isHttps ? https : http;

      const haReq = lib.request({
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     endpoint,
        method:   "GET",
        headers:  {
          "Authorization": `Bearer ${authToken}`,
          "Accept":        "image/jpeg,image/*,*/*",
        },
      }, haRes => {
        console.log(`[CAM PROXY] HA responded ${haRes.statusCode} for ${entity}`);
        const fwdHeaders = { "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" };
        if (haRes.headers["content-type"])   fwdHeaders["Content-Type"]   = haRes.headers["content-type"];
        if (haRes.headers["content-length"]) fwdHeaders["Content-Length"] = haRes.headers["content-length"];
        res.writeHead(haRes.statusCode, fwdHeaders);
        haRes.pipe(res);
      });
      haReq.on("error", e => { console.error("[CAM PROXY] error:", e.message); err(res, "Proxy error", 502); });
      haReq.end();
    } catch (e) { console.error("[CAM PROXY] exception:", e.message); err(res, e.message, 500); }
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
      if (ingressPath) {
        // Ingress: inject base tag so relative URLs route through HA ingress proxy
        const base = ingressPath.replace(/\/?$/, "/");
        html = html.replace("<head>", `<head>\n    <base href="${base}" />`);
      } else {
        // Direct LAN access: no base tag — relative URLs resolve to ha-ip:8099 directly
        // Mark the document so app.js knows it's in direct mode
        html = html.replace("<head>", `<head>\n    <meta name="ow-direct" content="true" />`);
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

  // Write custom component files immediately — must exist before HA loads
  writeCustomComponent();
  // Start server-side HA listener (small delay to let HA be ready)
  setTimeout(startHAListener, 3000);
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
from homeassistant.components.webhook import async_register, async_unregister
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from .const import DOMAIN, WEBHOOK_ID

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SWITCH, Platform.BINARY_SENSOR]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    url = entry.data[CONF_URL]
    coordinator = OverwatchCoordinator(hass, url)
    try:
        await coordinator.async_config_entry_first_refresh()
    except Exception as err:
        _LOGGER.error("Failed to connect to Overwatch add-on: %s", err)
        return False
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    async_register(hass, DOMAIN, "HA Overwatch Push", WEBHOOK_ID, coordinator.handle_webhook)
    await coordinator.register_webhook()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    async_unregister(hass, WEBHOOK_ID)
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


class OverwatchCoordinator(DataUpdateCoordinator):
    def __init__(self, hass: HomeAssistant, url: str) -> None:
        super().__init__(hass, _LOGGER, name="HA Overwatch", update_interval=timedelta(seconds=30))
        self.url = url

    async def _async_update_data(self) -> dict:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.url}/ow/entity-states",
                    timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status != 200:
                        raise UpdateFailed(f"Add-on returned {resp.status}")
                    return await resp.json(content_type=None)
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Cannot reach Overwatch add-on: {err}") from err

    async def handle_webhook(self, hass, webhook_id, request):
        try:
            data = await request.json()
            if data:
                self.async_set_updated_data(data)
        except Exception as err:
            _LOGGER.warning("Webhook parse error: %s", err)

    async def register_webhook(self):
        try:
            hass_url = self.hass.config.internal_url or self.hass.config.external_url or ""
            if not hass_url:
                return
            webhook_url = f"{hass_url.rstrip(chr(39))}/api/webhook/{WEBHOOK_ID}"
            async with aiohttp.ClientSession() as session:
                await session.post(f"{self.url}/ow/register-webhook",
                    json={"url": webhook_url}, timeout=aiohttp.ClientTimeout(total=5))
        except Exception:
            pass

    async def async_set_entity(self, entity_type: str, entity_key: str, state: bool) -> None:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{self.url}/ow/entity-set",
                    json={"type": entity_type, "key": entity_key, "state": state},
                    timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        if data.get("state"):
                            self.async_set_updated_data(data["state"])
                    else:
                        _LOGGER.warning("Overwatch entity-set returned %s", resp.status)
        except aiohttp.ClientError as err:
            _LOGGER.error("Cannot push state to Overwatch: %s", err)
`,
  "const.py": `"""Constants for HA Overwatch integration."""
DOMAIN = "ha_overwatch"
DEFAULT_URL = "http://localhost:8099"
WEBHOOK_ID = "ha_overwatch_push"
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
  "switch.py": `"""Switch platform for HA Overwatch."""
from __future__ import annotations
import logging
from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN
from . import OverwatchCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback) -> None:
    coordinator: OverwatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data or {}
    entities = [OverwatchMasterSwitch(coordinator)]
    for g in data.get("groups", []):    entities.append(OverwatchGroupSwitch(coordinator, g))
    for z in data.get("zones", []):     entities.append(OverwatchZoneSwitch(coordinator, z))
    entities.append(OverwatchCameraAllSwitch(coordinator))
    for g in data.get("camera_groups", []): entities.append(OverwatchCameraGroupSwitch(coordinator, g))
    for z in data.get("camera_zones", []):  entities.append(OverwatchCameraZoneSwitch(coordinator, z))
    for c in data.get("cameras", []):   entities.append(OverwatchCameraSwitch(coordinator, c))
    async_add_entities(entities)


def _dev(coordinator):
    return DeviceInfo(identifiers={(DOMAIN, "overwatch")}, name="HA Overwatch",
        manufacturer="HA Overwatch", model="Floor Plan Dashboard", configuration_url=coordinator.url)


class OWSwitch(CoordinatorEntity, SwitchEntity):
    _attr_should_poll = False
    def __init__(self, coordinator, uid, name, etype, ekey, icon="mdi:shield"):
        super().__init__(coordinator)
        self._attr_unique_id = uid
        self._attr_name = name
        self._attr_icon = icon
        self._attr_device_info = _dev(coordinator)
        self._etype = etype
        self._ekey = ekey
    @property
    def is_on(self): return True
    async def async_turn_on(self, **kw): await self.coordinator.async_set_entity(self._etype, self._ekey, True)
    async def async_turn_off(self, **kw): await self.coordinator.async_set_entity(self._etype, self._ekey, False)


class OverwatchMasterSwitch(OWSwitch):
    def __init__(self, c): super().__init__(c, "overwatch_zone_master", "Overwatch Zone Master", "master", "master", "mdi:shield-home")
    @property
    def is_on(self): return bool((self.coordinator.data or {}).get("master", True))

class OverwatchGroupSwitch(OWSwitch):
    def __init__(self, c, g):
        super().__init__(c, f"overwatch_zone_group_{g['id']}", f"Zone Group: {g.get('name', g['id'])}", "group", g["id"], "mdi:layers")
        self._gid = g["id"]
    @property
    def is_on(self):
        gs = (self.coordinator.data or {}).get("groups", [])
        g = next((x for x in gs if x["id"] == self._gid), None)
        return bool(g.get("enabled", True)) if g else True

class OverwatchZoneSwitch(OWSwitch):
    def __init__(self, c, z):
        super().__init__(c, f"overwatch_zone_{z['id']}", f"Zone: {z.get('name', z['id'])}", "zone", z["id"], "mdi:map-marker-radius")
        self._zid = z["id"]
    @property
    def is_on(self):
        zs = (self.coordinator.data or {}).get("zones", [])
        z = next((x for x in zs if x["id"] == self._zid), None)
        return bool(z.get("enabled", True)) if z else True

class OverwatchCameraAllSwitch(OWSwitch):
    def __init__(self, c): super().__init__(c, "overwatch_camera_all", "Camera All", "camera_all", "all", "mdi:cctv")
    @property
    def is_on(self):
        cs = (self.coordinator.data or {}).get("cameras", [])
        return all(x.get("enabled", True) for x in cs) if cs else True

class OverwatchCameraGroupSwitch(OWSwitch):
    def __init__(self, c, g):
        super().__init__(c, f"overwatch_camera_group_{g['id']}", f"Camera Group: {g.get('name', g['id'])}", "camera_group", g["id"], "mdi:cctv")
        self._gid = g["id"]
    @property
    def is_on(self):
        gs = (self.coordinator.data or {}).get("camera_groups", [])
        g = next((x for x in gs if x["id"] == self._gid), None)
        return bool(g.get("enabled", True)) if g else True

class OverwatchCameraZoneSwitch(OWSwitch):
    def __init__(self, c, z):
        super().__init__(c, f"overwatch_camera_zone_{z['id']}", f"Camera Zone: {z.get('name', z['id'])}", "camera_zone", z["id"], "mdi:cctv")
        self._zid = z["id"]
    @property
    def is_on(self):
        zs = (self.coordinator.data or {}).get("camera_zones", [])
        z = next((x for x in zs if x["id"] == self._zid), None)
        return bool(z.get("enabled", True)) if z else True

class OverwatchCameraSwitch(OWSwitch):
    def __init__(self, c, cam):
        cid = cam["id"]; safe = cid.replace(".", "_").replace("-", "_")
        super().__init__(c, f"overwatch_camera_{safe}", f"Camera: {cam.get('name', cid)}", "camera", cid, "mdi:cctv")
        self._cid = cid
    @property
    def is_on(self):
        cs = (self.coordinator.data or {}).get("cameras", [])
        c = next((x for x in cs if x["id"] == self._cid), None)
        return bool(c.get("enabled", True)) if c else True
`,
  "binary_sensor.py": `"""Binary sensor platform for HA Overwatch."""
from __future__ import annotations
from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN
from . import OverwatchCoordinator


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback) -> None:
    coordinator: OverwatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data or {}
    entities = [OverwatchMasterTriggered(coordinator)]
    for g in data.get("groups", []): entities.append(OverwatchGroupTriggered(coordinator, g))
    for z in data.get("zones", []):  entities.append(OverwatchZoneTriggered(coordinator, z))
    async_add_entities(entities)


def _dev(coordinator):
    return DeviceInfo(identifiers={(DOMAIN, "overwatch")}, name="HA Overwatch",
        manufacturer="HA Overwatch", model="Floor Plan Dashboard", configuration_url=coordinator.url)


class OWSensor(CoordinatorEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.MOTION
    _attr_should_poll = False
    def __init__(self, coordinator, uid, name):
        super().__init__(coordinator)
        self._attr_unique_id = uid
        self._attr_name = name
        self._attr_icon = "mdi:shield-alert"
        self._attr_device_info = _dev(coordinator)
    @property
    def is_on(self): return False


class OverwatchMasterTriggered(OWSensor):
    def __init__(self, c): super().__init__(c, "overwatch_zone_master_triggered", "Overwatch Zone Master Triggered")
    @property
    def is_on(self):
        return any(z.get("triggered", False) for z in (self.coordinator.data or {}).get("zones", []))

class OverwatchGroupTriggered(OWSensor):
    def __init__(self, c, g):
        super().__init__(c, f"overwatch_zone_group_{g['id']}_triggered", f"Zone Group Triggered: {g.get('name', g['id'])}")
        self._gid = g["id"]; self._zids = g.get("zone_ids", [])
    @property
    def is_on(self):
        return any(z.get("triggered", False) for z in (self.coordinator.data or {}).get("zones", []) if z["id"] in self._zids)

class OverwatchZoneTriggered(OWSensor):
    def __init__(self, c, z):
        super().__init__(c, f"overwatch_zone_{z['id']}_triggered", f"Zone Triggered: {z.get('name', z['id'])}")
        self._zid = z["id"]
    @property
    def is_on(self):
        zs = (self.coordinator.data or {}).get("zones", [])
        z = next((x for x in zs if x["id"] == self._zid), None)
        return bool(z.get("triggered", False)) if z else False
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
    "error": {
      "cannot_connect": "Cannot connect to HA Overwatch add-on.",
      "unknown": "Unexpected error."
    },
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
    "error": {
      "cannot_connect": "Cannot connect to HA Overwatch add-on.",
      "unknown": "Unexpected error."
    },
    "abort": { "already_configured": "HA Overwatch is already configured." }
  }
}
`,
  "manifest.json": `{
  "domain": "ha_overwatch",
  "name": "HA Overwatch",
  "version": "0.98.0",
  "documentation": "https://github.com/DM-AU/ha-overwatch",
  "issue_tracker": "https://github.com/DM-AU/ha-overwatch/issues",
  "codeowners": [],
  "requirements": [],
  "dependencies": [],
  "after_dependencies": [],
  "config_flow": true,
  "iot_class": "local_polling"
}
`,
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
      fs.writeFileSync(dest, content, "utf8");
      written++;
    }
    console.log(`[HA-Overwatch] Custom component written to ${destDir} (${written} files)`);
    console.log(`[HA-Overwatch] Restart Home Assistant to activate the HA Overwatch integration.`);
  } catch (e) {
    console.error("[HA-Overwatch] Failed to write custom component:", e.message);
  }
}


/* ─── WEBHOOK PUSH TO HA COORDINATOR ──────────────────────── */
let haWebhookUrl = null;

async function pushToHAWebhook(payload) {
  if (!haWebhookUrl) return;
  try {
    const parsed  = new URL(haWebhookUrl);
    const isHttps = parsed.protocol === "https:";
    const lib     = isHttps ? https : http;
    const body    = JSON.stringify(payload);
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ""),
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => { res.resume(); });
    req.on("error", () => {});
    req.write(body); req.end();
  } catch { /* ignore — coordinator still polls every 30s */ }
}

/* ─── SERVER-SIDE HA WEBSOCKET LISTENER ────────────────────── */
// Maintains a persistent server-to-HA WebSocket connection.
// Watches zone sensor states and updates serverState.triggeredZones,
// then pushes binary_sensor states to HA whenever a zone triggers/clears.
function startHAListener() {
  if (!process.env.SUPERVISOR_TOKEN) return;
  const net = require("net");

  let msgId     = 1;
  let authDone  = false;
  let subId     = null;
  let recBuf    = Buffer.alloc(0);
  let reconnectDelay = 5000;

  function connect() {
    const sock = net.connect({ host: "homeassistant", port: 8123 });

    // Upgrade to WebSocket manually
    const crypto = require("crypto");
    const wsKey  = crypto.randomBytes(16).toString("base64");
    sock.write(
      "GET /api/websocket HTTP/1.1\r\n" +
      "Host: homeassistant\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n"
    );

    function send(obj) {
      sendWsFrame(sock, JSON.stringify({ ...obj, id: msgId++ }));
    }

    let httpDone = false;
    sock.on("data", chunk => {
      if (!httpDone) {
        const s = chunk.toString();
        if (s.includes("\r\n\r\n")) {
          httpDone = true;
          const rest = chunk.slice(chunk.indexOf("\r\n\r\n") + 4);
          if (rest.length > 0) processChunk(rest);
        }
        return;
      }
      processChunk(chunk);
    });

    function processChunk(chunk) {
      recBuf = Buffer.concat([recBuf, chunk]);
      while (true) {
        const text = extractWsPayload(recBuf);
        if (text === null) break;
        // advance buffer past this frame
        const used = frameLength(recBuf);
        if (used <= 0) break;
        recBuf = recBuf.slice(used);
        try { handleMsg(JSON.parse(text)); } catch {}
      }
    }

    function handleMsg(msg) {
      if (msg.type === "auth_required") {
        sendWsFrame(sock, JSON.stringify({
          type: "auth", access_token: process.env.SUPERVISOR_TOKEN,
        }));
        return;
      }
      if (msg.type === "auth_ok") {
        authDone = true;
        reconnectDelay = 5000;
        console.log("[HA-Overwatch] Server HA listener authenticated");
        // Subscribe to all state_changed events
        send({ type: "subscribe_events", event_type: "state_changed" });
        return;
      }
      if (msg.type === "result" && msg.success && !subId) {
        subId = msg.id;
        return;
      }
      if (msg.type === "event" && msg.event?.event_type === "state_changed") {
        const { entity_id, new_state } = msg.event.data || {};
        if (!entity_id || !new_state) return;
        onStateChanged(entity_id, new_state.state);
      }
    }

    sock.on("error", e  => { console.error("[HA-Overwatch] HA listener error:", e.message); scheduleReconnect(); });
    sock.on("close", () => { console.log("[HA-Overwatch] HA listener disconnected"); scheduleReconnect(); });
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  }

  // Called when any HA entity state changes
  function onStateChanged(entityId, state) {
    const zones  = loadZones();
    const groups = loadGroups();

    // Build map of sensor → zone(s)
    let changed = false;
    zones.forEach(zone => {
      const sensors = zone.sensors || [];
      if (!sensors.includes(entityId)) return;
      const isTriggered = ["on", "open", "detected", "home", "triggered"].includes((state || "").toLowerCase());
      if (!!serverState.triggeredZones[zone.id] !== isTriggered) {
        serverState.triggeredZones[zone.id] = isTriggered;
        changed = true;
      }
    });

    if (changed) {
      const payload = buildEntityPayload();
      pushToHAWebhook(payload);
      pushStateToHA(payload).catch(() => {});
    }
  }

  connect();
}

// Calculate byte length of a WS frame (to advance buffer)
function frameLength(buf) {
  if (buf.length < 2) return -1;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return -1; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) return -1;
  const masked = (buf[1] & 0x80) !== 0;
  if (masked) offset += 4;
  return offset + len;
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

  // Connect to HA Core WebSocket — use internal hostname 'homeassistant' on port 8123
  const haReq = http.request({
    hostname: "homeassistant",
    port:     8123,
    path:     "/api/websocket",
    headers: {
      "Host":                  "homeassistant",
      "Upgrade":               "websocket",
      "Connection":            "Upgrade",
      "Sec-WebSocket-Key":     crypto.randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
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
          // Forward auth_required to browser so it knows to send auth
          try { socket.write(haBuf); } catch {}
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
      if (authState === "done") { try { haSocket.write(chunk); } catch {} return; }

      // Buffer browser data during auth exchange
      broBuf = Buffer.concat([broBuf, chunk]);
      const payload = extractWsPayload(broBuf);
      if (payload === null) return;

      try {
        const msg = JSON.parse(payload);
        if (msg.type === "auth") {
          // Replace whatever token browser sent with our real token
          console.log("[HA-Overwatch] WS proxy: replacing browser auth token with stored token");
          sendWsFrame(haSocket, JSON.stringify({ type: "auth", access_token: haToken }));
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
    return null; // skip large frames
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

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`[HA-Overwatch] Port ${PORT} already in use. Try: node server.js ${PORT + 1}`);
  } else {
    console.error("[HA-Overwatch] Server error:", e.message);
  }
  process.exit(1);
});

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
      fs.writeFileSync(dest, content, "utf8");
      written++;
    }
    console.log(`[HA-Overwatch] Custom component written to ${destDir} (${written} files)`);
    console.log(`[HA-Overwatch] Restart Home Assistant to activate the HA Overwatch integration.`);
  } catch (e) {
    console.error("[HA-Overwatch] Failed to write custom component:", e.message);
  }
}

/* ─── SERVER-SIDE HA WEBSOCKET LISTENER ────────────────────── */
// Maintains a persistent server-to-HA WebSocket connection.
// Watches zone sensor states and updates serverState.triggeredZones,
// then pushes binary_sensor states to HA whenever a zone triggers/clears.
function startHAListener() {
  if (!process.env.SUPERVISOR_TOKEN) return;
  const net = require("net");

  let msgId     = 1;
  let authDone  = false;
  let subId     = null;
  let recBuf    = Buffer.alloc(0);
  let reconnectDelay = 5000;

  function connect() {
    const sock = net.connect({ host: "homeassistant", port: 8123 });

    // Upgrade to WebSocket manually
    const crypto = require("crypto");
    const wsKey  = crypto.randomBytes(16).toString("base64");
    sock.write(
      "GET /api/websocket HTTP/1.1\r\n" +
      "Host: homeassistant\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n"
    );

    function send(obj) {
      sendWsFrame(sock, JSON.stringify({ ...obj, id: msgId++ }));
    }

    let httpDone = false;
    sock.on("data", chunk => {
      if (!httpDone) {
        const s = chunk.toString();
        if (s.includes("\r\n\r\n")) {
          httpDone = true;
          const rest = chunk.slice(chunk.indexOf("\r\n\r\n") + 4);
          if (rest.length > 0) processChunk(rest);
        }
        return;
      }
      processChunk(chunk);
    });

    function processChunk(chunk) {
      recBuf = Buffer.concat([recBuf, chunk]);
      while (true) {
        const text = extractWsPayload(recBuf);
        if (text === null) break;
        // advance buffer past this frame
        const used = frameLength(recBuf);
        if (used <= 0) break;
        recBuf = recBuf.slice(used);
        try { handleMsg(JSON.parse(text)); } catch {}
      }
    }

    function handleMsg(msg) {
      if (msg.type === "auth_required") {
        sendWsFrame(sock, JSON.stringify({
          type: "auth", access_token: process.env.SUPERVISOR_TOKEN,
        }));
        return;
      }
      if (msg.type === "auth_ok") {
        authDone = true;
        reconnectDelay = 5000;
        console.log("[HA-Overwatch] Server HA listener authenticated");
        // Subscribe to all state_changed events
        send({ type: "subscribe_events", event_type: "state_changed" });
        return;
      }
      if (msg.type === "result" && msg.success && !subId) {
        subId = msg.id;
        return;
      }
      if (msg.type === "event" && msg.event?.event_type === "state_changed") {
        const { entity_id, new_state } = msg.event.data || {};
        if (!entity_id || !new_state) return;
        onStateChanged(entity_id, new_state.state);
      }
    }

    sock.on("error", e  => { console.error("[HA-Overwatch] HA listener error:", e.message); scheduleReconnect(); });
    sock.on("close", () => { console.log("[HA-Overwatch] HA listener disconnected"); scheduleReconnect(); });
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  }

  // Called when any HA entity state changes
  function onStateChanged(entityId, state) {
    const zones  = loadZones();
    const groups = loadGroups();

    // Build map of sensor → zone(s)
    let changed = false;
    zones.forEach(zone => {
      const sensors = zone.sensors || [];
      if (!sensors.includes(entityId)) return;
      const isTriggered = ["on", "open", "detected", "home", "triggered"].includes((state || "").toLowerCase());
      if (!!serverState.triggeredZones[zone.id] !== isTriggered) {
        serverState.triggeredZones[zone.id] = isTriggered;
        changed = true;
      }
    });

    if (changed) {
      const payload = buildEntityPayload();
      pushStateToHA(payload).catch(() => {});
    }
  }

  connect();
}

// Calculate byte length of a WS frame (to advance buffer)
function frameLength(buf) {
  if (buf.length < 2) return -1;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return -1; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) return -1;
  const masked = (buf[1] & 0x80) !== 0;
  if (masked) offset += 4;
  return offset + len;
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

  // Connect to HA Core WebSocket — use internal hostname 'homeassistant' on port 8123
  const haReq = http.request({
    hostname: "homeassistant",
    port:     8123,
    path:     "/api/websocket",
    headers: {
      "Host":                  "homeassistant",
      "Upgrade":               "websocket",
      "Connection":            "Upgrade",
      "Sec-WebSocket-Key":     crypto.randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
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
          // Forward auth_required to browser so it knows to send auth
          try { socket.write(haBuf); } catch {}
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
      if (authState === "done") { try { haSocket.write(chunk); } catch {} return; }

      // Buffer browser data during auth exchange
      broBuf = Buffer.concat([broBuf, chunk]);
      const payload = extractWsPayload(broBuf);
      if (payload === null) return;

      try {
        const msg = JSON.parse(payload);
        if (msg.type === "auth") {
          // Replace whatever token browser sent with our real token
          console.log("[HA-Overwatch] WS proxy: replacing browser auth token with stored token");
          sendWsFrame(haSocket, JSON.stringify({ type: "auth", access_token: haToken }));
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
    return null; // skip large frames
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

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`[HA-Overwatch] Port ${PORT} already in use. Try: node server.js ${PORT + 1}`);
  } else {
    console.error("[HA-Overwatch] Server error:", e.message);
  }
  process.exit(1);
});
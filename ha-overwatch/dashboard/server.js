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

  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  /* ── /api/health ─────────────────────────────────────────── */
  if (pathname === "/ow/health") {
    const isAddon = !!process.env.SUPERVISOR_TOKEN;
    json(res, {
      ok: true,
      app: "ha-overwatch",
      version: "1.0.6",
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

  /* ── Static file serving ─────────────────────────────────── */
  // Static app files served from APP_DIR (script directory)
  // Data files (config/, img/) served from DATA_DIR
  let reqPath = pathname === "/" ? "/index.html" : pathname;
  reqPath = reqPath.replace(/\.\./g, "");

  // Data paths: serve from DATA_DIR
  let filePath;
  if (reqPath.startsWith("/config/") || reqPath.startsWith("/img/")) {
    filePath = path.join(DATA_DIR, reqPath);
    if (!filePath.startsWith(path.resolve(DATA_DIR))) { err(res, "Forbidden", 403); return; }
  } else {
    filePath = path.join(APP_DIR, reqPath);
    if (!filePath.startsWith(path.resolve(APP_DIR))) { err(res, "Forbidden", 403); return; }
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const ext     = path.extname(filePath).toLowerCase();
    const mime    = MIME[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type":  mime,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found: " + pathname);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HA-Overwatch] Server running at http://0.0.0.0:${PORT}`);
  console.log(`[HA-Overwatch] App directory:  ${APP_DIR}`);
  console.log(`[HA-Overwatch] Data directory: ${DATA_DIR}`);
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`[HA-Overwatch] Port ${PORT} already in use. Try: node server.js ${PORT + 1}`);
  } else {
    console.error("[HA-Overwatch] Server error:", e.message);
  }
  process.exit(1);
});

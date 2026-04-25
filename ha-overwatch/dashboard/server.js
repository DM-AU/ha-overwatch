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
  const z = { enabled: true, sensors: [], cameras: [], lights: [], sirens: [] };
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // List section headers
    if (line === "sensors:") { section = "sensors"; continue; }
    if (line === "cameras:") { section = "cameras"; continue; }
    if (line === "lights:")  { section = "lights";  continue; }
    if (line === "sirens:")  { section = "sirens";  continue; }
    if (line === "points:")  { section = "points";  continue; }
    // List items
    if (line.startsWith("- ") && section) {
      const val = line.slice(2).trim();
      if (section === "sensors") z.sensors.push(val);
      else if (section === "cameras") z.cameras.push(val);
      else if (section === "lights")  z.lights.push(val);
      else if (section === "sirens")  z.sirens.push(val);
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
  return z;
}

/* ─── FLOORS ──────────────────────────────────────────────── */
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
const globalTriggeredZones = {}; // nameSlug(zone.name) -> bool

// Full HA entity state cache — written by startHAListener, read by /ow/states endpoint
// Keyed by entity_id, value is the full HA state object {entity_id, state, attributes, ...}
const serverHaStates = {};

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

  /* ── /ow/triggered — coordinator polls for zone triggered states ── */
  if (pathname === "/ow/triggered" && req.method === "GET") {
    json(res, globalTriggeredZones);
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
  writeCustomComponent();
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
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SWITCH, Platform.BINARY_SENSOR]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    url = entry.data[CONF_URL]

    # Zone structure coordinator — polls /ow/zones hourly
    zone_coordinator = ZoneCoordinator(hass, url)
    try:
        await zone_coordinator.async_config_entry_first_refresh()
    except Exception as err:
        _LOGGER.error("Failed to fetch zone structure: %s", err)
        return False

    # Triggered state coordinator — polls /ow/triggered every 2s
    triggered_coordinator = TriggeredCoordinator(hass, url)
    await triggered_coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {
        "zone_coordinator":     zone_coordinator,
        "triggered_coordinator": triggered_coordinator,
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
            update_interval=timedelta(hours=1))
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
    """Polls /ow/triggered every 2s for zone triggered states."""

    def __init__(self, hass: HomeAssistant, url: str) -> None:
        super().__init__(hass, _LOGGER, name="HA Overwatch Triggered",
            update_interval=timedelta(seconds=2))
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
    data = coordinator.data or {}

    entities = [OverwatchMasterSwitch(coordinator)]
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

    _LOGGER.info("Overwatch: registering %d switch entities", len(entities))
    async_add_entities(entities, update_before_add=False)


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


class OverwatchMasterSwitch(OWSwitch):
    def __init__(self, c):
        super().__init__(c,
            entity_id="switch.overwatch_zone_master",
            unique_id="overwatch_zone_master",
            name="Overwatch Zone Master",
            icon="mdi:shield-home")


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
        safe = cid.replace(".", "_").replace("-", "_")
        super().__init__(c,
            entity_id=f"switch.overwatch_camera_{safe}",
            unique_id=f"overwatch_camera_{safe}",
            name=f"Camera: {cam.get('name', cid)}",
            icon="mdi:cctv")
`,
  "binary_sensor.py": `"""Binary sensor platform for HA Overwatch.

Reads triggered state from TriggeredCoordinator which polls /ow/triggered every 2s.
State is computed server-side from actual HA sensor state_changed events.
"""
from __future__ import annotations
import logging
from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN
from . import TriggeredCoordinator, ZoneCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    data               = hass.data[DOMAIN][entry.entry_id]
    zone_coordinator   = data["zone_coordinator"]
    trig_coordinator   = data["triggered_coordinator"]
    zones_data         = zone_coordinator.data or {}

    entities = [OverwatchMasterTriggered(trig_coordinator, zone_coordinator)]
    for g in zones_data.get("groups", []):
        entities.append(OverwatchGroupTriggered(trig_coordinator, g))
    for z in zones_data.get("zones", []):
        entities.append(OverwatchZoneTriggered(trig_coordinator, z))

    _LOGGER.info("Overwatch: registering %d binary sensor entities", len(entities))
    async_add_entities(entities, update_before_add=False)


def _dev(url: str) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "overwatch")},
        name="HA Overwatch",
        manufacturer="HA Overwatch",
        model="Floor Plan Dashboard",
        configuration_url=url,
    )


class OWSensor(CoordinatorEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.MOTION
    _attr_should_poll  = False

    def __init__(self, coordinator: TriggeredCoordinator, entity_id: str,
                 unique_id: str, name: str, url: str = ""):
        super().__init__(coordinator)
        self.entity_id        = entity_id
        self._attr_unique_id  = unique_id
        self._attr_name       = name
        self._attr_icon       = "mdi:shield-alert"
        self._attr_device_info = _dev(url)

    @property
    def triggered_data(self) -> dict:
        return self.coordinator.data or {}

    @property
    def is_on(self) -> bool:
        return False


class OverwatchMasterTriggered(OWSensor):
    def __init__(self, trig: TriggeredCoordinator, zone_coord: ZoneCoordinator):
        super().__init__(trig,
            entity_id="binary_sensor.overwatch_zone_master_triggered",
            unique_id="overwatch_zone_master_triggered",
            name="Overwatch Zone Master Triggered",
            url=trig.url)
        self._zone_coord = zone_coord

    @property
    def is_on(self) -> bool:
        return any(v for v in self.triggered_data.values())


class OverwatchGroupTriggered(OWSensor):
    def __init__(self, trig: TriggeredCoordinator, g: dict):
        gid = g["id"]
        super().__init__(trig,
            entity_id=f"binary_sensor.overwatch_zone_group_{gid}_triggered",
            unique_id=f"overwatch_zone_group_{gid}_triggered",
            name=f"Zone Group Triggered: {g.get('name', gid)}",
            url=trig.url)
        self._zone_ids = g.get("zone_ids", [])

    @property
    def is_on(self) -> bool:
        return any(self.triggered_data.get(zid, False) for zid in self._zone_ids)


class OverwatchZoneTriggered(OWSensor):
    def __init__(self, trig: TriggeredCoordinator, z: dict):
        zid = z["id"]
        super().__init__(trig,
            entity_id=f"binary_sensor.overwatch_zone_{zid}_triggered",
            unique_id=f"overwatch_zone_{zid}_triggered",
            name=f"Zone Triggered: {z.get('name', zid)}",
            url=trig.url)
        self._zid = zid

    @property
    def is_on(self) -> bool:
        return bool(self.triggered_data.get(self._zid, False))
`,
  "manifest.json": `{
  "domain": "ha_overwatch",
  "name": "HA Overwatch",
  "version": "1.14.0",
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
  let msgId = 1;

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
        sendWsFrame(sock, JSON.stringify({ ...obj, id: msgId++ }));
      }

      // Send a ping every 30s to keep connection alive
      const pingTimer = setInterval(() => {
        if (!connected) { clearInterval(pingTimer); return; }
        try {
          // WS ping frame: opcode 0x9, no payload
          sock.write(Buffer.from([0x89, 0x00]));
        } catch { clearInterval(pingTimer); }
      }, 30000);

      sock.on("data", chunk => {
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
        connected = false;
        clearInterval(pingTimer);
        console.log("[HA-Overwatch] HA listener disconnected");
        scheduleReconnect();
      });
      sock.on("error", e => {
        connected = false;
        clearInterval(pingTimer);
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
      setInterval(refreshZoneCache, 60000); // keep cache fresh
      send({ type: "subscribe_events", event_type: "state_changed" });
      // Fetch all current entity states into cache for /ow/states endpoint
      send({ type: "get_states" });
      return;
    }
    // Populate serverHaStates from get_states response
    if (msg.type === "result" && Array.isArray(msg.result)) {
      msg.result.forEach(st => { if (st.entity_id) serverHaStates[st.entity_id] = st; });
      console.log(`[HA-Overwatch] State cache populated: ${Object.keys(serverHaStates).length} entities`);
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
    if (serverHaStates[entityId]) {
      serverHaStates[entityId] = { ...serverHaStates[entityId], state: on ? 'on' : 'off' };
    }
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
      const allZones = loadZones();
      const floorZones = allZones.filter(z => z.floor_id === fid);
      if (floorZones.length > 0) {
        console.log(`[HA-Overwatch] Cascade: zone floor ${fid} → ${on ? 'on' : 'off'} (${floorZones.length} zones)`);
        floorZones.forEach(z => callHASwitch(`switch.overwatch_zone_${nameSlug(z.name) || z.id}`, on));
      }
      return;
    }

    // Camera floor → all camera zones + cameras on that floor
    if (entityId.startsWith('switch.overwatch_camera_floor_')) {
      const fid = entityId.replace('switch.overwatch_camera_floor_', '');
      const allZones = loadZones();
      const floorZones = allZones.filter(z => z.floor_id === fid && (z.cameras || []).length > 0);
      if (floorZones.length > 0) {
        console.log(`[HA-Overwatch] Cascade: camera floor ${fid} → ${on ? 'on' : 'off'} (${floorZones.length} zones)`);
        floorZones.forEach(z => {
          callHASwitch(`switch.overwatch_camera_zone_${nameSlug(z.name) || z.id}`, on);
          (z.cameras || []).forEach(camId => {
            const safe = camId.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
            callHASwitch(`switch.overwatch_camera_${safe}`, on);
          });
        });
      }
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

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
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

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`[HA-Overwatch] Port ${PORT} already in use. Try: node server.js ${PORT + 1}`);
  } else {
    console.error("[HA-Overwatch] Server error:", e.message);
  }
  process.exit(1);
});
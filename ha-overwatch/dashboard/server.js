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

    // For index.html: inject <base> tag so relative URLs resolve through ingress correctly
    if (filePath.endsWith("index.html")) {
      let html = fs.readFileSync(filePath, "utf8");
      const ingressPath = req.headers["x-ingress-path"] || "";
      const base = ingressPath ? ingressPath.replace(/\/?$/, "/") : "./";
      html = html.replace("<head>", `<head>\n    <base href="${base}" />`);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
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
});

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
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

// Update the enabled: field in a zone's YAML file so the dashboard sees the change
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

  /* ── /ow/zones — component fetches zone/group/camera structure ── */
  if (pathname === "/ow/zones" && req.method === "GET") {
    try {
      const zones  = loadZones();
      const groups = loadGroups();
      const cameraSet = new Set();
      zones.forEach(z => (z.cameras || []).forEach(c => cameraSet.add(c)));
      json(res, {
        zones:  zones.map(z => ({ id: z.id, name: z.name || z.id })),
        groups: groups.map(g => ({ id: g.id, name: g.name || g.id, zone_ids: g.zone_ids || [] })),
        camera_groups: groups
          .filter(g => (g.zone_ids || []).some(zid =>
            zones.find(z => z.id === zid && (z.cameras || []).length > 0)))
          .map(g => ({ id: g.id, name: g.name || g.id })),
        camera_zones: zones
          .filter(z => (z.cameras || []).length > 0)
          .map(z => ({ id: z.id, name: z.name || z.id })),
        cameras: [...cameraSet].map(id => ({
          id, name: id.replace(/^camera\./, '').replace(/_/g, ' '),
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
    coordinator = OverwatchCoordinator(hass, url)
    try:
        await coordinator.async_config_entry_first_refresh()
    except Exception as err:
        _LOGGER.error("Failed to fetch zone structure from Overwatch: %s", err)
        return False
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


class OverwatchCoordinator(DataUpdateCoordinator):
    """Fetches zone/group/camera structure from the add-on (rarely changes)."""

    def __init__(self, hass: HomeAssistant, url: str) -> None:
        super().__init__(
            hass, _LOGGER, name="HA Overwatch",
            update_interval=timedelta(hours=1),
        )
        self.url = url

    async def _async_update_data(self) -> dict:
        """Fetch zone structure — only needed at startup and when zones change."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.url}/ow/zones",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status != 200:
                        raise UpdateFailed(f"Add-on returned {resp.status}")
                    data = await resp.json(content_type=None)
                    _LOGGER.info(
                        "Overwatch: %d zones, %d groups, %d cameras",
                        len(data.get("zones", [])),
                        len(data.get("groups", [])),
                        len(data.get("cameras", [])),
                    )
                    return data
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Cannot reach Overwatch add-on: {err}") from err
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
from . import OverwatchCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: OverwatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data or {}

    entities = [OverwatchMasterSwitch(coordinator)]
    for g in data.get("groups", []):
        entities.append(OverwatchGroupSwitch(coordinator, g))
    for z in data.get("zones", []):
        entities.append(OverwatchZoneSwitch(coordinator, z))
    entities.append(OverwatchCameraAllSwitch(coordinator))
    for g in data.get("camera_groups", []):
        entities.append(OverwatchCameraGroupSwitch(coordinator, g))
    for z in data.get("camera_zones", []):
        entities.append(OverwatchCameraZoneSwitch(coordinator, z))
    for c in data.get("cameras", []):
        entities.append(OverwatchCameraSwitch(coordinator, c))

    _LOGGER.info("Overwatch: registering %d switch entities", len(entities))
    async_add_entities(entities, update_before_add=False)


def _dev(coordinator: OverwatchCoordinator) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "overwatch")},
        name="HA Overwatch",
        manufacturer="HA Overwatch",
        model="Floor Plan Dashboard",
        configuration_url=coordinator.url,
    )


class OWSwitch(CoordinatorEntity, SwitchEntity, RestoreEntity):
    """Base switch — state lives in HA, restored across restarts."""

    _attr_should_poll = False

    def __init__(self, coordinator, uid, name, icon="mdi:shield"):
        super().__init__(coordinator)
        self._attr_unique_id = uid
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
        super().__init__(c, "overwatch_zone_master", "Overwatch Zone Master", "mdi:shield-home")

class OverwatchGroupSwitch(OWSwitch):
    def __init__(self, c, g):
        super().__init__(c, f"overwatch_zone_group_{g['id']}", f"Zone Group: {g.get('name', g['id'])}", "mdi:layers")

class OverwatchZoneSwitch(OWSwitch):
    def __init__(self, c, z):
        super().__init__(c, f"overwatch_zone_{z['id']}", f"Zone: {z.get('name', z['id'])}", "mdi:map-marker-radius")

class OverwatchCameraAllSwitch(OWSwitch):
    def __init__(self, c):
        super().__init__(c, "overwatch_camera_all", "Camera All", "mdi:cctv")

class OverwatchCameraGroupSwitch(OWSwitch):
    def __init__(self, c, g):
        super().__init__(c, f"overwatch_camera_group_{g['id']}", f"Camera Group: {g.get('name', g['id'])}", "mdi:cctv")

class OverwatchCameraZoneSwitch(OWSwitch):
    def __init__(self, c, z):
        super().__init__(c, f"overwatch_camera_zone_{z['id']}", f"Camera Zone: {z.get('name', z['id'])}", "mdi:cctv")

class OverwatchCameraSwitch(OWSwitch):
    def __init__(self, c, cam):
        cid = cam["id"]
        safe = cid.replace(".", "_").replace("-", "_")
        super().__init__(c, f"overwatch_camera_{safe}", f"Camera: {cam.get('name', cid)}", "mdi:cctv")
`,
  "binary_sensor.py": `"""Binary sensor platform for HA Overwatch.

Triggered states are pushed directly by the server-side HA listener
via POST /api/states/binary_sensor.overwatch_zone_*
These entities are created here so HA knows about them,
but their state is written externally by the server.
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
from . import OverwatchCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: OverwatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data or {}
    entities = [OverwatchMasterTriggered(coordinator)]
    for g in data.get("groups", []):
        entities.append(OverwatchGroupTriggered(coordinator, g))
    for z in data.get("zones", []):
        entities.append(OverwatchZoneTriggered(coordinator, z))
    _LOGGER.info("Overwatch: registering %d binary sensor entities", len(entities))
    async_add_entities(entities, update_before_add=False)


def _dev(coordinator: OverwatchCoordinator) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "overwatch")},
        name="HA Overwatch",
        manufacturer="HA Overwatch",
        model="Floor Plan Dashboard",
        configuration_url=coordinator.url,
    )


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
    def is_on(self) -> bool:
        return False


class OverwatchMasterTriggered(OWSensor):
    def __init__(self, c):
        super().__init__(c, "overwatch_zone_master_triggered", "Overwatch Zone Master Triggered")

class OverwatchGroupTriggered(OWSensor):
    def __init__(self, c, g):
        super().__init__(c, f"overwatch_zone_group_{g['id']}_triggered",
                         f"Zone Group Triggered: {g.get('name', g['id'])}")

class OverwatchZoneTriggered(OWSensor):
    def __init__(self, c, z):
        super().__init__(c, f"overwatch_zone_{z['id']}_triggered",
                         f"Zone Triggered: {z.get('name', z['id'])}")
`,
  "manifest.json": `{
  "domain": "ha_overwatch",
  "name": "HA Overwatch",
  "version": "1.03.0",
  "documentation": "https://github.com/DM-AU/ha-overwatch",
  "issue_tracker": "https://github.com/DM-AU/ha-overwatch/issues",
  "codeowners": [],
  "requirements": [],
  "dependencies": [],
  "after_dependencies": [],
  "config_flow": true,
  "iot_class": "local_push"
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


/* ─── SERVER-SIDE HA WEBSOCKET LISTENER ────────────────────── */
// Maintains a persistent server-to-HA WebSocket connection.
// Watches zone sensor states and updates serverState.triggeredZones,
// then pushes binary_sensor states to HA whenever a zone triggers/clears.
/* ─── SERVER-SIDE HA STATE LISTENER ────────────────────────── */
// Watches HA entity state changes via supervisor WebSocket API.
// When a zone's sensors trigger/clear, pushes binary_sensor state to HA.
// Uses supervisor token + internal supervisor API — no login warnings.

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

      function send(obj) {
        sendWsFrame(sock, JSON.stringify({ ...obj, id: msgId++ }));
      }

      sock.on("data", chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          const text = extractWsPayload(buf);
          if (text === null) break;
          const used = frameLength(buf);
          if (used <= 0) break;
          buf = buf.slice(used);
          try { handleMsg(JSON.parse(text), send, sock); } catch {}
        }
      });

      sock.on("close", () => {
        console.log("[HA-Overwatch] HA listener disconnected");
        scheduleReconnect();
      });
      sock.on("error", e => {
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

  const triggeredZones = {}; // zoneId -> bool

  function handleMsg(msg, send, sock) {
    if (msg.type === "auth_required") {
      // Send auth using supervisor token
      sendWsFrame(sock, JSON.stringify({
        type: "auth", access_token: process.env.SUPERVISOR_TOKEN,
      }));
      return;
    }
    if (msg.type === "auth_ok") {
      send({ type: "subscribe_events", event_type: "state_changed" });
      return;
    }
    if (msg.type === "event" && msg.event?.event_type === "state_changed") {
      const { entity_id, new_state } = msg.event.data || {};
      if (!entity_id || !new_state) return;
      onStateChanged(entity_id, new_state.state || "");
    }
  }

  function onStateChanged(entityId, state) {
    const zones = loadZones();
    const triggered = ["on","open","detected","home","triggered"]
      .includes((state || "").toLowerCase());
    let changed = false;

    zones.forEach(zone => {
      if (!(zone.sensors || []).includes(entityId)) return;
      const wasTriggered = !!triggeredZones[zone.id];
      // Zone is triggered if ANY of its sensors are triggered
      const sensors = zone.sensors || [];
      // We only have this one sensor's new state — keep others as-is
      // Use a per-sensor map for accuracy
      triggeredZones[`${zone.id}::${entityId}`] = triggered;
      const zoneNowTriggered = sensors.some(sid =>
        triggeredZones[`${zone.id}::${sid}`] === true);
      if (zoneNowTriggered !== wasTriggered) {
        triggeredZones[zone.id] = zoneNowTriggered;
        pushBinarySensor(zone, zoneNowTriggered);
        changed = true;
      }
    });
  }

  function pushBinarySensor(zone, isTriggered) {
    if (!process.env.SUPERVISOR_TOKEN) return;
    const entityId = `binary_sensor.overwatch_zone_${zone.id}_triggered`;
    const name     = `Zone Triggered: ${zone.name || zone.id}`;
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
    }, res => { res.resume(); });
    req.on("error", () => {});
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
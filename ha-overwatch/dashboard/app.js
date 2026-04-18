/* ============================================================
 * HA-Overwatch — app.js  (Phase 1 v2)
 *
 * Fixes & features in this revision:
 *  1. Larger sidebar icons (28px default)
 *  2. Search highlight-only — no map zoom/pan
 *  3. Point insertion anywhere on map in edit-points mode
 *  4. Zone editor close button fixed via titlebar clone
 *  5. HA entity search inside zone editor (live + fallback)
 *  6. Config polling fixed — proper hash + cache-bust
 *  7. Sidebar position & floorplan upload in Settings
 *  8. Alarm entity status bar + colour-coded dot
 *  9. Connection log panel + toast alerts + server health
 * ============================================================ */

/* ─── CONFIG DEFAULTS ─────────────────────────────────────── */
let uiConfig = {
  floorplan: "img/floorplan.png",
  sidebar_position: "right",
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
  cam_snapshot_interval:  2,           // seconds between snapshot refreshes
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
let haMsgId = 1;
let haPendingCmds = {};
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
  };
  for (const [cssVar, cfgKey] of Object.entries(colorMap)) {
    if (uiConfig[cfgKey]) root.style.setProperty(cssVar, uiConfig[cfgKey]);
  }

  const statusEl = document.getElementById("statusText");
  if (statusEl) statusEl.textContent = uiConfig.status;

  const fp = document.getElementById("floorplanImage");
  if (fp && uiConfig.floorplan) {
    const fpPath   = apiPath(uiConfig.floorplan);
    const newBase  = fpPath.split("?")[0];
    const curBase  = fp.src.split("?")[0].replace(window.location.origin, "").replace(/^\/api\/hassio_ingress\/[^/]+/, "");
    if (!fp.dataset.loaded || !fp.src.includes(encodeURIComponent(uiConfig.floorplan).replace(/%20/g, " ").split("/").pop().split("?")[0])) {
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
    if (uiConfig.sidebar_collapsed) {
      sidebar.classList.add("collapsed");
      updateExpandBtn(true);
    } else {
      sidebar.classList.remove("collapsed");
      updateExpandBtn(false);
    }
  }

  restartPolling();

  // Re-connect HA if credentials changed — skip if already connected, add-on mode, or mode not yet determined
  if (!haConnected && isAddonMode === false && uiConfig.ha_url && uiConfig.ha_token) {
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
}

/* ─── EXPAND / COLLAPSE SIDEBAR ───────────────────────────── */
function updateExpandBtn(collapsed) {
  const btn  = document.getElementById("expandBtn");
  const svg  = btn?.querySelector("svg path");
  if (!btn) return;

  const isLeft = uiConfig.sidebar_position === "left";

  if (isLeft) {
    btn.style.left  = "10px";
    btn.style.right = "unset";
    // Expand btn: chevron right → opens left sidebar
    if (svg) svg.setAttribute("d", "M9 6l6 6-6 6");
  } else {
    btn.style.right = "10px";
    btn.style.left  = "unset";
    // Expand btn: chevron left ← opens right sidebar
    if (svg) svg.setAttribute("d", "M15 6l-6 6 6 6");
  }

  if (collapsed) {
    btn.classList.add("visible");
  } else {
    btn.classList.remove("visible");
  }

  // Issue 4: also update the collapse button chevron direction
  const collapseBtn = document.getElementById("collapseBtn");
  const collapseSvg = collapseBtn?.querySelector("svg path");
  if (collapseSvg) {
    // Collapse btn points AWAY from screen edge:
    // right sidebar → chevron right (→) to push it off right edge
    // left  sidebar → chevron left  (←) to push it off left edge
    collapseSvg.setAttribute("d", isLeft ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6");
  }
}

function bindSidebarToggle() {
  const sidebar = document.getElementById("sidebarEl");
  const collapseBtn = document.getElementById("collapseBtn");
  const expandBtn = document.getElementById("expandBtn");

  function collapse() {
    if (!sidebar) return;
    sidebar.classList.add("collapsed");
    uiConfig.sidebar_collapsed = true;
    updateExpandBtn(true);
    // Close any open overlays
    setSearchOpen(false);
    const logPanel = document.getElementById("logPanel");
    if (logPanel) logPanel.classList.remove("open");
    const settingsPanel = document.getElementById("settingsPanel");
    if (settingsPanel) settingsPanel.remove();
    if (editorMode) { editorMode = false; renderZonesEditor(); renderZones(); }
    // Close camera dropdown if open
    const camDd = document.getElementById("camStatusDd");
    if (camDd && camDd.style.display !== "none") {
      camDd.style.display = "none";
      localStorage.setItem("cam_status_open", "false");
    }
  }

  function expand() {
    if (!sidebar) return;
    sidebar.classList.remove("collapsed");
    uiConfig.sidebar_collapsed = false;
    updateExpandBtn(false);
  }

  if (collapseBtn) collapseBtn.onclick = collapse;
  if (expandBtn) expandBtn.onclick = expand;

  // Status bar: NO sidebar interaction (item 2)
}

/* ─── ZOOM / PAN ──────────────────────────────────────────── */
// Strategy: transform the entire #floorplanWrapper (image + SVG overlay together).
// This means zones ALWAYS align perfectly at any zoom/pan — no coordinate math needed for rendering.
// Points are stored in "natural image px" space (image at scale=1, origin top-left of wrapper).

function applyTransform() {
  const wrapper = document.getElementById("floorplanWrapper");
  if (wrapper) wrapper.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  // No renderZones() needed here — SVG moves with the wrapper automatically
  // Only re-render handles (circles) if in editor mode, since they need to be screen-size-invariant
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
}

function bindPan() {
  const outer = document.querySelector(".main") || document.body;
  let dragging = false, startX = 0, startY = 0;

  outer.addEventListener("pointerdown", e => {
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
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const cx = e.clientX, cy = e.clientY;
    zoom.x = cx - (cx - zoom.x) * factor;
    zoom.y = cy - (cy - zoom.y) * factor;
    zoom.scale = Math.min(10, Math.max(0.1, zoom.scale * factor));
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

function zoneToYaml(z) {
  let out = `id: ${z.id}\n`;
  out += `name: "${(z.name || "").replace(/"/g, '\\"')}"\n`;
  out += `color: "${z.colorHex || "#0096ff"}"\n`;
  out += `enabled: ${z.enabled !== false}\n`;
  out += `hidden: ${z.hidden === true}\n`;
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
  return out;
}

function parseZoneYaml(text) {
  const z = { points: [], sensors: [], cameras: [], lights: [], sirens: [], enabled: true, hidden: false };
  let section = "";

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "points:")  { section = "points";  continue; }
    if (line === "sensors:") { section = "sensors"; continue; }
    if (line === "cameras:") { section = "cameras"; continue; }
    if (line === "lights:")  { section = "lights";  continue; }
    if (line === "sirens:")  { section = "sirens";  continue; }

    if (line.startsWith("-")) {
      const val = line.slice(1).trim();
      if (section === "points") {
        const m = val.match(/\[\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*\]/);
        if (m) z.points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
      } else if (section === "sensors") { z.sensors.push(val); }
      else if (section === "cameras")   { z.cameras.push(val); }
      else if (section === "lights")    { z.lights.push(val); }
      else if (section === "sirens")    { z.sirens.push(val); }
      continue;
    }

    if (line.includes(":")) {
      section = "";
      const colonIdx = line.indexOf(":");
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (key === "id")      z.id = val;
      else if (key === "name")    z.name = val;
      else if (key === "enabled") z.enabled = val !== "false";
      else if (key === "hidden")  z.hidden  = val === "true";
      else if (key === "color")   { z.colorHex = val; z.color = hexToRgba(val, 0.25); }
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
  } catch {
    try { zones = JSON.parse(localStorage.getItem("zones") || "[]"); }
    catch { zones = []; }
  }
}

async function saveZone(zone) {
  const filename = zoneFilename(zone.id);
  try {
    const res = await fetch(apiPath("ow/save-zone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, content: zoneToYaml(zone) })
    });
    if (!res.ok) throw new Error(res.statusText);
  } catch {
    localStorage.setItem("zones", JSON.stringify(zones));
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
  const anyArmed     = members.some(z => z.enabled !== false && masterEnabled);
  const allDisarmed  = members.every(z => z.enabled === false || !masterEnabled);
  return { anyTriggered, anyArmed, allDisarmed };
}

function setGroupArmed(groupId, armed) {
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  (group.zone_ids || []).forEach(zoneId => setZoneEnabled(zoneId, armed));
  // Also sync group as a unit to HA
  owEntitySet("group", groupId, armed);
  renderZonesEditor();
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
    renderZonesEditor();
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
  if (!checkId) return false;
  const st = haStates[checkId];
  if (!st) return false;
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

function entityTypeColour(type) {
  const armed  = isAlarmArmed();
  const prefix = armed ? "color_on_" : "color_off_";
  const newKey = prefix + type;
  // localStorage override → uiConfig value → hard-coded default
  const lsKey  = 'ow_' + newKey;
  return localStorage.getItem(lsKey) || uiConfig[newKey] || (armed ? "#ff3b30" : "#4cd964");
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
  const dur = (parseFloat(localStorage.getItem('ow_fade_duration') ?? uiConfig.zone_fade_duration) || 3) * 1000;
  const elapsed = Date.now() - fade.startedAt;
  if (elapsed >= dur) {
    delete zoneFadeState[zoneId];
    return 0;
  }
  // Linear fade from 0.55 → 0 (starting from the dim flash level)
  return 0.55 * (1 - elapsed / dur);
}

/* ─── MASTER ALARM STATE ──────────────────────────────────── */
// masterEnabled is the dashboard-level arm toggle (independent of HA entity)
// Persisted to localStorage so it survives page refresh
let masterEnabled = localStorage.getItem("masterEnabled") !== "false";

function setMasterEnabled(val) {
  masterEnabled = !!val;
  localStorage.setItem("masterEnabled", masterEnabled);
  updateStatusDropdownInPlace();
  renderZones();
  logEvent("info", masterEnabled ? "Master alarm enabled." : "Master alarm disabled.", "system");
  syncMasterToHA(masterEnabled);
}

function setZoneEnabled(zoneId, val) {
  const zone = zones.find(z => z.id === zoneId);
  if (!zone) return;
  zone.enabled = !!val;
  saveZone(zone);
  updateStatusDropdownInPlace();
  renderZones();
  logEvent(
    "info",
    zone.enabled ? `Zone enabled: ${zone.name || zone.id}` : `Zone disabled: ${zone.name || zone.id}`,
    "zone",
    { zoneName: zone.name || zone.id, zoneColour: zone.colorHex || "#0096ff" }
  );
  syncZoneToHA(zone, zone.enabled ? "normal" : "disabled");
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

/* ─── ENTITY SYNC (dashboard → server → HA) ───────────────── */
// Fire-and-forget — errors never block the UI
async function owEntitySet(type, key, state) {
  if (!serverApiAvailable) return;
  try {
    await fetch(apiPath("ow/entity-set"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, key, state }),
    });
  } catch { /* server unreachable */ }
}

async function syncZoneToHA(zone, zoneState) {
  // Map visual state to enabled boolean
  const enabled = zoneState !== "disabled";
  await owEntitySet("zone", zone.id, enabled);
}

async function syncMasterToHA(armed) {
  await owEntitySet("master", "master", armed);
}

/* ─── ZONE STATE COMPUTATION ──────────────────────────────── */
function isEntityTriggered(entityId) {
  const st = haStates[entityId];
  if (!st) return false;
  const s = (st.state || "").toLowerCase();
  return s === "on" || s === "open" || s === "detected" || s === "home" || s === "triggered";
}

/* Track previous zone states to detect trigger→normal transitions */
const zonePrevState = {};

function getZoneState(zone) {
  // Respect zone-level and master enabled toggles
  if (zone.enabled === false || !masterEnabled) return "disabled";
  if (!haConnected) return "normal";
  const sensors = zone.sensors || [];
  if (!sensors.length) return "normal";
  const anyTriggered   = sensors.some(isEntityTriggered);
  const anyUnavailable = sensors.some(id => {
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
    const sensors = zone.sensors || [];
    // Compute raw state without the prev-state side effects
    let state = "normal";
    if (zone.enabled === false || !masterEnabled) {
      state = "disabled";
    } else {
      const anyTriggered   = sensors.some(isEntityTriggered);
      const anyUnavailable = sensors.length > 0 && sensors.some(id => {
        const st = haStates[id];
        return !st || (st.state || "").toLowerCase() === "unavailable";
      });
      if (anyTriggered)   state = "triggered";
      else if (anyUnavailable) state = "fault";
    }

    const prev = zonePrevState[zone.id];

    // Normal → Triggered
    if (prev !== "triggered" && state === "triggered") {
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

    // Triggered → anything else (cleared)
    if (prev === "triggered" && state !== "triggered") {
      const lastSensor = sensors.find(id => isEntityTriggered(id)) || sensors[0];
      const type       = detectEntityType(lastSensor || "");
      const zoneColour = resolveColour(entityTypeColour(type));
      startZoneFade(zone.id, zoneColour);
      logEvent(
        "ok",
        `Cleared`,
        "zone",
        { zoneName: zone.name || zone.id, zoneColour }
      );
      syncZoneToHA(zone, state);   // "normal", "fault", or "disabled"
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
        const isOff = zone.enabled === false || !masterEnabled;
        const sensors = zone.sensors || [];
        const anyActive = sensors.some(isEntityTriggered);
        const isDisarmedActive = isOff && anyActive;
        const isTriggered = st === "triggered";
        dot.classList.toggle("flashing", isTriggered || isDisarmedActive);
        dot.style.background = isTriggered
          ? "#ff3b30"
          : isDisarmedActive
          ? resolveColour(entityTypeColourOff(detectEntityType(sensors.find(isEntityTriggered) || "")))
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
        const allArmed      = members.every(z => z.enabled !== false && masterEnabled);
        const allDisarmed   = members.every(z => z.enabled === false || !masterEnabled);
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
  }
}, 700);

function renderZones() {
  const svg = document.getElementById("zonesSvg");
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const now = Date.now();
  const showHighlight      = highlightedZoneId  && now < highlightedUntil;
  const showGroupHighlight = highlightedGroupId && now < highlightedGroupUntil;

  // ── Group member highlight layer ────────────────────────────
  // Works in both editor mode (selectedGroupId) and live mode (highlightedGroupId from dropdown).
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

  zones.forEach(zone => {
    const pts = zone.points || [];
    if (!pts.length) return;

    const isSelected     = zone.id === selectedZoneId;
    const isHighlight    = showHighlight && zone.id === highlightedZoneId;
    const zoneState    = getZoneState(zone);
    const isDisabled   = zoneState === "disabled";
    const isHidden     = zone.hidden === true;
    const isTriggered  = haConnected && zoneState === "triggered";
    const isFault      = haConnected && zoneState === "fault";
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
      // Disabled zone in editor: grey dashed outline
      poly.style.fill             = "rgba(120,120,120,0.10)";
      poly.style.stroke           = "rgba(120,120,120,0.30)";
      poly.style.strokeWidth      = String(1 / zoom.scale);
      poly.style.strokeDasharray  = String(6 / zoom.scale) + " " + String(4 / zoom.scale);

    } else if (isTriggered || (flashMode === 'group' && groupFlashZoneIds.has(zone.id) && haConnected)) {
      const triggeredEntity = (zone.sensors || []).find(isEntityTriggered)
        || (zones.find(z => groupFlashZoneIds.has(z.id) && getZoneState(z) === 'triggered')?.sensors || []).find(isEntityTriggered);
      const type = detectEntityType(triggeredEntity || "");
      const hex  = resolveColour(entityTypeColour(type));
      const fillAlpha   = flashPhase ? 0.18 : 0.65;
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
      // Fault: amber fill, no prominent border
      poly.style.fill        = "rgba(255,149,0,0.28)";
      poly.style.stroke      = "rgba(255,149,0,0.35)";
      poly.style.strokeWidth = String(1 / zoom.scale);

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
      // Live mode — transparent unless a sensor is active
      const sensors = zone.sensors || [];
      const anyActive = sensors.some(isEntityTriggered);
      if (anyActive && isDisabled) {
        // Disarmed zone with active sensor — flash in off-colour (same flash rhythm as armed)
        const type = detectEntityType(sensors.find(isEntityTriggered) || "");
        const hex  = resolveColour(entityTypeColourOff(type));
        const fillAlpha = flashPhase ? 0.15 : 0.45;
        poly.style.fill        = hexToRgba(hex, fillAlpha);
        poly.style.stroke      = hexToRgba(hex, fillAlpha * 0.8);
        poly.style.strokeWidth = String(1 / zoom.scale);
      } else {
        // Clear zone (armed or disarmed, no active sensor) — completely transparent
        return;
      }
    }

    svg.appendChild(poly);

    // Handles only shown when actively editing points, not just selected
    if (editorMode && isSelected && isEditingPoints) {
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

/* ─── ZONES EDITOR PANEL (draggable) ──────────────────────── */
let editorPosRestored = false;
let editorDrag = { active: false, startX: 0, startY: 0 };
let editorSize = { w: 560, h: 420 };
let editorPos  = { x: 20, y: 70 };

function makeDraggableEditor(containerEl) {
  const container = containerEl || document.getElementById("zonesEditorContainer");
  if (!container) return;
  const panel = container.querySelector(".zones-editor");
  const titlebar = container.querySelector(".zones-editor-titlebar");
  if (!panel || !titlebar) return;

  // Restore saved position only once per session
  if (!editorPosRestored) {
    editorPosRestored = true;
    const savedX = localStorage.getItem("editorX");
    const savedY = localStorage.getItem("editorY");
    if (savedX !== null) editorPos.x = Math.max(0, Math.min(window.innerWidth  - 50, parseInt(savedX)));
    if (savedY !== null) editorPos.y = Math.max(0, Math.min(window.innerHeight - 50, parseInt(savedY)));
  }

  panel.style.left = editorPos.x + "px";
  panel.style.top  = editorPos.y + "px";

  // Remove any old listeners by cloning the titlebar (simplest approach)
  const newTitlebar = titlebar.cloneNode(true);
  titlebar.parentNode.replaceChild(newTitlebar, titlebar);

  newTitlebar.addEventListener("pointerdown", e => {
    // Don't drag if clicking the close button
    if (e.target.closest(".zones-editor-close")) return;
    editorDrag.active = true;
    editorDrag.startX = e.clientX - editorPos.x;
    editorDrag.startY = e.clientY - editorPos.y;
    newTitlebar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  newTitlebar.addEventListener("pointermove", e => {
    if (!editorDrag.active) return;
    editorPos.x = Math.max(0, Math.min(window.innerWidth  - 50, e.clientX - editorDrag.startX));
    editorPos.y = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - editorDrag.startY));
    panel.style.left = editorPos.x + "px";
    panel.style.top  = editorPos.y + "px";
  });

  newTitlebar.addEventListener("pointerup", () => {
    editorDrag.active = false;
    localStorage.setItem("editorX", editorPos.x);
    localStorage.setItem("editorY", editorPos.y);
  });

  // Re-wire close button on the cloned titlebar
  const closeBtn = newTitlebar.querySelector("#zonesCloseBtn");
  if (closeBtn) {
    closeBtn.onclick = () => {
      editorMode = false;
      isCreatingZone = false;
      isEditingPoints = false;
      currentNewZone = null;
      editorPosRestored = false; // allow re-restore next open
      const svg = document.getElementById("zonesSvg");
      if (svg) svg.style.pointerEvents = "none";
      const zonesBtn = document.getElementById("zonesBtn");
      if (zonesBtn) zonesBtn.classList.remove("active");
      renderZonesEditor();
      renderZones();
    };
  }
}

function renderZonesEditor() {
  const container = document.getElementById("zonesEditorContainer");
  if (!container) return;

  if (!editorMode) { container.innerHTML = ""; return; }

  // Don't blow away DOM while user is typing
  const activeEl = document.activeElement;
  const editorPanel = container.querySelector(".zones-editor");
  if (editorPanel && activeEl && editorPanel.contains(activeEl) &&
      (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) {
    refreshEntityStateDots(container);
    return;
  }

  const selectedZone  = selectedZoneId  ? zones.find(z => z.id === selectedZoneId)   : null;
  const selectedGroup = selectedGroupId ? groups.find(g => g.id === selectedGroupId) : null;

  const editPtsLabel    = isEditingPoints ? "✔ Done Editing" : "Edit Zone";
  const hasSelection = !!(selectedZone || selectedGroup);
  const editorW = hasSelection ? editorSize.w : 260;
  const editorH = editorSize.h;

  // ── Build left panel zone list with group headers ──────────
  function buildZoneList() {
    const sortedGroups = [...groups].sort((a, b) => (a.name||"").localeCompare(b.name||""));
    const groupedZoneIds = new Set(groups.flatMap(g => g.zone_ids || []));
    const ungroupedZones = zones.filter(z => !groupedZoneIds.has(z.id))
      .sort((a, b) => (a.name||a.id).localeCompare(b.name||b.id));
    let html = "";

    sortedGroups.forEach(g => {
      const gSel = g.id === selectedGroupId;
      const gState = getGroupState(g);
      const gHex    = g.colorHex || "#ff3b30";
      const gColour = gState.anyTriggered ? "#ff3b30" : gState.anyArmed ? gHex : gHex;
      const gOpacity = gState.anyArmed ? 1 : 0.35;
      const gFlash  = gState.anyTriggered;
      const storageKey = `zedGroup_${g.id}`;
      const collapsed  = localStorage.getItem(storageKey) !== "expanded";
      html += `
        <div class="zed-group-header ${gSel ? 'selected' : ''}" data-group-id="${g.id}" data-storage-key="${storageKey}">
          <div class="zone-list-dot${gFlash ? ' flashing' : ''}" style="background:${gColour};opacity:${gOpacity};width:6px;height:6px;flex-shrink:0;"></div>
          <span style="flex:1;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(g.name || g.id)}</span>
          <span class="zed-chevron" style="font-size:11px;color:#555;transition:transform 0.2s;display:inline-block;transform:rotate(${collapsed ? '-90' : '0'}deg);">▾</span>
        </div>
        <div class="zed-group-members" data-group-id="${g.id}" style="${collapsed ? 'display:none;' : ''}">`;
      const memberZones = (g.zone_ids || [])
        .map(id => zones.find(zz => zz.id === id))
        .filter(Boolean)
        .sort((a, b) => (a.name||a.id).localeCompare(b.name||b.id));
      memberZones.forEach(z => { html += buildZoneItem(z, true); });
      html += `</div>`;
    });

    if (ungroupedZones.length > 0) {
      html += `<div class="zed-group-header" style="cursor:default;">
        <div style="width:6px;height:6px;flex-shrink:0;background:transparent;"></div>
        <span style="flex:1;font-size:11px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:0.06em;">Ungrouped</span>
      </div>`;
      ungroupedZones.forEach(z => { html += buildZoneItem(z, false); });
    }
    return html || `<div style="color:#555;font-size:11px;padding:8px;">No zones yet.</div>`;
  }

  function buildZoneItem(z, indented) {
    const state = getZoneState(z);
    const isOff = z.enabled === false || !masterEnabled;
    const dotColour = isOff ? "#444" :
      state === "triggered" ? resolveColour(entityTypeColour(detectEntityType((z.sensors||[])[0]||""))) :
      state === "fault" ? "#ff9500" : (z.colorHex || "#0096ff");
    const sel = z.id === selectedZoneId;
    return `<div class="zones-list-item ${sel ? 'selected' : ''}" data-zone-id="${z.id}" style="${indented ? 'padding-left:20px;' : ''}">
      <div class="zone-list-dot" style="background:${dotColour};opacity:${isOff ? 0.4 : 1};"></div>
      <span style="flex:1;opacity:${isOff ? 0.5 : 1};font-size:12px;">${escapeHtml(z.name || z.id)}</span>
      ${z.hidden ? `<span style="font-size:9px;color:#555;">hidden</span>` : state === "triggered" ? `<span style="font-size:9px;color:#ff3b30;">⚠</span>` : `<span style="font-size:9px;color:#444;">${(z.points||[]).length}pt</span>`}
    </div>`;
  }

  // ── Build right panel ──────────────────────────────────────
  function buildRightPanel() {
    if (selectedGroup && !selectedZone) {
      // Group config panel
      const members = (selectedGroup.zone_ids || []).map(id => zones.find(z => z.id === id)).filter(Boolean);
      const allArmed = members.length > 0 && members.every(z => z.enabled !== false);
      return `
        <div class="zed-right-content">
          <div class="zones-editor-row"><label>Group Name</label>
            <input type="text" id="groupNameInput" value="${escapeHtml(selectedGroup.name || "")}" placeholder="Group name">
          </div>
          <div class="zones-editor-row"><label>Colour</label>
            <input type="color" id="groupColorInput" value="${selectedGroup.colorHex || '#ff3b30'}">
          </div>
          <div class="zones-editor-row" style="align-items:center;">
            <label>Group Armed</label>
            <label class="zone-toggle-switch">
              <input type="checkbox" id="groupArmedToggle" ${allArmed ? "checked" : ""}>
              <span class="zone-toggle-track"></span>
            </label>
          </div>
          <div style="font-size:11px;color:#666;margin-top:4px;">Members</div>
          <div id="groupMemberList" style="border:1px solid #222;border-radius:8px;padding:4px;flex:1;overflow-y:auto;">
            ${[...zones]
              .sort((a, b) => {
                const aIn = (selectedGroup.zone_ids || []).includes(a.id);
                const bIn = (selectedGroup.zone_ids || []).includes(b.id);
                if (aIn !== bIn) return aIn ? -1 : 1; // checked first
                return (a.name||a.id).localeCompare(b.name||b.id);
              })
              .map(z => {
                const inGroup = (selectedGroup.zone_ids || []).includes(z.id);
                return `<label style="display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:6px;${inGroup ? 'background:rgba(255,255,255,0.04);' : ''}">
                  <input type="checkbox" class="group-member-chk" data-zone-id="${z.id}" ${inGroup ? "checked" : ""} style="accent-color:#0096ff;">
                  <div class="zone-list-dot" style="background:${z.colorHex || '#0096ff'};width:6px;height:6px;flex-shrink:0;"></div>
                  <span style="font-size:12px;color:${inGroup ? '#fff' : '#888'};">${escapeHtml(z.name || z.id)}</span>
                </label>`;
              }).join("")}
          </div>
        </div>`;
    }

    if (selectedZone) {
      // Zone config panel
      const modeHint = isCreatingZone
        ? `<div class="zone-mode-hint">✏️ Click map to add points · Double-click to finish</div>`
        : isEditingPoints
        ? `<div class="zone-mode-hint">🔧 Click edge to insert · Right-click handle to remove</div>`
        : "";
      return `
        <div class="zed-right-content">
          ${modeHint}
          <div class="zones-editor-row"><label>Name</label>
            <input type="text" id="zoneNameInput" value="${escapeHtml(selectedZone.name || "")}" placeholder="Zone name">
          </div>
          <div class="zones-editor-row"><label>Colour</label>
            <input type="color" id="zoneColorInput" value="${selectedZone.colorHex || '#0096ff'}">
          </div>
          <div class="zones-editor-row" style="align-items:center;gap:8px;">
            <label style="flex:0 0 auto;">Armed</label>
            <label class="zone-toggle-switch">
              <input type="checkbox" id="zoneEnabledToggle" ${selectedZone.enabled !== false ? "checked" : ""}>
              <span class="zone-toggle-track"></span>
            </label>
            <span style="flex:1;"></span>
            <span style="font-size:11px;color:#666;">Visible</span>
            <button id="zoneHiddenToggle"
              style="background:none;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;cursor:pointer;line-height:0;color:${selectedZone.hidden ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.7)'};"
            >${selectedZone.hidden
              ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 12 5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
              : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 12 5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>`
            }</button>
          </div>
          <div class="ha-section" style="margin-top:2px;flex:1;display:flex;flex-direction:column;">
            <div class="ha-device-tabs" id="haDeviceTabs">
              <button class="ha-device-tab active" data-tab="sensors">Sensors</button>
              <button class="ha-device-tab" data-tab="cameras">Cameras</button>
              <button class="ha-device-tab" data-tab="lights">Lights</button>
              <button class="ha-device-tab" data-tab="sirens">Sirens</button>
            </div>
            <div class="ha-tab-panel" id="tabPanel_sensors" style="flex:1;overflow-y:auto;">
              <div class="entity-search-wrap"><input type="text" id="entitySearchInput" class="entity-search-input" placeholder="Search HA entities…" autocomplete="off">
              <div class="entity-search-results" id="entitySearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneEntityList">${(selectedZone.sensors||[]).map(e=>deviceRow(e,"sensors")).join("")}</div>
            </div>
            <div class="ha-tab-panel" id="tabPanel_cameras" style="display:none;">
              <div class="entity-search-wrap"><input type="text" id="cameraSearchInput" class="entity-search-input" placeholder="Search camera entities…" autocomplete="off">
              <div class="entity-search-results" id="cameraSearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneCameraList">${(selectedZone.cameras||[]).map(e=>deviceRow(e,"cameras")).join("")}</div>
            </div>
            <div class="ha-tab-panel" id="tabPanel_lights" style="display:none;">
              <div class="entity-search-wrap"><input type="text" id="lightSearchInput" class="entity-search-input" placeholder="Search light entities…" autocomplete="off">
              <div class="entity-search-results" id="lightSearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneLightList">${(selectedZone.lights||[]).map(e=>deviceRow(e,"lights")).join("")}</div>
            </div>
            <div class="ha-tab-panel" id="tabPanel_sirens" style="display:none;">
              <div class="entity-search-wrap"><input type="text" id="sirenSearchInput" class="entity-search-input" placeholder="Search siren entities…" autocomplete="off">
              <div class="entity-search-results" id="sirenSearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneSirenList">${(selectedZone.sirens||[]).map(e=>deviceRow(e,"sirens")).join("")}</div>
            </div>
          </div>
        </div>`;
    }

    // Nothing selected — hide right panel
    return ``;
  }

  container.innerHTML = `
    <div class="zones-editor" style="left:${editorPos.x}px;top:${editorPos.y}px;width:${editorW}px;height:${editorH}px;">
      <div class="zones-editor-titlebar">
        <h3>Zones</h3>
        <button class="zones-editor-close" id="zonesCloseBtn" title="Close editor">✕</button>
      </div>
      <div class="zed-body">
        <!-- LEFT PANEL -->
        <div class="zed-left" style="${(!selectedZone && !selectedGroup) ? 'border-right:none;width:100%;' : ''}">
          <div class="zed-list" id="zonesList">${buildZoneList()}</div>
          <div class="zed-actions">
            <button id="addGroupBtn">+ Group</button>
            <button id="addZoneBtn">+ Zone</button>
            ${selectedZone ? `<button id="editPointsBtn" style="${isEditingPoints ? 'border-color:rgba(255,204,0,0.5);color:#ffcc00;' : ''}">${editPtsLabel}</button>` : ""}
            ${selectedZone ? `<button id="undoZonesBtn" title="Undo last change">↩ Undo</button>` : ""}
            ${(selectedZone || selectedGroup) ? `<button id="deleteZoneBtn" class="danger">Delete</button>` : ""}
          </div>
        </div>
        <!-- RIGHT PANEL — completely hidden when nothing selected -->
        <div class="zed-right" style="${(!selectedZone && !selectedGroup) ? 'display:none;' : ''}">${buildRightPanel()}</div>
      </div>
      <div class="zed-resize-handle" id="zedResizeHandle"></div>
    </div>
  `;

  // ── Wire events ────────────────────────────────────────────
  // Zone list item clicks
  container.querySelectorAll(".zones-list-item").forEach(item => {
    item.onclick = () => {
      selectedZoneId  = item.dataset.zoneId;
      selectedGroupId = null;
      isCreatingZone = false; currentNewZone = null;
      renderZones(); renderZonesEditor();
    };
  });

  // Group header clicks
  container.querySelectorAll(".zed-group-header[data-group-id]").forEach(hdr => {
    hdr.onclick = (e) => {
      const gid = hdr.dataset.groupId;
      const key = hdr.dataset.storageKey;
      // If clicking the chevron area (right side), toggle collapse only
      const chevron = hdr.querySelector(".zed-chevron");
      const membersEl = container.querySelector(`.zed-group-members[data-group-id="${gid}"]`);
      if (membersEl && key) {
        const collapsed = membersEl.style.display === "none";
        membersEl.style.display = collapsed ? "" : "none";
        if (chevron) chevron.style.transform = `rotate(${collapsed ? "0" : "-90"}deg)`;
        localStorage.setItem(key, collapsed ? "expanded" : "collapsed");
      }
      // Also select the group (show right panel)
      selectedGroupId = gid;
      selectedZoneId  = null;
      renderZones();
      // Re-render only the left panel actions + right panel without blowing away the list
      // Full re-render needed to show right panel
      renderZonesEditor();
    };
  });

  // Add Zone
  document.getElementById("addZoneBtn")?.addEventListener("click", () => {
    const id = "zone_" + Date.now();
    const nz = { id, name: "New Zone", colorHex: "#0096ff", color: hexToRgba("#0096ff", 0.25),
                 points: [], sensors: [], cameras: [], lights: [], sirens: [], enabled: true, hidden: false };
    pushUndo(); zones.push(nz);
    selectedZoneId = id; selectedGroupId = null;
    isCreatingZone = true; isEditingPoints = false; currentNewZone = nz;
    saveZone(nz); renderZones(); renderZonesEditor();
  });

  // Add Group
  document.getElementById("addGroupBtn")?.addEventListener("click", () => {
    const id = "grp_" + Date.now();
    const ng = { id, name: "New Group", colorHex: "#ff3b30", zone_ids: [] };
    groups.push(ng);
    selectedGroupId = id; selectedZoneId = null;
    saveGroup(ng); renderZonesEditor();
  });

  // Delete
  document.getElementById("deleteZoneBtn")?.addEventListener("click", () => {
    if (selectedGroup && !selectedZone) {
      if (!confirm(`Delete group "${selectedGroup.name}"?`)) return;
      deleteGroup(selectedGroupId);
      groups = groups.filter(g => g.id !== selectedGroupId);
      selectedGroupId = null;
      renderZonesEditor();
    } else if (selectedZone) {
      pushUndo();
      deleteZoneFile(selectedZoneId);
      zones = zones.filter(z => z.id !== selectedZoneId);
      // Remove from any group
      groups.forEach(g => { g.zone_ids = (g.zone_ids||[]).filter(id => id !== selectedZoneId); saveGroup(g); });
      selectedZoneId = null; isCreatingZone = false; isEditingPoints = false; currentNewZone = null;
      renderZones(); renderZonesEditor();
    }
  });

  // Edit Zone points
  document.getElementById("editPointsBtn")?.addEventListener("click", () => {
    isEditingPoints = !isEditingPoints; isCreatingZone = false; currentNewZone = null;
    renderZones(); renderZonesEditor();
  });

  // ── Group config wiring ──────────────────────────────────
  if (selectedGroup && !selectedZone) {
    document.getElementById("groupNameInput")?.addEventListener("input", e => {
      selectedGroup.name = e.target.value;
      saveGroup(selectedGroup);
      renderZonesEditor();
    });

    document.getElementById("groupColorInput")?.addEventListener("input", e => {
      selectedGroup.colorHex = e.target.value;
      saveGroup(selectedGroup);
      renderZones();
      renderZonesEditor();
    });

    document.getElementById("groupArmedToggle")?.addEventListener("change", e => {
      setGroupArmed(selectedGroupId, e.target.checked);
    });

    document.querySelectorAll(".group-member-chk").forEach(chk => {
      chk.addEventListener("change", e => {
        const zid = e.target.dataset.zoneId;
        selectedGroup.zone_ids = selectedGroup.zone_ids || [];
        if (e.target.checked) {
          if (!selectedGroup.zone_ids.includes(zid)) selectedGroup.zone_ids.push(zid);
        } else {
          selectedGroup.zone_ids = selectedGroup.zone_ids.filter(id => id !== zid);
        }
        saveGroup(selectedGroup);
        renderZonesEditor();
      });
    });

    document.getElementById("deleteGroupBtn")?.addEventListener("click", () => {
      if (!confirm(`Delete group "${selectedGroup.name}"?`)) return;
      deleteGroup(selectedGroupId);
      groups = groups.filter(g => g.id !== selectedGroupId);
      selectedGroupId = null;
      renderZonesEditor();
    });
  }

  // ── Zone config wiring ───────────────────────────────────
  if (selectedZone) {
    let _zoneOrigName = selectedZone.name || "";
    document.getElementById("zoneNameInput")?.addEventListener("input", e => {
      selectedZone.name = e.target.value;
      saveZone(selectedZone);
    });
    document.getElementById("zoneNameInput")?.addEventListener("blur", e => {
      const newName = e.target.value.trim();
      if (newName && newName !== _zoneOrigName) {
        // Warn admin that entity ID changes break automations
        logEvent("warn",
          `Zone renamed from "${_zoneOrigName}" to "${newName}". ` +
          `HA entity IDs for this zone have changed — update any automations referencing the old entity.`,
          "system");
        _zoneOrigName = newName;
        // Re-sync the new entity state to HA
        owEntitySet("zone", selectedZone.id, selectedZone.enabled !== false);
      }
    });

    document.getElementById("zoneColorInput")?.addEventListener("input", e => {
      selectedZone.colorHex = e.target.value;
      selectedZone.color = hexToRgba(e.target.value, 0.25);
      saveZone(selectedZone); renderZones();
    });

    document.getElementById("zoneEnabledToggle")?.addEventListener("change", e => {
      setZoneEnabled(selectedZone.id, e.target.checked); renderZonesEditor();
    });

    document.getElementById("zoneHiddenToggle")?.addEventListener("click", () => {
      setZoneHidden(selectedZone.id, !selectedZone.hidden); renderZonesEditor();
    });

    // Device tabs
    document.getElementById("haDeviceTabs")?.querySelectorAll(".ha-device-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ha-device-tab").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".ha-tab-panel").forEach(p => p.style.display = "none");
        btn.classList.add("active");
        document.getElementById("tabPanel_" + btn.dataset.tab)?.style && (document.getElementById("tabPanel_" + btn.dataset.tab).style.display = "block");
      });
    });

    // Entity remove buttons
    ["sensors","cameras","lights","sirens"].forEach(devType => {
      const listId = { sensors:"zoneEntityList", cameras:"zoneCameraList", lights:"zoneLightList", sirens:"zoneSirenList" }[devType];
      document.getElementById(listId)?.querySelectorAll(".ha-entity-remove").forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation();
          selectedZone[devType] = (selectedZone[devType]||[]).filter(s => s !== btn.dataset.entityId);
          saveZone(selectedZone);
          if (devType === "sensors") subscribeHAEntities();
          renderZonesEditor();
        };
      });
    });

    bindDeviceSearch(selectedZone, "entitySearchInput", "entitySearchResults", "sensors",  "zoneEntityList");
    bindDeviceSearch(selectedZone, "cameraSearchInput", "cameraSearchResults", "cameras",  "zoneCameraList");
    bindDeviceSearch(selectedZone, "lightSearchInput",  "lightSearchResults",  "lights",   "zoneLightList");
    bindDeviceSearch(selectedZone, "sirenSearchInput",  "sirenSearchResults",  "sirens",   "zoneSirenList");
  }

  // ── Undo / Export ────────────────────────────────────────
  document.getElementById("undoZonesBtn")?.addEventListener("click", undoZones);

  const exportBtn = document.getElementById("exportZonesBtn");
  if (exportBtn) {
    exportBtn.onclick = () => {
      const blob = new Blob([generateZonesYaml()], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "zones_export.yaml"; a.click();
      URL.revokeObjectURL(url);
    };
    // Import button
    if (!document.getElementById("importZonesBtn")) {
      const importBtn = document.createElement("button");
      importBtn.id = "importZonesBtn"; importBtn.textContent = "Import YAML";
      const importInput = document.createElement("input");
      importInput.id = "importZonesFile"; importInput.type = "file"; importInput.accept = ".yaml,.yml,.txt"; importInput.style.display = "none";
      exportBtn.insertAdjacentElement("afterend", importBtn);
      importBtn.insertAdjacentElement("afterend", importInput);
      importBtn.onclick = () => importInput.click();
      importInput.onchange = () => {
        const file = importInput.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = e => { try { importZonesFromYaml(e.target.result); } catch {} };
        reader.readAsText(file);
      };
    }
  }

  // ── Resize handle (bottom-right corner) ──────────────────
  const resizeHandle = document.getElementById("zedResizeHandle");
  if (resizeHandle) {
    let resizing = false, rsx = 0, rsy = 0, rsw = 0, rsh = 0;
    resizeHandle.addEventListener("pointerdown", e => {
      resizing = true; rsx = e.clientX; rsy = e.clientY;
      rsw = editorSize.w; rsh = editorSize.h;
      resizeHandle.setPointerCapture(e.pointerId);
      e.stopPropagation(); e.preventDefault();
    });
    resizeHandle.addEventListener("pointermove", e => {
      if (!resizing) return;
      editorSize.w = Math.max(240, rsw + (e.clientX - rsx));
      editorSize.h = Math.max(300, rsh + (e.clientY - rsy));
      const panel = container.querySelector(".zones-editor");
      if (panel) { panel.style.width = editorSize.w + "px"; panel.style.height = editorSize.h + "px"; }
    });
    resizeHandle.addEventListener("pointerup", () => { resizing = false; });
  }

  // Restore draggable
  const titlebar = container.querySelector(".zones-editor-titlebar");
  if (titlebar && !titlebar._draggableWired) {
    makeDraggableEditor(container);
    titlebar._draggableWired = true;
  }
}


/* ─── DEVICE ROW HELPER ───────────────────────────────────── */
function deviceRow(entityId, devType) {
  const st = haStates[entityId];
  const stateStr  = st ? st.state : (haConnected ? "unavailable" : "—");
  const stateClass = st ? (isEntityTriggered(entityId) ? "on" : "off") : "unavailable";
  const shortId   = entityId.split(".").pop() || entityId;
  const icons = { sensors:"⬡", cameras:"⊡", lights:"⊙", sirens:"⊛" };
  const icon = icons[devType] || "·";
  return `
    <div class="ha-entity-row" data-entity-id="${escapeHtml(entityId)}" data-dev-type="${devType}">
      <span style="font-size:9px;color:#555;flex-shrink:0;">${icon}</span>
      <div class="ha-entity-state ${stateClass}"></div>
      <span class="ha-entity-id" title="${escapeHtml(entityId)}">${escapeHtml(shortId)}</span>
      <span class="ha-entity-type">${escapeHtml(stateStr)}</span>
      <button class="ha-entity-remove" data-entity-id="${escapeHtml(entityId)}" title="Remove">✕</button>
    </div>`;
}

/* ─── DEVICE SEARCH (replaces bindEntitySearch, handles all device types) ─── */
function bindDeviceSearch(selectedZone, inputId, resultsId, devType, listId) {
  const input     = document.getElementById(inputId);
  const resultsEl = document.getElementById(resultsId);
  const listEl    = document.getElementById(listId);
  if (!input || !selectedZone) return;

  function refreshList() {
    if (!listEl) return;
    listEl.innerHTML = (selectedZone[devType] || []).map(id => deviceRow(id, devType)).join("");
    listEl.querySelectorAll(".ha-entity-remove").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const id = btn.dataset.entityId;
        selectedZone[devType] = (selectedZone[devType] || []).filter(s => s !== id);
        saveZone(selectedZone);
        if (devType === "sensors") subscribeHAEntities();
        refreshList();
      };
    });
  }

  function addDevice(entityId) {
    entityId = entityId.trim();
    if (!entityId) return;
    if (!(selectedZone[devType] || []).includes(entityId)) {
      selectedZone[devType] = [...(selectedZone[devType] || []), entityId];
      saveZone(selectedZone);
      if (devType === "sensors") subscribeHAEntities();
    }
    input.value = "";
    if (resultsEl) { resultsEl.innerHTML = ""; resultsEl.style.display = "none"; }
    refreshList();
  }

  function runSearch(q) {
    if (!resultsEl) return;
    const query = q.trim().toLowerCase();
    if (!query) { resultsEl.style.display = "none"; return; }
    let candidates = [];
    if (haConnected && Object.keys(haStates).length > 0) {
      candidates = Object.keys(haStates)
        .filter(id => {
          const low = id.toLowerCase();
          // Exclude Overwatch's own entities from the picker (circular reference prevention)
          if (low.startsWith("switch.overwatch_") ||
              low.startsWith("binary_sensor.overwatch_")) return false;
          return low.includes(query);
        })
        .slice(0, 25)
        .map(id => ({ id, state: haStates[id]?.state || "—", friendly: haStates[id]?.attributes?.friendly_name || "" }));
    } else {
      candidates = [{ id: query, state: "add manually", friendly: "Press Enter to add" }];
    }
    if (!candidates.length) candidates = [{ id: query, state: "not found", friendly: "Press Enter to add anyway" }];
    resultsEl.innerHTML = candidates.map(c => `
      <div class="entity-search-result" data-entity-id="${escapeHtml(c.id)}">
        <span class="entity-search-id">${escapeHtml(c.id)}</span>
        <span class="entity-search-state">${escapeHtml(c.state)}</span>
        ${c.friendly ? `<span class="entity-search-friendly">${escapeHtml(c.friendly)}</span>` : ""}
      </div>`).join("");
    resultsEl.style.display = "block";
    resultsEl.querySelectorAll(".entity-search-result").forEach(el => {
      el.onclick = () => addDevice(el.dataset.entityId);
    });
  }

  let debounce = null;
  input.oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => runSearch(input.value), 120); };
  input.onkeydown = e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = resultsEl?.querySelector(".entity-search-result");
      addDevice(first ? first.dataset.entityId : input.value);
    }
    if (e.key === "Escape") { if (resultsEl) { resultsEl.style.display = "none"; } input.value = ""; }
  };
  document.addEventListener("pointerdown", function outside(e) {
    if (!input.contains(e.target) && !(resultsEl && resultsEl.contains(e.target))) {
      if (resultsEl) resultsEl.style.display = "none";
      document.removeEventListener("pointerdown", outside);
    }
  });
  refreshList();
}

/* ─── ENTITY SEARCH (legacy alias kept so old references don't throw) ──── */
function bindEntitySearch(zone) { bindDeviceSearch(zone, "entitySearchInput", "entitySearchResults", "sensors", "zoneEntityList"); }


/* ─── SVG INTERACTION ─────────────────────────────────────── */
// Ray-casting point-in-polygon test
function isPointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function closestEdgeInfo(zone, fpX, fpY) {
  const pts = zone.points || [];
  if (pts.length < 2) return null;
  let bestIdx = 0, bestDist = Infinity, bestSnap = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (!lenSq) continue;
    const t = Math.max(0, Math.min(1, ((fpX - a.x) * dx + (fpY - a.y) * dy) / lenSq));
    const snapX = a.x + t * dx, snapY = a.y + t * dy;
    const dist = Math.hypot(fpX - snapX, fpY - snapY);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; bestSnap = { x: snapX, y: snapY }; }
  }
  return { insertAfter: bestIdx, dist: bestDist, snap: bestSnap };
}

function bindZonesSvgEvents() {
  const svg = document.getElementById("zonesSvg");
  if (!svg) return;

  svg.addEventListener("pointerdown", e => {
    if (!editorMode) return;
    const target = e.target;
    const sx = e.clientX, sy = e.clientY;
    const fp = screenToFloorplan(sx, sy);

    // 1) Dragging a vertex handle — capture and block pan
    if (target.classList.contains("zone-handle")) {
      draggingHandle = { zoneId: target.dataset.zoneId, idx: Number(target.dataset.index) };
      svg.setPointerCapture(e.pointerId);
      e.stopPropagation();
      return;
    }

    // 2) Inserting a point (Edit Points mode)
    // Click near an edge → snap and insert on that edge
    // Click outside the zone body → insert at closest edge point
    // Click inside the zone → drag the zone (handled in step 3)
    if (isEditingPoints && selectedZoneId && !isCreatingZone) {
      const zone = zones.find(z => z.id === selectedZoneId);
      if (zone && (zone.points || []).length >= 2) {
        // Check if click is inside the zone polygon
        const insideZone = isPointInPolygon(fp.x, fp.y, zone.points);
        if (!insideZone) {
          const info = closestEdgeInfo(zone, fp.x, fp.y);
          if (info) {
            pushUndo();
            // Insert snapped to edge
            zone.points.splice(info.insertAfter + 1, 0, { x: Math.round(info.snap.x), y: Math.round(info.snap.y) });
            saveZone(zone);
            renderZones();
            renderZonesEditor();
            e.stopPropagation();
            return;
          }
        }
        // Click inside zone — fall through to polygon handler to start drag
      }
    }

    // 3) Clicking a polygon — select it (unless editing points on another zone)
    // Hidden zones cannot be selected. Can't switch zones while editing points.
    if (target.classList.contains("zone-polygon")) {
      const zoneId = target.dataset.zoneId;
      const zone   = zones.find(z => z.id === zoneId);
      if (zone?.hidden) { e.stopPropagation(); return; }
      if (isEditingPoints && selectedZoneId && zoneId !== selectedZoneId) {
        e.stopPropagation(); return;
      }
      selectedZoneId  = zoneId;
      selectedGroupId = null;
      // In edit points mode: clicking inside zone starts a drag of the whole zone
      if (isEditingPoints && zone) {
        draggingZone = { zoneId, startPoints: zone.points.map(p => ({ ...p })) };
        dragStart = { x: sx, y: sy };
        svg.setPointerCapture(e.pointerId);
      }
      renderZones();
      renderZonesEditor();
      e.stopPropagation();
      return;
    }

    // 4) Drawing new zone — add point, block pan
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

    // 5) Empty canvas click — deselect BUT let the event propagate so bindPan can pan
    selectedZoneId    = null;
    selectedGroupId   = null;
    highlightedZoneId = null; highlightedUntil      = 0;
    highlightedGroupId = null; highlightedGroupUntil = 0;
    isEditingPoints = false;
    renderZones();
    renderZonesEditor();
    // Do NOT stopPropagation here — outer pan handler will pick it up
  });

  svg.addEventListener("pointermove", e => {
    if (!editorMode) return;
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
    if (draggingHandle || draggingZone) {
      try { svg.releasePointerCapture(e.pointerId); } catch {}
    }
    draggingHandle = null;
    draggingZone   = null;
    dragStart      = null;
  });

  svg.addEventListener("dblclick", e => {
    if (!editorMode || !isCreatingZone || !currentNewZone) return;
    if (currentNewZone.points.length < 3) { alert("A zone needs at least 3 points."); return; }
    isCreatingZone = false;
    currentNewZone = null;
    saveZones();
    renderZonesEditor();
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
      renderZonesEditor();
    }
  });
}

/* ─── CONNECTION LOG & TOAST SYSTEM ─────────────────────── */
const connLog = [];
const MAX_LOG = 500;

// category: "system" | "zone" | "entity" | "ha"
function logEvent(level, message, category = "system", meta = {}) {
  const entry = { ts: new Date(), level, message, category, meta };
  connLog.unshift(entry);
  if (connLog.length > MAX_LOG) connLog.pop();

  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    `[HA-Overwatch][${category.toUpperCase()}][${level.toUpperCase()}] ${message}`
  );

  // Toasts ONLY for critical system/HA errors — not zone triggers or entity state changes
  const isCritical = (category === "system" || category === "ha") && (level === "error" || level === "warn");
  if (isCritical) showToast(message, level);

  // Badge on log button — only for critical system/HA errors (not zone or entity events)
  const logBtn = document.getElementById("logBtn");
  if (logBtn) {
    let badge = logBtn.querySelector(".log-error-dot");
    const isCritical = (category === "system" || category === "ha") && (level === "error" || level === "warn");
    if (isCritical) {
      if (!badge) {
        badge = document.createElement("div");
        badge.className = "log-error-dot";
        logBtn.appendChild(badge);
      }
    } else if (level === "ok" && (category === "system" || category === "ha")) {
      // Clear badge only when a critical category recovers
      const hasErrors = connLog.some(e =>
        (e.level === "error" || e.level === "warn") && (e.category === "system" || e.category === "ha")
      );
      if (!hasErrors && badge) badge.remove();
    }
  }

  // Live-refresh the log panel if open
  renderLogPanel(false);
}

function showToast(message, level = "warn") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.style.cssText = `
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      z-index: 9999; display: flex; flex-direction: column; gap: 8px;
      align-items: center; pointer-events: none;
    `;
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  const bg = level === "error" ? "rgba(255,59,48,0.92)" :
             level === "warn"  ? "rgba(255,149,0,0.92)" :
             level === "ok"    ? "rgba(50,215,75,0.92)" :
                                 "rgba(40,40,40,0.92)";
  toast.style.cssText = `
    background: ${bg}; color: #fff; border-radius: 10px;
    padding: 9px 16px; font-size: 13px; font-weight: 500;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4); pointer-events: none;
    max-width: 380px; text-align: center; line-height: 1.4;
    animation: toastIn 0.25s ease;
  `;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "toastOut 0.3s ease forwards";
    setTimeout(() => toast.remove(), 320);
  }, 4000);
}

// Inject toast keyframes once
(function injectToastCSS() {
  const s = document.createElement("style");
  s.textContent = `
    @keyframes toastIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
    @keyframes toastOut { from { opacity:1; transform:translateY(0); } to { opacity:0; transform:translateY(10px); } }
  `;
  document.head.appendChild(s);
})();

let logFilter = "all";
let logSearch  = "";

function renderLogPanel(toggle = true) {
  let panel = document.getElementById("logPanel");

  if (toggle) {
    if (panel) {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) {
        buildLogBody(panel);
        // Only wire draggable once — check if already wired
        const tb = panel.querySelector(".log-titlebar");
        if (tb && !tb._draggableWired) {
          makeDraggable(panel, tb, "logPanel");
          tb._draggableWired = true;
        }
      }
      return;
    }
    panel = document.createElement("div");
    panel.id = "logPanel";
    panel.className = "log-panel open";
    document.body.appendChild(panel);
    buildLogShell(panel);
    buildLogBody(panel);
    const tb = panel.querySelector(".log-titlebar");
    if (tb) {
      makeDraggable(panel, tb, "logPanel");
      tb._draggableWired = true;
    }
  } else {
    if (!panel || !panel.classList.contains("open")) return;
    // Live update: only rebuild body, never touch controls (preserves search focus)
    buildLogBody(panel);
  }
}

function buildLogShell(panel) {
  const catLabel = { all: "All", system: "System", zone: "Zones", entity: "Entities", ha: "HA" };
  panel.innerHTML = `
    <div class="log-titlebar" id="logTitlebar">
      <span class="log-title">Log</span>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="log-clear-btn" id="logClearBtn">Clear</button>
        <button class="zones-editor-close" id="logCloseBtn">\u2715</button>
      </div>
    </div>
    <div class="log-controls">
      <input type="text" class="log-search-input" id="logSearchInput"
        placeholder="Search log\u2026" value="" autocomplete="off">
      <div class="log-filter-tabs" id="logFilterTabs">
        ${["all","system","zone","entity","ha"].map(cat => `
          <button class="log-filter-tab ${logFilter === cat ? "active" : ""}" data-cat="${cat}">
            ${catLabel[cat]}
          </button>`).join("")}
      </div>
    </div>
    <div class="log-body" id="logBody"></div>
    <div class="log-resize-handle" id="logResizeHandle" title="Drag to resize"></div>
  `;

  panel.addEventListener("pointerdown", e => e.stopPropagation());

  document.getElementById("logCloseBtn").onclick = () => panel.classList.remove("open");

  document.getElementById("logClearBtn").onclick = () => {
    connLog.length = 0;
    logSearch = "";
    logFilter = "all";
    const inp = document.getElementById("logSearchInput");
    if (inp) inp.value = "";
    panel.querySelectorAll(".log-filter-tab").forEach(b => b.classList.toggle("active", b.dataset.cat === "all"));
    const logBtn = document.getElementById("logBtn");
    if (logBtn) { const b = logBtn.querySelector(".log-error-dot"); if (b) b.remove(); }
    buildLogBody(panel);
  };

  const searchInput = document.getElementById("logSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", () => { logSearch = searchInput.value; buildLogBody(panel); });
    searchInput.addEventListener("keydown", e => e.stopPropagation());
    searchInput.addEventListener("pointerdown", e => e.stopPropagation());
  }

  panel.querySelectorAll(".log-filter-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      logFilter = btn.dataset.cat;
      panel.querySelectorAll(".log-filter-tab").forEach(b => b.classList.toggle("active", b === btn));
      buildLogBody(panel);
    });
  });

  // Resize handle — bottom-right corner, drag to resize width and height
  const resizeHandle = panel.querySelector(".log-resize-handle");
  if (resizeHandle) {
    let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;

    resizeHandle.addEventListener("pointerdown", e => {
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = panel.offsetWidth;
      startH = panel.offsetHeight;

      // If panel is still in its default bottom-anchored position, convert to top/left
      // so resizing downward doesn't fight the bottom anchor
      if (!panel.style.top || panel.style.bottom) {
        const rect = panel.getBoundingClientRect();
        panel.style.top    = rect.top + "px";
        panel.style.left   = rect.left + "px";
        panel.style.bottom = "unset";
        panel.style.transform = "none";
      }

      resizeHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    resizeHandle.addEventListener("pointermove", e => {
      if (!resizing) return;
      const newW = Math.max(280, Math.min(window.innerWidth  - 20, startW + (e.clientX - startX)));
      const newH = Math.max(120, Math.min(window.innerHeight - 60, startH + (e.clientY - startY)));
      panel.style.width  = newW + "px";
      panel.style.height = newH + "px";
      localStorage.setItem("logPanelW", newW);
      localStorage.setItem("logPanelH", newH);
    });

    resizeHandle.addEventListener("pointerup", () => { resizing = false; });

    // Restore saved dimensions
    const savedW = localStorage.getItem("logPanelW");
    const savedH = localStorage.getItem("logPanelH");
    if (savedW) panel.style.width  = savedW + "px";
    if (savedH) panel.style.height = savedH + "px";
  }
}

function buildLogBody(panel) {
  const bodyEl = panel.querySelector("#logBody") || panel.querySelector(".log-body");
  if (!bodyEl) return;

  const levelIcon = { info: "\u2139", warn: "\u26a0", error: "\u2717", ok: "\u2713" };
  const levelCol  = { info: "#888", warn: "#ff9500", error: "#ff3b30", ok: "#32d74b" };

  const q = logSearch.trim().toLowerCase();
  const filtered = connLog.filter(e => {
    if (logFilter !== "all" && e.category !== logFilter) return false;
    if (q && !e.message.toLowerCase().includes(q) &&
        !(e.meta?.zoneName || "").toLowerCase().includes(q) &&
        !(e.meta?.entityId || "").toLowerCase().includes(q)) return false;
    return true;
  });

  if (filtered.length === 0) {
    bodyEl.innerHTML = `<div class="log-empty">${connLog.length === 0 ? "No events yet." : "No matching entries."}</div>`;
    return;
  }

  bodyEl.innerHTML = filtered.map(e => {
    const col  = levelCol[e.level]  || "#888";
    const icon = levelIcon[e.level] || "\u00b7";
    const zoneColour   = e.meta?.zoneColour || "#ffcc00";
    const zoneNameHtml = e.meta?.zoneName
      ? `<span class="log-zone-name" style="color:${zoneColour}">${escapeHtml(e.meta.zoneName)}</span> `
      : "";
    const entityHtml = e.meta?.entityId
      ? `<span class="log-entity-tag">${escapeHtml(e.meta.entityId)}</span>`
      : "";
    return `
      <div class="log-entry log-${e.level} log-cat-${e.category}">
        <span class="log-ts">${e.ts.toLocaleTimeString()}</span>
        <span class="log-icon" style="color:${col}">${icon}</span>
        <span class="log-msg">${zoneNameHtml}${escapeHtml(e.message)}${entityHtml ? " " : ""}${entityHtml}</span>
      </div>`;
  }).join("");
}

/* ─── SERVER HEALTH CHECK ────────────────────────────────── */
// Detect access mode:
// - Ingress: <base href="/api/hassio_ingress/<token>/"> injected by server.js
// - Direct LAN: <meta name="ow-direct"> injected, no base tag — relative URLs work as-is
const IS_DIRECT_MODE = !!document.querySelector('meta[name="ow-direct"]');
const BASE_PATH = (() => {
  if (IS_DIRECT_MODE) return "";   // direct LAN — all paths are relative to ha-ip:8099
  const base = document.querySelector("base");
  if (!base) return "";
  const href = base.getAttribute("href") || "";
  return href === "./" || href === "/" ? "" : href.replace(/\/$/, "");
})();

// Prefix a relative API path with the ingress base path (no-op in direct mode)
function apiPath(rel) {
  return BASE_PATH ? `${BASE_PATH}/${rel}` : rel;
}

let serverWasReachable = true;
let serverApiAvailable = null;   // null=unknown, true=server.js up, false=local-only
let serverCheckTimer   = null;
let isAddonMode        = false;  // true when running as HA add-on

async function checkServerHealth() {
  try {
    const res  = await fetch(apiPath("ow/health"), { method: "GET", cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    const wasDown = serverApiAvailable === false || !serverWasReachable;
    serverWasReachable = true;
    serverApiAvailable = true;

    // Detect add-on mode from health response
    if (data.isAddon && !isAddonMode) {
      isAddonMode = true;
      logEvent("ok", "Running as HA Add-on — HA connection is automatic.", "system");
      // connectHA() is called by init() after the first health check completes.
      // Subsequent health checks don't re-connect — haConnected guard handles that.
    }

    if (wasDown) logEvent("ok", "server.js is reachable again.", "system");
  } catch {
    serverWasReachable = false;
    try {
      await fetch(apiPath("config/ui.yaml") + "?v=" + Date.now(), { cache: "no-store" });
      if (serverApiAvailable !== false) {
        serverApiAvailable = false;
        logEvent("warn",
          "Local-only mode: server.js is NOT running. Zone edits and settings will not be saved to disk. Start server.js to enable persistence.",
          "system");
      }
    } catch {
      if (serverApiAvailable !== "offline") {
        serverApiAvailable = "offline";
        logEvent("error", "Dashboard is completely offline — no server or network reachable.", "system");
      }
    }
  }
}

function startServerHealthCheck() {
  // Return a promise that resolves after the FIRST health check completes.
  // init() awaits this so isAddonMode is known before connectHA() is called.
  const firstCheck = checkServerHealth();
  serverCheckTimer = setInterval(checkServerHealth, 20000);
  return firstCheck;
}

/* ─── OFFLINE ENTITY CHECK (issue 10) ───────────────────────── */
function checkOfflineZoneEntities() {
  const deviceTypes = ["sensors", "cameras", "lights", "sirens"];
  for (const zone of zones) {
    for (const devType of deviceTypes) {
      for (const entityId of (zone[devType] || [])) {
        const st = haStates[entityId];
        if (!st) {
          logEvent("warn", `Entity not found in HA: ${entityId}`, "entity", { zoneName: zone.name || zone.id, entityId });
        } else if ((st.state || "").toLowerCase() === "unavailable") {
          logEvent("warn", `Entity unavailable: ${entityId}`, "entity", { zoneName: zone.name || zone.id, entityId });
        }
      }
    }
  }
}

/* ─── HOME ASSISTANT WEBSOCKET ────────────────────────────── */
function setHAStatus(status) {
  const badge = document.getElementById("haStatusBadge");
  const text  = document.getElementById("haStatusText");
  if (!badge) return;
  badge.classList.remove("connected", "disconnected", "error");
  badge.classList.add(status);
  if (text) text.textContent = "HA";
  // Live-update the connection box in settings panel if open
  updateSettingsConnectionBox();
}

function updateSettingsConnectionBox() {
  const box = document.getElementById("haConnectionStatus");
  if (!box) return;
  const connected = haConnected;
  box.className = `settings-connection-box ${connected ? 'connected' : 'disconnected'}`;
  const label = box.querySelector(".settings-connection-label");
  const sub   = box.querySelector(".settings-connection-sub");
  if (label) label.textContent = connected ? '✓ Connected to Home Assistant' : '✗ Not connected';
  if (sub)   sub.textContent   = !IS_DIRECT_MODE
    ? (connected ? 'Running as HA Add-on.' : 'Attempting to connect via add-on proxy…')
    : (connected ? 'Connected via WebSocket.' : 'Connecting via add-on proxy…');
}

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
      if (editorMode) renderZonesEditor();
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

        // Render zones + check for zone state transitions when a subscribed entity changes
        if (haSubscribedEntities.has(data.entity_id)) {
          checkZoneStateChanges();   // detect trigger/clear/fault transitions and log them
          renderZones();
          if (editorMode) renderZonesEditor();
          // Real-time camera grid update
          if (window.camUpdate) window.camUpdate();
        }
      }
    }
  };

  haSocket.onclose = (ev) => {
    haConnected = false;
    setHAStatus("disconnected");
    showReconnectBanner(true);
    const reason = ev.reason ? ` (${ev.reason})` : "";
    if (haEverConnected) {
      logEvent("warn", `HA WebSocket disconnected (code ${ev.code})${reason}. Retrying in ${Math.round(haReconnectDelay/1000)}s…`, "ha");
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
  if (haReconnectTimer) clearTimeout(haReconnectTimer);
  haReconnectTimer = setTimeout(() => {
    connectHA();
    // Exponential backoff: double delay up to 30s
    haReconnectDelay = Math.min(haReconnectDelay * 2, 30000);
  }, haReconnectDelay);
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
  }
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
function renderSettingsPanel() {
  const existingEl = document.getElementById("settingsPanel");
  if (existingEl) { existingEl.classList.toggle("open"); return; }

  const panel = document.createElement("div");
  panel.className = "settings-panel open";
  panel.id = "settingsPanel";

  // isAdmin = came through HA ingress (authenticated), not direct LAN port
  // IS_DIRECT_MODE = accessed via http://ha-ip:8099 directly (no HA auth = browser/public user)
  const isAdmin = !IS_DIRECT_MODE;

  // Effective value: localStorage first, then ui.yaml default, then hard default
  const eff = (lsKey, cfgKey, def) =>
    localStorage.getItem(lsKey) ?? (uiConfig[cfgKey] != null ? String(uiConfig[cfgKey]) : def);

  const curDir   = localStorage.getItem('ow_split_dir') || 'h';
  const curMode  = getViewMode();
  const isSplitH = curMode === 'split' && curDir === 'h';
  const isSplitV = curMode === 'split' && curDir === 'v';

  const adminBox = `
    <div class="settings-admin-notice">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-top:1px;">
        <circle cx="12" cy="12" r="10" stroke="#ff9500" stroke-width="1.8"/>
        <path d="M12 8v4m0 4h.01" stroke="#ff9500" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span>Admin only — managed via the HA Add-on panel.</span>
    </div>`;

  const perDeviceBadge = `<span class="settings-browser-badge">Per device</span>`;
  const adminBadge     = `<span class="settings-admin-badge">Admin default</span>`;

  panel.innerHTML = `
    <div class="settings-titlebar">
      <span class="settings-title">Settings</span>
      <button class="zones-editor-close" id="settingsCloseBtn">✕</button>
    </div>
    <div class="settings-tabs">
      <button class="settings-tab active" data-tab="ha">HA</button>
      <button class="settings-tab" data-tab="general">General</button>
      <button class="settings-tab" data-tab="alarm">Alarm</button>
      <button class="settings-tab" data-tab="zones">Zones</button>
      <button class="settings-tab" data-tab="cameras">Cameras</button>
    </div>
    <div class="settings-body">

      <!-- ══ HA TAB ══════════════════════════════════════════════ -->
      <div class="settings-tab-panel active" data-panel="ha">

        ${!isAdmin ? `
        <div class="settings-section-title">HOME ASSISTANT <span class="settings-admin-badge">ADMIN ONLY</span></div>
        ${adminBox}` : ''}

        <div id="haConnectionStatus" class="settings-connection-box ${haConnected ? 'connected' : 'disconnected'}">
          <div class="settings-connection-label">${haConnected ? '✓ Connected to Home Assistant' : '✗ Not connected'}</div>
          <div class="settings-connection-sub">${!IS_DIRECT_MODE ? 'Running as HA Add-on. Enter token once to connect.' : 'Connection managed by admin via Add-on.'}</div>
        </div>

        <div class="settings-section" ${!isAdmin ? 'style="opacity:0.45;pointer-events:none;"' : ''}>
          <div class="settings-field">
            <label>HA URL</label>
            ${isAdmin
              ? `<input type="text" id="cfgHaUrl" value="${escapeHtml(uiConfig.ha_url || '')}" placeholder="http://homeassistant.local:8123">`
              : `<div class="settings-readonly">${escapeHtml(uiConfig.ha_url || 'Auto (add-on mode)')}</div>`}
          </div>
          <div class="settings-field">
            <label>Long-Lived Access Token</label>
            ${isAdmin
              ? `<input type="password" id="cfgHaToken" placeholder="${uiConfig.ha_token ? '●●●●●●●● (saved)' : 'eyJ…'}">`
              : `<div class="settings-readonly">●●●●●●●● ${uiConfig.ha_token ? '(saved)' : '(not set)'}</div>`}
          </div>
          ${isAdmin ? `
          <button class="settings-btn" id="settingsSaveHaBtn" style="${haConnected ? 'opacity:0.6;' : ''}">
            ${haConnected ? '✓ Connected — click to reconnect' : 'Connect to Home Assistant'}
          </button>
          <div id="haConnectStatus" style="font-size:11px;color:#888;margin-top:5px;min-height:14px;text-align:center;"></div>` : `
          <div class="settings-readonly" style="text-align:center;color:#555;font-size:11px;">To manage HA connection: open Overwatch in the HA Add-on panel as an admin.</div>`}
        </div>
      </div>

      <!-- ══ GENERAL TAB ═════════════════════════════════════════ -->
      <div class="settings-tab-panel" data-panel="general">

        <div class="settings-section">
          <div class="settings-section-title">Default View ${perDeviceBadge}</div>
          <div class="settings-field">
            <div class="settings-toggle-row">
              <button class="settings-toggle ${curMode === 'map' ? 'active' : ''}" data-view="map">Floorplan</button>
              <button class="settings-toggle ${isSplitH ? 'active' : ''}" data-view="split-h">Split ↔</button>
              <button class="settings-toggle ${isSplitV ? 'active' : ''}" data-view="split-v">Split ↕</button>
              <button class="settings-toggle ${curMode === 'cameras' ? 'active' : ''}" data-view="cameras">Cameras</button>
            </div>
            <div style="font-size:11px;color:#777;margin-top:4px;">Saved per device. Does not affect other users.</div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Sidebar ${perDeviceBadge}</div>
          <div class="settings-field">
            <label>Position</label>
            <div class="settings-toggle-row">
              <button class="settings-toggle ${uiConfig.sidebar_position !== 'left' ? 'active' : ''}" id="sidebarRight">Right</button>
              <button class="settings-toggle ${uiConfig.sidebar_position === 'left' ? 'active' : ''}" id="sidebarLeft">Left</button>
            </div>
          </div>
        </div>

        ${isAdmin ? `
        <div class="settings-section">
          <div class="settings-section-title">HA Integration <span class="settings-admin-badge">Admin</span></div>
          <div style="font-size:11px;color:#666;line-height:1.6;">
            The HA Overwatch custom component is written to
            <code style="background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px;font-size:10px;">/config/custom_components/ha_overwatch/</code>
            automatically on add-on start.<br><br>
            To activate:
            <ol style="margin:6px 0 0 16px;padding:0;">
              <li>Restart Home Assistant</li>
              <li>Go to <b>Settings → Devices &amp; Services → Add Integration</b></li>
              <li>Search for <b>HA Overwatch</b> and follow the steps</li>
            </ol>
            <br>
            Entities created: <code style="font-size:10px;">switch.overwatch_*</code> and <code style="font-size:10px;">binary_sensor.overwatch_*</code>
          </div>
        </div>` : ''}

      </div>

      <!-- ══ ALARM TAB ════════════════════════════════════════════ -->
      <div class="settings-tab-panel" data-panel="alarm">
        <div class="settings-section-title">ALARM CONFIGURATION <span class="settings-admin-badge">ADMIN ONLY</span></div>
        ${adminBox}
        <div class="settings-section" ${!isAdmin ? 'style="opacity:0.45;pointer-events:none;"' : ''}>
          <div class="settings-field">
            <label>Alarm Panel Entity</label>
            ${isAdmin ? `
            <div class="entity-search-wrap" style="position:relative;">
              <input type="text" id="cfgAlarmEntity" value="${escapeHtml(uiConfig.alarm_entity || '')}"
                placeholder="alarm_control_panel.home_alarm" autocomplete="off">
              <div class="entity-search-results" id="alarmEntityResults" style="display:none;"></div>
            </div>
            <div style="font-size:11px;color:#777;margin-top:3px;">Supports alarm_control_panel, input_boolean, switch, etc.</div>
            ` : `<div class="settings-readonly">${escapeHtml(uiConfig.alarm_entity || '—')}</div>`}
          </div>
          <div class="settings-field">
            <label style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="cfgAlarmInverted" ${uiConfig.alarm_entity_inverted ? 'checked' : ''}
                ${!isAdmin ? 'disabled' : ''} style="width:16px;height:16px;accent-color:#ffcc00;">
              <span>Invert alarm entity (OFF = Armed)</span>
            </label>
          </div>
          <div class="settings-field">
            <label>Label when armed</label>
            ${isAdmin
              ? `<input type="text" id="cfgLabelArmed" value="${escapeHtml(uiConfig.alarm_label_armed || 'Armed')}" style="max-width:160px;">`
              : `<div class="settings-readonly">${escapeHtml(uiConfig.alarm_label_armed || 'Armed')}</div>`}
          </div>
          <div class="settings-field">
            <label>Label when disarmed</label>
            ${isAdmin
              ? `<input type="text" id="cfgLabelDisarmed" value="${escapeHtml(uiConfig.alarm_label_disarmed || 'Disarmed')}" style="max-width:160px;">`
              : `<div class="settings-readonly">${escapeHtml(uiConfig.alarm_label_disarmed || 'Disarmed')}</div>`}
          </div>
          ${isAdmin ? `
          <button class="settings-btn" id="settingsSaveAlarmBtn">Save Alarm Settings</button>
          <div id="alarmSaveStatus" style="font-size:11px;color:#888;margin-top:6px;text-align:center;"></div>` : ''}
        </div>
      </div>

      <!-- ══ ZONES TAB ════════════════════════════════════════════ -->
      <div class="settings-tab-panel" data-panel="zones">

        <div class="settings-section">
          <div class="settings-section-title">Floor Plan Image <span class="settings-admin-badge">ADMIN ONLY</span></div>
          ${!isAdmin ? adminBox : ''}
          <div class="settings-field" ${!isAdmin ? 'style="opacity:0.45;pointer-events:none;"' : ''}>
            <label>Image path</label>
            ${isAdmin ? `
            <div class="settings-floorplan-row">
              <input type="text" id="cfgFloorplan" value="${escapeHtml(uiConfig.floorplan || 'img/floorplan.png')}" placeholder="img/floorplan.png">
              <label class="settings-upload-btn" title="Upload">↑<input type="file" id="cfgFloorplanUpload" accept="image/*" style="display:none;"></label>
            </div>
            <div id="floorplanUploadStatus" style="font-size:11px;color:#888;margin-top:4px;"></div>
            ` : `<div class="settings-readonly">${escapeHtml(uiConfig.floorplan || 'img/floorplan.png')}</div>`}
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Floorplan Behaviour ${perDeviceBadge}</div>
          <div style="font-size:11px;color:#666;margin-bottom:4px;">Saved per device. Admin sets the default via ui.yaml; browser overrides locally.</div>
          <div class="settings-field">
            <label>Zone fade-out (seconds)</label>
            <input type="number" id="cfgFadeDuration" value="${eff('ow_fade_duration','zone_fade_duration','3')}"
              min="0" max="30" step="0.5" style="width:80px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;color:#fff;padding:6px 8px;font-size:13px;outline:none;">
            <div style="font-size:11px;color:#777;margin-top:3px;">How long a zone fades out after trigger clears. 0 = instant.</div>
          </div>
          <div class="settings-field">
            <label>Flash behaviour when triggered</label>
            <div class="settings-toggle-row">
              <button class="settings-toggle ${eff('ow_flash_mode','zone_flash_mode','zone') === 'zone'  ? 'active' : ''}" data-flash="zone">Zone only</button>
              <button class="settings-toggle ${eff('ow_flash_mode','zone_flash_mode','zone') === 'group' ? 'active' : ''}" data-flash="group">Whole group</button>
            </div>
            <div style="font-size:11px;color:#777;margin-top:4px;"><b>Zone only:</b> just the triggered zone flashes.<br><b>Whole group:</b> all zones in the group flash.</div>
          </div>
          <button class="settings-btn settings-btn-secondary" id="settingsSaveZonesBehaviourBtn">Save Zone Behaviour</button>
          <div id="zoneBehaviourSaveStatus" style="font-size:11px;color:#888;margin-top:6px;text-align:center;"></div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Zone Colours ${perDeviceBadge}</div>
          <div style="font-size:11px;color:#666;margin-bottom:6px;">Admin sets server defaults. Browser saves locally and overrides them per device.</div>
          <div class="settings-section-title" style="font-size:10px;margin-top:4px;">Armed</div>
          <div class="settings-color-grid">
            <div class="settings-color-item"><label>Person</label><input type="color" id="cfgColOnPerson" value="${eff('ow_color_on_person','color_on_person','#ff3b30')}"></div>
            <div class="settings-color-item"><label>Motion</label><input type="color" id="cfgColOnMotion" value="${eff('ow_color_on_motion','color_on_motion','#ff9500')}"></div>
            <div class="settings-color-item"><label>Door</label><input type="color" id="cfgColOnDoor" value="${eff('ow_color_on_door','color_on_door','#ff6b35')}"></div>
            <div class="settings-color-item"><label>Window</label><input type="color" id="cfgColOnWindow" value="${eff('ow_color_on_window','color_on_window','#ff9f0a')}"></div>
            <div class="settings-color-item"><label>Animal</label><input type="color" id="cfgColOnAnimal" value="${eff('ow_color_on_animal','color_on_animal','#ff6b00')}"></div>
            <div class="settings-color-item"><label>Vehicle</label><input type="color" id="cfgColOnVehicle" value="${eff('ow_color_on_vehicle','color_on_vehicle','#ff3b80')}"></div>
            <div class="settings-color-item"><label>Smoke</label><input type="color" id="cfgColOnSmoke" value="${eff('ow_color_on_smoke','color_on_smoke','#ff2d55')}"></div>
            <div class="settings-color-item"><label>CO/Gas</label><input type="color" id="cfgColOnCo" value="${eff('ow_color_on_co','color_on_co','#bf5af2')}"></div>
          </div>
          <div class="settings-section-title" style="font-size:10px;margin-top:10px;">Disarmed</div>
          <div class="settings-color-grid">
            <div class="settings-color-item"><label>Person</label><input type="color" id="cfgColOffPerson" value="${eff('ow_color_off_person','color_off_person','#4cd964')}"></div>
            <div class="settings-color-item"><label>Motion</label><input type="color" id="cfgColOffMotion" value="${eff('ow_color_off_motion','color_off_motion','#5ac8fa')}"></div>
            <div class="settings-color-item"><label>Door</label><input type="color" id="cfgColOffDoor" value="${eff('ow_color_off_door','color_off_door','#ffcc00')}"></div>
            <div class="settings-color-item"><label>Window</label><input type="color" id="cfgColOffWindow" value="${eff('ow_color_off_window','color_off_window','#ffcc00')}"></div>
            <div class="settings-color-item"><label>Animal</label><input type="color" id="cfgColOffAnimal" value="${eff('ow_color_off_animal','color_off_animal','#aad400')}"></div>
            <div class="settings-color-item"><label>Vehicle</label><input type="color" id="cfgColOffVehicle" value="${eff('ow_color_off_vehicle','color_off_vehicle','#00c7be')}"></div>
            <div class="settings-color-item"><label>Smoke</label><input type="color" id="cfgColOffSmoke" value="${eff('ow_color_off_smoke','color_off_smoke','#ff6b6b')}"></div>
            <div class="settings-color-item"><label>CO/Gas</label><input type="color" id="cfgColOffCo" value="${eff('ow_color_off_co','color_off_co','#cc73f8')}"></div>
          </div>
          <button class="settings-btn settings-btn-secondary" id="settingsSaveColoursBtn" style="margin-top:8px;">Save Colours to this device</button>
          ${isAdmin ? `<div style="font-size:10px;color:#444;margin-top:4px;">Admin: <a href="#" id="settingsSaveColoursYamlLink" style="color:#666;">Save as server default</a></div>` : ''}
          <div id="coloursSaveStatus" style="font-size:11px;color:#888;margin-top:6px;text-align:center;"></div>
        </div>
      </div>

      <!-- ══ CAMERAS TAB ══════════════════════════════════════════ -->
      <div class="settings-tab-panel" data-panel="cameras">

        <div class="settings-section">
          <div class="settings-section-title">Camera Toggle Source ${perDeviceBadge}</div>
          <div class="settings-field">
            <label>Camera visibility controlled by</label>
            <div class="settings-toggle-row">
              <button class="settings-toggle ${localStorage.getItem('ow_cam_source') !== 'device' ? 'active' : ''}" data-camsource="server">Server defaults (HA entities)</button>
              <button class="settings-toggle ${localStorage.getItem('ow_cam_source') === 'device' ? 'active' : ''}" data-camsource="device">Per device (this browser)</button>
            </div>
            <div style="font-size:11px;color:#777;margin-top:4px;">
              <b>Server defaults:</b> camera visibility follows HA entity states — consistent across all browsers and controllable via HA automations.<br>
              <b>Per device:</b> this browser uses its own camera toggle settings, ignoring HA entity state.
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Display ${perDeviceBadge}</div>
          <div class="settings-field">
            <label>Camera mode</label>
            <div class="settings-toggle-row">
              <button class="settings-toggle ${eff('ow_cam_mode','cam_default_mode','snapshot') !== 'live' ? 'active' : ''}" data-cammode="snapshot">Snapshot</button>
              <button class="settings-toggle ${eff('ow_cam_mode','cam_default_mode','snapshot') === 'live' ? 'active' : ''}" data-cammode="live">Live</button>
            </div>
            <div style="font-size:11px;color:#777;margin-top:4px;"><b>Snapshot:</b> lower bandwidth, periodic refresh.<br><b>Live:</b> MJPEG stream, instant but more resources.</div>
          </div>
          <div class="settings-field" id="hideCamLabelsField" style="margin-top:6px;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input type="checkbox" id="cfgHideCamLabels" ${eff('ow_hide_cam_labels','cam_hide_labels','false') === 'true' ? 'checked' : ''}
                style="width:16px;height:16px;accent-color:#0096ff;cursor:pointer;">
              <span>Hide camera name labels on tiles</span>
            </label>
          </div>
          <button class="settings-btn settings-btn-secondary" id="settingsSaveCamDisplayBtn" style="margin-top:6px;">Save Display</button>
          <div id="camDisplaySaveStatus" style="font-size:11px;color:#888;margin-top:6px;text-align:center;"></div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Performance ${perDeviceBadge}</div>
          <div style="font-size:11px;color:#666;margin-bottom:6px;">Admin sets the default. Browser overrides locally without changing server config.</div>
          <div class="settings-field">
            <label>Snapshot refresh interval (seconds)</label>
            <input type="number" id="cfgSnapInterval" value="${eff('ow_snap_interval','cam_snapshot_interval','2')}"
              min="1" max="30" style="width:70px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;color:#fff;padding:6px 8px;font-size:13px;outline:none;">
          </div>
          <div class="settings-field">
            <label>Camera cooldown after zone clears (seconds)</label>
            <input type="number" id="cfgCamCooldown" value="${eff('ow_cam_cooldown','cam_cooldown','30')}"
              min="0" max="300" style="width:70px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;color:#fff;padding:6px 8px;font-size:13px;outline:none;">
          </div>
          <button class="settings-btn settings-btn-secondary" id="settingsSavePerfBtn">Save Performance</button>
          <div id="perfSaveStatus" style="font-size:11px;color:#888;margin-top:6px;text-align:center;"></div>
          ${isAdmin ? `
          <div style="font-size:10px;color:#444;margin-top:6px;">Admin: <a href="#" id="settingsSavePerfYamlLink" style="color:#666;">Save as server default</a></div>` : ''}
        </div>

      </div>

    </div>
  `;

  document.body.appendChild(panel);
  makeDraggable(panel, panel.querySelector(".settings-titlebar"), "settingsPanel");
  document.getElementById("settingsCloseBtn").onclick = () => panel.classList.remove("open");
  panel.addEventListener("pointerdown", e => e.stopPropagation());

  // Live-update HA connection status every 2s while settings is open
  const connPollTimer = setInterval(() => {
    if (!panel.classList.contains("open")) { clearInterval(connPollTimer); return; }
    updateSettingsConnectionBox();
  }, 2000);

  // ── Tab switching ────────────────────────────────────────────
  panel.querySelectorAll(".settings-tab").forEach(tab => {
    tab.onclick = () => {
      panel.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      panel.querySelectorAll(".settings-tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      panel.querySelector(`.settings-tab-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add("active");
    };
  });

  // ── View mode ────────────────────────────────────────────────
  panel.querySelectorAll(".settings-toggle[data-view]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-view]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const v = btn.dataset.view;
      if (v === 'split-h') {
        localStorage.setItem('ow_split_dir', 'h');
        document.body.setAttribute('data-split-dir', 'h');
        setViewMode('split');
      } else if (v === 'split-v') {
        localStorage.setItem('ow_split_dir', 'v');
        document.body.setAttribute('data-split-dir', 'v');
        setViewMode('split');
      } else {
        setViewMode(v);
      }
    };
  });

  // ── Flash mode ───────────────────────────────────────────────
  panel.querySelectorAll(".settings-toggle[data-flash]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-flash]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem('ow_flash_mode', btn.dataset.flash);
    };
  });

  // ── Camera source toggle (server/device) ────────────────────
  panel.querySelectorAll(".settings-toggle[data-camsource]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-camsource]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem('ow_cam_source', btn.dataset.camsource);
    };
  });

  // ── Camera mode ──────────────────────────────────────────────
  panel.querySelectorAll(".settings-toggle[data-cammode]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-cammode]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem('ow_cam_mode', btn.dataset.cammode);
      if (window._camSetMode) window._camSetMode(btn.dataset.cammode);
    };
  });

  // ── Camera labels ────────────────────────────────────────────
  document.getElementById("cfgHideCamLabels")?.addEventListener("change", function() {
    localStorage.setItem('ow_hide_cam_labels', this.checked ? 'true' : 'false');
    document.querySelectorAll('.cam-tile-label').forEach(el => {
      el.style.display = this.checked ? 'none' : '';
    });
  });

  // ── Sidebar position ─────────────────────────────────────────
  const sbRight = document.getElementById("sidebarRight");
  const sbLeft  = document.getElementById("sidebarLeft");
  if (sbRight) sbRight.onclick = () => {
    uiConfig.sidebar_position = "right"; applyConfig(); updateExpandBtn(uiConfig.sidebar_collapsed);
    sbRight.classList.add("active"); sbLeft?.classList.remove("active");
  };
  if (sbLeft) sbLeft.onclick = () => {
    uiConfig.sidebar_position = "left"; applyConfig(); updateExpandBtn(uiConfig.sidebar_collapsed);
    sbLeft.classList.add("active"); sbRight?.classList.remove("active");
  };

  // ── Save zone behaviour to localStorage ──────────────────────
  document.getElementById("settingsSaveZonesBehaviourBtn")?.addEventListener("click", () => {
    const fadeVal = document.getElementById("cfgFadeDuration")?.value;
    if (fadeVal != null) localStorage.setItem('ow_fade_duration', fadeVal);
    const flashBtn = panel.querySelector(".settings-toggle[data-flash].active");
    if (flashBtn) localStorage.setItem('ow_flash_mode', flashBtn.dataset.flash);
    const statusEl = document.getElementById("zoneBehaviourSaveStatus");
    if (statusEl) { statusEl.textContent = "✓ Saved to this device"; statusEl.style.color = "#32d74b"; }
  });

  // ── Save camera display to localStorage ──────────────────────
  document.getElementById("settingsSaveCamDisplayBtn")?.addEventListener("click", () => {
    const camModeBtn = panel.querySelector(".settings-toggle[data-cammode].active");
    if (camModeBtn) {
      localStorage.setItem('ow_cam_mode', camModeBtn.dataset.cammode);
      if (window._camSetMode) window._camSetMode(camModeBtn.dataset.cammode);
    }
    const hideLabels = document.getElementById("cfgHideCamLabels")?.checked;
    if (hideLabels != null) localStorage.setItem('ow_hide_cam_labels', hideLabels ? 'true' : 'false');
    const statusEl = document.getElementById("camDisplaySaveStatus");
    if (statusEl) { statusEl.textContent = "✓ Saved to this device"; statusEl.style.color = "#32d74b"; }
  });

  // ── Save performance to localStorage ─────────────────────────
  document.getElementById("settingsSavePerfBtn")?.addEventListener("click", () => {
    const interval = document.getElementById("cfgSnapInterval")?.value;
    const cooldown = document.getElementById("cfgCamCooldown")?.value;
    if (interval) localStorage.setItem('ow_snap_interval', interval);
    if (cooldown) localStorage.setItem('ow_cam_cooldown', cooldown);
    const statusEl = document.getElementById("perfSaveStatus");
    if (statusEl) { statusEl.textContent = "✓ Saved to this device"; statusEl.style.color = "#32d74b"; }
  });

  // ── Save colours to localStorage (all users) ─────────────────
  document.getElementById("settingsSaveColoursBtn")?.addEventListener("click", () => {
    const colourMap = {
      cfgColOnPerson: 'ow_color_on_person', cfgColOnMotion: 'ow_color_on_motion',
      cfgColOnDoor:   'ow_color_on_door',   cfgColOnWindow: 'ow_color_on_window',
      cfgColOnAnimal: 'ow_color_on_animal', cfgColOnVehicle:'ow_color_on_vehicle',
      cfgColOnSmoke:  'ow_color_on_smoke',  cfgColOnCo:     'ow_color_on_co',
      cfgColOffPerson:'ow_color_off_person',cfgColOffMotion:'ow_color_off_motion',
      cfgColOffDoor:  'ow_color_off_door',  cfgColOffWindow:'ow_color_off_window',
      cfgColOffAnimal:'ow_color_off_animal',cfgColOffVehicle:'ow_color_off_vehicle',
      cfgColOffSmoke: 'ow_color_off_smoke', cfgColOffCo:    'ow_color_off_co',
    };
    Object.entries(colourMap).forEach(([id, lsKey]) => {
      const val = document.getElementById(id)?.value;
      if (val) localStorage.setItem(lsKey, val);
    });
    renderZones(); // apply immediately
    const statusEl = document.getElementById("coloursSaveStatus");
    if (statusEl) { statusEl.textContent = "✓ Saved to this device"; statusEl.style.color = "#32d74b"; }
  });

  if (!isAdmin) return;  // ══ Admin-only bindings below ══════════

  // ── Alarm entity live search ─────────────────────────────────
  const alarmInput   = document.getElementById("cfgAlarmEntity");
  const alarmResults = document.getElementById("alarmEntityResults");
  if (alarmInput && alarmResults) {
    alarmInput.oninput = () => {
      const q = alarmInput.value.trim().toLowerCase();
      if (!q || !haConnected) { alarmResults.style.display = "none"; return; }
      const hits = Object.keys(haStates).filter(id => id.toLowerCase().includes(q)).slice(0, 20)
        .map(id => ({ id, state: haStates[id]?.state || "—", friendly: haStates[id]?.attributes?.friendly_name || "" }));
      if (!hits.length) { alarmResults.style.display = "none"; return; }
      alarmResults.innerHTML = hits.map(h => `
        <div class="entity-search-result" data-entity-id="${escapeHtml(h.id)}">
          <span class="entity-search-id">${escapeHtml(h.id)}</span>
          <span class="entity-search-state">${escapeHtml(h.state)}</span>
          ${h.friendly ? `<span class="entity-search-friendly">${escapeHtml(h.friendly)}</span>` : ""}
        </div>`).join("");
      alarmResults.style.display = "block";
      alarmResults.querySelectorAll(".entity-search-result").forEach(el => {
        el.onclick = () => { alarmInput.value = el.dataset.entityId; alarmResults.style.display = "none"; };
      });
    };
    document.addEventListener("pointerdown", function hideAlarm(e) {
      if (!alarmInput.contains(e.target) && !alarmResults.contains(e.target)) {
        alarmResults.style.display = "none";
        document.removeEventListener("pointerdown", hideAlarm);
      }
    });
  }

  // ── Floorplan upload ─────────────────────────────────────────
  const uploadInput  = document.getElementById("cfgFloorplanUpload");
  const uploadStatus = document.getElementById("floorplanUploadStatus");
  if (uploadInput) {
    uploadInput.onchange = async () => {
      const file = uploadInput.files[0]; if (!file) return;
      uploadStatus.textContent = "Uploading…";
      try {
        const form = new FormData(); form.append("file", file);
        const res = await fetch(apiPath("ow/upload-floorplan"), { method: "POST", body: form });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const path = data.path || ("img/" + file.name);
          document.getElementById("cfgFloorplan").value = path;
          uiConfig.floorplan = path;
          const fp = document.getElementById("floorplanImage");
          if (fp) { fp.src = apiPath(path) + "?v=" + Date.now(); fp.onload = initFloorplan; }
          uploadStatus.textContent = "✓ Uploaded: " + path; uploadStatus.style.color = "#32d74b";
        } else { uploadStatus.textContent = "✗ Failed (" + res.status + ")"; uploadStatus.style.color = "#ff3b30"; }
      } catch (err) { uploadStatus.textContent = "✗ " + err.message; uploadStatus.style.color = "#ff3b30"; }
    };
  }
  const fpInput = document.getElementById("cfgFloorplan");
  if (fpInput) {
    fpInput.onblur = () => {
      uiConfig.floorplan = fpInput.value.trim();
      const fp = document.getElementById("floorplanImage");
      if (fp && uiConfig.floorplan) { fp.src = apiPath(uiConfig.floorplan) + "?v=" + Date.now(); fp.onload = initFloorplan; }
    };
  }

  // ── Build ui.yaml ────────────────────────────────────────────
  function buildYamlContent() {
    const g = id => document.getElementById(id)?.value || "";
    return (
      `ui:\n` +
      `  ha_url: "${uiConfig.ha_url || ""}"\n` +
      `  ha_token: "${g("cfgHaToken") || uiConfig.ha_token || ""}"\n` +
      `  alarm_entity: "${g("cfgAlarmEntity") || uiConfig.alarm_entity || ""}"\n` +
      `  alarm_entity_inverted: ${document.getElementById("cfgAlarmInverted")?.checked ?? false}\n` +
      `  alarm_label_armed: "${g("cfgLabelArmed") || uiConfig.alarm_label_armed || "Armed"}"\n` +
      `  alarm_label_disarmed: "${g("cfgLabelDisarmed") || uiConfig.alarm_label_disarmed || "Disarmed"}"\n` +
      `  sidebar_position: "${uiConfig.sidebar_position}"\n` +
      `  floorplan: "${g("cfgFloorplan") || uiConfig.floorplan || "img/floorplan.png"}"\n` +
      `  zone_fade_duration: ${g("cfgFadeDuration") || uiConfig.zone_fade_duration || 3}\n` +
      `  color_on_person: "${g("cfgColOnPerson") || uiConfig.color_on_person}"\n` +
      `  color_on_motion: "${g("cfgColOnMotion") || uiConfig.color_on_motion}"\n` +
      `  color_on_door: "${g("cfgColOnDoor") || uiConfig.color_on_door}"\n` +
      `  color_on_window: "${g("cfgColOnWindow") || uiConfig.color_on_window}"\n` +
      `  color_on_animal: "${g("cfgColOnAnimal") || uiConfig.color_on_animal}"\n` +
      `  color_on_vehicle: "${g("cfgColOnVehicle") || uiConfig.color_on_vehicle}"\n` +
      `  color_on_smoke: "${g("cfgColOnSmoke") || uiConfig.color_on_smoke}"\n` +
      `  color_on_co: "${g("cfgColOnCo") || uiConfig.color_on_co}"\n` +
      `  color_off_person: "${g("cfgColOffPerson") || uiConfig.color_off_person}"\n` +
      `  color_off_motion: "${g("cfgColOffMotion") || uiConfig.color_off_motion}"\n` +
      `  color_off_door: "${g("cfgColOffDoor") || uiConfig.color_off_door}"\n` +
      `  color_off_window: "${g("cfgColOffWindow") || uiConfig.color_off_window}"\n` +
      `  color_off_animal: "${g("cfgColOffAnimal") || uiConfig.color_off_animal}"\n` +
      `  color_off_vehicle: "${g("cfgColOffVehicle") || uiConfig.color_off_vehicle}"\n` +
      `  color_off_smoke: "${g("cfgColOffSmoke") || uiConfig.color_off_smoke}"\n` +
      `  color_off_co: "${g("cfgColOffCo") || uiConfig.color_off_co}"\n` +
      `  cam_default_mode: "${uiConfig.cam_default_mode || "snapshot"}"\n` +
      `  cam_snapshot_interval: ${uiConfig.cam_snapshot_interval || 2}\n` +
      `  cam_cooldown: ${uiConfig.cam_cooldown || 30}\n` +
      `  cam_max_visible: ${uiConfig.cam_max_visible || 0}\n` +
      `  cam_sort_order: "${uiConfig.cam_sort_order || "recent_first"}"\n` +
      `  cam_fail_hide_seconds: ${uiConfig.cam_fail_hide_seconds || 5}\n` +
      `  cam_low_res_map: '${uiConfig.cam_low_res_map || "{}"}'\n` +
      `  cam_pinned: '${uiConfig.cam_pinned || "[]"}'\n`
    );
  }

  async function saveYaml(statusId) {
    const el = document.getElementById(statusId);
    if (el) { el.textContent = "Saving…"; el.style.color = "#888"; }
    try {
      const res = await fetch(apiPath("ow/save-config"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "config/ui.yaml", content: buildYamlContent() })
      });
      if (res.ok) {
        if (el) { el.textContent = "✓ Saved"; el.style.color = "#32d74b"; }
        await loadConfig();
      } else if (el) { el.textContent = "✗ Save failed"; el.style.color = "#ff3b30"; }
    } catch (e) { if (el) { el.textContent = "✗ " + e.message; el.style.color = "#ff3b30"; } }
  }

  // ── HA connect ───────────────────────────────────────────────
  const connectBtn    = document.getElementById("settingsSaveHaBtn");
  const tokenField    = document.getElementById("cfgHaToken");
  const connectStatus = document.getElementById("haConnectStatus");
  if (tokenField && connectBtn) {
    tokenField.addEventListener("input", () => {
      connectBtn.style.opacity = "1";
      connectBtn.textContent = "Connect to Home Assistant";
    });
  }
  if (connectBtn) {
    connectBtn.onclick = async () => {
      const newToken = tokenField?.value.trim() || "";
      if (!newToken && !uiConfig.ha_token) {
        if (connectStatus) { connectStatus.textContent = "✗ Enter a token first."; connectStatus.style.color = "#ff3b30"; }
        return;
      }
      if (newToken) {
        uiConfig.ha_token = newToken;
        try {
          await fetch(apiPath("ow/save-config"), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: "config/ui.yaml", content: buildYamlContent() })
          });
        } catch { /* non-fatal */ }
      }
      if (haSocket) { haSocket.onclose = null; haSocket.close(); haSocket = null; haConnected = false; }
      connectHA();
      if (connectStatus) { connectStatus.textContent = "Connecting…"; connectStatus.style.color = "#888"; }
    };
  }

  document.getElementById("settingsSaveAlarmBtn")?.addEventListener("click",   () => saveYaml("alarmSaveStatus"));
  document.getElementById("settingsSaveColoursYamlLink")?.addEventListener("click", e => {
    e.preventDefault();
    saveYaml("coloursSaveStatus");
  });
  document.getElementById("settingsSavePerfYamlLink")?.addEventListener("click", e => {
    e.preventDefault();
    // Update uiConfig with current localStorage overrides before saving to yaml
    const interval = localStorage.getItem('ow_snap_interval');
    const cooldown = localStorage.getItem('ow_cam_cooldown');
    if (interval) uiConfig.cam_snapshot_interval = parseFloat(interval);
    if (cooldown) uiConfig.cam_cooldown = parseFloat(cooldown);
    saveYaml("perfSaveStatus");
  });
}

function makeDraggable(panel, titlebar, storageKey) {
  if (!panel || !titlebar) return () => {};

  let drag = { active: false, ox: 0, oy: 0 };
  let pos  = { x: null, y: null };

  function applyPos(x, y) {
    // Clamp to viewport
    x = Math.max(0, Math.min(window.innerWidth  - 60, x));
    y = Math.max(0, Math.min(window.innerHeight - 60, y));
    pos.x = x; pos.y = y;
    panel.style.position = "fixed";
    panel.style.left     = x + "px";
    panel.style.top      = y + "px";
    panel.style.right    = "unset";
    panel.style.bottom   = "unset";
    if (storageKey) {
      localStorage.setItem(storageKey + "_x", x);
      localStorage.setItem(storageKey + "_y", y);
    }
  }

  function restorePos() {
    if (!storageKey) return;
    const sx = localStorage.getItem(storageKey + "_x");
    const sy = localStorage.getItem(storageKey + "_y");
    if (sx !== null && sy !== null) applyPos(Number(sx), Number(sy));
  }

  titlebar.style.cursor = "grab";

  titlebar.addEventListener("pointerdown", e => {
    if (e.target.closest("button, input, select, textarea")) return;
    drag.active = true;
    const rect = panel.getBoundingClientRect();
    drag.ox = e.clientX - rect.left;
    drag.oy = e.clientY - rect.top;
    titlebar.setPointerCapture(e.pointerId);
    titlebar.style.cursor = "grabbing";
    e.preventDefault();
  });

  titlebar.addEventListener("pointermove", e => {
    if (!drag.active) return;
    applyPos(e.clientX - drag.ox, e.clientY - drag.oy);
  });

  titlebar.addEventListener("pointerup", () => {
    drag.active = false;
    titlebar.style.cursor = "grab";
  });

  restorePos();
  return restorePos;
}

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
      if (String(s).toLowerCase().includes(query)) {
        hits.push({ type: "entity", zoneId: z.id, title: s, sub: `Sensor in ${z.name || z.id}` });
      }
    }
    for (const c of (z.cameras || [])) {
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
  if (editorMode) { renderZonesEditor(); renderZones(); }
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
  if (masterChk) masterChk.checked = masterEnabled;

  // Per-zone: toggle, eye, dot, state label
  body.querySelectorAll(".zone-enabled-chk[data-zone-id]").forEach(chk => {
    const zone = zones.find(z => z.id === chk.dataset.zoneId);
    if (!zone) return;
    chk.checked  = zone.enabled !== false;
    chk.disabled = !masterEnabled;

    const row = chk.closest(".status-dd-zone");
    if (!row) return;
    const isOff = zone.enabled === false || !masterEnabled;
    const st    = getZoneState(zone);
    const isTriggeredZone = st === "triggered";
    const sensors = zone.sensors || [];
    const anyActive = haConnected && sensors.some(isEntityTriggered);
    const isDisarmedActive = isOff && anyActive;

    const dotColour = isTriggeredZone ? "#ff3b30"
      : isDisarmedActive ? resolveColour(entityTypeColourOff(detectEntityType(sensors.find(isEntityTriggered) || "")))
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
    const allArmed = members.length > 0 && members.every(z => z.enabled !== false && masterEnabled);
    chk.checked = allArmed;

    const hdr = chk.closest(".status-dd-group-header");
    if (!hdr) return;
    const allDisarmed  = members.every(z => z.enabled === false || !masterEnabled);
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
    const allArmed   = ung.length > 0 && ung.every(z => z.enabled !== false && masterEnabled);
    const allDisarmed = ung.every(z => z.enabled === false || !masterEnabled);
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
    const isOff = z.enabled === false || !masterEnabled;
    const isTriggeredZone = state === "triggered";
    const sensors = z.sensors || [];
    const anyActive = haConnected && sensors.some(isEntityTriggered);
    const isDisarmedActive = isOff && anyActive;
    const dotColour = isTriggeredZone ? "#ff3b30"
      : isDisarmedActive ? resolveColour(entityTypeColourOff(detectEntityType(sensors.find(isEntityTriggered) || "")))
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
        <label class="zone-toggle-switch" style="flex-shrink:0;">
          <input type="checkbox" class="zone-enabled-chk" data-zone-id="${z.id}" ${z.enabled !== false ? "checked" : ""} ${!masterEnabled ? "disabled" : ""}>
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
    const allArmed    = members.length > 0 && members.every(z => z.enabled !== false && masterEnabled);
    const allDisarmed = members.length === 0 || members.every(z => z.enabled === false || !masterEnabled);
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
        <label class="zone-toggle-switch" style="flex-shrink:0;">
          <input type="checkbox" class="group-armed-chk" data-group-id="${g.id}" ${allArmed ? "checked" : ""}>
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
    const allArmed    = ungroupedZones.length > 0 && ungroupedZones.every(z => z.enabled !== false && masterEnabled);
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
        <label class="zone-toggle-switch" style="flex-shrink:0;">
          <input type="checkbox" class="ungrouped-armed-chk" ${allArmed ? "checked" : ""}>
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

  body.innerHTML = `
    <div class="status-dd-zones">
      <div class="status-dd-master">
        <span style="width:10px;flex-shrink:0;"></span>
        <div style="width:8px;height:8px;flex-shrink:0;"></div>
        <span style="flex:1;font-size:11px;font-weight:600;color:#aaa;">Master</span>
        <span class="status-dd-state" style="opacity:0;user-select:none;">——</span>
        <button class="zone-eye-btn" id="masterEyeBtn"
          style="background:none;border:none;padding:0 2px;cursor:pointer;color:${allHidden ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.65)'};line-height:0;flex-shrink:0;"
        >${allHidden ? eyeClosed : eyeOpen}</button>
        <label class="zone-toggle-switch" style="flex-shrink:0;">
          <input type="checkbox" id="masterToggleChk" ${masterEnabled ? "checked" : ""}>
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
  document.getElementById("masterToggleChk")?.addEventListener("change", e => setMasterEnabled(e.target.checked));

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
    chk.addEventListener("change", e => setGroupArmed(e.target.dataset.groupId, e.target.checked));
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
    chk.addEventListener("change", e => setZoneEnabled(e.target.dataset.zoneId, e.target.checked));
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
    if (!isOpen) renderStatusDropdown();
  });

  document.addEventListener("pointerdown", e => {
    if (!bar.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = "none";
    }
  });
}

/* ─── SEARCH UI BINDINGS ──────────────────────────────────── */
function bindCommonSidebarButtons() {
  const settingsBtn = document.getElementById("settingsBtn");
  const logBtn      = document.getElementById("logBtn");
  if (settingsBtn) settingsBtn.onclick = () => renderSettingsPanel();
  if (logBtn)      logBtn.onclick      = () => renderLogPanel(true);
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

/* ─── ZONES BUTTON ACTIVE STATE ───────────────────────────── */
function bindZonesButton() {
  const zonesBtn = document.getElementById("zonesBtn");
  if (!zonesBtn) return;
  zonesBtn.onclick = () => {
    editorMode = !editorMode;
    isCreatingZone = false;
    isEditingPoints = false;
    currentNewZone = null;
    if (editorMode) editorPosRestored = false; // allow position restore on open
    zonesBtn.classList.toggle("active", editorMode);
    const svg = document.getElementById("zonesSvg");
    if (svg) svg.style.pointerEvents = editorMode ? "all" : "none";
    renderZonesEditor();
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
  bindPan();
  initFloorplan();
  bindZonesButton();
  bindStatusBar();
  bindSearchUI();

  bindSidebarToggle();
  bindCommonSidebarButtons();
  initViewToggle();  // apply startup view mode, wire split handle drag
  // Hide zones editor button for non-admin (direct browser access)
  if (IS_DIRECT_MODE) {
    const zonesBtn = document.getElementById("zonesBtn");
    if (zonesBtn) zonesBtn.style.display = "none";
  }

  await loadZones();
  await loadGroups();
  bindZonesSvgEvents();
  renderZonesEditor();
  renderZones();
  await loadConfig();

  await startServerHealthCheck();

  if (!haConnected) connectHA();

  startLiveRefresh();
  logEvent("info", "HA-Overwatch initialised.", "system");

  subscribeHAEntities();

  // ── Expose shared state for cameras.js ─────────────────────
  // These are live references — cameras.js reads them directly.
  window.OW = {
    get zones()         { return zones; },
    get groups()        { return groups; },
    get haStates()      { return haStates; },
    get haConnected()   { return haConnected; },
    get uiConfig()      { return uiConfig; },
    get masterEnabled() { return masterEnabled; },
    get isAddonMode()   { return isAddonMode; },
    isEntityTriggered,
    apiPath,
    logEvent,
    renderSettingsPanel,
    renderLogPanel,
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
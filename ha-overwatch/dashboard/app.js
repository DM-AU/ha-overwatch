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
let highlightedZoneId = null;
let highlightedUntil = 0;
let searchDebounce = null;

/* ─── HA STATE ────────────────────────────────────────────── */
let haSocket = null;
let haConnected = false;
let haEverConnected = false;  // true after first successful auth_ok
let haStates = {};        // entity_id -> state object
let haMsgId = 1;
let haPendingCmds = {};
let haReconnectTimer = null;
let haSubscribedEntities = new Set();

/* ─── MODULE LOADER ───────────────────────────────────────── */
async function loadModule(targetId, file) {
  const target = document.getElementById(targetId);
  if (!target) return;

  // Some deployments keep modules in /modules/, others keep them at the root.
  const urls = [
    `modules/${file}?v=${Date.now()}`,
    `${file}?v=${Date.now()}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      target.innerHTML = await res.text();
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

  // Re-connect HA if credentials changed — skip if already connected or add-on mode handling it
  if (!haConnected && !isAddonMode && uiConfig.ha_url && uiConfig.ha_token) {
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
    const vw = window.innerWidth, vh = window.innerHeight;
    const cx = vw / 2, cy = vh / 2;
    // Keep the center point fixed while scaling
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
      // Reset: fit image to viewport
      const vw = window.innerWidth, vh = window.innerHeight;
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
  // setZoneEnabled already calls updateStatusDropdownInPlace for each zone
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
  const armed = isAlarmArmed();
  const prefix = armed ? "color_on_" : "color_off_";
  const legacyMap = {
    person: "color_triggered_person", motion: "color_triggered_motion",
    door: "color_triggered_door", window: "color_triggered_window",
    smoke: "color_triggered_smoke", co: "color_triggered_co",
    animal: "color_triggered_default", vehicle: "color_triggered_default",
    default: "color_triggered_default",
  };
  const newKey = prefix + type;
  if (uiConfig[newKey]) return uiConfig[newKey];
  return uiConfig[legacyMap[type] || "color_triggered_default"] || "#ff3b30";
}

// Always returns the disarmed (off) colour regardless of alarm state
function entityTypeColourOff(type) {
  return uiConfig[`color_off_${type}`] || uiConfig.color_off_default || "#4cd964";
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
  const dur = (uiConfig.zone_fade_duration || 3) * 1000;
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

/* ─── HA ENTITY SYNC (issue 17 Phase 1) ──────────────────── */
// Mirrors app.js slug logic — must match server.js zoneSlug()
function haZoneSlug(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "zone";
}

function haZoneEntityIds(zone) {
  const slug = haZoneSlug(zone.name || zone.id);
  return {
    armed:     `input_boolean.overwatch_zone_${slug}_armed`,
    triggered: `input_boolean.overwatch_zone_${slug}_triggered`,
  };
}

// Push a zone's current state to HA via the server.js relay.
// Fire-and-forget — errors are logged but never block the UI.
async function syncZoneToHA(zone, state) {
  if (!serverApiAvailable) return;  // no server.js running
  try {
    await fetch(apiPath("ow/ha-sync-zone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        zoneId:   zone.id,
        zoneName: zone.name || zone.id,
        state,
      }),
    });
  } catch { /* server unreachable — silently ignore */ }
}

async function syncMasterToHA(armed) {
  if (!serverApiAvailable) return;
  try {
    await fetch(apiPath("ow/ha-sync-master"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ armed }),
    });
  } catch { /* ignore */ }
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
  const showHighlight = highlightedZoneId && now < highlightedUntil;

  // ── Group member highlight layer ────────────────────────────
  // Render all group members into a single <g> with group-level opacity
  // so overlapping zones don't stack/seam — they become one flat shape.
  if (editorMode && selectedGroupId) {
    const selectedGrp = groups.find(g => g.id === selectedGroupId);
    if (selectedGrp) {
      const grpHex = selectedGrp.colorHex || "#ff3b30";

      // Single fill-only pass — no per-polygon strokes so overlaps never show seams
      const fillGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      fillGroup.setAttribute("fill", grpHex);
      fillGroup.setAttribute("fill-opacity", "0.72");
      fillGroup.setAttribute("stroke", "none");
      // Drop-shadow filter gives a subtle outer glow/outline without internal seams
      fillGroup.setAttribute("style", `filter: drop-shadow(0 0 3px ${grpHex})`);

      let hasMembers = false;
      (selectedGrp.zone_ids || []).forEach(zid => {
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

    // Group member zones are already rendered by the group layer above with uniform colour.
    // Skip individual rendering for them (unless they are also the selected zone).
    const activeGrp = editorMode && selectedGroupId ? groups.find(g => g.id === selectedGroupId) : null;
    const isGroupMember = activeGrp && (activeGrp.zone_ids || []).includes(zone.id);
    if (isGroupMember && !isSelected && editorMode) return;

    const pointsStr = pts.map(p => `${p.x},${p.y}`).join(" ");

    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", pointsStr || "0,0");
    poly.dataset.zoneId = zone.id;

    let cls = "zone-polygon";
    if (editorMode && isSelected) cls += " selected";
    if (isHighlight) cls += " zone-highlight";
    poly.setAttribute("class", cls);

    if (isHighlight) {
      // Search highlight: soft amber fill, soft stroke
      poly.style.fill        = "rgba(255,204,0,0.22)";
      poly.style.stroke      = "rgba(255,204,0,0.5)";
      poly.style.strokeWidth = String(1.5 / zoom.scale);

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

    } else if (isTriggered) {
      const triggeredEntity = (zone.sensors || []).find(isEntityTriggered);
      const type = detectEntityType(triggeredEntity || "");
      const hex  = resolveColour(entityTypeColour(type));
      const fillAlpha   = flashPhase ? 0.18 : 0.65;
      // Stroke alpha is the same as fill — no separate harsh outline
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
      const collapsed  = localStorage.getItem(storageKey) === "collapsed";
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
    document.getElementById("zoneNameInput")?.addEventListener("input", e => {
      selectedZone.name = e.target.value;
      saveZone(selectedZone);
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
        .filter(id => id.toLowerCase().includes(query))
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
    selectedZoneId  = null;
    selectedGroupId = null;
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
// Detect the ingress base path from the <base> tag injected by server.js.
// fetch() ignores <base> tags — we must prefix all API calls manually.
// In standalone mode base tag is "./" so BASE_PATH becomes empty string.
const BASE_PATH = (() => {
  const base = document.querySelector("base");
  if (!base) return "";
  const href = base.getAttribute("href") || "";
  // If it's a full ingress URL like /api/hassio_ingress/<token>/ use it as prefix
  return href === "./" || href === "/" ? "" : href.replace(/\/$/, "");
})();

// Prefix a relative API path with the ingress base path
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
  const text = document.getElementById("haStatusText");
  if (!badge) return;
  badge.classList.remove("connected", "disconnected", "error");
  badge.classList.add(status);
  if (text) text.textContent = "HA";
}

function connectHA() {
  if (haSocket && (haSocket.readyState === WebSocket.OPEN || haSocket.readyState === WebSocket.CONNECTING)) return;
  if (haReconnectTimer) clearTimeout(haReconnectTimer);

  let wsUrl;
  const pageIsHttps = window.location.protocol === "https:";

  if (isAddonMode) {
    // In add-on mode: connect to our own server's WebSocket proxy.
    // The proxy handles auth server-side — browser sends dummy token which gets replaced.
    const proto = pageIsHttps ? "wss:" : "ws:";
    const host  = window.location.host;
    wsUrl = `${proto}//${host}${BASE_PATH}/ws/api/websocket`;
    logEvent("info", "Connecting to HA via add-on WebSocket proxy…", "ha");
  } else {
    // Standalone mode: connect directly to HA WebSocket
    if (!uiConfig.ha_url) return;
    if (!uiConfig.ha_token) {
      logEvent("warn", "HA token required in standalone mode. Enter it in Settings.", "ha");
      return;
    }
    // Upgrade ws:// → wss:// if page is served over HTTPS (mixed content block)
    let haUrl = uiConfig.ha_url.replace(/\/$/, "");
    if (pageIsHttps && haUrl.startsWith("http://")) {
      haUrl = haUrl.replace("http://", "https://");
      logEvent("info", "Upgrading HA connection to HTTPS to match page protocol.", "ha");
    }
    wsUrl = haUrl.replace(/^http/, "ws") + "/api/websocket";
    logEvent("info", `Connecting to HA at ${haUrl}…`, "ha");
  }

  try {
    haSocket = new WebSocket(wsUrl);
  } catch (e) {
    logEvent("error", "WebSocket creation failed: " + e.message, "ha");
    setHAStatus("error");
    haReconnectTimer = setTimeout(connectHA, 15000);
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
      setHAStatus("connected");
      logEvent("ok", "Connected to Home Assistant (" + (msg.ha_version || "?") + ")", "ha");
      fetchAllStates();
      subscribeHAEntities();
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
        }
      }
    }
  };

  haSocket.onclose = (ev) => {
    haConnected = false;
    setHAStatus("disconnected");
    const reason = ev.reason ? ` (${ev.reason})` : "";
    // Only show disconnect warning if we had a working connection before
    if (haEverConnected) {
      logEvent("warn", `HA WebSocket disconnected (code ${ev.code})${reason}. Retrying in 10s…`, "ha");
    }
    haReconnectTimer = setTimeout(connectHA, 10000);
  };

  haSocket.onerror = () => {
    setHAStatus("error");
    // Only show error if we've connected before — suppresses noise on first load
    if (haEverConnected) {
      logEvent("error", "HA WebSocket error. Is the HA URL correct and reachable?", "ha");
    }
  };
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
  panel.innerHTML = `
    <div class="settings-titlebar">
      <span class="settings-title">Settings</span>
      <button class="zones-editor-close" id="settingsCloseBtn">✕</button>
    </div>
    <div class="settings-body">

      <!-- ══ HOME ASSISTANT ══════════════════════════════════ -->
      <div class="settings-section">
        <div class="settings-section-title">Home Assistant</div>

        <!-- Connection status box (traffic-light) -->
        <div id="haConnectionStatus" style="border-radius:8px;padding:10px 12px;margin-bottom:12px;border:1px solid;
          ${haConnected
            ? 'background:rgba(50,215,75,0.08);border-color:rgba(50,215,75,0.25);'
            : 'background:rgba(255,59,48,0.07);border-color:rgba(255,59,48,0.2);'}">
          <div style="font-size:12px;font-weight:600;margin-bottom:4px;
            color:${haConnected ? '#32d74b' : '#ff453a'};">
            ${haConnected ? 'Connected to Home Assistant' : 'Not connected to Home Assistant'}
          </div>
          ${isAddonMode
            ? `<div style="color:#777;font-size:11px;line-height:1.5;">
                Running as HA Add-on — URL is automatic.<br>
                Enter your Long-Lived Token below once and it will be stored securely server-side.
               </div>`
            : `<div style="color:#777;font-size:11px;">Enter your HA URL and token below.</div>`
          }
        </div>

        ${!isAddonMode ? `
        <div class="settings-field">
          <label>HA URL</label>
          <input type="text" id="cfgHaUrl" value="${escapeHtml(uiConfig.ha_url || "")}"
            placeholder="http://homeassistant.local:8123">
        </div>
        ` : ""}

        <div class="settings-field">
          <label>Long-Lived Access Token</label>
          <input type="password" id="cfgHaToken" placeholder="${uiConfig.ha_token ? "●●●●●●●● (saved)" : "eyJ…"}">
          <div style="font-size:11px;color:#666;margin-top:4px;">
            HA → Profile (bottom left) → Security → Long-Lived Access Tokens → Create Token
          </div>
        </div>

        <button class="settings-btn" id="settingsSaveHaBtn"
          style="${haConnected ? 'opacity:0.5;' : ''}">
          ${haConnected ? '✓ Connected — click to reconnect' : 'Connect to Home Assistant'}
        </button>
        <div id="haConnectStatus" style="font-size:11px;color:#888;margin-top:5px;min-height:14px;text-align:center;"></div>
      </div>

      <!-- ══ ALARM CONFIGURATION ═════════════════════════════ -->
      <div class="settings-section">
        <div class="settings-section-title">Alarm Configuration</div>
        <div class="settings-field">
          <label>Alarm Panel Entity</label>
          <div class="entity-search-wrap" style="position:relative;">
            <input type="text" id="cfgAlarmEntity" value="${escapeHtml(uiConfig.alarm_entity || "")}"
              placeholder="alarm_control_panel.home_alarm or input_boolean.alarm" autocomplete="off">
            <div class="entity-search-results" id="alarmEntityResults" style="display:none;"></div>
          </div>
          <div style="font-size:11px;color:#777;margin-top:3px;">Supports any entity: alarm_control_panel, input_boolean, switch, etc.</div>
        </div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="cfgAlarmInverted" ${uiConfig.alarm_entity_inverted ? "checked" : ""}
              style="width:16px;height:16px;cursor:pointer;accent-color:#ffcc00;">
            <span>Invert alarm entity</span>
          </label>
          <div style="font-size:11px;color:#777;margin-top:3px;">When checked: entity OFF = Armed, ON = Disarmed</div>
        </div>
        <div class="settings-field">
          <label>Label when armed</label>
          <input type="text" id="cfgLabelArmed" value="${escapeHtml(uiConfig.alarm_label_armed || "Armed")}"
            placeholder="Armed" style="max-width:160px;">
        </div>
        <div class="settings-field">
          <label>Label when disarmed</label>
          <input type="text" id="cfgLabelDisarmed" value="${escapeHtml(uiConfig.alarm_label_disarmed || "Disarmed")}"
            placeholder="Disarmed" style="max-width:160px;">
        </div>
      </div>

      <!-- ══ DISPLAY ══════════════════════════════════════════ -->
      <div class="settings-section">
        <div class="settings-section-title">Display</div>
        <div class="settings-field">
          <label>Sidebar Position</label>
          <div class="settings-toggle-row">
            <button class="settings-toggle ${uiConfig.sidebar_position !== "left" ? "active" : ""}" id="sidebarRight">Right</button>
            <button class="settings-toggle ${uiConfig.sidebar_position === "left" ? "active" : ""}" id="sidebarLeft">Left</button>
          </div>
        </div>
        <div class="settings-field">
          <label>Floor Plan Image</label>
          <div class="settings-floorplan-row">
            <input type="text" id="cfgFloorplan" value="${escapeHtml(uiConfig.floorplan || "img/floorplan.png")}" placeholder="img/floorplan.png">
            <label class="settings-upload-btn" title="Upload new floor plan">
              ↑
              <input type="file" id="cfgFloorplanUpload" accept="image/*" style="display:none;">
            </label>
          </div>
          <div id="floorplanUploadStatus" style="font-size:11px;color:#888;margin-top:4px;"></div>
        </div>
      </div>

      <!-- ══ ZONE BEHAVIOUR ═══════════════════════════════════ -->
      <div class="settings-section">
        <div class="settings-section-title">Zone Behaviour</div>
        <div class="settings-field">
          <label>Zone fade-out duration (seconds)</label>
          <input type="number" id="cfgFadeDuration" value="${uiConfig.zone_fade_duration ?? 3}" min="0" max="30" step="0.5"
            style="width:80px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;color:#fff;padding:6px 8px;font-size:13px;outline:none;">
          <div style="font-size:11px;color:#777;margin-top:3px;">How long a zone takes to fade out after its trigger clears. Set 0 to disable.</div>
        </div>
      </div>

      <!-- ══ ZONE COLOURS ═════════════════════════════════════ -->
      <div class="settings-section">
        <div class="settings-section-title">Zone Colours — Alarm Armed</div>
        <div style="font-size:11px;color:#888;margin-bottom:6px;">Colours when alarm system is armed/triggered</div>
        <div class="settings-color-grid">
          <div class="settings-color-item"><label>Person</label><input type="color" id="cfgColOnPerson" value="${uiConfig.color_on_person || "#ff3b30"}"></div>
          <div class="settings-color-item"><label>Motion</label><input type="color" id="cfgColOnMotion" value="${uiConfig.color_on_motion || "#ff9500"}"></div>
          <div class="settings-color-item"><label>Door</label><input type="color" id="cfgColOnDoor" value="${uiConfig.color_on_door || "#ff6b35"}"></div>
          <div class="settings-color-item"><label>Window</label><input type="color" id="cfgColOnWindow" value="${uiConfig.color_on_window || "#ff9f0a"}"></div>
          <div class="settings-color-item"><label>Animal</label><input type="color" id="cfgColOnAnimal" value="${uiConfig.color_on_animal || "#ff6b00"}"></div>
          <div class="settings-color-item"><label>Vehicle</label><input type="color" id="cfgColOnVehicle" value="${uiConfig.color_on_vehicle || "#ff3b80"}"></div>
          <div class="settings-color-item"><label>Smoke</label><input type="color" id="cfgColOnSmoke" value="${uiConfig.color_on_smoke || "#ff2d55"}"></div>
          <div class="settings-color-item"><label>CO / Gas</label><input type="color" id="cfgColOnCo" value="${uiConfig.color_on_co || "#bf5af2"}"></div>
        </div>
        <div class="settings-section-title" style="margin-top:12px;">Zone Colours — Alarm Disarmed</div>
        <div style="font-size:11px;color:#888;margin-bottom:6px;">Colours when alarm is disarmed but sensor is active</div>
        <div class="settings-color-grid">
          <div class="settings-color-item"><label>Person</label><input type="color" id="cfgColOffPerson" value="${uiConfig.color_off_person || "#4cd964"}"></div>
          <div class="settings-color-item"><label>Motion</label><input type="color" id="cfgColOffMotion" value="${uiConfig.color_off_motion || "#5ac8fa"}"></div>
          <div class="settings-color-item"><label>Door</label><input type="color" id="cfgColOffDoor" value="${uiConfig.color_off_door || "#ffcc00"}"></div>
          <div class="settings-color-item"><label>Window</label><input type="color" id="cfgColOffWindow" value="${uiConfig.color_off_window || "#ffcc00"}"></div>
          <div class="settings-color-item"><label>Animal</label><input type="color" id="cfgColOffAnimal" value="${uiConfig.color_off_animal || "#aad400"}"></div>
          <div class="settings-color-item"><label>Vehicle</label><input type="color" id="cfgColOffVehicle" value="${uiConfig.color_off_vehicle || "#00c7be"}"></div>
          <div class="settings-color-item"><label>Smoke</label><input type="color" id="cfgColOffSmoke" value="${uiConfig.color_off_smoke || "#ff6b6b"}"></div>
          <div class="settings-color-item"><label>CO / Gas</label><input type="color" id="cfgColOffCo" value="${uiConfig.color_off_co || "#cc73f8"}"></div>
        </div>
      </div>

      <!-- ══ SAVE ═════════════════════════════════════════════ -->
      <div class="settings-section">
        <button class="settings-btn" id="settingsSaveYamlBtn">Save Settings</button>
        <div id="yamlSaveStatus" style="font-size:11px;color:#888;margin-top:6px;text-align:center;"></div>
      </div>

    </div>
  `;

  document.body.appendChild(panel);

  // Make settings panel draggable (issue 9)
  const settingsTitlebarEl = panel.querySelector(".settings-titlebar");
  makeDraggable(panel, settingsTitlebarEl, "settingsPanel");

  document.getElementById("settingsCloseBtn").onclick = () => panel.classList.remove("open");
  panel.addEventListener("pointerdown", e => e.stopPropagation());

  // Alarm entity live search
  const alarmEntityInput   = document.getElementById("cfgAlarmEntity");
  const alarmEntityResults = document.getElementById("alarmEntityResults");
  if (alarmEntityInput && alarmEntityResults) {
    alarmEntityInput.oninput = () => {
      const q = alarmEntityInput.value.trim().toLowerCase();
      if (!q || !haConnected || !Object.keys(haStates).length) {
        alarmEntityResults.style.display = "none";
        return;
      }
      const hits = Object.keys(haStates)
        .filter(id => id.toLowerCase().includes(q))
        .slice(0, 20)
        .map(id => ({ id, state: haStates[id]?.state || "—", friendly: haStates[id]?.attributes?.friendly_name || "" }));
      if (!hits.length) { alarmEntityResults.style.display = "none"; return; }
      alarmEntityResults.innerHTML = hits.map(h => `
        <div class="entity-search-result" data-entity-id="${escapeHtml(h.id)}">
          <span class="entity-search-id">${escapeHtml(h.id)}</span>
          <span class="entity-search-state">${escapeHtml(h.state)}</span>
          ${h.friendly ? `<span class="entity-search-friendly">${escapeHtml(h.friendly)}</span>` : ""}
        </div>`).join("");
      alarmEntityResults.style.display = "block";
      alarmEntityResults.querySelectorAll(".entity-search-result").forEach(el => {
        el.onclick = () => {
          alarmEntityInput.value = el.dataset.entityId;
          alarmEntityResults.style.display = "none";
          updateYamlSnippet();
        };
      });
    };
    document.addEventListener("pointerdown", function hideAlarmResults(e) {
      if (!alarmEntityInput.contains(e.target) && !alarmEntityResults.contains(e.target)) {
        alarmEntityResults.style.display = "none";
        document.removeEventListener("pointerdown", hideAlarmResults);
      }
    });
  }

  // Sidebar position toggles
  const sidebarRightBtn = document.getElementById("sidebarRight");
  const sidebarLeftBtn = document.getElementById("sidebarLeft");
  if (sidebarRightBtn) sidebarRightBtn.onclick = () => {
    uiConfig.sidebar_position = "right";
    applyConfig();
    updateExpandBtn(uiConfig.sidebar_collapsed);
    sidebarRightBtn.classList.add("active");
    sidebarLeftBtn.classList.remove("active");
    updateYamlSnippet();
  };
  if (sidebarLeftBtn) sidebarLeftBtn.onclick = () => {
    uiConfig.sidebar_position = "left";
    applyConfig();
    updateExpandBtn(uiConfig.sidebar_collapsed);
    sidebarLeftBtn.classList.add("active");
    sidebarRightBtn.classList.remove("active");
    updateYamlSnippet();
  };

  // Floorplan upload
  const uploadInput = document.getElementById("cfgFloorplanUpload");
  const uploadStatus = document.getElementById("floorplanUploadStatus");
  if (uploadInput) {
    uploadInput.onchange = async () => {
      const file = uploadInput.files[0];
      if (!file) return;
      uploadStatus.textContent = "Uploading…";
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(apiPath("ow/upload-floorplan"), { method: "POST", body: form });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const path = data.path || ("img/" + file.name);
          document.getElementById("cfgFloorplan").value = path;
          uiConfig.floorplan = path;
          const fp = document.getElementById("floorplanImage");
          if (fp) {
            fp.src = apiPath(path) + "?v=" + Date.now();
            fp.dataset.loaded = "1";
            fp.onload = initFloorplan;
          }
          uploadStatus.textContent = "✓ Uploaded: " + path;
          uploadStatus.style.color = "#32d74b";
          // Auto-save so other browsers pick up the new floorplan
          try {
            await fetch(apiPath("ow/save-config"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filename: "config/ui.yaml", content: buildYamlContent() })
            });
          } catch { /* non-fatal */ }
        } else {
          uploadStatus.textContent = "✗ Upload failed (server returned " + res.status + ")";
          uploadStatus.style.color = "#ff3b30";
        }
      } catch (err) {
        uploadStatus.textContent = "✗ Upload error: " + err.message;
        uploadStatus.style.color = "#ff3b30";
      }
      updateYamlSnippet();
    };
  }

  const cfgFloorplanInput = document.getElementById("cfgFloorplan");
  if (cfgFloorplanInput) {
    cfgFloorplanInput.oninput = () => updateYamlSnippet();
    cfgFloorplanInput.onblur = () => {
      uiConfig.floorplan = cfgFloorplanInput.value.trim();
      const fp = document.getElementById("floorplanImage");
      if (fp && uiConfig.floorplan) {
        fp.src = apiPath(uiConfig.floorplan) + "?v=" + Date.now();
        fp.dataset.loaded = "1";
        fp.onload = initFloorplan;
      }
    };
  }

  // Build the full ui.yaml content from current settings fields
  function buildYamlContent() {
    const g = id => document.getElementById(id)?.value || "";
    const inverted = document.getElementById("cfgAlarmInverted")?.checked ?? false;
    // Use actual current values for ha_url and ha_token (from uiConfig, not fields that may be hidden)
    const haUrl   = isAddonMode ? (uiConfig.ha_url || "") : (g("cfgHaUrl") || uiConfig.ha_url || "");
    const haToken = g("cfgHaToken") || uiConfig.ha_token || "";
    return (
      `ui:\n` +
      `  ha_url: "${haUrl}"\n` +
      `  ha_token: "${haToken}"\n` +
      `  alarm_entity: "${g("cfgAlarmEntity") || uiConfig.alarm_entity || ""}"\n` +
      `  alarm_entity_inverted: ${inverted}\n` +
      `  alarm_label_armed: "${g("cfgLabelArmed") || uiConfig.alarm_label_armed || "Armed"}"\n` +
      `  alarm_label_disarmed: "${g("cfgLabelDisarmed") || uiConfig.alarm_label_disarmed || "Disarmed"}"\n` +
      `  sidebar_position: "${uiConfig.sidebar_position}"\n` +
      `  floorplan: "${g("cfgFloorplan") || uiConfig.floorplan || "img/floorplan.png"}"\n` +
      `  zone_fade_duration: ${document.getElementById("cfgFadeDuration")?.value ?? uiConfig.zone_fade_duration ?? 3}\n` +
      `  # Alarm armed colours\n` +
      `  color_on_person: "${g("cfgColOnPerson") || uiConfig.color_on_person}"\n` +
      `  color_on_motion: "${g("cfgColOnMotion") || uiConfig.color_on_motion}"\n` +
      `  color_on_door: "${g("cfgColOnDoor") || uiConfig.color_on_door}"\n` +
      `  color_on_window: "${g("cfgColOnWindow") || uiConfig.color_on_window}"\n` +
      `  color_on_animal: "${g("cfgColOnAnimal") || uiConfig.color_on_animal}"\n` +
      `  color_on_vehicle: "${g("cfgColOnVehicle") || uiConfig.color_on_vehicle}"\n` +
      `  color_on_smoke: "${g("cfgColOnSmoke") || uiConfig.color_on_smoke}"\n` +
      `  color_on_co: "${g("cfgColOnCo") || uiConfig.color_on_co}"\n` +
      `  # Alarm disarmed colours\n` +
      `  color_off_person: "${g("cfgColOffPerson") || uiConfig.color_off_person}"\n` +
      `  color_off_motion: "${g("cfgColOffMotion") || uiConfig.color_off_motion}"\n` +
      `  color_off_door: "${g("cfgColOffDoor") || uiConfig.color_off_door}"\n` +
      `  color_off_window: "${g("cfgColOffWindow") || uiConfig.color_off_window}"\n` +
      `  color_off_animal: "${g("cfgColOffAnimal") || uiConfig.color_off_animal}"\n` +
      `  color_off_vehicle: "${g("cfgColOffVehicle") || uiConfig.color_off_vehicle}"\n` +
      `  color_off_smoke: "${g("cfgColOffSmoke") || uiConfig.color_off_smoke}"\n` +
      `  color_off_co: "${g("cfgColOffCo") || uiConfig.color_off_co}"\n`
    );
  }

  // No-op stub so existing callers of updateYamlSnippet don't throw
  const updateYamlSnippet = () => {};
  updateYamlSnippet();

  // ── Connect to Home Assistant button ──────────────────────────
  const connectBtn    = document.getElementById("settingsSaveHaBtn");
  const tokenField    = document.getElementById("cfgHaToken");
  const connectStatus = document.getElementById("haConnectStatus");

  // Re-enable button when user types a new token
  if (tokenField && connectBtn) {
    tokenField.addEventListener("input", () => {
      const hasInput = tokenField.value.trim().length > 0;
      connectBtn.style.opacity = "1";
      connectBtn.textContent = "Connect to Home Assistant";
      if (haConnected && hasInput && connectStatus) {
        connectStatus.textContent = "⚠ This will replace your working connection.";
        connectStatus.style.color = "#ff9500";
      } else if (connectStatus) {
        connectStatus.textContent = "";
      }
    });
  }

  if (connectBtn) {
    connectBtn.onclick = async () => {
      const newToken = tokenField?.value.trim() || "";

      // Don't overwrite a saved token with nothing
      if (!newToken && !uiConfig.ha_token) {
        if (connectStatus) { connectStatus.textContent = "✗ Enter a Long-Lived Access Token first."; connectStatus.style.color = "#ff3b30"; }
        return;
      }

      if (!isAddonMode && document.getElementById("cfgHaUrl")) {
        uiConfig.ha_url = document.getElementById("cfgHaUrl").value.trim() || uiConfig.ha_url;
      }
      if (newToken) uiConfig.ha_token = newToken;  // only update if new token entered

      // Save token to disk immediately
      try {
        await fetch(apiPath("ow/save-config"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: "config/ui.yaml", content: buildYamlContent() })
        });
        if (connectStatus) { connectStatus.textContent = "✓ Token saved — connecting…"; connectStatus.style.color = "#32d74b"; }
      } catch (e) {
        if (connectStatus) { connectStatus.textContent = "⚠ Token saved in memory only."; connectStatus.style.color = "#ff9500"; }
      }

      if (haSocket) { haSocket.onclose = null; haSocket.close(); haSocket = null; haConnected = false; }
      if (connectBtn) { connectBtn.style.opacity = "0.5"; connectBtn.textContent = "Connecting…"; }
      connectHA();
      panel.classList.remove("open");
    };
  }

  // ── Save Settings button (all settings except HA token/URL) ───
  // Colours are applied live by readng fields; the Save button persists everything

  const saveYamlBtn    = document.getElementById("settingsSaveYamlBtn");
  const yamlSaveStatus = document.getElementById("yamlSaveStatus");
  if (saveYamlBtn) {
    saveYamlBtn.onclick = async () => {
      const g = id => document.getElementById(id)?.value;

      // Apply all non-HA settings to uiConfig
      uiConfig.alarm_entity         = document.getElementById("cfgAlarmEntity")?.value.trim() || uiConfig.alarm_entity;
      uiConfig.alarm_entity_inverted = document.getElementById("cfgAlarmInverted")?.checked ?? uiConfig.alarm_entity_inverted;
      uiConfig.alarm_label_armed    = document.getElementById("cfgLabelArmed")?.value.trim()    || uiConfig.alarm_label_armed;
      uiConfig.alarm_label_disarmed = document.getElementById("cfgLabelDisarmed")?.value.trim() || uiConfig.alarm_label_disarmed;
      const fd = parseFloat(g("cfgFadeDuration"));
      if (!isNaN(fd)) uiConfig.zone_fade_duration = Math.max(0, fd);
      // Colours
      ["person","motion","door","window","animal","vehicle","smoke","co"].forEach(t => {
        const on  = g(`cfgColOn${t.charAt(0).toUpperCase()+t.slice(1)}`);
        const off = g(`cfgColOff${t.charAt(0).toUpperCase()+t.slice(1)}`);
        if (on)  uiConfig[`color_on_${t}`]  = on;
        if (off) uiConfig[`color_off_${t}`] = off;
      });
      applyConfig();
      renderZones();

      const content = buildYamlContent();
      yamlSaveStatus.textContent = "Saving…";
      yamlSaveStatus.style.color = "#888";
      try {
        const res = await fetch(apiPath("ow/save-config"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: "config/ui.yaml", content })
        });
        if (res.ok) {
          yamlSaveStatus.textContent = "✓ Settings saved";
          yamlSaveStatus.style.color = "#32d74b";
          logEvent("ok", "Settings saved to config/ui.yaml.", "system");
          lastConfigHash = "";
        } else {
          yamlSaveStatus.textContent = "✗ Save failed (HTTP " + res.status + ")";
          yamlSaveStatus.style.color = "#ff3b30";
        }
      } catch (err) {
        yamlSaveStatus.textContent = "✗ Cannot reach server: " + err.message;
        yamlSaveStatus.style.color = "#ff3b30";
      }
    };
  }
}

/* ─── SHARED DRAGGABLE UTILITY (issue 9) ─────────────────── */
// Makes any panel draggable by its titlebar.
// storageKey: optional localStorage key to persist position.
// Returns a function to re-apply saved position.
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
    const zid = (z.id || "").toLowerCase();
    const zname = (z.name || "").toLowerCase();
    if (zid.includes(query) || zname.includes(query)) {
      hits.push({ type: "zone", zoneId: z.id, title: z.name || z.id, sub: `Zone (${z.id})` });
    }
    for (const s of (z.sensors || [])) {
      if (String(s).toLowerCase().includes(query)) {
        hits.push({ type: "entity", zoneId: z.id, title: s, sub: `Entity in ${z.name || z.id}` });
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
    if (a.type !== b.type) return a.type === "zone" ? -1 : 1;
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
  highlightedUntil = Date.now() + 2500;
  renderZones();
  setTimeout(() => renderZones(), 2600);

  selectedZoneId = zoneId;
  if (editorMode) { renderZonesEditor(); renderZones(); }
  setSearchOpen(false);
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
    const collapsed   = localStorage.getItem(storageKey) === "collapsed";
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
    const collapsed   = localStorage.getItem(storageKey) === "collapsed";
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

  // Group header collapse toggle
  body.querySelectorAll(".status-dd-group-header").forEach(hdr => {
    hdr.addEventListener("click", e => {
      if (e.target.closest("button,input,label")) return;
      const gid = hdr.dataset.groupId;
      const key = hdr.dataset.storageKey;
      const membersEl = body.querySelector(`.status-dd-group-members[data-group-id="${gid}"]`);
      const chevron = hdr.querySelector(".status-dd-chevron");
      if (!membersEl) return;
      const collapsed = membersEl.style.display === "none";
      membersEl.style.display = collapsed ? "" : "none";
      if (chevron) chevron.style.transform = `rotate(${collapsed ? "0" : "-90"}deg)`;
      localStorage.setItem(key, collapsed ? "expanded" : "collapsed");
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
  const settingsBtn = document.getElementById("settingsBtn");
  const logBtn      = document.getElementById("logBtn");

  if (searchBtn)   searchBtn.onclick   = () => setSearchOpen(!searchOpen);
  if (settingsBtn) settingsBtn.onclick = () => renderSettingsPanel();
  if (logBtn)      logBtn.onclick      = () => renderLogPanel(true);

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

  function onLoad() {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return;

    // Size the wrapper and SVG to the image's natural pixel dimensions
    wrapper.style.width  = iw + "px";
    wrapper.style.height = ih + "px";
    svg.setAttribute("width",  iw);
    svg.setAttribute("height", ih);
    svg.setAttribute("viewBox", `0 0 ${iw} ${ih}`);

    // Fit to viewport if no saved zoom
    if (!localStorage.getItem("zoomScale")) {
      const vw = window.innerWidth, vh = window.innerHeight;
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
  await loadModule("sidebarContainer", "sidebar.html");
  // sidebar sanity: if module path is wrong, the whole UI looks missing
  if (!document.getElementById("sidebarEl")) {
    console.warn('[HA-Overwatch] sidebarEl not found after loadModule(sidebar.html). Check file location: /modules/sidebar.html vs /sidebar.html');
  }

  await loadModule("expandBtnContainer", "expand-btn.html");
  await loadModule("statusContainer", "status.html");
  await loadModule("zonesEditorContainer", "zones-editor.html");

  bindZoomControls();
  bindPan();
  initFloorplan();

  bindSidebarToggle();
  bindZonesButton();
  bindStatusBar();
  bindSearchUI();

  await loadZones();
  await loadGroups();
  bindZonesSvgEvents();
  renderZonesEditor();
  renderZones();
  await loadConfig();

  // Wait for the first health check to complete so isAddonMode is set
  // before connectHA() fires — prevents spurious standalone WS attempts
  await startServerHealthCheck();

  // Connect to HA — by now isAddonMode is known so the right path is taken
  if (!haConnected) connectHA();

  startLiveRefresh();
  logEvent("info", "HA-Overwatch initialised.", "system");

  // Subscribe entities once zones are loaded (if HA already connected)
  subscribeHAEntities();
}

window.addEventListener("DOMContentLoaded", init);
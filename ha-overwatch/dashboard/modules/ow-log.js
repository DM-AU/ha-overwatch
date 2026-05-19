/* ─── HA-Overwatch Log Module ─────────────────────────────────
 * Stable baseline: v1.551.36.09.
 *
 * Scope:
 * - Connection/event log state and rendering.
 * - Log panel search/filter/clear controls.
 * - Server health polling helpers.
 * - HA status badge and settings connection status helpers.
 *
 * Compatibility design:
 * - Classic browser script; load before app.js.
 * - Functions intentionally remain global.
 * - apiPath() remains in app.js.
 * - App globals are resolved at call time after app.js has loaded.
 *
 * Deliberately NOT included:
 * - Zone/camera status dropdown rendering. Those are due for redesign.
 */

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

// Debounced save toast — consolidates rapid saves (e.g. typing) into a single "Saved ✓"
let _saveToastTimer = null;
/* ─── TOAST HELPERS moved to modules/ow-toast.js ───────────────────────── */
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

let serverWasReachable = true;
let serverApiAvailable = null;   // null=unknown, true=server.js up, false=local-only
let serverCheckTimer   = null;
let isAddonMode        = false;  // true when running as HA add-on
let _serverBuildId     = null;   // detect server restarts for auto-reload on 8099
let _lastDataVersion   = null;   // detect data changes from other browsers

async function checkServerHealth() {
  try {
    const res  = await fetch(apiPath("ow/health"), { method: "GET", cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    const wasDown = serverApiAvailable === false || !serverWasReachable;
    serverWasReachable = true;
    serverApiAvailable = true;

    // Auto-reload on 8099 when server restarts (new buildId = new code deployed)
    if (!IS_DIRECT_MODE && data.buildId) {
      if (_serverBuildId === null) {
        _serverBuildId = data.buildId; // first check — store baseline
      } else if (_serverBuildId !== data.buildId) {
        logEvent("ok", "Server restarted — reloading page to pick up new code.", "system");
        setTimeout(() => window.location.reload(), 800);
        return;
      }
    }

    // Live data sync — reload zones/lights when another browser makes changes
    if (data.dataVersion && _lastDataVersion !== null && data.dataVersion !== _lastDataVersion) {
      logEvent("ok", "Config changed externally — refreshing zones and lights.", "system");
      await loadZones();
      await loadGroups();
      // Only reload floors if not in edit mode (floor reload resets zoom)
      if (!editorMode) await loadFloors();
      await loadLights();
      await loadSirens();
      await loadCameraPins();
      await loadDoorPins();
      if (haConnected) subscribeHAEntities();
      renderZones();
      if (editorMode) renderZonesEditor();
    }
    if (data.dataVersion) _lastDataVersion = data.dataVersion;

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

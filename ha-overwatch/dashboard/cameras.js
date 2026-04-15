(function () {
'use strict';

/* ================================================================
 * HA-Overwatch — cameras.js
 * Camera wall dashboard logic.
 * Reads shared state from window.OW (exported by app.js).
 * ================================================================ */

/* ── Constants ───────────────────────────────────────────────── */
const CAM_STORAGE_PREFIX    = 'ow_cam_';
const CAM_TOGGLE_PREFIX     = 'ow_cam_toggle_';   // per camera toggle
const CAM_ZONE_PREFIX       = 'ow_cam_zone_';     // per zone toggle
const CAM_GLOBAL_KEY        = 'ow_cam_global';    // global all-cameras toggle

/* ── Module state ────────────────────────────────────────────── */
let camMode        = 'snapshot';   // 'snapshot' | 'live'
let camPinned      = new Set();    // Set of pinned camera entity ids
let camToggled     = {};           // { entityId: bool } — false = user disabled
let camZoneToggled = {};           // { zoneId: bool } — false = zone disabled on cam page
let camCooldowns   = {};           // { entityId: { until: timestamp, zoneId } }
let camFailCount   = {};           // { entityId: consecutiveFailures }
let camHidden      = new Set();    // cameras hidden due to persistent failure
let camLastTrigger = {};           // { entityId: timestamp }
let camLowResMap   = {};           // { highResId: lowResId }
let camMaxVisible  = 0;
let camSnapshotTimer = null;
let camStatusOpen  = true;         // camera status bar open/closed
let camModalOpen   = false;
let camModalEntityId = null;
let camModalMode   = 'live';       // modal display mode
let camStatusBody  = null;

/* ── Wait for OW to be ready ────────────────────────────────── */
function waitForOW(cb, attempts = 0) {
  if (window.OW && window.OW.zones !== undefined) { cb(); return; }
  if (attempts > 50) { console.error('[CAM] window.OW never ready'); return; }
  setTimeout(() => waitForOW(cb, attempts + 1), 100);
}

/* ── HA camera snapshot URL ─────────────────────────────────── */
function camSnapshotUrl(entityId) {
  // Use relative URL — the <base> tag injected by server.js resolves it
  // correctly through HA ingress automatically.
  // In standalone mode, fall back to ha_url.
  if (window.OW.isAddonMode) {
    return `api/camera_proxy/${entityId}?t=${Date.now()}`;
  }
  const haUrl = (window.OW.uiConfig.ha_url || '').replace(/\/$/, '');
  return `${haUrl}/api/camera_proxy/${entityId}?t=${Date.now()}`;
}

function camStreamUrl(entityId) {
  if (window.OW.isAddonMode) {
    return `api/camera_proxy_stream/${entityId}`;
  }
  const haUrl = (window.OW.uiConfig.ha_url || '').replace(/\/$/, '');
  return `${haUrl}/api/camera_proxy_stream/${entityId}`;
}

/* ── Tile entity resolution ──────────────────────────────────── */
function tileEntityFor(highResId) {
  return camLowResMap[highResId] || highResId;
}

function friendlyName(entityId) {
  const st = window.OW.haStates[entityId];
  return st?.attributes?.friendly_name || entityId.split('.').pop().replace(/_/g, ' ');
}

/* ── Compute active cameras ─────────────────────────────────── */
function getActiveCameras() {
  const OW    = window.OW;
  const zones = OW.zones;
  const now   = Date.now();
  const cfg   = OW.uiConfig;

  // Parse config
  camMaxVisible = parseInt(cfg.cam_max_visible) || 0;
  try { camLowResMap = JSON.parse(cfg.cam_low_res_map || '{}'); } catch {}
  try {
    const pins = JSON.parse(cfg.cam_pinned || '[]');
    camPinned = new Set(pins);
  } catch {}

  const cooldownMs = (parseInt(cfg.cam_cooldown) || 30) * 1000;
  const failHideMs = (parseInt(cfg.cam_fail_hide_seconds) || 5) * 1000;

  // Global toggle check
  const globalOn = localStorage.getItem(CAM_GLOBAL_KEY) !== 'false';
  if (!globalOn) return [];

  const cameraSet = new Map(); // entityId → { lastTrigger, fromZone }

  // Add from triggered zones (with cooldown)
  zones.forEach(zone => {
    // Zone-level toggle
    const zoneOn = localStorage.getItem(CAM_ZONE_PREFIX + zone.id) !== 'false';
    if (!zoneOn) return;

    const sensors   = zone.sensors || [];
    const triggered = sensors.some(OW.isEntityTriggered);
    const cameras   = zone.cameras || [];
    if (!cameras.length) return;

    cameras.forEach(entityId => {
      // Per-camera toggle
      const camOn = localStorage.getItem(CAM_TOGGLE_PREFIX + entityId) !== 'false';
      if (!camOn) return;
      if (camHidden.has(entityId)) return;

      if (triggered) {
        // Mark/extend cooldown
        const until = now + cooldownMs;
        camCooldowns[entityId] = { until, zoneId: zone.id };
        camLastTrigger[entityId] = now;
        cameraSet.set(entityId, { lastTrigger: now, fromZone: zone.id });
      } else if (camCooldowns[entityId] && camCooldowns[entityId].until > now) {
        // Still in cooldown
        const lt = camLastTrigger[entityId] || 0;
        cameraSet.set(entityId, { lastTrigger: lt, fromZone: zone.id });
      }
    });
  });

  // Add pinned cameras (always show if toggled on)
  camPinned.forEach(entityId => {
    const camOn = localStorage.getItem(CAM_TOGGLE_PREFIX + entityId) !== 'false';
    if (!camOn) return;
    if (camHidden.has(entityId)) return;
    if (!cameraSet.has(entityId)) {
      cameraSet.set(entityId, { lastTrigger: 0, fromZone: null, pinned: true });
    }
  });

  // Sort
  const sortOrder = cfg.cam_sort_order || 'recent_first';
  let list = [...cameraSet.entries()].map(([id, meta]) => ({ id, ...meta }));
  list.sort((a, b) => sortOrder === 'recent_first'
    ? b.lastTrigger - a.lastTrigger
    : a.lastTrigger - b.lastTrigger
  );

  // Apply max visible limit
  if (camMaxVisible > 0) list = list.slice(0, camMaxVisible);

  return list;
}

/* ── Mosaic layout ───────────────────────────────────────────── */
function computeGrid(n) {
  if (n <= 0) return { cols: 1, rows: 1 };
  if (n === 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 2, rows: 2 };
  if (n === 4) return { cols: 2, rows: 2 };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

/* ── Render camera grid ─────────────────────────────────────── */
function renderCameraGrid() {
  const grid   = document.getElementById('cameraGrid');
  const empty  = document.getElementById('cameraEmpty');
  if (!grid) return;

  const cameras = getActiveCameras();
  const cfg     = window.OW.uiConfig;
  const snap    = (cfg.cam_default_mode || 'snapshot') === 'snapshot';
  camMode       = snap ? 'snapshot' : 'live';

  if (cameras.length === 0) {
    grid.style.display  = 'none';
    if (empty) empty.style.display = 'flex';
    return;
  }

  grid.style.display  = '';
  if (empty) empty.style.display = 'none';

  const { cols, rows } = computeGrid(cameras.length);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;

  // Build a set of current ids
  const currentIds = new Set(cameras.map(c => c.id));

  // Remove tiles no longer active
  [...grid.querySelectorAll('.cam-tile')].forEach(tile => {
    if (!currentIds.has(tile.dataset.entityId)) tile.remove();
  });

  // Add or update tiles
  cameras.forEach(cam => {
    const tileId   = `cam-tile-${cam.id.replace(/\W/g, '_')}`;
    const tileEntity = tileEntityFor(cam.id);
    let tile = document.getElementById(tileId);

    if (!tile) {
      tile = document.createElement('div');
      tile.className        = 'cam-tile';
      tile.id               = tileId;
      tile.dataset.entityId = cam.id;

      const label = document.createElement('div');
      label.className = 'cam-tile-label';
      label.textContent = friendlyName(cam.id);

      const media = document.createElement('div');
      media.className = 'cam-tile-media';

      if (camMode === 'live') {
        const img = document.createElement('img');
        img.className = 'cam-tile-img';
        img.src = camStreamUrl(tileEntity);
        img.alt = '';
        attachFailureHandler(img, cam.id);
        media.appendChild(img);
      } else {
        const img = document.createElement('img');
        img.className = 'cam-tile-img';
        img.src = camSnapshotUrl(tileEntity);
        img.alt = '';
        attachFailureHandler(img, cam.id);
        media.appendChild(img);
      }

      if (cam.pinned) {
        const pin = document.createElement('div');
        pin.className = 'cam-tile-pin';
        pin.title = 'Pinned camera';
        pin.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L8 9H3l7.5 6-3 7L12 18l4.5 4-3-7L21 9h-5z"/></svg>`;
        tile.appendChild(pin);
      }

      tile.appendChild(label);
      tile.appendChild(media);

      tile.addEventListener('click', () => openCameraModal(cam.id));
      grid.appendChild(tile);
    } else {
      // Update label in case friendly name changed
      const label = tile.querySelector('.cam-tile-label');
      if (label) label.textContent = friendlyName(cam.id);
    }
  });
}

/* ── Snapshot refresh ───────────────────────────────────────── */
function startSnapshotRefresh() {
  stopSnapshotRefresh();
  const interval = (parseInt(window.OW.uiConfig.cam_snapshot_interval) || 2) * 1000;
  camSnapshotTimer = setInterval(() => {
    if (camMode !== 'snapshot') return;
    document.querySelectorAll('.cam-tile-img').forEach(img => {
      const tile     = img.closest('.cam-tile');
      if (!tile) return;
      const entityId = tile.dataset.entityId;
      const tileEnt  = tileEntityFor(entityId);
      img.src = camSnapshotUrl(tileEnt);
    });
    // Refresh modal if open and in snapshot mode
    if (camModalOpen && camModalMode === 'snapshot') {
      const modalImg = document.getElementById('camModalImg');
      if (modalImg && camModalEntityId) {
        modalImg.src = camSnapshotUrl(tileEntityFor(camModalEntityId));
      }
    }
  }, interval);
}

function stopSnapshotRefresh() {
  if (camSnapshotTimer) { clearInterval(camSnapshotTimer); camSnapshotTimer = null; }
}

/* ── Failure handling ───────────────────────────────────────── */
function attachFailureHandler(img, entityId) {
  let failStart = null;
  const failHide = (parseInt(window.OW.uiConfig.cam_fail_hide_seconds) || 5) * 1000;

  img.onerror = () => {
    if (!failStart) failStart = Date.now();
    if (Date.now() - failStart >= failHide) {
      camHidden.add(entityId);
      window.OW.logEvent('error', `Camera hidden after persistent failure: ${entityId}`, 'system');
      const tile = document.getElementById(`cam-tile-${entityId.replace(/\W/g, '_')}`);
      if (tile) tile.remove();
    } else {
      // Retry after 1s
      setTimeout(() => { img.src = img.src; }, 1000);
    }
  };
  img.onload = () => { failStart = null; };
}

/* ── Modal ───────────────────────────────────────────────────── */
function openCameraModal(entityId) {
  camModalOpen    = true;
  camModalEntityId = entityId;
  camModalMode    = (window.OW.uiConfig.cam_default_mode || 'snapshot') === 'live' ? 'live' : 'snapshot';

  const modal   = document.getElementById('cameraModal');
  const title   = document.getElementById('camModalTitle');
  const modeBtn = document.getElementById('camModalModeBtn');
  const pinBtn  = document.getElementById('camModalPinBtn');
  const img     = document.getElementById('camModalImg');

  if (!modal) return;

  title.textContent = friendlyName(entityId);
  updateModalMode(img, modeBtn, entityId);
  pinBtn.textContent = camPinned.has(entityId) ? '📌 Unpin' : '📌 Pin';

  modal.style.display = 'flex';
}

function updateModalMode(img, modeBtn, entityId) {
  const highResId = entityId; // modal always uses high-res
  modeBtn.textContent = camModalMode === 'live' ? 'Live' : 'Snapshot';
  if (camModalMode === 'live') {
    img.src = camStreamUrl(highResId);
  } else {
    img.src = camSnapshotUrl(highResId);
  }
}

function closeCameraModal() {
  camModalOpen     = false;
  camModalEntityId = null;
  const modal = document.getElementById('cameraModal');
  if (modal) modal.style.display = 'none';
  const img = document.getElementById('camModalImg');
  if (img) img.src = '';
}

/* ── Camera status bar ───────────────────────────────────────── */
function renderCameraStatusBar() {
  const container = document.getElementById('cameraStatusContainer');
  if (!container) return;

  const OW    = window.OW;
  const zones = OW.zones;
  const globalOn = localStorage.getItem(CAM_GLOBAL_KEY) !== 'false';

  // Build zone/camera tree for the dropdown
  const zonesWithCameras = zones.filter(z => (z.cameras || []).length > 0);

  let dropdownHtml = `
    <div class="cam-status-dd" id="camStatusDd" style="display:${camStatusOpen ? 'block' : 'none'};">
      <div class="cam-status-master">
        <span style="flex:1;font-size:11px;font-weight:600;color:#aaa;">All Cameras</span>
        <label class="zone-toggle-switch" style="flex-shrink:0;">
          <input type="checkbox" id="camGlobalToggle" ${globalOn ? 'checked' : ''}>
          <span class="zone-toggle-track"></span>
        </label>
      </div>
      <div style="height:1px;background:rgba(255,255,255,0.06);margin:0 14px 4px;"></div>`;

  if (zonesWithCameras.length === 0) {
    dropdownHtml += `<div class="cam-status-empty">No cameras configured in zones</div>`;
  } else {
    zonesWithCameras.forEach(zone => {
      const zoneOn = localStorage.getItem(CAM_ZONE_PREFIX + zone.id) !== 'false';
      dropdownHtml += `
        <div class="cam-status-zone-header">
          <div class="zone-list-dot" style="background:${zone.colorHex || '#0096ff'};width:8px;height:8px;border-radius:50%;flex-shrink:0;"></div>
          <span style="flex:1;font-size:12px;color:#ccc;">${escapeHtml(zone.name || zone.id)}</span>
          <label class="zone-toggle-switch" style="flex-shrink:0;">
            <input type="checkbox" class="cam-zone-toggle" data-zone-id="${zone.id}" ${zoneOn ? 'checked' : ''}>
            <span class="zone-toggle-track"></span>
          </label>
        </div>`;

      (zone.cameras || []).forEach(camId => {
        const camOn = localStorage.getItem(CAM_TOGGLE_PREFIX + camId) !== 'false';
        const isPinned = camPinned.has(camId);
        dropdownHtml += `
          <div class="cam-status-cam-row">
            <div style="width:6px;height:6px;border-radius:50%;background:#555;flex-shrink:0;margin-left:8px;"></div>
            <span style="flex:1;font-size:11px;color:#aaa;">${escapeHtml(friendlyName(camId))}</span>
            ${isPinned ? `<span style="font-size:9px;color:#ff9500;margin-right:4px;">PIN</span>` : ''}
            <label class="zone-toggle-switch" style="flex-shrink:0;">
              <input type="checkbox" class="cam-entity-toggle" data-cam-id="${camId}" ${camOn ? 'checked' : ''}>
              <span class="zone-toggle-track"></span>
            </label>
          </div>`;
      });
    });

    // Pinned cameras not in any zone
    camPinned.forEach(camId => {
      const inZone = zones.some(z => (z.cameras || []).includes(camId));
      if (inZone) return;
      const camOn = localStorage.getItem(CAM_TOGGLE_PREFIX + camId) !== 'false';
      dropdownHtml += `
        <div class="cam-status-zone-header" style="border-top:1px solid rgba(255,255,255,0.04);">
          <span style="flex:1;font-size:11px;color:#666;">Pinned (no zone)</span>
        </div>
        <div class="cam-status-cam-row">
          <div style="width:6px;height:6px;border-radius:50%;background:#ff9500;flex-shrink:0;margin-left:8px;"></div>
          <span style="flex:1;font-size:11px;color:#aaa;">${escapeHtml(friendlyName(camId))}</span>
          <span style="font-size:9px;color:#ff9500;margin-right:4px;">PIN</span>
          <label class="zone-toggle-switch" style="flex-shrink:0;">
            <input type="checkbox" class="cam-entity-toggle" data-cam-id="${camId}" ${camOn ? 'checked' : ''}>
            <span class="zone-toggle-track"></span>
          </label>
        </div>`;
    });
  }

  dropdownHtml += `</div>`;

  // Put mode buttons on opposite side from sidebar
  const sidebarOnRight = (window.OW.uiConfig.sidebar_position || 'right') !== 'left';
  const modeButtons = `
    <div class="cam-status-mode" style="${sidebarOnRight ? 'margin-right:auto;' : 'margin-left:auto;'}">
      <button class="cam-mode-btn ${camMode === 'snapshot' ? 'active' : ''}" id="camSnapBtn">Snapshot</button>
      <button class="cam-mode-btn ${camMode === 'live' ? 'active' : ''}" id="camLiveBtn">Live</button>
    </div>`;

  container.innerHTML = `
    <div class="cam-status-bar" id="camStatusBar">
      ${sidebarOnRight ? modeButtons : ''}
      <div class="cam-status-inner" id="camStatusToggle">
        <div class="cam-status-dot ${globalOn ? 'active' : ''}"></div>
        <span class="cam-status-label">${globalOn ? 'Cameras Active' : 'Cameras Off'}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="opacity:0.5;margin-left:4px;transition:transform 0.2s;transform:rotate(${camStatusOpen ? '180' : '0'}deg)">
          <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      ${!sidebarOnRight ? modeButtons : ''}
    </div>
    ${dropdownHtml}
  `;

  // Bind events
  document.getElementById('camStatusToggle')?.addEventListener('click', () => {
    camStatusOpen = !camStatusOpen;
    renderCameraStatusBar();
  });

  document.getElementById('camGlobalToggle')?.addEventListener('change', e => {
    localStorage.setItem(CAM_GLOBAL_KEY, e.target.checked ? 'true' : 'false');
    renderCameraStatusBar();
    renderCameraGrid();
  });

  document.querySelectorAll('.cam-zone-toggle').forEach(chk => {
    chk.addEventListener('change', e => {
      localStorage.setItem(CAM_ZONE_PREFIX + e.target.dataset.zoneId, e.target.checked ? 'true' : 'false');
      renderCameraGrid();
    });
  });

  document.querySelectorAll('.cam-entity-toggle').forEach(chk => {
    chk.addEventListener('change', e => {
      localStorage.setItem(CAM_TOGGLE_PREFIX + e.target.dataset.camId, e.target.checked ? 'true' : 'false');
      renderCameraGrid();
    });
  });

  document.getElementById('camSnapBtn')?.addEventListener('click', () => {
    camMode = 'snapshot';
    // Re-render all tiles with snapshot images
    const grid = document.getElementById('cameraGrid');
    if (grid) grid.innerHTML = '';
    renderCameraGrid();
    startSnapshotRefresh();
    renderCameraStatusBar();
  });

  document.getElementById('camLiveBtn')?.addEventListener('click', () => {
    camMode = 'live';
    stopSnapshotRefresh();
    // Re-render tiles with live streams
    const grid = document.getElementById('cameraGrid');
    if (grid) grid.innerHTML = '';
    renderCameraGrid();
    renderCameraStatusBar();
  });
}

/* ── Utility ─────────────────────────────────────────────────── */
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Main update loop ────────────────────────────────────────── */
let camUpdateInterval = null;

function camUpdate() {
  renderCameraGrid();
}

/* ── Modal bindings ─────────────────────────────────────────── */
function bindModal() {
  document.getElementById('camModalClose')?.addEventListener('click', closeCameraModal);
  document.getElementById('camModalBackdrop')?.addEventListener('click', closeCameraModal);

  document.getElementById('camModalModeBtn')?.addEventListener('click', () => {
    camModalMode = camModalMode === 'live' ? 'snapshot' : 'live';
    const img     = document.getElementById('camModalImg');
    const modeBtn = document.getElementById('camModalModeBtn');
    if (img && modeBtn && camModalEntityId) updateModalMode(img, modeBtn, camModalEntityId);
  });

  document.getElementById('camModalPinBtn')?.addEventListener('click', () => {
    if (!camModalEntityId) return;
    const OW = window.OW;
    const pinBtn = document.getElementById('camModalPinBtn');
    if (camPinned.has(camModalEntityId)) {
      camPinned.delete(camModalEntityId);
      pinBtn.textContent = '📌 Pin';
    } else {
      camPinned.add(camModalEntityId);
      pinBtn.textContent = '📌 Unpin';
    }
    // Persist pinned list back to uiConfig
    OW.uiConfig.cam_pinned = JSON.stringify([...camPinned]);
    // Save to server
    fetch(OW.apiPath('ow/save-config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'config/ui.yaml', content: buildCamYamlPatch(OW.uiConfig) })
    }).catch(() => {});
    renderCameraStatusBar();
    renderCameraGrid();
  });
}

function buildCamYamlPatch(cfg) {
  // Only save camera-related keys (others are owned by app.js)
  return [
    `cam_default_mode: "${cfg.cam_default_mode || 'snapshot'}"`,
    `cam_snapshot_interval: ${cfg.cam_snapshot_interval || 2}`,
    `cam_cooldown: ${cfg.cam_cooldown || 30}`,
    `cam_max_visible: ${cfg.cam_max_visible || 0}`,
    `cam_sort_order: "${cfg.cam_sort_order || 'recent_first'}"`,
    `cam_fail_hide_seconds: ${cfg.cam_fail_hide_seconds || 5}`,
    `cam_low_res_map: '${cfg.cam_low_res_map || "{}"}'`,
    `cam_pinned: '${cfg.cam_pinned || "[]"}'`,
  ].join('\n');
}

/* ── Override sidebar loading for camera page ─────────────────── */
// app.js loads modules/sidebar.html by default.
// We hook after DOMContentLoaded once OW is ready to swap in camera sidebar.
function initCameraPage() {
  const OW = window.OW;

  // Load camera sidebar and rebind buttons after injection
  const sidebarContainer = document.getElementById('sidebarContainer');
  if (sidebarContainer) {
    fetch(`modules/camera-sidebar.html?v=${Date.now()}`)
      .then(r => r.text())
      .then(html => {
        sidebarContainer.innerHTML = html;
        // Rebind all sidebar controls now that the DOM exists
        window.bindSidebarToggle && window.bindSidebarToggle();
        // Rebind settings + log now that sidebar DOM exists
        const settingsBtn = document.getElementById('settingsBtn');
        const logBtn      = document.getElementById('logBtn');
        if (settingsBtn) settingsBtn.onclick = () => window.renderSettingsPanel && window.renderSettingsPanel();
        if (logBtn)      logBtn.onclick      = () => window.renderLogPanel    && window.renderLogPanel(true);
      });
  }

  // Remove floorplan-only containers from layout
  ['expandBtnContainer', 'zonesEditorContainer'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Parse config
  camMode = (OW.uiConfig.cam_default_mode || 'snapshot') === 'live' ? 'live' : 'snapshot';
  try { camLowResMap = JSON.parse(OW.uiConfig.cam_low_res_map || '{}'); } catch {}
  try { camPinned = new Set(JSON.parse(OW.uiConfig.cam_pinned || '[]')); } catch {}

  // Initial renders
  renderCameraStatusBar();
  renderCameraGrid();
  bindModal();

  // Start snapshot refresh if in snapshot mode
  if (camMode === 'snapshot') startSnapshotRefresh();

  // Poll every 2s for zone state changes
  camUpdateInterval = setInterval(camUpdate, 2000);

  // Expose update function for app.js to call on HA state changes
  window.camUpdate = camUpdate;

  OW.logEvent('info', 'Camera dashboard initialised.', 'system');
}

/* ── Boot ────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  waitForOW(initCameraPage);
});

})();
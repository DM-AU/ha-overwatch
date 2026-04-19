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
const CAM_MODE_KEY          = 'ow_cam_source';    // 'server' | 'device' (defaults to 'server')

// Is this browser using server state (HA entities) or per-device localStorage?
// Camera toggle source: 'server' = HA switch entities, 'device' = localStorage
// Name-based slug — must match server.js nameSlug() in /ow/zones
function nameSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function camUseServerState() {
  return localStorage.getItem(CAM_MODE_KEY) !== 'device';
}

// Read camera/zone toggle state from HA switch entities or localStorage
function camIsEnabled(type, key) {
  if (!camUseServerState()) {
    // Device mode — use localStorage
    if (type === 'camera') return localStorage.getItem(CAM_TOGGLE_PREFIX + key) !== 'false';
    if (type === 'zone')   return localStorage.getItem(CAM_ZONE_PREFIX   + key) !== 'false';
    return localStorage.getItem(CAM_GLOBAL_KEY) !== 'false';
  }
  // Server mode — read from HA switch entity state via haStates
  const haStates = window.OW?.haStates || {};
  if (type === 'camera') {
    // Strip camera. prefix then slugify to match entity ID
    const safe = key.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
    const st   = haStates[`switch.overwatch_camera_${safe}`];
    return st ? st.state !== 'off' : true;
  }
  if (type === 'zone') {
    // zone.id is raw file ID — convert to name slug to match entity ID
    const zones = window.OW?.zones || [];
    const zone  = zones.find(z => z.id === key || nameSlug(z.name) === key);
    const slug  = zone ? nameSlug(zone.name) : nameSlug(key);
    const st    = haStates[`switch.overwatch_camera_zone_${slug || key}`];
    return st ? st.state !== 'off' : true;
  }
  // global — check camera_all switch
  const st = haStates['switch.overwatch_camera_all'];
  return st ? st.state !== 'off' : true;
}

// Set camera/zone toggle — calls HA switch service or writes localStorage
async function camSetEnabled(type, key, state) {
  if (!camUseServerState()) {
    if (type === 'camera') localStorage.setItem(CAM_TOGGLE_PREFIX + key, state ? 'true' : 'false');
    else if (type === 'zone') localStorage.setItem(CAM_ZONE_PREFIX + key, state ? 'true' : 'false');
    else localStorage.setItem(CAM_GLOBAL_KEY, state ? 'true' : 'false');
    return;
  }
  // Server mode — call HA switch service via existing WS connection
  if (!window.OW) return;
  const entityMap = {
    'all':          'switch.overwatch_camera_all',
    'camera_all':   'switch.overwatch_camera_all',
    'camera_group': `switch.overwatch_camera_group_${key}`,
    'camera_zone':  `switch.overwatch_camera_zone_${nameSlug(key) || key}`,
    'zone':         `switch.overwatch_camera_zone_${nameSlug(key) || key}`,
    'camera':       `switch.overwatch_camera_${key.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_')}`,
  };
  const entityId = entityMap[type];
  if (entityId && window.OW.haStates !== undefined) {
    // Use the same owCallSwitch pattern from app.js
    const haSocket = window.OW.getHASocket?.();
    if (haSocket && haSocket.readyState === WebSocket.OPEN) {
      haSocket.send(JSON.stringify({
        id: Date.now(), type: 'call_service',
        domain: 'switch', service: state ? 'turn_on' : 'turn_off',
        service_data: { entity_id: entityId },
      }));
    }
  }
}

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
let camStatusOpen  = localStorage.getItem('cam_status_open') !== 'false'; // default open, persisted
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
  // Use apiPath() same as all other server API calls — works in both addon and standalone mode
  if (window.OW.isAddonMode) {
    return window.OW.apiPath(`ow/camera_proxy/${entityId}`) + `?t=${Date.now()}`;
  }
  const haUrl = (window.OW.uiConfig.ha_url || '').replace(/\/$/, '');
  return `${haUrl}/api/camera_proxy/${entityId}?t=${Date.now()}`;
}

function camStreamUrl(entityId) {
  if (window.OW.isAddonMode) {
    return window.OW.apiPath(`ow/camera_proxy_stream/${entityId}`);
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

  camMaxVisible = parseInt(cfg.cam_max_visible) || 0;
  try { camLowResMap = JSON.parse(cfg.cam_low_res_map || '{}'); } catch {}
  try { camPinned = new Set(JSON.parse(cfg.cam_pinned || '[]')); } catch {}

  const cooldownMs = (parseInt(localStorage.getItem("ow_cam_cooldown") || cfg.cam_cooldown) || 30) * 1000;
  const failHideMs = (parseInt(cfg.cam_fail_hide_seconds) || 5) * 1000;

  // Global toggle — server or device mode
  const globalOn = camIsEnabled('global', 'all');
  if (!globalOn) return [];

  const cameraSet = new Map();

  zones.forEach(zone => {
    const zoneOn   = camIsEnabled('zone', zone.id);
    if (!zoneOn) return;

    const sensors   = zone.sensors || [];
    const triggered = sensors.some(OW.isEntityTriggered);
    const cameras   = zone.cameras || [];
    if (!cameras.length) return;

    cameras.forEach(entityId => {
      const camOn = camIsEnabled('camera', entityId);
      if (!camOn) return;
      if (camHidden.has(entityId)) return;

      if (triggered) {
        const until = now + cooldownMs;
        camCooldowns[entityId] = { until, zoneId: zone.id };
        camLastTrigger[entityId] = now;
        cameraSet.set(entityId, { lastTrigger: now, fromZone: zone.id });
      } else if (camCooldowns[entityId] && camCooldowns[entityId].until > now) {
        const lt = camLastTrigger[entityId] || 0;
        cameraSet.set(entityId, { lastTrigger: lt, fromZone: zone.id });
      }
    });
  });

  // Pinned cameras
  camPinned.forEach(entityId => {
    const camOn = camIsEnabled('camera', entityId);
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
  // camMode is set by user via Snapshot/Live buttons — do NOT override it here
  // (initial value is set once in initCameraPage from uiConfig)

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
      if (localStorage.getItem('ow_hide_cam_labels') === 'true') label.style.display = 'none';

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
  const interval = (parseInt(localStorage.getItem("ow_snap_interval") || window.OW.uiConfig.cam_snapshot_interval) || 2) * 1000;
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
  let failCount = 0;
  const maxFails = Math.max(3, parseInt(window.OW.uiConfig.cam_fail_hide_seconds) || 5) * 2;

  img.onerror = () => {
    failCount++;
    if (camHidden.has(entityId)) return;
    if (failCount >= maxFails) {
      camHidden.add(entityId);
      window.OW.logEvent('error', `Camera hidden after persistent failure: ${entityId}`, 'system');
      const tile = document.getElementById(`cam-tile-${entityId.replace(/\W/g, '_')}`);
      if (tile) tile.remove();
      // Auto-retry after 60s in case it was a temporary auth/network issue
      setTimeout(() => {
        if (camHidden.has(entityId)) {
          camHidden.delete(entityId);
          camFailCount[entityId] = 0;
          renderCameraGrid();
        }
      }, 60000);
    } else {
      // Retry with exponential backoff up to 5s
      const delay = Math.min(1000 * failCount, 5000);
      setTimeout(() => {
        if (!camHidden.has(entityId)) img.src = camSnapshotUrl(entityId) ;
      }, delay);
    }
  };
  img.onload = () => { failCount = 0; };
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
/* ── Dot colour helpers ──────────────────────────────────────── */
function camDotColour(isOn, isActive) {
  if (!isOn) return { colour: '#555', flash: false };
  if (isActive) return { colour: '#ff3b30', flash: true };
  return { colour: '#ff3b30', flash: false };
}

// Aggregate dot state for a set of camera IDs
function camsDotState(camIds, activeIds) {
  if (!camIds.length) return { colour: '#555', flash: false, dim: true };
  const anyOn     = camIds.some(id => camIsEnabled('camera', id));
  const allOn     = camIds.every(id => camIsEnabled('camera', id));
  const anyActive = camIds.some(id => activeIds.has(id));
  if (!anyOn)  return { colour: '#555',    flash: false,     dim: true };
  if (!allOn)  return { colour: '#ff9500', flash: anyActive, dim: false }; // orange = mixed
  return             { colour: '#ff3b30',  flash: anyActive, dim: false }; // red = all on
}

// Aggregate dot for a zone (respects zone-level toggle)
function zoneDotState(zone, activeIds) {
  const cameras = zone.cameras || [];
  const zoneOn  = camIsEnabled('zone', zone.id);
  if (!cameras.length || !zoneOn) return { colour: zone.colorHex || '#0096ff', flash: false, dim: true };
  return camsDotState(cameras, activeIds);
}

// Aggregate dot for a group (respects zone-level toggles for member zones)
function groupDotState(group, zones, activeIds) {
  const memberZones = (group.zone_ids || []).map(id => zones.find(z => z.id === id)).filter(Boolean)
    .filter(z => (z.cameras || []).length > 0);
  if (!memberZones.length) return { colour: group.colorHex || '#0096ff', flash: false, dim: true };

  // Collect all camera IDs that are in ON zones
  const allCams = memberZones.flatMap(z => {
    const zOn = camIsEnabled('zone', z.id);
    return zOn ? (z.cameras || []) : [];
  });
  if (!allCams.length) return { colour: group.colorHex || '#0096ff', flash: false, dim: true };
  return camsDotState(allCams, activeIds);
}

// All camera IDs across all zones with cameras
function allCameraIds(zones) {
  return zones.flatMap(z => z.cameras || []);
}

function renderCameraStatusBar() {
  const container = document.getElementById('cameraStatusContainer');
  if (!container) return;

  const OW       = window.OW;
  const zones    = OW.zones;
  const groups   = OW.groups;
  const activeCams = getActiveCameras();
  const activeIds  = new Set(activeCams.map(c => c.id));

  // Lock toggles for direct browser users in server-defaults mode
  const isDirectBrowser = !!document.querySelector('meta[name="ow-direct"]');
  const lockedAttr      = (camUseServerState() && isDirectBrowser) ? 'disabled' : '';

  // ── Compute master state ──────────────────────────────────────
  const allCams  = allCameraIds(zones);
  const masterOn = camIsEnabled('global', 'all');
  const masterDot = camsDotState(allCams, activeIds);

  const zonesWithCameras = zones.filter(z => (z.cameras || []).length > 0);

  // ── Build 3-level tree: groups → zones → cameras ─────────────
  let zonesHtml = '';
  if (zonesWithCameras.length === 0) {
    zonesHtml = `<div class="cam-status-empty">No cameras configured in zones</div>`;
  } else {
    const groupedZoneIds = new Set((groups || []).flatMap(g => g.zone_ids || []));

    // Sort groups alphabetically
    const sortedGroups = [...(groups || [])].sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id));

    // Render a single zone row + its cameras
    const renderZoneRow = (zone, indent) => {
      const cameras  = [...(zone.cameras || [])].sort((a, b) =>
        friendlyName(a).localeCompare(friendlyName(b)));
      const zoneOn   = camIsEnabled('zone', zone.id);
      const colKey   = `cam_zone_collapsed_${zone.id}`;
      const collapsed = localStorage.getItem(colKey) !== 'expanded';
      const dot = zoneDotState(zone, activeIds);
      const pl  = indent === 1 ? '28px' : '14px';

      let html = `
        <div class="cam-dd-zone-header${collapsed ? ' collapsed' : ''}"
             data-zone-id="${zone.id}" data-col-key="${colKey}"
             style="padding-left:${pl};">
          <div class="zone-list-dot${dot.flash ? ' flashing' : ''}"
            style="background:${dot.colour};opacity:${dot.dim ? 0.35 : 1};width:8px;height:8px;border-radius:50%;flex-shrink:0;"></div>
          <span class="cam-dd-zone-name">${escapeHtml(zone.name || zone.id)}</span>
          <svg class="cam-dd-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"
            style="opacity:0.4;flex-shrink:0;transition:transform 0.2s;transform:rotate(${collapsed ? '-90' : '0'}deg)">
            <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <label class="zone-toggle-switch" style="flex-shrink:0;" onclick="event.stopPropagation()">
            <input type="checkbox" class="cam-zone-toggle" data-zone-id="${zone.id}" ${zoneOn ? 'checked' : ''} ${lockedAttr}>
            <span class="zone-toggle-track"></span>
          </label>
        </div>
        <div class="cam-dd-cameras" data-zone-id="${zone.id}" style="display:${collapsed ? 'none' : ''};">`;

      cameras.forEach(camId => {
        const camOn    = camIsEnabled('camera', camId);
        const isActive = activeIds.has(camId);
        const isPinned = camPinned.has(camId);
        const dot      = camDotColour(camOn && zoneOn, isActive && camOn && zoneOn);
        const camPl    = indent === 1 ? '44px' : '28px';
        html += `
          <div class="cam-dd-cam-row" style="padding-left:${camPl};">
            <div class="zone-list-dot${dot.flash ? ' flashing' : ''}"
              style="background:${dot.colour};opacity:${camOn && zoneOn ? 1 : 0.3};width:6px;height:6px;border-radius:50%;flex-shrink:0;"></div>
            <span class="cam-dd-cam-name">${escapeHtml(friendlyName(camId))}${isPinned ? ' <span style="font-size:9px;color:#ff9500;">📌</span>' : ''}</span>
            <label class="zone-toggle-switch" style="flex-shrink:0;" onclick="event.stopPropagation()">
              <input type="checkbox" class="cam-entity-toggle" data-cam-id="${camId}" ${camOn ? 'checked' : ''} ${lockedAttr}>
              <span class="zone-toggle-track"></span>
            </label>
          </div>`;
      });

      html += `</div>`;
      return html;
    };

    // Render groups (with their member zones)
    sortedGroups.forEach(group => {
      const memberZones = (group.zone_ids || [])
        .map(id => zones.find(z => z.id === id))
        .filter(z => z && (z.cameras || []).length > 0)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
      if (!memberZones.length) return;

      const gColKey    = `cam_grp_collapsed_${group.id}`;
      const gCollapsed = localStorage.getItem(gColKey) !== 'expanded';
      const gDot       = groupDotState(group, zones, activeIds);

      // Group is "on" if ALL member zones are on per current mode
      const gAllOn = memberZones.every(z => camIsEnabled('zone', z.id));

      zonesHtml += `
        <div class="cam-dd-group-header${gCollapsed ? ' collapsed' : ''}"
             data-group-id="${group.id}" data-col-key="${gColKey}">
          <div class="zone-list-dot${gDot.flash ? ' flashing' : ''}"
            style="background:${gDot.colour};opacity:${gDot.dim ? 0.35 : 1};width:9px;height:9px;border-radius:50%;flex-shrink:0;"></div>
          <span class="cam-dd-group-name">${escapeHtml(group.name || group.id)}</span>
          <svg class="cam-dd-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"
            style="opacity:0.4;flex-shrink:0;transition:transform 0.2s;transform:rotate(${gCollapsed ? '-90' : '0'}deg)">
            <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <label class="zone-toggle-switch" style="flex-shrink:0;" onclick="event.stopPropagation()">
            <input type="checkbox" class="cam-group-toggle" data-group-id="${group.id}" ${gAllOn ? 'checked' : ''} ${lockedAttr}>
            <span class="zone-toggle-track"></span>
          </label>
        </div>
        <div class="cam-dd-group-zones" data-group-id="${group.id}" style="display:${gCollapsed ? 'none' : ''};">`;

      memberZones.forEach(zone => { zonesHtml += renderZoneRow(zone, 1); });
      zonesHtml += `</div>`;
    });

    // Ungrouped zones (sorted alphabetically)
    const ungroupedZones = zonesWithCameras
      .filter(z => !groupedZoneIds.has(z.id))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

    if (ungroupedZones.length) {
      ungroupedZones.forEach(zone => { zonesHtml += renderZoneRow(zone, 0); });
    }

    // Pinned cameras not in any zone
    const allZoneCams = new Set(zones.flatMap(z => z.cameras || []));
    const orphanPins  = [...camPinned].filter(id => !allZoneCams.has(id))
      .sort((a, b) => friendlyName(a).localeCompare(friendlyName(b)));
    if (orphanPins.length) {
      zonesHtml += `<div class="cam-dd-zone-header" style="border-top:1px solid rgba(255,255,255,0.06);cursor:default;">
        <div style="width:8px;height:8px;border-radius:50%;background:#ff9500;flex-shrink:0;"></div>
        <span class="cam-dd-zone-name" style="color:#777;">Pinned (no zone)</span>
      </div>`;
      orphanPins.forEach(camId => {
        const camOn    = camIsEnabled('camera', camId);
        const isActive = activeIds.has(camId);
        const dot      = camDotColour(camOn, isActive && camOn);
        zonesHtml += `
          <div class="cam-dd-cam-row" style="padding-left:28px;">
            <div class="zone-list-dot${dot.flash ? ' flashing' : ''}"
              style="background:${dot.colour};opacity:${camOn ? 1 : 0.3};width:6px;height:6px;border-radius:50%;flex-shrink:0;"></div>
            <span class="cam-dd-cam-name">${escapeHtml(friendlyName(camId))} <span style="font-size:9px;color:#ff9500;">📌</span></span>
            <label class="zone-toggle-switch" style="flex-shrink:0;">
              <input type="checkbox" class="cam-entity-toggle" data-cam-id="${camId}" ${camOn ? 'checked' : ''} ${lockedAttr}>
              <span class="zone-toggle-track"></span>
            </label>
          </div>`;
      });
    }
  }

  // ── Status bar pill ────────────────────────────────────────
  const anyActive    = activeCams.length > 0;
  const masterLabel  = masterOn ? 'Cameras Active' : 'Cameras Off';
  const masterColour = masterDot.dim ? '#555' : masterDot.colour;
  const masterFlash  = !masterDot.dim && masterDot.flash;

  const sidebarOnRight = (OW.uiConfig.sidebar_position || 'right') !== 'left';
  const hasHidden = camHidden.size > 0;

  // Retry button (only shown when cameras are hidden due to failures)
  const retrySide = sidebarOnRight
    ? 'position:absolute;left:12px;top:0;display:flex;gap:4px;align-items:center;'
    : 'position:absolute;right:12px;top:0;display:flex;gap:4px;align-items:center;';

  const retryButton = hasHidden ? `
    <div style="${retrySide}">
      <button class="cam-mode-btn" id="camRetryBtn" style="color:#ff9500;border-color:rgba(255,149,0,0.3);" title="Retry ${camHidden.size} hidden camera(s)">↺ Retry</button>
    </div>` : '';

  container.innerHTML = `
    ${retryButton}
    <div class="cam-status-bar" id="camStatusBar">
      <div class="cam-status-inner" id="camStatusToggle">
        <div class="zone-list-dot${masterFlash ? ' flashing' : ''}"
          style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${masterColour};"></div>
        <span class="cam-status-label">${masterLabel}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="opacity:0.5;margin-left:4px;transition:transform 0.2s;transform:rotate(${camStatusOpen ? '180' : '0'}deg)">
          <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>
  `;

  // ── Portal dropdown — lives on body, escapes overflow:hidden clipping ──
  let dd = document.getElementById('camStatusDd');
  if (!dd) {
    dd = document.createElement('div');
    dd.id = 'camStatusDd';
    document.body.appendChild(dd);
  }
  dd.className = 'cam-status-dd cam-status-dd-portal';

  const lockedNote = (lockedAttr)
    ? `<div style="font-size:10px;color:#555;padding:6px 14px;border-top:1px solid rgba(255,255,255,0.05);">
        Camera toggles controlled by HA entities (server defaults).<br>
        Switch to Per device in Settings → Cameras to override locally.
       </div>` : '';

  dd.innerHTML = `
    <div class="cam-status-master">
      <div class="zone-list-dot${masterFlash ? ' flashing' : ''}"
        style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${masterColour};opacity:${masterDot.dim ? 0.35 : 1};"></div>
      <span style="flex:1;font-size:11px;font-weight:600;color:#aaa;margin-left:6px;">All Cameras</span>
      <label class="zone-toggle-switch" style="flex-shrink:0;${lockedAttr ? 'opacity:0.4;' : ''}">
        <input type="checkbox" id="camGlobalToggle" ${masterOn ? 'checked' : ''} ${lockedAttr}>
        <span class="zone-toggle-track"></span>
      </label>
    </div>
    <div style="height:1px;background:rgba(255,255,255,0.06);margin:0 14px 4px;"></div>
    ${zonesHtml}
    ${lockedNote}
  `;
  dd.style.display = camStatusOpen ? 'block' : 'none';

  function positionDropdown() {
    const toggle = document.getElementById('camStatusToggle');
    if (!toggle) return;
    const r = toggle.getBoundingClientRect();
    if (r.width === 0) return;
    dd.style.position  = 'fixed';
    dd.style.top       = (r.bottom + 6) + 'px';
    dd.style.left      = (r.left + r.width / 2) + 'px';
    dd.style.transform = 'translateX(-50%)';
    dd.style.zIndex    = '9000';
  }
  requestAnimationFrame(() => {
    positionDropdown();
    // Second attempt in case panel hasn't laid out yet
    setTimeout(positionDropdown, 100);
  });

  // Expose toggle function globally
  window._camToggle = () => {
    camStatusOpen = !camStatusOpen;
    localStorage.setItem('cam_status_open', camStatusOpen ? 'true' : 'false');
    const d = document.getElementById('camStatusDd');
    if (d) d.style.display = camStatusOpen ? 'block' : 'none';
    const chev = document.querySelector('#camStatusToggle svg');
    if (chev) chev.style.transform = `rotate(${camStatusOpen ? '180' : '0'}deg)`;
    if (camStatusOpen) positionDropdown();
  };

  // Wire onclick synchronously — element exists immediately after innerHTML
  const toggleEl = document.getElementById('camStatusToggle');
  if (toggleEl) toggleEl.onclick = window._camToggle;

  // Master toggle — server mode: let HA WS state_changed drive re-render
  //                  device mode: write localStorage then re-render immediately
  document.getElementById('camGlobalToggle')?.addEventListener('change', async e => {
    const on = e.target.checked;
    await camSetEnabled('all', 'all', on);
    if (!camUseServerState()) {
      zonesWithCameras.forEach(zone => {
        localStorage.setItem(CAM_ZONE_PREFIX + zone.id, on ? 'true' : 'false');
        (zone.cameras || []).forEach(id => localStorage.setItem(CAM_TOGGLE_PREFIX + id, on ? 'true' : 'false'));
      });
      renderCameraStatusBar(); renderCameraGrid();
    }
    // Server mode: HA WS event will update haStates and trigger camUpdate → re-render
  });

  // Group header: collapse/expand
  document.querySelectorAll('.cam-dd-group-header').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('label,input')) return;
      const colKey = hdr.dataset.colKey;
      const content = hdr.nextElementSibling;
      const isCol = content?.style.display === 'none';
      if (content) content.style.display = isCol ? '' : 'none';
      const chev = hdr.querySelector('.cam-dd-chevron');
      if (chev) chev.style.transform = `rotate(${isCol ? '0' : '-90'}deg)`;
      localStorage.setItem(colKey, isCol ? 'expanded' : 'collapsed');
    });
  });

  // Group toggles
  document.querySelectorAll('.cam-group-toggle').forEach(chk => {
    chk.addEventListener('change', async e => {
      const gid = e.target.dataset.groupId;
      const on  = e.target.checked;
      const group = (groups || []).find(g => g.id === gid);
      const memberZones = (group?.zone_ids || []).map(id => zones.find(z => z.id === id))
        .filter(z => z && (z.cameras || []).length > 0);
      await camSetEnabled('camera_group', gid, on);
      if (!camUseServerState()) {
        memberZones.forEach(zone => {
          localStorage.setItem(CAM_ZONE_PREFIX + zone.id, on ? 'true' : 'false');
          (zone.cameras || []).forEach(id => localStorage.setItem(CAM_TOGGLE_PREFIX + id, on ? 'true' : 'false'));
        });
        renderCameraStatusBar(); renderCameraGrid();
      }
    });
  });

  // Zone header: collapse/expand cameras
  document.querySelectorAll('.cam-dd-zone-header').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('label,input')) return;
      const colKey = hdr.dataset.colKey;
      if (!colKey) return;
      const content = hdr.nextElementSibling;
      const isCol = content?.style.display === 'none';
      if (content) content.style.display = isCol ? '' : 'none';
      const chev = hdr.querySelector('.cam-dd-chevron');
      if (chev) chev.style.transform = `rotate(${isCol ? '0' : '-90'}deg)`;
      localStorage.setItem(colKey, isCol ? 'expanded' : 'collapsed');
    });
  });

  // Zone toggles
  document.querySelectorAll('.cam-zone-toggle').forEach(chk => {
    chk.addEventListener('change', async e => {
      const zid = e.target.dataset.zoneId;
      const on  = e.target.checked;
      const zone = zones.find(z => z.id === zid);
      await camSetEnabled('zone', zid, on);
      if (!camUseServerState()) {
        localStorage.setItem(CAM_ZONE_PREFIX + zid, on ? 'true' : 'false');
        (zone?.cameras || []).forEach(id => localStorage.setItem(CAM_TOGGLE_PREFIX + id, on ? 'true' : 'false'));
        renderCameraStatusBar(); renderCameraGrid();
      }
    });
  });

  // Camera toggles
  document.querySelectorAll('.cam-entity-toggle').forEach(chk => {
    chk.addEventListener('change', async e => {
      const camId = e.target.dataset.camId;
      const on    = e.target.checked;
      await camSetEnabled('camera', camId, on);
      if (!camUseServerState()) {
        localStorage.setItem(CAM_TOGGLE_PREFIX + camId, on ? 'true' : 'false');
        const parentZone = zones.find(z => (z.cameras || []).includes(camId));
        if (parentZone) {
          const allOn = (parentZone.cameras || []).every(id => camIsEnabled('camera', id));
          localStorage.setItem(CAM_ZONE_PREFIX + parentZone.id, allOn ? 'true' : 'false');
        }
        renderCameraStatusBar(); renderCameraGrid();
      }
    });
  });

  const retryBtn = document.getElementById('camRetryBtn');
  if (retryBtn) retryBtn.onclick = () => {
    camHidden.clear();
    camFailCount = {};
    const grid = document.getElementById('cameraGrid');
    if (grid) grid.innerHTML = '';
    renderCameraGrid();
    renderCameraStatusBar();
  };
}

/* ── Utility ─────────────────────────────────────────────────── */
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Main update loop ────────────────────────────────────────── */
let camUpdateInterval = null;

function camUpdate() {
  renderCameraGrid();

  const OW       = window.OW;
  if (!OW) return;
  const zones    = OW.zones || [];
  const groups   = OW.groups || [];
  const activeCams = getActiveCameras();
  const activeIds  = new Set(activeCams.map(c => c.id));

  // ── Master dot (in status pill) ────────────────────────────
  const allCams = zones.flatMap(z => z.cameras || []);
  const mDot    = camsDotState(allCams, activeIds);
  const masterDotEl = document.querySelector('#camStatusToggle .zone-list-dot');
  if (masterDotEl) {
    masterDotEl.style.background = mDot.dim ? '#555' : mDot.colour;
    masterDotEl.style.opacity    = mDot.dim ? '0.35' : '1';
    masterDotEl.classList.toggle('flashing', !mDot.dim && mDot.flash);
  }

  // ── Dropdown dots (only if open) ───────────────────────────
  const dd = document.getElementById('camStatusDd');
  if (!dd || dd.style.display === 'none') return;

  // Master dot inside dropdown
  const ddMasterDot = dd.querySelector('.cam-status-master .zone-list-dot');
  if (ddMasterDot) {
    ddMasterDot.style.background = mDot.dim ? '#555' : mDot.colour;
    ddMasterDot.style.opacity    = mDot.dim ? '0.35' : '1';
    ddMasterDot.classList.toggle('flashing', !mDot.dim && mDot.flash);
  }

  // Group dots
  dd.querySelectorAll('.cam-dd-group-header').forEach(hdr => {
    const gid   = hdr.dataset.groupId;
    const group = groups.find(g => g.id === gid);
    if (!group) return;
    const gDot  = groupDotState(group, zones, activeIds);
    const dot   = hdr.querySelector('.zone-list-dot');
    if (dot) {
      dot.style.background = gDot.dim ? '#555' : gDot.colour;
      dot.style.opacity    = gDot.dim ? '0.35' : '1';
      dot.classList.toggle('flashing', !gDot.dim && gDot.flash);
    }
  });

  // Zone dots
  dd.querySelectorAll('.cam-dd-zone-header').forEach(hdr => {
    const zid  = hdr.dataset.zoneId;
    const zone = zones.find(z => z.id === zid);
    if (!zone) return;
    const zDot = zoneDotState(zone, activeIds);
    const dot  = hdr.querySelector('.zone-list-dot');
    if (dot) {
      dot.style.background = zDot.dim ? (zone.colorHex || '#0096ff') : zDot.colour;
      dot.style.opacity    = zDot.dim ? '0.35' : '1';
      dot.classList.toggle('flashing', !zDot.dim && zDot.flash);
    }
  });

  // Camera dots
  dd.querySelectorAll('.cam-dd-cam-row').forEach(row => {
    const toggle = row.querySelector('.cam-entity-toggle');
    if (!toggle) return;
    const camId  = toggle.dataset.camId;
    const camOn  = camIsEnabled('camera', camId);
    const isActive = activeIds.has(camId);
    const cDot   = camDotColour(camOn, isActive && camOn);
    const dot    = row.querySelector('.zone-list-dot');
    if (dot) {
      dot.style.background = cDot.colour;
      dot.style.opacity    = camOn ? '1' : '0.3';
      dot.classList.toggle('flashing', cDot.flash);
    }
  });
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
    // Update uiConfig in memory — persisted next time user hits Save Settings
    OW.uiConfig.cam_pinned = JSON.stringify([...camPinned]);
    renderCameraStatusBar();
    renderCameraGrid();
  });
}

// buildCamYamlPatch removed — partial saves destroyed ui.yaml.
// Camera config persists via app.js buildYamlContent() on full Settings save.

/* ── Override sidebar loading for camera page ─────────────────── */
// app.js loads modules/sidebar.html by default.
// We hook after DOMContentLoaded once OW is ready to swap in camera sidebar.
function initCameraPage() {
  const OW = window.OW;

  // Parse config — localStorage overrides uiConfig for per-device settings
  camMode = (localStorage.getItem('ow_cam_mode') || OW.uiConfig.cam_default_mode || 'snapshot') === 'live' ? 'live' : 'snapshot';
  try { camLowResMap = JSON.parse(OW.uiConfig.cam_low_res_map || '{}'); } catch {}
  try { camPinned = new Set(JSON.parse(OW.uiConfig.cam_pinned || '[]')); } catch {}

  // Expose for settings panel source toggle
  window.renderCameraStatusBar = renderCameraStatusBar;

  // Initial renders
  renderCameraStatusBar();
  renderCameraGrid();
  bindModal();

  // Start snapshot refresh if in snapshot mode
  if (camMode === 'snapshot') startSnapshotRefresh();

  // Poll every 2s for zone state changes
  camUpdateInterval = setInterval(camUpdate, 2000);

  // Close camera dropdown when clicking outside it
  document.addEventListener('pointerdown', e => {
    const dd = document.getElementById('camStatusDd');
    const bar = document.getElementById('camStatusToggle');
    if (!dd || dd.style.display === 'none') return;
    if (!dd.contains(e.target) && !bar?.contains(e.target)) {
      camStatusOpen = false;
      dd.style.display = 'none';
      localStorage.setItem('cam_status_open', 'false');
    }
  });

  // Expose update function for app.js to call on HA state changes
  window.camUpdate = camUpdate;

  // Allow settings panel to change mode live
  window._camSetMode = (mode) => {
    if (camMode === mode) return;
    camMode = mode;
    if (mode === 'live') { stopSnapshotRefresh(); } else { startSnapshotRefresh(); }
    const grid = document.getElementById('cameraGrid');
    if (grid) grid.innerHTML = '';
    renderCameraGrid();
    renderCameraStatusBar();
  };

  // Clear hidden cameras on HA reconnect
  window.camResetHidden = () => {
    camHidden.clear();
    camFailCount = {};
    renderCameraGrid();
  };

  OW.logEvent('info', 'Camera dashboard initialised.', 'system');
}

/* ── Boot ────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  waitForOW(initCameraPage);
});

})();
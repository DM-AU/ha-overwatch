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

// Read camera toggle state from HA switch entities or localStorage
// For zone/group/global: DERIVED from children (any camera off = parent off)
// This means zone/group toggles REFLECT child state rather than having independent state.
function camIsEnabled(type, key) {
  if (!camUseServerState()) {
    // Device mode — use localStorage
    if (type === 'camera') return localStorage.getItem(CAM_TOGGLE_PREFIX + key) !== 'false';
    if (type === 'zone')   return localStorage.getItem(CAM_ZONE_PREFIX   + key) !== 'false';
    return localStorage.getItem(CAM_GLOBAL_KEY) !== 'false';
  }

  // Server mode — cameras read from HA switch entity state
  const haStates = window.OW?.haStates || {};

  if (type === 'camera') {
    const safe = key.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_');
    const st   = haStates[`switch.overwatch_camera_${safe}`];
    return st ? st.state !== 'off' : true;
  }

  // Zone: ON only if ALL cameras in the zone are ON (any off = zone off)
  if (type === 'zone') {
    const zones = window.OW?.zones || [];
    const zone  = zones.find(z => z.id === key || nameSlug(z.name) === key);
    if (!zone) return true;
    const cameras = zone.cameras || [];
    if (!cameras.length) return true;
    return cameras.every(camId => camIsEnabled('camera', camId));
  }

  // Group: ON only if ALL cameras in ALL member zones are ON
  if (type === 'camera_group' || type === 'group') {
    const zones  = window.OW?.zones  || [];
    const groups = window.OW?.groups || [];
    const group  = groups.find(g => g.id === key || nameSlug(g.name) === key);
    if (!group) return true;
    const memberZones = (group.zone_ids || [])
      .map(zid => zones.find(z => z.id === zid))
      .filter(z => z && (z.cameras || []).length > 0);
    if (!memberZones.length) return true;
    return memberZones.every(z => camIsEnabled('zone', z.id));
  }

  // Global: read directly from HA switch — it is an independent master override,
  // not derived from children. Turning any camera off should not turn off the master.
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
  // Server mode — call HA switch service via app.js sendHA (shared id counter, no collision)
  if (!window.OW) return;

  // Resolve name slugs from OW.zones/groups — entity IDs use zone.name not zone.id
  const owZones  = window.OW.zones  || [];
  const owGroups = window.OW.groups || [];
  function zoneNameSlug(zid) {
    const z = owZones.find(z => z.id === zid);
    return z ? nameSlug(z.name) : nameSlug(zid);
  }
  function groupNameSlug(gid) {
    const g = owGroups.find(g => g.id === gid);
    return g ? nameSlug(g.name) : nameSlug(gid);
  }

  const entityMap = {
    'all':          'switch.overwatch_camera_all',
    'camera_all':   'switch.overwatch_camera_all',
    'camera_group': `switch.overwatch_camera_group_${groupNameSlug(key)}`,
    'camera_zone':  `switch.overwatch_camera_zone_${zoneNameSlug(key)}`,
    'zone':         `switch.overwatch_camera_zone_${zoneNameSlug(key)}`,
    'camera':       `switch.overwatch_camera_${key.replace(/^camera\./, '').replace(/[^a-z0-9]+/g, '_')}`,
  };
  const entityId = entityMap[type];
  if (entityId) {
    const IS_DIRECT = !!document.querySelector('meta[name="ow-direct"]');
    if (IS_DIRECT) {
      // Direct Mode: no WebSocket — call HA via backend REST proxy
      fetch('ow/call-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'switch', service: state ? 'turn_on' : 'turn_off', entity_id: entityId }),
      }).catch(e => console.warn('[OW] camSetEnabled REST failed:', e.message));
    } else if (window.OW?.sendHA) {
      // Ingress/addon mode: use WebSocket via shared sendHA (preserves haMsgId counter)
      window.OW.sendHA({
        type: 'call_service',
        domain: 'switch', service: state ? 'turn_on' : 'turn_off',
        service_data: { entity_id: entityId },
      });
    }
  }
}

/* ── Module state ────────────────────────────────────────────── */
let camMode        = 'live';       // 'live' | 'snapshot' — live is forced by default
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
  // Snapshots are intentionally disabled. Never call /ow/camera_proxy or HA
  // /api/camera_proxy from the frontend. This placeholder performs no network I/O.
  const label = String(entityId || 'camera').replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <rect width="640" height="360" fill="#111"/>
    <text x="320" y="166" fill="#777" font-family="Arial, sans-serif" font-size="24" text-anchor="middle">Snapshots disabled</text>
    <text x="320" y="202" fill="#555" font-family="Arial, sans-serif" font-size="16" text-anchor="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
  if (localStorage.getItem('ow_cam_always_high_res') === 'true') return highResId;
  const resolved = camLowResMap[highResId] || highResId;
  if (resolved !== highResId) console.log(`[CAM] Low-res: ${highResId} → ${resolved}`);
  return resolved;
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
  // Do NOT reset camLowResMap or camPinned here — both are loaded once at init
  // and updated by their own handlers. Resetting from uiConfig overwrites saved values.

  const cooldownMs = (parseInt(localStorage.getItem("ow_cam_cooldown") || cfg.cam_cooldown) || 30) * 1000;
  const failHideMs = (parseInt(cfg.cam_fail_hide_seconds) || 5) * 1000;

  // Global toggle — server or device mode
  const globalOn = camIsEnabled('global', 'all');
  if (!globalOn) return [];

  // Floor filter — when enabled, only show cameras whose zones are on the active floor
  const camFloorOnly  = localStorage.getItem('ow_cam_floor_only') === 'true';
  const activeFloorId = OW.activeFloorId;
  const allFloors     = OW.floors || [];
  const isFirstFloor  = !activeFloorId || allFloors.length === 0 || allFloors[0]?.id === activeFloorId;

  const cameraSet = new Map();

  zones.forEach(zone => {
    // Floor filter — skip zones not on active floor
    if (camFloorOnly && allFloors.length > 1) {
      const zFloor = zone.floor_id;
      if (zFloor && zFloor !== activeFloorId) return;
      if (!zFloor && !isFirstFloor) return;
    }

    const zoneOn   = camIsEnabled('zone', zone.id);
    if (!zoneOn) return;

    // Setting: hide cameras from zones that are alarm-disarmed
    if (localStorage.getItem('ow_hide_disarmed_cams') === 'true') {
      const haStates = OW.haStates || {};
      const slug = zone.name ? zone.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : '';
      const alarmSt = haStates[`switch.overwatch_zone_${slug}`];
      // If entity exists and is off → zone is alarm-disarmed → skip cameras
      if (alarmSt && alarmSt.state === 'off') return;
    }

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
  const hideDisarmedCams = localStorage.getItem('ow_hide_disarmed_cams') === 'true';
  camPinned.forEach(entityId => {
    const camOn = camIsEnabled('camera', entityId);
    if (!camOn) return;
    if (camHidden.has(entityId)) return;
    // If hide-disarmed-cams is on, skip pinned cameras from disarmed zones
    if (hideDisarmedCams) {
      const ownerZone = zones.find(z => (z.cameras || []).includes(entityId));
      if (ownerZone && !camIsEnabled('zone', ownerZone.id)) return;
    }
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
  // Snapshot refresh disabled. Do not periodically assign snapshot URLs.
  stopSnapshotRefresh();
  return;
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
      // Retry with exponential backoff up to 5s.
      // In live mode: ONLY retry the stream, never snapshot.
      // Snapshot fallback hammers Protect's snapshot API causing 429 rate limiting.
      const delay = Math.min(1000 * failCount, 5000);
      setTimeout(() => {
        if (camHidden.has(entityId)) return;
        const tileEnt = tileEntityFor(entityId);
        img.src = camMode === 'live' ? camStreamUrl(tileEnt) : camSnapshotUrl(tileEnt);
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

      // Group is "on" if ALL cameras in all member zones are on (derived from children)
      const gAllOn = camIsEnabled('group', group.id);

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
      // Always call the group-level switch first
      await camSetEnabled('camera_group', gid, on);
      if (camUseServerState()) {
        // Server mode: cascade group → member zones → cameras directly.
        // HA has no built-in cascade for camera group switches, so we must call each entity.
        memberZones.forEach(zone => {
          camSetEnabled('zone', zone.id, on);
          (zone.cameras || []).forEach(camId => camSetEnabled('camera', camId, on));
        });
        // Re-render will happen when HA WS state_changed events come back for each entity
      } else {
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
      if (camUseServerState()) {
        // Server mode: cascade zone → member cameras directly.
        // HA has no built-in cascade for camera zone switches, so we call each entity.
        (zone?.cameras || []).forEach(camId => camSetEnabled('camera', camId, on));
        // Re-render will happen when HA WS state_changed events come back
      } else {
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

      if (camUseServerState()) {
        // Server mode: bottom-up cascade — update zone and group switches to reflect new state.
        // The zone/group switch state is DERIVED from children (any off = parent off).
        // We update the zone switch immediately so /ow/states reflects truth on next poll.
        const parentZone = zones.find(z => (z.cameras || []).includes(camId));
        if (parentZone) {
          // Zone is ON only if ALL its cameras are still ON after this change
          const zoneNowOn = (parentZone.cameras || []).every(id =>
            id === camId ? on : camIsEnabled('camera', id)
          );
          camSetEnabled('zone', parentZone.id, zoneNowOn);

          // Group containing this zone: ON only if ALL member zones are now ON
          const parentGroup = (groups || []).find(g =>
            (g.zone_ids || []).includes(parentZone.id)
          );
          // Do NOT call camSetEnabled for the group — group display is derived from
          // children via camIsEnabled('group') so it reflects correctly without writing
          // to HA. Writing to the group HA switch would trigger server-side cascadeSwitchState
          // which would turn off ALL zones in the group, not just the one camera's zone.
        }
        // Re-render will happen on next /ow/states poll (Direct Mode) or WS state_changed
      } else {
        // Device mode: update localStorage bottom-up
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
  // Inject fullscreen button into modal if not already present
  const modal = document.getElementById('cameraModal');
  if (modal && !document.getElementById('camModalFullscreenBtn')) {
    // Find the button row (contains camModalClose)
    const closeBtn = document.getElementById('camModalClose');
    if (closeBtn) {
      const fsBtn = document.createElement('button');
      fsBtn.id = 'camModalFullscreenBtn';
      fsBtn.textContent = '⛶';
      fsBtn.title = 'Full screen';
      fsBtn.style.cssText = closeBtn.style.cssText || '';
      fsBtn.className = closeBtn.className || 'cam-mode-btn';
      closeBtn.parentNode.insertBefore(fsBtn, closeBtn);
    }
  }

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
    // Save to localStorage so pins survive browser refresh
    localStorage.setItem('ow_cam_pinned', JSON.stringify([...camPinned]));
    OW.uiConfig.cam_pinned = JSON.stringify([...camPinned]);
    renderCameraStatusBar();
    renderCameraGrid();
  });

  document.getElementById('camModalFullscreenBtn')?.addEventListener('click', () => {
    if (!camModalEntityId) return;
    openCameraFullscreen(camModalEntityId);
  });

  document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('camModalFullscreenBtn');
    if (btn) btn.textContent = document.fullscreenElement ? '⊡' : '⛶';
  });
}

/* ── Proper fullscreen — dedicated overlay, then native API ──── */
function openCameraFullscreen(entityId) {
  // Remove any existing fullscreen overlay
  document.getElementById('camFullscreenOverlay')?.remove();

  const isLive = camMode === 'live';
  const overlay = document.createElement('div');
  overlay.id = 'camFullscreenOverlay';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:99999;
    background:#000;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
  `;

  const label = document.createElement('div');
  label.textContent = friendlyName(entityId);
  label.style.cssText = 'position:absolute;top:12px;left:16px;color:#fff;font-size:14px;font-weight:600;opacity:0.8;z-index:2;';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'position:absolute;top:10px;right:14px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:16px;z-index:2;';
  closeBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    overlay.remove();
  };

  const media = document.createElement('div');
  media.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';

  if (isLive) {
    const img = document.createElement('img');
    img.src = camStreamUrl(entityId); // always high-res in fullscreen
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
    media.appendChild(img);
  } else {
    const img = document.createElement('img');
    img.src = camSnapshotUrl(entityId); // always high-res in fullscreen
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
    // Refresh snapshot at configured interval
    const intervalMs = (parseInt(localStorage.getItem('ow_snap_interval') || window.OW?.uiConfig?.cam_snapshot_interval || 2) || 2) * 1000;
    const timer = setInterval(() => {
      if (!document.body.contains(overlay)) { clearInterval(timer); return; }
      img.src = camSnapshotUrl(entityId) + '&r=' + Date.now();
    }, intervalMs);
    overlay.addEventListener('remove', () => clearInterval(timer));
    media.appendChild(img);
  }

  overlay.appendChild(label);
  overlay.appendChild(media);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);

  // Request native fullscreen on the overlay element
  overlay.requestFullscreen?.()
    || overlay.webkitRequestFullscreen?.()
    || overlay.mozRequestFullScreen?.();

  // Close on Escape
  const escHandler = e => {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.contains(overlay)) overlay.remove();
  }, { once: true });
}

// buildCamYamlPatch removed — partial saves destroyed ui.yaml.
// Camera config persists via app.js buildYamlContent() on full Settings save.

/* ── Override sidebar loading for camera page ─────────────────── */
// app.js loads modules/sidebar.html by default.
// We hook after DOMContentLoaded once OW is ready to swap in camera sidebar.
async function initCameraPage() {
  const OW = window.OW;

  // Parse config
  // Load low-res map from dedicated file (more reliable than uiConfig round-trip)
  try {
    const r = await fetch(OW.apiPath('ow/cam-low-res-map') + '?v=' + Date.now());
    if (r.ok) {
      camLowResMap = await r.json();
      OW.uiConfig.cam_low_res_map = JSON.stringify(camLowResMap);
      console.log('[CAM] Low-res map loaded:', camLowResMap);
    } else {
      camLowResMap = JSON.parse(OW.uiConfig.cam_low_res_map || '{}');
      console.log('[CAM] Low-res map from uiConfig:', camLowResMap);
    }
  } catch(e) { 
    console.warn('[CAM] Failed to load low-res map:', e);
    try { camLowResMap = JSON.parse(OW.uiConfig.cam_low_res_map || '{}'); } catch { camLowResMap = {}; }
  }

  // Load pinned cameras — localStorage first (per-device, persists refresh), fall back to uiConfig
  try {
    const stored = localStorage.getItem('ow_cam_pinned');
    camPinned = new Set(JSON.parse(stored || OW.uiConfig.cam_pinned || '[]'));
  } catch { camPinned = new Set(); }

  // Live by default on every normal/external dashboard load.
  // Ignore stale snapshot values from older builds and from the settings panel.
  // HA Ingress cannot reliably carry live streams, so Ingress gets placeholder only.
  localStorage.setItem('ow_cam_mode_v4', 'live');
  camMode = isIngressBrowser() ? 'snapshot' : 'live';

  // Expose for settings panel source toggle
  window.renderCameraStatusBar = renderCameraStatusBar;
  window.openCameraModal       = openCameraModal;
  window.openCameraFullscreen  = openCameraFullscreen;
  window.setCamLowResMap       = map => { camLowResMap = map; console.log('[CAM] Low-res map updated:', map); };

  // Initial renders
  renderCameraStatusBar();
  renderCameraGrid();
  bindModal();

  // Start in live mode by default; snapshots are disabled.
  if (camMode === 'snapshot') stopSnapshotRefresh();

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
    if (mode !== 'live' && mode !== 'snapshot') return;
    localStorage.setItem('ow_cam_mode_v4', mode);
    camMode = isIngressBrowser() ? 'snapshot' : (mode === 'snapshot' ? 'snapshot' : 'live');
    if (camMode === 'live') stopSnapshotRefresh();
    else stopSnapshotRefresh(); // snapshots disabled; placeholder only
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
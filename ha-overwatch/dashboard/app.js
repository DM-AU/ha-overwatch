/* ─── HA-Overwatch Door Pins Module ─────────────────────────────
 * Extracted from app.js as a classic browser script.
 *
 * Load order:
 *   1. modules/ow-utils.js
 *   2. modules/ow-door-pins.js
 *   3. app.js
 *
 * Compatibility design:
 * - Functions intentionally remain global (classic script function declarations).
 * - Function bodies may reference globals declared in app.js (zones, doorPins,
 *   haStates, apiPath, renderZones, renderZonesEditor, etc.). Those references
 *   are resolved at call time after app.js has loaded.
 * - No behaviour change intended in this hotfix beyond restoring camera helpers to app.js.
 */

// ─────────────────────────────────────────────────────────────
// Door pin schema helpers (multi-zone + control-trigger support)
//
// Backward compat:
// - legacy pins may have pin.zone_id (string)
// - new pins use pin.zone_ids (string[])
// - we continue writing pin.zone_id as the first zone for older backends
//
function doorPinZoneIds(pin) {
  if (!pin) return [];
  if (Array.isArray(pin.zone_ids) && pin.zone_ids.length) return pin.zone_ids.filter(Boolean);
  if (pin.zone_id) return [pin.zone_id];
  return [];
}

function doorPinPrimaryZoneId(pin) {
  return doorPinZoneIds(pin)[0] || pin?.zone_id || '';
}

function normalizeDoorPin(pin) {
  if (!pin || typeof pin !== 'object') return pin;
  // Migrate legacy single-zone to multi-zone
  if ((!Array.isArray(pin.zone_ids) || !pin.zone_ids.length) && pin.zone_id) {
    pin.zone_ids = [pin.zone_id];
  }
  if (Array.isArray(pin.zone_ids) && pin.zone_ids.length && !pin.zone_id) {
    pin.zone_id = pin.zone_ids[0];
  }
  // Default new fields
  if (pin.control_counts_as_trigger == null) pin.control_counts_as_trigger = false;
  if (pin.control_trigger_state === undefined) pin.control_trigger_state = null; // null = Auto
  return pin;
}

function inferControlTriggerState(entityId) {
  if (!entityId) return null;
  const domain = String(entityId).split('.')[0];
  if (domain === 'lock')  return 'unlocked';
  if (domain === 'cover') return 'open';
  if (domain === 'switch') return 'on';
  return null;
}

function doorPinWantedControlState(pin) {
  if (!pin?.control_entity) return null;
  const explicit = pin.control_trigger_state;
  if (explicit === null || explicit === undefined || explicit === '') {
    return inferControlTriggerState(pin.control_entity);
  }
  return String(explicit);
}

function doorPinControlTriggered(pin) {
  if (!pin?.control_counts_as_trigger || !pin?.control_entity) return false;
  const wanted = (doorPinWantedControlState(pin) || '').toLowerCase();
  if (!wanted) return false;
  const st = String(haStates?.[pin.control_entity]?.state || '').toLowerCase();
  return st === wanted;
}

function isDoorTriggered(pin) {
  const sensorTrig = !!(pin?.sensor_entity && isEntityTriggered(pin.sensor_entity));
  const controlTrig = doorPinControlTriggered(pin);
  return sensorTrig || controlTrig;
}

function doorPinTriggerSourceEntity(pin) {
  if (pin?.sensor_entity && isEntityTriggered(pin.sensor_entity)) return pin.sensor_entity;
  if (doorPinControlTriggered(pin)) return pin.control_entity;
  return '';
}

// Linked zones popover (used in editor + runtime zone popup)
let _doorLinksPopoverEl = null;
function closeDoorLinksPopover() {
  if (_doorLinksPopoverEl) { _doorLinksPopoverEl.remove(); _doorLinksPopoverEl = null; }
}

function openDoorLinksPopover(pinId, anchorEl) {
  closeDoorLinksPopover();
  const pin = doorPins.find(p => p.id === pinId);
  if (!pin || !anchorEl) return;

  const zids = doorPinZoneIds(pin);
  const rows = zids
    .map(zid => zones.find(z => z.id === zid))
    .filter(Boolean)
    .map(z => `<div style="padding:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">• ${escapeHtml(z.name || z.id)}</div>`)
    .join('') || `<div style="padding:4px 0;color:#666;">No linked zones</div>`;

  const pop = document.createElement('div');
  pop.className = 'ow-door-links-popover';
  pop.style.cssText = 'position:fixed;z-index:9000;background:rgba(14,14,14,0.98);border:1px solid rgba(255,255,255,0.12);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.65);padding:10px 12px;min-width:180px;max-width:260px;color:#e0e0e0;font-size:12px;';
  pop.innerHTML = `
    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#666;margin-bottom:6px;">Linked zones</div>
    <div style="max-height:160px;overflow:auto;">${rows}</div>
    <div style="margin-top:8px;display:flex;justify-content:flex-end;gap:6px;">
      <button id="owDoorLinksEdit" style="background:rgba(0,150,255,0.15);border:1px solid rgba(0,150,255,0.35);color:#4db8ff;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:11px;">Edit door…</button>
      <button id="owDoorLinksClose" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#888;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:11px;">Close</button>
    </div>
  `;

  document.body.appendChild(pop);
  _doorLinksPopoverEl = pop;

  const rect = anchorEl.getBoundingClientRect();
  const pad = 8;
  const w = pop.offsetWidth || 220;
  const h = pop.offsetHeight || 180;
  let left = rect.left;
  let top  = rect.bottom + pad;
  if (left + w > window.innerWidth - 10) left = window.innerWidth - w - 10;
  if (top + h > window.innerHeight - 10) top = rect.top - h - pad;
  if (top < 10) top = 10;
  if (left < 10) left = 10;
  pop.style.left = Math.round(left) + 'px';
  pop.style.top  = Math.round(top) + 'px';

  pop.querySelector('#owDoorLinksClose')?.addEventListener('click', e => { e.stopPropagation(); closeDoorLinksPopover(); });
  pop.querySelector('#owDoorLinksEdit')?.addEventListener('click', e => {
    e.stopPropagation();
    closeDoorLinksPopover();
    if (!editorMode) editorMode = true;
    selectPin('door', pin.id);
    renderZones();
    renderZonesEditor(true);
  });

  setTimeout(() => {
    function outside(e) {
      if (_doorLinksPopoverEl && !_doorLinksPopoverEl.contains(e.target) && e.target !== anchorEl) {
        closeDoorLinksPopover();
        document.removeEventListener('pointerdown', outside, true);
      }
    }
    document.addEventListener('pointerdown', outside, true);
  }, 0);
}

/* ─── DOOR PINS ───────────────────────────────────────────── */
async function loadDoorPins() {
  try {
    const res = await fetch(apiPath("ow/door-pins") + "?v=" + Date.now());
    doorPins = res.ok ? await res.json() : [];
    doorPins.forEach(normalizeDoorPin);
  } catch { doorPins = []; }
}
async function saveDoorPin(pin) {
  normalizeDoorPin(pin);
  const z0 = doorPinPrimaryZoneId(pin);
  if (z0) pin.zone_id = z0;
  await fetch(apiPath("ow/save-door-pin"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pin) });
  showSaveToast('Door / Window');
  try { const h = await fetch(apiPath("ow/health"),{cache:"no-store"}); const d = await h.json(); if(d.dataVersion) _lastDataVersion = d.dataVersion; } catch{}
}
async function deleteDoorPin(id) {
  doorPins = doorPins.filter(p => p.id !== id);
  await fetch(apiPath("ow/delete-door-pin"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
}

function doorPinIsOpen(pin) {
  const state = String(haStates[pin?.sensor_entity]?.state || '').toLowerCase();
  return ['on','open','opening','detected','unlocked'].includes(state);
}
function doorPinDisplayState(pin) {
  if (!pin?.sensor_entity) return '—';
  const raw = String(haStates[pin.sensor_entity]?.state || '—').toLowerCase();
  if (['on','open','opening','detected','unlocked'].includes(raw)) return 'OPEN';
  if (['off','closed','closing','locked'].includes(raw)) return 'CLOSED';
  return raw === '—' ? '—' : raw.toUpperCase();
}
function doorControlInfo(pin) {
  const entityId = pin?.control_entity;
  if (!entityId) return null;
  const domain = entityId.split('.')[0];
  const state = String(haStates[entityId]?.state || '').toLowerCase();
  if (domain === 'lock') { const locked = state === 'locked' || state === 'off'; return { domain, service: locked ? 'unlock' : 'lock', label: locked ? 'Unlock' : 'Lock' }; }
  if (domain === 'cover') { const closed = state === 'closed' || state === 'closing' || state === 'off'; return { domain, service: closed ? 'open_cover' : 'close_cover', label: closed ? 'Open' : 'Close' }; }
  if (domain === 'switch' || domain === 'input_boolean') { const on = state === 'on' || state === 'open' || state === 'opening' || state === 'unlocked'; return { domain, service: on ? 'turn_off' : 'turn_on', label: on ? 'Close' : 'Open' }; }
  if (domain === 'button') return { domain, service: 'press', label: 'Press' };
  return null;
}
function callDoorPinControl(pin) {
  const info = doorControlInfo(pin);
  if (!info || !pin?.control_entity) return;
  _callDomainService(info.domain, info.service, pin.control_entity);
}

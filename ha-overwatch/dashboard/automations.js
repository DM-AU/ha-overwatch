/* ================================================================
 * HA-Overwatch — automations.js
 * Automation Editor: create/edit/delete HA automations from
 * zone-aware triggers, conditions, and actions.
 * Registers itself as window.OW_Automations for app.js to call.
 * ================================================================ */

(function () {
'use strict';

/* ── State ────────────────────────────────────────────────── */
let _panelEl   = null;
let _open      = false;
let _automations = [];   // [{id, name, triggers, conditions, actions, enabled}]
let _editing   = null;   // id of automation being edited, or 'new'
let _draft     = null;   // current draft object
let _haEntities = [];    // [{entity_id, name, domain}] from HA
let _entitiesLoaded = false;

/* ── Helpers ──────────────────────────────────────────────── */
function ow() { return window.OW || {}; }
function zones()  { return ow().zones  || []; }
function groups() { return ow().groups || []; }
function haStates() { return ow().haStates || {}; }
function apiPath(p) { return ow().apiPath ? ow().apiPath(p) : p; }
function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function uid() { return 'auto_' + Math.random().toString(36).slice(2,9); }

/* ── HA Entity Discovery ──────────────────────────────────── */
async function loadHAEntities() {
  if (_entitiesLoaded) return;
  try {
    const states = haStates();
    if (Object.keys(states).length > 0) {
      _haEntities = Object.entries(states).map(([id, s]) => ({
        entity_id: id,
        name: s.attributes?.friendly_name || id.split('.').pop().replace(/_/g,' '),
        domain: id.split('.')[0],
        state: s.state,
      }));
      _entitiesLoaded = true;
      return;
    }
    // Fallback: fetch from HA via proxy
    const r = await fetch(apiPath('ow/ha-states') + '?v=' + Date.now());
    if (r.ok) {
      const data = await r.json();
      _haEntities = Object.entries(data).map(([id, s]) => ({
        entity_id: id,
        name: s.attributes?.friendly_name || id.split('.').pop().replace(/_/g,' '),
        domain: id.split('.')[0],
        state: s.state,
      }));
      _entitiesLoaded = true;
    }
  } catch(e) {
    console.warn('[OW-Auto] Could not load HA entities', e);
  }
}

function entitiesByDomain(...domains) {
  if (_haEntities.length) {
    return _haEntities.filter(e => domains.includes(e.domain));
  }
  // derive from haStates directly
  return Object.entries(haStates())
    .filter(([id]) => domains.includes(id.split('.')[0]))
    .map(([id, s]) => ({
      entity_id: id,
      name: s.attributes?.friendly_name || id.split('.').pop().replace(/_/g,' '),
      domain: id.split('.')[0],
    }));
}

/* Collect ALL entities referenced in zones (sensors, lights, sirens, cameras) */
function zoneEntities(types = ['sensors','lights','sirens','cameras']) {
  const out = new Set();
  zones().forEach(z => {
    types.forEach(t => { (z[t] || []).forEach(e => out.add(e)); });
  });
  return [...out];
}

function sirensFromZones() {
  const s = new Set();
  zones().forEach(z => (z.sirens || []).forEach(e => s.add(e)));
  // also siren pins
  (ow().sirens || []).forEach(p => { if (p.entity_id) s.add(p.entity_id); });
  return [...s];
}

function lightsFromZones() {
  const l = new Set();
  zones().forEach(z => (z.lights || []).forEach(e => l.add(e)));
  (ow().lights || []).forEach(p => { if (p.entity_id) l.add(p.entity_id); });
  return [...l];
}

function notifyServices() {
  return entitiesByDomain('notify').map(e => e.entity_id);
}

function personEntities() {
  return entitiesByDomain('person', 'device_tracker');
}

/* ── Storage (automations.json via server) ────────────────── */
const STORE_FILE = 'config/automations.json';

async function loadAutomations() {
  try {
    const r = await fetch(apiPath('ow/automations') + '?v=' + Date.now());
    if (r.ok) {
      const d = await r.json();
      _automations = Array.isArray(d) ? d : [];
    }
  } catch(e) {
    console.warn('[OW-Auto] Could not load automations', e);
    _automations = [];
  }
}

async function saveAutomations() {
  try {
    await fetch(apiPath('ow/automations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_automations),
    });
  } catch(e) {
    console.warn('[OW-Auto] Could not save automations', e);
  }
}

/* ── Push automation to HA ────────────────────────────────── */
async function pushToHA(auto) {
  try {
    await fetch(apiPath('ow/push-automation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(auto),
    });
  } catch(e) {
    console.warn('[OW-Auto] Could not push automation to HA', e);
  }
}

async function deleteFromHA(autoId) {
  try {
    await fetch(apiPath('ow/delete-automation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: autoId }),
    });
  } catch(e) {
    console.warn('[OW-Auto] Could not delete automation from HA', e);
  }
}

/* ── Draft helpers ────────────────────────────────────────── */
function newDraft() {
  return {
    id: uid(),
    name: '',
    enabled: true,
    triggers: [],
    conditions: [],
    actions: [],
  };
}

function addTrigger(type) {
  const base = { id: uid(), type };
  const defaults = {
    zone:     { zone_ids: [], event: 'triggered' },
    zone_arm: { zone_ids: [], state: 'armed' },
    person:   { entity_ids: [], state: 'home' },
    entity:   { entity_id: '', to: 'on' },
  };
  _draft.triggers.push({ ...base, ...(defaults[type] || {}) });
  renderEditor();
}

function addCondition(type) {
  const base = { id: uid(), type };
  const defaults = {
    time:   { after: '00:00', before: '23:59' },
    entity: { entity_id: '', state: 'on' },
  };
  _draft.conditions.push({ ...base, ...(defaults[type] || {}) });
  renderEditor();
}

function addAction(type) {
  const base = { id: uid(), type };
  const defaults = {
    siren:    { entity_ids: [], service: 'turn_on' },
    light:    { entity_ids: [], service: 'turn_on' },
    notify:   { target: '', message: 'HA-Overwatch alert triggered.' },
    arm:      { service: 'alarm_arm_away', entity_id: '' },
    entity:   { entity_id: '', service: 'turn_on' },
  };
  _draft.actions.push({ ...base, ...(defaults[type] || {}) });
  renderEditor();
}

/* ── Panel Mount ──────────────────────────────────────────── */
function mountPanel() {
  if (_panelEl) return;
  _panelEl = document.createElement('div');
  _panelEl.id = 'owAutoPanel';
  _panelEl.style.cssText = `
    position:fixed; inset:0; z-index:9500;
    background:rgba(8,8,10,0.98);
    display:flex; flex-direction:column;
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;
    font-size:13px; color:#e0e0e0;
    overflow:hidden;
    opacity:0; transition:opacity 0.18s ease;
    pointer-events:none;
  `;
  document.body.appendChild(_panelEl);
}

function unmountPanel() {
  if (_panelEl) { _panelEl.remove(); _panelEl = null; }
}

/* ── Toggle ───────────────────────────────────────────────── */
async function toggle() {
  if (_open) { close(); return; }
  await open();
}

async function open() {
  _open = true;
  mountPanel();
  await loadAutomations();
  await loadHAEntities();
  const btn = document.getElementById('automationsBtn');
  if (btn) btn.classList.add('active');
  renderList();
  requestAnimationFrame(() => {
    _panelEl.style.opacity = '1';
    _panelEl.style.pointerEvents = 'all';
  });
}

function close() {
  _open = false;
  _editing = null;
  _draft = null;
  const btn = document.getElementById('automationsBtn');
  if (btn) btn.classList.remove('active');
  if (_panelEl) {
    _panelEl.style.opacity = '0';
    _panelEl.style.pointerEvents = 'none';
    setTimeout(() => unmountPanel(), 200);
  }
}

/* ── List View ────────────────────────────────────────────── */
function renderList() {
  if (!_panelEl) return;
  const count = _automations.length;

  _panelEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
      padding:16px 20px 14px; border-bottom:1px solid rgba(255,255,255,0.07);
      flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:12px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="opacity:0.7;">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="white" stroke-width="1.8"
            stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
        <span style="font-size:15px;font-weight:600;letter-spacing:0.01em;">Automation Editor</span>
        <span style="font-size:11px;color:#555;background:rgba(255,255,255,0.05);
          border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:2px 8px;">
          ${count} automation${count !== 1 ? 's' : ''}
        </span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="owAutoNewBtn" style="${btnStyle('#0064d2','rgba(0,100,210,0.18)')}">
          + New Automation
        </button>
        <button id="owAutoCloseBtn" style="${btnStyle('rgba(255,255,255,0.08)','rgba(255,255,255,0.05)',true)}">✕ Close</button>
      </div>
    </div>

    <div style="flex:1;overflow-y:auto;padding:20px;" id="owAutoListBody">
      ${count === 0 ? emptyState() : _automations.map(a => autoCard(a)).join('')}
    </div>
  `;

  _panelEl.querySelector('#owAutoNewBtn').onclick = () => {
    _editing = 'new';
    _draft = newDraft();
    renderEditor();
  };
  _panelEl.querySelector('#owAutoCloseBtn').onclick = close;

  _automations.forEach(a => {
    const el = _panelEl.querySelector(`[data-auto-edit="${a.id}"]`);
    if (el) el.onclick = () => {
      _editing = a.id;
      _draft = JSON.parse(JSON.stringify(a));
      renderEditor();
    };
    const del = _panelEl.querySelector(`[data-auto-del="${a.id}"]`);
    if (del) del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${a.name}"?`)) return;
      _automations = _automations.filter(x => x.id !== a.id);
      await saveAutomations();
      await deleteFromHA(a.id);
      renderList();
    };
    const tog = _panelEl.querySelector(`[data-auto-tog="${a.id}"]`);
    if (tog) tog.onclick = async (e) => {
      e.stopPropagation();
      a.enabled = !a.enabled;
      await saveAutomations();
      await pushToHA(a);
      renderList();
    };
  });
}

function autoCard(a) {
  const triggers  = a.triggers?.length  || 0;
  const conditions = a.conditions?.length || 0;
  const actions   = a.actions?.length   || 0;
  const enabled   = a.enabled !== false;

  const summaryParts = [];
  if (triggers)   summaryParts.push(`${triggers} trigger${triggers>1?'s':''}`);
  if (conditions) summaryParts.push(`${conditions} condition${conditions>1?'s':''}`);
  if (actions)    summaryParts.push(`${actions} action${actions>1?'s':''}`);

  return `
    <div data-auto-edit="${escH(a.id)}" style="
      background:rgba(255,255,255,0.03);
      border:1px solid rgba(255,255,255,${enabled ? '0.08' : '0.04'});
      border-radius:10px; padding:14px 16px;
      margin-bottom:8px; cursor:pointer;
      display:flex; align-items:center; gap:12px;
      opacity:${enabled ? 1 : 0.5};
      transition:background 0.12s,border-color 0.12s;
    "
    onmouseenter="this.style.background='rgba(255,255,255,0.05)'"
    onmouseleave="this.style.background='rgba(255,255,255,0.03)'">

      <!-- Lightning bolt -->
      <div style="width:32px;height:32px;border-radius:8px;background:${enabled ? 'rgba(0,100,210,0.2)' : 'rgba(255,255,255,0.05)'};
        display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="${enabled ? '#4db8ff' : '#555'}"
            stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
      </div>

      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${escH(a.name || 'Unnamed Automation')}
        </div>
        <div style="font-size:11px;color:#555;margin-top:2px;">${summaryParts.join(' · ') || 'No steps configured'}</div>
      </div>

      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
        <button data-auto-tog="${escH(a.id)}" title="${enabled ? 'Disable' : 'Enable'}"
          style="background:${enabled ? 'rgba(52,199,89,0.15)' : 'rgba(255,255,255,0.06)'};
          border:1px solid ${enabled ? 'rgba(52,199,89,0.4)' : 'rgba(255,255,255,0.1)'};
          color:${enabled ? '#34c759' : '#555'};border-radius:6px;padding:4px 10px;
          cursor:pointer;font-size:11px;font-weight:600;">
          ${enabled ? 'ON' : 'OFF'}
        </button>
        <button data-auto-del="${escH(a.id)}" title="Delete automation"
          style="background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.2);
          color:#ff453a;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;">
          🗑
        </button>
      </div>
    </div>`;
}

function emptyState() {
  return `
    <div style="text-align:center;padding:60px 20px;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="opacity:0.1;margin-bottom:16px;">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="white" stroke-width="1.5"
          stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <div style="color:rgba(255,255,255,0.15);font-size:14px;margin-bottom:8px;">No automations yet</div>
      <div style="color:rgba(255,255,255,0.08);font-size:12px;">
        Create automations that respond to your zones, sensors, and alarm state.
      </div>
    </div>`;
}

/* ── Editor View ──────────────────────────────────────────── */
function renderEditor() {
  if (!_panelEl || !_draft) return;

  const isNew = _editing === 'new';
  const zoneList = zones();
  const allZoneIds = zoneList.map(z => z.id);

  _panelEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
      padding:16px 20px 14px; border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:10px;">
        <button id="owAutoBackBtn" style="${btnStyle('rgba(255,255,255,0.06)','rgba(255,255,255,0.04)',true)}">
          ← Back
        </button>
        <span style="font-size:14px;font-weight:600;">${isNew ? 'New Automation' : 'Edit Automation'}</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="owAutoSaveBtn" style="${btnStyle('#0064d2','rgba(0,100,210,0.18)')}">
          💾 Save &amp; Push to HA
        </button>
      </div>
    </div>

    <div style="flex:1;overflow-y:auto;padding:0 20px 20px;" id="owAutoEditorBody">

      <!-- Name -->
      <div style="padding:18px 0 12px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <label style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#555;display:block;margin-bottom:6px;">
          Automation Name
        </label>
        <input id="owAutoName" type="text"
          placeholder='e.g. "Alert on front door trigger"'
          value="${escH(_draft.name)}"
          style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);
          border-radius:8px;color:#fff;padding:9px 12px;font-size:13px;outline:none;box-sizing:border-box;"
        />
        <div style="font-size:11px;color:#444;margin-top:4px;">
          Will be saved as: <span style="color:#666;">HA-Overwatch — <span id="owAutoNamePreview">${escH(_draft.name || '…')}</span></span>
        </div>
      </div>

      <!-- TRIGGERS ─────────────────────────────────────── -->
      ${section('⚡ Triggers', 'When this happens…', renderTriggers(zoneList), `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          <button class="ow-add-btn" data-add-trigger="zone">+ Zone event</button>
          <button class="ow-add-btn" data-add-trigger="zone_arm">+ Zone arm/disarm</button>
          <button class="ow-add-btn" data-add-trigger="person">+ Person/device</button>
          <button class="ow-add-btn" data-add-trigger="entity">+ Other entity</button>
        </div>
      `)}

      <!-- CONDITIONS ────────────────────────────────────── -->
      ${section('🔀 Conditions', 'Only if these are true…', renderConditions(), `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          <button class="ow-add-btn" data-add-cond="time">+ Time of day</button>
          <button class="ow-add-btn" data-add-cond="entity">+ Entity state</button>
        </div>
      `)}

      <!-- ACTIONS ───────────────────────────────────────── -->
      ${section('🎯 Actions', 'Then do this…', renderActions(), `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          <button class="ow-add-btn" data-add-action="siren">+ Siren</button>
          <button class="ow-add-btn" data-add-action="light">+ Light</button>
          <button class="ow-add-btn" data-add-action="notify">+ Notify</button>
          <button class="ow-add-btn" data-add-action="arm">+ Arm/Disarm</button>
          <button class="ow-add-btn" data-add-action="entity">+ Other entity</button>
        </div>
      `)}

    </div>
  `;

  // Name input live update
  const nameInput = _panelEl.querySelector('#owAutoName');
  const preview   = _panelEl.querySelector('#owAutoNamePreview');
  nameInput.oninput = () => {
    _draft.name = nameInput.value;
    if (preview) preview.textContent = nameInput.value || '…';
  };

  // Add trigger/condition/action buttons
  _panelEl.querySelectorAll('[data-add-trigger]').forEach(btn => {
    btn.onclick = () => addTrigger(btn.dataset.addTrigger);
  });
  _panelEl.querySelectorAll('[data-add-cond]').forEach(btn => {
    btn.onclick = () => addCondition(btn.dataset.addCond);
  });
  _panelEl.querySelectorAll('[data-add-action]').forEach(btn => {
    btn.onclick = () => addAction(btn.dataset.addAction);
  });

  // Remove buttons
  _panelEl.querySelectorAll('[data-remove-trigger]').forEach(btn => {
    btn.onclick = () => {
      _draft.triggers = _draft.triggers.filter(t => t.id !== btn.dataset.removeTrigger);
      renderEditor();
    };
  });
  _panelEl.querySelectorAll('[data-remove-cond]').forEach(btn => {
    btn.onclick = () => {
      _draft.conditions = _draft.conditions.filter(c => c.id !== btn.dataset.removeCond);
      renderEditor();
    };
  });
  _panelEl.querySelectorAll('[data-remove-action]').forEach(btn => {
    btn.onclick = () => {
      _draft.actions = _draft.actions.filter(a => a.id !== btn.dataset.removeAction);
      renderEditor();
    };
  });

  // Wire trigger fields
  _draft.triggers.forEach(t => wireTriggerFields(t, zoneList));
  _draft.conditions.forEach(c => wireConditionFields(c));
  _draft.actions.forEach(a => wireActionFields(a));

  // Back button
  _panelEl.querySelector('#owAutoBackBtn').onclick = () => {
    _editing = null; _draft = null;
    renderList();
  };

  // Save
  _panelEl.querySelector('#owAutoSaveBtn').onclick = async () => {
    if (!_draft.name.trim()) { alert('Please enter a name for this automation.'); return; }
    const full = { ..._draft, name: _draft.name.trim() };
    if (isNew) {
      _automations.push(full);
    } else {
      const idx = _automations.findIndex(a => a.id === full.id);
      if (idx >= 0) _automations[idx] = full; else _automations.push(full);
    }
    await saveAutomations();
    await pushToHA(full);
    _editing = null; _draft = null;
    renderList();
  };
}

/* ── Trigger Renderers ────────────────────────────────────── */
function renderTriggers(zoneList) {
  if (!_draft.triggers.length) return '<div style="color:#444;font-size:12px;padding:8px 0;">No triggers added. Add at least one below.</div>';
  return _draft.triggers.map(t => triggerCard(t, zoneList)).join('');
}

function triggerCard(t, zoneList) {
  let inner = '';

  if (t.type === 'zone') {
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Zones</label>
        ${zoneMultiSelect(t, zoneList, 'zone_ids', `trig-zone-${t.id}`)}
      </div>
      <div>
        <label style="${labelStyle}">Event</label>
        <select id="trig-event-${t.id}" style="${selectStyle}">
          <option value="triggered"  ${t.event==='triggered'  ?'selected':''}>Sensor triggered (active)</option>
          <option value="cleared"    ${t.event==='cleared'    ?'selected':''}>Sensor cleared (inactive)</option>
        </select>
      </div>`;
  }

  if (t.type === 'zone_arm') {
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Zones</label>
        ${zoneMultiSelect(t, zoneList, 'zone_ids', `trig-zarm-${t.id}`)}
      </div>
      <div>
        <label style="${labelStyle}">State change to</label>
        <select id="trig-armstate-${t.id}" style="${selectStyle}">
          <option value="armed"    ${t.state==='armed'   ?'selected':''}>Armed</option>
          <option value="disarmed" ${t.state==='disarmed'?'selected':''}>Disarmed</option>
        </select>
      </div>`;
  }

  if (t.type === 'person') {
    const persons = personEntities();
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Person / Device Tracker</label>
        ${persons.length
          ? multiEntitySelect(t.entity_ids, persons, `trig-person-${t.id}`)
          : entityInput(`trig-person-entity-${t.id}`, t.entity_ids?.[0] || '', 'e.g. person.john')}
      </div>
      <div>
        <label style="${labelStyle}">State</label>
        <select id="trig-personstate-${t.id}" style="${selectStyle}">
          <option value="home"     ${t.state==='home'    ?'selected':''}>Home</option>
          <option value="not_home" ${t.state==='not_home'?'selected':''}>Away (not home)</option>
        </select>
      </div>`;
  }

  if (t.type === 'entity') {
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Entity ID</label>
        ${entityInput(`trig-entity-${t.id}`, t.entity_id || '', 'e.g. binary_sensor.front_door')}
      </div>
      <div>
        <label style="${labelStyle}">State becomes</label>
        <input id="trig-to-${t.id}" type="text" value="${escH(t.to||'on')}"
          placeholder="on / off / home / …"
          style="${inputStyle}"/>
      </div>`;
  }

  return stepCard(t.id, triggerLabel(t.type), inner, 'trigger', t.id);
}

function triggerLabel(type) {
  return { zone:'Zone Event', zone_arm:'Zone Arm/Disarm', person:'Person/Device', entity:'Entity State' }[type] || type;
}

/* ── Condition Renderers ──────────────────────────────────── */
function renderConditions() {
  if (!_draft.conditions.length) return '<div style="color:#444;font-size:12px;padding:8px 0;">No conditions — automation will always run when triggered.</div>';
  return _draft.conditions.map(c => conditionCard(c)).join('');
}

function conditionCard(c) {
  let inner = '';

  if (c.type === 'time') {
    inner = `
      <div style="display:flex;gap:12px;">
        <div style="flex:1;">
          <label style="${labelStyle}">After</label>
          <input id="cond-after-${c.id}" type="time" value="${escH(c.after||'00:00')}" style="${inputStyle}"/>
        </div>
        <div style="flex:1;">
          <label style="${labelStyle}">Before</label>
          <input id="cond-before-${c.id}" type="time" value="${escH(c.before||'23:59')}" style="${inputStyle}"/>
        </div>
      </div>`;
  }

  if (c.type === 'entity') {
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Entity ID</label>
        ${entityInput(`cond-entity-${c.id}`, c.entity_id || '', 'e.g. input_boolean.night_mode')}
      </div>
      <div>
        <label style="${labelStyle}">Must be in state</label>
        <input id="cond-state-${c.id}" type="text" value="${escH(c.state||'on')}"
          placeholder="on / off / home / …" style="${inputStyle}"/>
      </div>`;
  }

  return stepCard(c.id, conditionLabel(c.type), inner, 'cond', c.id);
}

function conditionLabel(type) {
  return { time:'Time of Day', entity:'Entity State' }[type] || type;
}

/* ── Action Renderers ─────────────────────────────────────── */
function renderActions() {
  if (!_draft.actions.length) return '<div style="color:#444;font-size:12px;padding:8px 0;">No actions added. Add at least one below.</div>';
  return _draft.actions.map(a => actionCard(a)).join('');
}

function actionCard(a) {
  let inner = '';

  if (a.type === 'siren') {
    const sirenOpts = sirensFromZones();
    const extra = entitiesByDomain('siren','switch').filter(e => !sirenOpts.includes(e.entity_id));
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Sirens</label>
        ${sirenOpts.length
          ? multiEntitySelectRaw(a.entity_ids || [], sirenOpts.map(id => ({ entity_id:id, name: id.split('.').pop().replace(/_/g,' ') })), `act-sirens-${a.id}`)
          : entityInput(`act-sirens-${a.id}`, (a.entity_ids||[]).join(', '), 'siren.entity_id')}
        ${extra.length ? `<div style="margin-top:6px;"><label style="${labelStyle}">Other sirens/switches</label>${multiEntitySelect(a.entity_ids_extra||[], extra, `act-sirens-extra-${a.id}`)}</div>` : ''}
      </div>
      <div>
        <label style="${labelStyle}">Action</label>
        <select id="act-siren-svc-${a.id}" style="${selectStyle}">
          <option value="turn_on"  ${a.service==='turn_on' ?'selected':''}>Turn ON (activate)</option>
          <option value="turn_off" ${a.service==='turn_off'?'selected':''}>Turn OFF (silence)</option>
          <option value="toggle"   ${a.service==='toggle'  ?'selected':''}>Toggle</option>
        </select>
      </div>`;
  }

  if (a.type === 'light') {
    const lightOpts = lightsFromZones();
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Lights</label>
        ${lightOpts.length
          ? multiEntitySelectRaw(a.entity_ids || [], lightOpts.map(id => ({ entity_id:id, name: id.split('.').pop().replace(/_/g,' ') })), `act-lights-${a.id}`)
          : entityInput(`act-lights-${a.id}`, (a.entity_ids||[]).join(', '), 'light.entity_id')}
      </div>
      <div>
        <label style="${labelStyle}">Action</label>
        <select id="act-light-svc-${a.id}" style="${selectStyle}">
          <option value="turn_on"  ${a.service==='turn_on' ?'selected':''}>Turn ON</option>
          <option value="turn_off" ${a.service==='turn_off'?'selected':''}>Turn OFF</option>
          <option value="toggle"   ${a.service==='toggle'  ?'selected':''}>Toggle</option>
        </select>
      </div>`;
  }

  if (a.type === 'notify') {
    const notifyOpts = notifyServices();
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Notification Service</label>
        ${notifyOpts.length
          ? `<select id="act-notify-target-${a.id}" style="${selectStyle}">
              ${notifyOpts.map(n => `<option value="${escH(n)}" ${a.target===n?'selected':''}>${escH(n.replace('notify.',''))}</option>`).join('')}
              <option value="notify.notify" ${a.target==='notify.notify'?'selected':''}>notify.notify (default)</option>
            </select>`
          : entityInput(`act-notify-target-${a.id}`, a.target || 'notify.notify', 'notify.mobile_app_...')}
      </div>
      <div>
        <label style="${labelStyle}">Message</label>
        <textarea id="act-notify-msg-${a.id}" rows="2"
          placeholder="Alert message…"
          style="${inputStyle}resize:vertical;">${escH(a.message||'')}</textarea>
      </div>
      <div style="margin-top:8px;">
        <label style="${labelStyle}">Title (optional)</label>
        <input id="act-notify-title-${a.id}" type="text" value="${escH(a.title||'')}"
          placeholder="HA-Overwatch Alert" style="${inputStyle}"/>
      </div>`;
  }

  if (a.type === 'arm') {
    const alarmEntity = (ow().uiConfig?.alarm_entity) || '';
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Alarm Panel Entity</label>
        ${entityInput(`act-arm-entity-${a.id}`, a.entity_id || alarmEntity, 'alarm_control_panel.home_alarm')}
      </div>
      <div>
        <label style="${labelStyle}">Action</label>
        <select id="act-arm-svc-${a.id}" style="${selectStyle}">
          <option value="alarm_arm_away"  ${a.service==='alarm_arm_away' ?'selected':''}>Arm Away</option>
          <option value="alarm_arm_home"  ${a.service==='alarm_arm_home' ?'selected':''}>Arm Home</option>
          <option value="alarm_arm_night" ${a.service==='alarm_arm_night'?'selected':''}>Arm Night</option>
          <option value="alarm_disarm"    ${a.service==='alarm_disarm'   ?'selected':''}>Disarm</option>
        </select>
      </div>`;
  }

  if (a.type === 'entity') {
    inner = `
      <div style="margin-bottom:8px;">
        <label style="${labelStyle}">Entity ID</label>
        ${entityInput(`act-entity-id-${a.id}`, a.entity_id || '', 'e.g. switch.garage_light')}
      </div>
      <div>
        <label style="${labelStyle}">Service</label>
        <select id="act-entity-svc-${a.id}" style="${selectStyle}">
          <option value="turn_on"  ${a.service==='turn_on' ?'selected':''}>turn_on</option>
          <option value="turn_off" ${a.service==='turn_off'?'selected':''}>turn_off</option>
          <option value="toggle"   ${a.service==='toggle'  ?'selected':''}>toggle</option>
        </select>
      </div>`;
  }

  return stepCard(a.id, actionLabel(a.type), inner, 'action', a.id);
}

function actionLabel(type) {
  return { siren:'Siren', light:'Light', notify:'Notify', arm:'Arm/Disarm Alarm', entity:'Other Entity' }[type] || type;
}

/* ── Field Wiring ─────────────────────────────────────────── */
function wireTriggerFields(t, zoneList) {
  if (t.type === 'zone') {
    wireZoneMultiSelect(t, zoneList, 'zone_ids', `trig-zone-${t.id}`);
    wireSelect(`trig-event-${t.id}`, v => t.event = v);
  }
  if (t.type === 'zone_arm') {
    wireZoneMultiSelect(t, zoneList, 'zone_ids', `trig-zarm-${t.id}`);
    wireSelect(`trig-armstate-${t.id}`, v => t.state = v);
  }
  if (t.type === 'person') {
    wireSelect(`trig-personstate-${t.id}`, v => t.state = v);
    const inp = _panelEl.querySelector(`#trig-person-entity-${t.id}`);
    if (inp) inp.oninput = () => { t.entity_ids = inp.value.split(',').map(s => s.trim()).filter(Boolean); };
    wireMultiCheckbox(`trig-person-${t.id}`, ids => t.entity_ids = ids);
  }
  if (t.type === 'entity') {
    const inp = _panelEl.querySelector(`#trig-entity-${t.id}`);
    if (inp) inp.oninput = () => { t.entity_id = inp.value.trim(); };
    wireInput(`trig-to-${t.id}`, v => t.to = v);
  }
}

function wireConditionFields(c) {
  if (c.type === 'time') {
    wireInput(`cond-after-${c.id}`,  v => c.after  = v);
    wireInput(`cond-before-${c.id}`, v => c.before = v);
  }
  if (c.type === 'entity') {
    const inp = _panelEl.querySelector(`#cond-entity-${c.id}`);
    if (inp) inp.oninput = () => { c.entity_id = inp.value.trim(); };
    wireInput(`cond-state-${c.id}`, v => c.state = v);
  }
}

function wireActionFields(a) {
  if (a.type === 'siren') {
    wireMultiCheckbox(`act-sirens-${a.id}`, ids => a.entity_ids = ids);
    wireMultiCheckbox(`act-sirens-extra-${a.id}`, ids => a.entity_ids_extra = ids);
    wireSelect(`act-siren-svc-${a.id}`, v => a.service = v);
  }
  if (a.type === 'light') {
    wireMultiCheckbox(`act-lights-${a.id}`, ids => a.entity_ids = ids);
    wireSelect(`act-light-svc-${a.id}`, v => a.service = v);
  }
  if (a.type === 'notify') {
    wireSelect(`act-notify-target-${a.id}`, v => a.target = v);
    const inp = _panelEl.querySelector(`#act-notify-target-${a.id}`);
    if (inp && inp.tagName === 'INPUT') inp.oninput = () => { a.target = inp.value.trim(); };
    const msg = _panelEl.querySelector(`#act-notify-msg-${a.id}`);
    if (msg) msg.oninput = () => { a.message = msg.value; };
    wireInput(`act-notify-title-${a.id}`, v => a.title = v);
  }
  if (a.type === 'arm') {
    const inp = _panelEl.querySelector(`#act-arm-entity-${a.id}`);
    if (inp) inp.oninput = () => { a.entity_id = inp.value.trim(); };
    wireSelect(`act-arm-svc-${a.id}`, v => a.service = v);
  }
  if (a.type === 'entity') {
    const inp = _panelEl.querySelector(`#act-entity-id-${a.id}`);
    if (inp) inp.oninput = () => { a.entity_id = inp.value.trim(); };
    wireSelect(`act-entity-svc-${a.id}`, v => a.service = v);
  }
}

/* ── Input helpers ────────────────────────────────────────── */
function wireSelect(id, fn) {
  const el = _panelEl?.querySelector(`#${id}`);
  if (el) el.onchange = () => fn(el.value);
}
function wireInput(id, fn) {
  const el = _panelEl?.querySelector(`#${id}`);
  if (el) el.oninput = () => fn(el.value);
}
function wireMultiCheckbox(id, fn) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;
  const checkboxes = el.querySelectorAll('input[type=checkbox]');
  checkboxes.forEach(cb => {
    cb.onchange = () => fn([...checkboxes].filter(c => c.checked).map(c => c.value));
  });
}

/* ── Zone multi-select widget ─────────────────────────────── */
function zoneMultiSelect(t, zoneList, field, id) {
  const selected = t[field] || [];
  const allSelected = zoneList.length > 0 && zoneList.every(z => selected.includes(z.id));

  return `<div id="${escH(id)}" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
    border-radius:8px;padding:10px;max-height:160px;overflow-y:auto;">
    <label style="display:flex;align-items:center;gap:8px;padding-bottom:6px;
      border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:6px;cursor:pointer;">
      <input type="checkbox" data-all="1" ${allSelected ? 'checked' : ''} style="accent-color:#0064d2;">
      <span style="font-size:11px;font-weight:600;color:#aaa;">All Zones</span>
    </label>
    ${zoneList.map(z => `
      <label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;">
        <input type="checkbox" value="${escH(z.id)}" ${selected.includes(z.id) ? 'checked' : ''} style="accent-color:#0064d2;">
        <span style="font-size:12px;">${escH(z.name || z.id)}</span>
      </label>`).join('')}
    ${zoneList.length === 0 ? '<div style="color:#444;font-size:11px;">No zones configured</div>' : ''}
  </div>`;
}

function wireZoneMultiSelect(t, zoneList, field, id) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;
  const allCb   = el.querySelector('[data-all]');
  const zoneCbs = el.querySelectorAll('input[value]');

  function collectSelected() {
    return [...zoneCbs].filter(c => c.checked).map(c => c.value);
  }
  if (allCb) {
    allCb.onchange = () => {
      zoneCbs.forEach(cb => cb.checked = allCb.checked);
      t[field] = allCb.checked ? zoneList.map(z => z.id) : [];
    };
  }
  zoneCbs.forEach(cb => {
    cb.onchange = () => {
      t[field] = collectSelected();
      if (allCb) allCb.checked = zoneList.length > 0 && zoneList.every(z => t[field].includes(z.id));
    };
  });
}

/* ── Generic multi-entity select ─────────────────────────── */
function multiEntitySelect(selectedIds, entities, id) {
  return multiEntitySelectRaw(selectedIds, entities, id);
}

function multiEntitySelectRaw(selectedIds, entities, id) {
  if (!entities.length) return `<div style="color:#444;font-size:11px;">No entities found</div>`;
  return `<div id="${escH(id)}" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
    border-radius:8px;padding:8px;max-height:120px;overflow-y:auto;">
    ${entities.map(e => `
      <label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;">
        <input type="checkbox" value="${escH(e.entity_id)}"
          ${(selectedIds||[]).includes(e.entity_id) ? 'checked' : ''}
          style="accent-color:#0064d2;">
        <span style="font-size:12px;">${escH(e.name || e.entity_id.split('.').pop())}</span>
        <span style="font-size:10px;color:#444;">${escH(e.entity_id)}</span>
      </label>`).join('')}
  </div>`;
}

/* ── Entity text input with autocomplete hint ─────────────── */
function entityInput(id, value, placeholder) {
  return `<input id="${escH(id)}" type="text" value="${escH(value)}"
    placeholder="${escH(placeholder)}"
    style="${inputStyle}" autocomplete="off" spellcheck="false"/>`;
}

/* ── Step card wrapper ────────────────────────────────────── */
function stepCard(id, label, inner, removeType, removeId) {
  const colorMap = { trigger:'#0064d2', cond:'#9b59b6', action:'#27ae60' };
  const color = colorMap[removeType] || '#555';
  const removeAttr = {
    trigger: `data-remove-trigger="${escH(removeId)}"`,
    cond:    `data-remove-cond="${escH(removeId)}"`,
    action:  `data-remove-action="${escH(removeId)}"`,
  }[removeType] || '';

  return `
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);
      border-left:3px solid ${color}; border-radius:8px;padding:12px 14px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;
          letter-spacing:0.08em;color:${color};">${escH(label)}</span>
        <button ${removeAttr}
          style="background:none;border:none;color:#444;cursor:pointer;font-size:14px;padding:0 2px;line-height:1;"
          title="Remove">✕</button>
      </div>
      ${inner}
    </div>`;
}

/* ── Section wrapper ──────────────────────────────────────── */
function section(title, subtitle, body, addButtons) {
  return `
    <div style="padding:18px 0 0;">
      <div style="font-size:13px;font-weight:600;margin-bottom:2px;">${title}</div>
      <div style="font-size:11px;color:#555;margin-bottom:10px;">${subtitle}</div>
      <div id="owAutoSection-${title.replace(/\W/g,'')}">${body}</div>
      ${addButtons}
    </div>`;
}

/* ── Shared style strings ─────────────────────────────────── */
const labelStyle = 'display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#555;margin-bottom:4px;';
const selectStyle = `background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);
  border-radius:7px;color:#e0e0e0;padding:7px 10px;font-size:12px;width:100%;outline:none;`;
const inputStyle = `width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);
  border-radius:7px;color:#fff;padding:7px 10px;font-size:12px;outline:none;box-sizing:border-box;`;

function btnStyle(bg, border, ghost = false) {
  return `background:${bg};border:1px solid ${ghost ? 'rgba(255,255,255,0.1)' : border};
    color:${ghost ? '#aaa' : '#fff'};border-radius:8px;padding:7px 14px;cursor:pointer;
    font-size:12px;font-weight:600;`;
}

/* ── CSS injection for ow-add-btn ─────────────────────────── */
function injectStyles() {
  if (document.getElementById('ow-auto-styles')) return;
  const style = document.createElement('style');
  style.id = 'ow-auto-styles';
  style.textContent = `
    .ow-add-btn {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      color: #aaa;
      border-radius: 7px;
      padding: 5px 12px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.1s, color 0.1s;
    }
    .ow-add-btn:hover {
      background: rgba(255,255,255,0.1);
      color: #fff;
    }
  `;
  document.head.appendChild(style);
}

/* ── Search integration ───────────────────────────────────── */
// Expose automations to OW search bar
function searchAutomations(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  return _automations
    .filter(a => a.name.toLowerCase().includes(q))
    .map(a => ({
      type: 'automation',
      id: a.id,
      label: `⚡ ${a.name}`,
      sublabel: [a.triggers?.length && `${a.triggers.length} trigger(s)`,
                 a.actions?.length  && `${a.actions.length} action(s)`].filter(Boolean).join(' · '),
      action: () => {
        if (!_open) open();
        _editing = a.id;
        _draft = JSON.parse(JSON.stringify(a));
        renderEditor();
      },
    }));
}

/* ── Init ─────────────────────────────────────────────────── */
function init() {
  injectStyles();

  // Register search results provider with app.js
  if (window.OW) {
    window.OW.automationSearch = searchAutomations;
  } else {
    // OW not ready yet — hook in after a tick
    setTimeout(() => {
      if (window.OW) window.OW.automationSearch = searchAutomations;
    }, 1000);
  }
}

/* ── Public API ───────────────────────────────────────────── */
window.OW_Automations = { toggle, open, close, searchAutomations };

// Auto-init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
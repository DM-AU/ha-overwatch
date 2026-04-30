/* ================================================================
 * HA-Overwatch — automations.js
 * Automation Editor: create/edit/delete HA automations from
 * zone-aware triggers, conditions, and actions.
 * Registers itself as window.OW_Automations for app.js to call.
 *
 * Admin only — hidden from IS_DIRECT_MODE users by app.js.
 * ================================================================ */

(function () {
'use strict';

/* ── State ────────────────────────────────────────────────── */
let _panelEl     = null;
let _open        = false;
let _automations = [];
let _editing     = null;
let _draft       = null;
let _haEntities  = [];
let _entitiesLoaded = false;

/* ── Admin guard ──────────────────────────────────────────── */
function isAdmin() {
  return !document.querySelector('meta[name="ow-direct"]');
}

/* ── Helpers ──────────────────────────────────────────────── */
function ow()       { return window.OW || {}; }
function zones()    { return ow().zones  || []; }
function haStates() { return ow().haStates || {}; }
function apiPath(p) { return ow().apiPath ? ow().apiPath(p) : p; }
function escH(s)    { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function uid()      { return 'auto_' + Math.random().toString(36).slice(2,9); }

/* ── HA Entity Discovery ──────────────────────────────────── */
async function loadHAEntities() {
  const states = haStates();
  if (Object.keys(states).length > 0) {
    _haEntities = Object.entries(states).map(([id, s]) => ({
      entity_id: id,
      name:   s.attributes?.friendly_name || id.split('.').pop().replace(/_/g,' '),
      domain: id.split('.')[0],
      state:  s.state,
    })).sort((a,b) => a.entity_id.localeCompare(b.entity_id));
    _entitiesLoaded = true;
    return;
  }
  try {
    const r = await fetch(apiPath('ow/ha-states') + '?v=' + Date.now());
    if (r.ok) {
      const data = await r.json();
      _haEntities = Object.entries(data).map(([id, s]) => ({
        entity_id: id,
        name:   s.attributes?.friendly_name || id.split('.').pop().replace(/_/g,' '),
        domain: id.split('.')[0],
        state:  s.state,
      })).sort((a,b) => a.entity_id.localeCompare(b.entity_id));
      _entitiesLoaded = true;
    }
  } catch(e) { console.warn('[OW-Auto] Could not load HA entities', e); }
}

function entitiesByDomain(...domains) {
  const src = _haEntities.length ? _haEntities : Object.entries(haStates()).map(([id,s]) => ({
    entity_id: id, domain: id.split('.')[0],
    name: s.attributes?.friendly_name || id.split('.').pop().replace(/_/g,' '),
    state: s.state,
  }));
  return src.filter(e => domains.includes(e.domain));
}

function allEntities() {
  if (_haEntities.length) return _haEntities;
  return Object.entries(haStates()).map(([id,s]) => ({
    entity_id: id, domain: id.split('.')[0],
    name: s.attributes?.friendly_name || id.split('.').pop().replace(/_/g,' '),
    state: s.state,
  }));
}

function sirensFromZones() {
  const s = new Set();
  zones().forEach(z => (z.sirens||[]).forEach(e => s.add(e)));
  (ow().sirens||[]).forEach(p => { if (p.entity_id) s.add(p.entity_id); });
  return [...s];
}

function lightsFromZones() {
  const l = new Set();
  zones().forEach(z => (z.lights||[]).forEach(e => l.add(e)));
  (ow().lights||[]).forEach(p => { if (p.entity_id) l.add(p.entity_id); });
  return [...l];
}

function notifyServices() { return entitiesByDomain('notify').map(e => e.entity_id); }

/* ── Storage ──────────────────────────────────────────────── */
async function loadAutomations() {
  try {
    const r = await fetch(apiPath('ow/automations') + '?v=' + Date.now());
    if (r.ok) { const d = await r.json(); _automations = Array.isArray(d) ? d : []; }
  } catch(e) { console.warn('[OW-Auto] Could not load automations', e); _automations = []; }
}

async function saveAutomations() {
  try {
    await fetch(apiPath('ow/automations'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_automations),
    });
  } catch(e) { console.warn('[OW-Auto] Could not save', e); }
}

async function pushToHA(auto) {
  try {
    await fetch(apiPath('ow/push-automation'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(auto),
    });
  } catch(e) { console.warn('[OW-Auto] Could not push to HA', e); }
}

async function deleteFromHA(autoId) {
  try {
    await fetch(apiPath('ow/delete-automation'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: autoId }),
    });
  } catch(e) { console.warn('[OW-Auto] Could not delete from HA', e); }
}

/* ── Draft helpers ────────────────────────────────────────── */
function newDraft() {
  return { id: uid(), name: '', enabled: true, triggers: [], conditions: [], actions: [] };
}

function addTrigger(type) {
  const defaults = {
    zone:     { zone_ids: [], event: 'triggered' },
    zone_arm: { zone_ids: [], state: 'armed' },
    person:   { entity_ids: [], state: 'home' },
    device:   { entity_ids: [], state: 'home' },
    entity:   { entity_id: '', to: 'on' },
  };
  _draft.triggers.push({ id: uid(), type, ...(defaults[type]||{}) });
  renderEditor();
}

function addCondition(type) {
  const defaults = {
    time:   { time_mode: 'manual', after: '00:00', before: '23:59', time_entity: '' },
    entity: { entity_id: '', state: 'on' },
  };
  _draft.conditions.push({ id: uid(), type, ...(defaults[type]||{}) });
  renderEditor();
}

function addAction(type) {
  const defaults = {
    siren:  { entity_ids: [], service: 'turn_on' },
    light:  { entity_ids: [], service: 'turn_on' },
    notify: { target: '', message: 'HA-Overwatch alert triggered.', title: '' },
    arm:    { service: 'alarm_arm_away', entity_id: '' },
    entity: { entity_id: '', service: 'turn_on' },
  };
  _draft.actions.push({ id: uid(), type, ...(defaults[type]||{}) });
  renderEditor();
}

/* ── Panel Mount / Unmount ────────────────────────────────── */
function mountPanel() {
  if (_panelEl) return;
  _panelEl = document.createElement('div');
  _panelEl.id = 'owAutoPanel';
  _panelEl.style.cssText = `
    position:fixed; inset:0; z-index:9500;
    background:rgba(8,8,10,0.98);
    display:flex; flex-direction:column;
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;
    font-size:13px; color:#e0e0e0; overflow:hidden;
    opacity:0; transition:opacity 0.18s ease; pointer-events:none;
  `;
  document.body.appendChild(_panelEl);
}

function unmountPanel() {
  if (_panelEl) { _panelEl.remove(); _panelEl = null; }
}

/* ── Toggle / Open / Close ────────────────────────────────── */
async function toggle() { if (_open) { close(); return; } await open(); }

async function open() {
  if (!isAdmin()) { console.warn('[OW-Auto] Admin only.'); return; }
  _open = true;
  mountPanel();
  await loadAutomations();
  await loadHAEntities();
  document.getElementById('automationsBtn')?.classList.add('active');
  renderList();
  requestAnimationFrame(() => { _panelEl.style.opacity = '1'; _panelEl.style.pointerEvents = 'all'; });
}

function close() {
  _open = false; _editing = null; _draft = null;
  document.getElementById('automationsBtn')?.classList.remove('active');
  if (_panelEl) {
    _panelEl.style.opacity = '0'; _panelEl.style.pointerEvents = 'none';
    setTimeout(() => unmountPanel(), 200);
  }
}

/* ════════════════════════════════════════════════════════════
 * LIST VIEW
 * ═══════════════════════════════════════════════════════════ */
function renderList() {
  if (!_panelEl) return;
  const count = _automations.length;
  _panelEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
      padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:12px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="opacity:0.7;">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="white" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
        <span style="font-size:15px;font-weight:600;">Automation Editor</span>
        <span style="font-size:11px;color:#555;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:2px 8px;">
          ${count} automation${count!==1?'s':''}
        </span>
        <span style="font-size:10px;color:#444;background:rgba(255,149,0,0.1);border:1px solid rgba(255,149,0,0.2);border-radius:6px;padding:2px 7px;">Admin only</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="owAutoNewBtn" style="${btnStyle('#0064d2','rgba(0,100,210,0.18)')}">+ New Automation</button>
        <button id="owAutoCloseBtn" style="${btnStyle('rgba(255,255,255,0.08)','rgba(255,255,255,0.05)',true)}">✕ Close</button>
      </div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:20px;">
      ${count === 0 ? emptyState() : _automations.map(autoCard).join('')}
    </div>`;

  _panelEl.querySelector('#owAutoNewBtn').onclick = () => { _editing='new'; _draft=newDraft(); renderEditor(); };
  _panelEl.querySelector('#owAutoCloseBtn').onclick = close;

  _automations.forEach(a => {
    _panelEl.querySelector(`[data-auto-edit="${a.id}"]`)?.addEventListener('click', () => {
      _editing=a.id; _draft=JSON.parse(JSON.stringify(a)); renderEditor();
    });
    _panelEl.querySelector(`[data-auto-del="${a.id}"]`)?.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${a.name}"?`)) return;
      _automations = _automations.filter(x => x.id !== a.id);
      await saveAutomations(); await deleteFromHA(a.id); renderList();
    });
    _panelEl.querySelector(`[data-auto-tog="${a.id}"]`)?.addEventListener('click', async e => {
      e.stopPropagation();
      a.enabled = !a.enabled;
      await saveAutomations(); await pushToHA(a); renderList();
    });
  });
}

function autoCard(a) {
  const enabled = a.enabled !== false;
  const parts = [
    a.triggers?.length   && `${a.triggers.length} trigger${a.triggers.length>1?'s':''}`,
    a.conditions?.length && `${a.conditions.length} condition${a.conditions.length>1?'s':''}`,
    a.actions?.length    && `${a.actions.length} action${a.actions.length>1?'s':''}`,
  ].filter(Boolean);
  return `
    <div data-auto-edit="${escH(a.id)}" style="
      background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,${enabled?'0.08':'0.04'});
      border-radius:10px;padding:14px 16px;margin-bottom:8px;cursor:pointer;
      display:flex;align-items:center;gap:12px;opacity:${enabled?1:0.5};transition:background 0.12s;"
      onmouseenter="this.style.background='rgba(255,255,255,0.05)'"
      onmouseleave="this.style.background='rgba(255,255,255,0.03)'">
      <div style="width:32px;height:32px;border-radius:8px;flex-shrink:0;
        background:${enabled?'rgba(0,100,210,0.2)':'rgba(255,255,255,0.05)'};
        display:flex;align-items:center;justify-content:center;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="${enabled?'#4db8ff':'#555'}"
            stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${escH(a.name||'Unnamed Automation')}
        </div>
        <div style="font-size:11px;color:#555;margin-top:2px;">${parts.join(' · ')||'No steps configured'}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
        <button data-auto-tog="${escH(a.id)}"
          style="background:${enabled?'rgba(52,199,89,0.15)':'rgba(255,255,255,0.06)'};
          border:1px solid ${enabled?'rgba(52,199,89,0.4)':'rgba(255,255,255,0.1)'};
          color:${enabled?'#34c759':'#555'};border-radius:6px;padding:4px 10px;
          cursor:pointer;font-size:11px;font-weight:600;">${enabled?'ON':'OFF'}</button>
        <button data-auto-del="${escH(a.id)}"
          style="background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.2);
          color:#ff453a;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;">🗑</button>
      </div>
    </div>`;
}

function emptyState() {
  return `<div style="text-align:center;padding:60px 20px;">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="opacity:0.1;margin-bottom:16px;">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="white" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div style="color:rgba(255,255,255,0.15);font-size:14px;margin-bottom:8px;">No automations yet</div>
    <div style="color:rgba(255,255,255,0.08);font-size:12px;">Create automations that respond to your zones, sensors, and alarm state.</div>
  </div>`;
}

/* ════════════════════════════════════════════════════════════
 * EDITOR VIEW
 * ═══════════════════════════════════════════════════════════ */
function renderEditor() {
  if (!_panelEl || !_draft) return;
  const isNew = _editing === 'new';
  const zoneList = zones();

  _panelEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
      padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:10px;">
        <button id="owAutoBackBtn" style="${btnStyle('rgba(255,255,255,0.06)','rgba(255,255,255,0.04)',true)}">← Back</button>
        <span style="font-size:14px;font-weight:600;">${isNew?'New Automation':'Edit Automation'}</span>
      </div>
      <button id="owAutoSaveBtn" style="${btnStyle('#0064d2','rgba(0,100,210,0.18)')}">💾 Save &amp; Push to HA</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:0 20px 40px;">

      <!-- Name -->
      <div style="padding:18px 0 14px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <label style="${labelStyle}">Automation Name</label>
        <input id="owAutoName" type="text"
          placeholder='e.g. "Alert on front door trigger"'
          value="${escH(_draft.name)}"
          style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);
          border-radius:8px;color:#fff;padding:9px 12px;font-size:13px;outline:none;box-sizing:border-box;"/>
        <div style="font-size:11px;color:#444;margin-top:5px;">
          Saved as: <span style="color:#555;">HA-Overwatch — <span id="owAutoNamePreview">${escH(_draft.name||'…')}</span></span>
        </div>
      </div>

      ${editorSection('⚡','Triggers','When this happens…',
        _draft.triggers.map(t=>triggerCard(t,zoneList)).join('')||emptyStepMsg('No triggers added. Add at least one below.'),
        `<button class="ow-add-btn" data-add-trigger="zone">+ Zone event</button>
         <button class="ow-add-btn" data-add-trigger="zone_arm">+ Zone arm/disarm</button>
         <button class="ow-add-btn" data-add-trigger="person">+ Person</button>
         <button class="ow-add-btn" data-add-trigger="device">+ Device tracker</button>
         <button class="ow-add-btn" data-add-trigger="entity">+ Entity state</button>`
      )}

      ${editorSection('🔀','Conditions','Only if these are true…',
        _draft.conditions.map(c=>conditionCard(c)).join('')||emptyStepMsg('No conditions — automation always runs when triggered.'),
        `<button class="ow-add-btn" data-add-cond="time">+ Time of day</button>
         <button class="ow-add-btn" data-add-cond="entity">+ Entity state</button>`
      )}

      ${editorSection('🎯','Actions','Then do this…',
        _draft.actions.map(a=>actionCard(a)).join('')||emptyStepMsg('No actions added. Add at least one below.'),
        `<button class="ow-add-btn" data-add-action="siren">+ Siren</button>
         <button class="ow-add-btn" data-add-action="light">+ Light</button>
         <button class="ow-add-btn" data-add-action="notify">+ Notify</button>
         <button class="ow-add-btn" data-add-action="arm">+ Arm/Disarm</button>
         <button class="ow-add-btn" data-add-action="entity">+ Other entity</button>`
      )}
    </div>`;

  // Name
  const nameEl = _panelEl.querySelector('#owAutoName');
  const previewEl = _panelEl.querySelector('#owAutoNamePreview');
  nameEl.oninput = () => { _draft.name = nameEl.value; if (previewEl) previewEl.textContent = nameEl.value||'…'; };

  // Add / remove buttons
  _panelEl.querySelectorAll('[data-add-trigger]').forEach(b => b.onclick = () => addTrigger(b.dataset.addTrigger));
  _panelEl.querySelectorAll('[data-add-cond]').forEach(b    => b.onclick = () => addCondition(b.dataset.addCond));
  _panelEl.querySelectorAll('[data-add-action]').forEach(b  => b.onclick = () => addAction(b.dataset.addAction));
  _panelEl.querySelectorAll('[data-remove-trigger]').forEach(b => b.onclick = () => {
    _draft.triggers = _draft.triggers.filter(t => t.id !== b.dataset.removeTrigger); renderEditor();
  });
  _panelEl.querySelectorAll('[data-remove-cond]').forEach(b => b.onclick = () => {
    _draft.conditions = _draft.conditions.filter(c => c.id !== b.dataset.removeCond); renderEditor();
  });
  _panelEl.querySelectorAll('[data-remove-action]').forEach(b => b.onclick = () => {
    _draft.actions = _draft.actions.filter(a => a.id !== b.dataset.removeAction); renderEditor();
  });

  // Wire all fields + autocompletes
  _draft.triggers.forEach(t  => wireTriggerFields(t, zoneList));
  _draft.conditions.forEach(c => wireConditionFields(c));
  _draft.actions.forEach(a   => wireActionFields(a));
  _panelEl.querySelectorAll('[data-entity-autocomplete]').forEach(w => bindEntityAutocomplete(w));

  _panelEl.querySelector('#owAutoBackBtn').onclick = () => { _editing=null; _draft=null; renderList(); };
  _panelEl.querySelector('#owAutoSaveBtn').onclick = async () => {
    if (!_draft.name.trim()) { alert('Please enter a name for this automation.'); return; }
    const full = { ..._draft, name: _draft.name.trim() };
    if (isNew) { _automations.push(full); }
    else {
      const idx = _automations.findIndex(a => a.id === full.id);
      if (idx >= 0) _automations[idx] = full; else _automations.push(full);
    }
    await saveAutomations(); await pushToHA(full);
    _editing=null; _draft=null; renderList();
  };
}

/* ════════════════════════════════════════════════════════════
 * TRIGGER CARDS
 * ═══════════════════════════════════════════════════════════ */
function triggerCard(t, zoneList) {
  let inner = '';

  if (t.type === 'zone') {
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Zones</label>
        ${zoneMultiSelect(t, zoneList, 'zone_ids', `trig-zone-${t.id}`)}
      </div>
      <div>
        <label style="${labelStyle}">Event</label>
        <select id="trig-event-${t.id}" style="${selectStyle}">
          <option value="triggered" ${t.event==='triggered'?'selected':''}>Sensor triggered (active)</option>
          <option value="cleared"   ${t.event==='cleared'  ?'selected':''}>Sensor cleared (inactive)</option>
        </select>
      </div>`;
  }

  if (t.type === 'zone_arm') {
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Zones</label>
        ${zoneMultiSelect(t, zoneList, 'zone_ids', `trig-zarm-${t.id}`)}
      </div>
      <div>
        <label style="${labelStyle}">State changes to</label>
        <select id="trig-armstate-${t.id}" style="${selectStyle}">
          <option value="armed"    ${t.state==='armed'   ?'selected':''}>Armed</option>
          <option value="disarmed" ${t.state==='disarmed'?'selected':''}>Disarmed</option>
        </select>
      </div>`;
  }

  if (t.type === 'person') {
    const persons = entitiesByDomain('person');
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Person</label>
        ${persons.length
          ? multiEntitySelectRaw(t.entity_ids||[], persons, `trig-person-${t.id}`)
          : entityAutocomplete(`trig-person-ac-${t.id}`, t.entity_ids?.[0]||'', 'person.*', 'person', ['person'])}
      </div>
      <div>
        <label style="${labelStyle}">State</label>
        <select id="trig-personstate-${t.id}" style="${selectStyle}">
          <option value="home"     ${t.state==='home'    ?'selected':''}>Home</option>
          <option value="not_home" ${t.state==='not_home'?'selected':''}>Away (not home)</option>
        </select>
      </div>`;
  }

  if (t.type === 'device') {
    const trackers = entitiesByDomain('device_tracker');
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Device Tracker</label>
        ${trackers.length
          ? multiEntitySelectRaw(t.entity_ids||[], trackers, `trig-device-${t.id}`)
          : entityAutocomplete(`trig-device-ac-${t.id}`, t.entity_ids?.[0]||'', 'device_tracker.*', 'device_tracker', ['device_tracker'])}
      </div>
      <div>
        <label style="${labelStyle}">State</label>
        <select id="trig-devicestate-${t.id}" style="${selectStyle}">
          <option value="home"     ${t.state==='home'    ?'selected':''}>Home</option>
          <option value="not_home" ${t.state==='not_home'?'selected':''}>Away (not home)</option>
        </select>
      </div>`;
  }

  if (t.type === 'entity') {
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Entity</label>
        ${entityAutocomplete(`trig-entity-ac-${t.id}`, t.entity_id||'', 'Search any entity…')}
      </div>
      <div>
        <label style="${labelStyle}">State becomes</label>
        <input id="trig-to-${t.id}" type="text" value="${escH(t.to||'on')}"
          placeholder="on / off / home / triggered / …" style="${inputStyle}"/>
      </div>`;
  }

  const labels = { zone:'Zone Event', zone_arm:'Zone Arm/Disarm', person:'Person', device:'Device Tracker', entity:'Entity State' };
  return stepCard(t.id, labels[t.type]||t.type, inner, 'trigger');
}

/* ════════════════════════════════════════════════════════════
 * CONDITION CARDS
 * ═══════════════════════════════════════════════════════════ */
function conditionCard(c) {
  let inner = '';

  if (c.type === 'time') {
    const useEntity = c.time_mode === 'entity';
    inner = `
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <button class="ow-time-mode-btn" data-time-mode="manual" data-cond-id="${escH(c.id)}"
          style="${timeModeBtn(!useEntity)}">⏰ Manual time</button>
        <button class="ow-time-mode-btn" data-time-mode="entity" data-cond-id="${escH(c.id)}"
          style="${timeModeBtn(useEntity)}">📡 Time sensor</button>
      </div>
      ${!useEntity ? `
        <div style="display:flex;gap:12px;">
          <div style="flex:1;">
            <label style="${labelStyle}">After</label>
            <input id="cond-after-${c.id}" type="time" value="${escH(c.after||'00:00')}" style="${inputStyle}"/>
          </div>
          <div style="flex:1;">
            <label style="${labelStyle}">Before</label>
            <input id="cond-before-${c.id}" type="time" value="${escH(c.before||'23:59')}" style="${inputStyle}"/>
          </div>
        </div>` : `
        <div>
          <label style="${labelStyle}">Time sensor / input_datetime entity</label>
          ${entityAutocomplete(`cond-time-entity-ac-${c.id}`, c.time_entity||'',
            'sensor.* / input_datetime.* / schedule.*', null, ['sensor','input_datetime','schedule'])}
          <div style="font-size:11px;color:#555;margin-top:4px;">
            Triggers when this entity's time value is reached (e.g. <code style="color:#666;font-size:10px;">input_datetime.alarm_time</code>).
          </div>
        </div>`}`;
  }

  if (c.type === 'entity') {
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Entity</label>
        ${entityAutocomplete(`cond-entity-ac-${c.id}`, c.entity_id||'', 'Search any entity…')}
      </div>
      <div>
        <label style="${labelStyle}">Must be in state</label>
        <input id="cond-state-${c.id}" type="text" value="${escH(c.state||'on')}"
          placeholder="on / off / home / …" style="${inputStyle}"/>
      </div>`;
  }

  const labels = { time:'Time of Day', entity:'Entity State' };
  return stepCard(c.id, labels[c.type]||c.type, inner, 'cond');
}

/* ════════════════════════════════════════════════════════════
 * ACTION CARDS
 * ═══════════════════════════════════════════════════════════ */
function actionCard(a) {
  let inner = '';

  if (a.type === 'siren') {
    const sirenOpts = sirensFromZones();
    const extraSirens = entitiesByDomain('siren','switch').filter(e => !sirenOpts.includes(e.entity_id));
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Sirens (from zones)</label>
        ${sirenOpts.length
          ? multiEntitySelectRaw(a.entity_ids||[], sirenOpts.map(id=>({entity_id:id,name:id.split('.').pop().replace(/_/g,' ')})), `act-sirens-${a.id}`)
          : `<div style="color:#555;font-size:11px;margin-bottom:4px;">No sirens in zones yet</div>`}
      </div>
      ${extraSirens.length ? `
        <div style="margin-bottom:10px;">
          <label style="${labelStyle}">Other sirens / switches</label>
          ${multiEntitySelectRaw(a.entity_ids_extra||[], extraSirens, `act-sirens-extra-${a.id}`)}
        </div>` : ''}
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
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Lights (from zones)</label>
        ${lightOpts.length
          ? multiEntitySelectRaw(a.entity_ids||[], lightOpts.map(id=>({entity_id:id,name:id.split('.').pop().replace(/_/g,' ')})), `act-lights-${a.id}`)
          : `<div style="color:#555;font-size:11px;margin-bottom:4px;">No lights in zones yet</div>`}
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
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Notification Service</label>
        ${notifyOpts.length
          ? `<select id="act-notify-target-${a.id}" style="${selectStyle}">
              <option value="notify.notify" ${!a.target||a.target==='notify.notify'?'selected':''}>notify.notify (default / all)</option>
              ${notifyOpts.filter(n=>n!=='notify.notify').map(n=>`<option value="${escH(n)}" ${a.target===n?'selected':''}>${escH(n.replace('notify.',''))}</option>`).join('')}
             </select>`
          : entityAutocomplete(`act-notify-target-ac-${a.id}`, a.target||'notify.notify', 'notify.mobile_app_…', null, ['notify'])}
      </div>
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Message</label>
        <textarea id="act-notify-msg-${a.id}" rows="2"
          placeholder="Alert message…"
          style="${inputStyle}resize:vertical;">${escH(a.message||'')}</textarea>
      </div>
      <div>
        <label style="${labelStyle}">Title (optional)</label>
        <input id="act-notify-title-${a.id}" type="text" value="${escH(a.title||'')}"
          placeholder="HA-Overwatch Alert" style="${inputStyle}"/>
      </div>`;
  }

  if (a.type === 'arm') {
    const alarmEntity = ow().uiConfig?.alarm_entity || '';
    const alarmEntities = entitiesByDomain('alarm_control_panel');
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Alarm Panel Entity</label>
        ${alarmEntities.length
          ? `<select id="act-arm-entity-sel-${a.id}" style="${selectStyle}">
              ${alarmEntities.map(e=>`<option value="${escH(e.entity_id)}" ${(a.entity_id||alarmEntity)===e.entity_id?'selected':''}>${escH(e.name)}</option>`).join('')}
             </select>`
          : entityAutocomplete(`act-arm-entity-ac-${a.id}`, a.entity_id||alarmEntity, 'alarm_control_panel.*', null, ['alarm_control_panel'])}
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
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Entity</label>
        ${entityAutocomplete(`act-entity-ac-${a.id}`, a.entity_id||'', 'Search any entity…')}
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

  const labels = { siren:'Siren', light:'Light', notify:'Notify', arm:'Arm/Disarm Alarm', entity:'Other Entity' };
  return stepCard(a.id, labels[a.type]||a.type, inner, 'action');
}

/* ════════════════════════════════════════════════════════════
 * FIELD WIRING
 * ═══════════════════════════════════════════════════════════ */
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
    wireMultiCheckbox(`trig-person-${t.id}`, ids => t.entity_ids = ids);
    wireAutocomplete(`trig-person-ac-${t.id}`, v => t.entity_ids = v ? [v] : []);
  }
  if (t.type === 'device') {
    wireSelect(`trig-devicestate-${t.id}`, v => t.state = v);
    wireMultiCheckbox(`trig-device-${t.id}`, ids => t.entity_ids = ids);
    wireAutocomplete(`trig-device-ac-${t.id}`, v => t.entity_ids = v ? [v] : []);
  }
  if (t.type === 'entity') {
    wireAutocomplete(`trig-entity-ac-${t.id}`, v => t.entity_id = v);
    wireInput(`trig-to-${t.id}`, v => t.to = v);
  }
}

function wireConditionFields(c) {
  if (c.type === 'time') {
    _panelEl.querySelectorAll(`.ow-time-mode-btn[data-cond-id="${c.id}"]`).forEach(btn => {
      btn.onclick = () => { c.time_mode = btn.dataset.timeMode; renderEditor(); };
    });
    if (c.time_mode !== 'entity') {
      wireInput(`cond-after-${c.id}`,  v => c.after  = v);
      wireInput(`cond-before-${c.id}`, v => c.before = v);
    } else {
      wireAutocomplete(`cond-time-entity-ac-${c.id}`, v => c.time_entity = v);
    }
  }
  if (c.type === 'entity') {
    wireAutocomplete(`cond-entity-ac-${c.id}`, v => c.entity_id = v);
    wireInput(`cond-state-${c.id}`, v => c.state = v);
  }
}

function wireActionFields(a) {
  if (a.type === 'siren') {
    wireMultiCheckbox(`act-sirens-${a.id}`,       ids => a.entity_ids       = ids);
    wireMultiCheckbox(`act-sirens-extra-${a.id}`, ids => a.entity_ids_extra = ids);
    wireSelect(`act-siren-svc-${a.id}`, v => a.service = v);
  }
  if (a.type === 'light') {
    wireMultiCheckbox(`act-lights-${a.id}`, ids => a.entity_ids = ids);
    wireSelect(`act-light-svc-${a.id}`, v => a.service = v);
  }
  if (a.type === 'notify') {
    wireSelect(`act-notify-target-${a.id}`, v => a.target = v);
    wireAutocomplete(`act-notify-target-ac-${a.id}`, v => a.target = v);
    const msg = _panelEl.querySelector(`#act-notify-msg-${a.id}`);
    if (msg) msg.oninput = () => { a.message = msg.value; };
    wireInput(`act-notify-title-${a.id}`, v => a.title = v);
  }
  if (a.type === 'arm') {
    wireSelect(`act-arm-entity-sel-${a.id}`, v => a.entity_id = v);
    wireAutocomplete(`act-arm-entity-ac-${a.id}`, v => a.entity_id = v);
    wireSelect(`act-arm-svc-${a.id}`, v => a.service = v);
  }
  if (a.type === 'entity') {
    wireAutocomplete(`act-entity-ac-${a.id}`, v => a.entity_id = v);
    wireSelect(`act-entity-svc-${a.id}`, v => a.service = v);
  }
}

/* ════════════════════════════════════════════════════════════
 * ENTITY AUTOCOMPLETE WIDGET
 * ═══════════════════════════════════════════════════════════ */
function entityAutocomplete(id, value, placeholder, hint, filterDomains) {
  const domainsAttr = filterDomains ? filterDomains.join(',') : '';
  return `
    <div data-entity-autocomplete data-ac-id="${escH(id)}" data-filter-domains="${escH(domainsAttr)}"
      style="position:relative;">
      <input id="${escH(id)}" type="text" value="${escH(value)}"
        placeholder="${escH(placeholder)}" autocomplete="off" spellcheck="false"
        style="${inputStyle}"/>
      <div id="${escH(id)}-dd" style="
        display:none; position:absolute; top:calc(100% + 2px); left:0; right:0; z-index:10000;
        background:#141416; border:1px solid rgba(255,255,255,0.12);
        border-radius:8px; max-height:200px; overflow-y:auto;
        box-shadow:0 8px 24px rgba(0,0,0,0.6);"></div>
      ${hint ? `<div style="font-size:10px;color:#444;margin-top:3px;">Domain filter: <code style="color:#555;">${escH(hint)}</code></div>` : ''}
    </div>`;
}

function bindEntityAutocomplete(wrapEl) {
  const id = wrapEl.dataset.acId;
  const filterDomains = wrapEl.dataset.filterDomains
    ? wrapEl.dataset.filterDomains.split(',').filter(Boolean) : null;
  const input = wrapEl.querySelector(`#${CSS.escape(id)}`);
  const dd    = wrapEl.querySelector(`#${CSS.escape(id)}-dd`);
  if (!input || !dd) return;
  const cb = wrapEl._acCallback;

  function candidates(q) {
    let list = allEntities();
    if (filterDomains?.length) list = list.filter(e => filterDomains.includes(e.domain));
    if (!q) return list.slice(0, 40);
    const lq = q.toLowerCase();
    return list.filter(e =>
      e.entity_id.toLowerCase().includes(lq) || (e.name||'').toLowerCase().includes(lq)
    ).slice(0, 60);
  }

  function renderDd(q) {
    const hits = candidates(q);
    if (!hits.length) { dd.style.display='none'; return; }
    dd.innerHTML = hits.map(e => `
      <div data-val="${escH(e.entity_id)}" style="
        display:flex;align-items:center;gap:8px;
        padding:7px 10px;cursor:pointer;font-size:12px;
        border-bottom:1px solid rgba(255,255,255,0.04);"
        onmouseenter="this.style.background='rgba(255,255,255,0.07)'"
        onmouseleave="this.style.background=''">
        <span style="font-size:10px;color:#555;width:90px;flex-shrink:0;">${escH(e.domain)}</span>
        <span style="flex:1;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(e.name||e.entity_id.split('.').pop())}</span>
        <span style="font-size:10px;color:#444;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;">${escH(e.entity_id)}</span>
        ${e.state!=null?`<span style="font-size:10px;color:#555;min-width:28px;text-align:right;">${escH(e.state)}</span>`:''}
      </div>`).join('');
    dd.querySelectorAll('[data-val]').forEach(row => {
      row.onmousedown = ev => {
        ev.preventDefault();
        input.value = row.dataset.val;
        dd.style.display = 'none';
        if (cb) cb(row.dataset.val);
      };
    });
    dd.style.display = 'block';
  }

  input.addEventListener('focus', ()    => renderDd(input.value));
  input.addEventListener('input', ()    => { renderDd(input.value); if (cb) cb(input.value.trim()); });
  input.addEventListener('blur',  ()    => setTimeout(() => { dd.style.display='none'; }, 160));
  input.addEventListener('keydown', ev => {
    if (dd.style.display==='none') return;
    const rows = [...dd.querySelectorAll('[data-val]')];
    const cur  = dd.querySelector('[data-active]');
    const idx  = cur ? rows.indexOf(cur) : -1;
    if (ev.key==='ArrowDown') {
      ev.preventDefault();
      rows.forEach(r=>r.removeAttribute('data-active'));
      const n=rows[Math.min(idx+1,rows.length-1)];
      if(n){n.dataset.active='1';n.style.background='rgba(255,255,255,0.07)';n.scrollIntoView({block:'nearest'});}
    } else if (ev.key==='ArrowUp') {
      ev.preventDefault();
      rows.forEach(r=>r.removeAttribute('data-active'));
      const p=rows[Math.max(idx-1,0)];
      if(p){p.dataset.active='1';p.style.background='rgba(255,255,255,0.07)';p.scrollIntoView({block:'nearest'});}
    } else if (ev.key==='Enter' && cur) {
      ev.preventDefault();
      input.value = cur.dataset.val; dd.style.display='none'; if(cb) cb(input.value.trim());
    } else if (ev.key==='Escape') { dd.style.display='none'; }
  });
}

/* ── Autocomplete wire helper ─────────────────────────────── */
function wireAutocomplete(id, fn) {
  const wrap = _panelEl?.querySelector(`[data-entity-autocomplete][data-ac-id="${CSS.escape(id)}"]`);
  if (wrap) {
    wrap._acCallback = fn;
    bindEntityAutocomplete(wrap);
  }
}

/* ── Other input helpers ──────────────────────────────────── */
function wireSelect(id, fn) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (el) el.onchange = () => fn(el.value);
}
function wireInput(id, fn) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (el) el.oninput = () => fn(el.value);
}
function wireMultiCheckbox(id, fn) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;
  const cbs = el.querySelectorAll('input[type=checkbox]');
  cbs.forEach(cb => cb.onchange = () => fn([...cbs].filter(c=>c.checked).map(c=>c.value)));
}

/* ── Zone multi-select ────────────────────────────────────── */
function zoneMultiSelect(t, zoneList, field, id) {
  const sel = t[field]||[];
  const allSel = zoneList.length>0 && zoneList.every(z=>sel.includes(z.id));
  return `<div id="${escH(id)}" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
    border-radius:8px;padding:10px;max-height:160px;overflow-y:auto;">
    <label style="display:flex;align-items:center;gap:8px;padding-bottom:6px;
      border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:6px;cursor:pointer;">
      <input type="checkbox" data-all="1" ${allSel?'checked':''} style="accent-color:#0064d2;">
      <span style="font-size:11px;font-weight:600;color:#aaa;">All Zones</span>
    </label>
    ${zoneList.map(z=>`
      <label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;">
        <input type="checkbox" value="${escH(z.id)}" ${sel.includes(z.id)?'checked':''} style="accent-color:#0064d2;">
        <span style="font-size:12px;">${escH(z.name||z.id)}</span>
      </label>`).join('')}
    ${!zoneList.length?'<div style="color:#444;font-size:11px;">No zones configured</div>':''}
  </div>`;
}

function wireZoneMultiSelect(t, zoneList, field, id) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;
  const allCb = el.querySelector('[data-all]');
  const cbs   = el.querySelectorAll('input[value]');
  const collect = () => [...cbs].filter(c=>c.checked).map(c=>c.value);
  if (allCb) allCb.onchange = () => {
    cbs.forEach(cb => cb.checked = allCb.checked);
    t[field] = allCb.checked ? zoneList.map(z=>z.id) : [];
  };
  cbs.forEach(cb => cb.onchange = () => {
    t[field] = collect();
    if (allCb) allCb.checked = zoneList.length>0 && zoneList.every(z=>t[field].includes(z.id));
  });
}

/* ── Multi-entity checkbox list ─────────────────────────────── */
function multiEntitySelectRaw(selectedIds, entities, id) {
  if (!entities.length) return `<div style="color:#555;font-size:11px;">No entities found</div>`;
  return `<div id="${escH(id)}" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
    border-radius:8px;padding:8px;max-height:140px;overflow-y:auto;">
    ${entities.map(e=>`
      <label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;">
        <input type="checkbox" value="${escH(e.entity_id)}"
          ${(selectedIds||[]).includes(e.entity_id)?'checked':''} style="accent-color:#0064d2;">
        <span style="flex:1;font-size:12px;">${escH(e.name||e.entity_id.split('.').pop())}</span>
        <span style="font-size:10px;color:#444;">${escH(e.entity_id)}</span>
      </label>`).join('')}
  </div>`;
}

/* ── Step card ────────────────────────────────────────────── */
function stepCard(stepId, label, inner, removeType) {
  const colors = { trigger:'#0064d2', cond:'#9b59b6', action:'#27ae60' };
  const color = colors[removeType]||'#555';
  const ra = { trigger:`data-remove-trigger="${escH(stepId)}"`, cond:`data-remove-cond="${escH(stepId)}"`, action:`data-remove-action="${escH(stepId)}"` }[removeType]||'';
  return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);
    border-left:3px solid ${color};border-radius:8px;padding:12px 14px;margin-bottom:8px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:${color};">${escH(label)}</span>
      <button ${ra} style="background:none;border:none;color:#444;cursor:pointer;font-size:14px;padding:0 2px;line-height:1;" title="Remove">✕</button>
    </div>
    ${inner}
  </div>`;
}

/* ── Section wrapper ──────────────────────────────────────── */
function editorSection(icon, title, subtitle, body, addBtns) {
  return `<div style="padding:20px 0 0;border-top:1px solid rgba(255,255,255,0.05);margin-top:16px;">
    <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:2px;">
      <span style="font-size:16px;">${icon}</span>
      <span style="font-size:13px;font-weight:600;">${title}</span>
    </div>
    <div style="font-size:11px;color:#555;margin-bottom:10px;">${subtitle}</div>
    <div>${body}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">${addBtns}</div>
  </div>`;
}

function emptyStepMsg(msg) { return `<div style="color:#444;font-size:12px;padding:6px 0;">${msg}</div>`; }
function timeModeBtn(active) {
  return `background:${active?'rgba(0,100,210,0.2)':'rgba(255,255,255,0.05)'};
    border:1px solid ${active?'rgba(0,100,210,0.5)':'rgba(255,255,255,0.1)'};
    color:${active?'#4db8ff':'#888'};border-radius:6px;padding:5px 12px;
    cursor:pointer;font-size:11px;font-weight:600;`;
}

/* ── Shared styles ────────────────────────────────────────── */
const labelStyle  = 'display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#555;margin-bottom:4px;';
const selectStyle = `background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;padding:7px 10px;font-size:12px;width:100%;outline:none;`;
const inputStyle  = `width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#fff;padding:7px 10px;font-size:12px;outline:none;box-sizing:border-box;`;
function btnStyle(bg, border, ghost=false) {
  return `background:${bg};border:1px solid ${ghost?'rgba(255,255,255,0.1)':border};color:${ghost?'#aaa':'#fff'};border-radius:8px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600;`;
}

/* ── CSS ──────────────────────────────────────────────────── */
function injectStyles() {
  if (document.getElementById('ow-auto-styles')) return;
  const s = document.createElement('style');
  s.id = 'ow-auto-styles';
  s.textContent = `.ow-add-btn{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#aaa;border-radius:7px;padding:5px 12px;cursor:pointer;font-size:12px;transition:background 0.1s,color 0.1s;}.ow-add-btn:hover{background:rgba(255,255,255,0.1);color:#fff;}`;
  document.head.appendChild(s);
}

/* ── Search integration ───────────────────────────────────── */
function searchAutomations(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  return _automations.filter(a => a.name.toLowerCase().includes(q)).map(a => ({
    type:'automation', id:a.id, label:`⚡ ${a.name}`,
    sublabel:[a.triggers?.length&&`${a.triggers.length} trigger(s)`,a.actions?.length&&`${a.actions.length} action(s)`].filter(Boolean).join(' · '),
    action:() => { if(!_open) open(); _editing=a.id; _draft=JSON.parse(JSON.stringify(a)); renderEditor(); },
  }));
}

/* ── Init ─────────────────────────────────────────────────── */
function init() {
  injectStyles();
  const reg = () => { if(window.OW) window.OW.automationSearch=searchAutomations; else setTimeout(reg,500); };
  reg();
}

window.OW_Automations = { toggle, open, close, searchAutomations };

if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
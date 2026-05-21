/* ================================================================
 * HA-Overwatch — ow-alarms.js
 * v0.05.02 hotfix: Alarm Manager foundation, correct /modules path.
 *
 * Scope:
 * - Admin-only overlay opened from sidebar button #alarmsBtn.
 * - Persists alarm definitions to /ow/alarms -> config/alarms.json.
 * - Uses HA switch entities: switch.overwatch_alarm_<slug>.
 * - Displays effective state: armed_full / armed_partial / disarmed.
 * - Partial = armed alarm has member zones suppressed by another disarmed alarm
 *   or by manual zone switch OFF.
 *
 * Deliberately NOT included here:
 * - Active zone enforcement/reconciliation. That belongs in 0.05.03+ once
 *   overlap handling is locked.
 * ================================================================ */
(function () {
  'use strict';

  let panel = null;
  let openState = false;
  let alarms = [];
  let draft = null;
  let editingId = null;

  function ow() { return window.OW || {}; }
  function apiPath(p) { return ow().apiPath ? ow().apiPath(p) : p; }
  function zones() { return ow().zones || []; }
  function groups() { return ow().groups || []; }
  function floors() { return ow().floors || []; }
  function haStates() { return ow().haStates || {}; }
  function isAdmin() { return !document.querySelector('meta[name="ow-direct"]'); }
  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
  function uid() { return 'alarm_' + Math.random().toString(36).slice(2, 9); }

  function zoneSwitchId(z) { return `switch.overwatch_zone_${slug(z?.name) || z?.id}`; }
  function alarmSwitchId(a) { return `switch.overwatch_alarm_${slug(a?.name) || a?.id}`; }
  function canToggle() { try { return typeof window.canArmDisarm === 'function' ? window.canArmDisarm() : false; } catch { return false; } }

  function haSwitchOn(entityId) {
    const st = haStates()[entityId];
    if (!st) return null;
    return String(st.state || '').toLowerCase() !== 'off';
  }

  function alarmArmed(a) {
    const on = haSwitchOn(alarmSwitchId(a));
    return on === null ? !!a.default_armed : on;
  }

  function zoneArmed(z) {
    const on = haSwitchOn(zoneSwitchId(z));
    return on === null ? true : on;
  }

  function ensureDefaults() {
    if (!alarms.some(a => a.role === 'away')) {
      alarms.unshift({
        id: 'away', name: 'Away', role: 'away', builtin: true, locked: true,
        default_armed: true,
        members: { floor_ids: ['*'], group_ids: ['*'], zone_ids: ['*'] }
      });
    }
    if (!alarms.some(a => a.role === 'home')) {
      alarms.unshift({
        id: 'home', name: 'Home', role: 'home', builtin: true, locked: false,
        default_armed: false,
        members: { floor_ids: [], group_ids: [], zone_ids: [] }
      });
    }
    alarms.forEach(a => {
      a.id ||= uid();
      a.name ||= a.id;
      a.members ||= { floor_ids: [], group_ids: [], zone_ids: [] };
      a.members.floor_ids ||= [];
      a.members.group_ids ||= [];
      a.members.zone_ids ||= [];
    });
  }

  async function loadAlarms() {
    try {
      const r = await fetch(apiPath('ow/alarms') + '?v=' + Date.now(), { cache: 'no-store' });
      alarms = r.ok ? await r.json() : [];
      if (!Array.isArray(alarms)) alarms = alarms.alarms || [];
    } catch { alarms = []; }
    ensureDefaults();
  }

  async function saveAlarms() {
    ensureDefaults();
    await fetch(apiPath('ow/alarms'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alarms, null, 2)
    });
    if (typeof window.scheduleHAReload === 'function') window.scheduleHAReload(1500);
  }

  function zonesForFloor(fid) {
    const first = floors()[0]?.id;
    return zones().filter(z => {
      const zf = z.floor_id || '';
      if (!zf) return fid === first;
      return zf === fid;
    });
  }

  function zonesForGroup(gid) {
    const g = groups().find(x => x.id === gid);
    if (!g) return [];
    return (g.zone_ids || []).map(id => zones().find(z => z.id === id)).filter(Boolean);
  }

  function resolveAlarmZones(a) {
    const m = a.members || {};
    if ((m.floor_ids || []).includes('*') || (m.group_ids || []).includes('*') || (m.zone_ids || []).includes('*')) return zones().slice();
    const out = new Map();
    (m.floor_ids || []).forEach(fid => zonesForFloor(fid).forEach(z => out.set(z.id, z)));
    (m.group_ids || []).forEach(gid => zonesForGroup(gid).forEach(z => out.set(z.id, z)));
    (m.zone_ids || []).forEach(zid => { const z = zones().find(x => x.id === zid); if (z) out.set(z.id, z); });
    return [...out.values()];
  }

  function effectiveState(a) {
    if (!alarmArmed(a)) return { status: 'disarmed', zones: resolveAlarmZones(a), suppressed: [] };
    const myZones = resolveAlarmZones(a);
    const myIds = new Set(myZones.map(z => z.id));
    const suppressed = new Set();

    alarms.forEach(other => {
      if (other.id === a.id) return;
      if (alarmArmed(other)) return;
      resolveAlarmZones(other).forEach(z => { if (myIds.has(z.id)) suppressed.add(z.id); });
    });

    myZones.forEach(z => { if (!zoneArmed(z)) suppressed.add(z.id); });
    return { status: suppressed.size ? 'armed_partial' : 'armed_full', zones: myZones, suppressed: [...suppressed] };
  }

  function mount() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'owAlarmsPanel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:9600;background:rgba(8,8,10,.98);color:#e0e0e0;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column;opacity:0;pointer-events:none;transition:opacity .18s ease;';
    document.body.appendChild(panel);
    injectStyles();
  }

  function injectStyles() {
    if (document.getElementById('ow-alarms-style')) return;
    const s = document.createElement('style');
    s.id = 'ow-alarms-style';
    s.textContent = `
      .owa-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#aaa;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:600}.owa-btn.primary{background:#0064d2;color:#fff}.owa-btn:disabled{opacity:.35;cursor:default}
      .owa-card{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;margin:0 0 8px;cursor:pointer}.owa-card:hover{background:rgba(255,255,255,.055)}
      .owa-input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#fff;padding:8px 10px;outline:none}.owa-muted{font-size:11px;color:#555}.owa-tree{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px;max-height:52vh;overflow:auto}.owa-row{display:flex;align-items:center;gap:8px;padding:3px 4px}.owa-row span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .owa-pill{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:3px 8px;border:1px solid rgba(255,255,255,.12)} input[type=checkbox]:indeterminate{accent-color:#ff9500}`;
    document.head.appendChild(s);
  }

  async function open() {
    if (!isAdmin()) return;
    mount();
    await loadAlarms();
    openState = true;
    document.getElementById('alarmsBtn')?.classList.add('active');
    renderList();
    requestAnimationFrame(() => { panel.style.opacity = '1'; panel.style.pointerEvents = 'all'; });
  }

  function close() {
    openState = false; draft = null; editingId = null;
    document.getElementById('alarmsBtn')?.classList.remove('active');
    if (panel) { panel.style.opacity = '0'; panel.style.pointerEvents = 'none'; setTimeout(() => { panel?.remove(); panel = null; }, 180); }
  }

  function toggle() { openState ? close() : open(); }

  function pill(status) {
    if (status === 'armed_full') return '<span class="owa-pill" style="background:rgba(50,215,75,.15);border-color:rgba(50,215,75,.35);color:#32d74b">armed_full</span>';
    if (status === 'armed_partial') return '<span class="owa-pill" style="background:rgba(255,149,0,.15);border-color:rgba(255,149,0,.35);color:#ff9500">armed_partial</span>';
    return '<span class="owa-pill" style="background:rgba(255,255,255,.05);color:#777">disarmed</span>';
  }

  function renderList() {
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,.07)">
        <div style="display:flex;align-items:center;gap:12px"><span style="font-weight:700;font-size:15px">Alarm Manager</span><span class="owa-muted">${alarms.length} alarms</span><span style="font-size:10px;color:#ff9500">Admin only</span></div>
        <div style="display:flex;gap:8px"><button id="owaNew" class="owa-btn primary">+ New</button><button id="owaClose" class="owa-btn">✕ Close</button></div>
      </div>
      <div style="flex:1;overflow:auto;padding:14px 20px 20px">${alarms.map(cardHtml).join('') || '<div class="owa-muted">No alarms configured.</div>'}</div>`;
    panel.querySelector('#owaClose').onclick = close;
    panel.querySelector('#owaNew').onclick = () => { editingId = 'new'; draft = { id: uid(), name: 'New Alarm', role: 'custom', builtin: false, locked: false, default_armed: false, members: { floor_ids: [], group_ids: [], zone_ids: [] } }; renderEditor(); };
    panel.querySelectorAll('[data-edit]').forEach(el => el.onclick = () => { const a = alarms.find(x => x.id === el.dataset.edit); if (!a) return; editingId = a.id; draft = JSON.parse(JSON.stringify(a)); renderEditor(); });
    panel.querySelectorAll('[data-toggle]').forEach(btn => btn.onclick = e => { e.stopPropagation(); const a = alarms.find(x => x.id === btn.dataset.toggle); if (!a || !canToggle()) return; window.owCallSwitch?.(alarmSwitchId(a), !alarmArmed(a)); setTimeout(renderList, 250); });
    panel.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = async e => { e.stopPropagation(); const a = alarms.find(x => x.id === btn.dataset.delete); if (!a || a.builtin) return; if (!confirm(`Delete ${a.name}?`)) return; alarms = alarms.filter(x => x.id !== a.id); await saveAlarms(); renderList(); });
  }

  function cardHtml(a) {
    const eff = effectiveState(a);
    const tDisabled = canToggle() ? '' : 'disabled';
    const dDisabled = a.builtin ? 'disabled' : '';
    return `<div class="owa-card" data-edit="${esc(a.id)}"><div style="width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center">🛡️</div><div style="flex:1;min-width:0"><div style="display:flex;gap:10px;align-items:center"><b>${esc(a.name)}</b>${pill(eff.status)}</div><div class="owa-muted" style="margin-top:4px">${eff.zones.length} zones${eff.suppressed.length ? `, ${eff.suppressed.length} suppressed` : ''}</div></div><button class="owa-btn" data-toggle="${esc(a.id)}" ${tDisabled}>${alarmArmed(a) ? 'ON' : 'OFF'}</button><button class="owa-btn" data-delete="${esc(a.id)}" ${dDisabled}>🗑</button></div>`;
  }

  function renderEditor() {
    panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid rgba(255,255,255,.07)"><div style="display:flex;gap:10px;align-items:center"><button id="owaBack" class="owa-btn">← Back</button><b>${editingId === 'new' ? 'New Alarm' : 'Edit Alarm'}</b></div><button id="owaSave" class="owa-btn primary">💾 Save</button></div><div style="flex:1;overflow:auto;padding:16px 18px 40px"><label class="owa-muted">Alarm Name</label><input id="owaName" class="owa-input" value="${esc(draft.name)}" ${draft.locked ? 'disabled' : ''}><div class="owa-muted" style="margin-top:6px">HA entity: ${esc(alarmSwitchId(draft))}</div><h3 style="font-size:13px;margin:18px 0 6px">Members</h3><div class="owa-muted" style="margin-bottom:8px">Parent selection auto-includes future child zones.</div><div id="owaTree" class="owa-tree"></div></div>`;
    panel.querySelector('#owaBack').onclick = () => { draft = null; editingId = null; renderList(); };
    panel.querySelector('#owaName').oninput = e => { draft.name = e.target.value; };
    renderTree(panel.querySelector('#owaTree'));
    panel.querySelector('#owaSave').onclick = async () => { if (!(draft.name || '').trim()) return alert('Enter an alarm name.'); if (editingId === 'new') alarms.push(draft); else { const i = alarms.findIndex(a => a.id === editingId); if (i >= 0) alarms[i] = draft; } await saveAlarms(); await loadAlarms(); draft = null; editingId = null; renderList(); };
  }

  function renderTree(host) {
    const m = draft.members;
    const grouped = new Set(groups().flatMap(g => g.zone_ids || []));
    const first = floors()[0]?.id;
    let html = '';
    floors().forEach(f => {
      html += row('floor', f.id, f.name || f.id, m.floor_ids.includes(f.id), 0, true);
      groups().forEach(g => {
        const gz = zonesForGroup(g.id).filter(z => (z.floor_id || first) === f.id);
        if (!gz.length) return;
        html += row('group', g.id, g.name || g.id, m.group_ids.includes(g.id), 18, true);
        gz.forEach(z => html += row('zone', z.id, z.name || z.id, m.zone_ids.includes(z.id), 36));
      });
      zonesForFloor(f.id).filter(z => !grouped.has(z.id)).forEach(z => html += row('zone', z.id, z.name || z.id, m.zone_ids.includes(z.id), 36));
    });
    if (!floors().length) zones().forEach(z => html += row('zone', z.id, z.name || z.id, m.zone_ids.includes(z.id), 0));
    host.innerHTML = html || '<div class="owa-muted">No zones configured.</div>';
    host.querySelectorAll('input[data-type]').forEach(cb => cb.onchange = () => {
      const arr = cb.dataset.type === 'floor' ? m.floor_ids : cb.dataset.type === 'group' ? m.group_ids : m.zone_ids;
      if (cb.checked && !arr.includes(cb.dataset.id)) arr.push(cb.dataset.id);
      if (!cb.checked) { const i = arr.indexOf(cb.dataset.id); if (i >= 0) arr.splice(i, 1); }
    });
  }

  function row(type, id, label, checked, pad) {
    return `<label class="owa-row" style="padding-left:${pad}px"><input type="checkbox" data-type="${esc(type)}" data-id="${esc(id)}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  }

  window.OW_Alarms = { open, close, toggle };
})();

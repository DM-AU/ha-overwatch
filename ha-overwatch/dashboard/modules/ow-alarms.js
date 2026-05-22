/* ================================================================
 * HA-Overwatch — ow-alarms.js
 * v0.05.05A: Effective alarm state + suppression reason display.
 *
 * Scope:
 * - Frontend-only validation layer.
 * - Calculates selected / active / suppressed zones per alarm.
 * - Displays suppression reasons in Alarm Manager and editor.
 * - No trigger execution yet.
 * ================================================================ */
(function () {
  'use strict';

  let panel = null;
  let openState = false;
  let alarms = [];
  let draft = null;
  let editingId = null;
  let refreshTimer = null;
  const expanded = { floors: new Set(), groups: new Set() };

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

  function m(a) { a.members ||= {}; a.members.floor_ids ||= []; a.members.group_ids ||= []; a.members.zone_ids ||= []; return a.members; }
  function hasWildcard(mem) { return [mem?.floor_ids, mem?.group_ids, mem?.zone_ids].some(arr => Array.isArray(arr) && arr.includes('*')); }
  function explicitZoneIds(mem) { return new Set((mem.zone_ids || []).filter(x => x !== '*')); }
  function setExplicitZoneIds(mem, ids) { mem.floor_ids = []; mem.group_ids = []; mem.zone_ids = [...new Set(ids)].filter(Boolean); }
  function allZoneIds() { return zones().map(z => z.id); }
  function zoneName(zoneId) { return zones().find(z => z.id === zoneId)?.name || zoneId; }
  function alarmName(alarmId) { return alarms.find(a => a.id === alarmId)?.name || alarmId; }

  function haSwitchOn(entityId) {
    const st = haStates()[entityId];
    if (!st) return null;
    return String(st.state || '').toLowerCase() !== 'off';
  }
  function alarmArmed(a) { const on = haSwitchOn(alarmSwitchId(a)); return on === null ? !!a.default_armed : on; }
  function zoneArmed(z) { const on = haSwitchOn(zoneSwitchId(z)); return on === null ? true : on; }

  function zonesForFloor(fid) {
    const first = floors()[0]?.id;
    return zones().filter(z => (z.floor_id || first) === fid);
  }
  function zonesForGroup(gid) {
    const g = groups().find(x => x.id === gid);
    if (!g) return [];
    return (g.zone_ids || []).map(id => zones().find(z => z.id === id)).filter(Boolean);
  }
  function groupRowsForFloor(fid) {
    const first = floors()[0]?.id;
    return groups().map(g => ({ g, zs: zonesForGroup(g.id).filter(z => (z.floor_id || first) === fid) })).filter(x => x.zs.length);
  }
  function ungroupedZonesForFloor(fid) {
    const grouped = new Set(groups().flatMap(g => g.zone_ids || []));
    return zonesForFloor(fid).filter(z => !grouped.has(z.id));
  }

  function ensureDefaults() {
    if (!alarms.some(a => a.role === 'away')) {
      alarms.unshift({ id: 'away', name: 'Away', role: 'away', builtin: true, default_armed: true, members: { floor_ids: [], group_ids: [], zone_ids: allZoneIds() } });
    }
    if (!alarms.some(a => a.role === 'home')) {
      alarms.unshift({ id: 'home', name: 'Home', role: 'home', builtin: true, default_armed: false, configured: false, members: { floor_ids: [], group_ids: [], zone_ids: allZoneIds() } });
    }
    alarms.forEach(a => {
      a.id ||= uid();
      a.name ||= a.id;
      const mem = m(a);
      if (hasWildcard(mem)) setExplicitZoneIds(mem, allZoneIds());
      if ((a.role === 'home' || a.role === 'away') && !a.configured && !mem.floor_ids.length && !mem.group_ids.length && !mem.zone_ids.length) {
        setExplicitZoneIds(mem, allZoneIds());
      }
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
    await fetch(apiPath('ow/alarms'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alarms, null, 2) });
    if (typeof window.scheduleHAReload === 'function') window.scheduleHAReload(250);
    else fetch(apiPath('ow/reload'), { method: 'POST' }).catch(() => {});
  }

  function resolveAlarmZones(a) {
    const mem = m(a);
    if (hasWildcard(mem)) return zones().slice();
    const out = new Map();
    (mem.floor_ids || []).forEach(fid => zonesForFloor(fid).forEach(z => out.set(z.id, z))); // backward compatibility
    (mem.group_ids || []).forEach(gid => zonesForGroup(gid).forEach(z => out.set(z.id, z))); // backward compatibility
    (mem.zone_ids || []).forEach(zid => { const z = zones().find(x => x.id === zid); if (z) out.set(z.id, z); });
    return [...out.values()];
  }

  function getAlarmEffectiveState(a) {
    const selectedZones = resolveAlarmZones(a);
    const selectedZoneIds = selectedZones.map(z => z.id);
    const selectedSet = new Set(selectedZoneIds);
    const suppressions = [];
    const suppressedSet = new Set();

    if (!alarmArmed(a)) {
      return {
        state: 'disarmed',
        selectedZoneIds,
        activeZoneIds: [],
        suppressedZoneIds: [],
        suppressions: [],
      };
    }

    selectedZones.forEach(z => {
      if (!zoneArmed(z)) {
        suppressedSet.add(z.id);
        suppressions.push({
          zoneId: z.id,
          reason: 'manual_zone_disarm',
          source: zoneSwitchId(z),
          label: `${z.name || z.id} suppressed by manual zone disarm`,
        });
      }
    });

    alarms.forEach(other => {
      if (other.id === a.id) return;
      if (alarmArmed(other)) return;
      resolveAlarmZones(other).forEach(z => {
        if (!selectedSet.has(z.id)) return;
        suppressedSet.add(z.id);
        suppressions.push({
          zoneId: z.id,
          reason: 'overlap_disarmed_alarm',
          source: other.id,
          label: `${z.name || z.id} suppressed by disarmed alarm ${other.name || other.id}`,
        });
      });
    });

    const suppressedZoneIds = [...suppressedSet];
    const activeZoneIds = selectedZoneIds.filter(id => !suppressedSet.has(id));
    return {
      state: suppressedZoneIds.length ? 'armed_partial' : 'armed_full',
      selectedZoneIds,
      activeZoneIds,
      suppressedZoneIds,
      suppressions,
    };
  }

  // Kept as compatibility alias for older code paths in this module.
  function effectiveState(a) {
    const eff = getAlarmEffectiveState(a);
    return {
      status: eff.state,
      zones: eff.selectedZoneIds.map(id => zones().find(z => z.id === id)).filter(Boolean),
      suppressed: eff.suppressedZoneIds,
      suppressions: eff.suppressions,
      activeZoneIds: eff.activeZoneIds,
    };
  }

  function injectStyles() {
    if (document.getElementById('ow-alarms-style')) return;
    const s = document.createElement('style');
    s.id = 'ow-alarms-style';
    s.textContent = `
      .owa-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#aaa;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:600}.owa-btn.primary{background:#0064d2;color:#fff}.owa-btn:disabled{opacity:.35;cursor:default}
      .owa-card{display:flex;align-items:flex-start;gap:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;margin:0 0 8px;cursor:pointer}.owa-card:hover{background:rgba(255,255,255,.055)}
      .owa-input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#fff;padding:8px 10px;outline:none}.owa-muted{font-size:11px;color:#555}.owa-tree{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:8px;max-height:44vh;overflow:auto}.owa-row{display:flex;align-items:center;gap:8px;padding:4px 4px}.owa-row span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.owa-exp{width:22px;height:22px;border:0;background:transparent;color:#aaa;cursor:pointer}.owa-exp.leaf{visibility:hidden}.owa-pill{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:3px 8px;border:1px solid rgba(255,255,255,.12)}
      .owa-counts{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.owa-count{font-size:10px;color:#999;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.075);border-radius:999px;padding:3px 7px}.owa-supp{margin-top:8px;padding:8px 10px;background:rgba(255,149,0,.07);border:1px solid rgba(255,149,0,.16);border-radius:8px;color:#c8a166;font-size:11px}.owa-supp ul{margin:5px 0 0 16px;padding:0}.owa-supp li{margin:2px 0}.owa-section{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:10px;margin-top:12px}`;
    document.head.appendChild(s);
  }

  function mount() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'owAlarmsPanel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:9600;background:rgba(8,8,10,.98);color:#e0e0e0;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column;opacity:0;pointer-events:none;transition:opacity .18s ease;';
    document.body.appendChild(panel);
    injectStyles();
  }
  function startDynamicRefresh() { stopDynamicRefresh(); refreshTimer = setInterval(() => { if (openState && panel && !draft) renderList(false); }, 1000); }
  function stopDynamicRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }

  async function open() {
    if (!isAdmin()) return;
    mount();
    await loadAlarms();
    openState = true;
    document.getElementById('alarmsBtn')?.classList.add('active');
    renderList(true);
    startDynamicRefresh();
    requestAnimationFrame(() => { panel.style.opacity = '1'; panel.style.pointerEvents = 'all'; });
  }
  function close() {
    openState = false;
    draft = null;
    editingId = null;
    stopDynamicRefresh();
    document.getElementById('alarmsBtn')?.classList.remove('active');
    if (panel) { panel.style.opacity = '0'; panel.style.pointerEvents = 'none'; setTimeout(() => { panel?.remove(); panel = null; }, 180); }
  }
  function toggle() { openState ? close() : open(); }

  function pill(status) {
    if (status === 'armed_full') return '<span class="owa-pill" style="background:rgba(50,215,75,.15);border-color:rgba(50,215,75,.35);color:#32d74b">Armed</span>';
    if (status === 'armed_partial') return '<span class="owa-pill" style="background:rgba(255,149,0,.15);border-color:rgba(255,149,0,.35);color:#ff9500">Armed Partial</span>';
    return '<span class="owa-pill" style="background:rgba(255,255,255,.05);color:#777">Disarmed</span>';
  }

  function suppressionSummaryHtml(eff, max = 3) {
    if (!eff.suppressions.length) return '';
    const unique = [];
    const seen = new Set();
    eff.suppressions.forEach(s => {
      const key = `${s.zoneId}|${s.reason}|${s.source}`;
      if (!seen.has(key)) { seen.add(key); unique.push(s); }
    });
    const shown = unique.slice(0, max);
    const more = unique.length > max ? `<li>+ ${unique.length - max} more suppression reason(s)</li>` : '';
    return `<div class="owa-supp"><b>Suppressed:</b><ul>${shown.map(s => `<li>${esc(s.label)}</li>`).join('')}${more}</ul></div>`;
  }

  function renderList(resetScroll) {
    const listNode = panel?.querySelector('[data-owa-list]');
    const scrollTop = !resetScroll && listNode ? listNode.scrollTop : 0;
    panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,.07)"><div style="display:flex;align-items:center;gap:12px"><span style="font-weight:700;font-size:15px">Alarm Manager</span><span class="owa-muted">${alarms.length} alarms</span><span style="font-size:10px;color:#ff9500">Admin only</span></div><div style="display:flex;gap:8px"><button id="owaNew" class="owa-btn primary">+ New</button><button id="owaClose" class="owa-btn">✕ Close</button></div></div><div data-owa-list style="flex:1;overflow:auto;padding:14px 20px 20px">${alarms.map(cardHtml).join('') || '<div class="owa-muted">No alarms configured.</div>'}</div>`;
    panel.querySelector('#owaClose').onclick = close;
    panel.querySelector('#owaNew').onclick = () => { editingId = 'new'; draft = { id: uid(), name: 'New Alarm', role: 'custom', builtin: false, default_armed: false, configured: true, members: { floor_ids: [], group_ids: [], zone_ids: [] } }; expanded.floors.clear(); expanded.groups.clear(); renderEditor(); };
    panel.querySelectorAll('[data-edit]').forEach(el => el.onclick = () => { const a = alarms.find(x => x.id === el.dataset.edit); if (!a) return; editingId = a.id; draft = JSON.parse(JSON.stringify(a)); ensureDraftExplicit(); expanded.floors.clear(); expanded.groups.clear(); renderEditor(); });
    panel.querySelectorAll('[data-toggle]').forEach(btn => btn.onclick = e => { e.stopPropagation(); const a = alarms.find(x => x.id === btn.dataset.toggle); if (!a || !canToggle()) return; window.owCallSwitch?.(alarmSwitchId(a), !alarmArmed(a)); setTimeout(() => renderList(false), 250); });
    panel.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = async e => { e.stopPropagation(); const a = alarms.find(x => x.id === btn.dataset.delete); if (!a || a.builtin) return; if (!confirm(`Delete ${a.name}?`)) return; alarms = alarms.filter(x => x.id !== a.id); await saveAlarms(); renderList(true); });
    const list = panel.querySelector('[data-owa-list]');
    if (list && !resetScroll) list.scrollTop = scrollTop;
  }

  function cardHtml(a) {
    const eff = getAlarmEffectiveState(a);
    const dDisabled = a.builtin ? 'disabled' : '';
    return `<div class="owa-card" data-edit="${esc(a.id)}"><div style="width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;flex:0 0 auto">🛡️</div><div style="flex:1;min-width:0"><div style="display:flex;gap:10px;align-items:center"><b>${esc(a.name)}</b>${pill(eff.state)}</div><div class="owa-counts"><span class="owa-count">Selected ${eff.selectedZoneIds.length}</span><span class="owa-count">Active ${eff.activeZoneIds.length}</span><span class="owa-count">Suppressed ${eff.suppressedZoneIds.length}</span></div>${suppressionSummaryHtml(eff)}</div><div style="display:flex;gap:6px;flex:0 0 auto"><button class="owa-btn" data-toggle="${esc(a.id)}" ${canToggle() ? '' : 'disabled'}>${alarmArmed(a) ? 'ON' : 'OFF'}</button><button class="owa-btn" data-delete="${esc(a.id)}" ${dDisabled}>🗑</button></div></div>`;
  }

  function ensureDraftExplicit() {
    const mem = m(draft);
    if (hasWildcard(mem)) setExplicitZoneIds(mem, allZoneIds());
    const ids = new Set(resolveAlarmZones(draft).map(z => z.id));
    setExplicitZoneIds(mem, ids);
  }

  function draftEffectivePreview() {
    if (!draft) return null;
    const existingIndex = alarms.findIndex(a => a.id === editingId);
    const original = existingIndex >= 0 ? alarms[existingIndex] : null;
    if (existingIndex >= 0) alarms[existingIndex] = draft;
    else alarms.push(draft);
    const eff = getAlarmEffectiveState(draft);
    if (existingIndex >= 0) alarms[existingIndex] = original;
    else alarms = alarms.filter(a => a.id !== draft.id);
    return eff;
  }

  function renderEditor() {
    stopDynamicRefresh();
    const eff = draftEffectivePreview();
    panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid rgba(255,255,255,.07)"><div style="display:flex;gap:10px;align-items:center"><button id="owaBack" class="owa-btn">← Back</button><b>${editingId === 'new' ? 'New Alarm' : 'Edit Alarm'}</b>${eff ? pill(eff.state) : ''}</div><button id="owaSave" class="owa-btn primary">💾 Save</button></div><div style="flex:1;overflow:auto;padding:16px 18px 40px"><label class="owa-muted">Alarm Name</label><input id="owaName" class="owa-input" value="${esc(draft.name)}"><div class="owa-muted" style="margin-top:6px">HA entity: ${esc(alarmSwitchId(draft))}</div>${eff ? effectiveDetailHtml(eff) : ''}<h3 style="font-size:13px;margin:18px 0 6px">Members</h3><div class="owa-muted" style="margin-bottom:8px">Floors/groups are batch selectors only. Selecting a parent writes explicit zones so members can be unticked afterwards.</div><div id="owaTree" class="owa-tree"></div></div>`;
    panel.querySelector('#owaBack').onclick = () => { draft = null; editingId = null; renderList(true); startDynamicRefresh(); };
    panel.querySelector('#owaName').oninput = e => { draft.name = e.target.value; };
    renderTree(panel.querySelector('#owaTree'));
    panel.querySelector('#owaSave').onclick = async () => {
      if (!(draft.name || '').trim()) return alert('Enter an alarm name.');
      draft.configured = true;
      ensureDraftExplicit();
      if (editingId === 'new') alarms.push(draft);
      else { const i = alarms.findIndex(a => a.id === editingId); if (i >= 0) alarms[i] = draft; }
      await saveAlarms();
      await loadAlarms();
      draft = null;
      editingId = null;
      renderList(true);
      startDynamicRefresh();
    };
  }

  function effectiveDetailHtml(eff) {
    const activePreview = eff.activeZoneIds.slice(0, 8).map(id => esc(zoneName(id))).join(', ');
    const suppressedPreview = eff.suppressedZoneIds.slice(0, 8).map(id => esc(zoneName(id))).join(', ');
    return `<div class="owa-section"><div style="font-weight:700;margin-bottom:6px">Effective state</div><div class="owa-counts"><span class="owa-count">Selected ${eff.selectedZoneIds.length}</span><span class="owa-count">Active ${eff.activeZoneIds.length}</span><span class="owa-count">Suppressed ${eff.suppressedZoneIds.length}</span></div>${activePreview ? `<div class="owa-muted" style="margin-top:8px">Active: ${activePreview}${eff.activeZoneIds.length > 8 ? '…' : ''}</div>` : ''}${suppressedPreview ? `<div class="owa-muted" style="margin-top:5px">Suppressed zones: ${suppressedPreview}${eff.suppressedZoneIds.length > 8 ? '…' : ''}</div>` : ''}${suppressionSummaryHtml(eff, 12)}</div>`;
  }

  function selectedSet() { return explicitZoneIds(m(draft)); }
  function allSelected(ids) { const sel = selectedSet(); return ids.length > 0 && ids.every(id => sel.has(id)); }
  function someSelected(ids) { const sel = selectedSet(); return ids.some(id => sel.has(id)); }
  function setZoneIds(ids, checked) {
    const sel = selectedSet();
    ids.forEach(id => checked ? sel.add(id) : sel.delete(id));
    setExplicitZoneIds(m(draft), sel);
    draft.configured = true;
  }

  function renderTree(host) {
    let html = '';
    const fs = floors().length ? floors() : [{ id: 'floor_default', name: 'Ground Floor' }];
    fs.forEach(f => {
      const fZoneIds = zonesForFloor(f.id).map(z => z.id);
      html += row('floor', f.id, f.name || f.id, allSelected(fZoneIds), someSelected(fZoneIds), 0, expanded.floors.has(f.id), true);
      if (!expanded.floors.has(f.id)) return;
      groupRowsForFloor(f.id).forEach(({ g, zs }) => {
        const gZoneIds = zs.map(z => z.id);
        html += row('group', g.id, g.name || g.id, allSelected(gZoneIds), someSelected(gZoneIds), 22, expanded.groups.has(g.id), true);
        if (expanded.groups.has(g.id)) zs.forEach(z => html += row('zone', z.id, z.name || z.id, selectedSet().has(z.id), false, 44, false, false));
      });
      ungroupedZonesForFloor(f.id).forEach(z => html += row('zone', z.id, z.name || z.id, selectedSet().has(z.id), false, 22, false, false));
    });
    host.innerHTML = html || '<div class="owa-muted">No zones configured.</div>';
    host.querySelectorAll('[data-expand]').forEach(btn => btn.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      const set = btn.dataset.type === 'floor' ? expanded.floors : expanded.groups;
      set.has(btn.dataset.id) ? set.delete(btn.dataset.id) : set.add(btn.dataset.id);
      renderTree(host);
    });
    host.querySelectorAll('input[data-type]').forEach(cb => {
      cb.indeterminate = cb.dataset.mixed === 'true';
      cb.onchange = () => {
        const type = cb.dataset.type;
        const id = cb.dataset.id;
        if (type === 'floor') setZoneIds(zonesForFloor(id).map(z => z.id), cb.checked);
        else if (type === 'group') setZoneIds(zonesForGroup(id).map(z => z.id), cb.checked);
        else setZoneIds([id], cb.checked);
        renderTree(host);
      };
    });
  }

  function row(type, id, label, checked, mixed, pad, isExpanded, expandable) {
    const symbol = expandable ? (isExpanded ? '▾' : '▸') : '•';
    return `<label class="owa-row" style="padding-left:${pad}px"><button class="owa-exp ${expandable ? '' : 'leaf'}" data-expand="1" data-type="${esc(type)}" data-id="${esc(id)}">${symbol}</button><input type="checkbox" data-type="${esc(type)}" data-id="${esc(id)}" data-mixed="${mixed && !checked ? 'true' : 'false'}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  }

  window.OW_Alarms = {
    open,
    close,
    toggle,
    getAlarmEffectiveState,
  };
})();

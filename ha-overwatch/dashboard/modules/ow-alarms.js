/* ================================================================
 * HA-Overwatch — ow-alarms.js
 * v0.05.14: Trigger filters reposition + empty-selection warning (no trigger).
 *
 * Scope:
 * - Frontend-only.
 * - Adds display sorting by Name, Status, Active Zones, Suppressed Zones.
 * - Retains effective alarm state preview and corrected security colours.
 * - Red = Armed, Amber = Armed Partial, Green = Disarmed.
 * - Adds response profile configuration using Automation Editor-style grouped selectors.
 * - No trigger execution yet.
 * ================================================================ */
(function () {
  'use strict';

  let panel = null;
  let openState = false;
  let draft = null;
  let editingId = null;
  let refreshTimer = null;
  let alarms = [];
  const expanded = { floors: new Set(), groups: new Set() };

  const SORT_KEY = 'ow_alarm_sort_v1';
  let sortMode = 'status';
  let sortReverse = false;

  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) || '{}');
    if (saved.mode) sortMode = saved.mode;
    if (typeof saved.reverse === 'boolean') sortReverse = saved.reverse;
  } catch {}

  const ow = () => window.OW || {};
  const apiPath = p => ow().apiPath ? ow().apiPath(p) : p;
  const zones = () => ow().zones || [];
  const groups = () => ow().groups || [];
  const floors = () => ow().floors || [];
  const haStates = () => ow().haStates || {};
  const isAdmin = () => !document.querySelector('meta[name="ow-direct"]');
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const uid = () => 'alarm_' + Math.random().toString(36).slice(2, 9);
  const zoneSwitchId = z => `switch.overwatch_zone_${slug(z?.name) || z?.id}`;
  const alarmSwitchId = a => `switch.overwatch_alarm_${slug(a?.name) || a?.id}`;
  const canToggle = () => { try { return typeof window.canArmDisarm === 'function' ? window.canArmDisarm() : false; } catch { return false; } };

  function m(a) { a.members ||= {}; a.members.floor_ids ||= []; a.members.group_ids ||= []; a.members.zone_ids ||= []; return a.members; }
  const hasWildcard = mem => [mem?.floor_ids, mem?.group_ids, mem?.zone_ids].some(arr => Array.isArray(arr) && arr.includes('*'));
  const explicitZoneIds = mem => new Set((mem.zone_ids || []).filter(x => x !== '*'));
  function setExplicitZoneIds(mem, ids) { mem.floor_ids = []; mem.group_ids = []; mem.zone_ids = [...new Set(ids)].filter(Boolean); }
  const allZoneIds = () => zones().map(z => z.id);
  const zoneName = id => zones().find(z => z.id === id)?.name || id;

  const TRIGGER_FILTER_KEYS = ['person','animal','motion','door','window','vehicle','smoke','gas'];
  const TRIGGER_FILTER_LABELS = { person:'Person', animal:'Animal', motion:'Motion', door:'Door', window:'Window', vehicle:'Vehicle', smoke:'Smoke', gas:'Gas / CO' };
  function defaultTriggerFilters() { const out = {}; TRIGGER_FILTER_KEYS.forEach(k => out[k] = true); return out; }
  function normaliseTriggerFilters(filters) {
    const f = (filters && typeof filters === 'object') ? filters : {};
    const out = {};
    TRIGGER_FILTER_KEYS.forEach(k => {
      if (typeof f[k] === 'boolean') out[k] = f[k];
      else if (typeof f[k] === 'string') out[k] = (String(f[k]).toLowerCase() === 'true' || f[k] === '1' || String(f[k]).toLowerCase() === 'on');
      else out[k] = true;
    });
    return out;
  }
  function ensureTriggerFilters(a) { a.trigger_filters = normaliseTriggerFilters(a.trigger_filters || a.filters || null); return a.trigger_filters; }

const emptyResponseAction = () => ({ enabled:false, entities:[], targets:[] });
  const emptyResponseSet = () => ({ notify: emptyResponseAction(), sirens: emptyResponseAction(), lights: emptyResponseAction(), cameras: emptyResponseAction(), scripts: emptyResponseAction(), automations: emptyResponseAction() });
  function defaultResponses() { return { triggered_armed: emptyResponseSet(), triggered_disarmed: emptyResponseSet() }; }
  function normaliseResponseAction(action) {
    const a = action && typeof action === 'object' ? action : {};
    const cleanList = value => (Array.isArray(value) ? value : [])
      .map(item => typeof item === 'string' ? item : (item?.entity_id || item?.id || item?.name || ''))
      .map(s => String(s || '').trim()).filter(s => s && s !== '[object Object]');
    return { enabled: !!a.enabled, entities: cleanList(a.entities), targets: cleanList(a.targets) };
  }
  function normaliseResponseSet(set) {
    const s = set && typeof set === 'object' ? set : {};
    return { notify:normaliseResponseAction(s.notify), sirens:normaliseResponseAction(s.sirens), lights:normaliseResponseAction(s.lights), cameras:normaliseResponseAction(s.cameras), scripts:normaliseResponseAction(s.scripts), automations:normaliseResponseAction(s.automations) };
  }
  function normaliseResponses(responses) {
    const r = responses && typeof responses === 'object' ? responses : {};
    return { triggered_armed:normaliseResponseSet(r.triggered_armed || r.armed || r.triggered || {}), triggered_disarmed:normaliseResponseSet(r.triggered_disarmed || r.disarmed || {}) };
  }
  function ensureResponses(a) { a.responses = normaliseResponses(a.responses || defaultResponses()); return a.responses; }
  function linesToArray(value) { return String(value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
  function arrayToLines(value) { return (Array.isArray(value) ? value : []).join('\n'); }
  function entityLabel(entityId) { const st = haStates()[entityId]; const friendly = st?.attributes?.friendly_name; return friendly ? `${entityId} — ${friendly}` : entityId; }
  function haEntityOptions(domains = []) { const wanted = new Set(domains); return Object.keys(haStates()).filter(id => !wanted.size || wanted.has(id.split('.')[0])).sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base',numeric:true})); }
  function datalistOptions(id, domains) { return `<datalist id="${esc(id)}">${haEntityOptions(domains).map(e => `<option value="${esc(e)}">${esc(entityLabel(e))}</option>`).join('')}</datalist>`; }
  function responseEntityListForZone(zone, key) { return (zone?.[key] || []).filter(Boolean); }
  function responseOtherEntities(key, domains) {
    const used = new Set(zones().flatMap(z => responseEntityListForZone(z, key)));
    return haEntityOptions(domains).filter(e => !used.has(e));
  }

    function haSwitchOn(entityId) { const st = haStates()[entityId]; if (!st) return null; return String(st.state || '').toLowerCase() !== 'off'; }
  function alarmArmed(a) { const on = haSwitchOn(alarmSwitchId(a)); return on === null ? !!a.default_armed : on; }
  function zoneArmed(z) { const on = haSwitchOn(zoneSwitchId(z)); return on === null ? true : on; }

  function zonesForFloor(fid) { const first = floors()[0]?.id; return zones().filter(z => (z.floor_id || first) === fid); }
  function zonesForGroup(gid) { const g = groups().find(x => x.id === gid); if (!g) return []; return (g.zone_ids || []).map(id => zones().find(z => z.id === id)).filter(Boolean); }
  function groupRowsForFloor(fid) { const first = floors()[0]?.id; return groups().map(g => ({ g, zs: zonesForGroup(g.id).filter(z => (z.floor_id || first) === fid) })).filter(x => x.zs.length); }
  function ungroupedZonesForFloor(fid) { const grouped = new Set(groups().flatMap(g => g.zone_ids || [])); return zonesForFloor(fid).filter(z => !grouped.has(z.id)); }

  function ensureDefaults() {
    if (!alarms.some(a => a.role === 'away')) alarms.unshift({ id:'away', name:'Away', role:'away', builtin:true, default_armed:true, members:{ floor_ids:[], group_ids:[], zone_ids: allZoneIds() }});
    if (!alarms.some(a => a.role === 'home')) alarms.unshift({ id:'home', name:'Home', role:'home', builtin:true, default_armed:false, configured:false, members:{ floor_ids:[], group_ids:[], zone_ids: allZoneIds() }});
    alarms.forEach(a => {
      a.id ||= uid();
      a.name ||= a.id;
      const mem = m(a);
      if (hasWildcard(mem)) setExplicitZoneIds(mem, allZoneIds());
      if ((a.role === 'home' || a.role === 'away') && !a.configured && !mem.floor_ids.length && !mem.group_ids.length && !mem.zone_ids.length) setExplicitZoneIds(mem, allZoneIds());
      a.description = (a.description == null ? '' : String(a.description));
      ensureTriggerFilters(a);
      ensureResponses(a);
    });
  }

  async function loadAlarms() {
    try {
      const r = await fetch(apiPath('ow/alarms') + '?v=' + Date.now(), { cache:'no-store' });
      alarms = r.ok ? await r.json() : [];
      if (!Array.isArray(alarms)) alarms = alarms.alarms || [];
    } catch { alarms = []; }
    ensureDefaults();
  }

  async function saveAlarms() {
    ensureDefaults();
    await fetch(apiPath('ow/alarms'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(alarms, null, 2) });
    if (typeof window.scheduleHAReload === 'function') window.scheduleHAReload(250);
    else fetch(apiPath('ow/reload'), { method:'POST' }).catch(() => {});
  }

  function resolveAlarmZones(a) {
    const mem = m(a), out = new Map();
    if (hasWildcard(mem)) return zones().slice();
    (mem.floor_ids || []).forEach(fid => zonesForFloor(fid).forEach(z => out.set(z.id, z)));
    (mem.group_ids || []).forEach(gid => zonesForGroup(gid).forEach(z => out.set(z.id, z)));
    (mem.zone_ids || []).forEach(zid => { const z = zones().find(x => x.id === zid); if (z) out.set(z.id, z); });
    return [...out.values()];
  }

  function getAlarmEffectiveState(a) {
    const selectedZones = resolveAlarmZones(a);
    const selectedZoneIds = selectedZones.map(z => z.id);
    const selectedSet = new Set(selectedZoneIds);
    const suppressedSet = new Set();
    const suppressions = [];

    if (!alarmArmed(a)) {
      return { state:'disarmed', selectedZoneIds, activeZoneIds:[], suppressedZoneIds:[], suppressions:[] };
    }

    selectedZones.forEach(z => {
      if (!zoneArmed(z)) {
        suppressedSet.add(z.id);
        suppressions.push({ zoneId:z.id, reason:'manual_zone_disarm', source:zoneSwitchId(z), label:`${z.name || z.id} suppressed by manual zone disarm` });
      }
    });

    alarms.forEach(other => {
      if (other.id === a.id || alarmArmed(other)) return;
      resolveAlarmZones(other).forEach(z => {
        if (!selectedSet.has(z.id)) return;
        suppressedSet.add(z.id);
        suppressions.push({ zoneId:z.id, reason:'overlap_disarmed_alarm', source:other.id, label:`${z.name || z.id} suppressed by disarmed alarm ${other.name || other.id}` });
      });
    });

    const suppressedZoneIds = [...suppressedSet];
    return {
      state: suppressedZoneIds.length ? 'armed_partial' : 'armed_full',
      selectedZoneIds,
      activeZoneIds: selectedZoneIds.filter(id => !suppressedSet.has(id)),
      suppressedZoneIds,
      suppressions,
    };
  }

  function statusRank(state) {
    if (state === 'disarmed') return 0;
    if (state === 'armed_partial') return 1;
    if (state === 'armed_full') return 2;
    return -1;
  }

  function compareNumbers(a, b) { return a === b ? 0 : (a < b ? -1 : 1); }
  function compareNames(a, b) { return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true }); }

  function sortAlarmsForDisplay(list) {
    const decorated = list.map((alarm, index) => ({ alarm, eff: getAlarmEffectiveState(alarm), index }));
    decorated.sort((a, b) => {
      let result = 0;
      if (sortMode === 'name') {
        result = compareNames(a.alarm.name, b.alarm.name);
      } else if (sortMode === 'active') {
        result = compareNumbers(a.eff.activeZoneIds.length, b.eff.activeZoneIds.length) ||
                 compareNumbers(a.eff.suppressedZoneIds.length, b.eff.suppressedZoneIds.length) ||
                 compareNumbers(a.eff.selectedZoneIds.length, b.eff.selectedZoneIds.length) ||
                 compareNames(a.alarm.name, b.alarm.name);
      } else if (sortMode === 'suppressed') {
        result = compareNumbers(a.eff.suppressedZoneIds.length, b.eff.suppressedZoneIds.length) ||
                 compareNumbers(a.eff.activeZoneIds.length, b.eff.activeZoneIds.length) ||
                 compareNumbers(a.eff.selectedZoneIds.length, b.eff.selectedZoneIds.length) ||
                 compareNames(a.alarm.name, b.alarm.name);
      } else {
        // Status order: Disarmed -> Armed Partial -> Armed.
        // Within each status, larger alarms sort later by active, suppressed, then selected zones.
        result = compareNumbers(statusRank(a.eff.state), statusRank(b.eff.state)) ||
                 compareNumbers(a.eff.activeZoneIds.length, b.eff.activeZoneIds.length) ||
                 compareNumbers(a.eff.suppressedZoneIds.length, b.eff.suppressedZoneIds.length) ||
                 compareNumbers(a.eff.selectedZoneIds.length, b.eff.selectedZoneIds.length) ||
                 compareNames(a.alarm.name, b.alarm.name);
      }
      if (sortReverse) result = -result;
      return result || compareNumbers(a.index, b.index);
    });
    return decorated.map(x => x.alarm);
  }

  function persistSort() {
    try { localStorage.setItem(SORT_KEY, JSON.stringify({ mode: sortMode, reverse: sortReverse })); } catch {}
  }

  function injectStyles() {
    if (document.getElementById('ow-alarms-style')) return;
    const s = document.createElement('style');
    s.id = 'ow-alarms-style';
    s.textContent = `.owa-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#aaa;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:600}.owa-btn.primary{background:#0064d2;color:#fff}.owa-btn:disabled{opacity:.35;cursor:default}.owa-card{display:flex;align-items:flex-start;gap:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;margin:0 0 8px;cursor:pointer}.owa-card:hover{background:rgba(255,255,255,.055)}.owa-input,.owa-select{box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#fff;padding:8px 10px;outline:none}.owa-input{width:100%}.owa-select{font-size:12px;padding:7px 9px}.owa-select option{background:#111;color:#eee}.owa-muted{font-size:11px;color:#555}.owa-tree{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:8px;max-height:44vh;overflow:auto}.owa-row{display:flex;align-items:center;gap:8px;padding:4px 4px}.owa-row span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.owa-exp{width:22px;height:22px;border:0;background:transparent;color:#aaa;cursor:pointer}.owa-exp.leaf{visibility:hidden}.owa-pill{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:3px 8px;border:1px solid rgba(255,255,255,.12)}.owa-counts{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.owa-count{font-size:10px;color:#d8d8d8;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.075);border-radius:999px;padding:3px 7px}.owa-count.selected{background:rgba(0,122,255,.20);border-color:rgba(0,122,255,.42);color:#b9dcff}.owa-count.active{background:rgba(52,199,89,.20);border-color:rgba(52,199,89,.42);color:#c7f5d3}.owa-count.suppressed{background:rgba(255,149,0,.20);border-color:rgba(255,149,0,.46);color:#ffd49a}.owa-response-tree{background:rgba(255,255,255,.025);border-left:3px solid rgba(52,199,89,.85);border-radius:9px;padding:8px 10px;margin-top:8px}.owa-response-row{display:flex;align-items:center;gap:8px;padding:5px 0}.owa-response-row.depth1{padding-left:18px}.owa-response-row.depth2{padding-left:36px}.owa-response-row.depth3{padding-left:54px}.owa-response-row .tag{font-size:9px;border-radius:4px;padding:1px 4px;margin-left:4px;background:rgba(0,122,255,.25);color:#87c7ff}.owa-response-row .tag.triggered{background:rgba(255,59,48,.28);color:#ff9d9a}.owa-response-other{margin-top:8px}.owa-entity-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.owa-entity-pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;font-size:11px;color:#d6d6d6;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.11);border-radius:999px;padding:4px 8px}.owa-entity-pill button{border:0;background:transparent;color:#aaa;cursor:pointer;padding:0;font-size:12px}.owa-warn{margin-top:10px;padding:9px 11px;background:rgba(255,59,48,.10);border:1px solid rgba(255,59,48,.22);border-radius:8px;color:#ff9d9a;font-size:11px}.owa-warn b{color:#ff6b6b}
.owa-supp{margin-top:8px;padding:8px 10px;background:rgba(255,149,0,.07);border:1px solid rgba(255,149,0,.16);border-radius:8px;color:#c8a166;font-size:11px}.owa-supp ul{margin:5px 0 0 16px;padding:0}.owa-supp li{margin:2px 0}.owa-section{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:10px;margin-top:12px}.owa-sortbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.owa-sortlabel{font-size:11px;color:#777}`;
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

  function isSortControlActive() {
    const activeElement = document.activeElement;
    if (!activeElement || !panel || !panel.contains(activeElement)) return false;
    return !!activeElement.closest('#owaSortMode,#owaSortReverse,.owa-sortbar');
  }

  function startDynamicRefresh() {
    stopDynamicRefresh();
    refreshTimer = setInterval(() => {
      if (!openState || !panel || draft) return;
      if (isSortControlActive()) return;
      renderList(false);
    }, 1000);
  }
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
    if (status === 'armed_full') return '<span class="owa-pill" style="background:rgba(255,69,58,.15);border-color:rgba(255,69,58,.38);color:#ff453a">Armed</span>';
    if (status === 'armed_partial') return '<span class="owa-pill" style="background:rgba(255,149,0,.15);border-color:rgba(255,149,0,.38);color:#ff9500">Armed Partial</span>';
    return '<span class="owa-pill" style="background:rgba(50,215,75,.14);border-color:rgba(50,215,75,.34);color:#32d74b">Disarmed</span>';
  }

  function sortLabel() {
    if (sortMode === 'name') return sortReverse ? 'Name Z-A' : 'Name A-Z';
    if (sortMode === 'active') return sortReverse ? 'Most Active' : 'Least Active';
    if (sortMode === 'suppressed') return sortReverse ? 'Most Suppressed' : 'Least Suppressed';
    return sortReverse ? 'Armed → Disarmed' : 'Disarmed → Armed';
  }

  function suppressionSummaryHtml(eff, max = 3) {
    if (!eff.suppressions.length) return '';
    const unique = [], seen = new Set();
    eff.suppressions.forEach(s => { const key = `${s.zoneId}|${s.reason}|${s.source}`; if (!seen.has(key)) { seen.add(key); unique.push(s); } });
    const shown = unique.slice(0, max);
    const more = unique.length > max ? `<li>+ ${unique.length - max} more suppression reason(s)</li>` : '';
    return `<div class="owa-supp"><b>Suppressed:</b><ul>${shown.map(s => `<li>${esc(s.label)}</li>`).join('')}${more}</ul></div>`;
  }

  function renderList(resetScroll) {
    const listNode = panel?.querySelector('[data-owa-list]');
    const scrollTop = !resetScroll && listNode ? listNode.scrollTop : 0;
    const displayAlarms = sortAlarmsForDisplay(alarms);

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,.07)">
        <div style="display:flex;align-items:center;gap:12px;min-width:0">
          <span style="font-weight:700;font-size:15px">Alarm Manager</span>
          <span class="owa-muted">${alarms.length} alarms</span>
          <span style="font-size:10px;color:#ff9500">Admin only</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <div class="owa-sortbar">
            <span class="owa-sortlabel">Sort</span>
            <select id="owaSortMode" class="owa-select" title="Sort alarms">
              <option value="status" ${sortMode === 'status' ? 'selected' : ''}>Status</option>
              <option value="name" ${sortMode === 'name' ? 'selected' : ''}>Name</option>
              <option value="active" ${sortMode === 'active' ? 'selected' : ''}>Active Zones</option>
              <option value="suppressed" ${sortMode === 'suppressed' ? 'selected' : ''}>Suppressed Zones</option>
            </select>
            <button id="owaSortReverse" class="owa-btn" title="Reverse sort order">${sortReverse ? '↓' : '↑'} ${esc(sortLabel())}</button>
          </div>
          <button id="owaNew" class="owa-btn primary">+ New</button>
          <button id="owaClose" class="owa-btn">✕ Close</button>
        </div>
      </div>
      <div data-owa-list style="flex:1;overflow:auto;padding:14px 20px 20px">${displayAlarms.map(cardHtml).join('') || '<div class="owa-muted">No alarms configured.</div>'}</div>`;

    panel.querySelector('#owaClose').onclick = close;
    panel.querySelector('#owaSortMode').onchange = e => { sortMode = e.target.value; persistSort(); renderList(true); };
    panel.querySelector('#owaSortReverse').onclick = () => { sortReverse = !sortReverse; persistSort(); renderList(false); };
    panel.querySelector('#owaNew').onclick = () => { editingId = 'new'; draft = { id:uid(), name:'New Alarm', description:'', role:'custom', builtin:false, default_armed:false, configured:true, trigger_filters: defaultTriggerFilters(), members:{ floor_ids:[], group_ids:[], zone_ids:[] } }; expanded.floors.clear(); expanded.groups.clear(); renderEditor(); };
    panel.querySelectorAll('[data-edit]').forEach(el => el.onclick = () => { const a = alarms.find(x => x.id === el.dataset.edit); if (!a) return; editingId = a.id; draft = JSON.parse(JSON.stringify(a)); ensureDraftExplicit(); expanded.floors.clear(); expanded.groups.clear(); renderEditor(); });
    panel.querySelectorAll('[data-toggle]').forEach(btn => btn.onclick = e => { e.stopPropagation(); const a = alarms.find(x => x.id === btn.dataset.toggle); if (!a || !canToggle()) return; window.owCallSwitch?.(alarmSwitchId(a), !alarmArmed(a)); setTimeout(() => renderList(false), 250); });
    panel.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = async e => { e.stopPropagation(); const a = alarms.find(x => x.id === btn.dataset.delete); if (!a || a.builtin) return; if (!confirm(`Delete ${a.name}?`)) return; alarms = alarms.filter(x => x.id !== a.id); await saveAlarms(); renderList(true); });
    const list = panel.querySelector('[data-owa-list]');
    if (list && !resetScroll) list.scrollTop = scrollTop;
  }

  function cardHtml(a) {
    const eff = getAlarmEffectiveState(a);
    const dDisabled = a.builtin ? 'disabled' : '';
    return `<div class="owa-card" data-edit="${esc(a.id)}"><div style="width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;flex:0 0 auto">🛡️</div><div style="flex:1;min-width:0"><div style="display:flex;gap:10px;align-items:center"><b>${esc(a.name)}</b>${pill(eff.state)}</div><div class="owa-counts"><span class="owa-count selected">Selected ${eff.selectedZoneIds.length}</span><span class="owa-count active">Active ${eff.activeZoneIds.length}</span><span class="owa-count suppressed">Suppressed ${eff.suppressedZoneIds.length}</span></div>${suppressionSummaryHtml(eff)}</div><div style="display:flex;gap:6px;flex:0 0 auto"><button class="owa-btn" data-toggle="${esc(a.id)}" ${canToggle() ? '' : 'disabled'}>${alarmArmed(a) ? 'ON' : 'OFF'}</button><button class="owa-btn" data-delete="${esc(a.id)}" ${dDisabled}>🗑</button></div></div>`;
  }

  function ensureDraftExplicit() {
    const mem = m(draft);
    if (hasWildcard(mem)) setExplicitZoneIds(mem, allZoneIds());
    setExplicitZoneIds(mem, new Set(resolveAlarmZones(draft).map(z => z.id)));
  }

  function draftEffectivePreview() {
    if (!draft) return null;
    const i = alarms.findIndex(a => a.id === editingId);
    const original = i >= 0 ? alarms[i] : null;
    if (i >= 0) alarms[i] = draft; else alarms.push(draft);
    const eff = getAlarmEffectiveState(draft);
    if (i >= 0) alarms[i] = original; else alarms = alarms.filter(a => a.id !== draft.id);
    return eff;
  }

  function renderEditor() {
    stopDynamicRefresh();
    ensureResponses(draft);
    ensureTriggerFilters(draft);
    const eff = draftEffectivePreview();
    panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid rgba(255,255,255,.07)"><div style="display:flex;gap:10px;align-items:center"><b>${editingId === 'new' ? 'New Alarm' : 'Edit Alarm'}</b>${eff ? pill(eff.state) : ''}</div><div style="display:flex;gap:8px;align-items:center"><button id="owaSave" class="owa-btn primary">💾 Save</button><button id="owaBack" class="owa-btn">← Back</button></div></div><div style="flex:1;overflow:auto;padding:16px 18px 40px"><label class="owa-muted">Alarm Name</label><input id="owaName" class="owa-input" value="${esc(draft.name)}"><label class="owa-muted" style="margin-top:12px">Description</label><textarea id="owaDesc" class="owa-input" rows="2" placeholder="Optional description" style="resize:vertical;min-height:52px">${esc(draft.description || '')}</textarea><div class="owa-muted" style="margin-top:6px">HA entity: ${esc(alarmSwitchId(draft))}</div>${eff ? effectiveDetailHtml(eff) : ''}${triggerFiltersHtml()}<h3 style="font-size:13px;margin:18px 0 6px">Members</h3><div class="owa-muted" style="margin-bottom:8px">Floors/groups are batch selectors only. Selecting a parent writes explicit zones so members can be unticked afterwards.</div><div id="owaTree" class="owa-tree"></div>${responseProfileHtml()}</div>`;
    panel.querySelector('#owaBack').onclick = () => { draft = null; editingId = null; renderList(true); startDynamicRefresh(); };
    panel.querySelector('#owaName').oninput = e => { draft.name = e.target.value; };
    const descEl = panel.querySelector('#owaDesc');
    if (descEl) descEl.oninput = e => { draft.description = e.target.value; };
    renderTree(panel.querySelector('#owaTree'));
    wireResponseControls();
    panel.querySelectorAll('[data-trigfilter]').forEach(cb => cb.onchange = () => { const k = cb.dataset.trigfilter; ensureTriggerFilters(draft)[k] = !!cb.checked; const warn = panel.querySelector('.owa-warn'); const any = TRIGGER_FILTER_KEYS.some(x => ensureTriggerFilters(draft)[x]); if (warn) warn.style.display = any ? 'none' : ''; else if (!any) { const host = panel.querySelector('#owaTrigFilters'); if (host) host.insertAdjacentHTML('afterend', '<div class="owa-warn"><b>Warning:</b> No trigger filters are enabled. This alarm will never enter a triggered state until at least one filter is selected.</div>'); } });
    panel.querySelector('#owaSave').onclick = async () => {
      if (!(draft.name || '').trim()) return alert('Enter an alarm name.');
      draft.configured = true;
      readResponseDraft();
      draft.description = String(draft.description || '').trim();
      ensureTriggerFilters(draft);
      ensureDraftExplicit();
      if (editingId === 'new') alarms.push(draft); else { const i = alarms.findIndex(a => a.id === editingId); if (i >= 0) alarms[i] = draft; }
      await saveAlarms();
      await loadAlarms();
      draft = null;
      editingId = null;
      renderList(true);
      startDynamicRefresh();
    };
  }

  function responseTreeHtml(scope, key, label, deviceKey, domains, action) {
    const selected = new Set(action.entities || []);
    const fs = floors().length ? floors() : [{ id:'floor_default', name:'Ground Floor' }];
    let html = `<div class="owa-response-tree" data-response-tree="${scope}.${key}"><div style="font-weight:800;text-transform:uppercase;color:#32d74b;font-size:11px;margin-bottom:7px">▾ ${esc(label)}</div>`;
    fs.forEach(f => {
      const floorZones = zonesForFloor(f.id).filter(z => responseEntityListForZone(z, deviceKey).length);
      if (!floorZones.length) return;
      html += `<div class="owa-response-row"><input type="checkbox" data-response-parent="${scope}.${key}" data-response-ids="${esc(floorZones.flatMap(z => responseEntityListForZone(z, deviceKey)).join('|'))}"><b>${esc(f.name || f.id)}</b></div>`;
      groupRowsForFloor(f.id).forEach(({ g, zs }) => {
        const groupZones = zs.filter(z => responseEntityListForZone(z, deviceKey).length);
        if (!groupZones.length) return;
        html += `<div class="owa-response-row depth1"><span>▾</span><input type="checkbox" data-response-parent="${scope}.${key}" data-response-ids="${esc(groupZones.flatMap(z => responseEntityListForZone(z, deviceKey)).join('|'))}"><b>${esc(g.name || g.id)}</b></div>`;
        groupZones.forEach(z => {
          const ids = responseEntityListForZone(z, deviceKey);
          const zState = getZoneStateSafe(z);
          html += `<div class="owa-response-row depth2"><span>▾</span><input type="checkbox" data-response-parent="${scope}.${key}" data-response-ids="${esc(ids.join('|'))}"><span>${esc(z.name || z.id)}</span>${zState ? `<span class="tag ${zState === 'triggered' ? 'triggered' : ''}">${esc(zState)}</span>` : ''}</div>`;
          ids.forEach(eid => html += `<label class="owa-response-row depth3"><input type="checkbox" data-response-entity-check="${scope}.${key}" value="${esc(eid)}" ${selected.has(eid) ? 'checked' : ''}><span>${esc(entityLabel(eid))}</span></label>`);
        });
      });
      ungroupedZonesForFloor(f.id).filter(z => responseEntityListForZone(z, deviceKey).length).forEach(z => {
        const ids = responseEntityListForZone(z, deviceKey);
        html += `<div class="owa-response-row depth1"><span>▾</span><input type="checkbox" data-response-parent="${scope}.${key}" data-response-ids="${esc(ids.join('|'))}"><b>${esc(z.name || z.id)}</b></div>`;
        ids.forEach(eid => html += `<label class="owa-response-row depth2"><input type="checkbox" data-response-entity-check="${scope}.${key}" value="${esc(eid)}" ${selected.has(eid) ? 'checked' : ''}><span>${esc(entityLabel(eid))}</span></label>`);
      });
    });
    const other = responseOtherEntities(deviceKey, domains);
    html += `<details class="owa-response-other"><summary class="owa-btn" style="display:inline-block">Other ${esc(label.toLowerCase())} from HA (${other.length})</summary><div style="margin-top:8px;max-height:220px;overflow:auto">${other.map(eid => `<label class="owa-response-row depth1"><input type="checkbox" data-response-entity-check="${scope}.${key}" value="${esc(eid)}" ${selected.has(eid) ? 'checked' : ''}><span>${esc(entityLabel(eid))}</span></label>`).join('')}</div></details>`;
    return html + '</div>';
  }

  function getZoneStateSafe(z) {
    try { return typeof window.getZoneState === 'function' ? window.getZoneState(z) : ''; } catch { return ''; }
  }

  function searchResponseHtml(scope, key, label, hint, action, domains) {
    const listId = `owa_${scope}_${key}_entities`;
    const selected = (action.entities || []).map(entityId => `<span class="owa-entity-pill" data-response-entity="${scope}.${key}" data-entity-id="${esc(entityId)}"><span>${esc(entityLabel(entityId))}</span><button type="button" data-remove-response-entity="1">×</button></span>`).join('');
    return `<div class="owa-section"><label style="display:flex;gap:8px;align-items:center;font-weight:700"><input type="checkbox" data-response-enabled="${scope}.${key}" ${action.enabled ? 'checked' : ''}>${esc(label)}</label><div style="display:flex;gap:6px;margin-top:8px"><input class="owa-input" list="${esc(listId)}" data-response-search="${scope}.${key}" placeholder="${esc(hint)}"><button type="button" class="owa-btn" data-response-add="${scope}.${key}">Add</button></div>${datalistOptions(listId, domains)}<div class="owa-entity-list" data-response-selected="${scope}.${key}">${selected}</div></div>`;
  }

  function notifyResponseHtml(scope, action) {
    return `<div class="owa-section"><label style="display:flex;gap:8px;align-items:center;font-weight:700"><input type="checkbox" data-response-enabled="${scope}.notify" ${action.enabled ? 'checked' : ''}>Notify</label><textarea class="owa-input" data-response-list="${scope}.notify.targets" rows="2" placeholder="One notify target per line" style="resize:vertical;min-height:46px;margin-top:8px">${esc(arrayToLines(action.targets))}</textarea></div>`;
  }

  function responseSetHtml(scope, title, description, set) {
    return `<div class="owa-section"><div style="font-weight:700;margin-bottom:4px">${esc(title)}</div><div class="owa-muted" style="margin-bottom:8px">${esc(description)}</div>${notifyResponseHtml(scope, set.notify)}${responseTreeHtml(scope, 'sirens', 'Sirens', 'sirens', ['siren', 'switch'], set.sirens)}${responseTreeHtml(scope, 'lights', 'Light', 'lights', ['light', 'switch'], set.lights)}${responseTreeHtml(scope, 'cameras', 'Cameras', 'cameras', ['camera'], set.cameras)}${searchResponseHtml(scope, 'scripts', 'HA Scripts', 'Search script entities to run', set.scripts, ['script'])}${searchResponseHtml(scope, 'automations', 'HA Automations', 'Search automation entities to trigger', set.automations, ['automation'])}</div>`;
  }

  function responseProfileHtml() {
    const r = ensureResponses(draft);
    return `<h3 style="font-size:13px;margin:18px 0 6px">Response Profile</h3><div class="owa-muted" style="margin-bottom:8px">Stored on the alarm profile only. Each response type has its own enable checkbox. Execution and managed HA automation generation are deferred.</div>${responseSetHtml('triggered_armed', 'Triggered Armed', 'Actions for active unsuppressed zones while the alarm is armed.', r.triggered_armed)}${responseSetHtml('triggered_disarmed', 'Triggered Disarmed', 'Actions for selected zones that trigger while the alarm is disarmed. Useful for lights/cameras without siren escalation.', r.triggered_disarmed)}`;
  }

  function wireResponseControls() {
    panel.querySelectorAll('[data-response-parent]').forEach(cb => cb.onchange = () => {
      const key = cb.dataset.responseParent;
      const ids = (cb.dataset.responseIds || '').split('|').filter(Boolean);
      ids.forEach(id => panel.querySelectorAll(`[data-response-entity-check="${CSS.escape(key)}"][value="${CSS.escape(id)}"]`).forEach(child => { child.checked = cb.checked; }));
    });
    panel.querySelectorAll('[data-response-add]').forEach(btn => btn.onclick = () => {
      const key = btn.dataset.responseAdd;
      const input = panel.querySelector(`[data-response-search="${CSS.escape(key)}"]`);
      const host = panel.querySelector(`[data-response-selected="${CSS.escape(key)}"]`);
      const entityId = String(input?.value || '').trim();
      if (!entityId || !host || host.querySelector(`[data-entity-id="${CSS.escape(entityId)}"]`)) return;
      const pill = document.createElement('span');
      pill.className = 'owa-entity-pill';
      pill.dataset.responseEntity = key;
      pill.dataset.entityId = entityId;
      pill.innerHTML = `<span>${esc(entityLabel(entityId))}</span><button type="button" data-remove-response-entity="1">×</button>`;
      host.appendChild(pill);
      if (input) input.value = '';
      pill.querySelector('[data-remove-response-entity]').onclick = () => pill.remove();
    });
    panel.querySelectorAll('[data-remove-response-entity]').forEach(btn => btn.onclick = () => btn.closest('[data-response-entity]')?.remove());
  }

  function readResponseDraft() {
    const r = ensureResponses(draft);
    panel.querySelectorAll('[data-response-enabled]').forEach(cb => {
      const [scope, key] = cb.dataset.responseEnabled.split('.');
      if (r[scope]?.[key]) r[scope][key].enabled = !!cb.checked;
    });
    panel.querySelectorAll('[data-response-list]').forEach(ta => {
      const [scope, key, field] = ta.dataset.responseList.split('.');
      if (r[scope]?.[key]) r[scope][key][field] = linesToArray(ta.value);
    });
    ['triggered_armed', 'triggered_disarmed'].forEach(scope => ['sirens', 'lights', 'cameras'].forEach(key => {
      if (!r[scope]?.[key]) return;
      r[scope][key].entities = Array.from(panel.querySelectorAll(`[data-response-entity-check="${scope}.${key}"]:checked`)).map(el => el.value).filter(Boolean);
    }));
    panel.querySelectorAll('[data-response-selected]').forEach(host => {
      const [scope, key] = host.dataset.responseSelected.split('.');
      if (r[scope]?.[key]) r[scope][key].entities = Array.from(host.querySelectorAll('[data-entity-id]')).map(el => el.dataset.entityId).filter(Boolean);
    });
    draft.responses = normaliseResponses(r);
  }

  
  function triggerFiltersHtml() {
    const f = ensureTriggerFilters(draft);
    const any = TRIGGER_FILTER_KEYS.some(k => f[k]);
    const warn = !any ? `<div class="owa-warn"><b>Warning:</b> No trigger filters are enabled. This alarm will never enter a triggered state until at least one filter is selected.</div>` : '';
    return `<h3 style="font-size:13px;margin:18px 0 6px">Trigger Filters</h3>` +
      `<div class="owa-muted" style="margin-bottom:8px">Alarm will only trigger when the triggering entity type matches a checked filter. If none are selected, it will never trigger.</div>` +
      `<div class="owa-section" id="owaTrigFilters" style="display:flex;flex-wrap:wrap;gap:10px">` +
      `${TRIGGER_FILTER_KEYS.map(k => `<label style="display:flex;gap:8px;align-items:center;min-width:140px"><input type="checkbox" data-trigfilter="${k}" ${f[k] ? 'checked' : ''}> ${esc(TRIGGER_FILTER_LABELS[k] || k)}</label>`).join('')}` +
      `</div>` + warn;
  }

function effectiveDetailHtml(eff) {
    const active = eff.activeZoneIds.slice(0, 8).map(id => esc(zoneName(id))).join(', ');
    return `<div class="owa-section"><div style="font-weight:700;margin-bottom:6px">Effective state</div><div class="owa-counts"><span class="owa-count selected">Selected ${eff.selectedZoneIds.length}</span><span class="owa-count active">Active ${eff.activeZoneIds.length}</span><span class="owa-count suppressed">Suppressed ${eff.suppressedZoneIds.length}</span></div>${active ? `<div class="owa-muted" style="margin-top:8px">Active: ${active}${eff.activeZoneIds.length > 8 ? '…' : ''}</div>` : ''}${suppressionSummaryHtml(eff, 12)}</div>`;
  }


  const selectedSet = () => explicitZoneIds(m(draft));
  const allSelected = ids => { const sel = selectedSet(); return ids.length > 0 && ids.every(id => sel.has(id)); };
  const someSelected = ids => { const sel = selectedSet(); return ids.some(id => sel.has(id)); };
  function setZoneIds(ids, checked) { const sel = selectedSet(); ids.forEach(id => checked ? sel.add(id) : sel.delete(id)); setExplicitZoneIds(m(draft), sel); draft.configured = true; }

  function renderTree(host) {
    let html = '';
    const fs = floors().length ? floors() : [{ id:'floor_default', name:'Ground Floor' }];
    fs.forEach(f => {
      const fids = zonesForFloor(f.id).map(z => z.id);
      html += row('floor', f.id, f.name || f.id, allSelected(fids), someSelected(fids), 0, expanded.floors.has(f.id), true);
      if (!expanded.floors.has(f.id)) return;
      groupRowsForFloor(f.id).forEach(({ g, zs }) => {
        const gids = zs.map(z => z.id);
        html += row('group', g.id, g.name || g.id, allSelected(gids), someSelected(gids), 22, expanded.groups.has(g.id), true);
        if (expanded.groups.has(g.id)) zs.forEach(z => html += row('zone', z.id, z.name || z.id, selectedSet().has(z.id), false, 44, false, false));
      });
      ungroupedZonesForFloor(f.id).forEach(z => html += row('zone', z.id, z.name || z.id, selectedSet().has(z.id), false, 22, false, false));
    });
    host.innerHTML = html || '<div class="owa-muted">No zones configured.</div>';
    host.querySelectorAll('[data-expand]').forEach(btn => btn.onclick = e => { e.preventDefault(); e.stopPropagation(); const set = btn.dataset.type === 'floor' ? expanded.floors : expanded.groups; set.has(btn.dataset.id) ? set.delete(btn.dataset.id) : set.add(btn.dataset.id); renderTree(host); });
    host.querySelectorAll('input[data-type]').forEach(cb => { cb.indeterminate = cb.dataset.mixed === 'true'; cb.onchange = () => { const type = cb.dataset.type, id = cb.dataset.id; if (type === 'floor') setZoneIds(zonesForFloor(id).map(z => z.id), cb.checked); else if (type === 'group') setZoneIds(zonesForGroup(id).map(z => z.id), cb.checked); else setZoneIds([id], cb.checked); renderTree(host); }; });
  }

  function row(type, id, label, checked, mixed, pad, isExpanded, expandable) {
    const symbol = expandable ? (isExpanded ? '▾' : '▸') : '•';
    return `<label class="owa-row" style="padding-left:${pad}px"><button class="owa-exp ${expandable ? '' : 'leaf'}" data-expand="1" data-type="${esc(type)}" data-id="${esc(id)}">${symbol}</button><input type="checkbox" data-type="${esc(type)}" data-id="${esc(id)}" data-mixed="${mixed && !checked ? 'true' : 'false'}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  }

  window.OW_Alarms = { open, close, toggle, getAlarmEffectiveState };
})();

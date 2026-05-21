/* ================================================================
 * HA-Overwatch — ow-alarms.js
 * Alarm Manager (admin-only)
 *
 * v0.05.01 foundation:
 *  - Stores alarm definitions in config/alarms.json via /ow/alarms
 *  - Uses HA switch entities: switch.overwatch_alarm_<slug>
 *  - Computes effective state: armed_full / armed_partial / disarmed
 *  - Overlap rule: disarmed alarm zones suppress coverage in armed alarms (partial)
 *  - Manual zone disarm (zone switch OFF) suppresses coverage (partial)
 *
 * NOTE:
 *  - This UI does NOT yet enforce zone switch state to match alarm intent.
 *    (i.e., it does not automatically arm/disarm member zones).
 *    That reconcile engine is best done in 0.05.02 to avoid overlap edge cases.
 * ================================================================ */
(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────
  let _panelEl = null;
  let _open = false;
  let _alarms = [];          // array of alarm defs
  let _editingId = null;     // alarm id
  let _draft = null;
  let _listSearch = '';

  // ── Guards / helpers ────────────────────────────────────────
  function isAdmin() { return !document.querySelector('meta[name="ow-direct"]'); }
  function ow() { return window.OW || {}; }
  function apiPath(p) { return ow().apiPath ? ow().apiPath(p) : p; }
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function uid(prefix='alarm') { return prefix + '_' + Math.random().toString(36).slice(2, 9); }
  function nameSlug(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function floors() { return ow().floors || []; }
  function groups() { return ow().groups || []; }
  function zones()  { return ow().zones  || []; }
  function haStates() { return ow().haStates || {}; }

  function zoneSwitchId(z) {
    // Must match app.js zoneSlug() logic
    const slug = nameSlug(z?.name) || z?.id;
    return `switch.overwatch_zone_${slug}`;
  }
  function alarmSwitchId(a) {
    const slug = nameSlug(a?.name) || a?.id;
    return `switch.overwatch_alarm_${slug}`;
  }

  function canToggle() {
    // Uses app.js helper (IP allow-list)
    try { return typeof window.canArmDisarm === 'function' ? window.canArmDisarm() : false; }
    catch { return false; }
  }

  // ── Storage ─────────────────────────────────────────────────
  async function loadAlarms() {
    try {
      const r = await fetch(apiPath('ow/alarms') + '?v=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      _alarms = Array.isArray(data) ? data : (data?.alarms || []);
    } catch {
      _alarms = [];
    }

    // Ensure defaults
    ensureDefaults();

    return _alarms;
  }

  function ensureDefaults() {
    const hasAway = _alarms.some(a => (a.role || '').toLowerCase() === 'away');
    const hasHome = _alarms.some(a => (a.role || '').toLowerCase() === 'home');

    if (!hasAway) {
      _alarms.unshift({
        id: 'away',
        name: 'Away',
        role: 'away',
        builtin: true,
        locked: true,
        default_armed: true,
        members: { floor_ids: ['*'], group_ids: ['*'], zone_ids: ['*'] },
      });
    }
    if (!hasHome) {
      _alarms.unshift({
        id: 'home',
        name: 'Home',
        role: 'home',
        builtin: true,
        locked: false,
        default_armed: false,
        members: { floor_ids: [], group_ids: [], zone_ids: [] },
      });
    }

    // Fill missing required fields
    _alarms.forEach(a => {
      if (!a.id) a.id = uid('alarm');
      if (!a.name) a.name = a.id;
      if (!a.members) a.members = { floor_ids: [], group_ids: [], zone_ids: [] };
      if (!Array.isArray(a.members.floor_ids)) a.members.floor_ids = [];
      if (!Array.isArray(a.members.group_ids)) a.members.group_ids = [];
      if (!Array.isArray(a.members.zone_ids))  a.members.zone_ids  = [];
    });
  }

  async function saveAlarms() {
    try {
      await fetch(apiPath('ow/alarms'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_alarms, null, 2),
      });
      // Trigger HA reload so new alarm switches appear
      if (typeof window.scheduleHAReload === 'function') window.scheduleHAReload(1500);
    } catch (e) {
      console.warn('[OW-Alarms] saveAlarms failed:', e?.message || e);
    }
  }

  // ── Membership resolution ───────────────────────────────────
  function zonesForFloorId(fid) {
    const fl = floors();
    const firstFloorId = fl[0]?.id;
    return zones().filter(z => {
      const zfid = z.floor_id || z.floorId || z.floor || z.floor_id;
      // app.js logic: zones without floor_id belong to first floor
      if (!zfid) return fid === firstFloorId;
      return zfid === fid;
    });
  }

  function zonesForGroupId(gidRaw) {
    const g = groups().find(x => x.id === gidRaw);
    if (!g) return [];
    const ids = g.zone_ids || [];
    return ids.map(zid => zones().find(z => z.id === zid)).filter(Boolean);
  }

  function resolveAlarmZones(alarm) {
    const m = alarm?.members || { floor_ids: [], group_ids: [], zone_ids: [] };

    // '*' means everything (Away default)
    if (m.floor_ids?.includes('*') || m.group_ids?.includes('*') || m.zone_ids?.includes('*')) {
      return zones().slice();
    }

    const set = new Map();

    // floors
    (m.floor_ids || []).forEach(fid => {
      zonesForFloorId(fid).forEach(z => set.set(z.id, z));
    });

    // groups
    (m.group_ids || []).forEach(gid => {
      zonesForGroupId(gid).forEach(z => set.set(z.id, z));
    });

    // direct zones
    (m.zone_ids || []).forEach(zid => {
      const z = zones().find(z => z.id === zid);
      if (z) set.set(z.id, z);
    });

    return [...set.values()];
  }

  // ── State computation ───────────────────────────────────────
  function haSwitchOn(entityId) {
    const st = haStates()[entityId];
    if (!st) return null;
    return String(st.state || '').toLowerCase() !== 'off';
  }

  function alarmArmed(alarm) {
    const on = haSwitchOn(alarmSwitchId(alarm));
    if (on === null) {
      // Not in HA yet: fall back to default_armed (builtin) else false
      return !!alarm?.default_armed;
    }
    return on;
  }

  function zoneArmedInHA(zone) {
    const on = haSwitchOn(zoneSwitchId(zone));
    // If unknown, treat as armed to avoid false partial before HA states load.
    return on === null ? true : on;
  }

  function computeAlarmEffective(alarm) {
    const armed = alarmArmed(alarm);
    if (!armed) return { status: 'disarmed', suppressed: [], zones: resolveAlarmZones(alarm) };

    const myZones = resolveAlarmZones(alarm);
    const myZoneIds = new Set(myZones.map(z => z.id));

    // Zones suppressed by disarmed alarms (overlap degradation)
    const suppressedByOther = new Set();
    _alarms.forEach(other => {
      if (!other || other === alarm) return;
      if (alarmArmed(other)) return; // only disarmed alarms suppress
      resolveAlarmZones(other).forEach(z => {
        if (myZoneIds.has(z.id)) suppressedByOther.add(z.id);
      });
    });

    // Zones suppressed by manual zone disarm (zone switch off)
    const suppressedByManual = new Set();
    myZones.forEach(z => {
      if (!zoneArmedInHA(z)) suppressedByManual.add(z.id);
    });

    const suppressed = [...new Set([...suppressedByOther, ...suppressedByManual])];
    const status = suppressed.length ? 'armed_partial' : 'armed_full';

    return { status, suppressed, zones: myZones };
  }

  // ── UI ─────────────────────────────────────────────────────
  function mountPanel() {
    if (_panelEl) return;
    _panelEl = document.createElement('div');
    _panelEl.id = 'owAlarmsPanel';
    _panelEl.style.cssText = 'position:fixed;inset:0;z-index:9600;background:rgba(8,8,10,0.98);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;font-size:13px;color:#e0e0e0;overflow:hidden;opacity:0;transition:opacity 0.18s ease;pointer-events:none;';
    document.body.appendChild(_panelEl);
  }
  function unmountPanel() {
    if (_panelEl) { _panelEl.remove(); _panelEl = null; }
  }

  function injectStyles() {
    if (document.getElementById('ow-alarms-styles')) return;
    const s = document.createElement('style');
    s.id = 'ow-alarms-styles';
    s.textContent = `
      @keyframes ow-blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
      .ow-pill{font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;border-radius:999px;padding:3px 8px;display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,0.12)}
      .ow-pill .dot{width:7px;height:7px;border-radius:50%}
      .ow-btn{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#aaa;border-radius:8px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600;}
      .ow-btn.primary{background:#0064d2;border-color:rgba(0,100,210,0.18);color:#fff;}
      .ow-btn:disabled{opacity:0.35;cursor:default;}
      .ow-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:13px 15px;margin-bottom:7px;display:flex;align-items:center;gap:12px;}
      .ow-card:hover{background:rgba(255,255,255,0.055);}
      .ow-mini{font-size:11px;color:#555;}
      .ow-input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#fff;padding:7px 10px;font-size:12px;outline:none;box-sizing:border-box;}
      .ow-tree{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px;max-height:50vh;overflow:auto;}
      .ow-tree .row{display:flex;align-items:center;gap:8px;padding:3px 4px;}
      .ow-tree .row .label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      input[type=checkbox]:indeterminate { accent-color: #ff9500; }
    `;
    document.head.appendChild(s);
  }

  async function open() {
    if (!isAdmin()) return;
    _open = true;
    injectStyles();
    mountPanel();
    await loadAlarms();
    document.getElementById('alarmsBtn')?.classList.add('active');
    renderList();
    requestAnimationFrame(() => {
      _panelEl.style.opacity = '1';
      _panelEl.style.pointerEvents = 'all';
    });
  }

  function close() {
    _open = false;
    _editingId = null;
    _draft = null;
    document.getElementById('alarmsBtn')?.classList.remove('active');
    if (_panelEl) {
      _panelEl.style.opacity = '0';
      _panelEl.style.pointerEvents = 'none';
      setTimeout(() => unmountPanel(), 200);
    }
  }

  async function toggle() {
    if (_open) close();
    else await open();
  }

  function pillFor(status) {
    if (status === 'armed_full')   return { text: 'armed_full',   bg: 'rgba(50,215,75,0.15)',  br: 'rgba(50,215,75,0.35)',  fg: '#32d74b' };
    if (status === 'armed_partial')return { text: 'armed_partial',bg: 'rgba(255,149,0,0.15)', br: 'rgba(255,149,0,0.35)', fg: '#ff9500' };
    return { text: 'disarmed', bg: 'rgba(255,255,255,0.05)', br: 'rgba(255,255,255,0.10)', fg: '#777' };
  }

  function renderList() {
    if (!_panelEl) return;

    const filtered = _listSearch
      ? _alarms.filter(a => (a.name || '').toLowerCase().includes(_listSearch.toLowerCase()))
      : _alarms.slice();

    const html = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:12px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="opacity:0.7;"><path d="M12 2l7 4v6c0 5-3 9-7 10-4-1-7-5-7-10V6l7-4z" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>
          <span style="font-size:15px;font-weight:600;">Alarm Manager</span>
          <span style="font-size:11px;color:#555;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:2px 8px;">${_alarms.length} alarm${_alarms.length!==1?'s':''}</span>
          <span style="font-size:10px;color:#ff9500;background:rgba(255,149,0,0.1);border:1px solid rgba(255,149,0,0.2);border-radius:6px;padding:2px 7px;">Admin only</span>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="owAlarmRefreshBtn" class="ow-btn" title="Reload">↻</button>
          <button id="owAlarmNewBtn" class="ow-btn primary">+ New</button>
          <button id="owAlarmCloseBtn" class="ow-btn">✕ Close</button>
        </div>
      </div>
      <div style="padding:10px 20px 0;flex-shrink:0;">
        <div style="position:relative;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:0.4;"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
          <input id="owAlarmListSearch" class="ow-input" style="padding-left:32px;" type="text" value="${esc(_listSearch)}" placeholder="Search alarms…" />
        </div>
        <div class="ow-mini" style="margin-top:6px;">Toggles require your client IP to be in the arm allow-list.</div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:12px 20px 20px;">
        ${filtered.length===0 ? `<div style="color:#444;padding:20px;text-align:center;">No alarms match.</div>` : filtered.map(a => alarmCard(a)).join('')}
      </div>
    `;

    _panelEl.innerHTML = html;

    _panelEl.querySelector('#owAlarmCloseBtn')?.addEventListener('click', close);
    _panelEl.querySelector('#owAlarmRefreshBtn')?.addEventListener('click', async () => { await loadAlarms(); renderList(); });
    _panelEl.querySelector('#owAlarmNewBtn')?.addEventListener('click', () => {
      _editingId = 'new';
      _draft = {
        id: uid('alarm'),
        name: 'New Alarm',
        role: 'custom',
        builtin: false,
        locked: false,
        default_armed: false,
        members: { floor_ids: [], group_ids: [], zone_ids: [] },
      };
      renderEditor();
    });

    const s = _panelEl.querySelector('#owAlarmListSearch');
    if (s) {
      s.oninput = () => { _listSearch = s.value || ''; renderList(); };
      s.onkeydown = e => e.stopPropagation();
    }

    _panelEl.querySelectorAll('[data-alarm-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.alarmEdit;
        const found = _alarms.find(a => a.id === id);
        if (!found) return;
        _editingId = id;
        _draft = JSON.parse(JSON.stringify(found));
        renderEditor();
      });
    });

    _panelEl.querySelectorAll('[data-alarm-del]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.alarmDel;
        const a = _alarms.find(x => x.id === id);
        if (!a) return;
        if (a.builtin) { alert('Built-in alarms cannot be deleted.'); return; }
        if (!confirm(`Delete "${a.name}"?`)) return;
        _alarms = _alarms.filter(x => x.id !== id);
        await saveAlarms();
        await loadAlarms();
        renderList();
      });
    });

    _panelEl.querySelectorAll('[data-alarm-toggle]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.alarmToggle;
        const a = _alarms.find(x => x.id === id);
        if (!a) return;
        const ent = alarmSwitchId(a);
        const current = alarmArmed(a);
        if (!canToggle()) return;
        if (typeof window.owCallSwitch === 'function') {
          window.owCallSwitch(ent, !current);
        } else {
          // owCallSwitch is global in app.js. If not present, fallback.
          try { ow().sendHA?.({ type: 'call_service', domain: 'switch', service: (!current ? 'turn_on' : 'turn_off'), service_data: { entity_id: ent } }); } catch {}
        }
        // optimistic UI refresh
        setTimeout(() => renderList(), 200);
      });
    });
  }

  function alarmCard(alarm) {
    const eff = computeAlarmEffective(alarm);
    const pill = pillFor(eff.status);
    const armed = alarmArmed(alarm);
    const toggleDis = !canToggle();

    const subtitle = eff.status === 'armed_partial'
      ? `${eff.suppressed.length} zone(s) suppressed`
      : `${eff.zones.length} zone(s)`;

    return `
      <div class="ow-card" style="cursor:pointer;" data-alarm-edit="${esc(alarm.id)}">
        <div style="width:34px;height:34px;border-radius:9px;flex-shrink:0;background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center;">
          <span style="font-size:16px;opacity:0.6;">🛡️</span>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(alarm.name || alarm.id)}</div>
            <span class="ow-pill" style="background:${pill.bg};border-color:${pill.br};color:${pill.fg};">
              <span class="dot" style="background:${pill.fg};${eff.status==='armed_partial'?'animation:ow-blink 1.2s ease-in-out infinite;':''}"></span>
              ${pill.text}
            </span>
          </div>
          <div class="ow-mini" style="margin-top:4px;">${esc(subtitle)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="ow-btn" data-alarm-toggle="${esc(alarm.id)}" ${toggleDis?'disabled':''} title="Toggle alarm">${armed ? 'ON' : 'OFF'}</button>
          <button class="ow-btn" data-alarm-del="${esc(alarm.id)}" ${alarm.builtin?'disabled':''} title="Delete">🗑</button>
        </div>
      </div>
    `;
  }

  function renderEditor() {
    if (!_panelEl || !_draft) return;

    const locked = !!_draft.locked;

    _panelEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:10px;">
          <button id="owAlarmBackBtn" class="ow-btn">← Back</button>
          <span style="font-size:14px;font-weight:600;">${_editingId==='new'?'New Alarm':'Edit Alarm'}</span>
        </div>
        <button id="owAlarmSaveBtn" class="ow-btn primary">💾 Save</button>
      </div>
      <div id="owAlarmScrollBody" style="flex:1;overflow-y:auto;padding:0 18px 40px;">
        <div style="padding:16px 0 12px;border-bottom:1px solid rgba(255,255,255,0.05);">
          <label style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#555;margin-bottom:4px;">Alarm Name</label>
          <input id="owAlarmName" class="ow-input" type="text" value="${esc(_draft.name || '')}" ${locked?'disabled':''} />
          <div class="ow-mini" style="margin-top:6px;">HA entity: <span style="color:#777;">${esc(alarmSwitchId(_draft))}</span></div>
          ${locked?'<div class="ow-mini" style="margin-top:4px;color:#ff9500;">Built-in alarm — membership may be locked.</div>':''}
        </div>

        <div style="padding:16px 0 0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;">
            <div>
              <div style="font-size:13px;font-weight:700;">Members</div>
              <div class="ow-mini">Select Floors / Groups / Zones. Parent selections auto-include future children.</div>
            </div>
            <div style="min-width:220px;">
              <input id="owAlarmMemberSearch" class="ow-input" placeholder="Filter…" />
            </div>
          </div>
          <div id="owAlarmTree" class="ow-tree"></div>
        </div>
      </div>
    `;

    _panelEl.querySelector('#owAlarmBackBtn')?.addEventListener('click', () => { _draft=null; _editingId=null; renderList(); });

    const nameEl = _panelEl.querySelector('#owAlarmName');
    if (nameEl) {
      nameEl.oninput = () => { _draft.name = nameEl.value; };
      nameEl.onkeydown = e => e.stopPropagation();
    }

    renderMemberTree(_panelEl.querySelector('#owAlarmTree'));

    const filterEl = _panelEl.querySelector('#owAlarmMemberSearch');
    if (filterEl) {
      filterEl.oninput = () => applyTreeFilter(filterEl.value);
      filterEl.onkeydown = e => e.stopPropagation();
    }

    _panelEl.querySelector('#owAlarmSaveBtn')?.addEventListener('click', async () => {
      if (!(_draft.name || '').trim()) { alert('Enter a name.'); return; }

      // Normalise ID if user renamed a new alarm
      if (_editingId === 'new') {
        _alarms.push(_draft);
      } else {
        const idx = _alarms.findIndex(a => a.id === _editingId);
        if (idx >= 0) _alarms[idx] = _draft;
      }

      // Ensure built-ins remain present
      ensureDefaults();

      await saveAlarms();
      await loadAlarms();
      _draft = null;
      _editingId = null;
      renderList();
    });
  }

  function buildTreeModel() {
    const fl = floors();
    const gr = groups();
    const zs = zones();
    const grouped = new Set(gr.flatMap(g => g.zone_ids || []));

    // Floor mapping
    const byFloor = new Map();
    const firstFloorId = fl[0]?.id;
    zs.forEach(z => {
      const fid = z.floor_id || (!z.floor_id && firstFloorId) || null;
      const key = fid || firstFloorId || 'floor_default';
      if (!byFloor.has(key)) byFloor.set(key, []);
      byFloor.get(key).push(z);
    });

    const out = [];
    if (fl.length) {
      fl.forEach(f => {
        // groups for this floor
        const fGroups = gr.map(g => {
          const zlist = (g.zone_ids || []).map(id => zs.find(z => z.id === id)).filter(Boolean)
            .filter(z => (z.floor_id || null) === f.id || (!z.floor_id && f.id === firstFloorId));
          return zlist.length ? { id: g.id, name: g.name || g.id, zones: zlist } : null;
        }).filter(Boolean);

        const fUng = (byFloor.get(f.id) || []).filter(z => !grouped.has(z.id));
        out.push({ id: f.id, name: f.name || f.id, groups: fGroups, ungrouped: fUng });
      });
    } else {
      // no floors
      const gBlocks = gr.map(g => ({ id: g.id, name: g.name || g.id, zones: (g.zone_ids || []).map(id => zs.find(z => z.id === id)).filter(Boolean) }))
        .filter(g => g.zones.length);
      const ung = zs.filter(z => !grouped.has(z.id));
      out.push({ id: 'floor_default', name: 'All Zones', groups: gBlocks, ungrouped: ung });
    }

    // Sort alphabetically
    out.forEach(f => {
      f.groups.sort((a,b) => a.name.localeCompare(b.name));
      f.groups.forEach(g => g.zones.sort((a,b) => (a.name||a.id).localeCompare(b.name||b.id)));
      f.ungrouped.sort((a,b) => (a.name||a.id).localeCompare(b.name||b.id));
    });

    return out;
  }

  function renderMemberTree(container) {
    if (!container) return;

    const model = buildTreeModel();
    const m = _draft.members;

    function isFloorSel(fid) { return (m.floor_ids || []).includes(fid) || (m.floor_ids || []).includes('*'); }
    function isGroupSel(gid) { return (m.group_ids || []).includes(gid) || (m.group_ids || []).includes('*'); }
    function isZoneSel(zid)  { return (m.zone_ids  || []).includes(zid) || (m.zone_ids  || []).includes('*'); }

    function rowCheckbox(type, id, checked, indeterminate=false) {
      const cid = `${type}-${id}`;
      return `<input type="checkbox" data-ow-type="${esc(type)}" data-ow-id="${esc(id)}" id="${esc(cid)}" ${checked?'checked':''} />`;
    }

    let html = '';
    model.forEach(f => {
      html += `<div class="row" data-ow-label="${esc(f.name)}" style="padding-left:2px;">
        ${rowCheckbox('floor', f.id, isFloorSel(f.id))}
        <span class="label" style="font-weight:800;color:#bbb;text-transform:uppercase;font-size:11px;letter-spacing:0.06em;">${esc(f.name)}</span>
      </div>`;

      f.groups.forEach(g => {
        html += `<div class="row" data-ow-label="${esc(g.name)}" style="padding-left:18px;">
          ${rowCheckbox('group', g.id, isGroupSel(g.id))}
          <span class="label" style="font-weight:700;color:#ccc;">${esc(g.name)}</span>
        </div>`;

        g.zones.forEach(z => {
          html += `<div class="row" data-ow-label="${esc(z.name||z.id)}" style="padding-left:34px;">
            ${rowCheckbox('zone', z.id, isZoneSel(z.id))}
            <span class="label">${esc(z.name||z.id)}</span>
          </div>`;
        });
      });

      if (f.ungrouped.length) {
        html += `<div class="row" data-ow-label="Ungrouped" style="padding-left:18px;">
          <span style="width:18px;display:inline-block;"></span>
          <span class="label" style="font-weight:700;color:#777;">Ungrouped</span>
        </div>`;
        f.ungrouped.forEach(z => {
          html += `<div class="row" data-ow-label="${esc(z.name||z.id)}" style="padding-left:34px;">
            ${rowCheckbox('zone', z.id, isZoneSel(z.id))}
            <span class="label">${esc(z.name||z.id)}</span>
          </div>`;
        });
      }

      html += `<div style="height:8px;"></div>`;
    });

    container.innerHTML = html;

    // Wire changes
    container.querySelectorAll('input[type=checkbox][data-ow-type]').forEach(cb => {
      cb.addEventListener('change', () => {
        const t = cb.dataset.owType;
        const id = cb.dataset.owId;

        if (t === 'floor') {
          if (cb.checked) {
            if (!m.floor_ids.includes(id)) m.floor_ids.push(id);
          } else {
            m.floor_ids = m.floor_ids.filter(x => x !== id);
          }
        }
        if (t === 'group') {
          if (cb.checked) {
            if (!m.group_ids.includes(id)) m.group_ids.push(id);
          } else {
            m.group_ids = m.group_ids.filter(x => x !== id);
          }
        }
        if (t === 'zone') {
          if (cb.checked) {
            if (!m.zone_ids.includes(id)) m.zone_ids.push(id);
          } else {
            m.zone_ids = m.zone_ids.filter(x => x !== id);
          }
        }

        // Re-render to update indeterminate state
        renderMemberTree(container);
      });
    });

    // Compute indeterminate states (basic)
    applyIndeterminate(container, model);
  }

  function applyIndeterminate(container, model) {
    const m = _draft.members;
    const zs = zones();

    function setInd(cb, val) {
      if (!cb) return;
      cb.indeterminate = !!val;
    }

    // For each group: indeterminate if some zones selected
    model.forEach(f => {
      f.groups.forEach(g => {
        const groupCb = container.querySelector(`input[data-ow-type="group"][data-ow-id="${CSS.escape(g.id)}"]`);
        const total = g.zones.length;
        const on = g.zones.filter(z => m.zone_ids.includes(z.id)).length;
        setInd(groupCb, on>0 && on<total);
      });

      // For each floor: consider all zones under it
      const floorCb = container.querySelector(`input[data-ow-type="floor"][data-ow-id="${CSS.escape(f.id)}"]`);
      const allZones = [...f.groups.flatMap(g => g.zones), ...f.ungrouped];
      const total = allZones.length;
      const on = allZones.filter(z => m.zone_ids.includes(z.id)).length;
      setInd(floorCb, on>0 && on<total);
    });
  }

  function applyTreeFilter(q) {
    const container = _panelEl?.querySelector('#owAlarmTree');
    if (!container) return;
    const query = (q || '').trim().toLowerCase();
    container.querySelectorAll('.row').forEach(r => {
      const label = (r.dataset.owLabel || '').toLowerCase();
      r.style.display = !query || label.includes(query) ? '' : 'none';
    });
  }

  // ── Public API ─────────────────────────────────────────────
  window.OW_Alarms = { toggle, open, close };

})();

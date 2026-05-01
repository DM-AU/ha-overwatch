/* ================================================================
 * HA-Overwatch — automations.js  v4
 * Admin-only Automation Editor.
 * HA is source of truth — reads/writes directly via server proxy.
 * ================================================================ */
(function () {
'use strict';

/* ── State ─────────────────────────────────────────────────── */
let _panelEl        = null;
let _open           = false;
let _automations    = [];        // [{draft, warnings, ha_id}]
let _editing        = null;      // automation id or 'new'
let _draft          = null;
let _haEntities     = [];
let _haServices     = {};        // domain -> [{name, description}]
let _listSearch     = '';
let _collapsed      = { triggers:false, conditions:false, actions:false };
let _collapsedSteps = {};
let _parseErrors    = [];        // list of {id, name, warnings} for sidebar badge

/* ── Admin guard ───────────────────────────────────────────── */
function isAdmin() { return !document.querySelector('meta[name="ow-direct"]'); }

/* ── Helpers ───────────────────────────────────────────────── */
function ow()        { return window.OW || {}; }
function zones()     { return ow().zones   || []; }
function groups()    { return ow().groups  || []; }
function haStates()  { return ow().haStates || {}; }
function apiPath(p)  { return ow().apiPath ? ow().apiPath(p) : p; }
function escH(s)     { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function uid()       { return 'auto_' + Math.random().toString(36).slice(2,9); }
function nameSlug(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); }

/* ── Zone / Group status from haStates ─────────────────────── */
function zoneTriggered(zone) {
  const slug = nameSlug(zone.name) || zone.id;
  const st = haStates()[`binary_sensor.overwatch_zone_${slug}_triggered`];
  if (st) return st.state === 'on';
  // Fallback: check sensors directly
  return (zone.sensors||[]).some(id => haStates()[id]?.state === 'on');
}
function zoneArmed(zone) {
  const slug = nameSlug(zone.name) || zone.id;
  const st = haStates()[`switch.overwatch_zone_${slug}`];
  return st ? st.state === 'on' : true; // default armed if unknown
}
function groupTriggered(group) {
  return (group.zone_ids||[]).some(id => {
    const z = zones().find(z=>z.id===id);
    return z && zoneTriggered(z);
  });
}
function groupArmed(group) {
  return (group.zone_ids||[]).some(id => {
    const z = zones().find(z=>z.id===id);
    return z && zoneArmed(z);
  });
}

/* ── HA Entity / Service Discovery ─────────────────────────── */
async function loadHAEntities() {
  const states = haStates();
  if (Object.keys(states).length > 0) {
    _haEntities = Object.entries(states).map(([id,s])=>({
      entity_id:id, domain:id.split('.')[0], state:s.state,
      name: s.attributes?.friendly_name || id.split('.').pop().replace(/_/g,' '),
    })).sort((a,b)=>a.entity_id.localeCompare(b.entity_id));
    return;
  }
  try {
    const r = await fetch(apiPath('ow/states')+'?v='+Date.now());
    if (r.ok) {
      const data = await r.json();
      _haEntities = Object.entries(data).map(([id,s])=>({
        entity_id:id, domain:id.split('.')[0], state:s.state,
        name: s.attributes?.friendly_name||id.split('.').pop().replace(/_/g,' '),
      })).sort((a,b)=>a.entity_id.localeCompare(b.entity_id));
    }
  } catch(e) { console.warn('[OW-Auto] loadHAEntities:',e); }
}

async function loadHAServices(domain) {
  if (_haServices[domain]) return _haServices[domain];
  try {
    const r = await fetch(apiPath(`ow/ha-services?domain=${domain}`)+'&v='+Date.now());
    if (r.ok) {
      const data = await r.json();
      const domainData = Array.isArray(data) ? data.find(d=>d.domain===domain) : null;
      _haServices[domain] = domainData ? Object.entries(domainData.services||{}).map(([name,def])=>({
        name, description: def.description||name,
      })) : [];
    }
  } catch { _haServices[domain] = []; }
  return _haServices[domain]||[];
}

function entitiesByDomain(...domains) {
  const src = _haEntities.length ? _haEntities
    : Object.entries(haStates()).map(([id,s])=>({entity_id:id,domain:id.split('.')[0],state:s.state,name:s.attributes?.friendly_name||id.split('.').pop().replace(/_/g,' ')}));
  return src.filter(e=>domains.includes(e.domain));
}
function allEntities() {
  if (_haEntities.length) return _haEntities;
  return Object.entries(haStates()).map(([id,s])=>({entity_id:id,domain:id.split('.')[0],state:s.state,name:s.attributes?.friendly_name||id.split('.').pop().replace(/_/g,' ')}));
}

/* ── Zone/Group device helpers ─────────────────────────────── */
function sensorsByType(type) {
  // type: null=all, 'motion', 'door', 'window', 'smoke', 'co', etc.
  const result = [];
  groups().forEach(g => {
    const gZones = (g.zone_ids||[]).map(id=>zones().find(z=>z.id===id)).filter(Boolean);
    gZones.forEach(z => {
      (z.sensors||[]).forEach(eid => {
        if (!type || eid.toLowerCase().includes(type) || (haStates()[eid]?.attributes?.friendly_name||'').toLowerCase().includes(type)) {
          result.push({ entity_id:eid, name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '), state:haStates()[eid]?.state, zone:z, group:g });
        }
      });
    });
  });
  // Also ungrouped zones
  const groupedZoneIds = new Set(groups().flatMap(g=>g.zone_ids||[]));
  zones().filter(z=>!groupedZoneIds.has(z.id)).forEach(z => {
    (z.sensors||[]).forEach(eid => {
      if (!type || eid.toLowerCase().includes(type) || (haStates()[eid]?.attributes?.friendly_name||'').toLowerCase().includes(type)) {
        result.push({ entity_id:eid, name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '), state:haStates()[eid]?.state, zone:z, group:null });
      }
    });
  });
  return result;
}

function lightsByGroupZone() {
  // Returns [{type:'group',id,name,armed,triggered, children:[{type:'zone',...,children:[{entity_id,...}]}]}]
  const result = [];
  groups().forEach(g => {
    const gZones = (g.zone_ids||[]).map(id=>zones().find(z=>z.id===id)).filter(Boolean).filter(z=>z.lights?.length);
    if (!gZones.length) return;
    result.push({ type:'group', id:g.id, name:g.name||g.id, armed:groupArmed(g), triggered:groupTriggered(g),
      children: gZones.map(z=>({
        type:'zone', id:z.id, name:z.name||z.id, armed:zoneArmed(z), triggered:zoneTriggered(z),
        children: (z.lights||[]).map(eid=>({ entity_id:eid, name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '), state:haStates()[eid]?.state }))
      }))
    });
  });
  // Ungrouped zones with lights
  const groupedZoneIds = new Set(groups().flatMap(g=>g.zone_ids||[]));
  zones().filter(z=>!groupedZoneIds.has(z.id)&&z.lights?.length).forEach(z=>{
    result.push({ type:'zone', id:z.id, name:z.name||z.id, armed:zoneArmed(z), triggered:zoneTriggered(z),
      children:(z.lights||[]).map(eid=>({ entity_id:eid, name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '), state:haStates()[eid]?.state }))
    });
  });
  return result;
}

function sirenEntities() {
  const s = new Set();
  zones().forEach(z=>(z.sirens||[]).forEach(e=>s.add(e)));
  (ow().sirens||[]).forEach(p=>{if(p.entity_id)s.add(p.entity_id);});
  entitiesByDomain('siren').forEach(e=>s.add(e.entity_id));
  // Filter: only entities with 'siren' in entity_id or friendly_name
  return [...s].filter(id=>{
    const fn=(haStates()[id]?.attributes?.friendly_name||'').toLowerCase();
    return id.toLowerCase().includes('siren')||fn.includes('siren');
  }).map(id=>({ entity_id:id, name:haStates()[id]?.attributes?.friendly_name||id.split('.').pop().replace(/_/g,' '), state:haStates()[id]?.state }));
}

function camerasByGroupZone() {
  const result = [];
  groups().forEach(g=>{
    const gZones=(g.zone_ids||[]).map(id=>zones().find(z=>z.id===id)).filter(z=>z&&z.cameras?.length);
    if(!gZones.length)return;
    result.push({type:'group',id:g.id,name:g.name||g.id,armed:groupArmed(g),triggered:groupTriggered(g),
      children:gZones.map(z=>({type:'zone',id:z.id,name:z.name||z.id,armed:zoneArmed(z),triggered:zoneTriggered(z),
        children:(z.cameras||[]).map(eid=>({entity_id:eid,name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '),state:haStates()[eid]?.state}))
      }))
    });
  });
  const gpzids=new Set(groups().flatMap(g=>g.zone_ids||[]));
  zones().filter(z=>!gpzids.has(z.id)&&z.cameras?.length).forEach(z=>{
    result.push({type:'zone',id:z.id,name:z.name||z.id,armed:zoneArmed(z),triggered:zoneTriggered(z),
      children:(z.cameras||[]).map(eid=>({entity_id:eid,name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '),state:haStates()[eid]?.state}))
    });
  });
  return result;
}

/* ── Zone/Group hierarchical selector for triggers ─────────── */
// Returns zone/group tree for zone event / zone arm triggers
function zoneGroupTree() {
  const result = [];
  groups().forEach(g=>{
    const gZones=(g.zone_ids||[]).map(id=>zones().find(z=>z.id===id)).filter(Boolean);
    result.push({type:'group',id:g.id,name:g.name||g.id,armed:groupArmed(g),triggered:groupTriggered(g),zones:gZones});
  });
  const gpzids=new Set(groups().flatMap(g=>g.zone_ids||[]));
  const ungrouped=zones().filter(z=>!gpzids.has(z.id));
  if(ungrouped.length) result.push({type:'ungrouped',zones:ungrouped});
  return result;
}

function notifyEntities() { return entitiesByDomain('notify'); }

/* ── Storage / HA sync ─────────────────────────────────────── */
async function loadFromHA() {
  try {
    const r = await fetch(apiPath('ow/ha-automations')+'?v='+Date.now());
    if (!r.ok) { _automations=[]; return; }
    const haList = await r.json();
    _parseErrors = [];
    _automations = haList.map(ha => {
      const { draft, warnings } = parseHAAutomation(ha);
      if (warnings.length) {
        _parseErrors.push({ id:draft.id, name:draft.name, warnings });
        ow().logEvent?.('warn', `[AutoEditor] "${draft.name}" has parse warnings: ${warnings.join('; ')}`, 'automation');
      }
      return { draft, warnings, ha_id: ha.id };
    });
    // Update sidebar badge
    updateSidebarBadge();
    // Also sync local index
    saveLocalIndex();
  } catch(e) { console.warn('[OW-Auto] loadFromHA:',e); _automations=[]; }
}

async function saveLocalIndex() {
  // local automations.json just stores id+name index for search integration
  try {
    await fetch(apiPath('ow/automations'),{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_automations.map(a=>({id:a.draft.id,name:a.draft.name}))) });
  } catch {}
}

async function pushToHA(draft) {
  try {
    const r = await fetch(apiPath('ow/push-automation'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});
    const d = await r.json().catch(()=>({}));
    if (d.ok===false) { console.warn('[OW-Auto] HA push failed:',d); return {ok:false,detail:d.detail||'HA rejected automation.'}; }
    return {ok:true};
  } catch(e) { return {ok:false,detail:e.message}; }
}

async function deleteFromHA(autoId) {
  try { await fetch(apiPath('ow/delete-automation'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:autoId})}); }
  catch(e) { console.warn('[OW-Auto] delete:',e); }
}

// Parse HA automation back to OW draft (client-side mirror of server's parseHAAutomation)
function parseHAAutomation(ha) {
  const warnings = [];
  let owId=null, owName=null;
  try { const m=JSON.parse(ha.description||"{}"); owId=m.ow_id||null; owName=m.ow_name||null; } catch {}
  const alias=ha.alias||"";
  const displayName=owName||alias.replace(/^HA-Overwatch\s*[-–—]?\s*/i,"").trim();
  const draft = { id:owId||uid(), name:displayName, enabled:ha.state!=="off", triggers:[], conditions:[], actions:[], _ha_parse_warnings:[] };

  function zoneBySlug(slug) { return zones().find(z=>(nameSlug(z.name)||z.id)===slug||z.id===slug); }
  function groupBySlug(slug) { return groups().find(g=>(nameSlug(g.name)||g.id)===slug||g.id===slug); }

  const rawTriggers=ha.triggers||ha.trigger||[];
  for (const t of (Array.isArray(rawTriggers)?rawTriggers:rawTriggers?[rawTriggers]:[])) {
    if (!t||t.platform!=='state') { if(t) warnings.push(`Unsupported trigger: ${t.platform||'unknown'}`); continue; }
    const ids=Array.isArray(t.entity_id)?t.entity_id:(t.entity_id?[t.entity_id]:[]);
    const forDur=t.for||null;
    const zoneTriggIds=ids.filter(id=>/^binary_sensor\.overwatch_zone_(?!group).+_triggered$/.test(id));
    const groupTriggIds=ids.filter(id=>/^binary_sensor\.overwatch_zone_group_.+_triggered$/.test(id));
    const zoneArmIds=ids.filter(id=>/^switch\.overwatch_zone_(?!group)[^_]/.test(id));
    const groupArmIds=ids.filter(id=>/^switch\.overwatch_zone_group_/.test(id));
    const nonOW=ids.filter(id=>!id.includes('overwatch_zone'));

    if (zoneTriggIds.length||groupTriggIds.length) {
      const zIds=zoneTriggIds.map(id=>{const sl=id.replace(/^binary_sensor\.overwatch_zone_/,"").replace(/_triggered$/,"");return (zoneBySlug(sl)||{}).id||null;}).filter(Boolean);
      const gIds=groupTriggIds.map(id=>{const sl=id.replace(/^binary_sensor\.overwatch_zone_group_/,"").replace(/_triggered$/,"");return (groupBySlug(sl)||{}).id||null;}).filter(Boolean);
      draft.triggers.push({id:uid(),type:'zone',zone_ids:zIds,group_ids:gIds,event:t.to==='off'?'cleared':'triggered',for_duration:forDur});
    } else if (zoneArmIds.length||groupArmIds.length) {
      const zIds=zoneArmIds.map(id=>{const sl=id.replace(/^switch\.overwatch_zone_/,"");return (zoneBySlug(sl)||{}).id||null;}).filter(Boolean);
      const gIds=groupArmIds.map(id=>{const sl=id.replace(/^switch\.overwatch_zone_group_/,"");return (groupBySlug(sl)||{}).id||null;}).filter(Boolean);
      draft.triggers.push({id:uid(),type:'zone_arm',zone_ids:zIds,group_ids:gIds,state:t.to==='off'?'disarmed':'armed',for_duration:forDur});
    } else if (nonOW.length) {
      const domain=nonOW[0].split('.')[0];
      if (domain==='person') draft.triggers.push({id:uid(),type:'person',entity_ids:nonOW,state:t.to||'home',for_duration:forDur});
      else if (domain==='device_tracker') draft.triggers.push({id:uid(),type:'device',entity_ids:nonOW,state:t.to||'home',for_duration:forDur});
      else { draft.triggers.push({id:uid(),type:'entity',entity_id:nonOW[0],to:t.to||'on',for_duration:forDur}); if(nonOW.length>1) warnings.push('Multi-entity trigger partially imported'); }
    }
  }

  const rawConds=ha.conditions||ha.condition||[];
  for (const c of (Array.isArray(rawConds)?rawConds:rawConds?[rawConds]:[])) {
    if (!c) continue;
    if (c.condition==='time') draft.conditions.push({id:uid(),type:'time',time_mode:'manual',after:c.after||'00:00',before:c.before||'23:59'});
    else if (c.condition==='state') {
      const eid = c.entity_id||'';
      const domain = eid.split('.')[0];
      if (domain==='person'||domain==='device_tracker') {
        draft.conditions.push({id:uid(),type:'person',entity_ids:eid?[eid]:[],state:c.state||'home'});
      } else {
        draft.conditions.push({id:uid(),type:'entity',entity_id:eid,state:c.state||'on'});
      }
    }
    else if (c.condition==='template') { const m=(c.value_template||'').match(/states\('([^']+)'\)/); if(m) draft.conditions.push({id:uid(),type:'time',time_mode:'entity',time_entity:m[1]}); else warnings.push('Unsupported template condition'); }
    else warnings.push(`Unsupported condition: ${c.condition}`);
  }

  const rawActions=ha.actions||ha.action||[];
  for (const a of (Array.isArray(rawActions)?rawActions:rawActions?[rawActions]:[])) {
    if (!a) continue;
    const actionKey=a.action||a.service||'';
    const di=actionKey.indexOf('.');
    const domain=di>=0?actionKey.slice(0,di):'';
    const svc=di>=0?actionKey.slice(di+1):'';
    const tids=a.target?.entity_id?(Array.isArray(a.target.entity_id)?a.target.entity_id:[a.target.entity_id]):[];
    if (domain==='siren') draft.actions.push({id:uid(),type:'siren',entity_ids:tids,service:svc});
    else if (domain==='light') draft.actions.push({id:uid(),type:'light',entity_ids_zone:tids,entity_ids_other:[],entity_ids:[],service:svc});
    else if (domain==='notify') draft.actions.push({id:uid(),type:'notify',target:`notify.${svc}`,message:a.data?.message||'',title:a.data?.title||''});
    else if (domain==='alarm_control_panel') draft.actions.push({id:uid(),type:'arm',service:svc,entity_id:tids[0]||''});
    else if (domain==='camera') draft.actions.push({id:uid(),type:'camera',service:svc,entity_ids:tids,service_data:a.data||{}});
    else draft.actions.push({id:uid(),type:'entity',entity_id:tids[0]||'',service:actionKey});
  }

  draft._ha_parse_warnings=warnings;
  return {draft, warnings};
}

function updateSidebarBadge() {
  const btn = document.getElementById('automationsBtn');
  if (!btn) return;
  const existing = btn.querySelector('.ow-auto-error-dot');
  if (_parseErrors.length > 0) {
    if (!existing) {
      const dot = document.createElement('span');
      dot.className = 'ow-auto-error-dot';
      dot.style.cssText = 'position:absolute;top:4px;right:4px;width:8px;height:8px;border-radius:50%;background:#ff3b30;animation:ow-blink 1s ease-in-out infinite;';
      btn.style.position = 'relative';
      btn.appendChild(dot);
    }
  } else if (existing) {
    existing.remove();
  }
}

/* ── Draft helpers ─────────────────────────────────────────── */
function newDraft() { return {id:uid(),name:'',enabled:true,triggers:[],conditions:[],actions:[]}; }

function addTrigger(type) {
  const defaults = {
    zone:     {zone_ids:[],group_ids:[],event:'triggered',for_duration:null},
    zone_arm: {zone_ids:[],group_ids:[],state:'armed',for_duration:null},
    person:   {entity_ids:[],state:'home',for_duration:null},
    device:   {entity_ids:[],state:'home',for_duration:null},
    sensor:   {entity_ids:[],state:'on',for_duration:null},
    entity:   {entity_id:'',to:'on',for_duration:null},
  };
  _draft.triggers.push({id:uid(),type,...(defaults[type]||{for_duration:null})});
  renderEditorKeepScroll();
}
function addCondition(type) {
  const defaults = {
    time:   {time_mode:'manual',after:'00:00',before:'23:59',time_entity:''},
    entity: {entity_id:'',state:'on'},
    person: {entity_ids:[],state:'home'},
  };
  _draft.conditions.push({id:uid(),type,...(defaults[type]||{})});
  renderEditorKeepScroll();
}
function addAction(type) {
  const defaults = {
    siren:  {entity_ids:[],service:'turn_on'},
    light:  {entity_ids:[],entity_ids_zone:[],entity_ids_other:[],service:'turn_on'},
    notify: {target:'',message:'HA-Overwatch: Zone triggered.',title:''},
    arm:    {service:'alarm_arm_away',entity_id:''},
    camera: {entity_ids:[],service:'snapshot',service_data:{}},
    entity: {entity_id:'',service:'turn_on'},
  };
  _draft.actions.push({id:uid(),type,...(defaults[type]||{})});
  renderEditorKeepScroll();
}

/* ── Scroll-preserving re-render ───────────────────────────── */
function renderEditorKeepScroll() {
  const scrollEl = _panelEl?.querySelector('#owAutoScrollBody');
  const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
  renderEditor();
  requestAnimationFrame(() => {
    const el = _panelEl?.querySelector('#owAutoScrollBody');
    if (el) el.scrollTop = scrollTop;
  });
}

/* ── Panel mount ────────────────────────────────────────────── */
function mountPanel() {
  if (_panelEl) return;
  _panelEl = document.createElement('div');
  _panelEl.id = 'owAutoPanel';
  _panelEl.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(8,8,10,0.98);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;font-size:13px;color:#e0e0e0;overflow:hidden;opacity:0;transition:opacity 0.18s ease;pointer-events:none;';
  document.body.appendChild(_panelEl);
}
function unmountPanel() { if(_panelEl){_panelEl.remove();_panelEl=null;} }

/* ── Toggle / Open / Close ─────────────────────────────────── */
async function toggle() { if(_open){close();return;} await open(); }
async function open() {
  if (!isAdmin()) return;
  _open=true; mountPanel();
  // Load from HA as source of truth
  await Promise.all([loadFromHA(), loadHAEntities()]);
  // Pre-fetch camera services
  loadHAServices('camera');
  document.getElementById('automationsBtn')?.classList.add('active');
  renderList();
  requestAnimationFrame(()=>{_panelEl.style.opacity='1';_panelEl.style.pointerEvents='all';});
}
function close() {
  _open=false;_editing=null;_draft=null;
  document.getElementById('automationsBtn')?.classList.remove('active');
  if(_panelEl){_panelEl.style.opacity='0';_panelEl.style.pointerEvents='none';setTimeout(()=>unmountPanel(),200);}
}

/* ════════════════════════════════════════════════════════════
 * LIST VIEW
 * ═══════════════════════════════════════════════════════════ */
function renderList() {
  if (!_panelEl) return;
  const allAutos = _automations.map(a=>a.draft);
  const filtered = _listSearch ? allAutos.filter(a=>a.name.toLowerCase().includes(_listSearch.toLowerCase())) : allAutos;

  _panelEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:12px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="opacity:0.7;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="white" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>
        <span style="font-size:15px;font-weight:600;">Automation Editor</span>
        <span style="font-size:11px;color:#555;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:2px 8px;">${allAutos.length} automation${allAutos.length!==1?'s':''}</span>
        <span style="font-size:10px;color:#ff9500;background:rgba(255,149,0,0.1);border:1px solid rgba(255,149,0,0.2);border-radius:6px;padding:2px 7px;">Admin only</span>
        ${_parseErrors.length ? `<span style="font-size:10px;color:#ff3b30;background:rgba(255,59,48,0.1);border:1px solid rgba(255,59,48,0.25);border-radius:6px;padding:2px 7px;">⚠ ${_parseErrors.length} parse error${_parseErrors.length>1?'s':''}</span>` : ''}
      </div>
      <div style="display:flex;gap:8px;">
        <button id="owAutoRefreshBtn" title="Reload from HA" style="${btnStyle('rgba(255,255,255,0.06)','rgba(255,255,255,0.04)',true)}">↻</button>
        <button id="owAutoNewBtn" style="${btnStyle('#0064d2','rgba(0,100,210,0.18)')}">+ New</button>
        <button id="owAutoCloseBtn" style="${btnStyle('rgba(255,255,255,0.08)','rgba(255,255,255,0.05)',true)}">✕ Close</button>
      </div>
    </div>
    <div style="padding:10px 20px 0;flex-shrink:0;">
      <div style="position:relative;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:0.4;"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="owAutoListSearch" type="text" value="${escH(_listSearch)}" placeholder="Search automations…"
          style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:8px;color:#fff;padding:7px 10px 7px 32px;font-size:12px;outline:none;box-sizing:border-box;"/>
      </div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:12px 20px 20px;">
      ${filtered.length===0 ? (_listSearch?'<div style="color:#444;padding:20px;text-align:center;">No automations match.</div>':emptyState()) : filtered.map(a=>autoCard(a,_parseErrors.find(e=>e.id===a.id))).join('')}
    </div>`;

  _panelEl.querySelector('#owAutoNewBtn').onclick=()=>{_editing='new';_draft=newDraft();_collapsedSteps={};renderEditor();};
  _panelEl.querySelector('#owAutoCloseBtn').onclick=close;
  _panelEl.querySelector('#owAutoRefreshBtn').onclick=async()=>{
    const btn=_panelEl.querySelector('#owAutoRefreshBtn'); if(btn)btn.textContent='↻…';
    await loadFromHA(); await loadHAEntities(); renderList();
  };
  const searchEl=_panelEl.querySelector('#owAutoListSearch');
  searchEl.oninput=()=>{_listSearch=searchEl.value;renderList();};
  searchEl.onkeydown=e=>e.stopPropagation();

  filtered.forEach(a=>{
    _panelEl.querySelector(`[data-auto-edit="${a.id}"]`)?.addEventListener('click',()=>{
      _editing=a.id;_draft=JSON.parse(JSON.stringify(a));_collapsedSteps={};renderEditor();
    });
    _panelEl.querySelector(`[data-auto-del="${a.id}"]`)?.addEventListener('click',async e=>{
      e.stopPropagation();
      if(!confirm(`Delete "${a.name}"?`))return;
      _automations=_automations.filter(x=>x.draft.id!==a.id);
      await saveLocalIndex();await deleteFromHA(a.id);renderList();
    });
    _panelEl.querySelector(`[data-auto-tog="${a.id}"]`)?.addEventListener('click',async e=>{
      e.stopPropagation();a.enabled=!a.enabled;
      await pushToHA(a);await loadFromHA();renderList();
    });
  });
}

function autoCard(a, parseErr) {
  const enabled=a.enabled!==false;
  const parts=[
    a.triggers?.length&&`${a.triggers.length} trigger${a.triggers.length>1?'s':''}`,
    a.conditions?.length&&`${a.conditions.length} condition${a.conditions.length>1?'s':''}`,
    a.actions?.length&&`${a.actions.length} action${a.actions.length>1?'s':''}`,
  ].filter(Boolean);
  return `<div data-auto-edit="${escH(a.id)}" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,${enabled?'0.08':'0.04'});border-radius:10px;padding:13px 15px;margin-bottom:7px;cursor:pointer;display:flex;align-items:center;gap:12px;opacity:${enabled?1:0.5};transition:background 0.12s;" onmouseenter="this.style.background='rgba(255,255,255,0.055)'" onmouseleave="this.style.background='rgba(255,255,255,0.03)'">
    <div style="width:30px;height:30px;border-radius:7px;flex-shrink:0;background:${parseErr?'rgba(255,59,48,0.15)':enabled?'rgba(0,100,210,0.2)':'rgba(255,255,255,0.05)'};display:flex;align-items:center;justify-content:center;">
      ${parseErr?'<span style="font-size:14px;">⚠</span>':`<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="${enabled?'#4db8ff':'#555'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`}
    </div>
    <div style="flex:1;min-width:0;">
      <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escH(a.name||'Unnamed')}</div>
      <div style="font-size:11px;color:${parseErr?'#ff6b6b':'#555'};margin-top:2px;">${parseErr?`⚠ ${escH(parseErr.warnings[0]||'Parse error')}`:parts.join(' · ')||'Empty'}</div>
    </div>
    <div style="display:flex;gap:5px;flex-shrink:0;">
      <button data-auto-tog="${escH(a.id)}" style="background:${enabled?'rgba(52,199,89,0.15)':'rgba(255,255,255,0.06)'};border:1px solid ${enabled?'rgba(52,199,89,0.4)':'rgba(255,255,255,0.1)'};color:${enabled?'#34c759':'#555'};border-radius:6px;padding:3px 9px;cursor:pointer;font-size:11px;font-weight:600;">${enabled?'ON':'OFF'}</button>
      <button data-auto-del="${escH(a.id)}" style="background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.2);color:#ff453a;border-radius:6px;padding:3px 7px;cursor:pointer;font-size:12px;">🗑</button>
    </div>
  </div>`;
}

function emptyState() {
  return `<div style="text-align:center;padding:50px 20px;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" style="opacity:0.1;margin-bottom:12px;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="white" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg><div style="color:rgba(255,255,255,0.15);font-size:14px;margin-bottom:6px;">No HA-Overwatch automations found</div><div style="color:rgba(255,255,255,0.08);font-size:12px;">Automations created here will appear in HA with the "HA-Overwatch —" prefix.</div></div>`;
}

/* ════════════════════════════════════════════════════════════
 * EDITOR VIEW
 * ═══════════════════════════════════════════════════════════ */
function renderEditor() {
  if (!_panelEl || !_draft) return;
  const isNew = _editing === 'new';
  const col = _collapsed;

  _panelEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:10px;">
        <button id="owAutoBackBtn" style="${btnStyle('rgba(255,255,255,0.06)','rgba(255,255,255,0.04)',true)}">← Back</button>
        <span style="font-size:14px;font-weight:600;">${isNew?'New Automation':'Edit Automation'}</span>
      </div>
      <button id="owAutoSaveBtn" style="${btnStyle('#0064d2','rgba(0,100,210,0.18)')}">💾 Save &amp; Push to HA</button>
    </div>
    <div id="owAutoScrollBody" style="flex:1;overflow-y:auto;padding:0 18px 40px;">
      <div style="padding:16px 0 12px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <label style="${labelStyle}">Automation Name</label>
        <input id="owAutoName" type="text" placeholder='e.g. "Alert on front door trigger"' value="${escH(_draft.name)}"
          style="${inputStyle}font-size:13px;padding:9px 12px;"/>
        <div style="font-size:11px;color:#444;margin-top:5px;">Saved as: <span style="color:#555;">HA-Overwatch — <span id="owAutoNamePreview">${escH(_draft.name||'…')}</span></span></div>
      </div>
      ${editorSection('⚡','Triggers','When this happens…','triggers',col.triggers,
        _draft.triggers.map(t=>triggerCard(t)).join('')||emptyStepMsg('No triggers yet.'),
        `<button class="ow-add-btn" data-add-trigger="zone">+ Zone event</button>
         <button class="ow-add-btn" data-add-trigger="zone_arm">+ Zone arm/disarm</button>
         <button class="ow-add-btn" data-add-trigger="sensor">+ Sensor</button>
         <button class="ow-add-btn" data-add-trigger="person">+ Person</button>
         <button class="ow-add-btn" data-add-trigger="device">+ Device tracker</button>
         <button class="ow-add-btn" data-add-trigger="entity">+ Any entity</button>`
      )}
      ${editorSection('🔀','Conditions','Only if true…','conditions',col.conditions,
        _draft.conditions.map(c=>conditionCard(c)).join('')||emptyStepMsg('No conditions — always runs.'),
        `<button class="ow-add-btn" data-add-cond="time">+ Time of day</button>
         <button class="ow-add-btn" data-add-cond="person">+ Person / Device</button>
         <button class="ow-add-btn" data-add-cond="entity">+ Entity state</button>`
      )}
      ${editorSection('🎯','Actions','Then do this…','actions',col.actions,
        _draft.actions.map((a,i)=>actionCard(a,i,_draft.actions.length)).join('')||emptyStepMsg('No actions yet.'),
        `<button class="ow-add-btn" data-add-action="siren">+ Siren</button>
         <button class="ow-add-btn" data-add-action="light">+ Light</button>
         <button class="ow-add-btn" data-add-action="camera">+ Camera</button>
         <button class="ow-add-btn" data-add-action="notify">+ Notify</button>
         <button class="ow-add-btn" data-add-action="arm">+ Arm/Disarm</button>
         <button class="ow-add-btn" data-add-action="entity">+ Other entity</button>`
      )}
    </div>`;

  const nameEl=_panelEl.querySelector('#owAutoName');
  const previewEl=_panelEl.querySelector('#owAutoNamePreview');
  nameEl.oninput=()=>{_draft.name=nameEl.value;if(previewEl)previewEl.textContent=nameEl.value||'…';};

  _panelEl.querySelectorAll('[data-section-toggle]').forEach(btn=>{
    btn.onclick=()=>{_collapsed[btn.dataset.sectionToggle]=!_collapsed[btn.dataset.sectionToggle];renderEditorKeepScroll();};
  });
  _panelEl.querySelectorAll('[data-step-collapse]').forEach(btn=>{
    btn.onclick=()=>{_collapsedSteps[btn.dataset.stepCollapse]=!_collapsedSteps[btn.dataset.stepCollapse];renderEditorKeepScroll();};
  });

  _panelEl.querySelectorAll('[data-add-trigger]').forEach(b=>b.onclick=()=>addTrigger(b.dataset.addTrigger));
  _panelEl.querySelectorAll('[data-add-cond]').forEach(b=>b.onclick=()=>addCondition(b.dataset.addCond));
  _panelEl.querySelectorAll('[data-add-action]').forEach(b=>b.onclick=()=>addAction(b.dataset.addAction));
  _panelEl.querySelectorAll('[data-remove-trigger]').forEach(b=>b.onclick=()=>{_draft.triggers=_draft.triggers.filter(t=>t.id!==b.dataset.removeTrigger);renderEditorKeepScroll();});
  _panelEl.querySelectorAll('[data-remove-cond]').forEach(b=>b.onclick=()=>{_draft.conditions=_draft.conditions.filter(c=>c.id!==b.dataset.removeCond);renderEditorKeepScroll();});
  _panelEl.querySelectorAll('[data-remove-action]').forEach(b=>b.onclick=()=>{_draft.actions=_draft.actions.filter(a=>a.id!==b.dataset.removeAction);renderEditorKeepScroll();});

  // Action move up/down
  _panelEl.querySelectorAll('[data-action-up]').forEach(b=>b.onclick=()=>{
    const idx=_draft.actions.findIndex(a=>a.id===b.dataset.actionUp);
    if(idx>0){[_draft.actions[idx-1],_draft.actions[idx]]=[_draft.actions[idx],_draft.actions[idx-1]];renderEditorKeepScroll();}
  });
  _panelEl.querySelectorAll('[data-action-down]').forEach(b=>b.onclick=()=>{
    const idx=_draft.actions.findIndex(a=>a.id===b.dataset.actionDown);
    if(idx<_draft.actions.length-1){[_draft.actions[idx],_draft.actions[idx+1]]=[_draft.actions[idx+1],_draft.actions[idx]];renderEditorKeepScroll();}
  });

  _draft.triggers.forEach(t=>wireTriggerFields(t));
  _draft.conditions.forEach(c=>wireConditionFields(c));
  _draft.actions.forEach(a=>wireActionFields(a));
  _panelEl.querySelectorAll('[data-entity-autocomplete]').forEach(w=>bindEntityAutocomplete(w));

  _panelEl.querySelector('#owAutoBackBtn').onclick=()=>{_editing=null;_draft=null;renderList();};
  _panelEl.querySelector('#owAutoSaveBtn').onclick=async()=>{
    if(!_draft.name.trim()){alert('Please enter an automation name.');return;}
    const full={..._draft,name:_draft.name.trim()};
    const saveBtn=_panelEl.querySelector('#owAutoSaveBtn');
    if(saveBtn){saveBtn.textContent='Saving…';saveBtn.disabled=true;}
    const result=await pushToHA(full);
    if(result.ok===false){
      if(saveBtn){saveBtn.textContent='💾 Save & Push to HA';saveBtn.disabled=false;}
      alert(`Push to HA failed:\n${result.detail||'Check server logs.'}`);
      return;
    }
    await loadFromHA();
    _editing=null;_draft=null;renderList();
  };
}

/* ════════════════════════════════════════════════════════════
 * TRIGGER CARDS
 * ═══════════════════════════════════════════════════════════ */
function triggerCard(t) {
  let inner = '';
  const forField = `
    <div style="margin-top:10px;">
      <label style="${labelStyle}">For (HH:MM:SS — optional)</label>
      <input id="trig-for-${t.id}" type="text" value="${escH(t.for_duration||'')}"
        placeholder="00:00:30 — trigger only after this duration"
        style="${inputStyle}" autocomplete="off"/>
    </div>`;

  if (t.type === 'zone' || t.type === 'zone_arm') {
    const isArm = t.type === 'zone_arm';
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Groups &amp; Zones</label>
        ${zoneGroupSelector(t, `trig-zg-${t.id}`)}
      </div>
      <div>
        <label style="${labelStyle}">${isArm?'State changes to':'Event'}</label>
        ${isArm ? `
          <select id="trig-armstate-${t.id}" style="${selectStyle}">
            <option value="armed"    ${t.state==='armed'   ?'selected':''}>Armed</option>
            <option value="disarmed" ${t.state==='disarmed'?'selected':''}>Disarmed</option>
          </select>` : `
          <select id="trig-event-${t.id}" style="${selectStyle}">
            <option value="triggered" ${t.event==='triggered'?'selected':''}>Sensor triggered (active)</option>
            <option value="cleared"   ${t.event==='cleared'  ?'selected':''}>Sensor cleared (inactive)</option>
          </select>`}
      </div>
      ${forField}`;
  }

  if (t.type === 'sensor') {
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Sensors from zones</label>
        ${sensorsHierarchicalSelector(t.entity_ids||[], `trig-sensor-${t.id}`)}
      </div>
      <div>
        <label style="${labelStyle}">State</label>
        <select id="trig-sensorstate-${t.id}" style="${selectStyle}">
          <option value="on"  ${t.state==='on' ?'selected':''}>Triggered / Open / Active</option>
          <option value="off" ${t.state==='off'?'selected':''}>Clear / Closed / Inactive</option>
        </select>
      </div>
      ${forField}`;
  }

  if (t.type === 'person') {
    const persons = entitiesByDomain('person');
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Person</label>
        ${persons.length ? searchableCheckboxList(t.entity_ids||[],persons,`trig-person-${t.id}`) : entityAutocomplete(`trig-person-ac-${t.id}`,t.entity_ids?.[0]||'','person.*',null,['person'])}
      </div>
      <div>
        <label style="${labelStyle}">State</label>
        <select id="trig-personstate-${t.id}" style="${selectStyle}">
          <option value="home"     ${t.state==='home'    ?'selected':''}>Home</option>
          <option value="not_home" ${t.state==='not_home'?'selected':''}>Away (not home)</option>
        </select>
      </div>
      ${forField}`;
  }

  if (t.type === 'device') {
    const trackers = entitiesByDomain('device_tracker');
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Device Tracker</label>
        ${trackers.length ? searchableCheckboxList(t.entity_ids||[],trackers,`trig-device-${t.id}`) : entityAutocomplete(`trig-device-ac-${t.id}`,t.entity_ids?.[0]||'','device_tracker.*',null,['device_tracker'])}
      </div>
      <div>
        <label style="${labelStyle}">State</label>
        <select id="trig-devicestate-${t.id}" style="${selectStyle}">
          <option value="home"     ${t.state==='home'    ?'selected':''}>Home</option>
          <option value="not_home" ${t.state==='not_home'?'selected':''}>Away</option>
        </select>
      </div>
      ${forField}`;
  }

  if (t.type === 'entity') {
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Entity</label>
        ${entityAutocomplete(`trig-entity-ac-${t.id}`,t.entity_id||'','Search any entity…')}
      </div>
      <div>
        <label style="${labelStyle}">State becomes</label>
        <input id="trig-to-${t.id}" type="text" value="${escH(t.to||'on')}" placeholder="on / off / home / triggered / …" style="${inputStyle}"/>
      </div>
      ${forField}`;
  }

  const labels={zone:'Zone Event',zone_arm:'Zone Arm/Disarm',sensor:'Sensor',person:'Person',device:'Device Tracker',entity:'Entity State'};
  return stepCard(t.id, labels[t.type]||t.type, inner, 'trigger');
}

/* ── Zone/Group selector for zone event / zone_arm triggers ── */
function zoneGroupSelector(t, id) {
  const tree = zoneGroupTree();
  const selZones = t.zone_ids||[];
  const selGroups = t.group_ids||[];

  return `<div id="${escH(id)}" class="ow-scbl" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;">
    <div style="position:relative;border-bottom:1px solid rgba(255,255,255,0.06);">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);opacity:0.35;pointer-events:none;"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2.5"/><path d="M16 16L21 21" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
      <input type="text" placeholder="Filter zones…" autocomplete="off"
        style="width:100%;background:none;border:none;color:#ccc;padding:7px 10px 7px 28px;font-size:12px;outline:none;box-sizing:border-box;"
        oninput="(function(el){var q=el.value.toLowerCase();el.closest('.ow-scbl').querySelectorAll('[data-scbl-item]').forEach(function(r){r.style.display=r.dataset.scblLabel.toLowerCase().includes(q)?'':'none';});})(this)"
        onkeydown="event.stopPropagation()"/>
    </div>
    <div style="max-height:220px;overflow-y:auto;padding:4px;">
      ${tree.map(node => {
        if (node.type === 'ungrouped') {
          return node.zones.map(z => zoneRow(z, selZones, selGroups, null)).join('');
        }
        // Group node
        const gId = escH(node.id);
        const gCollapsed = !!_collapsedSteps[`zg-${node.id}`];
        const gState = stateBadge(node.triggered, node.armed);
        const allZoneIds = node.zones.map(z=>z.id);
        const allSelected = allZoneIds.every(zid=>selZones.includes(zid));
        const someSelected = allZoneIds.some(zid=>selZones.includes(zid)) || selGroups.includes(node.id);
        return `
          <div data-scbl-item data-scbl-label="${escH(node.name)}">
            <div style="display:flex;align-items:center;padding:5px 6px;gap:6px;">
              <button data-grp-collapse="${gId}" style="background:none;border:none;color:#555;cursor:pointer;font-size:10px;padding:0 2px;flex-shrink:0;">${gCollapsed?'▶':'▼'}</button>
              <label style="display:flex;align-items:center;gap:7px;cursor:pointer;flex:1;">
                <input type="checkbox" data-grp-cb="${gId}" ${someSelected?'checked':''} ${allSelected&&!gCollapsed?'':''}
                  style="accent-color:#0064d2;flex-shrink:0;">
                <span style="font-size:12px;font-weight:600;color:#ccc;">${escH(node.name)}</span>
                ${gState}
              </label>
            </div>
            ${gCollapsed?'':`<div data-grp-children="${gId}" style="padding-left:20px;">${node.zones.map(z=>zoneRow(z,selZones,selGroups,node.id)).join('')}</div>`}
          </div>`;
      }).join('')}
    </div>
  </div>`;
}

function zoneRow(z, selZones, selGroups, groupId) {
  const zId = escH(z.id);
  const zCollapsed = !!_collapsedSteps[`zzr-${z.id}`];
  const state = stateBadge(zoneTriggered(z), zoneArmed(z));
  const sensors = (z.sensors||[]);
  return `<div data-scbl-item data-scbl-label="${escH(z.name||z.id)}">
    <div style="display:flex;align-items:center;padding:4px 6px;gap:6px;">
      ${sensors.length?`<button data-zone-sensor-collapse="${zId}" style="background:none;border:none;color:#444;cursor:pointer;font-size:9px;padding:0 2px;flex-shrink:0;">${zCollapsed?'▶':'▼'}</button>`:'<span style="width:14px;flex-shrink:0;"></span>'}
      <label style="display:flex;align-items:center;gap:7px;cursor:pointer;flex:1;">
        <input type="checkbox" data-zone-cb="${zId}" data-group-id="${escH(groupId||'')}" ${selZones.includes(z.id)?'checked':''} style="accent-color:#0064d2;flex-shrink:0;">
        <span style="font-size:11px;color:#bbb;">${escH(z.name||z.id)}</span>
        ${state}
      </label>
    </div>
    ${!zCollapsed&&sensors.length?`<div style="padding-left:28px;">${sensors.map(eid=>`
      <div style="display:flex;align-items:center;padding:2px 6px;gap:6px;">
        <span style="font-size:10px;color:#444;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop())}</span>
        ${stateBadge(haStates()[eid]?.state==='on',null,'small')}
      </div>`).join('')}</div>`:``}
  </div>`;
}

function wireZoneGroupSelector(t, id) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;

  // Group collapse buttons
  el.querySelectorAll('[data-grp-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();const gid=btn.dataset.grpCollapse;_collapsedSteps[`zg-${gid}`]=!_collapsedSteps[`zg-${gid}`];renderEditorKeepScroll();};
  });
  el.querySelectorAll('[data-zone-sensor-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();const zid=btn.dataset.zoneSensorCollapse;_collapsedSteps[`zzr-${zid}`]=!_collapsedSteps[`zzr-${zid}`];renderEditorKeepScroll();};
  });

  // Zone checkboxes
  function collectSelections() {
    t.zone_ids  = [...el.querySelectorAll('[data-zone-cb]:checked')].map(cb=>cb.dataset.zoneCb);
    t.group_ids = [...el.querySelectorAll('[data-grp-cb]:checked')].map(cb=>cb.dataset.grpCb)
      .filter(gid=>{ // only include group if ALL its zones are selected
        const grp = groups().find(g=>g.id===gid);
        if (!grp) return false;
        return (grp.zone_ids||[]).every(zid=>t.zone_ids.includes(zid));
      });
  }
  el.querySelectorAll('[data-zone-cb]').forEach(cb=>{
    cb.onchange=()=>{
      collectSelections();
      // Update parent group checkbox state
      const gid=cb.dataset.groupId;
      if (gid) {
        const grp=groups().find(g=>g.id===gid);
        if (grp) {
          const allZids=grp.zone_ids||[];
          const grpCb=el.querySelector(`[data-grp-cb="${CSS.escape(gid)}"]`);
          if(grpCb) grpCb.checked=allZids.every(zid=>t.zone_ids.includes(zid));
        }
      }
    };
  });
  el.querySelectorAll('[data-grp-cb]').forEach(cb=>{
    cb.onchange=()=>{
      const gid=cb.dataset.grpCb;
      const grp=groups().find(g=>g.id===gid);
      if (grp) {
        // Cascade: check/uncheck all zone checkboxes in this group
        (grp.zone_ids||[]).forEach(zid=>{
          const zCb=el.querySelector(`[data-zone-cb="${CSS.escape(zid)}"]`);
          if (zCb) zCb.checked=cb.checked;
        });
      }
      collectSelections();
    };
  });
}

/* ── Sensor hierarchical selector ──────────────────────────── */
function sensorsHierarchicalSelector(selectedIds, id) {
  const tree = zoneGroupTree();
  return `<div id="${escH(id)}" class="ow-scbl" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;">
    <div style="position:relative;border-bottom:1px solid rgba(255,255,255,0.06);">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);opacity:0.35;pointer-events:none;"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2.5"/><path d="M16 16L21 21" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
      <input type="text" placeholder="Filter sensors…" autocomplete="off"
        style="width:100%;background:none;border:none;color:#ccc;padding:7px 10px 7px 28px;font-size:12px;outline:none;box-sizing:border-box;"
        oninput="(function(el){var q=el.value.toLowerCase();el.closest('.ow-scbl').querySelectorAll('[data-scbl-item]').forEach(function(r){r.style.display=r.dataset.scblLabel.toLowerCase().includes(q)?'':'none';});})(this)"
        onkeydown="event.stopPropagation()"/>
    </div>
    <div style="max-height:220px;overflow-y:auto;padding:4px;">
      ${tree.map(node=>{
        if (node.type==='ungrouped') {
          return node.zones.filter(z=>z.sensors?.length).map(z=>sensorZoneBlock(z,null,selectedIds)).join('');
        }
        const gZones=node.zones.filter(z=>z.sensors?.length);
        if (!gZones.length) return '';
        const gCollapsed=!!_collapsedSteps[`sg-${node.id}`];
        return `<div data-scbl-item data-scbl-label="${escH(node.name)}">
          <div style="display:flex;align-items:center;padding:5px 6px;gap:6px;">
            <button data-sg-collapse="${escH(node.id)}" style="background:none;border:none;color:#555;cursor:pointer;font-size:10px;padding:0 2px;">${gCollapsed?'▶':'▼'}</button>
            <span style="font-size:12px;font-weight:600;color:#ccc;">${escH(node.name)}</span>
            ${stateBadge(node.triggered,node.armed)}
          </div>
          ${gCollapsed?'':gZones.map(z=>sensorZoneBlock(z,node.id,selectedIds)).join('')}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function sensorZoneBlock(z, groupId, selectedIds) {
  const zCollapsed=!!_collapsedSteps[`sz-${z.id}`];
  const sensors=z.sensors||[];
  if (!sensors.length) return '';
  const allSel=sensors.every(e=>selectedIds.includes(e));
  return `<div data-scbl-item data-scbl-label="${escH(z.name||z.id)}">
    <div style="display:flex;align-items:center;padding:4px 6px;gap:6px;padding-left:${groupId?'20':'6'}px;">
      <button data-sz-collapse="${escH(z.id)}" style="background:none;border:none;color:#444;cursor:pointer;font-size:9px;padding:0 2px;">${zCollapsed?'▶':'▼'}</button>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">
        <input type="checkbox" data-sz-zone-cb="${escH(z.id)}" ${allSel?'checked':''} style="accent-color:#0064d2;">
        <span style="font-size:11px;font-weight:600;color:#bbb;">${escH(z.name||z.id)}</span>
        ${stateBadge(zoneTriggered(z),zoneArmed(z))}
      </label>
    </div>
    ${!zCollapsed?`<div style="padding-left:${groupId?'36':'22'}px;">${sensors.map(eid=>{
      const st=haStates()[eid]?.state;
      const fn=haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' ');
      return `<label data-scbl-item data-scbl-label="${escH(fn+' '+eid)}" style="display:flex;align-items:center;gap:7px;padding:3px 4px;cursor:pointer;border-radius:4px;" onmouseenter="this.style.background='rgba(255,255,255,0.04)'" onmouseleave="this.style.background=''">
        <input type="checkbox" value="${escH(eid)}" ${selectedIds.includes(eid)?'checked':''} style="accent-color:#0064d2;flex-shrink:0;">
        <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(fn)}</span>
        ${st!==undefined?stateBadge(st==='on',null,'small'):''}
      </label>`;
    }).join('')}</div>`:``}
  </div>`;
}

function wireSensorHierarchicalSelector(id, fn) {
  const el=_panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;
  el.querySelectorAll('[data-sg-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();_collapsedSteps[`sg-${btn.dataset.sgCollapse}`]=!_collapsedSteps[`sg-${btn.dataset.sgCollapse}`];renderEditorKeepScroll();};
  });
  el.querySelectorAll('[data-sz-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();_collapsedSteps[`sz-${btn.dataset.szCollapse}`]=!_collapsedSteps[`sz-${btn.dataset.szCollapse}`];renderEditorKeepScroll();};
  });
  function collect() { return [...el.querySelectorAll('input[value]:checked')].map(cb=>cb.value); }
  el.querySelectorAll('[data-sz-zone-cb]').forEach(zoneCb=>{
    const zid=zoneCb.dataset.szZoneCb;
    zoneCb.onchange=()=>{
      const z=zones().find(z=>z.id===zid);
      if(!z)return;
      const sensors=z.sensors||[];
      sensors.forEach(eid=>{const cb=el.querySelector(`input[value="${CSS.escape(eid)}"]`);if(cb)cb.checked=zoneCb.checked;});
      fn(collect());
    };
  });
  el.querySelectorAll('input[value]').forEach(cb=>{
    cb.onchange=()=>{
      fn(collect());
      // Update zone checkbox
      const zone=zones().find(z=>(z.sensors||[]).includes(cb.value));
      if (zone) {
        const zCb=el.querySelector(`[data-sz-zone-cb="${CSS.escape(zone.id)}"]`);
        if(zCb) zCb.checked=(zone.sensors||[]).every(e=>el.querySelector(`input[value="${CSS.escape(e)}"]`)?.checked);
      }
    };
  });
}

/* ── Stat badge ─────────────────────────────────────────────── */
function stateBadge(triggered, armed, size='normal') {
  const parts=[];
  if (triggered) parts.push(`<span style="font-size:${size==='small'?'9':'10'}px;padding:1px 4px;border-radius:3px;background:rgba(255,59,48,0.2);color:#ff6b6b;">triggered</span>`);
  else if (armed===true) parts.push(`<span style="font-size:${size==='small'?'9':'10'}px;padding:1px 4px;border-radius:3px;background:rgba(0,100,210,0.15);color:#4db8ff;">armed</span>`);
  else if (armed===false) parts.push(`<span style="font-size:${size==='small'?'9':'10'}px;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.05);color:#555;">disarmed</span>`);
  return parts.join('');
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
        <button class="ow-time-mode-btn" data-time-mode="manual" data-cond-id="${escH(c.id)}" style="${timeModeBtn(!useEntity)}">⏰ Manual</button>
        <button class="ow-time-mode-btn" data-time-mode="entity" data-cond-id="${escH(c.id)}" style="${timeModeBtn(useEntity)}">📡 Time sensor</button>
      </div>
      ${!useEntity ? `
        <div style="display:flex;gap:12px;">
          <div style="flex:1;"><label style="${labelStyle}">After</label><input id="cond-after-${c.id}" type="time" value="${escH(c.after||'00:00')}" style="${inputStyle}"/></div>
          <div style="flex:1;"><label style="${labelStyle}">Before</label><input id="cond-before-${c.id}" type="time" value="${escH(c.before||'23:59')}" style="${inputStyle}"/></div>
        </div>` : `
        <label style="${labelStyle}">Time sensor / input_datetime</label>
        ${entityAutocomplete(`cond-time-entity-ac-${c.id}`,c.time_entity||'','sensor.* / input_datetime.* / schedule.*',null,['sensor','input_datetime','schedule'])}`}`;
  }
  if (c.type === 'entity') {
    inner = `
      <div style="margin-bottom:10px;"><label style="${labelStyle}">Entity</label>${entityAutocomplete(`cond-entity-ac-${c.id}`,c.entity_id||'','Search any entity…')}</div>
      <div><label style="${labelStyle}">Must be in state</label><input id="cond-state-${c.id}" type="text" value="${escH(c.state||'on')}" placeholder="on / off / home / …" style="${inputStyle}"/></div>`;
  }
  if (c.type === 'person') {
    const persons  = entitiesByDomain('person');
    const trackers = entitiesByDomain('device_tracker');
    const all      = [...persons, ...trackers];
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Person / Device tracker</label>
        ${all.length
          ? searchableCheckboxList(c.entity_ids||[], all, `cond-person-${c.id}`)
          : entityAutocomplete(`cond-person-ac-${c.id}`, c.entity_ids?.[0]||'', 'person.* / device_tracker.*', null, ['person','device_tracker'])}
      </div>
      <div>
        <label style="${labelStyle}">Must be in state</label>
        <select id="cond-person-state-${c.id}" style="${selectStyle}">
          <option value="home"     ${c.state==='home'    ?'selected':''}>Home</option>
          <option value="not_home" ${c.state==='not_home'?'selected':''}>Away (not home)</option>
        </select>
      </div>`;
  }
  const labels = {time:'Time of Day', entity:'Entity State', person:'Person / Device'};
  return stepCard(c.id, labels[c.type]||c.type, inner, 'cond');
}

/* ════════════════════════════════════════════════════════════
 * ACTION CARDS  (with move up/down)
 * ═══════════════════════════════════════════════════════════ */
function actionCard(a, idx, total) {
  let inner = '';
  const moveControls = `
    <div style="display:flex;gap:4px;margin-left:8px;">
      <button data-action-up="${escH(a.id)}" ${idx===0?'disabled':''} title="Move up"
        style="background:none;border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:${idx===0?'#333':'#666'};cursor:${idx===0?'default':'pointer'};font-size:11px;padding:1px 6px;line-height:1.4;">↑</button>
      <button data-action-down="${escH(a.id)}" ${idx===total-1?'disabled':''} title="Move down"
        style="background:none;border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:${idx===total-1?'#333':'#666'};cursor:${idx===total-1?'default':'pointer'};font-size:11px;padding:1px 6px;line-height:1.4;">↓</button>
    </div>`;

  if (a.type === 'siren') {
    const sirens = sirenEntities();
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Sirens <span style="color:#444;font-weight:400;">(entities with "siren" in name/id)</span></label>
        ${sirens.length ? searchableCheckboxList(a.entity_ids||[],sirens,`act-sirens-${a.id}`) : entityAutocomplete(`act-siren-ac-${a.id}`,a.entity_ids?.[0]||'','siren.*',null,['siren'])}
      </div>
      <div><label style="${labelStyle}">Action</label>
        <select id="act-siren-svc-${a.id}" style="${selectStyle}">
          <option value="turn_on"  ${a.service==='turn_on' ?'selected':''}>Turn ON (activate)</option>
          <option value="turn_off" ${a.service==='turn_off'?'selected':''}>Turn OFF (silence)</option>
          <option value="toggle"   ${a.service==='toggle'  ?'selected':''}>Toggle</option>
        </select></div>`;
  }

  if (a.type === 'light') {
    const tree = lightsByGroupZone();
    const otherLights = entitiesByDomain('light').filter(e=>{
      const allZoneLightIds=new Set(zones().flatMap(z=>z.lights||[]));
      return !allZoneLightIds.has(e.entity_id);
    });
    inner = `
      ${tree.map(node=>lightGroupZoneBlock(node,a,`act-light-${a.id}`)).join('')}
      ${otherLights.length ? `<div style="margin-bottom:10px;"><label style="${labelStyle}">Other lights from HA</label>${searchableCheckboxList(a.entity_ids_other||[],otherLights,`act-light-other-${a.id}`)}</div>` : ''}
      ${!tree.length&&!otherLights.length?`<div style="color:#555;font-size:11px;margin-bottom:8px;">No lights found in zones.</div>`:''}
      <div><label style="${labelStyle}">Action</label>
        <select id="act-light-svc-${a.id}" style="${selectStyle}">
          <option value="turn_on"  ${a.service==='turn_on' ?'selected':''}>Turn ON</option>
          <option value="turn_off" ${a.service==='turn_off'?'selected':''}>Turn OFF</option>
          <option value="toggle"   ${a.service==='toggle'  ?'selected':''}>Toggle</option>
        </select></div>`;
  }

  if (a.type === 'camera') {
    const camTree = camerasByGroupZone();
    const camServices = _haServices['camera']||[];
    const baseServices = [
      {name:'turn_on',  description:'Turn on / enable camera'},
      {name:'turn_off', description:'Turn off / disable camera'},
      {name:'snapshot', description:'Take a snapshot'},
      {name:'record',   description:'Start recording'},
    ];
    const baseNames = new Set(baseServices.map(s=>s.name));
    const mergedServices = [...baseServices, ...camServices.filter(s=>!baseNames.has(s.name))];
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Cameras</label>
        ${camTree.map(node=>cameraGroupZoneBlock(node,a,`act-cam-${a.id}`)).join('')}
        ${!camTree.length?`<div style="color:#555;font-size:11px;margin-bottom:6px;">No cameras in zones — search HA:</div>${entityAutocomplete(`act-cam-ac-${a.id}`,a.entity_ids?.[0]||'','camera.*',null,['camera'])}`:''}
      </div>
      <div style="margin-bottom:10px;"><label style="${labelStyle}">Action</label>
        <select id="act-cam-svc-${a.id}" style="${selectStyle}">
          ${mergedServices.map(s=>`<option value="${escH(s.name)}" ${a.service===s.name?'selected':''}>${escH(s.name)} — ${escH(s.description)}</option>`).join('')}
        </select>
      </div>`;
  }

  if (a.type === 'notify') {
    const notifyEnts = notifyEntities();
    inner = `
      <div style="margin-bottom:10px;"><label style="${labelStyle}">Service</label>
        ${notifyEnts.length ? searchableCheckboxList([a.target].filter(Boolean),notifyEnts.map(e=>({entity_id:e.entity_id,name:e.entity_id.replace('notify.',''),state:e.state})),`act-notify-target-${a.id}`,true) : entityAutocomplete(`act-notify-ac-${a.id}`,a.target||'','notify.*',null,['notify'])}
      </div>
      <div style="margin-bottom:10px;"><label style="${labelStyle}">Message</label>
        <textarea id="act-notify-msg-${a.id}" rows="3" style="${inputStyle}resize:vertical;"
          placeholder="Alert message… ({{ trigger.entity_id }} for dynamic values)">${escH(a.message||'')}</textarea>
        <div style="font-size:10px;color:#444;margin-top:3px;">💡 <code style="color:#555;">{{ trigger.entity_id }}</code> · <code style="color:#555;">{{ states('x') }}</code> · <span id="act-notify-template-${a.id}" style="color:#0064d2;cursor:pointer;">📋 Presets ▾</span></div>
        <div id="act-notify-presets-${a.id}" style="display:none;margin-top:6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:7px;padding:8px;"></div>
      </div>
      <div><label style="${labelStyle}">Title (optional)</label><input id="act-notify-title-${a.id}" type="text" value="${escH(a.title||'')}" placeholder="HA-Overwatch Alert" style="${inputStyle}"/></div>`;
  }

  if (a.type === 'arm') {
    const alarmEnts = entitiesByDomain('alarm_control_panel');
    const def = ow().uiConfig?.alarm_entity||'';
    inner = `
      <div style="margin-bottom:10px;"><label style="${labelStyle}">Alarm Panel</label>
        ${alarmEnts.length ? `<select id="act-arm-entity-sel-${a.id}" style="${selectStyle}">${alarmEnts.map(e=>`<option value="${escH(e.entity_id)}" ${(a.entity_id||def)===e.entity_id?'selected':''}>${escH(e.name)}</option>`).join('')}</select>` : entityAutocomplete(`act-arm-entity-ac-${a.id}`,a.entity_id||def,'alarm_control_panel.*',null,['alarm_control_panel'])}
      </div>
      <div><label style="${labelStyle}">Action</label>
        <select id="act-arm-svc-${a.id}" style="${selectStyle}">
          <option value="alarm_arm_away"  ${a.service==='alarm_arm_away' ?'selected':''}>Arm Away</option>
          <option value="alarm_arm_home"  ${a.service==='alarm_arm_home' ?'selected':''}>Arm Home</option>
          <option value="alarm_arm_night" ${a.service==='alarm_arm_night'?'selected':''}>Arm Night</option>
          <option value="alarm_disarm"    ${a.service==='alarm_disarm'   ?'selected':''}>Disarm</option>
        </select></div>`;
  }

  if (a.type === 'entity') {
    inner = `
      <div style="margin-bottom:10px;"><label style="${labelStyle}">Entity</label>${entityAutocomplete(`act-entity-ac-${a.id}`,a.entity_id||'','Search any entity…')}</div>
      <div><label style="${labelStyle}">Service</label>
        <select id="act-entity-svc-${a.id}" style="${selectStyle}">
          <option value="turn_on"  ${a.service==='turn_on' ?'selected':''}>turn_on</option>
          <option value="turn_off" ${a.service==='turn_off'?'selected':''}>turn_off</option>
          <option value="toggle"   ${a.service==='toggle'  ?'selected':''}>toggle</option>
        </select></div>`;
  }

  const labels={siren:'Siren',light:'Light',camera:'Camera',notify:'Notify',arm:'Arm/Disarm',entity:'Other Entity'};
  return stepCard(a.id, labels[a.type]||a.type, inner, 'action', moveControls);
}

function lightGroupZoneBlock(node, a, baseId) {
  if (node.type==='group') {
    const gCollapsed=!!_collapsedSteps[`lg-${node.id}`];
    return `<div style="margin-bottom:6px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <button data-lg-collapse="${escH(node.id)}" style="background:none;border:none;color:#555;cursor:pointer;font-size:10px;padding:0 2px;">${gCollapsed?'▶':'▼'}</button>
        <span style="font-size:11px;font-weight:600;color:#ccc;">${escH(node.name)}</span>${stateBadge(node.triggered,node.armed)}
      </div>
      ${gCollapsed?'':node.children.map(z=>lightGroupZoneBlock(z,a,baseId)).join('')}
    </div>`;
  }
  // Zone node
  const zCollapsed=!!_collapsedSteps[`lz-${node.id}`];
  const lightIds=node.children.map(l=>l.entity_id);
  const selIds=a.entity_ids_zone||[];
  const allSel=lightIds.every(e=>selIds.includes(e));
  return `<div style="margin-bottom:4px;padding-left:16px;">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
      <button data-lz-collapse="${escH(node.id)}" style="background:none;border:none;color:#444;cursor:pointer;font-size:9px;padding:0 2px;">${zCollapsed?'▶':'▼'}</button>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">
        <input type="checkbox" data-lz-zone-cb="${escH(node.id)}" data-base-id="${escH(baseId)}" ${allSel?'checked':''} style="accent-color:#0064d2;">
        <span style="font-size:11px;color:#bbb;">${escH(node.name)}</span>${stateBadge(node.triggered,node.armed)}
      </label>
    </div>
    ${!zCollapsed?`<div style="padding-left:20px;">${node.children.map(l=>`
      <label style="display:flex;align-items:center;gap:7px;padding:2px 4px;cursor:pointer;border-radius:4px;" onmouseenter="this.style.background='rgba(255,255,255,0.04)'" onmouseleave="this.style.background=''">
        <input type="checkbox" data-light-cb value="${escH(l.entity_id)}" data-base-id="${escH(baseId)}" ${selIds.includes(l.entity_id)?'checked':''} style="accent-color:#0064d2;flex-shrink:0;">
        <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(l.name)}</span>
        ${l.state!==undefined?stateBadge(l.state==='on',null,'small'):''}
      </label>`).join('')}</div>`:``}
  </div>`;
}

function wireLightTree(a, baseId) {
  const el=_panelEl;
  if (!el) return;
  el.querySelectorAll('[data-lg-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();_collapsedSteps[`lg-${btn.dataset.lgCollapse}`]=!_collapsedSteps[`lg-${btn.dataset.lgCollapse}`];renderEditorKeepScroll();};
  });
  el.querySelectorAll('[data-lz-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();_collapsedSteps[`lz-${btn.dataset.lzCollapse}`]=!_collapsedSteps[`lz-${btn.dataset.lzCollapse}`];renderEditorKeepScroll();};
  });
  function collectLights() {
    return [...el.querySelectorAll(`[data-light-cb][data-base-id="${CSS.escape(baseId)}"]:checked`)].map(cb=>cb.value);
  }
  el.querySelectorAll(`[data-lz-zone-cb][data-base-id="${CSS.escape(baseId)}"]`).forEach(zoneCb=>{
    zoneCb.onchange=()=>{
      const zid=zoneCb.dataset.lzZoneCb;
      const z=zones().find(z=>z.id===zid);
      if(z)(z.lights||[]).forEach(eid=>{const cb=el.querySelector(`[data-light-cb][value="${CSS.escape(eid)}"]`);if(cb)cb.checked=zoneCb.checked;});
      a.entity_ids_zone=collectLights();
    };
  });
  el.querySelectorAll(`[data-light-cb][data-base-id="${CSS.escape(baseId)}"]`).forEach(cb=>{
    cb.onchange=()=>{
      a.entity_ids_zone=collectLights();
      const z=zones().find(z=>(z.lights||[]).includes(cb.value));
      if(z){const zCb=el.querySelector(`[data-lz-zone-cb="${CSS.escape(z.id)}"]`);if(zCb)zCb.checked=(z.lights||[]).every(e=>el.querySelector(`[data-light-cb][value="${CSS.escape(e)}"]`)?.checked);}
    };
  });
}

function cameraGroupZoneBlock(node, a, baseId) {
  if (node.type==='group') {
    const gC=!!_collapsedSteps[`cg-${node.id}`];
    return `<div style="margin-bottom:6px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <button data-cg-collapse="${escH(node.id)}" style="background:none;border:none;color:#555;cursor:pointer;font-size:10px;padding:0 2px;">${gC?'▶':'▼'}</button>
        <span style="font-size:11px;font-weight:600;color:#ccc;">${escH(node.name)}</span>${stateBadge(node.triggered,node.armed)}
      </div>
      ${gC?'':node.children.map(z=>cameraGroupZoneBlock(z,a,baseId)).join('')}
    </div>`;
  }
  const zC=!!_collapsedSteps[`cz-${node.id}`];
  const selIds=a.entity_ids||[];
  const camIds=node.children.map(c=>c.entity_id);
  const allSel=camIds.every(e=>selIds.includes(e));
  return `<div style="margin-bottom:4px;padding-left:16px;">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
      <button data-cz-collapse="${escH(node.id)}" style="background:none;border:none;color:#444;cursor:pointer;font-size:9px;padding:0 2px;">${zC?'▶':'▼'}</button>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">
        <input type="checkbox" data-cz-zone-cb="${escH(node.id)}" data-base-id="${escH(baseId)}" ${allSel?'checked':''} style="accent-color:#0064d2;">
        <span style="font-size:11px;color:#bbb;">${escH(node.name)}</span>${stateBadge(node.triggered,node.armed)}
      </label>
    </div>
    ${!zC?`<div style="padding-left:20px;">${node.children.map(c=>`
      <label style="display:flex;align-items:center;gap:7px;padding:2px 4px;cursor:pointer;border-radius:4px;" onmouseenter="this.style.background='rgba(255,255,255,0.04)'" onmouseleave="this.style.background=''">
        <input type="checkbox" data-cam-cb value="${escH(c.entity_id)}" data-base-id="${escH(baseId)}" ${selIds.includes(c.entity_id)?'checked':''} style="accent-color:#0064d2;flex-shrink:0;">
        <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(c.name)}</span>
      </label>`).join('')}</div>`:``}
  </div>`;
}

function wireCameraTree(a, baseId) {
  const el=_panelEl;
  if(!el)return;
  el.querySelectorAll('[data-cg-collapse]').forEach(btn=>{btn.onclick=e=>{e.stopPropagation();_collapsedSteps[`cg-${btn.dataset.cgCollapse}`]=!_collapsedSteps[`cg-${btn.dataset.cgCollapse}`];renderEditorKeepScroll();};});
  el.querySelectorAll('[data-cz-collapse]').forEach(btn=>{btn.onclick=e=>{e.stopPropagation();_collapsedSteps[`cz-${btn.dataset.czCollapse}`]=!_collapsedSteps[`cz-${btn.dataset.czCollapse}`];renderEditorKeepScroll();};});
  function collectCams() { return [...el.querySelectorAll(`[data-cam-cb][data-base-id="${CSS.escape(baseId)}"]:checked`)].map(cb=>cb.value); }
  el.querySelectorAll(`[data-cz-zone-cb][data-base-id="${CSS.escape(baseId)}"]`).forEach(zoneCb=>{
    zoneCb.onchange=()=>{
      const z=zones().find(z=>z.id===zoneCb.dataset.czZoneCb);
      if(z)(z.cameras||[]).forEach(eid=>{const cb=el.querySelector(`[data-cam-cb][value="${CSS.escape(eid)}"]`);if(cb)cb.checked=zoneCb.checked;});
      a.entity_ids=collectCams();
    };
  });
  el.querySelectorAll(`[data-cam-cb][data-base-id="${CSS.escape(baseId)}"]`).forEach(cb=>{
    cb.onchange=()=>{
      a.entity_ids=collectCams();
      const z=zones().find(z=>(z.cameras||[]).includes(cb.value));
      if(z){const zCb=el.querySelector(`[data-cz-zone-cb="${CSS.escape(z.id)}"]`);if(zCb)zCb.checked=(z.cameras||[]).every(e=>el.querySelector(`[data-cam-cb][value="${CSS.escape(e)}"]`)?.checked);}
    };
  });
}

/* ════════════════════════════════════════════════════════════
 * FIELD WIRING
 * ═══════════════════════════════════════════════════════════ */
function wireTriggerFields(t) {
  if (t.type==='zone'||t.type==='zone_arm') {
    wireZoneGroupSelector(t, `trig-zg-${t.id}`);
    if (t.type==='zone') wireSelect(`trig-event-${t.id}`,v=>t.event=v);
    else wireSelect(`trig-armstate-${t.id}`,v=>t.state=v);
  }
  if (t.type==='sensor') { wireSensorHierarchicalSelector(`trig-sensor-${t.id}`,ids=>t.entity_ids=ids); wireSelect(`trig-sensorstate-${t.id}`,v=>t.state=v); }
  if (t.type==='person') { wireSelect(`trig-personstate-${t.id}`,v=>t.state=v); wireSearchableCheckbox(`trig-person-${t.id}`,ids=>t.entity_ids=ids); wireAutocomplete(`trig-person-ac-${t.id}`,v=>t.entity_ids=v?[v]:[]); }
  if (t.type==='device') { wireSelect(`trig-devicestate-${t.id}`,v=>t.state=v); wireSearchableCheckbox(`trig-device-${t.id}`,ids=>t.entity_ids=ids); wireAutocomplete(`trig-device-ac-${t.id}`,v=>t.entity_ids=v?[v]:[]); }
  if (t.type==='entity') { wireAutocomplete(`trig-entity-ac-${t.id}`,v=>t.entity_id=v); wireInput(`trig-to-${t.id}`,v=>t.to=v); }
  wireInput(`trig-for-${t.id}`,v=>t.for_duration=v.trim()||null);
}

function wireConditionFields(c) {
  if (c.type==='time') {
    _panelEl.querySelectorAll(`.ow-time-mode-btn[data-cond-id="${c.id}"]`).forEach(btn=>{btn.onclick=()=>{c.time_mode=btn.dataset.timeMode;renderEditorKeepScroll();};});
    if (c.time_mode!=='entity') { wireInput(`cond-after-${c.id}`,v=>c.after=v); wireInput(`cond-before-${c.id}`,v=>c.before=v); }
    else wireAutocomplete(`cond-time-entity-ac-${c.id}`,v=>c.time_entity=v);
  }
  if (c.type==='entity') { wireAutocomplete(`cond-entity-ac-${c.id}`,v=>c.entity_id=v); wireInput(`cond-state-${c.id}`,v=>c.state=v); }
  if (c.type==='person') {
    wireSearchableCheckbox(`cond-person-${c.id}`,ids=>c.entity_ids=ids);
    wireAutocomplete(`cond-person-ac-${c.id}`,v=>c.entity_ids=v?[v]:[]);
    wireSelect(`cond-person-state-${c.id}`,v=>c.state=v);
  }
}

function wireActionFields(a) {
  if (a.type==='siren') {
    wireSearchableCheckbox(`act-sirens-${a.id}`,ids=>a.entity_ids=ids);
    wireAutocomplete(`act-siren-ac-${a.id}`,v=>a.entity_ids=v?[v]:[]);
    wireSelect(`act-siren-svc-${a.id}`,v=>a.service=v);
  }
  if (a.type==='light') {
    wireLightTree(a,`act-light-${a.id}`);
    wireSearchableCheckbox(`act-light-other-${a.id}`,ids=>a.entity_ids_other=ids);
    wireSelect(`act-light-svc-${a.id}`,v=>a.service=v);
  }
  if (a.type==='camera') {
    wireCameraTree(a,`act-cam-${a.id}`);
    wireAutocomplete(`act-cam-ac-${a.id}`,v=>a.entity_ids=v?[v]:[]);
    wireSelect(`act-cam-svc-${a.id}`,v=>a.service=v);
    wireInput(`act-cam-svc-${a.id}`,v=>a.service=v);
  }
  if (a.type==='notify') {
    wireSearchableCheckbox(`act-notify-target-${a.id}`,ids=>a.target=ids[0]||'',true);
    wireAutocomplete(`act-notify-ac-${a.id}`,v=>a.target=v);
    const msg=_panelEl?.querySelector(`#act-notify-msg-${a.id}`);
    if(msg)msg.oninput=()=>{a.message=msg.value;};
    wireInput(`act-notify-title-${a.id}`,v=>a.title=v);
    // Presets
    const pt=_panelEl?.querySelector(`#act-notify-template-${a.id}`);
    const pb=_panelEl?.querySelector(`#act-notify-presets-${a.id}`);
    if(pt&&pb){
      const presets=[
        {label:'Zone triggered',msg:"⚠️ Zone triggered: {{ trigger.entity_id }}. Time: {{ now().strftime('%H:%M') }}."},
        {label:'Zone armed',    msg:"🔐 Zone armed at {{ now().strftime('%H:%M') }}."},
        {label:'Zone cleared',  msg:"✅ Zone cleared: {{ trigger.entity_id }}."},
        {label:'Alarm triggered',msg:"🚨 ALARM! Zone: {{ trigger.entity_id }} at {{ now().strftime('%H:%M:%S') }}."},
        {label:'Person home',   msg:"🏠 {{ trigger.entity_id }} home at {{ now().strftime('%H:%M') }}."},
      ];
      pt.onclick=()=>{
        const open=pb.style.display==='none';pb.style.display=open?'block':'none';
        if(open&&!pb.innerHTML){pb.innerHTML=presets.map((p,i)=>`<button class="ow-preset-btn" data-pi="${i}" style="display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid rgba(255,255,255,0.05);color:#aaa;padding:6px 4px;cursor:pointer;font-size:11px;">${escH(p.label)}</button>`).join('');
          pb.querySelectorAll('.ow-preset-btn').forEach(btn=>{btn.onmouseenter=()=>btn.style.color='#fff';btn.onmouseleave=()=>btn.style.color='#aaa';btn.onclick=()=>{const p=presets[parseInt(btn.dataset.pi)];if(msg){msg.value=p.msg;a.message=p.msg;}pb.style.display='none';};});}
      };
    }
  }
  if (a.type==='arm') { wireSelect(`act-arm-entity-sel-${a.id}`,v=>a.entity_id=v); wireAutocomplete(`act-arm-entity-ac-${a.id}`,v=>a.entity_id=v); wireSelect(`act-arm-svc-${a.id}`,v=>a.service=v); }
  if (a.type==='entity') { wireAutocomplete(`act-entity-ac-${a.id}`,v=>a.entity_id=v); wireSelect(`act-entity-svc-${a.id}`,v=>a.service=v); }
}

/* ════════════════════════════════════════════════════════════
 * SHARED WIDGETS
 * ═══════════════════════════════════════════════════════════ */
function searchableCheckboxList(selectedIds, entities, id, singleSelect=false) {
  if (!entities.length) return `<div style="color:#555;font-size:11px;">No entities found</div>`;
  return `<div id="${escH(id)}" class="ow-scbl" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;">
    <div style="position:relative;border-bottom:1px solid rgba(255,255,255,0.06);">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);opacity:0.35;pointer-events:none;"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2.5"/><path d="M16 16L21 21" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
      <input type="text" placeholder="Filter…" autocomplete="off"
        style="width:100%;background:none;border:none;color:#ccc;padding:7px 10px 7px 28px;font-size:12px;outline:none;box-sizing:border-box;"
        oninput="(function(el){var q=el.value.toLowerCase();el.closest('.ow-scbl').querySelectorAll('[data-scbl-item]').forEach(function(r){r.style.display=r.dataset.scblLabel.toLowerCase().includes(q)?'':'none';});})(this)"
        onkeydown="event.stopPropagation()"/>
    </div>
    <div style="max-height:160px;overflow-y:auto;padding:4px;">
      ${entities.map(e=>{
        const state=e.state??haStates()[e.entity_id]?.state;
        const badge=state!==undefined?stateBadge(state==='on'||state==='home',null,'small'):'';
        return `<label data-scbl-item data-scbl-label="${escH((e.name||e.entity_id)+' '+e.entity_id)}" style="display:flex;align-items:center;gap:8px;padding:5px 6px;cursor:pointer;border-radius:5px;" onmouseenter="this.style.background='rgba(255,255,255,0.04)'" onmouseleave="this.style.background=''">
          <input type="${singleSelect?'radio':'checkbox'}" name="${singleSelect?escH(id):''}" value="${escH(e.entity_id)}" ${(selectedIds||[]).includes(e.entity_id)?'checked':''} style="accent-color:#0064d2;flex-shrink:0;">
          <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(e.name||e.entity_id.split('.').pop())}</span>
          <span style="font-size:10px;color:#444;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(e.entity_id)}</span>
          ${badge}
        </label>`;
      }).join('')}
    </div>
  </div>`;
}

function wireSearchableCheckbox(id, fn, singleSelect=false) {
  const el=_panelEl?.querySelector(`#${CSS.escape(id)}`);
  if(!el)return;
  const inputs=el.querySelectorAll('input[type=checkbox],input[type=radio]');
  inputs.forEach(cb=>cb.onchange=()=>fn([...inputs].filter(c=>c.checked).map(c=>c.value)));
}

function entityAutocomplete(id, value, placeholder, hint, filterDomains) {
  return `<div data-entity-autocomplete data-ac-id="${escH(id)}" data-filter-domains="${escH(filterDomains?filterDomains.join(','):'')}" style="position:relative;">
    <input id="${escH(id)}" type="text" value="${escH(value)}" placeholder="${escH(placeholder)}" autocomplete="off" spellcheck="false" style="${inputStyle}"/>
    <div id="${escH(id)}-dd" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:10000;background:#141416;border:1px solid rgba(255,255,255,0.12);border-radius:8px;max-height:200px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.6);"></div>
    ${hint?`<div style="font-size:10px;color:#444;margin-top:3px;">${escH(hint)}</div>`:''}
  </div>`;
}

function bindEntityAutocomplete(wrapEl) {
  const id=wrapEl.dataset.acId;
  const filterDomains=wrapEl.dataset.filterDomains?wrapEl.dataset.filterDomains.split(',').filter(Boolean):null;
  const input=wrapEl.querySelector(`#${CSS.escape(id)}`);
  const dd=wrapEl.querySelector(`#${CSS.escape(id)}-dd`);
  if(!input||!dd)return;
  const cb=wrapEl._acCallback;
  function hits(q) {
    let list=allEntities();
    if(filterDomains?.length)list=list.filter(e=>filterDomains.includes(e.domain));
    if(!q)return list.slice(0,40);
    const lq=q.toLowerCase();
    return list.filter(e=>e.entity_id.toLowerCase().includes(lq)||(e.name||'').toLowerCase().includes(lq)).slice(0,60);
  }
  function renderDd(q) {
    const h=hits(q);
    if(!h.length){dd.style.display='none';return;}
    dd.innerHTML=h.map(e=>{
      const state=e.state??haStates()[e.entity_id]?.state;
      const badge=state!==undefined?stateBadge(state==='on',null,'small'):'';
      return `<div data-val="${escH(e.entity_id)}" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid rgba(255,255,255,0.04);" onmouseenter="this.style.background='rgba(255,255,255,0.07)'" onmouseleave="this.style.background=''">
        <span style="font-size:10px;color:#555;width:80px;flex-shrink:0;">${escH(e.domain)}</span>
        <span style="flex:1;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(e.name||e.entity_id.split('.').pop())}</span>
        <span style="font-size:10px;color:#444;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(e.entity_id)}</span>
        ${badge}
      </div>`;
    }).join('');
    dd.querySelectorAll('[data-val]').forEach(row=>{row.onmousedown=ev=>{ev.preventDefault();input.value=row.dataset.val;dd.style.display='none';if(cb)cb(row.dataset.val);};});
    dd.style.display='block';
  }
  input.addEventListener('focus',()=>renderDd(input.value));
  input.addEventListener('input',()=>{renderDd(input.value);if(cb)cb(input.value.trim());});
  input.addEventListener('blur',()=>setTimeout(()=>dd.style.display='none',160));
  input.addEventListener('keydown',ev=>{
    if(dd.style.display==='none')return;
    const rows=[...dd.querySelectorAll('[data-val]')];const cur=dd.querySelector('[data-active]');const idx=cur?rows.indexOf(cur):-1;
    if(ev.key==='ArrowDown'){ev.preventDefault();rows.forEach(r=>r.removeAttribute('data-active'));const n=rows[Math.min(idx+1,rows.length-1)];if(n){n.dataset.active='1';n.style.background='rgba(255,255,255,0.07)';n.scrollIntoView({block:'nearest'});}}
    else if(ev.key==='ArrowUp'){ev.preventDefault();rows.forEach(r=>r.removeAttribute('data-active'));const p=rows[Math.max(idx-1,0)];if(p){p.dataset.active='1';p.style.background='rgba(255,255,255,0.07)';p.scrollIntoView({block:'nearest'});}}
    else if(ev.key==='Enter'&&cur){ev.preventDefault();input.value=cur.dataset.val;dd.style.display='none';if(cb)cb(input.value.trim());}
    else if(ev.key==='Escape')dd.style.display='none';
  });
}

function wireAutocomplete(id, fn) {
  const wrap=_panelEl?.querySelector(`[data-entity-autocomplete][data-ac-id="${CSS.escape(id)}"]`);
  if(wrap){wrap._acCallback=fn;bindEntityAutocomplete(wrap);}
}
function wireSelect(id,fn){const el=_panelEl?.querySelector(`#${CSS.escape(id)}`);if(el)el.onchange=()=>fn(el.value);}
function wireInput(id,fn){const el=_panelEl?.querySelector(`#${CSS.escape(id)}`);if(el)el.oninput=()=>fn(el.value);}

/* ── Step card ──────────────────────────────────────────────── */
function stepCard(stepId, label, inner, removeType, extraControls='') {
  const colors={trigger:'#0064d2',cond:'#9b59b6',action:'#27ae60'};
  const color=colors[removeType]||'#555';
  const ra={trigger:`data-remove-trigger="${escH(stepId)}"`,cond:`data-remove-cond="${escH(stepId)}"`,action:`data-remove-action="${escH(stepId)}"`}[removeType]||'';
  const collapsed=!!_collapsedSteps[stepId];
  return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-left:3px solid ${color};border-radius:8px;padding:10px 12px;margin-bottom:7px;">
    <div style="display:flex;align-items:center;${collapsed?'':'margin-bottom:10px;'}">
      <button data-step-collapse="${escH(stepId)}" style="background:none;border:none;color:${color};cursor:pointer;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;padding:0;text-align:left;flex:1;">${collapsed?'▶':'▼'} ${escH(label)}</button>
      ${extraControls}
      <button ${ra} style="background:none;border:none;color:#3a3a3a;cursor:pointer;font-size:14px;padding:0 2px;line-height:1;margin-left:8px;" onmouseenter="this.style.color='#ff453a'" onmouseleave="this.style.color='#3a3a3a'">✕</button>
    </div>
    ${collapsed?'':`<div>${inner}</div>`}
  </div>`;
}

/* ── Section wrapper ─────────────────────────────────────────── */
function editorSection(icon,title,subtitle,key,collapsed,body,addBtns) {
  return `<div style="padding:16px 0 0;border-top:1px solid rgba(255,255,255,0.05);margin-top:14px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:${collapsed?'0':'8px'};">
      <span style="font-size:15px;">${icon}</span>
      <span style="font-size:13px;font-weight:600;flex:1;">${title}</span>
      <button data-section-toggle="${key}" style="background:none;border:1px solid rgba(255,255,255,0.08);border-radius:5px;color:#555;cursor:pointer;font-size:11px;padding:2px 8px;">${collapsed?'▶ Expand':'▼ Collapse'}</button>
    </div>
    ${!collapsed?`<div style="font-size:11px;color:#555;margin-bottom:8px;">${subtitle}</div><div>${body}</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">${addBtns}</div>`:''}
  </div>`;
}

function emptyStepMsg(msg){return `<div style="color:#444;font-size:12px;padding:5px 0;">${msg}</div>`;}
function timeModeBtn(active){return `background:${active?'rgba(0,100,210,0.2)':'rgba(255,255,255,0.05)'};border:1px solid ${active?'rgba(0,100,210,0.5)':'rgba(255,255,255,0.1)'};color:${active?'#4db8ff':'#888'};border-radius:6px;padding:4px 11px;cursor:pointer;font-size:11px;font-weight:600;`;}

/* ── Styles ─────────────────────────────────────────────────── */
const labelStyle  = 'display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#555;margin-bottom:4px;';
const selectStyle = `background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;padding:7px 10px;font-size:12px;width:100%;outline:none;`;
const inputStyle  = `width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#fff;padding:7px 10px;font-size:12px;outline:none;box-sizing:border-box;`;
function btnStyle(bg,border,ghost=false){return `background:${bg};border:1px solid ${ghost?'rgba(255,255,255,0.1)':border};color:${ghost?'#aaa':'#fff'};border-radius:8px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600;`;}

function injectStyles(){
  if(document.getElementById('ow-auto-styles'))return;
  const s=document.createElement('style');s.id='ow-auto-styles';
  s.textContent=`
    .ow-add-btn{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#aaa;border-radius:7px;padding:5px 12px;cursor:pointer;font-size:12px;transition:background 0.1s,color 0.1s;}
    .ow-add-btn:hover{background:rgba(255,255,255,0.1);color:#fff;}
    @keyframes ow-blink{0%,100%{opacity:1}50%{opacity:0.3}}
  `;
  document.head.appendChild(s);
}

/* ── Search integration ─────────────────────────────────────── */
function searchAutomations(query){
  if(!query)return[];
  const q=query.toLowerCase();
  return _automations.map(a=>a.draft).filter(a=>a.name.toLowerCase().includes(q)).map(a=>({
    type:'automation',id:a.id,label:`⚡ ${a.name}`,
    sublabel:[a.triggers?.length&&`${a.triggers.length} trigger(s)`,a.actions?.length&&`${a.actions.length} action(s)`].filter(Boolean).join(' · '),
    action:()=>{if(!_open)open();_editing=a.id;_draft=JSON.parse(JSON.stringify(a));renderEditor();},
  }));
}

/* ── Init ───────────────────────────────────────────────────── */
function init(){
  injectStyles();
  const reg=()=>{if(window.OW)window.OW.automationSearch=searchAutomations;else setTimeout(reg,500);};
  reg();
}

window.OW_Automations={toggle,open,close,searchAutomations};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
else init();

})();
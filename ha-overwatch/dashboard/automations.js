/* ================================================================
 * HA-Overwatch — automations.js  v0.05.12
 * Admin-only Automation Editor.
 * HA is source of truth — reads/writes directly via server proxy.
 * ================================================================ */
(function () {
'use strict';

/* ── State ─────────────────────────────────────────────────── */
let _panelEl        = null;
let _open           = false;
let _automations    = [];        // [{draft, warnings, ha_id}]
let _doorPins       = [];        // [{id, zone_id, sensor_entity, name, ...}]
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
async function loadDoorPins() {
  try {
    const r = await fetch(apiPath('ow/door-pins') + '?v=' + Date.now());
    if (r.ok) _doorPins = await r.json();
  } catch { _doorPins = []; }
}

// Get door sensor entity IDs for a zone (from doorPins)
function doorSensorsForZone(zoneId) {
  return _doorPins.filter(p => p.zone_id === zoneId && p.sensor_entity).map(p => p.sensor_entity);
}

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

// Build a device tree (lights/cameras) from zoneGroupTree, filtering to zones that have the device type
function deviceTreeFromZones(deviceKey) {
  // deviceKey: 'lights' | 'cameras'
  // Returns the same floor→group→zone structure as zoneGroupTree but only nodes with devices
  const tree = zoneGroupTree();
  const result = [];
  tree.forEach(node => {
    if (node.type === 'floor') {
      const floorGroups = (node.groups||[]).map(g => {
        const gZones = g.zones.filter(z=>(z[deviceKey]||[]).length>0).map(z=>({
          ...z, devices:(z[deviceKey]||[]).map(eid=>({entity_id:eid,name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '),state:haStates()[eid]?.state}))
        }));
        return gZones.length ? {...g, zones:gZones} : null;
      }).filter(Boolean);
      const floorUngrouped = (node.ungrouped||[]).filter(z=>(z[deviceKey]||[]).length>0).map(z=>({
        ...z, devices:(z[deviceKey]||[]).map(eid=>({entity_id:eid,name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '),state:haStates()[eid]?.state}))
      }));
      if (floorGroups.length||floorUngrouped.length) {
        result.push({type:'floor',id:node.id,name:node.name,groups:floorGroups,ungrouped:floorUngrouped,triggered:node.triggered,armed:node.armed});
      }
    } else if (node.type === 'group') {
      const gZones = node.zones.filter(z=>(z[deviceKey]||[]).length>0).map(z=>({
        ...z, devices:(z[deviceKey]||[]).map(eid=>({entity_id:eid,name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '),state:haStates()[eid]?.state}))
      }));
      if (gZones.length) result.push({type:'group',...node,zones:gZones});
    } else if (node.type === 'ungrouped') {
      (node.zones||[]).filter(z=>(z[deviceKey]||[]).length>0).forEach(z=>{
        result.push({type:'zone',...z, devices:(z[deviceKey]||[]).map(eid=>({entity_id:eid,name:haStates()[eid]?.attributes?.friendly_name||eid.split('.').pop().replace(/_/g,' '),state:haStates()[eid]?.state}))});
      });
    }
  });
  return result;
}

function lightsByGroupZone()   { return deviceTreeFromZones('lights'); }
function camerasByGroupZone()  { return deviceTreeFromZones('cameras'); }
function sirensByGroupZone()   { return deviceTreeFromZones('sirens'); }



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

/* ── Zone/Group hierarchical selector for triggers ─────────── */
// Returns zone/group tree for zone event / zone arm triggers
function zoneGroupTree() {
  const floorList = ow().floors || [];
  const result = [];
  const gpzids = new Set(groups().flatMap(g=>g.zone_ids||[]));

  if (floorList.length > 0) {
    const firstFloorId = floorList[0].id;

    floorList.forEach(floor => {
      const isFirst = floor.id === firstFloorId;
      // A zone belongs to this floor if: floor_id matches, OR (zone has no floor_id AND this is the first floor)
      const belongsToFloor = z => z.floor_id === floor.id || (!z.floor_id && isFirst);

      // Groups with at least one zone on this floor
      const floorGroups = groups().map(g => {
        const gZones = (g.zone_ids||[]).map(id=>zones().find(z=>z.id===id)).filter(z=>z && belongsToFloor(z));
        if (!gZones.length) return null;
        return {type:'group',id:g.id,name:g.name||g.id,armed:groupArmed(g),triggered:groupTriggered(g),zones:gZones};
      }).filter(Boolean);

      // Ungrouped zones on this floor
      const floorUngrouped = zones().filter(z=>!gpzids.has(z.id) && belongsToFloor(z));

      if (floorGroups.length || floorUngrouped.length) {
        result.push({type:'floor',id:floor.id,name:floor.name||floor.id,groups:floorGroups,ungrouped:floorUngrouped});
      }
    });
  } else {
    // No floors configured — flat: groups then ungrouped zones
    groups().forEach(g=>{
      const gZones=(g.zone_ids||[]).map(id=>zones().find(z=>z.id===id)).filter(Boolean);
      if(gZones.length) result.push({type:'group',id:g.id,name:g.name||g.id,armed:groupArmed(g),triggered:groupTriggered(g),zones:gZones});
    });
    const ungrouped=zones().filter(z=>!gpzids.has(z.id));
    if(ungrouped.length) result.push({type:'ungrouped',zones:ungrouped});
  }
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
  try {
    if (ha.variables?.ow_id) { owId=ha.variables.ow_id; owName=ha.variables.ow_name||null; }
    else { const m=JSON.parse(ha.description||"{}"); owId=m.ow_id||null; owName=m.ow_name||null; }
  } catch {}
  const alias=ha.alias||"";
  const displayName=owName||alias.replace(/^HA-Overwatch\s*[-–—]?\s*/i,"").trim();
  const draft = { id:owId||uid(), name:displayName, enabled:ha.state!=="off", triggers:[], conditions:[], actions:[], _ha_parse_warnings:[] };

  function zoneBySlug(slug) { return zones().find(z=>(nameSlug(z.name)||z.id)===slug||z.id===slug); }
  function groupBySlug(slug) { return groups().find(g=>(nameSlug(g.name)||g.id)===slug||g.id===slug); }

  const rawTriggers=ha.triggers||ha.trigger||[];
  for (const t of (Array.isArray(rawTriggers)?rawTriggers:rawTriggers?[rawTriggers]:[])) {
    const trigPlatform = t.platform || t.trigger || ''; // HA 2024.x uses 'trigger', older uses 'platform'
    if (!t||trigPlatform!=='state') { if(t) warnings.push(`Unsupported trigger: ${trigPlatform||'unknown'}`); continue; }
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
      if (domain==='person') {
        draft.conditions.push({id:uid(),type:'person',entity_ids:eid?[eid]:[],state:c.state||'home'});
      } else if (domain==='device_tracker') {
        draft.conditions.push({id:uid(),type:'device',entity_ids:eid?[eid]:[],state:c.state||'home'});
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
    // Detect unsupported action structures FIRST before trying to parse
    if (a.choose !== undefined) { warnings.push('Unsupported action: choose block — edit in HA directly'); continue; }
    if (a.repeat !== undefined) { warnings.push('Unsupported action: repeat block — edit in HA directly'); continue; }
    if (a.parallel !== undefined) { warnings.push('Unsupported action: parallel block — edit in HA directly'); continue; }
    if (a.sequence !== undefined) { warnings.push('Unsupported action: sequence block — edit in HA directly'); continue; }
    if (a.if !== undefined) { warnings.push('Unsupported action: if block — edit in HA directly'); continue; }
    if (a.delay !== undefined) { warnings.push('Unsupported action: delay — edit in HA directly'); continue; }
    const actionKey=a.action||a.service||'';
    if (!actionKey) { warnings.push(`Unsupported action structure: ${JSON.stringify(a).slice(0,60)}`); continue; }
    const di=actionKey.indexOf('.');
    const domain=di>=0?actionKey.slice(0,di):'';
    const svc=di>=0?actionKey.slice(di+1):'';
    const tids=a.target?.entity_id?(Array.isArray(a.target.entity_id)?a.target.entity_id:[a.target.entity_id]):[];
    if (domain==='siren') draft.actions.push({id:uid(),type:'siren',entity_ids:tids,service:svc});
    else if (domain==='light') draft.actions.push({id:uid(),type:'light',entity_ids_zone:tids,entity_ids_other:[],entity_ids:[],service:svc});
    else if (domain==='notify') draft.actions.push({id:uid(),type:'notify',target:`notify.${svc}`,message:a.data?.message||'',title:a.data?.title||''});
    else if (domain==='alarm_control_panel') draft.actions.push({id:uid(),type:'arm',service:svc,entity_ids:[],entity_id:tids[0]||''});
    else if (domain==='switch' && tids.some(id=>id.includes('overwatch_zone'))) {
      // OW arm/disarm switch action
      draft.actions.push({id:uid(),type:'arm',service:svc,entity_ids:tids,entity_id:''});
    }
    else if (domain==='camera') draft.actions.push({id:uid(),type:'camera',service:svc,entity_ids:tids,service_data:a.data||{}});
    else if (domain==='switch' && tids.some(id=>id.includes('overwatch_camera'))) {
      draft.actions.push({id:uid(),type:'camera_view',entity_ids:tids,service:svc});
    }
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
    door:     {entity_ids:[],state:'on',for_duration:null},
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
    device: {entity_ids:[],state:'home'},
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
    camera_view: {entity_ids:[],service:'turn_on'},
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
  await Promise.all([loadFromHA(), loadHAEntities(), loadDoorPins()]);
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
        <span style="font-size:14px;font-weight:600;">${isNew?'New Automation':'Edit Automation'}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button id="owAutoSaveBtn" style="${btnStyle('#0064d2','rgba(0,100,210,0.18)')}">💾 Save &amp; Push to HA</button>
        <button id="owAutoBackBtn" style="${btnStyle('rgba(255,255,255,0.06)','rgba(255,255,255,0.04)',true)}">← Back</button>
      </div>
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
         <button class="ow-add-btn" data-add-trigger="door">+ Door / Window</button>
         <button class="ow-add-btn" data-add-trigger="person">+ Person</button>
         <button class="ow-add-btn" data-add-trigger="device">+ Device tracker</button>
         <button class="ow-add-btn" data-add-trigger="entity">+ Any entity</button>`
      )}
      ${editorSection('🔀','Conditions','Only if true…','conditions',col.conditions,
        _draft.conditions.map(c=>conditionCard(c)).join('')||emptyStepMsg('No conditions — always runs.'),
        `<button class="ow-add-btn" data-add-cond="time">+ Time of day</button>
         <button class="ow-add-btn" data-add-cond="person">+ Person</button>
         <button class="ow-add-btn" data-add-cond="device">+ Device tracker</button>
         <button class="ow-add-btn" data-add-cond="entity">+ Entity state</button>`
      )}
      ${editorSection('🎯','Actions','Then do this…','actions',col.actions,
        _draft.actions.map((a,i)=>actionCard(a,i,_draft.actions.length)).join('')||emptyStepMsg('No actions yet.'),
        `<button class="ow-add-btn" data-add-action="siren">+ Siren</button>
         <button class="ow-add-btn" data-add-action="light">+ Light</button>
         <button class="ow-add-btn" data-add-action="camera">+ Camera</button>
         <button class="ow-add-btn" data-add-action="notify">+ Notify</button>
         <button class="ow-add-btn" data-add-action="arm">+ Arm/Disarm</button>
         <button class="ow-add-btn" data-add-action="camera_view">+ Camera view</button>
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

  // Wire all searchable list filter inputs (data-scbl-filter) via delegation
  _panelEl.querySelectorAll('[data-scbl-filter]').forEach(inp=>{
    inp.oninput=()=>{
      const q = inp.value.toLowerCase().trim();
      const list = inp.closest('.ow-scbl');
      if (!list) return;
      if (!q) {
        // No filter — restore all items
        list.querySelectorAll('[data-scbl-item]').forEach(r=>r.style.display='');
        return;
      }
      // First pass: mark each item based on whether it or any descendant matches
      // Work bottom-up: sensor labels first, then zone/group/floor wrappers
      const allItems = [...list.querySelectorAll('[data-scbl-item]')];
      // Reset
      allItems.forEach(r=>r.style.display='none');
      // Show items whose own label matches
      allItems.forEach(r=>{
        if (r.dataset.scblLabel?.toLowerCase().includes(q)) {
          r.style.display='';
          // Show all ancestors
          let p = r.parentElement;
          while (p && p !== list) {
            if (p.dataset.scblItem !== undefined || p.hasAttribute('data-scbl-item')) p.style.display='';
            p = p.parentElement;
          }
        }
      });
      // Second pass: show floor/group/zone containers if any child is visible
      // (handles case where a sensor matches but its zone wrapper doesn't have matching label)
      list.querySelectorAll('[data-sg-floor],[data-sg-group],[data-sg-zone],[data-zg-floor],[data-zg-group],[data-zg-zone],[data-dl-floor],[data-dl-group],[data-dl-zone]').forEach(container=>{
        const hasVisible = [...container.querySelectorAll('[data-scbl-item]')].some(c=>c.style.display!=='none'&&c!==container);
        if (hasVisible) container.style.display='';
      });
    };
    inp.onkeydown=e=>e.stopPropagation();
  });
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
  // Set indeterminate state on parent checkboxes after all wiring is done
  requestAnimationFrame(()=>updateIndeterminateStates(_panelEl));

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
  const _fp = (t.for_duration||'').split(':');
  const _fH = _fp[0]||'', _fM = _fp[1]||'', _fS = _fp[2]||'';
  const forField = `
    <div style="margin-top:10px;">
      <label style="${labelStyle}">For duration (optional — trigger only after held this long)</label>
      <div style="display:flex;align-items:center;gap:6px;">
        <div style="flex:1;">
          <input id="trig-for-h-${t.id}" type="number" min="0" max="23" value="${escH(_fH)}"
            placeholder="0" style="${inputStyle}text-align:center;" autocomplete="off"/>
          <div style="font-size:9px;color:#444;text-align:center;margin-top:2px;">Hours</div>
        </div>
        <span style="color:#555;font-size:18px;padding-bottom:14px;">:</span>
        <div style="flex:1;">
          <input id="trig-for-m-${t.id}" type="number" min="0" max="59" value="${escH(_fM)}"
            placeholder="0" style="${inputStyle}text-align:center;" autocomplete="off"/>
          <div style="font-size:9px;color:#444;text-align:center;margin-top:2px;">Minutes</div>
        </div>
        <span style="color:#555;font-size:18px;padding-bottom:14px;">:</span>
        <div style="flex:1;">
          <input id="trig-for-s-${t.id}" type="number" min="0" max="59" value="${escH(_fS)}"
            placeholder="0" style="${inputStyle}text-align:center;" autocomplete="off"/>
          <div style="font-size:9px;color:#444;text-align:center;margin-top:2px;">Seconds</div>
        </div>
      </div>
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

  if (t.type === 'sensor' || t.type === 'door') {
    const isDoor = t.type === 'door';
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">${isDoor ? 'Door / Window sensors from zones' : 'Sensors from zones'}</label>
        ${isDoor ? `<div style="font-size:11px;color:#555;margin-bottom:4px;">Shows only sensors configured in each zone's <strong style="color:#888;">Doors</strong> tab. Add window contact sensors there to include them here.</div>` : ''}
        ${sensorsHierarchicalSelector(
          t.entity_ids||[],
          isDoor ? `trig-door-${t.id}` : `trig-sensor-${t.id}`,
          isDoor ? doorSensorsForZone : null
        )}
      </div>
      <div>
        <label style="${labelStyle}">State</label>
        <select id="trig-${isDoor?'door':'sensor'}state-${t.id}" style="${selectStyle}">
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

  const labels={zone:'Zone Event',zone_arm:'Zone Arm/Disarm',sensor:'Sensor',door:'Door / Window',person:'Person',device:'Device Tracker',entity:'Entity State'};
  return stepCard(t.id, labels[t.type]||t.type, inner, 'trigger');
}

/* ── Zone/Group selector for zone event / zone_arm triggers ── */
function zoneGroupSelector(t, id) {
  const tree = zoneGroupTree();
  const selZones = t.zone_ids||[];
  const selGroups = t.group_ids||[];
  const showSensors = (t.type === 'zone');

  function renderTree() {
    return tree.map(node => {
      if (node.type === 'ungrouped') {
        return node.zones.map(z => zoneRow(z, selZones, selGroups, null, showSensors)).join('');
      }
      if (node.type === 'floor') {
        const fCollapsed = !!_collapsedSteps['zf-' + node.id];
        const fTriggered = node.groups.some(g=>g.triggered) || node.ungrouped.some(z=>zoneTriggered(z));
        const fArmed = node.groups.some(g=>g.armed) || node.ungrouped.some(z=>zoneArmed(z));
        const children = '<div data-ow-children="zf-' + escH(node.id) + '" style="padding-left:8px;' + (fCollapsed?'display:none;':'') + '">' +
          node.groups.map(g => zoneGroupBlock(g, selZones, selGroups, showSensors)).join('') +
          node.ungrouped.map(z => zoneRow(z, selZones, selGroups, null, showSensors)).join('') +
          '</div>';
        return '<div data-zg-floor="' + escH(node.id) + '" data-scbl-item data-scbl-label="' + escH(node.name) + '">' +
          '<div style="display:flex;align-items:center;padding:5px 6px;gap:5px;background:rgba(255,255,255,0.03);border-radius:5px;margin-bottom:2px;">' +
          '<button data-flo-collapse="' + escH(node.id) + '" style="background:none;border:none;color:#666;cursor:pointer;font-size:10px;padding:0 2px;">' + (fCollapsed?'▶':'▼') + '</button>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
          '<input type="checkbox" data-flo-cb="' + escH(node.id) + '" ' + (node.groups.every(g=>g.zones.every(z=>selZones.includes(z.id)))&&node.ungrouped.every(z=>selZones.includes(z.id))?'checked':'') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
          '<span style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.06em;">' + escH(node.name) + '</span>' +
          stateBadge(fTriggered, fArmed) +
          '</label>' +
          '</div>' + children + '</div>';
      }
      return zoneGroupBlock(node, selZones, selGroups, showSensors);
    }).join('');
  }

  return '<div id="' + escH(id) + '" class="ow-scbl" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;">' +
    '<div style="position:relative;border-bottom:1px solid rgba(255,255,255,0.06);">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);opacity:0.35;pointer-events:none;"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2.5"/><path d="M16 16L21 21" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>' +
    '<input type="text" placeholder="Filter zones\u2026" autocomplete="off"' +
    ' style="width:100%;background:none;border:none;color:#ccc;padding:7px 10px 7px 28px;font-size:12px;outline:none;box-sizing:border-box;"' +
    ' data-scbl-filter="1"' +
    '/>' +
    '</div>' +
    '<div style="padding:4px;">' + renderTree() + '</div>' +
    '</div>';
}

function zoneGroupBlock(g, selZones, selGroups, showSensors) {
  const gId = escH(g.id);
  // Collapsed by default unless something is selected inside
  const hasSelection = g.zones.some(z=>selZones.includes(z.id)) || selGroups.includes(g.id);
  const gCollapsed = !hasSelection && (_collapsedSteps['zg-' + g.id] !== false);
  const someSelected = hasSelection;
  const children = '<div data-ow-children="zg-' + gId + '" style="padding-left:16px;' + (gCollapsed?'display:none;':'') + '">' +
    g.zones.map(z => zoneRow(z, selZones, selGroups, g.id, showSensors)).join('') +
    '</div>';
  return '<div data-zg-group="' + gId + '" data-scbl-item data-scbl-label="' + escH(g.name) + '">' +
    '<div style="display:flex;align-items:center;padding:4px 6px;gap:6px;">' +
    '<button data-grp-collapse="' + gId + '" style="background:none;border:none;color:#555;cursor:pointer;font-size:10px;padding:0 2px;flex-shrink:0;">' + (gCollapsed?'▶':'▼') + '</button>' +
    '<label style="display:flex;align-items:center;gap:7px;cursor:pointer;flex:1;">' +
    '<input type="checkbox" data-grp-cb="' + gId + '" ' + (someSelected?'checked':'') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
    '<span style="font-size:12px;font-weight:600;color:#ccc;">' + escH(g.name) + '</span>' +
    stateBadge(g.triggered, g.armed) +
    '</label></div>' + children + '</div>';
}

function zoneRow(z, selZones, selGroups, groupId, showSensors) {
  const zId = escH(z.id);
  const sensors = z.sensors || [];
  const hasSensors = showSensors && sensors.length > 0;
  const zSelected = selZones.includes(z.id);
  // Zones collapsed by default unless selected
  const zCollapsed = hasSensors && !zSelected && (_collapsedSteps['zzr-' + z.id] !== false);
  const state = stateBadge(zoneTriggered(z), zoneArmed(z));
  const expandBtn = hasSensors
    ? '<button data-zone-sensor-collapse="' + zId + '" style="background:none;border:none;color:#444;cursor:pointer;font-size:9px;padding:0 2px;flex-shrink:0;">' + (zCollapsed?'▶':'▼') + '</button>'
    : '<span style="width:14px;flex-shrink:0;"></span>';
  const sensorRows = hasSensors ?
    '<div data-ow-children="zzr-' + zId + '" style="padding-left:20px;border-left:2px solid rgba(255,255,255,0.06);margin-left:6px;' + (zCollapsed?'display:none;':'') + '">' + sensors.map(eid => {
      const fn = (haStates()[eid]?.attributes?.friendly_name) || eid.split('.').pop().replace(/_/g,' ');
      const st = haStates()[eid]?.state;
      return '<label style="display:flex;align-items:center;gap:7px;padding:2px 4px;cursor:pointer;border-radius:4px;" onmouseenter="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseleave="this.style.background=\'\'">' +
        '<input type="checkbox" data-sensor-cb value="' + escH(eid) + '" data-zone-id="' + zId + '" ' + (zSelected ? 'checked' : '') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
        '<span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH(fn) + '</span>' +
        (st !== undefined ? stateBadge(st==='on', null, 'small') : '') +
        '</label>';
    }).join('') + '</div>' : '';
  return '<div data-zg-zone="' + zId + '" data-scbl-item data-scbl-label="' + escH(z.name||z.id) + '">' +
    '<div style="display:flex;align-items:center;padding:4px 6px;gap:6px;">' +
    expandBtn +
    '<label style="display:flex;align-items:center;gap:7px;cursor:pointer;flex:1;">' +
    '<input type="checkbox" data-zone-cb="' + zId + '" data-group-id="' + escH(groupId||'') + '"' + (zSelected?' checked':'') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
    '<span style="font-size:11px;color:#bbb;">' + escH(z.name||z.id) + '</span>' +
    state + '</label></div>' + sensorRows + '</div>';
}


function wireZoneGroupSelector(t, id) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;

  el.querySelectorAll('[data-flo-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();e.preventDefault();const key='zf-'+btn.dataset.floCollapse;const ch=btn.parentElement?.nextElementSibling;const nowC=ch&&ch.style.display==='none';_collapsedSteps[key]=!nowC;if(ch)ch.style.display=nowC?'':'none';btn.textContent=nowC?'▼':'▶';};
  });
  el.querySelectorAll('[data-grp-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();e.preventDefault();const key='zg-'+btn.dataset.grpCollapse;const ch=btn.parentElement?.nextElementSibling;const nowC=ch&&ch.style.display==='none';_collapsedSteps[key]=!nowC;if(ch)ch.style.display=nowC?'':'none';btn.textContent=nowC?'▼':'▶';};
  });
  el.querySelectorAll('[data-zone-sensor-collapse]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();e.preventDefault();const key='zzr-'+btn.dataset.zoneSensorCollapse;const ch=btn.parentElement?.nextElementSibling;const nowC=ch&&ch.style.display==='none';_collapsedSteps[key]=!nowC;if(ch)ch.style.display=nowC?'':'none';btn.textContent=nowC?'▼':'▶';};
  });

  function allZoneCbsIn(c) { return [...c.querySelectorAll('[data-zone-cb]')]; }
  function collectSelections() {
    t.zone_ids  = [...el.querySelectorAll('[data-zone-cb]:checked')].map(cb=>cb.dataset.zoneCb);
    t.group_ids = [...el.querySelectorAll('[data-grp-cb]:checked')]
      .filter(cb=>!cb.indeterminate).map(cb=>cb.dataset.grpCb)
      .filter(gid=>{ const grp=groups().find(g=>g.id===gid); return grp&&(grp.zone_ids||[]).every(zid=>t.zone_ids.includes(zid)); });
  }
  function updateParentsZG(zoneCb) {
    const grpDiv=zoneCb.closest('[data-zg-group]');
    if(grpDiv){const grpCb=grpDiv.querySelector('[data-grp-cb]');if(grpCb){const zc=allZoneCbsIn(grpDiv);const n=zc.filter(c=>c.checked).length;grpCb.indeterminate=n>0&&n<zc.length;if(!grpCb.indeterminate)grpCb.checked=(n===zc.length);}}
    const flDiv=zoneCb.closest('[data-zg-floor]');
    if(flDiv){const flCb=flDiv.querySelector('[data-flo-cb]');if(flCb){const zc=allZoneCbsIn(flDiv);const n=zc.filter(c=>c.checked).length;flCb.indeterminate=n>0&&n<zc.length;if(!flCb.indeterminate)flCb.checked=(n===zc.length);}}
  }
  el.querySelectorAll('[data-flo-cb]').forEach(flCb=>{
    flCb.onchange=()=>{
      const flDiv=flCb.closest('[data-zg-floor]');
      if(flDiv){allZoneCbsIn(flDiv).forEach(zc=>zc.checked=flCb.checked);flDiv.querySelectorAll('[data-grp-cb]').forEach(gc=>{gc.checked=flCb.checked;gc.indeterminate=false;});flDiv.querySelectorAll('[data-sensor-cb]').forEach(sc=>sc.checked=flCb.checked);}
      flCb.indeterminate=false;collectSelections();
    };
  });
  el.querySelectorAll('[data-grp-cb]').forEach(grpCb=>{
    grpCb.onchange=()=>{
      const grpDiv=grpCb.closest('[data-zg-group]');
      if(grpDiv){allZoneCbsIn(grpDiv).forEach(zc=>zc.checked=grpCb.checked);grpDiv.querySelectorAll('[data-sensor-cb]').forEach(sc=>sc.checked=grpCb.checked);}
      grpCb.indeterminate=false;
      const flDiv=grpCb.closest('[data-zg-floor]');
      if(flDiv){const flCb=flDiv.querySelector('[data-flo-cb]');if(flCb){const zc=allZoneCbsIn(flDiv);const n=zc.filter(c=>c.checked).length;flCb.indeterminate=n>0&&n<zc.length;if(!flCb.indeterminate)flCb.checked=(n===zc.length);}}
      collectSelections();
    };
  });
  el.querySelectorAll('[data-zone-cb]').forEach(zoneCb=>{
    zoneCb.onchange=()=>{
      el.querySelectorAll(`[data-sensor-cb][data-zone-id="${CSS.escape(zoneCb.dataset.zoneCb)}"]`).forEach(sc=>sc.checked=zoneCb.checked);
      updateParentsZG(zoneCb);collectSelections();
    };
  });
  el.querySelectorAll('[data-sensor-cb]').forEach(scb=>{
    scb.onchange=()=>{
      const zid=scb.dataset.zoneId;
      const zoneCb=el.querySelector(`[data-zone-cb="${CSS.escape(zid)}"]`);
      if(zoneCb){const s=[...el.querySelectorAll(`[data-sensor-cb][data-zone-id="${CSS.escape(zid)}"]`)];const n=s.filter(c=>c.checked).length;zoneCb.indeterminate=n>0&&n<s.length;if(!zoneCb.indeterminate)zoneCb.checked=n===s.length;updateParentsZG(zoneCb);}
      collectSelections();
    };
  });
  el.querySelectorAll('[data-zone-cb]:checked').forEach(zc=>updateParentsZG(zc));
}


function sensorsHierarchicalSelector(selectedIds, id, overrideSensorsFn) {
  const tree = zoneGroupTree();
  // overrideSensorsFn: optional (zoneId) => [entityId, ...] — REPLACES z.sensors when set
  // Used by door trigger to show only door pin sensors for each zone

  function allSensorsIn(node) {
    function zoneSensors(z) {
      return overrideSensorsFn ? overrideSensorsFn(z.id) : (z.sensors||[]);
    }
    if (node.sensors) return zoneSensors(node); // bare zone
    if (node.type === 'group' || node.zones) return (node.zones||[]).flatMap(z=>zoneSensors(z));
    return [
      ...(node.groups||[]).flatMap(g=>(g.zones||[]).flatMap(z=>zoneSensors(z))),
      ...(node.ungrouped||[]).flatMap(z=>zoneSensors(z))
    ];
  }
  function isFullS(node) { const a=allSensorsIn(node); return a.length>0 && a.every(e=>selectedIds.includes(e)); }
  // Returns true if this zone has any sensors (respects override)
  function zoneHasSensors(z) {
    return overrideSensorsFn ? overrideSensorsFn(z.id).length > 0 : (z.sensors||[]).length > 0;
  }

  function renderSensorZone(z, indent) {
    const zCollapsed = _collapsedSteps['sz-'+z.id] !== false;
    const sensors = overrideSensorsFn ? overrideSensorsFn(z.id) : (z.sensors||[]);
    if (!sensors.length) return '';
    const allSel = sensors.every(e=>selectedIds.includes(e));
    return '<div data-sg-zone="' + escH(z.id) + '" data-scbl-item data-scbl-label="' + escH(z.name||z.id) + '">' +
      '<div style="display:flex;align-items:center;padding:3px 6px;gap:5px;padding-left:' + indent + 'px;">' +
      '<button data-sz-collapse="' + escH(z.id) + '" style="background:none;border:none;color:#444;cursor:pointer;font-size:9px;padding:0 2px;flex-shrink:0;">' + (zCollapsed?'▶':'▼') + '</button>' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
      '<input type="checkbox" data-sz-zone-cb="' + escH(z.id) + '" ' + (allSel?'checked':'') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
      '<span style="font-size:11px;font-weight:600;color:#bbb;">' + escH(z.name||z.id) + '</span>' +
      stateBadge(zoneTriggered(z), zoneArmed(z)) + '</label></div>' +
      '<div data-ow-children="sz-' + escH(z.id) + '" style="padding-left:' + (indent+28) + 'px;' + (zCollapsed?'display:none;':'') + '">' +
      sensors.map(eid => {
        const st = haStates()[eid]?.state;
        const fn = haStates()[eid]?.attributes?.friendly_name || eid.split('.').pop().replace(/_/g,' ');
        return '<label data-scbl-item data-scbl-label="' + escH(fn+' '+eid) + '" style="display:flex;align-items:center;gap:7px;padding:3px 4px;cursor:pointer;border-radius:4px;">' +
          '<input type="checkbox" data-sensor-eid="' + escH(eid) + '" ' + (selectedIds.includes(eid)?'checked':'') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
          '<span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH(fn) + '</span>' +
          (st!==undefined ? stateBadge(st==='on',null,'small') : '') + '</label>';
      }).join('') +
      '</div></div>';
  }

  function renderSensorGroup(g, indent) {
    const gZones = g.zones.filter(z=>zoneHasSensors(z));
    if (!gZones.length) return '';
    const gCollapsed = _collapsedSteps['sg-'+g.id] !== false;
    const full = isFullS(g);
    return '<div data-sg-group="' + escH(g.id) + '" data-scbl-item data-scbl-label="' + escH(g.name) + '">' +
      '<div style="display:flex;align-items:center;padding:4px 6px;gap:5px;padding-left:' + indent + 'px;">' +
      '<button data-sg-collapse="' + escH(g.id) + '" style="background:none;border:none;color:#555;cursor:pointer;font-size:10px;padding:0 2px;flex-shrink:0;">' + (gCollapsed?'▶':'▼') + '</button>' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
      '<input type="checkbox" data-sg-grp-cb="' + escH(g.id) + '" ' + (full?'checked':'') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
      '<span style="font-size:12px;font-weight:600;color:#ccc;">' + escH(g.name) + '</span>' +
      stateBadge(g.triggered, g.armed) + '</label></div>' +
      '<div data-ow-children="sg-' + escH(g.id) + '"' + (gCollapsed?' style="display:none"':'') + '>' +
      gZones.map(z=>renderSensorZone(z, indent+16)).join('') +
      '</div></div>';
  }

  const body = tree.map(node => {
    if (node.type === 'floor') {
      const fCollapsed = !!_collapsedSteps['sf-'+node.id];
      const flGrps = (node.groups||[]).filter(g=>g.zones.some(z=>zoneHasSensors(z)));
      const flUng  = (node.ungrouped||[]).filter(z=>zoneHasSensors(z));
      if (!flGrps.length && !flUng.length) return '';
      const full = isFullS(node);
      const childHtml = flGrps.map(g=>renderSensorGroup(g,16)).join('') + flUng.map(z=>renderSensorZone(z,16)).join('');
      return '<div data-sg-floor="' + escH(node.id) + '" data-scbl-item data-scbl-label="' + escH(node.name) + '">' +
        '<div style="display:flex;align-items:center;padding:5px 6px;gap:5px;background:rgba(255,255,255,0.03);border-radius:4px;margin-bottom:2px;">' +
        '<button data-sf-collapse="' + escH(node.id) + '" style="background:none;border:none;color:#666;cursor:pointer;font-size:10px;padding:0 2px;flex-shrink:0;">' + (fCollapsed?'▶':'▼') + '</button>' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
        '<input type="checkbox" data-sf-cb="' + escH(node.id) + '" ' + (full?'checked':'') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
        '<span style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.06em;">' + escH(node.name) + '</span>' +
        '</label></div>' +
        '<div data-ow-children="sf-' + escH(node.id) + '"' + (fCollapsed?' style="display:none"':'') + '>' + childHtml + '</div></div>';
    }
    if (node.type === 'group')     return renderSensorGroup(node, 16);
    if (node.type === 'ungrouped') return (node.zones||[]).filter(z=>zoneHasSensors(z)).map(z=>renderSensorZone(z,16)).join('');
    return '';
  }).join('');

  return `<div id="${escH(id)}" class="ow-scbl" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;">
    <div style="position:relative;border-bottom:1px solid rgba(255,255,255,0.06);">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);opacity:0.35;pointer-events:none;"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2.5"/><path d="M16 16L21 21" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
      <input type="text" placeholder="Filter sensors…" autocomplete="off"
        style="width:100%;background:none;border:none;color:#ccc;padding:7px 10px 7px 28px;font-size:12px;outline:none;box-sizing:border-box;"
        data-scbl-filter="1"/>
    </div>
    <div style="padding:4px;">${body||'<div style="color:#555;font-size:11px;padding:6px;">No sensors found in zones.</div>'}</div>
  </div>`;
}

function wireSensorHierarchicalSelector(id, fn) {
  const el = _panelEl?.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;

  // ── Collapse buttons ──────────────────────────────────────
  [['[data-sf-collapse]','sf-'],['[data-sg-collapse]','sg-'],['[data-sz-collapse]','sz-']].forEach(([sel,pfx])=>{
    el.querySelectorAll(sel).forEach(btn=>{
      btn.onclick=e=>{
        e.stopPropagation();e.preventDefault();
        const rawId=btn.dataset.sfCollapse||btn.dataset.sgCollapse||btn.dataset.szCollapse;
        const key=pfx+rawId;
        const ch=btn.parentElement?.nextElementSibling;
        const nowC=ch&&ch.style.display==='none';
        _collapsedSteps[key]=!nowC;
        if(ch)ch.style.display=nowC?'':'none';
        btn.textContent=nowC?'▼':'▶';
      };
    });
  });

  // ── Helpers ───────────────────────────────────────────────
  function collect() { return [...el.querySelectorAll('input[data-sensor-eid]:checked')].map(c=>c.dataset.sensorEid); }

  function updateParentsS(startEl) {
    const zDiv  = startEl.closest('[data-sg-zone]');
    const gDiv  = startEl.closest('[data-sg-group]');
    const fDiv  = startEl.closest('[data-sg-floor]');
    [
      [zDiv,  '[data-sz-zone-cb]'],
      [gDiv,  '[data-sg-grp-cb]'],
      [fDiv,  '[data-sf-cb]'],
    ].forEach(([div, cbSel]) => {
      if (!div) return;
      const cb = div.querySelector(cbSel);
      if (!cb) return;
      const total = [...div.querySelectorAll('input[data-sensor-eid]')].length;
      const n     = [...div.querySelectorAll('input[data-sensor-eid]:checked')].length;
      cb.indeterminate = n > 0 && n < total;
      if (!cb.indeterminate) cb.checked = (n === total);
    });
  }

  // ── Floor ─────────────────────────────────────────────────
  el.querySelectorAll('[data-sf-cb]').forEach(flCb=>{
    flCb.onchange=()=>{
      const fDiv=flCb.closest('[data-sg-floor]');
      if(fDiv) {
        fDiv.querySelectorAll('input[data-sensor-eid]').forEach(c=>c.checked=flCb.checked);
        fDiv.querySelectorAll('[data-sg-grp-cb],[data-sz-zone-cb]').forEach(c=>{c.checked=flCb.checked;c.indeterminate=false;});
      }
      flCb.indeterminate=false;
      fn(collect());
    };
  });

  // ── Group ─────────────────────────────────────────────────
  el.querySelectorAll('[data-sg-grp-cb]').forEach(grpCb=>{
    grpCb.onchange=()=>{
      const gDiv=grpCb.closest('[data-sg-group]');
      if(gDiv) {
        gDiv.querySelectorAll('input[data-sensor-eid]').forEach(c=>c.checked=grpCb.checked);
        gDiv.querySelectorAll('[data-sz-zone-cb]').forEach(c=>{c.checked=grpCb.checked;c.indeterminate=false;});
      }
      grpCb.indeterminate=false;
      updateParentsS(grpCb);
      fn(collect());
    };
  });

  // ── Zone ──────────────────────────────────────────────────
  el.querySelectorAll('[data-sz-zone-cb]').forEach(zCb=>{
    zCb.onchange=()=>{
      const zDiv=zCb.closest('[data-sg-zone]');
      if(zDiv) zDiv.querySelectorAll('input[data-sensor-eid]').forEach(c=>c.checked=zCb.checked);
      zCb.indeterminate=false;
      updateParentsS(zCb);
      fn(collect());
    };
  });

  // ── Individual sensor ─────────────────────────────────────
  el.querySelectorAll('input[data-sensor-eid]').forEach(sCb=>{
    sCb.onchange=()=>{ updateParentsS(sCb); fn(collect()); };
  });

  // Initial indeterminate
  el.querySelectorAll('input[data-sensor-eid]:checked').forEach(c=>updateParentsS(c));
}


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
    const persons = entitiesByDomain('person');
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Person</label>
        ${persons.length
          ? searchableCheckboxList(c.entity_ids||[], persons, `cond-person-${c.id}`)
          : entityAutocomplete(`cond-person-ac-${c.id}`, c.entity_ids?.[0]||'', 'person.*', null, ['person'])}
      </div>
      <div>
        <label style="${labelStyle}">Must be in state</label>
        <select id="cond-person-state-${c.id}" style="${selectStyle}">
          <option value="home"     ${c.state==='home'    ?'selected':''}>Home</option>
          <option value="not_home" ${c.state==='not_home'?'selected':''}>Away (not home)</option>
        </select>
      </div>`;
  }
  if (c.type === 'device') {
    const trackers = entitiesByDomain('device_tracker');
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Device Tracker</label>
        ${trackers.length
          ? searchableCheckboxList(c.entity_ids||[], trackers, `cond-device-${c.id}`)
          : entityAutocomplete(`cond-device-ac-${c.id}`, c.entity_ids?.[0]||'', 'device_tracker.*', null, ['device_tracker'])}
      </div>
      <div>
        <label style="${labelStyle}">Must be in state</label>
        <select id="cond-device-state-${c.id}" style="${selectStyle}">
          <option value="home"     ${c.state==='home'    ?'selected':''}>Home</option>
          <option value="not_home" ${c.state==='not_home'?'selected':''}>Away (not home)</option>
        </select>
      </div>`;
  }
  const labels = {time:'Time of Day', entity:'Entity State', person:'Person', device:'Device Tracker'};
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
    const sirenTree = sirensByGroupZone();
    const zoneSirenIds = new Set(zones().flatMap(z=>z.sirens||[]));
    const extraSirens = sirenEntities().filter(e=>!zoneSirenIds.has(e.entity_id));
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Sirens</label>
        ${sirenTree.length ? deviceActionTree(sirenTree, a.entity_ids||[], `act-sirens-${a.id}`) : '<div style="color:#555;font-size:11px;margin-bottom:6px;">No sirens in zones.</div>'}
        ${extraSirens.length ? `<div style="margin-top:6px;"><label style="${labelStyle}">Other sirens</label>${searchableCheckboxList(a.entity_ids_extra||[],extraSirens,`act-sirens-extra-${a.id}`)}</div>` : ''}
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
      ${tree.length ? deviceActionTree(tree, a.entity_ids_zone||[], `act-light-${a.id}`) : ''}
      ${otherLights.length ? '<div style="margin-bottom:10px;">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
        '<button id="act-light-other-toggle-' + escH(a.id) + '" style="background:none;border:1px solid rgba(255,255,255,0.1);border-radius:5px;color:#555;cursor:pointer;font-size:11px;padding:2px 8px;">▶ Other lights from HA (' + otherLights.length + ')</button>' +
        '</div>' +
        '<div id="act-light-other-wrap-' + escH(a.id) + '" style="display:none;max-height:180px;overflow-y:auto;border-radius:8px;">' +
        searchableCheckboxList([...new Set([...(a.entity_ids_other||[]), ...(a.entity_ids_zone||[]).filter(id=>otherLights.some(l=>l.entity_id===id))])], otherLights, 'act-light-other-' + a.id) +
        '</div></div>' : ''}
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
    // #7: Remove turn_on/turn_off — not real camera functions
    const baseServices = [
      {name:'snapshot', description:'Take a snapshot'},
      {name:'record',   description:'Start recording'},
    ];
    const baseNames = new Set(baseServices.map(s=>s.name));
    const mergedServices = [...baseServices, ...camServices.filter(s=>!baseNames.has(s.name)&&s.name!=='turn_on'&&s.name!=='turn_off')];
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Cameras</label>
        ${camTree.length ? deviceActionTree(camTree, a.entity_ids||[], `act-cam-${a.id}`) : `<div style="color:#555;font-size:11px;margin-bottom:6px;">No cameras in zones — search HA:</div>${entityAutocomplete(`act-cam-ac-${a.id}`,a.entity_ids?.[0]||'','camera.*',null,['camera'])}`}
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
    // Build OW zone arm switches from zone/group hierarchy
    const armTree = zoneGroupTree();
    // Also include master switch if it exists
    const masterSwitch = allEntities().find(e=>e.entity_id==='switch.overwatch_master');

    function buildArmRows(tree) {
      let rows = '';
      if (masterSwitch) {
        const isSel = (a.entity_ids||[]).includes(masterSwitch.entity_id);
        rows += '<label style="display:flex;align-items:center;gap:8px;padding:5px 6px;cursor:pointer;border-radius:5px;background:rgba(255,255,255,0.04);margin-bottom:4px;">' +
          '<input type="checkbox" data-arm-cb value="' + escH(masterSwitch.entity_id) + '" ' + (isSel?'checked':'') + ' style="accent-color:#0064d2;">' +
          '<span style="font-size:12px;font-weight:600;color:#ccc;">All Zones (master)</span>' +
          stateBadge(false, masterSwitch.state==='on') + '</label>';
      }
      tree.forEach(node=>{
        if (node.type==='floor') {
          const fCollapsed = !!_collapsedSteps['armf-'+node.id];
          const allFloorEids = [
            ...(node.groups||[]).map(g=>'switch.overwatch_zone_group_'+(nameSlug(g.name)||g.id)),
            ...(node.ungrouped||[]).map(z=>'switch.overwatch_zone_'+(nameSlug(z.name)||z.id)),
          ];
          const fAllSel = allFloorEids.length && allFloorEids.every(e=>(a.entity_ids||[]).includes(e));
          rows += '<div>' +
            '<div style="display:flex;align-items:center;gap:5px;padding:4px 6px;background:rgba(255,255,255,0.03);border-radius:4px;margin-bottom:2px;">' +
            '<button data-armf-collapse="' + escH(node.id) + '" style="background:none;border:none;color:#666;cursor:pointer;font-size:10px;padding:0 2px;">' + (fCollapsed?'▶':'▼') + '</button>' +
            '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
            '<input type="checkbox" data-armf-cb value="' + escH(node.id) + '" ' + (fAllSel?'checked':'') + ' style="accent-color:#0064d2;flex-shrink:0;">' +
            '<span style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.06em;">' + escH(node.name) + '</span>' +
            '</label></div>';
          const armFlCh = (node.groups||[]).map(g=>buildGroupArmRow(g,12,node.id)).join('')+(node.ungrouped||[]).map(z=>buildZoneArmRow(z,12)).join('');
          rows += '<div data-ow-children="armf-' + escH(node.id) + '"' + (fCollapsed?' style="display:none"':'') + '>' + armFlCh + '</div>';
          rows += '</div>';
        } else if (node.type==='group') {
          rows += buildGroupArmRow(node, 6, null);
        } else if (node.type==='ungrouped') {
          (node.ungrouped||node.zones||[]).forEach(z=>{ rows += buildZoneArmRow(z, 6); });
        }
      });
      return rows;
    }
    function buildGroupArmRow(g, indent, floorId) {
      indent = indent || 6;
      const slug = nameSlug(g.name)||g.id;
      const geid = 'switch.overwatch_zone_group_' + slug;
      const isSel = (a.entity_ids||[]).includes(geid);
      const gKey = 'armg-'+g.id+(floorId?'-'+floorId:'');
      const armGroupKey = g.id+(floorId?'-'+floorId:'');
      const gC = _collapsedSteps[gKey] !== false; // collapsed by default
      const memberZones = (g.zones||[]);
      // Compute partial: some zones checked but not group switch itself
      const zoneEids = memberZones.map(z=>'switch.overwatch_zone_'+(nameSlug(z.name)||z.id));
      const checkedZones = zoneEids.filter(e=>(a.entity_ids||[]).includes(e)).length;
      const zoneRows = memberZones.map(z=>buildZoneArmRow(z, indent, armGroupKey)).join('');
      return '<div data-arm-group="'+escH(armGroupKey)+'">' +
        '<div style="display:flex;align-items:center;gap:5px;padding:3px 6px;padding-left:'+indent+'px;">' +
        (memberZones.length ? '<button data-armg-collapse="'+escH(gKey)+'" style="background:none;border:none;color:#555;cursor:pointer;font-size:9px;padding:0 2px;">'+(gC?'▶':'▼')+'</button>' : '<span style="width:14px;flex-shrink:0;"></span>') +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
        '<input type="checkbox" data-arm-grp-cb="'+escH(armGroupKey)+'" data-arm-grp-eid="'+escH(geid)+'" '+( isSel?'checked':'')+' style="accent-color:#0064d2;flex-shrink:0;">' +
        '<span style="font-size:12px;font-weight:600;color:#ccc;">' + escH(g.name) + '</span>' +
        stateBadge(g.triggered, g.armed) +
        '</label></div>' +
        '<div data-ow-children="'+escH(gKey)+'"' + (gC?' style="display:none"':'') + '>' + zoneRows + '</div>' +
        '</div>';
    }
    function buildZoneArmRow(z, groupIndent, groupId) {
      // indent: same as group, then add spacer for button + extra step
      const indent = groupIndent || 6;
      const slug = nameSlug(z.name)||z.id;
      const eid = 'switch.overwatch_zone_' + slug;
      const isSel = (a.entity_ids||[]).includes(eid);
      // padding-left = group indent + 14px (button) + 10px (step) = indent+24
      return '<div style="display:flex;align-items:center;padding:2px 6px;padding-left:'+(indent+14)+'px;">' +
        '<span style="width:14px;flex-shrink:0;"></span>' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
        '<input type="checkbox" data-arm-zone-cb="'+escH(eid)+'" data-arm-group-id="'+escH(groupId||'')+'" '+( isSel?'checked':'')+' style="accent-color:#0064d2;flex-shrink:0;">' +
        '<span style="font-size:11px;color:#bbb;">' + escH(z.name||z.id) + '</span>' +
        stateBadge(zoneTriggered(z), zoneArmed(z)) +
        '</label></div>';
    }

    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Zone / Group switches</label>
        <div id="act-arm-zones-${a.id}" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px;">
          ${buildArmRows(armTree)||'<div style="color:#555;font-size:11px;">No OW zone switches found.</div>'}
        </div>
      </div>
      <div>
        <label style="${labelStyle}">Action</label>
        <select id="act-arm-svc-${a.id}" style="${selectStyle}">
          <option value="turn_on"  ${a.service==='turn_on' ||!a.service?'selected':''}>Arm (turn on)</option>
          <option value="turn_off" ${a.service==='turn_off'?'selected':''}>Disarm (turn off)</option>
          <option value="toggle"   ${a.service==='toggle'  ?'selected':''}>Toggle</option>
        </select>
      </div>`;
  }

  if (a.type === 'camera_view') {
    // OW camera view switches - show using hierarchy from zone tree  
    const camViewAll = allEntities().filter(e=>e.entity_id.startsWith('switch.overwatch_camera_')).sort((a,b)=>a.entity_id.localeCompare(b.entity_id));
    // Build tree: floor switches → group switches → zone switches → individual camera switches
    const camViewByFloor = [];
    const floors2 = ow().floors||[];
    if (floors2.length) {
      floors2.forEach(f=>{
        const floorSw = camViewAll.find(e=>e.entity_id===`switch.overwatch_camera_floor_${nameSlug(f.name)||f.id}`);
        const groups2 = groups().filter(g=>(g.zone_ids||[]).some(zid=>{const z=zones().find(z=>z.id===zid);return z&&(!z.floor_id||z.floor_id===f.id);}));
        const groupRows = groups2.map(g=>{
          const gsw = camViewAll.find(e=>e.entity_id===`switch.overwatch_camera_group_${nameSlug(g.name)||g.id}`);
          const gZones=(g.zone_ids||[]).map(id=>zones().find(z=>z.id===id)).filter(z=>z&&(!z.floor_id||z.floor_id===f.id));
          return {type:'group',id:g.id,name:g.name,sw:gsw,zones:gZones};
        });
        camViewByFloor.push({name:f.name,id:f.id,sw:floorSw,groups:groupRows});
      });
    }
    const masterSw = camViewAll.find(e=>e.entity_id==='switch.overwatch_camera_all');
    inner = `
      <div style="margin-bottom:10px;">
        <label style="${labelStyle}">Camera views (HA-Overwatch switches)</label>
        <div id="act-camview-zones-${a.id}" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:6px;">
          ${masterSw ? `<label style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:4px;background:rgba(255,255,255,0.04);margin-bottom:4px;"><input type="checkbox" data-camview-cb value="${escH(masterSw.entity_id)}" ${(a.entity_ids||[]).includes(masterSw.entity_id)?'checked':''} style="accent-color:#0064d2;"><span style="font-size:12px;font-weight:600;color:#ccc;">All cameras (master)</span></label>` : ''}
          ${camViewByFloor.map(fl=>{
            const fCollapsed=!!_collapsedSteps['cvf-'+fl.id];
            const flSwEntity=fl.sw?.entity_id;
            const fAllSel=flSwEntity&&(a.entity_ids||[]).includes(flSwEntity);
            const groupsHtml=fl.groups.map(g=>{
              const gSel=(a.entity_ids||[]).includes(g.sw?.entity_id);
              const gC=_collapsedSteps['cvg-'+fl.id+'-'+g.id]!==false;
              const zonesSw=g.zones.map(z=>{
                const zSw=camViewAll.find(e=>e.entity_id==='switch.overwatch_camera_zone_'+(nameSlug(z.name)||z.id));
                const zSel=(a.entity_ids||[]).includes(zSw?.entity_id);
                return zSw?'<div style="display:flex;align-items:center;padding:2px 6px 2px 22px;"><span style="width:12px;flex-shrink:0;"></span><label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;"><input type="checkbox" data-camview-cb value="'+escH(zSw.entity_id)+'" '+(zSel?'checked':'')+' style="accent-color:#0064d2;"><span style="font-size:11px;color:#bbb;">'+escH(z.name||z.id)+'</span></label></div>':'';
              }).join('');
              return '<div>' +
                '<div style="display:flex;align-items:center;gap:5px;padding:2px 6px 2px 12px;">' +
                (g.zones.length?'<button data-cvg-collapse="'+escH(fl.id+'-'+g.id)+'" style="background:none;border:none;color:#555;cursor:pointer;font-size:9px;padding:0 2px;">'+(gC?'▶':'▼')+'</button>':'<span style="width:12px;"></span>')+
                '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">'+(g.sw?'<input type="checkbox" data-camview-cb value="'+escH(g.sw.entity_id)+'" '+(gSel?'checked':'')+' style="accent-color:#0064d2;">':'')+
                '<span style="font-size:11px;font-weight:600;color:#ccc;">'+escH(g.name)+'</span></label></div>' +
                '<div data-ow-children="cvg-'+escH(fl.id+'-'+g.id)+'"'+(gC?' style="display:none"':'')+'>' + zonesSw + '</div></div>';
            }).join('');
            // All camview entities on this floor (floor switch + group switches)
            const allFlCamEids=[flSwEntity,...fl.groups.map(g=>g.sw?.entity_id)].filter(Boolean);
            const cvfAllSel=allFlCamEids.length&&allFlCamEids.every(e=>(a.entity_ids||[]).includes(e));
            return '<div>' +
              '<div style="display:flex;align-items:center;gap:5px;padding:3px 6px;background:rgba(255,255,255,0.03);border-radius:4px;margin-bottom:2px;">' +
              '<button data-cvf-collapse="'+escH(fl.id)+'" style="background:none;border:none;color:#666;cursor:pointer;font-size:10px;padding:0 2px;">'+(fCollapsed?'▶':'▼')+'</button>' +
              '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
              '<input type="checkbox" data-cvfall-cb="'+escH(fl.id)+'" '+( cvfAllSel?'checked':'')+' style="accent-color:#0064d2;flex-shrink:0;">' +
              '<span style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.06em;">'+escH(fl.name)+'</span>' +
              (flSwEntity?'<span style="font-size:10px;color:#444;margin-left:4px;">floor switch</span>':'') +
              '</label></div>' +
              '<div data-ow-children="cvf-'+escH(fl.id)+'"'+(fCollapsed?' style="display:none"':'')+'>' + groupsHtml + '</div></div>';
          }).join('')}
          ${!camViewByFloor.length && !masterSw ? '<div style="color:#555;font-size:11px;">No OW camera view switches found.</div>' : ''}
        </div>
      </div>
      <div>
        <label style="${labelStyle}">Action</label>
        <select id="act-camview-svc-${a.id}" style="${selectStyle}">
          <option value="turn_on"  ${a.service==='turn_on' ||!a.service?'selected':''}>Turn ON (show cameras)</option>
          <option value="turn_off" ${a.service==='turn_off'?'selected':''}>Turn OFF (hide cameras)</option>
          <option value="toggle"   ${a.service==='toggle'  ?'selected':''}>Toggle</option>
        </select>
      </div>`;
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

  const labels={siren:'Siren',light:'Light',camera:'Camera',camera_view:'Camera View',notify:'Notify',arm:'Arm/Disarm',entity:'Other Entity'};
  return stepCard(a.id, labels[a.type]||a.type, inner, 'action', moveControls);
}

/* ════════════════════════════════════════════════════════════
 * UNIFIED DEVICE ACTION TREE (lights / cameras)
 * Same floor→group→zone hierarchy as zone selector.
 * deviceKey: for wiring callbacks ('entity_ids_zone' or 'entity_ids')
 * ═══════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════
 * UNIFIED DEVICE ACTION TREE  — render + wire
 *
 * Consistent hierarchy: Floor > Group > Zone > Device
 * Consistent indentation: INDENT_BASE + depth * INDENT_STEP
 * Consistent cascade & indeterminate on all levels
 * One function pair used by Sirens, Lights, Cameras
 * ═══════════════════════════════════════════════════════════ */
const TREE_BASE  = 4;   // px left-padding for floor header
const TREE_STEP  = 16;  // px indent per depth level

function deviceActionTree(tree, selectedIds, baseId) {

  function allDevIds(node) {
    // Collect all device entity_ids under this node
    if (node.devices)     return node.devices.map(d=>d.entity_id);
    if (node.zones)       return node.zones.flatMap(z=>(z.devices||[]).map(d=>d.entity_id));
    const grpDevs = (node.groups||[]).flatMap(g=>(g.zones||[]).flatMap(z=>(z.devices||[]).map(d=>d.entity_id)));
    const ungDevs = (node.ungrouped||[]).flatMap(z=>(z.devices||[]).map(d=>d.entity_id));
    return [...grpDevs,...ungDevs];
  }
  function isFull(node)    { const ids=allDevIds(node); return ids.length>0 && ids.every(id=>selectedIds.includes(id)); }
  function isPartial(node) { const ids=allDevIds(node); return ids.some(id=>selectedIds.includes(id)); }

  function collapseBtn(key, dataAttr, collapsed, extraData) {
    return '<button '+dataAttr+'="'+key+'"'+(extraData||'')+' style="flex-shrink:0;background:none;border:none;color:#666;cursor:pointer;font-size:10px;padding:0 2px;line-height:1;">'+(collapsed?'▶':'▼')+'</button>';
  }

  function renderDevice(d, depth) {
    const pad = TREE_BASE + depth * TREE_STEP;
    const sel = selectedIds.includes(d.entity_id);
    return '<div style="display:flex;align-items:center;gap:6px;padding:2px 6px;padding-left:'+pad+'px;">' +
      '<span style="flex-shrink:0;width:14px;"></span>' + // spacer aligns with buttons above
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
      '<input type="checkbox" data-dl-cb="'+escH(d.entity_id)+'" data-base-id="'+escH(baseId)+'" '+(sel?'checked':'')+' style="accent-color:#0064d2;flex-shrink:0;">' +
      '<span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escH(d.name)+'</span>' +
      (d.state!==undefined?stateBadge(d.state==='on',null,'small'):'') +
      '</label></div>';
  }

  function renderZone(zone, depth) {
    const pad = TREE_BASE + depth * TREE_STEP;
    const key = 'dlz-'+zone.id+'-'+baseId;
    const collapsed = _collapsedSteps[key] !== false;
    const full = isFull(zone), part = isPartial(zone);
    const devHtml = (zone.devices||[]).map(d=>renderDevice(d, depth+1)).join('');
    return '<div data-dl-zone="'+escH(zone.id)+'" data-base-id="'+escH(baseId)+'">' +
      '<div style="display:flex;align-items:center;gap:5px;padding:2px 6px;padding-left:'+pad+'px;">' +
      (zone.devices?.length ? collapseBtn(key,'data-dlz-collapse',collapsed,' data-base-id="'+escH(baseId)+'"') : '<span style="flex-shrink:0;width:14px;"></span>') +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
      '<input type="checkbox" data-dlz-cb="'+escH(zone.id)+'" data-base-id="'+escH(baseId)+'" '+(full?'checked':'')+' style="accent-color:#0064d2;flex-shrink:0;">' +
      '<span style="font-size:11px;color:#bbb;">'+escH(zone.name||zone.id)+'</span>' +
      stateBadge(zoneTriggered(zone),zoneArmed(zone)) +
      '</label></div>' +
      '<div data-ow-children="'+escH(key)+'"'+(collapsed?' style="display:none"':'')+'>'+devHtml+'</div>' +
      '</div>';
  }

  function renderGroup(g, depth) {
    const pad = TREE_BASE + depth * TREE_STEP;
    const key = 'dlg-'+g.id+'-'+baseId;
    const collapsed = _collapsedSteps[key] !== false;
    const full = isFull(g), part = isPartial(g);
    const zonesHtml = (g.zones||[]).map(z=>renderZone(z, depth+1)).join('');
    return '<div data-dl-group="'+escH(g.id)+'" data-base-id="'+escH(baseId)+'">' +
      '<div style="display:flex;align-items:center;gap:5px;padding:3px 6px;padding-left:'+pad+'px;">' +
      ((g.zones?.length) ? collapseBtn(key,'data-dlg-collapse',collapsed,' data-base-id="'+escH(baseId)+'"') : '<span style="flex-shrink:0;width:14px;"></span>') +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
      '<input type="checkbox" data-dlg-cb="'+escH(g.id)+'" data-base-id="'+escH(baseId)+'" '+(full?'checked':'')+' style="accent-color:#0064d2;flex-shrink:0;">' +
      '<span style="font-size:12px;font-weight:600;color:#ccc;">'+escH(g.name||g.id)+'</span>' +
      stateBadge(g.triggered,g.armed) +
      '</label></div>' +
      '<div data-ow-children="'+escH(key)+'"'+(collapsed?' style="display:none"':'')+'>'+zonesHtml+'</div>' +
      '</div>';
  }

  function renderFloor(f, depth) {
    const pad = TREE_BASE;
    const key = 'dlf-'+f.id+'-'+baseId;
    const collapsed = !!_collapsedSteps[key]; // floors expanded by default
    const full = isFull(f), part = isPartial(f);
    const groupsHtml = (f.groups||[]).map(g=>renderGroup(g, depth+1)).join('');
    const ungroupedHtml = (f.ungrouped||[]).map(z=>renderZone(z, depth+1)).join('');
    return '<div data-dl-floor="'+escH(f.id)+'" data-base-id="'+escH(baseId)+'">' +
      '<div style="display:flex;align-items:center;gap:5px;padding:4px 6px;padding-left:'+pad+'px;background:rgba(255,255,255,0.03);border-radius:4px;margin-bottom:2px;">' +
      collapseBtn(key,'data-dlf-collapse',collapsed,' data-base-id="'+escH(baseId)+'"') +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">' +
      '<input type="checkbox" data-dlf-cb="'+escH(f.id)+'" data-base-id="'+escH(baseId)+'" '+(full?'checked':'')+' style="accent-color:#0064d2;flex-shrink:0;">' +
      '<span style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.06em;">'+escH(f.name||f.id)+'</span>' +
      stateBadge(f.triggered,f.armed) +
      '</label></div>' +
      '<div data-ow-children="'+escH(key)+'"'+(collapsed?' style="display:none"':'')+'>'+groupsHtml+ungroupedHtml+'</div>' +
      '</div>';
  }

  function renderNode(node, depth) {
    if (node.type==='floor')     return renderFloor(node, depth);
    if (node.type==='group')     return renderGroup(node, depth);
    if (node.type==='ungrouped') return (node.zones||[]).map(z=>renderZone(z, depth)).join('');
    return renderZone(node, depth); // bare zone
  }

  return '<div style="margin-bottom:10px;">'+tree.map(n=>renderNode(n,0)).join('')+'</div>';
}

function wireDeviceActionTree(selectedIds, onUpdate, baseId) {
  const el = _panelEl;
  if (!el) return;
  const esc = CSS.escape.bind(CSS);

  // ── Collapse buttons (all levels) ──────────────────────────
  function wireCollapse(selector, keyFn) {
    el.querySelectorAll(selector+'[data-base-id="'+baseId+'"]').forEach(btn=>{
      btn.onclick = e => {
        e.stopPropagation(); e.preventDefault();
        const key = keyFn(btn);
        const ch = btn.parentElement?.nextElementSibling;
        const nowCollapsed = ch && ch.style.display==='none';
        _collapsedSteps[key] = !nowCollapsed;
        if (ch) ch.style.display = nowCollapsed ? '' : 'none';
        btn.textContent = nowCollapsed ? '▼' : '▶';
      };
    });
  }
  wireCollapse('[data-dlf-collapse]', btn => 'dlf-'+btn.dataset.dlfCollapse+'-'+baseId);
  wireCollapse('[data-dlg-collapse]', btn => 'dlg-'+btn.dataset.dlgCollapse+'-'+baseId);
  wireCollapse('[data-dlz-collapse]', btn => 'dlz-'+btn.dataset.dlzCollapse+'-'+baseId);

  // ── Helpers ─────────────────────────────────────────────────
  function devCbs()  { return [...el.querySelectorAll('[data-dl-cb][data-base-id="'+baseId+'"]')]; }
  function collectIds() { return devCbs().filter(c=>c.checked).map(c=>c.dataset.dlCb); }

  // Find all device checkboxes within a container element
  function devsIn(containerEl) {
    return [...containerEl.querySelectorAll('[data-dl-cb][data-base-id="'+baseId+'"]')];
  }

  // Given a device checkbox, find its zone/group/floor checkboxes by DOM traversal
  function parentsOf(devCb) {
    const zoneDiv  = devCb.closest('[data-dl-zone][data-base-id="'+baseId+'"]');
    const groupDiv = devCb.closest('[data-dl-group][data-base-id="'+baseId+'"]');
    const floorDiv = devCb.closest('[data-dl-floor][data-base-id="'+baseId+'"]');
    return {
      zoneCb:  zoneDiv  ? zoneDiv.querySelector('[data-dlz-cb][data-base-id="'+baseId+'"]')  : null,
      groupCb: groupDiv ? groupDiv.querySelector(':scope > div > label > [data-dlg-cb][data-base-id="'+baseId+'"]') : null,
      floorCb: floorDiv ? floorDiv.querySelector(':scope > div > label > [data-dlf-cb][data-base-id="'+baseId+'"]') : null,
    };
  }

  function updateParents(startCb) {
    // Walk up from a checkbox and set indeterminate/checked on each ancestor level
    const {zoneCb, groupCb, floorCb} = parentsOf(startCb);
    [zoneCb, groupCb, floorCb].forEach(cb => {
      if (!cb) return;
      const container = cb.closest('[data-dl-zone],[data-dl-group],[data-dl-floor]');
      if (!container) return;
      const children = devsIn(container);
      if (!children.length) return;
      const n = children.filter(c=>c.checked).length;
      cb.indeterminate = n > 0 && n < children.length;
      if (!cb.indeterminate) cb.checked = (n === children.length);
    });
    // Also update zone-level group parent if zone changed
    if (zoneCb && groupCb) {
      const groupContainer = groupCb.closest('[data-dl-group]');
      if (groupContainer) {
        const zoneCbs = [...groupContainer.querySelectorAll('[data-dlz-cb][data-base-id="'+baseId+'"]')];
        const n = zoneCbs.filter(c=>c.checked&&!c.indeterminate).length;
        const partial = zoneCbs.filter(c=>c.checked||c.indeterminate).length;
        groupCb.indeterminate = partial>0 && (n<zoneCbs.length || zoneCbs.some(c=>c.indeterminate));
        if (!groupCb.indeterminate) groupCb.checked = n===zoneCbs.length;
      }
    }
  }

  // ── Floor checkboxes ────────────────────────────────────────
  el.querySelectorAll('[data-dlf-cb][data-base-id="'+baseId+'"]').forEach(flCb=>{
    flCb.onchange=()=>{
      const flDiv=flCb.closest('[data-dl-floor]');
      if(flDiv) {
        devsIn(flDiv).forEach(c=>c.checked=flCb.checked);
        flDiv.querySelectorAll('[data-dlg-cb][data-base-id="'+baseId+'"]').forEach(c=>{c.checked=flCb.checked;c.indeterminate=false;});
        flDiv.querySelectorAll('[data-dlz-cb][data-base-id="'+baseId+'"]').forEach(c=>{c.checked=flCb.checked;c.indeterminate=false;});
      }
      flCb.indeterminate=false;
      onUpdate(collectIds());
    };
  });

  // ── Group checkboxes ────────────────────────────────────────
  el.querySelectorAll('[data-dlg-cb][data-base-id="'+baseId+'"]').forEach(grpCb=>{
    grpCb.onchange=()=>{
      const grpDiv=grpCb.closest('[data-dl-group]');
      if(grpDiv) {
        devsIn(grpDiv).forEach(c=>c.checked=grpCb.checked);
        grpDiv.querySelectorAll('[data-dlz-cb][data-base-id="'+baseId+'"]').forEach(c=>{c.checked=grpCb.checked;c.indeterminate=false;});
      }
      grpCb.indeterminate=false;
      // Update floor parent
      const flDiv=grpCb.closest('[data-dl-floor]');
      const flCb=flDiv?.querySelector(':scope > div > label > [data-dlf-cb][data-base-id="'+baseId+'"]');
      if(flCb) { const grpCbs=[...flDiv.querySelectorAll('[data-dlg-cb][data-base-id="'+baseId+'"]')]; const n=grpCbs.filter(c=>c.checked&&!c.indeterminate).length; const part=grpCbs.filter(c=>c.checked||c.indeterminate).length; flCb.indeterminate=part>0&&(n<grpCbs.length||grpCbs.some(c=>c.indeterminate)); if(!flCb.indeterminate)flCb.checked=n===grpCbs.length; }
      onUpdate(collectIds());
    };
  });

  // ── Zone checkboxes ─────────────────────────────────────────
  el.querySelectorAll('[data-dlz-cb][data-base-id="'+baseId+'"]').forEach(zCb=>{
    zCb.onchange=()=>{
      const zDiv=zCb.closest('[data-dl-zone]');
      if(zDiv) { devsIn(zDiv).forEach(c=>c.checked=zCb.checked); }
      zCb.indeterminate=false;
      updateParents(zCb);
      onUpdate(collectIds());
    };
  });

  // ── Device checkboxes ────────────────────────────────────────
  el.querySelectorAll('[data-dl-cb][data-base-id="'+baseId+'"]').forEach(devCb=>{
    devCb.onchange=()=>{
      updateParents(devCb);
      onUpdate(collectIds());
    };
  });

  // Set initial indeterminate state on all parents
  devCbs().forEach(c=>{ if(!c.checked) return; updateParents(c); });
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
  if (t.type==='door')   { wireSensorHierarchicalSelector(`trig-door-${t.id}`,ids=>t.entity_ids=ids);   wireSelect(`trig-doorstate-${t.id}`,v=>t.state=v); }
  if (t.type==='person') { wireSelect(`trig-personstate-${t.id}`,v=>t.state=v); wireSearchableCheckbox(`trig-person-${t.id}`,ids=>t.entity_ids=ids); wireAutocomplete(`trig-person-ac-${t.id}`,v=>t.entity_ids=v?[v]:[]); }
  if (t.type==='device') { wireSelect(`trig-devicestate-${t.id}`,v=>t.state=v); wireSearchableCheckbox(`trig-device-${t.id}`,ids=>t.entity_ids=ids); wireAutocomplete(`trig-device-ac-${t.id}`,v=>t.entity_ids=v?[v]:[]); }
  if (t.type==='entity') { wireAutocomplete(`trig-entity-ac-${t.id}`,v=>t.entity_id=v); wireInput(`trig-to-${t.id}`,v=>t.to=v); }
  // Wire HH:MM:SS inputs
  function updateForDuration() {
    const h=(_panelEl?.querySelector(`#trig-for-h-${t.id}`)?.value||'').padStart(2,'0');
    const m=(_panelEl?.querySelector(`#trig-for-m-${t.id}`)?.value||'').padStart(2,'0');
    const s=(_panelEl?.querySelector(`#trig-for-s-${t.id}`)?.value||'').padStart(2,'0');
    t.for_duration = (h==='00'&&m==='00'&&s==='00') ? null : `${h}:${m}:${s}`;
  }
  [`trig-for-h-${t.id}`,`trig-for-m-${t.id}`,`trig-for-s-${t.id}`].forEach(id=>{
    const el=_panelEl?.querySelector(`#${CSS.escape(id)}`);
    if(el)el.oninput=updateForDuration;
  });
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
  if (c.type==='device') {
    wireSearchableCheckbox(`cond-device-${c.id}`,ids=>c.entity_ids=ids);
    wireAutocomplete(`cond-device-ac-${c.id}`,v=>c.entity_ids=v?[v]:[]);
    wireSelect(`cond-device-state-${c.id}`,v=>c.state=v);
  }
}

function wireActionFields(a) {
  if (a.type==='siren') {
    wireDeviceActionTree(a.entity_ids||[], ids=>a.entity_ids=ids, `act-sirens-${a.id}`);
    wireSearchableCheckbox(`act-sirens-extra-${a.id}`,ids=>a.entity_ids_extra=ids);
    wireSelect(`act-siren-svc-${a.id}`,v=>a.service=v);
  }
  if (a.type==='light') {
    wireDeviceActionTree(a.entity_ids_zone||[], ids=>a.entity_ids_zone=ids, `act-light-${a.id}`);
    wireSearchableCheckbox(`act-light-other-${a.id}`,ids=>a.entity_ids_other=ids);
    const otherToggle=_panelEl?.querySelector(`#act-light-other-toggle-${a.id}`);
    const otherWrap=_panelEl?.querySelector(`#act-light-other-wrap-${a.id}`);
    if(otherToggle&&otherWrap) otherToggle.onclick=()=>{
      const open=otherWrap.style.display==='none';
      otherWrap.style.display=open?'':'none';
      otherToggle.textContent=(open?'▼':'▶')+' Other lights from HA ('+otherToggle.textContent.replace(/^[▶▼]\s*/,'').replace(/\s*\(.*$/,'')+' ('+otherWrap.querySelectorAll('label').length+')';
    };
    wireSelect(`act-light-svc-${a.id}`,v=>a.service=v);
  }
  if (a.type==='camera') {
    wireDeviceActionTree(a.entity_ids||[], ids=>a.entity_ids=ids, `act-cam-${a.id}`);
    wireAutocomplete(`act-cam-ac-${a.id}`,v=>a.entity_ids=v?[v]:[]);
    wireSelect(`act-cam-svc-${a.id}`,v=>a.service=v);
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
  if (a.type==='arm') {
    // Wire floor collapse
    _panelEl?.querySelectorAll('[data-armf-collapse]').forEach(btn=>{
      btn.onclick=e=>{e.stopPropagation();e.preventDefault();const key='armf-'+btn.dataset.armfCollapse;const ch=btn.parentElement?.nextElementSibling;const nowCollapsed=ch&&ch.style.display==='none';_collapsedSteps[key]=!nowCollapsed;if(ch)ch.style.display=nowCollapsed?'':'none';btn.textContent=nowCollapsed?'▼':'▶';};
    });
    // Wire group collapse
    _panelEl?.querySelectorAll('[data-armg-collapse]').forEach(btn=>{
      btn.onclick=e=>{e.stopPropagation();e.preventDefault();const key=btn.dataset.armgCollapse;const ch=btn.parentElement?.nextElementSibling;const nowCollapsed=ch&&ch.style.display==='none';_collapsedSteps[key]=!nowCollapsed;if(ch)ch.style.display=nowCollapsed?'':'none';btn.textContent=nowCollapsed?'▼':'▶';};
    });

    const armBox=_panelEl?.querySelector(`#act-arm-zones-${a.id}`);
    if(armBox) {
      function collectArmIds() {
        // Collect all checked boxes — both group switches and zone switches
        const grpIds=[...armBox.querySelectorAll('[data-arm-grp-cb]:checked')].map(c=>c.dataset.armGrpEid).filter(Boolean);
        const zoneIds=[...armBox.querySelectorAll('[data-arm-zone-cb]:checked')].map(c=>c.dataset.armZoneCb).filter(Boolean);
        const masterIds=[...armBox.querySelectorAll('[data-arm-cb]:checked')].map(c=>c.value).filter(Boolean);
        return [...new Set([...grpIds,...zoneIds,...masterIds])];
      }
      function updateArmIndeterminate() {
        // Group level: check if some but not all zone checkboxes are checked
        armBox.querySelectorAll('[data-arm-group]').forEach(grpDiv=>{
          const gid=grpDiv.dataset.armGroup;
          const grpCb=grpDiv.querySelector(`[data-arm-grp-cb="${CSS.escape(gid)}"]`);
          if(!grpCb)return;
          const zoneCbs=[...grpDiv.querySelectorAll('[data-arm-zone-cb]')];
          if(!zoneCbs.length)return;
          const checked=zoneCbs.filter(c=>c.checked).length;
          grpCb.indeterminate = checked>0 && checked<zoneCbs.length;
          if(!grpCb.indeterminate) grpCb.checked = checked===zoneCbs.length;
        });
        // Floor level: check if some but not all group+zone checkboxes are checked
        armBox.querySelectorAll('[data-armf-cb]').forEach(flCb=>{
          const fid=flCb.value;
          const flDiv=armBox.querySelector(`[data-ow-children="${CSS.escape('armf-'+fid)}"]`);
          if(!flDiv)return;
          const allGrpCbs=[...flDiv.querySelectorAll('[data-arm-grp-cb]')];
          const allZoneCbs=[...flDiv.querySelectorAll('[data-arm-zone-cb]')];
          const allCbs=[...allGrpCbs,...allZoneCbs];
          if(!allCbs.length)return;
          const checkedCount=allCbs.filter(c=>c.checked).length;
          const hasIndeterminate=allGrpCbs.some(c=>c.indeterminate);
          flCb.indeterminate = hasIndeterminate || (checkedCount>0 && checkedCount<allCbs.length);
          if(!flCb.indeterminate) flCb.checked = checkedCount===allCbs.length;
        });
      }

      // Wire floor checkboxes — cascade to all groups and zones on floor
      armBox.querySelectorAll('[data-armf-cb]').forEach(flCb=>{
        flCb.onchange=()=>{
          const fid=flCb.value;
          const flDiv=armBox.querySelector(`[data-ow-children="${CSS.escape('armf-'+fid)}"]`);
          if(flDiv){
            flDiv.querySelectorAll('[data-arm-grp-cb]').forEach(cb=>cb.checked=flCb.checked);
            flDiv.querySelectorAll('[data-arm-zone-cb]').forEach(cb=>cb.checked=flCb.checked);
          }
          a.entity_ids=collectArmIds();
          updateArmIndeterminate();
        };
      });

      // Wire group checkboxes — cascade to zone rows inside that group
      armBox.querySelectorAll('[data-arm-grp-cb]').forEach(grpCb=>{
        grpCb.onchange=()=>{
          const gid=grpCb.dataset.armGrpCb;
          const grpDiv=armBox.querySelector(`[data-arm-group="${CSS.escape(gid)}"]`);
          if(grpDiv) grpDiv.querySelectorAll('[data-arm-zone-cb]').forEach(cb=>cb.checked=grpCb.checked);
          a.entity_ids=collectArmIds();
          updateArmIndeterminate();
        };
      });

      // Wire zone checkboxes — update parent group indeterminate state
      armBox.querySelectorAll('[data-arm-zone-cb]').forEach(zoneCb=>{
        zoneCb.onchange=()=>{
          a.entity_ids=collectArmIds();
          updateArmIndeterminate();
        };
      });

      // Master switch
      armBox.querySelectorAll('[data-arm-cb]').forEach(cb=>{
        cb.onchange=()=>{ a.entity_ids=collectArmIds(); };
      });

      // Set initial indeterminate state
      updateArmIndeterminate();
    }
    wireSelect(`act-arm-svc-${a.id}`,v=>a.service=v);
  }
  if (a.type==='camera_view') {
    // Collapse buttons
    _panelEl?.querySelectorAll('[data-cvf-collapse]').forEach(btn=>{
      btn.onclick=e=>{e.stopPropagation();e.preventDefault();const key='cvf-'+btn.dataset.cvfCollapse;const ch=btn.parentElement?.nextElementSibling;const nowC=ch&&ch.style.display==='none';_collapsedSteps[key]=!nowC;if(ch)ch.style.display=nowC?'':'none';btn.textContent=nowC?'▼':'▶';};
    });
    _panelEl?.querySelectorAll('[data-cvg-collapse]').forEach(btn=>{
      btn.onclick=e=>{e.stopPropagation();e.preventDefault();const key='cvg-'+btn.dataset.cvgCollapse;const ch=btn.parentElement?.nextElementSibling;const nowC=ch&&ch.style.display==='none';_collapsedSteps[key]=!nowC;if(ch)ch.style.display=nowC?'':'none';btn.textContent=nowC?'▼':'▶';};
    });

    const camviewBox=_panelEl?.querySelector(`#act-camview-zones-${a.id}`);
    if(camviewBox) {
      function collectCVIds() {
        return [...camviewBox.querySelectorAll('[data-camview-cb]:checked')].map(c=>c.value);
      }

      // Find all camview-cb checkboxes in a container
      function cvCbsIn(container) {
        return [...container.querySelectorAll('[data-camview-cb]')];
      }

      // Update floor "select all" checkbox based on children
      function updateCVFloor(startEl) {
        const floorHeader = startEl.closest('[data-sg-floor],[data-dl-floor]');
        if (!floorHeader) {
          // Use data-ow-children approach — find the floor via cvfall-cb
          // The floor checkbox is data-cvfall-cb, find its ow-children sibling
          camviewBox.querySelectorAll('[data-cvfall-cb]').forEach(flCb=>{
            const flId = flCb.dataset.cvfallCb;
            const chDiv = camviewBox.querySelector(`[data-ow-children="cvf-${CSS.escape(flId)}"]`);
            if (!chDiv) return;
            if (!chDiv.contains(startEl)) return;
            const all = cvCbsIn(chDiv);
            const n = all.filter(c=>c.checked).length;
            flCb.indeterminate = n > 0 && n < all.length;
            if (!flCb.indeterminate) flCb.checked = (n === all.length);
          });
        }
      }

      // Floor "select all" checkbox — cascade all
      camviewBox.querySelectorAll('[data-cvfall-cb]').forEach(flCb=>{
        flCb.onchange=()=>{
          const flId=flCb.dataset.cvfallCb;
          const chDiv=camviewBox.querySelector(`[data-ow-children="cvf-${CSS.escape(flId)}"]`);
          if(chDiv) cvCbsIn(chDiv).forEach(cb=>cb.checked=flCb.checked);
          flCb.indeterminate=false;
          a.entity_ids=collectCVIds();
        };
      });

      // All individual camview checkboxes — update parent floor
      camviewBox.querySelectorAll('[data-camview-cb]').forEach(cb=>{
        cb.onchange=()=>{
          updateCVFloor(cb);
          a.entity_ids=collectCVIds();
        };
      });
    }
    wireSelect(`act-camview-svc-${a.id}`,v=>a.service=v);
  }
  if (a.type==='entity') { wireAutocomplete(`act-entity-ac-${a.id}`,v=>a.entity_id=v); wireSelect(`act-entity-svc-${a.id}`,v=>a.service=v); }
}

/* ════════════════════════════════════════════════════════════
 * SHARED WIDGETS
 * ═══════════════════════════════════════════════════════════ */
function searchableCheckboxList(selectedIds, entities, id, singleSelect=false) {
  if (!entities.length) return `<div style="color:#555;font-size:11px;">No entities found</div>`;
  // Sort: checked items first, then alphabetical
  const sel = selectedIds||[];
  const sorted = [...entities].sort((a,b)=>{
    const aChk = sel.includes(a.entity_id)?0:1;
    const bChk = sel.includes(b.entity_id)?0:1;
    if (aChk!==bChk) return aChk-bChk;
    return (a.name||a.entity_id).localeCompare(b.name||b.entity_id);
  });
  return `<div id="${escH(id)}" class="ow-scbl" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;">
    <div style="position:relative;border-bottom:1px solid rgba(255,255,255,0.06);">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);opacity:0.35;pointer-events:none;"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2.5"/><path d="M16 16L21 21" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
      <input type="text" placeholder="Filter…" autocomplete="off"
        style="width:100%;background:none;border:none;color:#ccc;padding:7px 10px 7px 28px;font-size:12px;outline:none;box-sizing:border-box;"
        data-scbl-filter="1"/>
    </div>
    <div style="padding:4px;">
      ${sorted.map(e=>{
        const state=e.state??haStates()[e.entity_id]?.state;
        const badge=state!==undefined?stateBadge(state==='on'||state==='home',null,'small'):'';
        const isChecked = sel.includes(e.entity_id);
        return `<label data-scbl-item data-scbl-label="${escH((e.name||e.entity_id)+' '+e.entity_id)}" style="display:flex;align-items:center;gap:8px;padding:5px 6px;cursor:pointer;border-radius:5px;${isChecked?'background:rgba(0,100,210,0.08);':''}" onmouseenter="this.style.background='rgba(255,255,255,0.04)'" onmouseleave="this.style.background='${isChecked?'rgba(0,100,210,0.08)':''}'">\n          <input type="${singleSelect?'radio':'checkbox'}" name="${singleSelect?escH(id):''}" value="${escH(e.entity_id)}" ${isChecked?'checked':''} style="accent-color:#0064d2;flex-shrink:0;">\n          <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(e.name||e.entity_id.split('.').pop())}</span>\n          <span style="font-size:10px;color:#444;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escH(e.entity_id)}</span>\n          ${badge}\n        </label>`;
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
    <div id="${escH(id)}-dd" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:10000;background:#141416;border:1px solid rgba(255,255,255,0.12);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.6);"></div>
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

/* ════════════════════════════════════════════════════════════
 * INDETERMINATE (PARTIAL) CHECKBOX STATE
 * Called after render and after any checkbox change.
 * Walks up from individual checkboxes to set indeterminate on
 * parent group/zone/floor checkboxes when only some children checked.
 * ═══════════════════════════════════════════════════════════ */
function updateIndeterminateStates(root) {
  if (!root) return;

  // ── Zone group selector (zone event / zone arm triggers) ──
  root.querySelectorAll('[data-grp-cb]').forEach(grpCb => {
    const gid = grpCb.dataset.grpCb;
    const grp = groups().find(g=>g.id===gid);
    if (!grp) return;
    const zoneCbs = [...root.querySelectorAll(`[data-zone-cb]`)].filter(cb=>{
      const z = zones().find(z=>z.id===cb.dataset.zoneCb);
      return z && (grp.zone_ids||[]).includes(z.id);
    });
    if (!zoneCbs.length) return;
    const checkedCount = zoneCbs.filter(cb=>cb.checked).length;
    grpCb.indeterminate = checkedCount > 0 && checkedCount < zoneCbs.length;
    if (checkedCount === zoneCbs.length) grpCb.checked = true;
    if (checkedCount === 0) grpCb.checked = false;
  });

  // ── Device action tree: handled by wireDeviceActionTree.updateParents() ─

  // ── Sensor selector ────────────────────────────────────────
  root.querySelectorAll('[data-sz-zone-cb]').forEach(zCb => {
    const zid = zCb.dataset.szZoneCb;
    const z = zones().find(z=>z.id===zid);
    if (!z) return;
    const sensInputs = [...root.querySelectorAll('input[value]')]
      .filter(cb=>(z.sensors||[]).includes(cb.value));
    if (!sensInputs.length) return;
    const n = sensInputs.filter(c=>c.checked).length;
    zCb.indeterminate = n > 0 && n < sensInputs.length;
    if (n === sensInputs.length) zCb.checked = true;
    if (n === 0) zCb.checked = false;
  });

  // ── Arm/disarm: handled inline in wireActionFields for 'arm' type ─
}

function injectStyles(){
  if(document.getElementById('ow-auto-styles'))return;
  const s=document.createElement('style');s.id='ow-auto-styles';
  s.textContent=`
    .ow-add-btn{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#aaa;border-radius:7px;padding:5px 12px;cursor:pointer;font-size:12px;transition:background 0.1s,color 0.1s;}
    .ow-add-btn:hover{background:rgba(255,255,255,0.1);color:#fff;}
    @keyframes ow-blink{0%,100%{opacity:1}50%{opacity:0.3}}
    input[type=checkbox]:indeterminate { accent-color: #ff9500; outline: none; }
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

// Re-push all OW automations to HA — called when zone/group names change so entity IDs update
async function repushAll() {
  if (!_automations.length) return;
  logEvent?.('info', `Updating ${_automations.length} automation(s) after rename…`, 'system');
  for (const a of _automations) {
    try { await pushToHA(a.draft); } catch(e) { console.warn('[OW-Auto] repush failed:', e); }
  }
}

window.OW_Automations={toggle,open,close,searchAutomations,repushAll};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
else init();

})();
/* ─── HA-Overwatch Pins Module ────────────────────────────────
 * Stable baseline: v1.551.36.10.
 *
 * Scope:
 * - Map light/siren/camera/door pin rendering.
 * - Pin drag/drop/save interactions.
 * - Pin tap control actions.
 * - Pin animation refresh loop for active lights/sirens/open doors.
 *
 * Compatibility design:
 * - Classic browser script; load before app.js.
 * - Functions intentionally remain global.
 * - App globals are resolved at call time after app.js has loaded.
 * - HA transport helpers call connect/runtime globals only at interaction time.
 */

function togglePinEntity(entityId, pinId) {
  if (!entityId) return;

  // Light tap modes
  const lightPin = lights.find(p => p.id === pinId);
  if (lightPin?.tapAll) {
    const zone = zones.find(z => (z.lights || []).includes(entityId));
    if (zone?.lights?.length) {
      const allOn = zone.lights.every(e => haStates[e]?.state === 'on');
      zone.lights.forEach(e => _callService(e, allOn ? 'turn_off' : 'turn_on'));
      return;
    }
  }

  // Siren tap modes
  const sirenPin = sirens.find(p => p.id === pinId);
  if (sirenPin) {
    const state   = haStates[entityId]?.state;
    const isOn    = state === 'on' || (state === 'unknown' && sirenPin._localOn);
    const service = isOn ? 'turn_off' : 'turn_on';

    if (sirenPin.tapAll) {
      // All sirens across all zones
      const allEntities = [...new Set(zones.flatMap(z => z.sirens || []).concat(sirens.map(p => p.entity_id).filter(Boolean)))];
      allEntities.forEach(e => _callService(e, service));
      sirens.forEach(p => { p._localOn = !isOn; });
    } else if (sirenPin.tapZone) {
      // All sirens in this zone
      const zone = zones.find(z => (z.sirens || []).includes(entityId));
      if (zone?.sirens?.length) zone.sirens.forEach(e => _callService(e, service));
      // Also update _localOn for all siren pins with matching zone
    } else {
      _callService(entityId, service);
      sirenPin._localOn = !isOn;
    }
    renderZones();
    return;
  }

  // Default toggle
  _callService(entityId, haStates[entityId]?.state === 'on' ? 'turn_off' : 'turn_on');
}

function _callService(entityId, service) {
  if (!entityId) return;
  const domain = entityId.startsWith("light.") ? "light" : entityId.startsWith("siren.") ? "siren" : "switch";
  _callDomainService(domain, service, entityId);
}

function _callDomainService(domain, service, entityId) {
  if (!domain || !service || !entityId) return;
  if (IS_DIRECT_MODE) {
    fetch("ow/call-service", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain, service, entity_id: entityId }) }).catch(e => console.warn("[OW] call-service failed:", e.message));
  } else if (haConnected && haSocket) {
    sendHA({ type: "call_service", domain, service, service_data: { entity_id: entityId } });
  }
}

function renderPins(panelIdx) {
  const hideLights  = localStorage.getItem('ow_hide_lights')   === 'true';
  const hideSirens  = localStorage.getItem('ow_hide_sirens')   === 'true';
  const hideCameras = localStorage.getItem('ow_hide_cam_pins') === 'true';

  // Determine SVG and floor context
  let svg, floorId, isFirst;
  if (panelIdx !== undefined) {
    svg     = getPanelSvg(panelIdx);
    const f = getPanelFloor(panelIdx);
    floorId = f?.id || null;
    isFirst = floors.length === 0 || floors[0]?.id === floorId;
  } else {
    svg     = document.getElementById('zonesSvg');
    floorId = activeFloorId;
    isFirst = !floorId || floors.length === 0 || floors[0]?.id === floorId;
  }
  if (!svg) return;

  // Remove existing pin elements (they have data-pin attribute)
  // Skip removal if a pin is being dragged — would break pointer capture
  if (!_pinDragging) {
    svg.querySelectorAll('[data-pin]').forEach(el => el.remove());
  }

  const scale = (panelIdx !== undefined ? PANEL_ZOOMS[panelIdx]?.scale : zoom.scale) || 1;

  // Helper: is pin visible on this floor?
  function pinOnFloor(pin) {
    if (!pin.floor_id) return isFirst;
    return pin.floor_id === floorId;
  }

  // Render lights
  if (!hideLights) {
    lights.forEach(pin => {
      if (!pinOnFloor(pin)) return;
      const isOn   = haStates[pin.entity_id]?.state === 'on';
      const isEdit = editorMode && activePinType === 'light' && activePinId === pin.id;
      svg.appendChild(makeLightPin(pin, isOn, isEdit, scale));
    });
  }

  // Render sirens
  if (!hideSirens) {
    sirens.forEach(pin => {
      if (!pinOnFloor(pin)) return;
      const sirenState = haStates[pin.entity_id]?.state;
      const isOn   = sirenState === 'on' || (sirenState === 'unknown' && pin._localOn);
      const isEdit = editorMode && activePinType === 'siren' && activePinId === pin.id;
      svg.appendChild(makeSirenPin(pin, isOn || isEdit, isEdit, scale));
    });
  }

  // Render camera pins
  if (!hideCameras) {
    cameraPins.forEach(pin => {
      if (!pinOnFloor(pin)) return;
      const isEdit = editorMode && activePinType === 'camera' && activePinId === pin.id;
      svg.appendChild(makeCameraPin(pin, isEdit, scale));
    });
  }

  // Render door pins (always visible — doors are structural)
  doorPins.forEach(pin => {
    if (!pinOnFloor(pin)) return;
    if (pin.x == null || pin.y == null) return; // not placed on map yet
    const isEdit = editorMode && activePinType === 'door' && activePinId === pin.id;
    svg.appendChild(makeDoorPin(pin, isEdit, scale));
  });
}

function makeLightPin(pin, isOn, isEdit, scale) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('data-pin', 'light');
  g.setAttribute('data-pin-id', pin.id);
  g.style.cursor = 'pointer';
  g.style.pointerEvents = 'all';

  const ICON_R   = 14 / scale;           // icon badge radius — scales with zoom so it stays same screen size
  const cx = pin.x, cy = pin.y;
  const hasDir   = pin.direction !== undefined && pin.direction !== null && pin.direction !== '';
  // Glow radius — each slider step = 1.5% of image width (finer control)
  const svgEl   = g.closest('svg') || document.getElementById('zonesSvg');
  const imgW    = svgEl ? Number(svgEl.getAttribute('width') || 2000) : 2000;
  const glowRadius = (pin.radius || 3) * (imgW * 0.006); // smaller steps: 1→0.6%, 10→6%

  const showGlow = isOn || (editorMode && isEdit);

  if (showGlow) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    // Very slow, very subtle breathing — mostly steady, just a gentle pulse
    const breathe = isOn ? (0.85 + 0.15 * Math.sin(Date.now() / 3000 * Math.PI)) : 0.65;

    // Check if any zone at this location is currently triggered — dim glow so zone takes priority
    const nearTriggeredZone = zones.some(z => {
      const state = getZoneState(z);
      if (state !== 'triggered' && state !== 'fault') return false;
      const pts = z.points || [];
      if (pts.length < 3) return false;
      return isPointInPolygon(pin.x, pin.y, pts);
    });
    const glowOpacityScale = nearTriggeredZone ? 0.15 : 1.0; // near transparent when zone triggered

    if (!hasDir) {
      // ── Omnidirectional radial glow ────────────────────────
      const grad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
      grad.id = `lg-${pin.id}`;
      grad.setAttribute('cx', '50%'); grad.setAttribute('cy', '50%'); grad.setAttribute('r', '50%');
      const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s1.setAttribute('offset', '0%');   s1.setAttribute('stop-color', '#ffff44'); s1.setAttribute('stop-opacity', String((0.75 + 0.25 * breathe) * glowOpacityScale));
      const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s2.setAttribute('offset', '45%');  s2.setAttribute('stop-color', '#ffee00'); s2.setAttribute('stop-opacity', String((0.35 + 0.30 * breathe) * glowOpacityScale));
      const s3 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s3.setAttribute('offset', '100%'); s3.setAttribute('stop-color', '#ffcc00'); s3.setAttribute('stop-opacity', String((0.05 + 0.10 * breathe) * glowOpacityScale));
      grad.appendChild(s1); grad.appendChild(s2); grad.appendChild(s3); defs.appendChild(grad); g.appendChild(defs);

      const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      glow.setAttribute('cx', cx); glow.setAttribute('cy', cy);
      glow.setAttribute('r', glowRadius);
      glow.setAttribute('fill', `url(#lg-${pin.id})`);
      glow.setAttribute('pointer-events', 'none');
      g.appendChild(glow);

    } else {
      // ── Directional cone + small source glow ───────────────
      const dir    = Number(pin.direction);
      const spread = pin.spread || 35; // degrees half-angle
      const rad    = d => d * Math.PI / 180;

      // Cone gradient
      const coneGrad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
      coneGrad.id = `lg-cone-${pin.id}`;
      coneGrad.setAttribute('cx', '0%'); coneGrad.setAttribute('cy', '50%');
      coneGrad.setAttribute('r', '100%'); coneGrad.setAttribute('fx', '0%');
      const c1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      c1.setAttribute('offset', '0%'); c1.setAttribute('stop-color', '#ffee88'); c1.setAttribute('stop-opacity', String(0.25 + 0.55 * breathe));
      const c2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      c2.setAttribute('offset', '100%'); c2.setAttribute('stop-color', '#ffaa00'); c2.setAttribute('stop-opacity', '0');
      coneGrad.appendChild(c1); coneGrad.appendChild(c2); defs.appendChild(coneGrad); g.appendChild(defs);

      // Cone path: arc-tipped triangle
      const x1 = cx + glowRadius * Math.sin(rad(dir - spread));
      const y1 = cy - glowRadius * Math.cos(rad(dir - spread));
      const x2 = cx + glowRadius * Math.sin(rad(dir + spread));
      const y2 = cy - glowRadius * Math.cos(rad(dir + spread));
      const xM = cx + glowRadius * Math.sin(rad(dir));
      const yM = cy - glowRadius * Math.cos(rad(dir));
      const cone = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      cone.setAttribute('d', `M${cx},${cy} L${x1},${y1} Q${xM},${yM} ${x2},${y2} Z`);
      cone.setAttribute('fill', `url(#lg-cone-${pin.id})`);
      cone.setAttribute('pointer-events', 'none');
      g.appendChild(cone);

      // Small tight source glow at icon
      const srcGrad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
      srcGrad.id = `lg-src-${pin.id}`;
      srcGrad.setAttribute('cx', '50%'); srcGrad.setAttribute('cy', '50%'); srcGrad.setAttribute('r', '50%');
      const ss1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      ss1.setAttribute('offset', '0%'); ss1.setAttribute('stop-color', '#ffee88'); ss1.setAttribute('stop-opacity', '0.7');
      const ss2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      ss2.setAttribute('offset', '100%'); ss2.setAttribute('stop-color', '#ffaa00'); ss2.setAttribute('stop-opacity', '0');
      srcGrad.appendChild(ss1); srcGrad.appendChild(ss2); defs.appendChild(srcGrad);

      const srcGlow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      srcGlow.setAttribute('cx', cx); srcGlow.setAttribute('cy', cy);
      srcGlow.setAttribute('r', ICON_R * 2.5);
      srcGlow.setAttribute('fill', `url(#lg-src-${pin.id})`);
      srcGlow.setAttribute('pointer-events', 'none');
      g.appendChild(srcGlow);
    }
  }

  // Small subtle background to make icon readable on any background
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', ICON_R * 0.9);
  bg.setAttribute('fill', 'rgba(0,0,0,0.45)');
  bg.setAttribute('stroke', isEdit ? '#0096ff' : (isOn ? 'rgba(255,220,0,0.6)' : 'rgba(255,255,255,0.12)'));
  bg.setAttribute('stroke-width', String((isEdit ? 2.5 : 1) / scale));
  g.appendChild(bg);

  // Clean geometric bulb icon — simple shapes readable at any size
  const iconScale = ICON_R / 10;
  const iconG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  iconG.setAttribute('transform', `translate(${cx},${cy}) scale(${iconScale})`);
  const mk = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
    return el;
  };
  if (isOn) {
    iconG.appendChild(mk('circle', {cx:'0',cy:'-1',r:'6',fill:'#ffee00'}));
    iconG.appendChild(mk('rect',   {x:'-3',y:'4',width:'6',height:'2.5',rx:'1',fill:'#ffcc00'}));
    iconG.appendChild(mk('circle', {cx:'-2',cy:'-3',r:'1.5',fill:'rgba(255,255,255,0.45)'}));
  } else {
    iconG.appendChild(mk('circle', {cx:'0',cy:'-1',r:'6',fill:'none',stroke:'#ccc','stroke-width':'1.8'}));
    iconG.appendChild(mk('rect',   {x:'-3',y:'4',width:'6',height:'2.5',rx:'1',fill:'none',stroke:'#ccc','stroke-width':'1.8'}));
    iconG.appendChild(mk('line',   {x1:'-4.5',y1:'5',x2:'4.5',y2:'-6',stroke:'#ff6666','stroke-width':'1.8','stroke-linecap':'round'}));
  }
  g.appendChild(iconG);

  // Live mode: tap to toggle. Editor mode: handled by makePinDraggable (tap=select, drag=move)
  if (editorMode) {
    makePinDraggable(g, pin, 'light');
  } else {
    let _moved = false;
    g.addEventListener('pointerdown', e => { _moved = false; e.stopPropagation(); });
    g.addEventListener('pointermove', e => { if (Math.hypot(e.movementX, e.movementY) > 2) _moved = true; });
    g.addEventListener('pointerup',   e => { e.stopPropagation(); if (!_moved) togglePinEntity(pin.entity_id, pin.id); });
  }

  return g;
}

function makeSirenPin(pin, isOn, isEdit, scale) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('data-pin', 'siren');
  g.setAttribute('data-pin-id', pin.id);
  g.style.cursor = 'pointer';
  g.style.pointerEvents = 'all'; // always clickable even when SVG is pointer-events:none

  const R  = 14 / scale;
  const cx = pin.x, cy = pin.y;

  // Pulsing rings + flash glow when on
  if (isOn) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const grad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
    grad.id = `sg-${pin.id}`;
    grad.setAttribute('cx', '50%'); grad.setAttribute('cy', '50%'); grad.setAttribute('r', '50%');
    const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#ff3b30'); s1.setAttribute('stop-opacity', String(flashPhase ? 0.7 : 0.35));
    const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#ff3b30'); s2.setAttribute('stop-opacity', '0');
    grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); g.appendChild(defs);

    // 3 rings at different expansion stages driven by time
    const ringPhase = (Date.now() % 1600) / 1600;
    const maxRingR  = R * (2 + (pin.radius || 4)); // radius setting controls max expansion

    // Red glow scaled to match ring max size
    const flashGlow = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    flashGlow.setAttribute('cx', cx); flashGlow.setAttribute('cy', cy);
    flashGlow.setAttribute('rx', maxRingR); flashGlow.setAttribute('ry', maxRingR);
    flashGlow.setAttribute('fill', `url(#sg-${pin.id})`);
    g.appendChild(flashGlow);
    [0, 0.33, 0.66].forEach((offset) => {
      const phase = (ringPhase + offset) % 1;
      const ringR = R * 1.2 + (maxRingR - R * 1.2) * phase;
      const ringO = Math.max(0, 0.7 * (1 - phase));
      const ring  = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ring.setAttribute('cx', cx); ring.setAttribute('cy', cy);
      ring.setAttribute('r', ringR);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', '#ff3b30');
      ring.setAttribute('stroke-width', String(1.5 / scale));
      ring.setAttribute('opacity', String(ringO));
      g.appendChild(ring);
    });
  }

  // Subtle background circle — matches light icon style
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', R * 0.9);
  bg.setAttribute('fill', isOn ? 'rgba(40,0,0,0.5)' : 'rgba(40,40,40,0.5)');
  bg.setAttribute('stroke', isEdit ? '#0096ff' : (isOn ? 'rgba(255,80,60,0.7)' : 'rgba(255,255,255,0.35)'));
  bg.setAttribute('stroke-width', String((isEdit ? 2.5 : 1.2) / scale));
  g.appendChild(bg);

  // No edit ring needed — bg stroke handles it
  if (isEdit) {
    // Already handled above
  }

  // MDI bell icon — mdi:bell / mdi:bell-outline
  const iconG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const sirenIconScale = R / 12;
  iconG.setAttribute('transform', `translate(${cx - 12 * sirenIconScale},${cy - 12 * sirenIconScale}) scale(${sirenIconScale})`);
  const bell = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bell.setAttribute('d', 'M21,19V20H3V19L5,17V11C5,7.9 7.03,5.17 10,4.29C10,4.19 10,4.1 10,4A2,2 0 0,1 12,2A2,2 0 0,1 14,4C14,4.1 14,4.19 14,4.29C16.97,5.17 19,7.9 19,11V17L21,19M14,21A2,2 0 0,1 12,23A2,2 0 0,1 10,21');
  bell.setAttribute('fill', isOn ? '#ff3b30' : 'none');
  bell.setAttribute('stroke', isOn ? '#ff1a0e' : '#ccc');
  bell.setAttribute('stroke-width', isOn ? '0.5' : '1.2');
  iconG.appendChild(bell);
  // Off-state: red diagonal slash in MDI 0-24 coordinate space
  if (!isOn) {
    const slash = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    slash.setAttribute('x1', '2');  slash.setAttribute('y1', '22');
    slash.setAttribute('x2', '22'); slash.setAttribute('y2', '2');
    slash.setAttribute('stroke', '#ff5555');
    slash.setAttribute('stroke-width', '2');
    slash.setAttribute('stroke-linecap', 'round');
    iconG.appendChild(slash);
  }
  g.appendChild(iconG);

  if (editorMode) {
    makePinDraggable(g, pin, 'siren');
  } else {
    let _moved = false;
    g.addEventListener('pointerdown', e => { _moved = false; e.stopPropagation(); });
    g.addEventListener('pointermove', e => { if (Math.hypot(e.movementX, e.movementY) > 2) _moved = true; });
    g.addEventListener('pointerup',   e => { e.stopPropagation(); if (!_moved) togglePinEntity(pin.entity_id, pin.id); });
  }

  return g;
}

function makeCameraPin(pin, isEdit, scale) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('data-pin', 'camera');
  g.setAttribute('data-pin-id', pin.id);
  g.style.cursor = 'pointer';
  g.style.pointerEvents = 'all';

  const R  = 14 / scale;
  const cx = pin.x, cy = pin.y;

  // Background circle
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', R * 0.9);
  bg.setAttribute('fill', 'rgba(0,0,0,0.25)');
  bg.setAttribute('stroke', isEdit ? '#0096ff' : 'rgba(100,180,255,0.5)');
  bg.setAttribute('stroke-width', String((isEdit ? 2.5 : 1.2) / scale));
  g.appendChild(bg);

  // Camera icon — simple geometric: rectangle body + circle lens
  const iconS = R / 10;
  const iconG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  iconG.setAttribute('transform', `translate(${cx},${cy}) scale(${iconS})`);
  const mk = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k,v));
    return el;
  };
  // Camera body
  iconG.appendChild(mk('rect', {x:'-7',y:'-4',width:'14',height:'10',rx:'2',fill:'none',stroke:'#64b4ff','stroke-width':'1.5'}));
  // Lens
  iconG.appendChild(mk('circle', {cx:'0',cy:'1',r:'3.2',fill:'none',stroke:'#64b4ff','stroke-width':'1.5'}));
  // Viewfinder bump on top-left
  iconG.appendChild(mk('rect', {x:'-5',y:'-7',width:'4',height:'3',rx:'1',fill:'#64b4ff'}));
  g.appendChild(iconG);

  // Interaction
  if (editorMode) {
    makePinDraggable(g, pin, 'camera');
  } else {
    let _moved = false;
    g.addEventListener('pointerdown', e => { _moved = false; e.stopPropagation(); });
    g.addEventListener('pointermove', e => { if (Math.hypot(e.movementX, e.movementY) > 2) _moved = true; });
    g.addEventListener('pointerup', e => {
      e.stopPropagation();
      if (!_moved && pin.entity_id && window.openCameraModal) {
        window.openCameraModal(pin.entity_id);
      }
    });
  }

  return g;
}

let activePinType = null; // 'light' | 'siren' | 'camera' | 'door' | null
let activePinId   = null;
let placingPinType  = null; // 'light' | 'siren' | 'camera' — click-to-place mode
let placingEntityId = null;
let placingZoneId   = null;
let _placingExistingPinId = null; // if set, update existing pin position rather than create new
let _activeZoneTab  = 'sensors'; // persists across renderZonesEditor re-renders

function selectPin(type, id) {
  // Toggle — clicking same pin deselects it
  if (activePinType === type && activePinId === id) {
    activePinId = null; activePinType = null;
  } else {
    activePinType   = type;
    activePinId     = id;
    selectedZoneId  = null;
    selectedGroupId = null;
  }
}

// Called when user clicks a map to place a pin (single or multi-panel)
function placePinAtFloorplanCoord(x, y, floorId) {
  const type     = placingPinType;
  const entityId = placingEntityId || '';
  const zoneId   = placingZoneId;
  const existingPinId = _placingExistingPinId;
  placingPinType  = null;
  placingEntityId = null;
  placingZoneId   = null;
  _placingExistingPinId = null;
  // Reset cursors
  document.querySelectorAll('#zonesSvg, .fp-svg').forEach(s => s.style.cursor = '');

  // If placing an existing unpositioned pin (e.g. from search-add), just update its position
  if (existingPinId && type === 'door') {
    const existing = doorPins.find(p => p.id === existingPinId);
    if (existing) {
      existing.x = Math.round(x);
      existing.y = Math.round(y);
      existing.floor_id = floorId || activeFloorId || null;
      saveDoorPin(existing);
      selectPin('door', existing.id);
      renderZones(); renderZonesEditor();
      return;
    }
  }

  // Inherit floor from the zone the entity belongs to
  const zone = zones.find(z => z.id === zoneId);
  const pinFloor = zone?.floor_id || floorId || activeFloorId || null;

  const pin = {
    id:        (type === 'light' ? 'light_' : type === 'siren' ? 'siren_' : type === 'door' ? 'door_' : 'campin_') + Date.now(),
    name:      entityId.split('.').pop() || (type === 'light' ? 'New Light' : type === 'siren' ? 'New Siren' : type === 'door' ? 'New Door' : 'New Camera'),
    entity_id: type === 'door' ? undefined : entityId,
    sensor_entity: type === 'door' ? '' : undefined,
    control_entity: type === 'door' ? null : undefined,
    zone_ids: type === 'door' ? [zoneId] : undefined,
    zone_id:   type === 'door' ? zoneId : undefined,
    floor_id:  pinFloor,
    x:         Math.round(x),
    y:         Math.round(y),
    rotation:  0,
    direction: type !== 'door' ? null : undefined,
  };
  if (type === 'light')  { lights.push(pin);      saveLight(pin);      selectPin('light',  pin.id); }
  else if (type === 'siren') { sirens.push(pin);  saveSiren(pin);      selectPin('siren',  pin.id); }
  else if (type === 'door') { doorPins.push(pin); saveDoorPin(pin);    selectPin('door',   pin.id); }
  else                   { cameraPins.push(pin);  saveCameraPin(pin);  selectPin('camera', pin.id); }
  renderZones(); renderZonesEditor();
}

function makeDoorPin(pin, isEdit, scale) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('data-pin', 'door');
  g.setAttribute('data-pin-id', pin.id);
  g.style.cursor = 'pointer';
  g.style.pointerEvents = 'all';

  const sensorState  = haStates[pin.sensor_entity]?.state;
  const isOpen       = ['on','open','opening','detected','unlocked'].includes(String(sensorState || '').toLowerCase());
  const noSensor     = !pin.sensor_entity;
  const controlState = pin.control_entity ? haStates[pin.control_entity]?.state : null;
  const isLocked     = controlState === 'locked' || controlState === 'off';
  const isUnlocked   = controlState === 'unlocked' || controlState === 'on';
  const hasControl   = !!pin.control_entity;

  const rootCS     = getComputedStyle(document.documentElement);
  const colOnDoor  = rootCS.getPropertyValue('--color-door-open').trim()  || '#ff6b35';
  const colOffDoor = rootCS.getPropertyValue('--color-door-closed').trim() || '#ffcc00';

  // Zone arm state — find the zone this pin belongs to
  const linkedZones = doorPinZoneIds(pin).map(zid => zones.find(z => z.id === zid)).filter(Boolean);
  const zoneArmed   = linkedZones.length ? linkedZones.some(z => getZoneState(z) !== 'disabled') : true;

  // Open door: use armed colour if zone armed, disarmed colour if zone disarmed
  // Closed door: always green (safe, shut)
  const colOpen = noSensor ? '#888' : zoneArmed ? colOnDoor : colOffDoor;
  const col     = noSensor ? '#888' : isOpen ? colOpen : '#34c759';

  const mk = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k,String(v)));
    return el;
  };

  // W = opening width, H = wall/frame height (thickness)
  const W   = Math.max(4, pin.sizeW || 20);
  const H   = Math.max(1, pin.sizeH || 4);
  const T   = Math.max(0.5, W * 0.05);
  const jT  = T * 1.2;

  const doorType  = pin.doorType || 'single';
  const doorHand  = pin.doorHand || 'left';
  const isSliding = doorType === 'sliding';
  const isDouble  = doorType === 'double';

  const cx = pin.x, cy = pin.y;
  const rot = pin.rotation || 0;
  const iconG = mk('g', { transform: `translate(${cx},${cy}) rotate(${rot})` });

  // Jamb rect helper — draws wall segment
  function jamb(x1, x2) {
    iconG.appendChild(mk('rect', {
      x:x1, y:-H/2, width:Math.max(0.5, x2-x1), height:H,
      fill:col, 'fill-opacity':'0.5', stroke:col, 'stroke-width':T*0.3
    }));
  }

  if (isSliding) {
    // Two jambs + track + panel
    jamb(-W/2, -W/2+H);  // left jamb
    jamb( W/2-H,  W/2);  // right jamb
    // Track
    iconG.appendChild(mk('line', { x1:-W/2+H, y1:0, x2:W/2-H, y2:0,
      stroke:col, 'stroke-width':T*0.4, 'stroke-dasharray':`${T*2},${T}` }));
    const panelW = (W - H*2) * 0.9;
    if (isOpen) {
      // Panel at left side
      iconG.appendChild(mk('rect', { x:-W/2+H, y:-H/2, width:panelW, height:H,
        fill:col, 'fill-opacity':'0.7', stroke:col, 'stroke-width':T*0.4 }));
    } else {
      // Panel centred in opening
      const gap = (W - H*2 - panelW) / 2;
      iconG.appendChild(mk('rect', { x:-W/2+H+gap, y:-H/2, width:panelW, height:H,
        fill:col, 'fill-opacity':'0.5', stroke:col, 'stroke-width':T*0.4 }));
    }

  } else if (isDouble) {
    // Two jambs at outer edges, two panels from jamb face to centre
    jamb(-W/2, -W/2+H);  // left jamb
    jamb( W/2-H,  W/2);  // right jamb
    const panelL = W/2 - H;  // each panel length

    [[-W/2+H, 'left'],[W/2-H, 'right']].forEach(([hinge, side]) => {
      const fx    = 0;
      const sweep = side === 'left' ? 0 : 1;
      const panelDX = side === 'left' ? panelL : -panelL;
      // Hinge dot
      iconG.appendChild(mk('circle', { cx:hinge, cy:0, r:jT*0.6, fill:col }));
      if (isOpen) {
        const angle = side === 'left' ? -90 : 90;
        const pg = mk('g', { transform:`rotate(${angle},${hinge},0)` });
        pg.appendChild(mk('line', { x1:hinge, y1:0, x2:hinge+panelDX, y2:0,
          stroke:col, 'stroke-width':T*1.5 }));
        iconG.appendChild(pg);
        iconG.appendChild(mk('path', {
          d:`M ${hinge} ${-panelL} A ${panelL} ${panelL} 0 0 ${sweep} ${fx} 0`,
          fill:'none', stroke:col, 'stroke-width':T*0.5, 'stroke-dasharray':`${T*2},${T}`
        }));
      } else {
        iconG.appendChild(mk('line', { x1:hinge, y1:0, x2:fx, y2:0,
          stroke:col, 'stroke-width':T*1.5 }));
      }
    });

  } else {
    // Single door — left and right jambs (same as double, no centre)
    jamb(-W/2, -W/2+H);  // hinge-side jamb
    jamb( W/2-H,  W/2);  // free-side jamb

    // Hinge face x (inner edge of hinge jamb)
    const hinge  = doorHand === 'left' ? -W/2+H : W/2-H;
    const freeX  = doorHand === 'left' ?  W/2-H : -W/2+H;
    const panelL = W - H*2;  // panel = opening minus both jambs
    const panelDX = doorHand === 'left' ? panelL : -panelL;
    const sweep  = doorHand === 'left' ? 0 : 1;

    // Hinge dot
    iconG.appendChild(mk('circle', { cx:hinge, cy:0, r:jT*0.6, fill:col }));

    if (isOpen) {
      // Panel perpendicular — rotated 90° at hinge face, NO horizontal line
      const angle = doorHand === 'left' ? -90 : 90;
      const pg = mk('g', { transform:`rotate(${angle},${hinge},0)` });
      pg.appendChild(mk('line', { x1:hinge, y1:0, x2:hinge+panelDX, y2:0,
        stroke:col, 'stroke-width':T*1.5 }));
      iconG.appendChild(pg);
      iconG.appendChild(mk('path', {
        d:`M ${hinge} ${-panelL} A ${panelL} ${panelL} 0 0 ${sweep} ${freeX} 0`,
        fill:'none', stroke:col, 'stroke-width':T*0.5, 'stroke-dasharray':`${T*2},${T}`
      }));
    } else {
      // Closed — horizontal panel line only, no arc
      iconG.appendChild(mk('line', { x1:hinge, y1:0, x2:freeX, y2:0,
        stroke:col, 'stroke-width':T*1.5 }));
    }
  }

  // Aura when open — siren-style expanding rings, centred on door opening
  if (isOpen && !isEdit) {
    const suppressDisarmed = localStorage.getItem('ow_hide_door_alert_disarmed') === 'true';
    const showAura = !suppressDisarmed || zoneArmed;
    if (showAura) {
    const auraRadius = pin.auraRadius || 3;
    const maxRingR   = (W/2) * (0.8 + auraRadius * 0.4);
    const minRingR   = W * 0.1;
    const ringPhase  = (Date.now() % 1600) / 1600;
    // Centre: middle of the opening gap (between the two jambs)
    const auraCX = 0;
    const auraCY = 0;  // at the threshold line — centre of the door opening
    const glowId = `dg-${pin.id}`;
    const defs = mk('defs', {});
    const grad = mk('radialGradient', { id:glowId, cx:'50%', cy:'50%', r:'50%' });
    const s1 = mk('stop', { offset:'0%', 'stop-color':colOpen, 'stop-opacity':'0.3' });
    const s2 = mk('stop', { offset:'100%', 'stop-color':colOpen, 'stop-opacity':'0' });
    grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad);
    iconG.insertBefore(defs, iconG.firstChild);
    const glow = mk('ellipse', { cx:auraCX, cy:auraCY, rx:maxRingR, ry:maxRingR, fill:`url(#${glowId})` });
    iconG.insertBefore(glow, iconG.firstChild);
    [0, 0.33, 0.66].forEach(offset => {
      const phase = (ringPhase + offset) % 1;
      const r     = minRingR + (maxRingR - minRingR) * phase;
      const op    = Math.max(0, 0.7 * (1 - phase));
      iconG.appendChild(mk('circle', { cx:auraCX, cy:auraCY, r, fill:'none', stroke:colOpen,
        'stroke-width':T*0.8, opacity:op }));
    });
    }
  }

  // Editor box
  if (isEdit) {
    iconG.appendChild(mk('rect', {
      x:-W/2-T, y:-W/2-T, width:W+T*2, height:W/2+H/2+T*2,
      fill:'none', stroke:'#0096ff', 'stroke-width':1.5/scale,
      rx:1.5/scale, 'stroke-dasharray':`${3/scale},${2/scale}`
    }));
  }

  // Lock badge
  if (hasControl && controlState) {
    const br = Math.max(2.5, W*0.1);
    const bx = W/2+br*1.5;
    const by = -H/2;
    const lc = isLocked ? '#ff3b30' : '#34c759';
    iconG.appendChild(mk('circle', { cx:bx, cy:by, r:br, fill:'rgba(10,10,10,0.9)', stroke:lc, 'stroke-width':0.8 }));
    const sym = mk('text', { x:bx, y:by+br*0.38, 'text-anchor':'middle', 'font-size':br*1.3, fill:lc, 'font-family':'sans-serif', style:'pointer-events:none;user-select:none' });
    sym.textContent = isLocked ? '🔒' : '🔓';
    iconG.appendChild(sym);
  }

  g.appendChild(iconG);

  if (editorMode) {
    makePinDraggable(g, pin, 'door');
  } else {
    let _moved = false;
    g.addEventListener('pointerdown', e => { _moved = false; e.stopPropagation(); });
    g.addEventListener('pointermove', e => { if (Math.hypot(e.movementX, e.movementY) > 2) _moved = true; });
    g.addEventListener('pointerup', e => {
      e.stopPropagation();
      if (_moved) return;
      if (!hasControl || !pin.control_entity) return;
      const label  = pin.name || pin.sensor_entity?.split('.').pop() || 'door';
      const action = isLocked ? 'Unlock' : isUnlocked ? 'Lock' : isOpen ? 'Close' : 'Open';
      if (confirm(`${action} ${label}?`)) {
        const domain = pin.control_entity.startsWith('lock.') ? 'lock' : 'switch';
        const svc    = domain === 'lock' ? (isLocked ? 'unlock' : 'lock') : (isLocked ? 'turn_on' : 'turn_off');
        _callService(pin.control_entity, svc);
      }
    });
  }
  return g;
}

function makePinDraggable(g, pin, type) {
  let dragging = false, startClient = null, startPos = null, hasMoved = false;

  g.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    e.preventDefault();
    dragging      = true;
    _pinDragging  = true;
    _draggingPinId = pin.id;
    hasMoved      = false;
    startClient   = { x: e.clientX, y: e.clientY };
    startPos      = { x: pin.x, y: pin.y };
    g.setPointerCapture(e.pointerId);
  });

  g.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startClient.x;
    const dy = e.clientY - startClient.y;
    if (!hasMoved && Math.hypot(dx, dy) < 4) return;
    hasMoved = true;
    // Get zoom scale for this panel/single
    const panelSvg = g.closest('.fp-svg');
    let s = zoom.scale || 1;
    if (panelSvg) {
      const match = panelSvg.id?.match(/fp-svg-(\d+)/);
      if (match) s = PANEL_ZOOMS[Number(match[1])]?.scale || 1;
    }
    const newX = Math.round(startPos.x + dx / s);
    const newY = Math.round(startPos.y + dy / s);
    // Move g visually via SVG translate — no DOM recreation, pointer capture preserved
    g.setAttribute('transform', `translate(${newX - startPos.x},${newY - startPos.y})`);
    pin.x = newX;
    pin.y = newY;
  });

  g.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging       = false;
    _pinDragging   = false;
    _draggingPinId = null;
    g.removeAttribute('transform');
    if (hasMoved) {
      if (type === 'light')  saveLight(pin);
      else if (type === 'siren') saveSiren(pin);
      else if (type === 'camera') saveCameraPin(pin);
      else saveDoorPin(pin);
      renderZones();
    } else {
      e.stopPropagation(); // prevent SVG empty-canvas handler from clearing activePinId
      selectPin(type, pin.id);
      console.log('[OW PIN] tap: activePinId=', activePinId, 'selectedZoneId=', selectedZoneId);
      renderZones();
      renderZonesEditor();
    }
  });

  g.addEventListener('pointercancel', () => { dragging = false; _pinDragging = false; _draggingPinId = null; g.removeAttribute('transform'); });
}

let _pinAnimRunning = false;
let _pinDragging    = false; // set during drag to suppress renderPins from removing the dragged element
let _draggingPinId  = null;  // id of pin currently being dragged

function startPinAnimLoop() {
  if (_pinAnimRunning) return;
  _pinAnimRunning = true;
  function loop() {
    // Don't run animation loop in editor mode (causes flicker on selected pins)
    // or during drag (would interfere with pointer capture)
    if (editorMode || _pinDragging) { _pinAnimRunning = false; return; }
    const hasActiveSirens = sirens.some(p => haStates[p.entity_id]?.state === 'on');
    const hasActiveLights = lights.some(p => haStates[p.entity_id]?.state === 'on');
    const suppressDoorDisarmed = localStorage.getItem('ow_hide_door_alert_disarmed') === 'true';
    const hasOpenDoors    = doorPins.some(p => {
      if (p.sensor_entity && isEntityGhosted(p.sensor_entity)) return false;
      if (p.control_entity && isEntityGhosted(p.control_entity)) return false;
      if (!isDoorTriggered(p)) return false;
      if (suppressDoorDisarmed) {
        // Check if the zone is disarmed — check arm switch directly (not getZoneState
        // which would return 'triggered' because the open door makes the zone triggered)
        const linked = doorPinZoneIds(p).map(zid => zones.find(z => z.id === zid)).filter(Boolean);
      const zone = linked[0] || null;
        if (!zone) return true;
        let zoneEnabled;
        if (!zoneUseServerState()) {
          zoneEnabled = localStorage.getItem(ZONE_LOCAL_PREFIX + zone.id) !== 'false';
        } else {
          const sw = haStates[`switch.overwatch_zone_${zoneSlug(zone)}`];
          zoneEnabled = sw ? sw.state !== 'off' : zone.enabled !== false;
        }
        const masterSw = haStates['switch.overwatch_zone_master'];
        const masterOn = masterSw ? masterSw.state !== 'off' : masterEnabled;
        if (!zoneEnabled || !masterOn) return false; // zone/master disarmed — suppress
      }
      return true;
    });
    if (hasActiveSirens || hasActiveLights || hasOpenDoors) {
      renderPins();
      if (getNumPanels() > 1) {
        const n = getNumPanels();
        for (let i = 0; i < n; i++) renderPins(i);
      }
      requestAnimationFrame(loop);
    } else {
      _pinAnimRunning = false;
    }
  }
  requestAnimationFrame(loop);
}

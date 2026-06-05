/* ─── HA-Overwatch Floors Module ───────────────────────────────
 * Stable baseline: v0.05.35.06.
 * Scope: Floor CRUD, active floor switching, multi-panel runtime.
 * Classic browser script; load before app.js.
 */

function getNumPanels()  { return Math.min(parseInt(localStorage.getItem('ow_map_panels') || '1'), floors.length || 1); }
function getPanelsDir()  { return localStorage.getItem('ow_panels_dir') || 'h'; }
function getPanelFloor(idx) {
  const key = idx === 0 ? 'ow_panel_0_floor' : 'ow_panel_1_floor';
  const saved = localStorage.getItem(key);
  const match = floors.find(f => f.id === saved);
  if (match) return match;
  return floors[idx] || floors[0] || null;
}

async function loadFloors() {
  try {
    const res = await fetch(apiPath("ow/floors") + "?v=" + Date.now());
    if (!res.ok) { floors = []; return; }
    floors = await res.json();
    // v0.05.35.06: preserve current floor during HA registry/area refreshes.
    // Only choose a default floor on initial load, or if the previous floor no longer exists.
    const previousActiveFloorId = activeFloorId;
    if (!activeFloorId || !floors.some(f => f.id === activeFloorId)) {
      const savedActiveFloorId = localStorage.getItem("ow_active_floor");
      activeFloorId = floors.find(f => f.id === savedActiveFloorId)?.id || floors[0]?.id || null;
    }
    // Clear saved zoom only when the active floor actually changes.
    if (previousActiveFloorId !== activeFloorId) {
      localStorage.removeItem("zoomScale");
      localStorage.removeItem("zoomX");
      localStorage.removeItem("zoomY");
    }
    // Load the active floor's floorplan image and await it so initFloorplan
    // gets correct dimensions before renderZones runs
    const floor = activeFloor();
    if (floor?.floorplan) {
      const fp = document.getElementById("floorplanImage");
      if (fp) {
        await new Promise(resolve => {
          fp.onload  = resolve;
          fp.onerror = resolve;
          fp.src = apiPath(floor.floorplan) + "?v=" + Date.now();
        });
        initFloorplan();
      }
    }
  } catch { floors = []; }
}

async function saveFloor(floor) {
  const res = await fetch(apiPath("ow/save-floor"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(floor),
  });
  const data = await res.json();
  if (data.floors) floors = data.floors;
  showSaveToast('Floor');
  return data;
}

async function deleteFloor(id) {
  const res = await fetch(apiPath("ow/delete-floor"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const data = await res.json();
  if (data.floors) floors = data.floors;
  return data;
}

function setActiveFloor(id) {
  // v0.05.35.06: HA area assignment/sync is data refresh, not navigation.
  // Suppression is used while the zone editor is reconciling HA area membership.
  if (window._owSuppressFloorChange) return;

  const floor = floors.find(f => f.id === id);
  if (!floor) return;

  // In multi-panel mode, update the active panel's floor assignment
  if (getNumPanels() > 1) {
    // Only update if a panel is actually selected
    if (activePanelIdx >= 0) {
      const key = activePanelIdx === 0 ? 'ow_panel_0_floor' : 'ow_panel_1_floor';
      const current = localStorage.getItem(key);
      if (current !== id) {
        localStorage.setItem(key, id);
        applyFloorPanels(); // rebuild panels with new floor assignment
      }
    }
    return;
  }

  activeFloorId = id;
  localStorage.setItem("ow_active_floor", id);
  // Clear saved zoom so the new floor's image fits to the panel automatically
  localStorage.removeItem("zoomScale");
  localStorage.removeItem("zoomX");
  localStorage.removeItem("zoomY");
  applyActiveFloor();
}

function activeFloor() {
  return floors.find(f => f.id === activeFloorId) || floors[0] || null;
}

function applyActiveFloor() {
  const floor = activeFloor();
  if (!floor) return;
  // Update floorplan image
  const fp = document.getElementById("floorplanImage");
  if (fp && floor.floorplan) {
    const newSrc = apiPath(floor.floorplan) + "?v=" + Date.now();
    if (!fp.src.includes(floor.floorplan.split("?")[0])) {
      fp.src = newSrc;
      fp.onload = initFloorplan;
    }
  }
  renderZones();
  renderStatusDropdown();
  if (window.renderCameraStatusBar) { window.renderCameraStatusBar(); applyStatusVisibility(); }
}

// ─── MULTI-PANEL FLOOR RENDERER ────────────────────────────────────────────
//
// When getNumPanels() === 1: normal single-panel mode (existing engine unchanged)
// When getNumPanels() === 2: replaces #main contents with two .floor-panel divs,
//   each with its own img, svg, zoom state, and pan binding.
//
// activePanelIdx tracks which panel sidebar zoom/reset applies to.
// Mouse scroll always applies to whichever panel the pointer is over.

const PANEL_ZOOMS = [
  { scale: 1, x: 0, y: 0 },
  { scale: 1, x: 0, y: 0 },
];

function getPanelEl(idx)      { return document.querySelector(`.floor-panel[data-panel-idx="${idx}"]`); }
function getPanelWrapper(idx) { return document.querySelector(`.floor-panel[data-panel-idx="${idx}"] .fp-wrapper`); }
function getPanelImg(idx)     { return document.querySelector(`.floor-panel[data-panel-idx="${idx}"] .fp-img`); }
function getPanelSvg(idx)     { return document.querySelector(`.floor-panel[data-panel-idx="${idx}"] .fp-svg`); }

function applyPanelTransform(idx) {
  const wrapper = getPanelWrapper(idx);
  if (!wrapper) return;
  const z = PANEL_ZOOMS[idx];
  wrapper.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.scale})`;
  if (editorMode) renderAllPanelZones();
}

function fitPanelToContainer(idx) {
  const panelEl = getPanelEl(idx);
  const img     = getPanelImg(idx);
  if (!panelEl || !img || !img.naturalWidth) return;
  const vw = panelEl.offsetWidth;
  const vh = panelEl.offsetHeight;
  // If panel has no size yet (not laid out), retry after layout
  if (!vw || !vh) {
    requestAnimationFrame(() => fitPanelToContainer(idx));
    return;
  }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const z  = PANEL_ZOOMS[idx];
  z.scale  = Math.min(vw / iw, vh / ih, 1);
  z.x      = (vw - iw * z.scale) / 2;
  z.y      = (vh - ih * z.scale) / 2;
  applyPanelTransform(idx);
  renderAllPanelZones();
}

function setActivePanel(idx) {
  // Click same panel again = deselect
  if (activePanelIdx === idx && document.querySelector('.floor-panel.fp-active')) {
    activePanelIdx = -1;
    document.querySelectorAll('.floor-panel').forEach(el => el.classList.remove('fp-active'));
    return;
  }
  activePanelIdx = idx;
  document.querySelectorAll('.floor-panel').forEach((el, i) => {
    el.classList.toggle('fp-active', i === idx);
  });
}

// Render zones onto a specific panel's SVG
function renderPanelZones(idx) {
  const panelSvg = getPanelSvg(idx);
  const floor    = getPanelFloor(idx);
  if (!panelSvg || !floor) return;

  const img = getPanelImg(idx);
  if (!img) return;
  // If image not yet loaded, defer — onload will call renderPanelZones again
  if (!img.naturalWidth) {
    const prev = img.onload;
    img.onload = () => { if (prev) prev(); renderPanelZones(idx); };
    return;
  }

  // Clear — preserve dragging pin element
  if (_pinDragging) {
    Array.from(panelSvg.childNodes).forEach(child => {
      if (child.getAttribute?.('data-pin-id') === _draggingPinId) return;
      panelSvg.removeChild(child);
    });
  } else {
    while (panelSvg.firstChild) panelSvg.removeChild(panelSvg.firstChild);
  }
  panelSvg.setAttribute('width',   img.naturalWidth);
  panelSvg.setAttribute('height',  img.naturalHeight);
  panelSvg.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);

  // Pass the panel SVG directly — no ID swap, no DOM mutation
  const savedFloorId = activeFloorId;
  try {
    activeFloorId = floor.id;
    const triggeredZones = zones.filter(z => {
      const s = getZoneState(z);
      return s === 'triggered' || s === 'fault';
    });
    _renderZonesInternal(panelSvg);
    const afterCount = panelSvg.childNodes.length;
    if (triggeredZones.length > 0 && afterCount === 0) {
      console.warn(`[OW] Panel ${idx}: 0 SVG elements but ${triggeredZones.length} triggered zones! haConnected=${haConnected}, floor=${floor.id}`);
      triggeredZones.forEach(z => console.warn(`  Zone: ${z.name}, pts=${(z.points||[]).length}, state=${getZoneState(z)}, hidden=${z.hidden}`));
    } else {
      console.debug(`[OW] Panel ${idx}: ${afterCount} SVG elements (${triggeredZones.length} triggered)`);
    }
  } finally {
    activeFloorId = savedFloorId;
  }
  renderPins(idx); // render lights & sirens for this panel
}

function renderAllPanelZones() {
  const n = getNumPanels();
  for (let i = 0; i < n; i++) renderPanelZones(i);
}

// Build zoom/pan binding for a panel
function bindPanelInteraction(idx) {
  const panelEl = getPanelEl(idx);
  if (!panelEl) return;

  // Select panel on click — not passive so preventDefault works in pan handler
  panelEl.addEventListener('pointerdown', e => { setActivePanel(idx); }, { capture: true });

  // Pin placement — intercept click on the panel SVG when in placing mode
  panelEl.addEventListener('click', e => {
    // Live mode: zone polygon click opens popup
    if (!editorMode && e.target.classList?.contains('zone-polygon')) {
      const zoneId = e.target.dataset?.zoneId;
      const zone   = zones.find(z => z.id === zoneId);
      if (zone && !zone.hidden) {
        openZonePopup(zoneId, e.clientX, e.clientY);
        e.stopPropagation();
        return;
      }
    }
    if (!placingPinType) return;
    e.stopPropagation();
    const panelSvg = getPanelSvg(idx);
    if (!panelSvg) return;
    const rect = panelSvg.getBoundingClientRect();
    const z    = PANEL_ZOOMS[idx] || { scale: 1, x: 0, y: 0 };
    const fpX  = (e.clientX - rect.left - z.x) / z.scale;
    const fpY  = (e.clientY - rect.top  - z.y) / z.scale;
    const floor = getPanelFloor(idx);
    placePinAtFloorplanCoord(fpX, fpY, floor?.id || null);
  });

  // Zone editor interactions for multi-panel SVGs.
  const panelSvg = getPanelSvg(idx);
  if (panelSvg && !panelSvg._owZoneEditorBound) {
    panelSvg._owZoneEditorBound = true;

    const panelPoint = (e) => {
      const rect = panelEl.getBoundingClientRect();
      const z = PANEL_ZOOMS[idx] || { scale: 1, x: 0, y: 0 };
      return {
        x: (e.clientX - rect.left - z.x) / z.scale,
        y: (e.clientY - rect.top  - z.y) / z.scale,
      };
    };

    panelSvg.addEventListener('pointerdown', e => {
      const target = e.target;
      const sx = e.clientX, sy = e.clientY;
      const fp = panelPoint(e);
      const floor = getPanelFloor(idx);

      if (!editorMode) {
        if (target.classList?.contains('zone-polygon')) {
          const zoneId = target.dataset.zoneId;
          const zone = zones.find(z => z.id === zoneId);
          if (zone?.hidden) { e.stopPropagation(); return; }
          openZonePopup(zoneId, e.clientX, e.clientY);
          e.stopPropagation();
        }
        return;
      }

      if (placingPinType) {
        placePinAtFloorplanCoord(fp.x, fp.y, floor?.id || activeFloorId);
        e.stopPropagation();
        return;
      }

      if (target.classList?.contains('zone-handle')) {
        draggingHandle = { zoneId: target.dataset.zoneId, idx: Number(target.dataset.index) };
        panelSvg.setPointerCapture(e.pointerId);
        e.stopPropagation();
        return;
      }

      if (isEditingPoints && selectedZoneId && !isCreatingZone) {
        const zone = zones.find(z => z.id === selectedZoneId);
        if (zone && (zone.points || []).length >= 2) {
          const insideZone = isPointInPolygon(fp.x, fp.y, zone.points);
          if (!insideZone) {
            const info = closestEdgeInfo(zone, fp.x, fp.y);
            if (info) {
              pushUndo();
              zone.points.splice(info.insertAfter + 1, 0, { x: Math.round(fp.x), y: Math.round(fp.y) });
              saveZone(zone);
              renderZones();
              renderZonesEditor();
              e.stopPropagation();
              return;
            }
          }
        }
      }

      if (target.classList?.contains('zone-polygon')) {
        const zoneId = target.dataset.zoneId;
        const zone = zones.find(z => z.id === zoneId);
        if (zone?.hidden) { e.stopPropagation(); return; }
        if (isEditingPoints && selectedZoneId && zoneId !== selectedZoneId) { e.stopPropagation(); return; }
        if (selectedZoneId === zoneId && !isEditingPoints) {
          clearZoneEditorSelection(true);
          e.stopPropagation();
          return;
        }
        selectedZoneId = zoneId;
        selectedGroupId = null;
        activePinId = null;
        activePinType = null;
        if (isEditingPoints && zone) {
          draggingZone = { zoneId, startPoints: zone.points.map(p => ({ ...p })) };
          dragStart = { x: sx, y: sy };
          panelSvg.setPointerCapture(e.pointerId);
        }
        renderZones();
        renderZonesEditor();
        e.stopPropagation();
        return;
      }

      if (isCreatingZone && currentNewZone) {
        pushUndo();
        currentNewZone.points.push({ x: fp.x, y: fp.y });
        saveZone(currentNewZone);
        renderZones();
        const countSpan = document.querySelector(`.zones-list-item[data-zone-id="${currentNewZone.id}"] span:last-child`);
        if (countSpan) countSpan.textContent = `${currentNewZone.points.length}pts`;
        e.stopPropagation();
        return;
      }

      clearZoneEditorSelection(true);
    });

    panelSvg.addEventListener('pointermove', e => {
      if (!editorMode) return;
      const fp = panelPoint(e);
      if (draggingHandle) {
        const zone = zones.find(z => z.id === draggingHandle.zoneId);
        if (!zone) return;
        zone.points[draggingHandle.idx] = fp;
        saveZone(zone);
        renderZones();
      } else if (draggingZone && dragStart) {
        const zone = zones.find(z => z.id === draggingZone.zoneId);
        if (!zone) return;
        const z = PANEL_ZOOMS[idx] || { scale: 1 };
        const dxF = (e.clientX - dragStart.x) / z.scale;
        const dyF = (e.clientY - dragStart.y) / z.scale;
        zone.points = draggingZone.startPoints.map(p => ({ x: p.x + dxF, y: p.y + dyF }));
        saveZone(zone);
        renderZones();
      }
    });

    panelSvg.addEventListener('pointerup', e => {
      if (draggingHandle || draggingZone) {
        try { panelSvg.releasePointerCapture(e.pointerId); } catch {}
      }
      draggingHandle = null;
      draggingZone = null;
      dragStart = null;
    });

    panelSvg.addEventListener('pointercancel', () => {
      draggingHandle = null;
      draggingZone = null;
      dragStart = null;
    });

    panelSvg.addEventListener('dblclick', e => {
      if (!editorMode || !isCreatingZone || !currentNewZone) return;
      if (currentNewZone.points.length < 3) { alert('A zone needs at least 3 points.'); return; }
      isCreatingZone = false;
      currentNewZone = null;
      saveZones();
      renderZonesEditor();
      scheduleHAReload();
      e.stopPropagation();
    });

    panelSvg.addEventListener('contextmenu', e => {
      if (!editorMode) return;
      e.preventDefault();
      const target = e.target;
      if (target.classList?.contains('zone-handle') && isEditingPoints) {
        const zone = zones.find(z => z.id === target.dataset.zoneId);
        if (!zone || zone.points.length <= 3) return;
        pushUndo();
        zone.points.splice(Number(target.dataset.index), 1);
        saveZone(zone);
        renderZones();
        renderZonesEditor();
      }
    });
  }

  // Pan
  let panning = false, panStart = null;

  panelEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('.zone-handle, .zone-polygon, .floor-panel-handle')) return;
    if (mapLocked && !editorMode) return; // locked
    panning  = true;
    panStart = { x: e.clientX - PANEL_ZOOMS[idx].x, y: e.clientY - PANEL_ZOOMS[idx].y };
  });

  panelEl.addEventListener('pointermove', e => {
    if (!panning) return;
    if (e.pointerType === 'mouse' && e.buttons !== 1) { panning = false; return; }
    PANEL_ZOOMS[idx].x = e.clientX - panStart.x;
    PANEL_ZOOMS[idx].y = e.clientY - panStart.y;
    applyPanelTransform(idx);
  });

  panelEl.addEventListener('pointerup',    () => { panning = false; });
  panelEl.addEventListener('pointercancel',() => { panning = false; });
  // Scroll zoom — always applies to hovered panel regardless of selection
  panelEl.addEventListener('wheel', e => {
    e.preventDefault();
    if (mapLocked && !editorMode) return; // locked
    const factor   = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect     = panelEl.getBoundingClientRect();
    const cx       = e.clientX - rect.left;
    const cy       = e.clientY - rect.top;
    const z        = PANEL_ZOOMS[idx];
    const newScale = Math.min(10, Math.max(0.05, z.scale * factor));
    z.x = cx - (cx - z.x) * (newScale / z.scale);
    z.y = cy - (cy - z.y) * (newScale / z.scale);
    z.scale = newScale;
    // Clamp to prevent shooting off-screen
    const img = getPanelImg(idx);
    if (img && img.naturalWidth) {
      const iw = img.naturalWidth * z.scale;
      const ih = img.naturalHeight * z.scale;
      const margin = 80;
      z.x = Math.min(rect.width  - margin, Math.max(-(iw - margin), z.x));
      z.y = Math.min(rect.height - margin, Math.max(-(ih - margin), z.y));
    }
    applyPanelTransform(idx);
  }, { passive: false });

  // Touch pinch-zoom
  let touches = null, pinchDist0 = null, pinchZoom0 = null;
  panelEl.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      touches    = e.touches;
      pinchDist0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                               e.touches[0].clientY - e.touches[1].clientY);
      pinchZoom0 = PANEL_ZOOMS[idx].scale;
      panning    = false;
    }
  }, { passive: true });
  panelEl.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && pinchDist0) {
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                            e.touches[0].clientY - e.touches[1].clientY);
      PANEL_ZOOMS[idx].scale = Math.min(10, Math.max(0.1, pinchZoom0 * d / pinchDist0));
      applyPanelTransform(idx);
    }
  }, { passive: false });
  panelEl.addEventListener('touchend', () => { pinchDist0 = null; }, { passive: true });
}

// Build/rebuild the multi-panel DOM inside #main
function applyFloorPanels() {
  const n      = getNumPanels();
  const dir    = getPanelsDir();
  const mainEl = document.getElementById('main');
  if (!mainEl) return;

  if (n <= 1) {
    // ── Single panel ── restore original DOM if needed
    if (mainEl.querySelector('.floor-panel')) {
      mainEl.innerHTML = `
        <div id="floorplanWrapper" class="floorplan-wrapper">
          <img id="floorplanImage" src="img/floorplan.png" />
          <svg id="zonesSvg" class="zones-svg"></svg>
          <div id="deviceLayer"></div>
        </div>`;
      // Re-init with saved floor
      activeFloorId = getPanelFloor(0)?.id || floors[0]?.id || null;
      const fp = document.getElementById('floorplanImage');
      const floor = activeFloor();
      if (fp && floor?.floorplan) {
        fp.onload = () => { initFloorplan(); renderZones(); };
        fp.src = apiPath(floor.floorplan) + '?v=' + Date.now();
        if (fp.complete) { initFloorplan(); renderZones(); }
      }
      bindPan(); // re-bind single-panel pan
      setZoneSvgInteractionState();
    }
    // Hide sidebar zoom when returning to single panel
    _updateZoomBtnsVisibility();
    return;
  }

  // ── Multi-panel ── build panel container
  mainEl.innerHTML = ''; // clear existing content
  const container = document.createElement('div');
  container.className = 'floor-panels-container fp-dir-' + dir;
  // Direction only — size and position handled by CSS
  container.style.flexDirection = dir === 'v' ? 'column' : 'row';

  for (let i = 0; i < n; i++) {
    const floor   = getPanelFloor(i);
    const fi      = floors.indexOf(floor);
    const isFirst = fi === 0;

    const panelDiv = document.createElement('div');
    panelDiv.className = 'floor-panel' + (i === activePanelIdx ? ' fp-active' : '');
    panelDiv.dataset.panelIdx = i;
    panelDiv.setAttribute('draggable', 'false');

    // Floor label — hidden if user disabled it
    const label = document.createElement('div');
    label.className = 'floor-panel-label';
    label.textContent = floor?.name || 'Floor ' + (i + 1);
    if (localStorage.getItem('ow_hide_floor_label') === 'true') label.style.display = 'none';

    // Wrapper (panned/scaled)
    const wrapper = document.createElement('div');
    wrapper.className = 'fp-wrapper';
    wrapper.style.cssText = 'position:absolute;top:0;left:0;transform-origin:top left;';

    // Image
    const img = document.createElement('img');
    img.className = 'fp-img';
    img.style.cssText = 'display:block;user-select:none;pointer-events:none;max-width:none;';
    const imgSrc = floor?.floorplan ? apiPath(floor.floorplan) : 'img/floorplan.png';
    // Use floor ID as cache key so image only reloads when floor changes, not every render
    const imgCacheKey = floor?.id || 'default';

    // SVG — must use createElementNS for proper SVG rendering
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fp-svg zones-svg');
    svg.id = 'fp-svg-' + i;
    svg.style.cssText = `position:absolute;top:0;left:0;overflow:visible;pointer-events:${editorMode ? 'all' : 'none'};`;

    wrapper.appendChild(img);
    wrapper.appendChild(svg);
    panelDiv.appendChild(label);
    panelDiv.appendChild(wrapper);
    container.appendChild(panelDiv);

    // Load image then fit and render
    const panelIdx = i;
    const onImgLoad = () => {
      wrapper.style.width  = img.naturalWidth  + 'px';
      wrapper.style.height = img.naturalHeight + 'px';
      svg.setAttribute('width',   img.naturalWidth);
      svg.setAttribute('height',  img.naturalHeight);
      svg.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
      requestAnimationFrame(() => {
        fitPanelToContainer(panelIdx);
        renderPanelZones(panelIdx);
      });
    };
    img.onload = onImgLoad;
    img.src = imgSrc + '?v=' + imgCacheKey;
    // If image was already cached and complete, onload won't fire — call manually
    if (img.complete && img.naturalWidth) onImgLoad();
  }

  // Add draggable resize handle between panels
  if (n === 2) {
    const handle = document.createElement('div');
    handle.className = 'floor-panel-handle';
    // Wider hit area — 8px visible, pointer events on full area
    handle.style.cssText = dir === 'v'
      ? 'height:6px;width:100%;cursor:row-resize;background:rgba(255,255,255,0.06);flex-shrink:0;z-index:10;display:flex;align-items:center;justify-content:center;'
      : 'width:6px;height:100%;cursor:col-resize;background:rgba(255,255,255,0.06);flex-shrink:0;z-index:10;display:flex;align-items:center;justify-content:center;';
    const dot = document.createElement('div');
    dot.style.cssText = dir === 'v'
      ? 'width:40px;height:2px;background:rgba(255,255,255,0.25);border-radius:2px;pointer-events:none;'
      : 'height:40px;width:2px;background:rgba(255,255,255,0.25);border-radius:2px;pointer-events:none;';
    handle.appendChild(dot);
    container.insertBefore(handle, container.children[1]);

    let dragging = false, startPct = 50, startPos = 0;
    handle.addEventListener('pointerdown', e => {
      if (mapLocked) return; // locked — don't allow panel resize
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      startPos = dir === 'v' ? e.clientY : e.clientX;
      const panels = container.querySelectorAll('.floor-panel');
      const total  = dir === 'v' ? container.offsetHeight : container.offsetWidth;
      const p0Size = dir === 'v' ? panels[0].offsetHeight : panels[0].offsetWidth;
      startPct = (p0Size / total) * 100;
      handle.style.background = 'rgba(0,150,255,0.5)';
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const panels = container.querySelectorAll('.floor-panel');
      if (panels.length < 2) return;
      const total = dir === 'v' ? container.offsetHeight : container.offsetWidth;
      const delta = (dir === 'v' ? e.clientY : e.clientX) - startPos;
      const newPct = Math.min(80, Math.max(20, startPct + (delta / total) * 100));
      panels[0].style.flex = `0 0 ${newPct.toFixed(1)}%`;
      panels[1].style.flex = '1';
      [0, 1].forEach(i => fitPanelToContainer(i));
    });
    handle.addEventListener('pointerup', () => {
      dragging = false;
      handle.style.background = 'rgba(255,255,255,0.06)';
      // Save split position
      const panels = container.querySelectorAll('.floor-panel');
      if (panels.length >= 2) {
        const total = dir === 'v' ? container.offsetHeight : container.offsetWidth;
        const p0    = dir === 'v' ? panels[0].offsetHeight : panels[0].offsetWidth;
        localStorage.setItem('ow_fp_split_pct', ((p0 / total) * 100).toFixed(1));
      }
    });
    handle.addEventListener('mouseenter', () => { if (!dragging) handle.style.background = 'rgba(0,150,255,0.5)'; });
    handle.addEventListener('mouseleave', () => { if (!dragging) handle.style.background = 'rgba(255,255,255,0.06)'; });
  }

  mainEl.appendChild(container);

  // Restore saved floor panel split position
  if (n === 2) {
    const savedPct = localStorage.getItem('ow_fp_split_pct');
    if (savedPct) {
      const pct = Math.min(80, Math.max(20, parseFloat(savedPct)));
      // Apply after layout — use rAF so container has dimensions
      requestAnimationFrame(() => {
        const panels = container.querySelectorAll('.floor-panel');
        if (panels.length >= 2) {
          panels[0].style.flex = `0 0 ${pct.toFixed(1)}%`;
          panels[1].style.flex = '1';
          [0, 1].forEach(i => fitPanelToContainer(i));
        }
      });
    }
  }

  // Bind interactions for each panel
  for (let i = 0; i < n; i++) bindPanelInteraction(i);
  setZoneSvgInteractionState();

  // Update zoom buttons
  _updateZoomBtnsVisibility();
  setActivePanel(activePanelIdx < n ? activePanelIdx : 0);
}

// Show/hide sidebar zoom buttons based on panel count
function _updateZoomBtnsVisibility() {
  const multi = getNumPanels() > 1;
  ['zoomIn','zoomOut','zoomReset'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.opacity = multi ? '0.45' : '';
    // Don't disable — just visually indicate they apply to selected panel
  });
}

// Override sidebar zoom/reset to apply to active panel in multi-panel mode
function bindZoomControlsMultiPanel() {
  const zoomIn    = document.getElementById('zoomIn');
  const zoomOut   = document.getElementById('zoomOut');
  const zoomReset = document.getElementById('zoomReset');
  if (!zoomIn) return;

  function zoomPanel(factor) {
    if (getNumPanels() <= 1) return; // handled by existing bindZoomControls
    const panelEl = getPanelEl(activePanelIdx);
    if (!panelEl) return;
    const vw = panelEl.offsetWidth / 2;
    const vh = panelEl.offsetHeight / 2;
    const z  = PANEL_ZOOMS[activePanelIdx];
    z.x      = vw - (vw - z.x) * factor;
    z.y      = vh - (vh - z.y) * factor;
    z.scale  = Math.min(10, Math.max(0.1, z.scale * factor));
    applyPanelTransform(activePanelIdx);
  }

  // Wrap existing onclick handlers to intercept multi-panel mode
  const origIn    = zoomIn.onclick;
  const origOut   = zoomOut.onclick;
  const origReset = zoomReset.onclick;

  zoomIn.onclick = () => {
    if (mapLocked && !editorMode) return;
    if (getNumPanels() > 1) zoomPanel(1.15); else origIn?.();
  };
  zoomOut.onclick = () => {
    if (mapLocked && !editorMode) return;
    if (getNumPanels() > 1) zoomPanel(1 / 1.15); else origOut?.();
  };
  zoomReset.onclick = () => {
    if (mapLocked && !editorMode) return;
    if (getNumPanels() > 1) fitPanelToContainer(activePanelIdx); else origReset?.();
  };
}

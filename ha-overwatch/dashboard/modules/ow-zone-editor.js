/* ─── HA-Overwatch Zone Editor Module ─────────────────────────
 * Stable baseline: v1.551.36.11.
 * Scope: Zone Editor panel rendering, device rows/search, draggable editor helper.
 * Classic browser script; load before app.js.
 * Deliberately excludes SVG/map runtime events, zone popup rendering, and status dropdowns.
 */

/* ─── ZONES EDITOR PANEL (draggable) ──────────────────────── */
let editorPosRestored = false;
let editorDrag = { active: false, startX: 0, startY: 0 };
let editorSize = { w: 560, h: 420 };
let editorPos  = { x: 20, y: 70 };

// Restore saved editor size and position
(function() {
  const sw = localStorage.getItem('editorW'), sh = localStorage.getItem('editorH');
  if (sw) editorSize.w = Math.max(240, parseInt(sw));
  if (sh) editorSize.h = Math.max(300, parseInt(sh));
  const sx = localStorage.getItem('editorX'), sy = localStorage.getItem('editorY');
  if (sx !== null) editorPos.x = Math.max(0, Math.min(window.innerWidth  - 50, parseInt(sx)));
  if (sy !== null) editorPos.y = Math.max(0, Math.min(window.innerHeight - 50, parseInt(sy)));
})();

function makeDraggableEditor(containerEl) {
  const container = containerEl || document.getElementById("zonesEditorContainer");
  if (!container) return;
  const panel = container.querySelector(".zones-editor");
  const titlebar = container.querySelector(".zones-editor-titlebar");
  if (!panel || !titlebar) return;

  // Restore saved position only once per session
  if (!editorPosRestored) {
    editorPosRestored = true;
    const savedX = localStorage.getItem("editorX");
    const savedY = localStorage.getItem("editorY");
    if (savedX !== null) editorPos.x = Math.max(0, Math.min(window.innerWidth  - 50, parseInt(savedX)));
    if (savedY !== null) editorPos.y = Math.max(0, Math.min(window.innerHeight - 50, parseInt(savedY)));
  }

  panel.style.left = editorPos.x + "px";
  panel.style.top  = editorPos.y + "px";

  // Remove any old listeners by cloning the titlebar (simplest approach)
  const newTitlebar = titlebar.cloneNode(true);
  titlebar.parentNode.replaceChild(newTitlebar, titlebar);

  newTitlebar.addEventListener("pointerdown", e => {
    // Don't drag if clicking the close button
    if (e.target.closest(".zones-editor-close")) return;
    editorDrag.active = true;
    editorDrag.startX = e.clientX - editorPos.x;
    editorDrag.startY = e.clientY - editorPos.y;
    newTitlebar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  newTitlebar.addEventListener("pointermove", e => {
    if (!editorDrag.active) return;
    editorPos.x = Math.max(0, Math.min(window.innerWidth  - 50, e.clientX - editorDrag.startX));
    editorPos.y = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - editorDrag.startY));
    panel.style.left = editorPos.x + "px";
    panel.style.top  = editorPos.y + "px";
  });

  newTitlebar.addEventListener("pointerup", () => {
    editorDrag.active = false;
    localStorage.setItem("editorX", editorPos.x);
    localStorage.setItem("editorY", editorPos.y);
  });

  // Re-wire close button on the cloned titlebar
  const closeBtn = newTitlebar.querySelector("#zonesCloseBtn");
  if (closeBtn) {
    closeBtn.onclick = () => {
      editorMode = false;
      isCreatingZone = false;
      isEditingPoints = false;
      currentNewZone = null;
      activePinId = null; activePinType = null;
      placingPinType = null; placingEntityId = null;
      editorPosRestored = false;
      setZoneSvgInteractionState();
      const zonesBtn = document.getElementById("zonesBtn");
      if (zonesBtn) zonesBtn.classList.remove("active");
      closeDoorLinksPopover();
      renderZonesEditor();
      renderZones();
    };
  }
}

/* ─── PIN RENDERING (LIGHTS & SIRENS) ────────────────────── */
// panelIdx: undefined = single panel, number = multi-panel index

function renderZonesEditor(force = false) {
  const container = document.getElementById("zonesEditorContainer");
  if (!container) return;

  if (!editorMode) { container.innerHTML = ""; return; }

  // Don't blow away DOM while the user is interacting with editor controls.
  if (!force && zoneEditorHasActiveControl(container)) {
    refreshEntityStateDots(container);
    return;
  }
  const __zedScrollState = captureZoneEditorScrollState(container);

  const selectedZone  = selectedZoneId  ? zones.find(z => z.id === selectedZoneId)   : null;
  const selectedGroup = selectedGroupId ? groups.find(g => g.id === selectedGroupId) : null;

  const needsPoints   = selectedZone && (selectedZone.points || []).length < 3;
  const editPtsLabel  = isCreatingZone ? "✏️ Adding Points" : isEditingPoints ? "✔ Done Editing" : needsPoints ? "Add Points" : "Edit Zone";
  const hasSelection = !!(selectedZone || selectedGroup || activePinId);
  // Use saved size if user has customised it, otherwise default narrow when nothing selected
  // When something is selected, guarantee both panels fit
  const editorW = hasSelection ? Math.max(editorSize.w, 420) : 260;
  const editorH = editorSize.h;

  // ── Build left panel zone list with group headers ──────────
  function buildZoneList() {
    // Only show zones on the active floor
    const curFloorId = activeFloorId;
    const firstFloor = !curFloorId || floors.length === 0 || floors[0]?.id === curFloorId;
    const floorZones = floors.length > 1
      ? zones.filter(z => z.floor_id === curFloorId || (!z.floor_id && firstFloor))
      : zones;

    const sortedGroups = [...groups].sort((a, b) => (a.name||"").localeCompare(b.name||""));
    const groupedZoneIds = new Set(groups.flatMap(g => g.zone_ids || []));
    const ungroupedZones = floorZones.filter(z => !groupedZoneIds.has(z.id))
      .sort((a, b) => (a.name||a.id).localeCompare(b.name||b.id));
    let html = "";

    sortedGroups.forEach(g => {
      // Skip groups with no members on current floor
      const hasFloorMembers = (g.zone_ids || []).some(id => floorZones.find(z => z.id === id));
      // Always show selected group or groups with no members yet (newly created)
      if (floors.length > 1 && !hasFloorMembers && g.id !== selectedGroupId && (g.zone_ids || []).length > 0) return;
      const gSel = g.id === selectedGroupId;
      const gState = getGroupState(g);
      const gHex    = g.colorHex || "#ff3b30";
      const gColour = gState.anyTriggered ? "#ff3b30" : gState.anyArmed ? gHex : gHex;
      const gOpacity = gState.anyArmed ? 1 : 0.35;
      const gFlash  = gState.anyTriggered;
      const storageKey = `zedGroup_${g.id}`;
      const collapsed  = localStorage.getItem(storageKey) !== "expanded";
      html += `
        <div class="zed-group-header ${gSel ? 'selected' : ''}" data-group-id="${g.id}" data-storage-key="${storageKey}">
          <div class="zone-list-dot${gFlash ? ' flashing' : ''}" style="background:${gColour};opacity:${gOpacity};width:6px;height:6px;flex-shrink:0;"></div>
          <span style="flex:1;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(g.name || g.id)}</span>
          <span class="zed-chevron" style="font-size:11px;color:#555;transition:transform 0.2s;display:inline-block;transform:rotate(${collapsed ? '-90' : '0'}deg);">▾</span>
        </div>
        <div class="zed-group-members" data-group-id="${g.id}" style="${collapsed ? 'display:none;' : ''}">`;
      const memberZones = (g.zone_ids || [])
        .map(id => floorZones.find(zz => zz.id === id))
        .filter(Boolean)
        .sort((a, b) => (a.name||a.id).localeCompare(b.name||b.id));
      memberZones.forEach(z => { html += buildZoneItem(z, true); });
      html += `</div>`;
    });

    if (ungroupedZones.length > 0) {
      html += `<div class="zed-group-header" style="cursor:default;">
        <div style="width:6px;height:6px;flex-shrink:0;background:transparent;"></div>
        <span style="flex:1;font-size:11px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:0.06em;">Ungrouped</span>
      </div>`;
      ungroupedZones.forEach(z => { html += buildZoneItem(z, false); });
    }
    return html || `<div style="color:#555;font-size:11px;padding:8px;">No zones yet.</div>`;
  }

  function buildZoneItem(z, indented) {
    const state = getZoneState(z);
    const isOff = getZoneState(z) === "disabled";
    const activeEntity = zoneActiveTriggerEntity(z);
    const dotColour = isOff ? "#444" :
      state === "triggered" ? resolveColour(entityTypeColour(detectEntityType(activeEntity || (z.sensors||[])[0] || "door"))) :
      state === "fault" ? "#ff9500" : (z.colorHex || "#0096ff");
    const sel = z.id === selectedZoneId;
    return `<div class="zones-list-item ${sel ? 'selected' : ''}" data-zone-id="${z.id}" style="${indented ? 'padding-left:20px;' : ''}">
      <div class="zone-list-dot" style="background:${dotColour};opacity:${isOff ? 0.4 : 1};"></div>
      <span style="flex:1;opacity:${isOff ? 0.5 : 1};font-size:12px;">${escapeHtml(z.name || z.id)}</span>
      ${z.hidden ? `<span style="font-size:9px;color:#555;">hidden</span>` : state === "triggered" ? `<span style="font-size:9px;color:#ff3b30;">⚠</span>` : `<span style="font-size:9px;color:#444;">${(z.points||[]).length}pt</span>`}
    </div>`;
  }

  // ── Build pin right panel (light, siren, camera or door) ─────
  function buildPinRightPanel() {
    const pin = activePinType === 'light'   ? lights.find(p => p.id === activePinId)
              : activePinType === 'siren'   ? sirens.find(p => p.id === activePinId)
              : activePinType === 'camera'  ? cameraPins.find(p => p.id === activePinId)
              : activePinType === 'door'    ? doorPins.find(p => p.id === activePinId)
              : null;
    if (!pin) return '';

    const isLight  = activePinType === 'light';
    const isCamera = activePinType === 'camera';
    const isDoor   = activePinType === 'door';
    const label    = isLight ? 'Light' : isCamera ? 'Camera' : isDoor ? 'Door' : 'Siren';
    const icon     = isLight ? '💡'   : isCamera ? '📷'     : isDoor ? '🚪'   : '🔊';

    return `
      <div class="zed-right-content">
        <div class="zones-editor-section-title">${icon} ${label}</div>
        <div class="zones-editor-row">
          <label>Name</label>
          <input id="pinNameInput" class="zones-editor-input" value="${escapeHtml(pin.name || '')}" placeholder="Name">
        </div>
        ${isDoor ? `
        <div class="zones-editor-row">
          <label>Sensor entity</label>
          <div style="position:relative;flex:1;">
            <input id="pinEntityInput" class="zones-editor-input" value="${escapeHtml(pin.sensor_entity || '')}"
              placeholder="binary_sensor.door_contact" autocomplete="off" style="width:100%;">
            <div id="pinEntityResults" style="display:none;position:absolute;top:100%;left:0;right:0;background:#1a1a1a;border:1px solid rgba(255,255,255,0.15);border-radius:6px;z-index:100;max-height:160px;overflow-y:auto;"></div>
          </div>
        </div>
        <div class="zones-editor-row">
          <label>Control entity</label>
          <div style="position:relative;flex:1;">
            <input id="pinControlEntityInput" class="zones-editor-input" value="${escapeHtml(pin.control_entity || '')}"
              placeholder="lock.* or switch.* (optional)" autocomplete="off" style="width:100%;">
            <div id="pinCtrlResults" style="display:none;position:absolute;top:100%;left:0;right:0;background:#1a1a1a;border:1px solid rgba(255,255,255,0.15);border-radius:6px;z-index:100;max-height:160px;overflow-y:auto;"></div>
          </div>
        </div>

        <div style="position:relative;margin-top:6px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:12px;color:#aaa;flex:1;display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="pinControlCountsChk" ${pin.control_counts_as_trigger ? 'checked' : ''} style="accent-color:#0096ff;">
              <span>Count control entity as triggered</span>
            </label>
            <button id="pinControlTriggerCog" title="Trigger settings" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#888;border-radius:7px;padding:4px 8px;cursor:pointer;font-size:12px;line-height:1;">⚙</button>
          </div>
          <div id="pinControlTriggerPopover" style="display:none;position:absolute;right:0;top:100%;margin-top:6px;background:rgba(14,14,14,0.98);border:1px solid rgba(255,255,255,0.12);border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,0.65);padding:10px 12px;z-index:120;min-width:220px;">
            <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#666;margin-bottom:6px;">Trigger when control state is…</div>
            <select id="pinControlTriggerSelect" style="width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:7px 8px;color:#ddd;font-size:12px;">
              <option value="">Auto</option>
              <option value="unlocked">unlocked</option>
              <option value="open">open</option>
              <option value="on">on</option>
            </select>
            <div style="font-size:10px;color:#555;margin-top:6px;line-height:1.25;">Auto infers: lock→unlocked, cover→open, switch→on. Unknown domains do nothing unless overridden.</div>
          </div>
        </div>

        <div style="margin-top:10px;">
          <label style="font-size:12px;color:#aaa;">Linked zones</label>
          <input id="pinZonesSearchInput" type="text" value="" placeholder="Search zones…" autocomplete="off"
            style="width:100%;margin-top:6px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:6px 8px;color:#ccc;font-size:12px;outline:none;">
          <div id="pinZonesList" style="margin-top:6px;border:1px solid rgba(255,255,255,0.10);border-radius:10px;padding:6px 8px;max-height:160px;overflow:auto;"></div>
          <div style="font-size:10px;color:#555;margin-top:3px;">Checked zones float to the top. List is alphabetical.</div>
        </div>

        <div style="margin-top:10px;">
          <label style="font-size:12px;color:#aaa;">Door type</label>
          <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
            <button id="doorTypeSingle"  class="settings-toggle ${(pin.doorType||'single')==='single' ?'active':''}" style="flex:1;font-size:11px;min-width:60px;">Single</button>
            <button id="doorTypeDouble"  class="settings-toggle ${pin.doorType==='double' ?'active':''}" style="flex:1;font-size:11px;min-width:60px;">Double</button>
            <button id="doorTypeSliding" class="settings-toggle ${pin.doorType==='sliding'?'active':''}" style="flex:1;font-size:11px;min-width:60px;">Sliding</button>
          </div>
        </div>
        <div style="margin-top:8px;${(pin.doorType==='double'||pin.doorType==='sliding')?'display:none;':''}" id="doorHandRow">
          <label style="font-size:12px;color:#aaa;">Hinge side</label>
          <div style="display:flex;gap:6px;margin-top:4px;">
            <button id="doorHandLeft"  class="settings-toggle ${(pin.doorHand||'left')==='left' ?'active':''}" style="flex:1;font-size:11px;">Left</button>
            <button id="doorHandRight" class="settings-toggle ${pin.doorHand==='right'?'active':''}" style="flex:1;font-size:11px;">Right</button>
          </div>
        </div>
        <div style="margin-top:8px;">
          <label style="font-size:12px;color:#aaa;">Width <span id="pinSizeWVal" style="color:#64b4ff;font-weight:600;">${pin.sizeW||20}</span></label>
          <input id="pinSizeWInput" type="range" min="4" max="100" step="1" value="${pin.sizeW||20}"
            style="width:100%;accent-color:#64b4ff;margin-top:4px;display:block;">
          <div style="font-size:10px;color:#555;margin-top:1px;">Door opening width on map</div>
        </div>
        <div style="margin-top:6px;">
          <label style="font-size:12px;color:#aaa;">Height <span id="pinSizeDVal" style="color:#64b4ff;font-weight:600;">${pin.sizeH||4}</span></label>
          <input id="pinSizeDInput" type="range" min="1" max="30" step="1" value="${pin.sizeH||4}"
            style="width:100%;accent-color:#64b4ff;margin-top:4px;display:block;">
          <div style="font-size:10px;color:#555;margin-top:1px;">Frame/wall thickness on map</div>
        </div>
        <div style="margin-top:6px;">
          <label style="font-size:12px;color:#aaa;">Aura radius <span id="pinAuraRadVal" style="color:#ff6b6b;font-weight:600;">${pin.auraRadius||3}</span></label>
          <input id="pinAuraRadInput" type="range" min="1" max="10" step="1" value="${pin.auraRadius||3}"
            style="width:100%;accent-color:#ff6b6b;margin-top:4px;display:block;">
          <div style="font-size:10px;color:#555;margin-top:1px;">Open door aura size</div>
        </div>
        <div style="margin-top:8px;">
          <label style="font-size:12px;color:#aaa;">Rotation <span id="pinRotationVal" style="color:#64b4ff;font-weight:600;">${pin.rotation || 0}°</span></label>
          <input id="pinRotationInput" type="range" min="0" max="359" step="1" value="${pin.rotation || 0}"
            style="width:100%;accent-color:#64b4ff;margin-top:4px;display:block;">
          <div style="font-size:10px;color:#555;margin-top:2px;">Rotate to align with wall</div>
        </div>` : `
        <div class="zones-editor-row">
          <label>Entity</label>
          <input id="pinEntityInput" class="zones-editor-input" value="${escapeHtml(pin.entity_id || '')}"
            placeholder="${isLight ? 'light.* or switch.*' : isCamera ? 'camera.*' : 'switch.* or siren.*'}" autocomplete="off">
        </div>`}
        ${isLight ? `
        <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;">
          <label style="font-size:12px;color:#aaa;">Range <span id="pinRadiusVal" style="color:#ffcc44;font-weight:600;">${pin.radius || 3}</span></label>
          <input id="pinRadiusInput" type="range" min="1" max="10" step="1" value="${pin.radius || 3}"
            style="width:100%;accent-color:#ffcc44;margin-top:4px;display:block;">
          <div style="font-size:10px;color:#555;margin-top:2px;">Distance glow extends from icon</div>
        </div>
        <div style="margin-top:12px;">
          <label style="font-size:12px;color:#aaa;">Direction <span id="pinDirVal" style="color:#ffcc44;font-weight:600;">${pin.direction !== null && pin.direction !== undefined && pin.direction !== '' ? pin.direction + '°' : 'none'}</span></label>
          <input id="pinDirectionInput" type="range" min="-1" max="359" step="1" value="${pin.direction !== null && pin.direction !== undefined && pin.direction !== '' ? pin.direction : -1}"
            style="width:100%;accent-color:#ffcc44;margin-top:4px;display:block;">
          <div style="font-size:10px;color:#555;margin-top:2px;">Slide fully left for omnidirectional glow</div>
        </div>
        <div id="pinSpreadRow" style="margin-top:12px;${(pin.direction !== null && pin.direction !== undefined && pin.direction !== '') ? '' : 'display:none;'}">
          <label style="font-size:12px;color:#aaa;">Spread <span id="pinSpreadVal" style="color:#ffcc44;font-weight:600;">${pin.spread || 35}°</span></label>
          <input id="pinSpreadInput" type="range" min="5" max="90" step="5" value="${pin.spread || 35}"
            style="width:100%;accent-color:#ffcc44;margin-top:4px;display:block;">
          <div style="font-size:10px;color:#555;margin-top:2px;">Cone half-angle — narrow for spotlight, wide for flood</div>
        </div>
        ` : ''}
        <div class="zones-editor-row" style="margin-top:4px;">
          <label style="color:#555;font-size:11px;">Position</label>
          <span style="font-size:11px;color:#555;">${Math.round(pin.x)}, ${Math.round(pin.y)}</span>
        </div>
        ${isLight ? `
        <div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">
          <label style="font-size:12px;color:#aaa;">Tap action</label>
          <div style="display:flex;gap:6px;margin-top:4px;">
            <button id="pinTapThis" class="settings-toggle ${!pin.tapAll && !pin.tapAllSirens ? 'active' : ''}" style="flex:1;font-size:11px;">This light</button>
            <button id="pinTapAll"  class="settings-toggle ${pin.tapAll ? 'active' : ''}" style="flex:1;font-size:11px;">All zone lights</button>
          </div>
        </div>` : isCamera ? `
        <div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">
          <div style="font-size:11px;color:#666;">Tap opens full-screen camera view.</div>
        </div>` : isDoor ? `
        <div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">
          <div style="font-size:11px;color:#666;">Tap will show a confirmation before toggling the control entity.</div>
        </div>` : `
        <div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">
          <label style="font-size:12px;color:#aaa;">Tap action</label>
          <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
            <button id="pinTapThis"       class="settings-toggle ${!pin.tapZone && !pin.tapAll ? 'active' : ''}" style="flex:1;font-size:11px;min-width:80px;">This siren</button>
            <button id="pinTapZone"       class="settings-toggle ${pin.tapZone ? 'active' : ''}"                 style="flex:1;font-size:11px;min-width:80px;">Zone sirens</button>
            <button id="pinTapAllSirens"  class="settings-toggle ${pin.tapAll  ? 'active' : ''}"                 style="flex:1;font-size:11px;min-width:80px;">All sirens</button>
          </div>
        </div>
        <div style="margin-top:10px;">
          <label style="font-size:12px;color:#aaa;">Aura radius <span id="pinRadiusVal" style="color:#ff6666;font-weight:600;">${pin.radius || 4}</span></label>
          <input id="pinRadiusInput" type="range" min="1" max="10" step="1" value="${pin.radius || 4}"
            style="width:100%;accent-color:#ff6666;margin-top:4px;display:block;">
          <div style="font-size:10px;color:#555;margin-top:2px;">Pulsing ring size when active</div>
        </div>`}
        <button id="pinDoneBtn" style="margin-top:10px;background:rgba(0,150,255,0.15);border:1px solid rgba(0,150,255,0.4);color:#0096ff;border-radius:8px;padding:6px 12px;cursor:pointer;width:100%;font-size:12px;">Done</button>
        <button id="pinDeleteBtn" style="margin-top:6px;background:rgba(255,59,48,0.15);border:1px solid rgba(255,59,48,0.4);color:#ff3b30;border-radius:8px;padding:6px 12px;cursor:pointer;width:100%;font-size:12px;">Delete ${label}</button>
      </div>`;
  }

  // ── Build right panel ──────────────────────────────────────
  function buildRightPanel() {
    if (selectedGroup && !selectedZone) {
      // Group config panel
      const members = (selectedGroup.zone_ids || []).map(id => zones.find(z => z.id === id)).filter(Boolean);
      const allArmed = members.length > 0 && members.every(z => getZoneState(z) !== 'disabled');
      return `
        <div class="zed-right-content">
          <div class="zones-editor-row"><label>Group Name</label>
            <input type="text" id="groupNameInput" value="${escapeHtml(selectedGroup.name || "")}" placeholder="Group name">
          </div>
          <div class="zones-editor-row"><label>Colour</label>
            <input type="color" id="groupColorInput" value="${selectedGroup.colorHex || '#ff3b30'}">
          </div>
          <div class="zones-editor-row" style="align-items:center;">
            <label>Group Armed</label>
            <label class="zone-toggle-switch">
              <input type="checkbox" id="groupArmedToggle" ${allArmed ? "checked" : ""}>
              <span class="zone-toggle-track"></span>
            </label>
          </div>
          <div style="font-size:11px;color:#666;margin-top:4px;">Members</div>
          <div id="groupMemberList" style="border:1px solid #222;border-radius:8px;padding:4px;flex:1;overflow-y:auto;">
            ${[...zones]
              .sort((a, b) => {
                const aIn = (selectedGroup.zone_ids || []).includes(a.id);
                const bIn = (selectedGroup.zone_ids || []).includes(b.id);
                if (aIn !== bIn) return aIn ? -1 : 1; // checked first
                return (a.name||a.id).localeCompare(b.name||b.id);
              })
              .map(z => {
                const inGroup = (selectedGroup.zone_ids || []).includes(z.id);
                return `<label style="display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:6px;${inGroup ? 'background:rgba(255,255,255,0.04);' : ''}">
                  <input type="checkbox" class="group-member-chk" data-zone-id="${z.id}" ${inGroup ? "checked" : ""} style="accent-color:#0096ff;">
                  <div class="zone-list-dot" style="background:${z.colorHex || '#0096ff'};width:6px;height:6px;flex-shrink:0;"></div>
                  <span style="font-size:12px;color:${inGroup ? '#fff' : '#888'};">${escapeHtml(z.name || z.id)}</span>
                  ${floors.length > 1 ? `<span style="font-size:10px;color:#555;margin-left:auto;">${escapeHtml(floors.find(f => f.id === z.floor_id)?.name || floors[0]?.name || '')}</span>` : ''}
                </label>`;
              }).join("")}
          </div>
        </div>`;
    }

    if (selectedZone) {
      // Zone config panel
      const modeHint = isCreatingZone
        ? `<div class="zone-mode-hint">✏️ Click map to add points · Double-click to finish</div>`
        : isEditingPoints
        ? `<div class="zone-mode-hint">🔧 Click edge to insert · Right-click handle to remove</div>`
        : "";
      return `
        <div class="zed-right-content">
          ${modeHint}
          <div class="zones-editor-row"><label>Name</label>
            <input type="text" id="zoneNameInput" value="${escapeHtml(selectedZone.name || "")}" placeholder="Zone name">
          </div>
          <div class="zones-editor-row"><label>Colour</label>
            <input type="color" id="zoneColorInput" value="${selectedZone.colorHex || '#0096ff'}">
          </div>
          <div class="zones-editor-row" style="align-items:center;gap:8px;">
            <label style="flex:0 0 auto;">Armed</label>
            <label class="zone-toggle-switch">
              <input type="checkbox" id="zoneEnabledToggle" ${zoneIsEnabled(selectedZone) ? "checked" : ""}>
              <span class="zone-toggle-track"></span>
            </label>
            <span style="flex:1;"></span>
            <span style="font-size:11px;color:#666;">Visible</span>
            <button id="zoneHiddenToggle"
              style="background:none;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;cursor:pointer;line-height:0;color:${selectedZone.hidden ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.7)'};"
            >${selectedZone.hidden
              ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 12 5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
              : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 12 5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>`
            }</button>
          </div>
          ${floors.length > 1 ? `
          <div class="zones-editor-row" style="align-items:center;">
            <label style="flex:0 0 auto;">Floor</label>
            <select id="zoneFloorSelect" style="flex:1;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;color:#fff;font-size:12px;">
              ${floors.map(f => `<option value="${f.id}" ${(selectedZone.floor_id || floors[0]?.id) === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
            </select>
          </div>` : ''}
          <div class="zones-editor-row" style="align-items:center;">
            <label style="flex:0 0 auto;">Group</label>
            <select id="zoneGroupSelect" style="flex:1;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;color:#fff;font-size:12px;">
              <option value="">— Ungrouped —</option>
              ${[...groups].sort((a,b)=>(a.name||a.id).localeCompare(b.name||b.id)).map(g => `<option value="${escapeHtml(g.id)}" ${currentGroupIdForZone(selectedZone.id) === g.id ? 'selected' : ''}>${escapeHtml(g.name || g.id)}</option>`).join('')}
            </select>
          </div>
          <div class="zones-editor-row" style="align-items:center;">
            <label style="flex:0 0 auto;">HA Area</label>
            <select id="zoneHAAreaSelect" style="flex:1;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;color:#fff;font-size:12px;">
              <option value="">— None —</option>
              ${(_haRegistry.areas||[]).map(a => `<option value="${escapeHtml(a.area_id)}" ${selectedZone.ha_area_id === a.area_id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
            </select>
            ${selectedZone.ha_area_id ? `<button id="zoneHAAreaSync" title="Sync entities from HA area" style="background:rgba(0,150,255,0.1);border:1px solid rgba(0,150,255,0.3);color:#4db8ff;border-radius:7px;padding:5px 8px;cursor:pointer;font-size:11px;margin-left:6px;flex-shrink:0;">↻ Sync</button>` : ''}
          </div>
          <div class="ha-section" style="margin-top:2px;flex:1;display:flex;flex-direction:column;">
            <div class="ha-device-tabs" id="haDeviceTabs">
              <button class="ha-device-tab ${_activeZoneTab==='sensors'?'active':''}" data-tab="sensors">Sensors</button>
              <button class="ha-device-tab ${_activeZoneTab==='cameras'?'active':''}" data-tab="cameras">Cameras</button>
              <button class="ha-device-tab ${_activeZoneTab==='lights'?'active':''}" data-tab="lights">Lights</button>
              <button class="ha-device-tab ${_activeZoneTab==='sirens'?'active':''}" data-tab="sirens">Sirens</button>
              <button class="ha-device-tab ${_activeZoneTab==='doors'?'active':''}" data-tab="doors">Doors &amp; Windows</button>
            </div>
            <div class="ha-tab-panel" id="tabPanel_sensors" style="${_activeZoneTab==='sensors'?'flex:1;overflow-y:auto;':'display:none;'}">
              <div class="entity-search-wrap"><input type="text" id="entitySearchInput" class="entity-search-input" placeholder="Search HA entities…" autocomplete="off">
              <div class="entity-search-results" id="entitySearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneEntityList">${(selectedZone.sensors||[]).map(e=>deviceRow(e,"sensors",selectedZone)).join("")}</div>
            </div>
            <div class="ha-tab-panel" id="tabPanel_cameras" style="${_activeZoneTab==='cameras'?'flex:1;overflow-y:auto;':'display:none;'}">
              <div class="entity-search-wrap"><input type="text" id="cameraSearchInput" class="entity-search-input" placeholder="Search camera entities…" autocomplete="off">
              <div class="entity-search-results" id="cameraSearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneCameraList">${(selectedZone.cameras||[]).map(e=>deviceRow(e,"cameras",selectedZone)).join("")}</div>
            </div>
            <div class="ha-tab-panel" id="tabPanel_lights" style="${_activeZoneTab==='lights'?'flex:1;overflow-y:auto;':'display:none;'}">
              <div class="entity-search-wrap"><input type="text" id="lightSearchInput" class="entity-search-input" placeholder="Search light entities…" autocomplete="off">
              <div class="entity-search-results" id="lightSearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneLightList">${(selectedZone.lights||[]).map(e=>deviceRow(e,"lights",selectedZone)).join("")}</div>
            </div>
            <div class="ha-tab-panel" id="tabPanel_sirens" style="${_activeZoneTab==='sirens'?'flex:1;overflow-y:auto;':'display:none;'}">
              <div class="entity-search-wrap"><input type="text" id="sirenSearchInput" class="entity-search-input" placeholder="Search siren entities…" autocomplete="off">
              <div class="entity-search-results" id="sirenSearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneSirenList">${(selectedZone.sirens||[]).map(e=>deviceRow(e,"sirens",selectedZone)).join("")}</div>
            </div>
            <div class="ha-tab-panel" id="tabPanel_doors" style="${_activeZoneTab==='doors'?'flex:1;overflow-y:auto;':'display:none;'}">
              <div style="font-size:11px;color:#555;padding:6px 0 8px;">Place door &amp; window sensors on the map. Each has a sensor (open/closed) and an optional control entity (lock/switch). Use the search below to add a sensor without placing it on the map.</div>
              <div class="entity-search-wrap"><input type="text" id="doorSearchInput" class="entity-search-input" placeholder="Search doors &amp; windows…" autocomplete="off">
              <div class="entity-search-results" id="doorSearchResults" style="display:none;"></div></div>
              <div class="ha-entity-list" id="zoneDoorList">${doorPins.filter(p=>doorPinZoneIds(p).includes(selectedZone.id)).map(p=>doorPinRow(p, selectedZone)).join("")}</div>
              <button id="addDoorPinBtn" style="margin-top:8px;width:100%;background:rgba(0,150,255,0.1);border:1px solid rgba(0,150,255,0.3);color:#0096ff;border-radius:6px;padding:6px;cursor:pointer;font-size:12px;">+ Place Door or Window on Map</button>
            </div>
          </div>
        </div>`;
    }

    // Nothing selected — hide right panel
    return ``;
  }

  container.innerHTML = `
    <div class="zones-editor" style="left:${editorPos.x}px;top:${editorPos.y}px;width:${editorW}px;height:${editorH}px;">
      <div class="zones-editor-titlebar">
        <h3>Zones ${floors.length > 1 ? `<span style="font-size:10px;font-weight:400;color:#666;margin-left:6px;">— ${escapeHtml(activeFloor()?.name || '')}</span>` : ''}</h3>
        <button class="zones-editor-close" id="zonesCloseBtn" title="Close editor">✕</button>
      </div>
      <div class="zed-body">
        <!-- LEFT PANEL -->
          <div class="zed-left" style="${(!selectedZone && !selectedGroup && !activePinId) ? 'border-right:none;width:100%;' : '' }">
          ${floors.length > 1 ? (
            '<div style="padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:4px;">'
            + '<select id="editorFloorSelect" style="flex:1;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;color:#fff;font-size:12px;">'
            + floors.map(f => '<option value="' + f.id + '"' + (f.id === activeFloorId ? ' selected' : '') + '>' + escapeHtml(f.name) + '</option>').join('')
            + '</select>'
            + (!IS_DIRECT_MODE ? '<button id="floorConfigZedBtn" title="Configure floor" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;color:#888;font-size:12px;cursor:pointer;flex-shrink:0;">⚙</button>' : '')
            + '</div>'
          ) : (!IS_DIRECT_MODE ? '<div style="padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:flex-end;"><button id="floorConfigZedBtn" title="Configure floor" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;color:#888;font-size:12px;cursor:pointer;">⚙ Configure floor</button></div>' : '')}
          <div class="zed-list" id="zonesList">${buildZoneList()}</div>
          <div class="zed-actions">
            <button id="addGroupBtn">+ Group</button>
            <button id="addZoneBtn">+ Zone</button>
            ${!IS_DIRECT_MODE ? '<button id="addFloorZedBtn">+ Floor</button>' : ''}
            ${selectedZone ? `<button id="editPointsBtn" style="${isEditingPoints ? 'border-color:rgba(255,204,0,0.5);color:#ffcc00;' : ''}">${editPtsLabel}</button>` : ""}
            ${selectedZone ? `<button id="undoZonesBtn" title="Undo last change">↩ Undo</button>` : ""}
            ${(selectedZone || selectedGroup) ? `<button id="deleteZoneBtn" class="danger">Delete</button>` : ""}
          </div>
        </div>
        <!-- RIGHT PANEL — completely hidden when nothing selected -->
        <div class="zed-right" style="${(!selectedZone && !selectedGroup && !activePinId) ? 'display:none;' : ''}">${activePinId ? buildPinRightPanel() : buildRightPanel()}</div>
      </div>
      <div class="zed-resize-handle" id="zedResizeHandle"></div>
    </div>
  `;

  restoreZoneEditorScrollState(container, __zedScrollState);

  // ── Wire events ────────────────────────────────────────────
  // Zone list item clicks
  container.querySelectorAll(".zones-list-item").forEach(item => {
    item.onclick = () => {
      selectedZoneId  = item.dataset.zoneId;
      selectedGroupId = null;
      activePinId     = null; activePinType = null; // deselect any pin
      isCreatingZone = false; currentNewZone = null;
      renderZones(); renderZonesEditor();
    };
  });

  // Group header clicks
  container.querySelectorAll(".zed-group-header[data-group-id]").forEach(hdr => {
    hdr.onclick = (e) => {
      const gid = hdr.dataset.groupId;
      const key = hdr.dataset.storageKey;
      // If clicking the chevron area (right side), toggle collapse only
      const chevron = hdr.querySelector(".zed-chevron");
      const membersEl = container.querySelector(`.zed-group-members[data-group-id="${gid}"]`);
      if (membersEl && key) {
        const collapsed = membersEl.style.display === "none";
        membersEl.style.display = collapsed ? "" : "none";
        if (chevron) chevron.style.transform = `rotate(${collapsed ? "0" : "-90"}deg)`;
        localStorage.setItem(key, collapsed ? "expanded" : "collapsed");
      }
      // Also select the group (show right panel)
      selectedGroupId = gid;
      selectedZoneId  = null;
      activePinId = null; activePinType = null;
      renderZones();
      // Re-render only the left panel actions + right panel without blowing away the list
      // Full re-render needed to show right panel
      renderZonesEditor();
    };
  });

  // Floor selector — switches active floor, reloads floorplan and re-renders zone list
  document.getElementById("editorFloorSelect")?.addEventListener("change", e => {
    setActiveFloor(e.target.value);
    selectedZoneId  = null;
    selectedGroupId = null;
    activePinId = null; activePinType = null;
    isCreatingZone = false; currentNewZone = null;
    renderZonesEditor(true);
    renderZones();
  });

  // Floor config button (⚙ inline in floor selector)
  document.getElementById("floorConfigZedBtn")?.addEventListener("click", () => {
    openFloorConfigPanel(activeFloorId || floors[0]?.id);
  });

  // Add Floor
  document.getElementById("addFloorZedBtn")?.addEventListener("click", async () => {
    const name = prompt("New floor name:", "New Floor");
    if (!name?.trim()) return;
    const id = "floor_" + Date.now();
    const newFloor = { id, name: name.trim(), floorplan: null, ha_floor_id: null, ha_auto_add_areas: true, ha_linked_area_ids: [] };
    const res = await saveFloor(newFloor);
    if (res?.floors) { floors.length = 0; res.floors.forEach(f => floors.push(f)); }
    setActiveFloor(id);
    // Open config panel immediately so user can set floorplan image
    renderZonesEditor();
    openFloorConfigPanel(id);
  });

  // Add Zone
  document.getElementById("addZoneBtn")?.addEventListener("click", () => {
    const id = "zone_" + Date.now();
    const nz = { id, name: "New Zone", colorHex: "#0096ff", color: hexToRgba("#0096ff", 0.25),
                 points: [], sensors: [], cameras: [], lights: [], sirens: [], enabled: true, hidden: false,
                 floor_id: activeFloorId || null };
    pushUndo(); zones.push(nz);
    selectedZoneId = id; selectedGroupId = null;
    isCreatingZone = true; isEditingPoints = false; currentNewZone = nz;
    saveZone(nz); renderZones(); renderZonesEditor();
    scheduleHAReload(); // new zone = new HA entity needed
  });

  // Add Group
  document.getElementById("addGroupBtn")?.addEventListener("click", () => {
    const id = "grp_" + Date.now();
    const ng = { id, name: "New Group", colorHex: "#ff3b30", zone_ids: [] };
    groups.push(ng);
    selectedGroupId = id; selectedZoneId = null;
    saveGroup(ng); renderZonesEditor();
  });

  // Add Light / Add Siren — now triggered via 📍 button in zone's Lights/Sirens tab

  // Delete
  document.getElementById("deleteZoneBtn")?.addEventListener("click", () => {
    if (selectedGroup && !selectedZone) {
      if (!confirm(`Delete group "${selectedGroup.name}"?`)) return;
      deleteGroup(selectedGroupId);
      groups = groups.filter(g => g.id !== selectedGroupId);
      selectedGroupId = null;
      renderZonesEditor();
    } else if (selectedZone) {
      pushUndo();
      deleteZoneFile(selectedZoneId);
      zones = zones.filter(z => z.id !== selectedZoneId);
      // Remove from any group
      groups.forEach(g => { g.zone_ids = (g.zone_ids||[]).filter(id => id !== selectedZoneId); saveGroup(g); });
      selectedZoneId = null; isCreatingZone = false; isEditingPoints = false; currentNewZone = null;
      renderZones(); renderZonesEditor();
      scheduleHAReload(); // zone deleted — remove HA entity
    }
  });

  // Edit Zone points
  document.getElementById("editPointsBtn")?.addEventListener("click", () => {
    const zone = zones.find(z => z.id === selectedZoneId);
    if (zone && (zone.points || []).length < 3) {
      // Zone not complete yet — resume creation mode so more points can be added
      isCreatingZone  = true;
      isEditingPoints = false;
      currentNewZone  = zone;
    } else {
      isEditingPoints = !isEditingPoints;
      isCreatingZone  = false;
      currentNewZone  = null;
    }
    renderZones(); renderZonesEditor();
  });

  // ── Group config wiring ──────────────────────────────────
  if (selectedGroup && !selectedZone) {
    document.getElementById("groupNameInput")?.addEventListener("input", e => {
      selectedGroup.name = e.target.value;
      saveGroup(selectedGroup);
      renderZonesEditor();
      // Also update the group header name in the left panel tree immediately
      const treeHdr = document.querySelector(`.zed-group-header[data-group-id="${CSS.escape(selectedGroup.id)}"] span`);
      if (treeHdr) treeHdr.textContent = e.target.value || '(unnamed)';
    });
    document.getElementById("groupNameInput")?.addEventListener("blur", e => {
      const newName = e.target.value.trim();
      if (newName && window.OW_Automations?.repushAll) {
        window.OW_Automations.repushAll().then(() =>
          logEvent("ok", `Automations updated for renamed group "${newName}".`, "system")
        );
      }
    });

    document.getElementById("groupColorInput")?.addEventListener("input", e => {
      selectedGroup.colorHex = e.target.value;
      saveGroup(selectedGroup);
      renderZones();
      renderZonesEditor();
    });

    document.getElementById("groupArmedToggle")?.addEventListener("change", e => {
      setGroupArmed(selectedGroupId, e.target.checked);
    });

    document.querySelectorAll(".group-member-chk").forEach(chk => {
      chk.addEventListener("change", e => {
        const zid = e.target.dataset.zoneId;
        selectedGroup.zone_ids = selectedGroup.zone_ids || [];
        if (e.target.checked) {
          if (!selectedGroup.zone_ids.includes(zid)) selectedGroup.zone_ids.push(zid);
        } else {
          selectedGroup.zone_ids = selectedGroup.zone_ids.filter(id => id !== zid);
        }
        saveGroup(selectedGroup);
        renderZonesEditor();
      });
    });

    document.getElementById("deleteGroupBtn")?.addEventListener("click", () => {
      if (!confirm(`Delete group "${selectedGroup.name}"?`)) return;
      deleteGroup(selectedGroupId);
      groups = groups.filter(g => g.id !== selectedGroupId);
      selectedGroupId = null;
      renderZonesEditor();
    });
  }

  // ── Pin config wiring ─────────────────────────────────────
  if (activePinId) {
    const pin = activePinType === 'light'  ? lights.find(p => p.id === activePinId)
              : activePinType === 'siren'  ? sirens.find(p => p.id === activePinId)
              : activePinType === 'door'   ? doorPins.find(p => p.id === activePinId)
              : cameraPins.find(p => p.id === activePinId);

    const savePin = () => {
      if (activePinType === 'light')  saveLight(pin);
      else if (activePinType === 'siren') saveSiren(pin);
      else if (activePinType === 'door') saveDoorPin(pin);
      else saveCameraPin(pin);
    };

    if (pin) {
      document.getElementById('pinNameInput')?.addEventListener('input', e => {
        pin.name = e.target.value; savePin();
      });

      // Door-specific: sensor + control entity autocomplete + rotation
      if (activePinType === 'door') {
        const wireEntitySearch = (inputId, resultsId, prefixes, onSelect) => {
          const inp = document.getElementById(inputId);
          const res = document.getElementById(resultsId);
          if (!inp || !res) return;
          inp.addEventListener('keydown', e => e.stopPropagation());
          inp.addEventListener('input', e => {
            e.stopPropagation();
            const q = inp.value.trim().toLowerCase();
            if (!q) { res.style.display = 'none'; return; }
            const matches = Object.keys(haStates).filter(id =>
              prefixes.some(p => id.startsWith(p)) && id.toLowerCase().includes(q)
            ).slice(0, 10);
            res.innerHTML = matches.map(id =>
              `<div class="entity-search-result" data-id="${escapeHtml(id)}" style="padding:5px 8px;cursor:pointer;font-size:11px;color:#ccc;border-bottom:1px solid rgba(255,255,255,0.05);">${escapeHtml(id)}</div>`
            ).join('') || `<div style="padding:6px 8px;color:#555;font-size:11px;">No matches</div>`;
            res.style.display = 'block';
            res.querySelectorAll('[data-id]').forEach(row => {
              row.addEventListener('mousedown', e => {
                e.preventDefault();
                inp.value = row.dataset.id;
                res.style.display = 'none';
                onSelect(row.dataset.id);
              });
            });
          });
          inp.addEventListener('blur', () => setTimeout(() => res.style.display = 'none', 150));
        };

        wireEntitySearch('pinEntityInput', 'pinEntityResults',
          ['binary_sensor.', 'sensor.'],
          val => { pin.sensor_entity = val; savePin(); renderZones(); }
        );
        // Also save on blur
        document.getElementById('pinEntityInput')?.addEventListener('blur', e => {
          pin.sensor_entity = e.target.value.trim(); savePin(); renderZones();
        });

        wireEntitySearch('pinControlEntityInput', 'pinCtrlResults',
          ['lock.', 'cover.', 'switch.', 'input_boolean.', 'button.'],
          val => { pin.control_entity = val; savePin(); renderZones(); }
        );
        document.getElementById('pinControlEntityInput')?.addEventListener('blur', e => {
          pin.control_entity = e.target.value.trim() || null; savePin(); renderZones();
        });

        // Control trigger options
        const ctlChk = document.getElementById('pinControlCountsChk');
        if (ctlChk) {
          ctlChk.addEventListener('change', e => {
            pin.control_counts_as_trigger = !!e.target.checked;
            savePin();
            renderZones();
          });
        }

        const cog = document.getElementById('pinControlTriggerCog');
        const pop = document.getElementById('pinControlTriggerPopover');
        const sel = document.getElementById('pinControlTriggerSelect');
        if (sel) {
          const v = pin.control_trigger_state;
          sel.value = (v === null || v === undefined) ? '' : String(v);
          sel.addEventListener('change', () => {
            pin.control_trigger_state = sel.value ? sel.value : null;
            savePin();
            renderZones();
          });
        }
        if (cog && pop) {
          cog.addEventListener('click', e => {
            e.stopPropagation();
            pop.style.display = (pop.style.display === 'none' || !pop.style.display) ? 'block' : 'none';
          });
          document.addEventListener('pointerdown', function _close(e) {
            if (!pop) return;
            if (pop.style.display === 'none') return;
            if (pop.contains(e.target) || cog.contains(e.target)) return;
            pop.style.display = 'none';
          }, true);
        }

        // Linked zones list (alphabetical, search, checked first)
        const zsInp = document.getElementById('pinZonesSearchInput');
        const zsList = document.getElementById('pinZonesList');
        function _zoneLabel(z) { return String((z?.name || z?.id || '')).trim(); }
        function renderLinkedZonesList() {
          if (!zsList) return;
          const q = String(zsInp?.value || '').trim().toLowerCase();
          const beforeScroll = zsList.scrollTop;
          const linked = new Set(doorPinZoneIds(pin));
          const items = [...zones].map(z => ({
            z,
            id: z.id,
            name: _zoneLabel(z),
            checked: linked.has(z.id),
          }))
          .filter(x => !q || x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q))
          .sort((a,b) => {
            if (a.checked !== b.checked) return a.checked ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

          zsList.innerHTML = items.map(x => {
            const floor = floors.find(f => f.id === x.z.floor_id)?.name || '';
            const floorTag = floor ? `<span style="font-size:10px;color:#555;margin-left:6px;">${escapeHtml(floor)}</span>` : '';
            return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:${x.checked ? '#ddd' : '#aaa'};">
              <input type="checkbox" class="pinZoneLinkChk" data-zone-id="${escapeHtml(x.id)}" ${x.checked ? 'checked' : ''} style="accent-color:#0096ff;">
              <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${escapeHtml(x.name)}</span>${floorTag}
            </label>`;
          }).join('') || `<div style="padding:6px 2px;color:#555;font-size:12px;">No matches</div>`;

          zsList.scrollTop = beforeScroll;

          zsList.querySelectorAll('.pinZoneLinkChk').forEach(chk => {
            chk.addEventListener('change', () => {
              const zid = chk.dataset.zoneId;
              const current = new Set(doorPinZoneIds(pin));
              if (chk.checked) current.add(zid); else current.delete(zid);

              // Keep legacy zone_id stable when possible (compat for any remaining code reading zone_id)
              const primary = (pin.zone_id && current.has(pin.zone_id)) ? pin.zone_id : (Array.from(current)[0] || null);
              let rest = Array.from(current).filter(id => id && id !== primary);
              rest.sort((a,b) => _zoneLabel(zones.find(z=>z.id===a)).localeCompare(_zoneLabel(zones.find(z=>z.id===b))));

              let next = primary ? [primary, ...rest] : rest;
              if (!next.length) {
                const fallback = pin.zone_id || zones[0]?.id || null;
                if (fallback) next = [fallback];
              }

              pin.zone_ids = next;
              pin.zone_id  = next[0];
              savePin();
              renderZones();
              renderLinkedZonesList();
            });
          });
        }

        zsInp?.addEventListener('input', () => renderLinkedZonesList());
        renderLinkedZonesList();


        const rotEl  = document.getElementById('pinRotationInput');
        const rotVal = document.getElementById('pinRotationVal');
        if (rotEl) {
          rotEl.addEventListener('input', e => {
            e.stopPropagation();
            pin.rotation = Number(e.target.value);
            if (rotVal) rotVal.textContent = pin.rotation + '°';
            renderZones();
          });
          rotEl.addEventListener('change', () => savePin());
        }

        // Door type — single / double / sliding
        document.getElementById('doorTypeSingle')?.addEventListener('click', () => {
          pin.doorType = 'single'; savePin(); renderZones(); renderZonesEditor();
        });
        document.getElementById('doorTypeDouble')?.addEventListener('click', () => {
          pin.doorType = 'double'; savePin(); renderZones(); renderZonesEditor();
        });
        document.getElementById('doorTypeSliding')?.addEventListener('click', () => {
          pin.doorType = 'sliding'; savePin(); renderZones(); renderZonesEditor();
        });
        // Hinge side — left / right
        document.getElementById('doorHandLeft')?.addEventListener('click', () => {
          pin.doorHand = 'left'; savePin(); renderZones(); renderZonesEditor();
        });
        document.getElementById('doorHandRight')?.addEventListener('click', () => {
          pin.doorHand = 'right'; savePin(); renderZones(); renderZonesEditor();
        });
        // Width slider
        const sizeWEl = document.getElementById('pinSizeWInput');
        const sizeWVal = document.getElementById('pinSizeWVal');
        if (sizeWEl) {
          sizeWEl.addEventListener('input', e => {
            e.stopPropagation();
            pin.sizeW = Number(e.target.value);
            if (sizeWVal) sizeWVal.textContent = pin.sizeW;
            renderZones();
          });
          sizeWEl.addEventListener('change', () => savePin());
        }
        // Depth slider
        const sizeDEl = document.getElementById('pinSizeDInput');
        const sizeDVal = document.getElementById('pinSizeDVal');
        if (sizeDEl) {
          sizeDEl.addEventListener('input', e => {
            e.stopPropagation();
            pin.sizeH = Number(e.target.value);
            if (sizeDVal) sizeDVal.textContent = pin.sizeH;
            renderZones();
          });
          sizeDEl.addEventListener('change', () => savePin());
        }
        const auraEl  = document.getElementById('pinAuraRadInput');
        const auraVal = document.getElementById('pinAuraRadVal');
        if (auraEl) {
          auraEl.addEventListener('input', e => {
            e.stopPropagation();
            pin.auraRadius = Number(e.target.value);
            if (auraVal) auraVal.textContent = pin.auraRadius;
            renderZones();
          });
          auraEl.addEventListener('change', () => savePin());
        }
      }
      document.getElementById('pinEntityInput')?.addEventListener('keydown', e => e.stopPropagation());
      document.getElementById('pinEntityInput')?.addEventListener('input',   e => e.stopPropagation());
      document.getElementById('pinEntityInput')?.addEventListener('blur', e => {
        pin.entity_id = e.target.value.trim(); savePin(); renderZones();
      });

      // Radius slider — live preview, save on pointerup
      const radiusEl = document.getElementById('pinRadiusInput');
      const radiusVal = document.getElementById('pinRadiusVal');
      if (radiusEl) {
        radiusEl.addEventListener('input', e => {
          pin.radius = Number(e.target.value);
          if (radiusVal) radiusVal.textContent = pin.radius;
          renderZones(); // live preview
        });
        radiusEl.addEventListener('change', () => saveLight(pin));
      }

      // Direction slider — -1 means no direction (omnidirectional)
      const dirEl  = document.getElementById('pinDirectionInput');
      const dirVal = document.getElementById('pinDirVal');
      if (dirEl) {
        dirEl.addEventListener('input', e => {
          const v = Number(e.target.value);
          pin.direction = v < 0 ? null : v;
          if (dirVal) dirVal.textContent = v < 0 ? 'none' : v + '°';
          // Show/hide spread row dynamically
          const spreadRow = document.getElementById('pinSpreadRow');
          if (spreadRow) spreadRow.style.display = v < 0 ? 'none' : 'flex';
          renderZones(); // live preview
        });
        dirEl.addEventListener('change', () => savePin());
      }

      // Spread slider
      const spreadEl  = document.getElementById('pinSpreadInput');
      const spreadVal = document.getElementById('pinSpreadVal');
      if (spreadEl) {
        spreadEl.addEventListener('input', e => {
          pin.spread = Number(e.target.value);
          if (spreadVal) spreadVal.textContent = pin.spread + '°';
          renderZones();
        });
        spreadEl.addEventListener('change', () => savePin());
      }

      // Tap action buttons (lights only)
      document.getElementById('pinTapThis')?.addEventListener('click', () => {
        pin.tapAll = false; pin.tapZone = false; savePin(); renderZonesEditor();
      });
      document.getElementById('pinTapAll')?.addEventListener('click', () => {
        pin.tapAll = true; pin.tapZone = false; savePin(); renderZonesEditor();
      });
      // Siren-specific tap actions
      document.getElementById('pinTapZone')?.addEventListener('click', () => {
        pin.tapZone = true; pin.tapAll = false; savePin(); renderZonesEditor();
      });
      document.getElementById('pinTapAllSirens')?.addEventListener('click', () => {
        pin.tapAll = true; pin.tapZone = false; savePin(); renderZonesEditor();
      });

      // Siren radius slider
      const sirenRadiusEl  = document.getElementById('pinRadiusInput');
      const sirenRadiusVal = document.getElementById('pinRadiusVal');
      if (sirenRadiusEl && activePinType === 'siren') {
        sirenRadiusEl.addEventListener('input', e => {
          pin.radius = Number(e.target.value);
          if (sirenRadiusVal) sirenRadiusVal.textContent = pin.radius;
          renderZones();
        });
        sirenRadiusEl.addEventListener('change', () => savePin());
      }

      document.getElementById('pinDoneBtn')?.addEventListener('click', () => {
        activePinId = null; activePinType = null;
        renderZones(); renderZonesEditor();
      });
      document.getElementById('pinDeleteBtn')?.addEventListener('click', () => {
        if (!confirm(`Delete this ${activePinType}?`)) return;
        if (activePinType === 'light') deleteLight(activePinId);
        else if (activePinType === 'siren') deleteSiren(activePinId);
        else if (activePinType === 'door') deleteDoorPin(activePinId);
        else deleteCameraPin(activePinId);
        activePinId = null; activePinType = null;
        renderZones(); renderZonesEditor();
      });
    }
  }

  // ── Zone config wiring ───────────────────────────────────
  if (selectedZone) {
    let _zoneOrigName = selectedZone.name || "";
    document.getElementById("zoneNameInput")?.addEventListener("input", e => {
      selectedZone.name = e.target.value;
      saveZone(selectedZone);
      // Update the name label in the left panel tree immediately without full re-render
      // (renderZonesEditor early-returns when an input has focus to preserve cursor position)
      const treeItem = document.querySelector(`.zones-list-item[data-zone-id="${CSS.escape(selectedZone.id)}"]`);
      if (treeItem) {
        const nameSpan = treeItem.querySelector('span:first-of-type');
        if (nameSpan) nameSpan.textContent = e.target.value || '(unnamed)';
      }
    });
    document.getElementById("zoneNameInput")?.addEventListener("blur", e => {
      const newName = e.target.value.trim();
      if (newName && newName !== _zoneOrigName) {
        // Re-push all OW automations so entity IDs reflect the new slug
        if (window.OW_Automations?.repushAll) {
          window.OW_Automations.repushAll().then(() =>
            logEvent("ok", `Automations updated for renamed zone "${newName}".`, "system")
          );
        } else {
          logEvent("warn",
            `Zone renamed to "${newName}". Re-open Automation Editor and re-save any automations referencing this zone.`,
            "system");
        }
        _zoneOrigName = newName;
        // Re-sync the new entity state to HA
        owEntitySet("zone", selectedZone.id, selectedZone.enabled !== false);
      }
    });

    document.getElementById("zoneColorInput")?.addEventListener("input", e => {
      selectedZone.colorHex = e.target.value;
      selectedZone.color = hexToRgba(e.target.value, 0.25);
      saveZone(selectedZone); renderZones();
    });

    document.getElementById("zoneEnabledToggle")?.addEventListener("change", e => {
      setZoneEnabled(selectedZone.id, e.target.checked); renderZonesEditor();
    });

    document.getElementById("zoneHiddenToggle")?.addEventListener("click", () => {
      setZoneHidden(selectedZone.id, !selectedZone.hidden); renderZonesEditor();
    });

    document.getElementById("zoneFloorSelect")?.addEventListener("change", e => {
      selectedZone.floor_id = e.target.value;
      saveZone(selectedZone);
      renderZones(); renderZonesEditor();
    });

    document.getElementById("zoneGroupSelect")?.addEventListener("change", e => {
      setZoneGroup(selectedZone.id, e.target.value || null);
    });

    // HA Area select — when changed, remove old area's synced entities and sync new area
    document.getElementById("zoneHAAreaSelect")?.addEventListener("change", async e => {
      const oldAreaId = selectedZone.ha_area_id;
      const newAreaId = e.target.value || null;

      // Remove entities that came from the OLD area (not manually added)
      if (oldAreaId && oldAreaId !== newAreaId) {
        const oldAreaEntities = new Set(haEntitiesForArea(oldAreaId).map(e => e.entity_id));
        // Also include door pins from old area
        const oldDoorPins = doorPins.filter(p => doorPinZoneIds(p).includes(selectedZone.id) && oldAreaEntities.has(p.sensor_entity));
        for (const pin of oldDoorPins) {
          doorPins.splice(doorPins.indexOf(pin), 1);
          await fetch(apiPath('ow/delete-door-pin'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pin.id }) });
        }
        // Remove from entity tabs — only those that came from the old area
        ['sensors','cameras','lights','sirens'].forEach(tab => {
          selectedZone[tab] = (selectedZone[tab]||[]).filter(eid => !oldAreaEntities.has(eid));
        });
        // Clear excluded entities from old area too
        selectedZone.ha_excluded_entities = (selectedZone.ha_excluded_entities||[]).filter(eid => !oldAreaEntities.has(eid));
      }

      selectedZone.ha_area_id = newAreaId;
      await saveZone(selectedZone);

      // Sync entities from new area if one was selected. Force a registry refresh so
      // newly-added/removed HA area devices are reconciled immediately.
      if (newAreaId) await syncZoneFromHAArea(selectedZone, { forceRefresh: true });

      renderZonesEditor(true);
    });

    // HA Area sync button — authoritative refresh + reconcile from HA area
    document.getElementById("zoneHAAreaSync")?.addEventListener("click", async () => {
      await syncZoneFromHAArea(selectedZone, { forceRefresh: true });
      renderZonesEditor(true);
    });

    // Device tabs
    document.getElementById("haDeviceTabs")?.querySelectorAll(".ha-device-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _activeZoneTab = btn.dataset.tab; // persist across re-renders
        document.querySelectorAll(".ha-device-tab").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".ha-tab-panel").forEach(p => { p.style.display = "none"; p.style.flex = ""; });
        btn.classList.add("active");
        const panel = document.getElementById("tabPanel_" + btn.dataset.tab);
        if (panel) { panel.style.display = ""; panel.style.flex = "1"; panel.style.overflowY = "auto"; }
      });
    });

    // Entity remove + ghost buttons
    ["sensors","cameras","lights","sirens"].forEach(devType => {
      const listId = { sensors:"zoneEntityList", cameras:"zoneCameraList", lights:"zoneLightList", sirens:"zoneSirenList" }[devType];
      document.getElementById(listId)?.querySelectorAll(".ha-entity-remove").forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation();
          selectedZone[devType] = (selectedZone[devType]||[]).filter(s => s !== btn.dataset.entityId);
          saveZone(selectedZone);
          if (devType === "sensors") subscribeHAEntities();
          renderZonesEditor();
        };
      });
      // Ghost toggle — adds/removes from ha_excluded_entities
      document.getElementById(listId)?.querySelectorAll(".ha-entity-ghost").forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation();
          const eid = btn.dataset.entityId;
          if (!selectedZone.ha_excluded_entities) selectedZone.ha_excluded_entities = [];
          const ex = selectedZone.ha_excluded_entities;
          if (ex.includes(eid)) {
            selectedZone.ha_excluded_entities = ex.filter(x => x !== eid); // restore
          } else {
            ex.push(eid); // ghost
          }
          saveZone(selectedZone);
          renderZonesEditor();
        };
      });
    });

    bindDeviceSearch(selectedZone, "entitySearchInput", "entitySearchResults", "sensors",  "zoneEntityList");
    bindDeviceSearch(selectedZone, "cameraSearchInput", "cameraSearchResults", "cameras",  "zoneCameraList");
    bindDeviceSearch(selectedZone, "lightSearchInput",  "lightSearchResults",  "lights",   "zoneLightList");
    bindDeviceSearch(selectedZone, "sirenSearchInput",  "sirenSearchResults",  "sirens",   "zoneSirenList");

    // Doors tab — Place, Edit, Delete
    // Door search — selecting entity pre-fills sensor and enters place mode
    const doorSearchEl = document.getElementById('doorSearchInput');
    if (doorSearchEl) {
      doorSearchEl.addEventListener('keydown', e => e.stopPropagation());
      const triggerDoorSearch = (e) => {
        e.stopPropagation();
        const q = e.target.value.trim().toLowerCase();
        const resultsEl = document.getElementById('doorSearchResults');
        if (!resultsEl) return;
        const DOOR_CLASSES = new Set(['door','window','garage_door','opening','lock','gate','awning','blind','curtain','damper','shutter','shade']);
        // When no query: show all door/window class entities. When query: also match id/name.
        const matches = Object.keys(haStates).filter(id => {
          if (!id.startsWith('binary_sensor.') && !id.startsWith('sensor.')) return false;
          const attrs = haStates[id]?.attributes || {};
          const dc = (attrs.device_class || '').toLowerCase();
          const fn = (attrs.friendly_name || '').toLowerCase();
          const isDoorType = DOOR_CLASSES.has(dc);
          if (!q) return isDoorType; // no query → show only door/window class
          const matchesQuery = id.toLowerCase().includes(q) || fn.includes(q);
          return matchesQuery; // with query → show any matching sensor
        }).sort((a, b) => {
          // Sort door/window class entities to top
          const da = DOOR_CLASSES.has((haStates[a]?.attributes?.device_class||'').toLowerCase());
          const db = DOOR_CLASSES.has((haStates[b]?.attributes?.device_class||'').toLowerCase());
          return (db ? 1 : 0) - (da ? 1 : 0);
        }).slice(0, 50);
        resultsEl.innerHTML = (matches.length ? matches : []).map(id => {
          const attrs = haStates[id]?.attributes || {};
          const fn = attrs.friendly_name || id.split('.').pop().replace(/_/g,' ');
          const dc = attrs.device_class || '';
          return `<div class="entity-search-result" data-entity-id="${escapeHtml(id)}">${escapeHtml(fn)} <span style="color:#555;font-size:10px;">${escapeHtml(id)}${dc ? ' · '+escapeHtml(dc) : ''}</span></div>`;
        }).join('') || `<div style="padding:6px;color:#555;font-size:12px;">${q ? 'No matches' : 'No door/window sensors found'}</div>`;
        resultsEl.style.display = 'block';
        resultsEl.querySelectorAll('.entity-search-result').forEach(row => {
          row.addEventListener('click', () => {
            const entityId = row.dataset.entityId;
            // Create a door pin directly without requiring map placement
            // Pin is created with no x/y position (won't render on map until placed)
            const zone = selectedZone;
            const newPin = {
              id:             'door_' + Date.now(),
              name:           entityId.split('.').pop().replace(/_/g, ' '),
              sensor_entity:  entityId,
              control_entity: null,
              zone_id:        zone.id,
              floor_id:       zone.floor_id || activeFloorId || null,
              x:              null,
              y:              null,
              rotation:       0,
            };
            doorPins.push(newPin);
            saveDoorPin(newPin);
            doorSearchEl.value = '';
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
            renderZonesEditor();
            logEvent('info', `Added ${entityId} as door/window sensor. Use "Place on Map" to position it.`, 'system');
          });
        });
      };
      doorSearchEl.addEventListener('input', triggerDoorSearch);
      doorSearchEl.addEventListener('focus', triggerDoorSearch);
      // Close results when clicking outside the search box
      document.addEventListener('click', function closeDoorSearch(e) {
        if (!doorSearchEl.isConnected) { document.removeEventListener('click', closeDoorSearch); return; }
        const wrap = doorSearchEl.closest('.entity-search-wrap');
        if (wrap && !wrap.contains(e.target)) {
          const resultsEl = document.getElementById('doorSearchResults');
          if (resultsEl) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; }
        }
      });
    }

    document.getElementById("addDoorPinBtn")?.addEventListener("click", () => {
      // Enter crosshair mode — user clicks the map to place the door
      placingPinType  = 'door';
      placingEntityId = '';
      placingZoneId   = selectedZone.id;
      document.querySelectorAll('#zonesSvg, .fp-svg').forEach(s => s.style.cursor = 'crosshair');
      // Show hint
      logEvent('info', 'Click the map to place the door icon.', 'system');
    });

    document.querySelectorAll(".door-pin-place-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const pin = doorPins.find(p => p.id === btn.dataset.id);
        if (!pin) return;
        placingPinType  = 'door';
        placingEntityId = pin.sensor_entity || '';
        placingZoneId   = pin.zone_id;
        _placingExistingPinId = pin.id; // flag to update existing pin rather than create new
        document.querySelectorAll('#zonesSvg, .fp-svg').forEach(s => s.style.cursor = 'crosshair');
        logEvent('info', `Click the map to place ${pin.name || pin.sensor_entity}`, 'system');
      });
    });

    document.querySelectorAll(".door-pin-edit-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        selectPin('door', btn.dataset.id);
        renderZones(); renderZonesEditor();
      });
    });

    document.querySelectorAll(".door-pin-links-btn").forEach(btn => {
      btn.addEventListener("click", e => { e.stopPropagation(); openDoorLinksPopover(btn.dataset.id, btn); });
    });

    document.querySelectorAll(".door-pin-ghost").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const id = btn.dataset.entityId;
        selectedZone.ha_excluded_entities = selectedZone.ha_excluded_entities || [];
        if (selectedZone.ha_excluded_entities.includes(id)) {
          selectedZone.ha_excluded_entities = selectedZone.ha_excluded_entities.filter(x => x !== id);
        } else {
          selectedZone.ha_excluded_entities.push(id);
        }
        saveZone(selectedZone);
        subscribeHAEntities();
        renderZones(); renderZonesEditor();
      });
    });

    document.querySelectorAll(".door-pin-delete-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!confirm("Delete this door pin?")) return;
        deleteDoorPin(btn.dataset.id);
        renderZones(); renderZonesEditor();
      });
    });
  } // end if (selectedZone && editorMode)

  // ── Undo / Export ────────────────────────────────────────
  document.getElementById("undoZonesBtn")?.addEventListener("click", undoZones);

  const exportBtn = document.getElementById("exportZonesBtn");
  if (exportBtn) {
    exportBtn.onclick = () => {
      const blob = new Blob([generateZonesYaml()], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "zones_export.yaml"; a.click();
      URL.revokeObjectURL(url);
    };
    // Import button
    if (!document.getElementById("importZonesBtn")) {
      const importBtn = document.createElement("button");
      importBtn.id = "importZonesBtn"; importBtn.textContent = "Import YAML";
      const importInput = document.createElement("input");
      importInput.id = "importZonesFile"; importInput.type = "file"; importInput.accept = ".yaml,.yml,.txt"; importInput.style.display = "none";
      exportBtn.insertAdjacentElement("afterend", importBtn);
      importBtn.insertAdjacentElement("afterend", importInput);
      importBtn.onclick = () => importInput.click();
      importInput.onchange = () => {
        const file = importInput.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = e => { try { importZonesFromYaml(e.target.result); } catch {} };
        reader.readAsText(file);
      };
    }
  }

  // ── Resize handle (bottom-right corner) ──────────────────
  const resizeHandle = document.getElementById("zedResizeHandle");
  if (resizeHandle) {
    let resizing = false, rsx = 0, rsy = 0, rsw = 0, rsh = 0;
    resizeHandle.addEventListener("pointerdown", e => {
      resizing = true; rsx = e.clientX; rsy = e.clientY;
      rsw = editorSize.w; rsh = editorSize.h;
      resizeHandle.setPointerCapture(e.pointerId);
      e.stopPropagation(); e.preventDefault();
    });
    resizeHandle.addEventListener("pointermove", e => {
      if (!resizing) return;
      editorSize.w = Math.max(240, rsw + (e.clientX - rsx));
      editorSize.h = Math.max(300, rsh + (e.clientY - rsy));
      const panel = container.querySelector(".zones-editor");
      if (panel) { panel.style.width = editorSize.w + "px"; panel.style.height = editorSize.h + "px"; }
    });
    resizeHandle.addEventListener("pointerup", () => { resizing = false; localStorage.setItem("editorW", editorSize.w); localStorage.setItem("editorH", editorSize.h); });
  }

  // Restore draggable
  const titlebar = container.querySelector(".zones-editor-titlebar");
  if (titlebar && !titlebar._draggableWired) {
    makeDraggableEditor(container);
    titlebar._draggableWired = true;
  }
}


/* ─── DEVICE ROW HELPER ───────────────────────────────────── */
// Door pin summary row in zone editor Doors tab
function doorPinRow(pin, zone) {
  normalizeDoorPin(pin);
  const sState = haStates[pin.sensor_entity]?.state;
  const isOpen = ['on','open','opening','detected','unlocked'].includes(String(sState || '').toLowerCase());
  const excluded = !!(zone && pin.sensor_entity && (zone.ha_excluded_entities || []).includes(pin.sensor_entity));
  const colour = excluded ? '#777' : sState === undefined ? '#555' : isOpen ? '#ff9500' : '#34c759';
  const isPlaced = pin.x != null && pin.y != null;
  const zCount = doorPinZoneIds(pin).length;

  const editBtn = `<button class="door-pin-edit-btn" data-id="${escapeHtml(pin.id)}" style="background:none;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:2px 6px;cursor:pointer;font-size:10px;color:#888;flex-shrink:0;">Edit</button>`;
  const placeBtn = !isPlaced
    ? `<button class="door-pin-place-btn" data-id="${escapeHtml(pin.id)}" style="background:none;border:1px solid rgba(0,150,255,0.4);border-radius:4px;padding:2px 6px;cursor:pointer;font-size:10px;color:#4db8ff;flex-shrink:0;">📍 Place</button>${editBtn}`
    : editBtn;
  const ghostBtn = zone?.ha_area_id && pin.sensor_entity
    ? `<button class="door-pin-ghost" data-entity-id="${escapeHtml(pin.sensor_entity)}" title="${excluded ? 'Restore entity' : 'Ghost entity — keep visible but ignore in Overwatch'}" style="background:none;border:1px solid ${excluded ? 'rgba(255,149,0,0.5)' : 'rgba(255,255,255,0.12)'};border-radius:4px;padding:2px 6px;cursor:pointer;font-size:10px;color:${excluded ? '#ff9500' : '#555'};flex-shrink:0;">${excluded ? '👻 Hidden' : '👻'}</button>`
    : '';
  const linkBtn = zCount > 1
    ? `<button class="door-pin-links-btn" data-id="${escapeHtml(pin.id)}" title="View linked zones" style="background:none;border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:2px 6px;cursor:pointer;font-size:10px;color:#666;flex-shrink:0;">🔗 ${zCount}</button>`
    : '';

  return `<div class="ha-entity-row" data-door-pin-id="${escapeHtml(pin.id)}" style="flex-wrap:wrap;gap:6px;${excluded ? 'opacity:0.45;' : ''}">
    <div class="ha-entity-state" style="background:${colour};flex-shrink:0;"></div>
    <span class="ha-entity-id" title="${escapeHtml(pin.sensor_entity||'')}">${escapeHtml(pin.name || pin.sensor_entity?.split('.').pop() || 'Door')}</span>
    <span class="ha-entity-type" style="font-size:10px;color:#555;">${excluded ? 'GHOSTED' : sState ? (isOpen?'OPEN':'CLOSED') : '—'}</span>
    ${linkBtn}
    ${ghostBtn}
    ${placeBtn}
    <button class="door-pin-delete-btn" data-id="${escapeHtml(pin.id)}" style="background:none;border:none;color:#ff3b30;cursor:pointer;font-size:12px;flex-shrink:0;">✕</button>
  </div>`;
}



function deviceRow(entityId, devType, zone) {
  const st = haStates[entityId];
  const stateStr  = st ? st.state : (haConnected ? "unavailable" : "—");
  const stateClass = st ? (isEntityTriggered(entityId) ? "on" : "off") : "unavailable";
  const shortId   = entityId.split(".").pop() || entityId;
  const fn        = st?.attributes?.friendly_name;
  const displayName = fn || shortId;
  const icons = { sensors:"⬡", cameras:"⊡", lights:"⊙", sirens:"⊛" };
  const icon = icons[devType] || "·";

  // Ghost state — entity is excluded (from HA area sync but user toggled off)
  const excluded = zone && (zone.ha_excluded_entities || []).includes(entityId);
  // If zone is linked to HA area, use ghost instead of delete for all entities in this zone
  const isHALinked = !!zone?.ha_area_id;
  const ghostBtn = isHALinked
    ? `<button class="ha-entity-ghost" data-entity-id="${escapeHtml(entityId)}" title="${excluded ? 'Restore entity (currently hidden from automations & search)' : 'Hide entity (ghost — removes from automations & search but keeps the link)'}"
        style="background:none;border:1px solid ${excluded ? 'rgba(255,149,0,0.5)' : 'rgba(255,255,255,0.12)'};border-radius:4px;padding:2px 6px;cursor:pointer;font-size:10px;color:${excluded ? '#ff9500' : '#555'};flex-shrink:0;"
        >${excluded ? '👻 Hidden' : '👻'}</button>`
    : '';
  // Show ✕ delete button only on non-HA-linked zones (or always for manually-added?)
  // Design decision: zones with ha_area_id use ghost-only (no delete); zones without use delete-only
  const showDelete = !isHALinked;

  // For lights and sirens: show pin button — filled if already placed, outline if not
  let pinBtn = '';
  if (devType === 'lights' || devType === 'sirens' || devType === 'cameras') {
    const pinArr = devType === 'lights' ? lights : devType === 'sirens' ? sirens : cameraPins;
    const pinType = devType === 'lights' ? 'light' : devType === 'sirens' ? 'siren' : 'camera';
    const alreadyPlaced = pinArr.some(p => p.entity_id === entityId);
    pinBtn = `<button class="ha-entity-pin" data-entity-id="${escapeHtml(entityId)}" data-pin-type="${pinType}"
      title="${alreadyPlaced ? 'Reposition on map' : 'Place on map'}"
      style="background:none;border:1px solid ${alreadyPlaced ? '#64b4ff' : 'rgba(255,255,255,0.2)'};border-radius:4px;padding:2px 5px;cursor:pointer;font-size:10px;color:${alreadyPlaced ? '#64b4ff' : '#666'};flex-shrink:0;">📍</button>`;
  }

  // Camera: low-res entity sub-row
  const lowResRow = devType === 'cameras' ? (() => {
    const lowId = getCamLowRes(entityId);
    return `<div class="cam-low-res-row" style="display:flex;align-items:center;gap:6px;padding:2px 0 4px 18px;width:100%;">
      <span style="font-size:10px;color:#555;white-space:nowrap;">Low res:</span>
      <input class="cam-low-res-input" data-high="${escapeHtml(entityId)}"
        type="text" value="${escapeHtml(lowId === entityId ? '' : lowId)}"
        placeholder="camera.entity_low (optional)"
        style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:2px 6px;font-size:10px;color:#ccc;outline:none;"
        autocomplete="off">
    </div>`;
  })() : '';

  return `
    <div class="ha-entity-row" data-entity-id="${escapeHtml(entityId)}" data-dev-type="${devType}" style="flex-wrap:wrap;${excluded ? 'opacity:0.4;' : ''}">
      <span style="font-size:9px;color:#555;flex-shrink:0;">${icon}</span>
      <div class="ha-entity-state ${stateClass}"></div>
      <span class="ha-entity-id" title="${escapeHtml(entityId)}">${escapeHtml(displayName)}</span>
      <span class="ha-entity-type">${escapeHtml(stateStr)}</span>
      ${ghostBtn}
      ${pinBtn}
      ${showDelete ? `<button class="ha-entity-remove" data-entity-id="${escapeHtml(entityId)}" title="Remove">✕</button>` : ''}
      ${lowResRow}
    </div>`;
}

function bindCamLowResLookup(input) {
  if (!input || input._owLowResLookupBound) return;
  input._owLowResLookupBound = true;
  let resultsEl = input.parentElement?.querySelector('.cam-low-res-results');
  if (!resultsEl) {
    resultsEl = document.createElement('div');
    resultsEl.className = 'cam-low-res-results entity-search-results';
    resultsEl.style.cssText = 'position:absolute;left:18px;right:0;top:100%;z-index:20;background:rgba(12,12,12,0.98);border:1px solid rgba(255,255,255,0.12);border-radius:6px;max-height:180px;overflow-y:auto;display:none;box-shadow:0 8px 24px rgba(0,0,0,0.5);';
    if (input.parentElement) { input.parentElement.style.position = input.parentElement.style.position || 'relative'; input.parentElement.appendChild(resultsEl); }
  }
  function saveValue(value) { const highId = input.dataset.high; const lowVal = String(value || '').trim(); if (lowVal) camLowResMap[highId] = lowVal; else delete camLowResMap[highId]; input.value = lowVal; saveCamLowResMap(); }
  function renderResults(q) {
    const query = String(q || '').trim().toLowerCase();
    if (!query) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return; }
    const hits = Object.keys(haStates || {}).filter(id => id.startsWith('camera.')).filter(id => { const f = haStates[id]?.attributes?.friendly_name || ''; return id.toLowerCase().includes(query) || f.toLowerCase().includes(query); }).slice(0, 25);
    resultsEl.innerHTML = hits.length ? hits.map(id => `<div class="entity-search-result" data-entity-id="${escapeHtml(id)}"><span class="entity-search-id">${escapeHtml(id)}</span><span class="entity-search-state">${escapeHtml(haStates[id]?.state || '—')}</span></div>`).join('') : `<div class="entity-search-result" data-entity-id="${escapeHtml(query)}"><span class="entity-search-id">${escapeHtml(query)}</span><span class="entity-search-state">manual</span></div>`;
    resultsEl.style.display = 'block';
    resultsEl.querySelectorAll('.entity-search-result').forEach(el => { el.onclick = e => { e.stopPropagation(); saveValue(el.dataset.entityId); resultsEl.style.display = 'none'; }; });
  }
  let debounce = null;
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => renderResults(input.value), 80); });
  input.addEventListener('focus', () => { if (input.value.trim()) renderResults(input.value); });
  input.addEventListener('blur', () => { setTimeout(() => { resultsEl.style.display = 'none'; }, 150); saveValue(input.value); });
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); const first = resultsEl.querySelector('.entity-search-result'); saveValue(first ? first.dataset.entityId : input.value); resultsEl.style.display = 'none'; input.blur(); } if (e.key === 'Escape') resultsEl.style.display = 'none'; });
}

/* ─── DEVICE SEARCH (replaces bindEntitySearch, handles all device types) ─── */
function bindDeviceSearch(selectedZone, inputId, resultsId, devType, listId) {
  const input     = document.getElementById(inputId);
  const resultsEl = document.getElementById(resultsId);
  const listEl    = document.getElementById(listId);
  if (!input || !selectedZone) return;

  function refreshList() {
    if (!listEl) return;
    listEl.innerHTML = (selectedZone[devType] || []).map(id => deviceRow(id, devType, selectedZone)).join("");
    listEl.querySelectorAll(".ha-entity-remove").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const id = btn.dataset.entityId;
        selectedZone[devType] = (selectedZone[devType] || []).filter(s => s !== id);
        saveZone(selectedZone);
        if (devType === "sensors") subscribeHAEntities();
        refreshList();
      };
    });
    listEl.querySelectorAll(".ha-entity-ghost").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const id = btn.dataset.entityId;
        selectedZone.ha_excluded_entities = selectedZone.ha_excluded_entities || [];
        if (selectedZone.ha_excluded_entities.includes(id)) {
          selectedZone.ha_excluded_entities = selectedZone.ha_excluded_entities.filter(x => x !== id);
        } else {
          selectedZone.ha_excluded_entities.push(id);
        }
        saveZone(selectedZone);
        subscribeHAEntities();
        renderZones();
        refreshList();
      };
    });
    // Low-res camera input — dynamic camera.* lookup + save on select/blur/enter
    listEl.querySelectorAll(".cam-low-res-input").forEach(bindCamLowResLookup);
    // Pin button — enter placement mode for this entity
    listEl.querySelectorAll(".ha-entity-pin").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const entityId = btn.dataset.entityId;
        const pinType  = btn.dataset.pinType; // 'light' or 'siren'
        // If already placed, select it for repositioning
        const existing = pinType === 'light'
          ? lights.find(p => p.entity_id === entityId)
          : pinType === 'siren'
            ? sirens.find(p => p.entity_id === entityId)
            : cameraPins.find(p => p.entity_id === entityId);
        if (existing) {
          selectPin(pinType, existing.id);
          renderZones(); renderZonesEditor();
          return;
        }
        // Enter placement mode
        placingPinType   = pinType;
        placingEntityId  = entityId;
        placingZoneId    = selectedZone.id;
        activePinId      = null; activePinType = null;
        // Show crosshair on all SVGs
        document.querySelectorAll('#zonesSvg, .fp-svg').forEach(s => s.style.cursor = 'crosshair');
        showToast(`Click the map to place ${pinType === 'light' ? '💡' : '🔊'} ${entityId.split('.').pop()}`, 'info');
      };
    });
  }

  function addDevice(entityId) {
    entityId = entityId.trim();
    if (!entityId) return;
    if (!(selectedZone[devType] || []).includes(entityId)) {
      selectedZone[devType] = [...(selectedZone[devType] || []), entityId];
      saveZone(selectedZone);
      if (devType === "sensors") {
        subscribeHAEntities();
        // If this entity isn't in haStates yet (brand new / never seen), fetch it
        // so getZoneState doesn't immediately fault due to !st
        if (!haStates[entityId] && haConnected) {
          fetchSingleEntityState(entityId);
        }
      }
    }
    input.value = "";
    if (resultsEl) { resultsEl.innerHTML = ""; resultsEl.style.display = "none"; }
    refreshList();
  }

  function runSearch(q) {
    if (!resultsEl) return;
    const query = q.trim().toLowerCase();
    if (!query) { resultsEl.style.display = "none"; return; }
    let candidates = [];
    if (haConnected && Object.keys(haStates).length > 0) {
      candidates = Object.keys(haStates)
        .filter(id => {
          const low = id.toLowerCase();
          // Exclude Overwatch's own entities from the picker (circular reference prevention)
          if (low.startsWith("switch.overwatch_") ||
              low.startsWith("binary_sensor.overwatch_")) return false;
          return low.includes(query);
        })
        .slice(0, 25)
        .map(id => ({ id, state: haStates[id]?.state || "—", friendly: haStates[id]?.attributes?.friendly_name || "" }));
    } else {
      candidates = [{ id: query, state: "add manually", friendly: "Press Enter to add" }];
    }
    if (!candidates.length) candidates = [{ id: query, state: "not found", friendly: "Press Enter to add anyway" }];
    resultsEl.innerHTML = candidates.map(c => `
      <div class="entity-search-result" data-entity-id="${escapeHtml(c.id)}">
        <span class="entity-search-id">${escapeHtml(c.id)}</span>
        <span class="entity-search-state">${escapeHtml(c.state)}</span>
        ${c.friendly ? `<span class="entity-search-friendly">${escapeHtml(c.friendly)}</span>` : ""}
      </div>`).join("");
    resultsEl.style.display = "block";
    resultsEl.querySelectorAll(".entity-search-result").forEach(el => {
      el.onclick = () => addDevice(el.dataset.entityId);
    });
  }

  let debounce = null;
  input.oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => runSearch(input.value), 120); };
  input.onkeydown = e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = resultsEl?.querySelector(".entity-search-result");
      addDevice(first ? first.dataset.entityId : input.value);
    }
    if (e.key === "Escape") { if (resultsEl) { resultsEl.style.display = "none"; } input.value = ""; }
  };
  document.addEventListener("pointerdown", function outside(e) {
    if (!input.contains(e.target) && !(resultsEl && resultsEl.contains(e.target))) {
      if (resultsEl) resultsEl.style.display = "none";
      document.removeEventListener("pointerdown", outside);
    }
  });
  refreshList();
}

/* ─── ENTITY SEARCH (legacy alias kept so old references don't throw) ──── */
function bindEntitySearch(zone) { bindDeviceSearch(zone, "entitySearchInput", "entitySearchResults", "sensors", "zoneEntityList"); }


/* ─── SVG INTERACTION ─────────────────────────────────────── */
// Ray-casting point-in-polygon test
function isPointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function closestEdgeInfo(zone, fpX, fpY) {
  const pts = zone.points || [];
  if (pts.length < 2) return null;
  let bestIdx = 0, bestDist = Infinity, bestSnap = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (!lenSq) continue;
    const t = Math.max(0, Math.min(1, ((fpX - a.x) * dx + (fpY - a.y) * dy) / lenSq));
    const snapX = a.x + t * dx, snapY = a.y + t * dy;
    const dist = Math.hypot(fpX - snapX, fpY - snapY);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; bestSnap = { x: snapX, y: snapY }; }
  }
  return { insertAfter: bestIdx, dist: bestDist, snap: bestSnap };
}

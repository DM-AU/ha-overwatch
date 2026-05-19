/* ─── HA-Overwatch Settings Module ─────────────────────────────
 * Stable baseline: v1.551.36.07.
 * Extracted from app.js as a classic browser script.
 *
 * Scope:
 * - Settings panel rendering and wiring.
 * - Shared draggable panel helper.
 * - Floor configuration panel.
 * - HA area sync/create helpers used by settings/floor config.
 *
 * Compatibility design:
 * - Functions intentionally remain global.
 * - App globals are resolved at call time after app.js has loaded.
 * - No camera-config helpers were moved in this pass.
 */

function openSettings(tab) {
  // Remove existing panel and re-render, then activate the requested tab
  const existing = document.getElementById("settingsPanel");
  if (existing) existing.remove();
  renderSettingsPanel();
  if (tab) {
    const panel = document.getElementById("settingsPanel");
    if (!panel) return;
    // Use classList to match how tab switching works internally
    panel.querySelectorAll(".settings-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
    panel.querySelectorAll(".settings-tab-panel").forEach(p => {
      p.classList.toggle("active", p.dataset.panel === tab);
    });
  }
}

function renderSettingsPanel() {
  const existingEl = document.getElementById("settingsPanel");
  if (existingEl) { existingEl.classList.toggle("open"); return; }

  const panel = document.createElement("div");
  panel.className = "settings-panel open";
  panel.id = "settingsPanel";

  // isAdmin = came through HA ingress (authenticated), not direct LAN port
  // IS_DIRECT_MODE = accessed via http://ha-ip:8099 directly (no HA auth = browser/public user)
  const isAdmin = !IS_DIRECT_MODE;

  // Effective value: localStorage first, then ui.yaml default, then hard default
  const eff = (lsKey, cfgKey, def) =>
    localStorage.getItem(lsKey) ?? (uiConfig[cfgKey] != null ? String(uiConfig[cfgKey]) : def);

  const curDir   = localStorage.getItem('ow_split_dir') || 'h';
  const curMode  = getViewMode();
  const isSplitH = curMode === 'split' && curDir === 'h';
  const isSplitV = curMode === 'split' && curDir === 'v';

  const adminBox = `
    <div class="settings-admin-notice">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-top:1px;">
        <circle cx="12" cy="12" r="10" stroke="#ff9500" stroke-width="1.8"/>
        <path d="M12 8v4m0 4h.01" stroke="#ff9500" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span>Admin only — managed via the HA Add-on panel.</span>
    </div>`;

  const perDeviceBadge = `<span class="settings-browser-badge">Per device</span>`;
  const adminBadge     = `<span class="settings-admin-badge">Admin default</span>`;

  panel.innerHTML = `
    <div class="settings-titlebar">
      <span class="settings-title">Settings</span>
      <button class="zones-editor-close" id="settingsCloseBtn">✕</button>
    </div>
    <div class="settings-tabs">
      <button class="settings-tab active" data-tab="ha">HA</button>
      <button class="settings-tab" data-tab="general">General</button>
      <button class="settings-tab" data-tab="alarm">Alarm</button>
      <button class="settings-tab" data-tab="zones">Zones</button>
      <button class="settings-tab" data-tab="cameras">Cameras</button>
    </div>
    <div class="settings-body">

      <!-- ══ HA TAB ══════════════════════════════════════════════ -->
      <div class="settings-tab-panel active" data-panel="ha">

        ${!isAdmin ? `
        <div class="settings-section-title">HOME ASSISTANT <span class="settings-admin-badge">ADMIN ONLY</span></div>
        ${adminBox}
        <div class="settings-section" style="margin-top:10px;">
          <div class="settings-section-title">This Device</div>
          <div class="settings-field">
            <label>IP Address</label>
            <div style="display:flex;align-items:center;gap:8px;">
              <code style="background:rgba(0,150,255,0.12);border:1px solid rgba(0,150,255,0.3);border-radius:6px;padding:4px 10px;color:#4db8ff;font-size:13px;letter-spacing:0.05em;">${CLIENT_IP || '(unknown)'}</code>
              <button onclick="navigator.clipboard?.writeText('${CLIENT_IP || ''}')" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#888;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;">Copy</button>
            </div>
            <div style="font-size:11px;color:#555;margin-top:4px;">Share with your admin to get arm/disarm access.</div>
          </div>
        </div>` : ''}

        <div id="haConnectionStatus" class="settings-connection-box ${haConnected ? 'connected' : 'disconnected'}">
          <div class="settings-connection-label">${haConnected ? '✓ Connected to Home Assistant' : '✗ Not connected'}</div>
          <div class="settings-connection-sub">${!IS_DIRECT_MODE ? 'Running as HA Add-on. Enter token once to connect.' : 'Connection managed by admin via Add-on.'}</div>
        </div>

        <div class="settings-section" ${!isAdmin ? 'style="opacity:0.45;pointer-events:none;"' : ''}>
          <div class="settings-field">
            <label>HA URL</label>
            ${isAdmin
              ? `<input type="text" id="cfgHaUrl" value="${escapeHtml(uiConfig.ha_url || '')}" placeholder="http://homeassistant.local:8123">`
              : `<div class="settings-readonly">${escapeHtml(uiConfig.ha_url || 'Auto (add-on mode)')}</div>`}
          </div>
          <div class="settings-field">
            <label>Long-Lived Access Token</label>
            ${isAdmin
              ? `<input type="password" id="cfgHaToken" placeholder="${uiConfig.ha_token ? '●●●●●●●● (saved)' : 'eyJ…'}">`
              : `<div class="settings-readonly">●●●●●●●● ${uiConfig.ha_token ? '(saved)' : '(not set)'}</div>`}
          </div>
          ${isAdmin ? `
          <button class="settings-btn" id="settingsSaveHaBtn" style="${haConnected ? 'opacity:0.6;' : ''}">
            ${haConnected ? '✓ Connected — click to reconnect' : 'Connect to Home Assistant'}
          </button>
          <div id="haConnectStatus" style="font-size:11px;color:#888;margin-top:5px;min-height:14px;text-align:center;"></div>` : `
          <div class="settings-readonly" style="text-align:center;color:#555;font-size:11px;">To manage HA connection: open Overwatch in the HA Add-on panel as an admin.</div>`}
        </div>

        ${isAdmin ? `
        <div class="settings-section">
          <div class="settings-section-title">Zone Arm/Disarm Access</div>
          <div class="settings-field">
            <label>Allowed IP addresses</label>
            <textarea id="cfgArmAllowedIps" rows="3" placeholder="192.168.1.10&#10;192.168.1.11&#10;10.0.0.5"
              style="width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:6px 8px;color:#e0e0e0;font-size:12px;resize:vertical;font-family:monospace;"
            >${escapeHtml(_armAllowedIps.join('\n'))}</textarea>
            <div style="font-size:11px;color:#555;margin-top:3px;">One IP per line. Only these devices can arm/disarm zones. Leave empty to disable arm/disarm for all devices.</div>
            <div style="font-size:11px;color:#888;margin-top:4px;">Your current IP: <strong style="color:#0096ff;">${CLIENT_IP || '(unknown)'}</strong></div>
          </div>
          <button class="settings-btn" id="saveArmIpsBtn" style="margin-top:4px;">Save allowed IPs</button>
        </div>` : ''}
      </div>

      <!-- ══ GENERAL TAB ═════════════════════════════════════════ -->
      <div class="settings-tab-panel" data-panel="general">

        <div class="settings-section">
          <div class="settings-section-title">Default View ${perDeviceBadge}</div>
          <div class="settings-field">

            <!-- Level 1: Main view -->
            <div style="font-size:11px;color:#666;margin-bottom:4px;">Main view</div>
            <div class="settings-toggle-row" id="mainViewRow">
              <button class="settings-toggle ${curMode === 'map' ? 'active' : ''}" data-view="map">Floorplan</button>
              <button class="settings-toggle ${isSplitH ? 'active' : ''}" data-view="split-h">Split ↔</button>
              <button class="settings-toggle ${isSplitV ? 'active' : ''}" data-view="split-v">Split ↕</button>
              <button class="settings-toggle ${curMode === 'cameras' ? 'active' : ''}" data-view="cameras">Cameras</button>
            </div>

            <!-- Level 2: Floor panels (shown when map or split is active) -->
            ${(curMode === 'map' || curMode === 'split') && floors.length > 1 ? (()=>{
              const numPanels = parseInt(localStorage.getItem('ow_map_panels')||'1');
              const panelsDir = localStorage.getItem('ow_panels_dir')||'h';
              return '<div style="margin-top:10px;">'
                + '<div style="font-size:11px;color:#666;margin-bottom:4px;">Floor panels</div>'
                + '<div class="settings-toggle-row" id="floorPanelRow">'
                + '<button class="settings-toggle' + (numPanels===1?' active':'') + '" data-panels="1">1 Panel</button>'
                + '<button class="settings-toggle' + (numPanels===2&&panelsDir==='h'?' active':'') + '" data-panels="2" data-panels-dir="h">2 ↔</button>'
                + '<button class="settings-toggle' + (numPanels===2&&panelsDir==='v'?' active':'') + '" data-panels="2" data-panels-dir="v">2 ↕</button>'
                + '</div>'
                + (numPanels >= 2 ? (()=>{
                    const p0 = localStorage.getItem('ow_panel_0_floor') || (floors[0]?.id||'');
                    const p1 = localStorage.getItem('ow_panel_1_floor') || (floors[1]?.id||floors[0]?.id||'');
                    const floorOpts = floors.map(f=>'<option value="'+f.id+'">'+ f.name +'</option>').join('');
                    return '<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">'
                      + '<div style="display:flex;align-items:center;gap:8px;">'
                      + '<span style="font-size:11px;color:#888;width:52px;">Panel 1</span>'
                      + '<select id="panel0FloorSel" style="flex:1;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:4px 8px;color:#fff;font-size:12px;">'
                      + floors.map(f=>'<option value="'+f.id+'"'+(f.id===p0?' selected':'')+'>'+f.name+'</option>').join('')
                      + '</select></div>'
                      + '<div style="display:flex;align-items:center;gap:8px;">'
                      + '<span style="font-size:11px;color:#888;width:52px;">Panel 2</span>'
                      + '<select id="panel1FloorSel" style="flex:1;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:4px 8px;color:#fff;font-size:12px;">'
                      + floors.map(f=>'<option value="'+f.id+'"'+(f.id===p1?' selected':'')+'>'+f.name+'</option>').join('')
                      + '</select></div>'
                      + '</div>';
                  })() : '')
                + '</div>';
            })() : ''}

            <div style="font-size:11px;color:#777;margin-top:6px;">Saved per device.</div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Sidebar ${perDeviceBadge}</div>
          <div class="settings-field">
            <label>Position</label>
            <div class="settings-toggle-row">
              <button class="settings-toggle ${uiConfig.sidebar_position !== 'left' ? 'active' : ''}" id="sidebarRight">Right</button>
              <button class="settings-toggle ${uiConfig.sidebar_position === 'left' ? 'active' : ''}" id="sidebarLeft">Left</button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Floor Settings ${perDeviceBadge}</div>
          ${floors.length <= 1
            ? '<div style="font-size:11px;color:#666;">Add multiple floors in the Zones tab to enable floor settings.</div>'
            : (() => {
                const multiPanel = getNumPanels() > 1;
                const disStyle   = multiPanel ? 'opacity:0.35;pointer-events:none;' : '';
                const mpNote     = multiPanel ? '<div style="font-size:10px;color:#666;padding-bottom:6px;">Multi-panel active — auto-switch and camera floor filter are unavailable.</div>' : '';
                const autoOn     = localStorage.getItem('ow_auto_floor') === 'true';
                const subStyle   = autoOn ? '' : 'opacity:0.4;pointer-events:none;';
                return mpNote
                  + '<div style="display:flex;flex-direction:column;gap:8px;">'
                  + '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">'
                  + '<input type="checkbox" id="hideFloorLabelChk" ' + (localStorage.getItem('ow_hide_floor_label')==='true' ? 'checked' : '') + '>'
                  + '<span>Hide floor name label on panels</span></label>'
                  + '<div style="' + disStyle + 'display:flex;flex-direction:column;gap:8px;">'
                  + '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">'
                  + '<input type="checkbox" id="camFloorOnlyChk" ' + (localStorage.getItem('ow_cam_floor_only')==='true' ? 'checked' : '') + (multiPanel ? ' disabled' : '') + '>'
                  + '<span>Show cameras for current floor only</span></label>'
                  + '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">'
                  + '<input type="checkbox" id="autoFloorChk" ' + (autoOn ? 'checked' : '') + (multiPanel ? ' disabled' : '') + '>'
                  + '<span>Auto-switch floor on motion</span></label>'
                  + '<div style="padding-left:24px;display:flex;flex-direction:column;gap:6px;' + subStyle + '">'
                  + '<div style="display:flex;align-items:center;gap:8px;">'
                  + '<label style="flex:1;font-size:12px;">Default floor</label>'
                  + '<select id="defaultFloorSel" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:4px 8px;color:#fff;font-size:12px;">'
                  + floors.map(f => '<option value="' + f.id + '"' + (localStorage.getItem('ow_default_floor')===f.id?' selected':'') + '>' + escapeHtml(f.name) + '</option>').join('')
                  + '</select></div>'
                  + '<div style="display:flex;align-items:center;gap:8px;">'
                  + '<label style="flex:1;font-size:12px;">Stay on triggered floor (s)</label>'
                  + '<input type="number" id="floorStayChk" min="5" max="600" value="' + (localStorage.getItem('ow_floor_stay_secs')||'30') + '" style="width:60px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:4px 8px;color:#fff;font-size:12px;"></div>'
                  + '<div style="display:flex;align-items:center;gap:8px;">'
                  + '<label style="flex:1;font-size:12px;">Return-to-default cooldown (s)</label>'
                  + '<input type="number" id="floorReturnChk" min="5" max="600" value="' + (localStorage.getItem('ow_floor_return_secs')||'60') + '" style="width:60px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:4px 8px;color:#fff;font-size:12px;"></div>'
                  + '</div></div></div>';
              })()
          }
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Status Panels ${perDeviceBadge}</div>
          <div class="settings-field">
            <label class="settings-checkbox-row">
              <input type="checkbox" id="hideZoneStatusChk" ${localStorage.getItem('ow_hide_zone_status') === 'true' ? 'checked' : ''}>
              Hide Zone Status <span style="font-size:11px;color:#777;margin-left:4px;">Per device info panel</span>
            </label>
            <label class="settings-checkbox-row" style="margin-top:8px;display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="hideCamStatusChk" ${localStorage.getItem('ow_hide_camera_status') === 'true' ? 'checked' : ''}>
              Hide Camera Status <span style="font-size:11px;color:#777;margin-left:4px;">Per device info panel</span>
            </label>
          </div>
        </div>

        ${isAdmin ? `
        <div class="settings-section">
          <div class="settings-section-title">HA Integration <span class="settings-admin-badge">Admin</span></div>
          <div style="font-size:11px;color:#666;line-height:1.6;">
            The HA Overwatch custom component is written to
            <code style="background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px;font-size:10px;">/config/custom_components/ha_overwatch/</code>
            automatically on add-on start.<br><br>
            To activate:
            <ol style="margin:6px 0 0 16px;padding:0;">
              <li>Restart Home Assistant</li>
              <li>Go to <b>Settings → Devices &amp; Services → Add Integration</b></li>
              <li>Search for <b>HA Overwatch</b> and follow the steps</li>
            </ol>
            <br>
            Entities created: <code style="font-size:10px;">switch.overwatch_*</code> and <code style="font-size:10px;">binary_sensor.overwatch_*</code>
          </div>
        </div>` : ''}

      </div>

      <!-- ══ ALARM TAB ════════════════════════════════════════════ -->
      <div class="settings-tab-panel" data-panel="alarm">
        <div class="settings-section-title">ALARM CONFIGURATION <span class="settings-admin-badge">ADMIN ONLY</span></div>
        ${adminBox}
        <div class="settings-section" ${!isAdmin ? 'style="opacity:0.45;pointer-events:none;"' : ''}>
          <div class="settings-field">
            <label>Alarm Panel Entity</label>
            ${isAdmin ? `
            <div class="entity-search-wrap" style="position:relative;">
              <input type="text" id="cfgAlarmEntity" value="${escapeHtml(uiConfig.alarm_entity || '')}"
                placeholder="alarm_control_panel.home_alarm" autocomplete="off">
              <div class="entity-search-results" id="alarmEntityResults" style="display:none;"></div>
            </div>
            <div style="font-size:11px;color:#777;margin-top:3px;">Supports alarm_control_panel, input_boolean, switch, etc.</div>
            ` : `<div class="settings-readonly">${escapeHtml(uiConfig.alarm_entity || '—')}${
              uiConfig.alarm_entity && haStates[uiConfig.alarm_entity]?.attributes?.friendly_name
                ? `<span style="color:#666;font-size:11px;display:block;margin-top:2px;">${escapeHtml(haStates[uiConfig.alarm_entity].attributes.friendly_name)}</span>`
                : ''
            }</div>`}
          </div>
          <div class="settings-field">
            <label style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="cfgAlarmInverted" ${uiConfig.alarm_entity_inverted ? 'checked' : ''}
                ${!isAdmin ? 'disabled' : ''} style="width:16px;height:16px;accent-color:#ffcc00;">
              <span>Invert alarm entity (OFF = Armed)</span>
            </label>
          </div>
          <div class="settings-field">
            <label>Label when armed</label>
            ${isAdmin
              ? `<input type="text" id="cfgLabelArmed" value="${escapeHtml(uiConfig.alarm_label_armed || 'Armed')}" style="max-width:160px;">`
              : `<div class="settings-readonly">${escapeHtml(uiConfig.alarm_label_armed || 'Armed')}</div>`}
          </div>
          <div class="settings-field">
            <label>Label when disarmed</label>
            ${isAdmin
              ? `<input type="text" id="cfgLabelDisarmed" value="${escapeHtml(uiConfig.alarm_label_disarmed || 'Disarmed')}" style="max-width:160px;">`
              : `<div class="settings-readonly">${escapeHtml(uiConfig.alarm_label_disarmed || 'Disarmed')}</div>`}
          </div>
          ${isAdmin ? `
          <button class="settings-btn" id="settingsSaveAlarmBtn">Save Alarm Settings</button>
          <div id="alarmSaveStatus" style="font-size:11px;color:#888;margin-top:6px;text-align:center;"></div>` : ''}
        </div>
      </div>

      <!-- ══ ZONES TAB ════════════════════════════════════════════ -->
      <div class="settings-tab-panel" data-panel="zones">

        <div class="settings-section">
          <div class="settings-section-title">Zone Toggle Source ${perDeviceBadge}</div>
          <div class="settings-toggle-row">
            <button class="settings-toggle ${localStorage.getItem('ow_zone_source') !== 'device' ? 'active' : ''}" data-zonesource="server">HA defaults (server)</button>
            <button class="settings-toggle ${localStorage.getItem('ow_zone_source') === 'device' ? 'active' : ''}" data-zonesource="device">Per device (this browser)</button>
          </div>
          <div style="font-size:11px;color:#777;margin-top:4px;"><b>HA defaults:</b> zone toggles reflect HA switch state. Locked on remote browsers (no WebSocket).<br><b>Per device:</b> each browser stores its own zone on/off state independently of HA.</div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Floorplan Behaviour ${perDeviceBadge}</div>
          <div style="font-size:11px;color:#666;margin-bottom:4px;">Saved per device. Admin sets the default via ui.yaml; browser overrides locally.</div>
          <div class="settings-field">
            <label>Zone fade-out (seconds)</label>
            <input type="number" id="cfgFadeDuration" value="${eff('ow_fade_duration','zone_fade_duration','3')}"
              min="0" max="30" step="0.5" style="width:80px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;color:#fff;padding:6px 8px;font-size:13px;outline:none;">
            <div style="font-size:11px;color:#777;margin-top:3px;">How long a zone fades out after trigger clears. 0 = instant.</div>
          </div>
          <div class="settings-field">
            <label>Flash behaviour when triggered</label>
            <div class="settings-toggle-row">
              <button class="settings-toggle ${eff('ow_flash_mode','zone_flash_mode','zone') === 'zone'  ? 'active' : ''}" data-flash="zone">Zone only</button>
              <button class="settings-toggle ${eff('ow_flash_mode','zone_flash_mode','zone') === 'group' ? 'active' : ''}" data-flash="group">Whole group</button>
            </div>
            <div style="font-size:11px;color:#777;margin-top:4px;"><b>Zone only:</b> just the triggered zone flashes.<br><b>Whole group:</b> all zones in the group flash.</div>
          </div>
          <div class="settings-field" style="margin-top:10px;">
            <label>Disarmed zone behaviour</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:6px;">
              <input type="checkbox" id="hideDisarmedFlashChk" ${localStorage.getItem('ow_hide_disarmed_flash') === 'true' ? 'checked' : ''}>
              Hide flashing on disarmed zones with active sensors
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:6px;">
              <input type="checkbox" id="smokeCoAlwaysArmedChk" ${localStorage.getItem('ow_smoke_co_always_armed') === 'true' ? 'checked' : ''}>
              Treat Smoke &amp; CO as always armed
              <span style="font-size:11px;color:#777;margin-left:2px;">(use armed colours even when disarmed)</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:6px;">
              <input type="checkbox" id="hideDoorAlertDisarmedChk" ${localStorage.getItem('ow_hide_door_alert_disarmed') === 'true' ? 'checked' : ''}>
              Suppress open door/window alerts for disarmed zones
              <span style="font-size:11px;color:#777;margin-left:2px;">(no animation when zone is disarmed)</span>
            </label>
          </div>
          <div class="settings-field">
            <label>Map icons</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:6px;">
              <input type="checkbox" id="hideLightsChk" ${localStorage.getItem('ow_hide_lights') === 'true' ? 'checked' : ''}>
              Hide light icons on map
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:4px;">
              <input type="checkbox" id="hideSirensChk" ${localStorage.getItem('ow_hide_sirens') === 'true' ? 'checked' : ''}>
              Hide siren icons on map
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:4px;">
              <input type="checkbox" id="hideCamPinsChk" ${localStorage.getItem('ow_hide_cam_pins') === 'true' ? 'checked' : ''}>
              Hide camera icons on map
            </label>
            <div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">
              <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px;">Zone detail popup</label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="zonePopupThumbsChk" ${localStorage.getItem('ow_zone_popup_thumbs') === 'true' ? 'checked' : ''}>
                Show camera thumbnails in zone panel
              </label>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title" id="zoneColourToggle"
            style="cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between;">
            <span>Zone Colours ${perDeviceBadge}</span>
            <span id="zoneColourChevron" style="font-size:10px;color:#666;transition:transform 0.2s;">▼</span>
          </div>
          <div id="zoneColourBody" style="display:none;">
          <div style="font-size:11px;color:#666;margin-bottom:6px;">Admin sets server defaults. Browser saves locally and overrides them per device.</div>
          <div class="settings-section-title" style="font-size:10px;margin-top:4px;">Armed</div>
          <div class="settings-color-grid">
            <div class="settings-color-item"><label>Person</label><input type="color" id="cfgColOnPerson" value="${eff('ow_color_on_person','color_on_person','#ff3b30')}"></div>
            <div class="settings-color-item"><label>Motion</label><input type="color" id="cfgColOnMotion" value="${eff('ow_color_on_motion','color_on_motion','#ff9500')}"></div>
            <div class="settings-color-item"><label>Door</label><input type="color" id="cfgColOnDoor" value="${eff('ow_color_on_door','color_on_door','#ff6b35')}"></div>
            <div class="settings-color-item"><label>Window</label><input type="color" id="cfgColOnWindow" value="${eff('ow_color_on_window','color_on_window','#ff9f0a')}"></div>
            <div class="settings-color-item"><label>Animal</label><input type="color" id="cfgColOnAnimal" value="${eff('ow_color_on_animal','color_on_animal','#ff6b00')}"></div>
            <div class="settings-color-item"><label>Vehicle</label><input type="color" id="cfgColOnVehicle" value="${eff('ow_color_on_vehicle','color_on_vehicle','#ff3b80')}"></div>
            <div class="settings-color-item"><label>Smoke</label><input type="color" id="cfgColOnSmoke" value="${eff('ow_color_on_smoke','color_on_smoke','#ff2d55')}"></div>
            <div class="settings-color-item"><label>CO/Gas</label><input type="color" id="cfgColOnCo" value="${eff('ow_color_on_co','color_on_co','#bf5af2')}"></div>
          </div>
          <div class="settings-section-title" style="font-size:10px;margin-top:10px;">Disarmed</div>
          <div class="settings-color-grid">
            <div class="settings-color-item"><label>Person</label><input type="color" id="cfgColOffPerson" value="${eff('ow_color_off_person','color_off_person','#4cd964')}"></div>
            <div class="settings-color-item"><label>Motion</label><input type="color" id="cfgColOffMotion" value="${eff('ow_color_off_motion','color_off_motion','#5ac8fa')}"></div>
            <div class="settings-color-item"><label>Door</label><input type="color" id="cfgColOffDoor" value="${eff('ow_color_off_door','color_off_door','#ffcc00')}"></div>
            <div class="settings-color-item"><label>Window</label><input type="color" id="cfgColOffWindow" value="${eff('ow_color_off_window','color_off_window','#ffcc00')}"></div>
            <div class="settings-color-item"><label>Animal</label><input type="color" id="cfgColOffAnimal" value="${eff('ow_color_off_animal','color_off_animal','#aad400')}"></div>
            <div class="settings-color-item"><label>Vehicle</label><input type="color" id="cfgColOffVehicle" value="${eff('ow_color_off_vehicle','color_off_vehicle','#00c7be')}"></div>
            <div class="settings-color-item"><label>Smoke</label><input type="color" id="cfgColOffSmoke" value="${eff('ow_color_off_smoke','color_off_smoke','#ff6b6b')}"></div>
            <div class="settings-color-item"><label>CO/Gas</label><input type="color" id="cfgColOffCo" value="${eff('ow_color_off_co','color_off_co','#cc73f8')}"></div>
          </div>
          ${isAdmin ? `<div style="font-size:10px;color:#444;margin-top:4px;">Admin: <a href="#" id="settingsSaveColoursYamlLink" style="color:#666;">Save as server default</a></div>` : `
          <div style="margin-top:8px;">
            <button id="resetColoursBtn" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);color:#888;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;">Reset to server defaults</button>
            <span id="resetColoursStatus" style="font-size:10px;color:#555;margin-left:6px;"></span>
          </div>`}
          </div><!-- /zoneColourBody -->
        </div>
      </div>

      <!-- ══ CAMERAS TAB ══════════════════════════════════════════ -->
      <div class="settings-tab-panel" data-panel="cameras">

        <div class="settings-section">
          <div class="settings-section-title">Camera Toggle Source ${perDeviceBadge}</div>
          <div class="settings-field">
            <label>Camera visibility controlled by</label>
            <div class="settings-toggle-row">
              <button class="settings-toggle ${localStorage.getItem('ow_cam_source') !== 'device' ? 'active' : ''}" data-camsource="server">Server defaults (HA entities)</button>
              <button class="settings-toggle ${localStorage.getItem('ow_cam_source') === 'device' ? 'active' : ''}" data-camsource="device">Per device (this browser)</button>
            </div>
            <div style="font-size:11px;color:#777;margin-top:4px;">
              <b>Server defaults:</b> camera visibility follows HA entity states — consistent across all browsers and controllable via HA automations.<br>
              <b>Per device:</b> this browser uses its own camera toggle settings, ignoring HA entity state.
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Display ${perDeviceBadge}</div>
          <div class="settings-field">
            <label>Camera mode</label>
            <div class="settings-toggle-row">
              <button class="settings-toggle ${eff('ow_cam_mode_v4','cam_default_mode','live') !== 'live' ? 'active' : ''}" data-cammode="snapshot">Snapshot</button>
              <button class="settings-toggle ${eff('ow_cam_mode_v4','cam_default_mode','live') === 'live' ? 'active' : ''}" data-cammode="live">Live</button>
            </div>
            <div style="font-size:11px;color:#777;margin-top:4px;"><b>Snapshot:</b> lower bandwidth, periodic refresh.<br><b>Live:</b> MJPEG stream, instant but more resources.</div>
          </div>
          <div class="settings-field" id="hideCamLabelsField" style="margin-top:6px;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input type="checkbox" id="cfgHideCamLabels" ${eff('ow_hide_cam_labels','cam_hide_labels','false') === 'true' ? 'checked' : ''}
                style="width:16px;height:16px;accent-color:#0096ff;cursor:pointer;">
              <span>Hide camera name labels on tiles</span>
            </label>
          </div>
          <div class="settings-field" style="margin-top:6px;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input type="checkbox" id="cfgAlwaysHighRes" ${localStorage.getItem('ow_cam_always_high_res') === 'true' ? 'checked' : ''}
                style="width:16px;height:16px;accent-color:#0096ff;cursor:pointer;">
              <span>Always use high resolution (ignore low-res assignments)</span>
            </label>
          </div>
          <div class="settings-field" style="margin-top:6px;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input type="checkbox" id="cfgHideDisarmedCams" ${localStorage.getItem('ow_hide_disarmed_cams') === 'true' ? 'checked' : ''}
                style="width:16px;height:16px;accent-color:#0096ff;cursor:pointer;">
              <span>Hide cameras from disarmed zones in camera panel</span>
            </label>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Performance ${perDeviceBadge}</div>
          <div style="font-size:11px;color:#666;margin-bottom:6px;">Admin sets the default. Browser overrides locally without changing server config.</div>
          <div class="settings-field">
            <label>Snapshot refresh interval (seconds)</label>
            <input type="number" id="cfgSnapInterval" value="${eff('ow_snap_interval','cam_snapshot_interval','2')}"
              min="1" max="30" style="width:70px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;color:#fff;padding:6px 8px;font-size:13px;outline:none;">
          </div>
          <div class="settings-field">
            <label>Camera cooldown after zone clears (seconds)</label>
            <input type="number" id="cfgCamCooldown" value="${eff('ow_cam_cooldown','cam_cooldown','30')}"
              min="0" max="300" style="width:70px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;color:#fff;padding:6px 8px;font-size:13px;outline:none;">
          </div>
          ${isAdmin ? `
          <div style="font-size:10px;color:#444;margin-top:6px;">Admin: <a href="#" id="settingsSavePerfYamlLink" style="color:#666;">Save as server default</a></div>` : ''}
        </div>

      </div>

    </div>
  `;

  document.body.appendChild(panel);
  makeDraggable(panel, panel.querySelector(".settings-titlebar"), "settingsPanel");
  document.getElementById("settingsCloseBtn").onclick = () => panel.classList.remove("open");
  panel.addEventListener("pointerdown", e => e.stopPropagation());

  // Live-update HA connection status every 2s while settings is open
  const connPollTimer = setInterval(() => {
    if (!panel.classList.contains("open")) { clearInterval(connPollTimer); return; }
    updateSettingsConnectionBox();
  }, 2000);

  // ── Tab switching ────────────────────────────────────────────
  panel.querySelectorAll(".settings-tab").forEach(tab => {
    tab.onclick = () => {
      panel.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      panel.querySelectorAll(".settings-tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      panel.querySelector(`.settings-tab-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add("active");
    };
  });

  // ── View mode ────────────────────────────────────────────────
  panel.querySelectorAll(".settings-toggle[data-view]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-view]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const v = btn.dataset.view;
      if (v === 'split-h') {
        localStorage.setItem('ow_split_dir', 'h');
        document.body.setAttribute('data-split-dir', 'h');
        setViewMode('split');
      } else if (v === 'split-v') {
        localStorage.setItem('ow_split_dir', 'v');
        document.body.setAttribute('data-split-dir', 'v');
        setViewMode('split');
      } else {
        setViewMode(v);
      }
      // Re-render settings to show/hide floor panel options
      openSettings("general");
    };
  });

  // ── Floor panels ─────────────────────────────────────────────
  panel.querySelectorAll(".settings-toggle[data-panels]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-panels]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const n   = parseInt(btn.dataset.panels);
      const dir = btn.dataset.panelsDir || 'h';
      localStorage.setItem('ow_map_panels', n);
      if (n >= 2) localStorage.setItem('ow_panels_dir', dir);
      applyFloorPanels();
      openSettings("general"); // re-render to show/hide selectors
    };
  });

  const p0sel = document.getElementById("panel0FloorSel");
  const p1sel = document.getElementById("panel1FloorSel");
  if (p0sel) p0sel.onchange = () => {
    localStorage.setItem('ow_panel_0_floor', p0sel.value);
    applyFloorPanels();
  };
  if (p1sel) p1sel.onchange = () => {
    localStorage.setItem('ow_panel_1_floor', p1sel.value);
    applyFloorPanels();
  };

  // ── Flash mode ───────────────────────────────────────────────
  panel.querySelectorAll(".settings-toggle[data-flash]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-flash]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem('ow_flash_mode', btn.dataset.flash);
    };
  });

  // ── Camera source toggle (server/device) ────────────────────
  panel.querySelectorAll(".settings-toggle[data-camsource]").forEach(btn => {
    btn.onclick = async () => {
      panel.querySelectorAll(".settings-toggle[data-camsource]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem('ow_cam_source', btn.dataset.camsource);
      // If switching to server mode, fetch latest state immediately
      if (btn.dataset.camsource !== 'device' && window._camRefreshServerState) {
        await window._camRefreshServerState();
      }
      // Re-render both the status bar (dropdown locked state + dots) and grid
      if (window.renderCameraStatusBar) { window.renderCameraStatusBar(); applyStatusVisibility(); }
      if (window.camUpdate) window.camUpdate();
    };
  });

  // ── Zone source toggle (server/device) ──────────────────────
  panel.querySelectorAll(".settings-toggle[data-zonesource]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-zonesource]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem(ZONE_MODE_KEY, btn.dataset.zonesource);
      renderStatusDropdown();
      renderZones();
    };
  });

  // ── Zone behaviour — auto-save to localStorage on change ─────
  document.getElementById("cfgFadeDuration")?.addEventListener("change", function() {
    localStorage.setItem('ow_fade_duration', this.value);
  });

  // ── Camera display — auto-save to localStorage on change ─────
  panel.querySelectorAll(".settings-toggle[data-cammode]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-cammode]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem('ow_cam_mode_v4', 'snapshot');
      if (window._camSetMode) window._camSetMode('snapshot');
    };
  });

  // ── Camera performance — auto-save to localStorage on change ──
  document.getElementById("cfgSnapInterval")?.addEventListener("change", function() {
    localStorage.setItem('ow_snap_interval', this.value);
  });
  document.getElementById("cfgCamCooldown")?.addEventListener("change", function() {
    localStorage.setItem('ow_cam_cooldown', this.value);
  });
  panel.querySelectorAll(".settings-toggle[data-cammode]").forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll(".settings-toggle[data-cammode]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem('ow_cam_mode_v4', 'snapshot');
      if (window._camSetMode) window._camSetMode('snapshot');
    };
  });

  // ── Camera labels ────────────────────────────────────────────
  document.getElementById("cfgHideCamLabels")?.addEventListener("change", function() {
    localStorage.setItem('ow_hide_cam_labels', this.checked ? 'true' : 'false');
    document.querySelectorAll('.cam-tile-label').forEach(el => {
      el.style.display = this.checked ? 'none' : '';
    });
  });

  document.getElementById("cfgAlwaysHighRes")?.addEventListener("change", function() {
    localStorage.setItem('ow_cam_always_high_res', this.checked ? 'true' : 'false');
    if (window.renderCameraStatusBar) { window.renderCameraStatusBar(); applyStatusVisibility(); }
  });
  document.getElementById("cfgHideDisarmedCams")?.addEventListener("change", function() {
    localStorage.setItem('ow_hide_disarmed_cams', this.checked ? 'true' : 'false');
    if (window.renderCameraStatusBar) { window.renderCameraStatusBar(); applyStatusVisibility(); }
  });

  // ── Sidebar position ─────────────────────────────────────────
  const sbRight = document.getElementById("sidebarRight");
  const sbLeft  = document.getElementById("sidebarLeft");
  if (sbRight) sbRight.onclick = () => {
    uiConfig.sidebar_position = "right"; applyConfig(); updateExpandBtn(uiConfig.sidebar_collapsed);
    sbRight.classList.add("active"); sbLeft?.classList.remove("active");
  };
  if (sbLeft) sbLeft.onclick = () => {
    uiConfig.sidebar_position = "left"; applyConfig(); updateExpandBtn(uiConfig.sidebar_collapsed);
    sbLeft.classList.add("active"); sbRight?.classList.remove("active");
  };

  // ── Status panel visibility ───────────────────────────────────
  const hideZoneChk = document.getElementById("hideZoneStatusChk");
  const hideCamChk  = document.getElementById("hideCamStatusChk");
  if (hideZoneChk) hideZoneChk.onchange = () => {
    localStorage.setItem("ow_hide_zone_status", hideZoneChk.checked);
    applyStatusVisibility();
  };
  if (hideCamChk) hideCamChk.onchange = () => {
    localStorage.setItem("ow_hide_camera_status", hideCamChk.checked);
    applyStatusVisibility();
  };

  // ── Map icon visibility ───────────────────────────────────────
  document.getElementById("hideDisarmedFlashChk")?.addEventListener("change", function() {
    localStorage.setItem('ow_hide_disarmed_flash', this.checked ? 'true' : 'false');
    renderZones();
  });

  document.getElementById("smokeCoAlwaysArmedChk")?.addEventListener("change", function() {
    localStorage.setItem('ow_smoke_co_always_armed', this.checked ? 'true' : 'false');
    renderZones();
  });

  document.getElementById("hideDoorAlertDisarmedChk")?.addEventListener("change", function() {
    localStorage.setItem('ow_hide_door_alert_disarmed', this.checked ? 'true' : 'false');
    renderZones();
  });

  const hideLightsChk  = document.getElementById('hideLightsChk');
  const hideSirensChk  = document.getElementById('hideSirensChk');
  const hideCamPinsChk = document.getElementById('hideCamPinsChk');
  if (hideLightsChk) hideLightsChk.onchange = () => {
    localStorage.setItem('ow_hide_lights', hideLightsChk.checked ? 'true' : 'false');
    renderZones();
  };
  if (hideSirensChk) hideSirensChk.onchange = () => {
    localStorage.setItem('ow_hide_sirens', hideSirensChk.checked ? 'true' : 'false');
    renderZones();
  };
  if (hideCamPinsChk) hideCamPinsChk.onchange = () => {
    localStorage.setItem('ow_hide_cam_pins', hideCamPinsChk.checked ? 'true' : 'false');
    renderZones();
  };
  const zonePopupThumbsChk = document.getElementById('zonePopupThumbsChk');
  if (zonePopupThumbsChk) zonePopupThumbsChk.onchange = () => {
    localStorage.setItem('ow_zone_popup_thumbs', zonePopupThumbsChk.checked ? 'true' : 'false');
    refreshZonePopupIfOpen();
  };

  // ── Floor settings ────────────────────────────────────────────
  const hideFloorLabelChk = document.getElementById("hideFloorLabelChk");
  if (hideFloorLabelChk) hideFloorLabelChk.onchange = () => {
    localStorage.setItem('ow_hide_floor_label', hideFloorLabelChk.checked);
    applyFloorPanels(); // rebuild panels to show/hide labels
  };

  const camFloorOnlyChk = document.getElementById("camFloorOnlyChk");
  const autoFloorChk    = document.getElementById("autoFloorChk");
  const defaultFloorSel = document.getElementById("defaultFloorSel");
  const floorStayInput  = document.getElementById("floorStayChk");
  const floorReturnInput = document.getElementById("floorReturnChk");
  const floorSubSettings = autoFloorChk?.closest(".settings-field")?.nextElementSibling;

  if (camFloorOnlyChk) camFloorOnlyChk.onchange = () => {
    localStorage.setItem("ow_cam_floor_only", camFloorOnlyChk.checked);
    if (window.renderCameraStatusBar) { window.renderCameraStatusBar(); applyStatusVisibility(); }
    if (window.camUpdate) window.camUpdate();
  };
  if (autoFloorChk) autoFloorChk.onchange = () => {
    localStorage.setItem("ow_auto_floor", autoFloorChk.checked);
    // Toggle sub-settings opacity
    const sub = document.querySelector("#autoFloorChk")?.closest("label")?.nextElementSibling;
    if (sub) sub.style.cssText = `padding-left:24px;display:flex;flex-direction:column;gap:6px;${!autoFloorChk.checked ? 'opacity:0.4;pointer-events:none;' : ''}`;
  };
  if (defaultFloorSel) defaultFloorSel.onchange = () => {
    localStorage.setItem("ow_default_floor", defaultFloorSel.value);
  };
  if (floorStayInput) floorStayInput.onchange = () => {
    localStorage.setItem("ow_floor_stay_secs", floorStayInput.value);
  };
  if (floorReturnInput) floorReturnInput.onchange = () => {
    localStorage.setItem("ow_floor_return_secs", floorReturnInput.value);
  };

  // ── Save zone behaviour to localStorage ──────────────────────
  // ── Colours — auto-save to localStorage on change ────────────
  const colourMap = {
    cfgColOnPerson: 'ow_color_on_person',  cfgColOnMotion:  'ow_color_on_motion',
    cfgColOnDoor:   'ow_color_on_door',    cfgColOnWindow:  'ow_color_on_window',
    cfgColOnAnimal: 'ow_color_on_animal',  cfgColOnVehicle: 'ow_color_on_vehicle',
    cfgColOnSmoke:  'ow_color_on_smoke',   cfgColOnCo:      'ow_color_on_co',
    cfgColOffPerson:'ow_color_off_person', cfgColOffMotion: 'ow_color_off_motion',
    cfgColOffDoor:  'ow_color_off_door',   cfgColOffWindow: 'ow_color_off_window',
    cfgColOffAnimal:'ow_color_off_animal', cfgColOffVehicle:'ow_color_off_vehicle',
    cfgColOffSmoke: 'ow_color_off_smoke',  cfgColOffCo:     'ow_color_off_co',
  };
  Object.entries(colourMap).forEach(([id, lsKey]) => {
    document.getElementById(id)?.addEventListener("input", function() {
      localStorage.setItem(lsKey, this.value);
      applyConfig();   // update CSS variables immediately
      renderZones();   // re-render floorplan with new colours
    });
  });

  if (!isAdmin) {
    // Non-admin: still wire the reset button
    document.getElementById("resetColoursBtn")?.addEventListener("click", () => {
      const colourLsKeys = [
        'ow_color_on_person','ow_color_on_motion','ow_color_on_door','ow_color_on_window',
        'ow_color_on_animal','ow_color_on_vehicle','ow_color_on_smoke','ow_color_on_co','ow_color_on_default',
        'ow_color_off_person','ow_color_off_motion','ow_color_off_door','ow_color_off_window',
        'ow_color_off_animal','ow_color_off_vehicle','ow_color_off_smoke','ow_color_off_co','ow_color_off_default',
        'ow_color_zone_triggered','ow_color_zone_fault','ow_color_zone_bypassed','ow_color_zone_armed','ow_color_zone_normal'
      ];
      colourLsKeys.forEach(k => localStorage.removeItem(k));
      applyConfig();
      renderZones();
      openSettings('zones');
      const st = document.getElementById('resetColoursStatus');
      if (st) { st.textContent = '✓ Reset'; setTimeout(() => st.textContent = '', 2000); }
    });
    return;  // ══ Admin-only bindings below ══════════
  }

  // ── Alarm entity live search ─────────────────────────────────
  const alarmInput   = document.getElementById("cfgAlarmEntity");
  const alarmResults = document.getElementById("alarmEntityResults");
  if (alarmInput && alarmResults) {
    alarmInput.oninput = () => {
      const q = alarmInput.value.trim().toLowerCase();
      if (!q || !haConnected) { alarmResults.style.display = "none"; return; }
      const hits = Object.keys(haStates).filter(id => id.toLowerCase().includes(q)).slice(0, 20)
        .map(id => ({ id, state: haStates[id]?.state || "—", friendly: haStates[id]?.attributes?.friendly_name || "" }));
      if (!hits.length) { alarmResults.style.display = "none"; return; }
      alarmResults.innerHTML = hits.map(h => `
        <div class="entity-search-result" data-entity-id="${escapeHtml(h.id)}">
          <span class="entity-search-id">${escapeHtml(h.id)}</span>
          <span class="entity-search-state">${escapeHtml(h.state)}</span>
          ${h.friendly ? `<span class="entity-search-friendly">${escapeHtml(h.friendly)}</span>` : ""}
        </div>`).join("");
      alarmResults.style.display = "block";
      alarmResults.querySelectorAll(".entity-search-result").forEach(el => {
        el.onclick = () => { alarmInput.value = el.dataset.entityId; alarmResults.style.display = "none"; };
      });
    };
    document.addEventListener("pointerdown", function hideAlarm(e) {
      if (!alarmInput.contains(e.target) && !alarmResults.contains(e.target)) {
        alarmResults.style.display = "none";
        document.removeEventListener("pointerdown", hideAlarm);
      }
    });
  }

  // ── Floors settings ────────────────────────────────────────────
  // Helper: upload a floorplan image and return the path
  async function uploadFloorplanFile(file, statusEl) {
    if (statusEl) statusEl.textContent = "Uploading…";
    const form = new FormData(); form.append("file", file);
    const res = await fetch(apiPath("ow/upload-floorplan"), { method: "POST", body: form });
    if (!res.ok) throw new Error("Upload failed (" + res.status + ")");
    const data = await res.json().catch(() => ({}));
    const imgPath = data.path || ("img/" + file.name);
    if (statusEl) { statusEl.textContent = "✓ " + imgPath; statusEl.style.color = "#32d74b"; }
    return imgPath;
  }

  // ── Build ui.yaml ────────────────────────────────────────────
  function buildYamlContent() {
    const g = id => document.getElementById(id)?.value || "";
    return (
      `ui:\n` +
      `  ha_url: "${uiConfig.ha_url || ""}"\n` +
      `  ha_token: "${g("cfgHaToken") || uiConfig.ha_token || ""}"\n` +
      `  alarm_entity: "${g("cfgAlarmEntity") || uiConfig.alarm_entity || ""}"\n` +
      `  alarm_entity_inverted: ${document.getElementById("cfgAlarmInverted")?.checked ?? false}\n` +
      `  alarm_label_armed: "${g("cfgLabelArmed") || uiConfig.alarm_label_armed || "Armed"}"\n` +
      `  alarm_label_disarmed: "${g("cfgLabelDisarmed") || uiConfig.alarm_label_disarmed || "Disarmed"}"\n` +
      `  sidebar_position: "${uiConfig.sidebar_position}"\n` +
      `  floorplan: "${activeFloor()?.floorplan || uiConfig.floorplan || "img/floorplan.png"}"\n` +
      `  zone_fade_duration: ${g("cfgFadeDuration") || uiConfig.zone_fade_duration || 3}\n` +
      `  color_on_person: "${g("cfgColOnPerson") || uiConfig.color_on_person}"\n` +
      `  color_on_motion: "${g("cfgColOnMotion") || uiConfig.color_on_motion}"\n` +
      `  color_on_door: "${g("cfgColOnDoor") || uiConfig.color_on_door}"\n` +
      `  color_on_window: "${g("cfgColOnWindow") || uiConfig.color_on_window}"\n` +
      `  color_on_animal: "${g("cfgColOnAnimal") || uiConfig.color_on_animal}"\n` +
      `  color_on_vehicle: "${g("cfgColOnVehicle") || uiConfig.color_on_vehicle}"\n` +
      `  color_on_smoke: "${g("cfgColOnSmoke") || uiConfig.color_on_smoke}"\n` +
      `  color_on_co: "${g("cfgColOnCo") || uiConfig.color_on_co}"\n` +
      `  color_off_person: "${g("cfgColOffPerson") || uiConfig.color_off_person}"\n` +
      `  color_off_motion: "${g("cfgColOffMotion") || uiConfig.color_off_motion}"\n` +
      `  color_off_door: "${g("cfgColOffDoor") || uiConfig.color_off_door}"\n` +
      `  color_off_window: "${g("cfgColOffWindow") || uiConfig.color_off_window}"\n` +
      `  color_off_animal: "${g("cfgColOffAnimal") || uiConfig.color_off_animal}"\n` +
      `  color_off_vehicle: "${g("cfgColOffVehicle") || uiConfig.color_off_vehicle}"\n` +
      `  color_off_smoke: "${g("cfgColOffSmoke") || uiConfig.color_off_smoke}"\n` +
      `  color_off_co: "${g("cfgColOffCo") || uiConfig.color_off_co}"\n` +
      `  cam_default_mode: "${uiConfig.cam_default_mode || "snapshot"}"\n` +
      `  cam_snapshot_interval: ${uiConfig.cam_snapshot_interval || 2}\n` +
      `  cam_cooldown: ${uiConfig.cam_cooldown || 30}\n` +
      `  cam_max_visible: ${uiConfig.cam_max_visible || 0}\n` +
      `  cam_sort_order: "${uiConfig.cam_sort_order || "recent_first"}"\n` +
      `  cam_fail_hide_seconds: ${uiConfig.cam_fail_hide_seconds || 5}\n` +
      `  cam_low_res_map: '${uiConfig.cam_low_res_map || "{}"}'\n` +
      `  cam_pinned: '${uiConfig.cam_pinned || "[]"}'\n`
    );
  }

  async function saveYaml(statusId) {
    const el = document.getElementById(statusId);
    if (el) { el.textContent = "Saving…"; el.style.color = "#888"; }
    try {
      const res = await fetch(apiPath("ow/save-config"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "config/ui.yaml", content: buildYamlContent() })
      });
      if (res.ok) {
        if (el) { el.textContent = "✓ Saved"; el.style.color = "#32d74b"; }
        await loadConfig();
      } else if (el) { el.textContent = "✗ Save failed"; el.style.color = "#ff3b30"; }
    } catch (e) { if (el) { el.textContent = "✗ " + e.message; el.style.color = "#ff3b30"; } }
  }

  // ── HA connect ───────────────────────────────────────────────
  const connectBtn    = document.getElementById("settingsSaveHaBtn");
  const tokenField    = document.getElementById("cfgHaToken");
  const connectStatus = document.getElementById("haConnectStatus");

  // Arm/Disarm IP allow list
  document.getElementById("saveArmIpsBtn")?.addEventListener("click", async () => {
    const raw = document.getElementById("cfgArmAllowedIps")?.value || "";
    const ips = raw.split("\n").map(s => s.trim()).filter(Boolean);
    await saveArmAllowedIps(ips);
    const btn = document.getElementById("saveArmIpsBtn");
    if (btn) { btn.textContent = "✓ Saved"; setTimeout(() => btn.textContent = "Save allowed IPs", 1500); }
  });
  if (tokenField && connectBtn) {
    tokenField.addEventListener("input", () => {
      connectBtn.style.opacity = "1";
      connectBtn.textContent = "Connect to Home Assistant";
    });
  }
  if (connectBtn) {
    connectBtn.onclick = async () => {
      const newToken = tokenField?.value.trim() || "";
      if (!newToken && !uiConfig.ha_token) {
        if (connectStatus) { connectStatus.textContent = "✗ Enter a token first."; connectStatus.style.color = "#ff3b30"; }
        return;
      }
      if (newToken) {
        uiConfig.ha_token = newToken;
        try {
          await fetch(apiPath("ow/save-config"), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: "config/ui.yaml", content: buildYamlContent() })
          });
        } catch { /* non-fatal */ }
      }
      if (haSocket) { haSocket.onclose = null; haSocket.close(); haSocket = null; haConnected = false; }
      if (!IS_DIRECT_MODE) connectHA();
      if (connectStatus) { connectStatus.textContent = "Connecting…"; connectStatus.style.color = "#888"; }
    };
  }

  document.getElementById("settingsSaveAlarmBtn")?.addEventListener("click",   () => saveYaml("alarmSaveStatus"));

  // ── Zone Colours collapsible ─────────────────────────────────
  // Use document-level delegation so it works regardless of tab state
  if (!window._zoneColourDelegationBound) {
    window._zoneColourDelegationBound = true;
    document.addEventListener('click', e => {
      const toggle = e.target.closest('#zoneColourToggle');
      if (!toggle) return;
      const body    = document.getElementById('zoneColourBody');
      const chevron = document.getElementById('zoneColourChevron');
      if (!body) return;
      const open = body.style.display === 'none' || body.style.display === '';
      body.style.display    = open ? 'block' : 'none';
      if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
      localStorage.setItem('ow_zone_colour_open', String(open));
    });
  }
  // Set initial open state
  const _zcb = document.getElementById('zoneColourBody');
  const _zcc = document.getElementById('zoneColourChevron');
  const _zcOpen = localStorage.getItem('ow_zone_colour_open') !== 'false';
  if (_zcb) _zcb.style.display = _zcOpen ? 'block' : 'none';
  if (_zcc) _zcc.style.transform = _zcOpen ? 'rotate(180deg)' : '';

  document.getElementById("settingsSaveColoursYamlLink")?.addEventListener("click", e => {
    e.preventDefault();
    saveYaml("coloursSaveStatus");
  });

  document.getElementById("resetColoursBtn")?.addEventListener("click", () => {
    // Clear all localStorage colour overrides — revert to server uiConfig values
    const colourLsKeys = [
      'ow_color_on_person','ow_color_on_motion','ow_color_on_door','ow_color_on_window',
      'ow_color_on_smoke','ow_color_on_co','ow_color_on_default',
      'ow_color_off_person','ow_color_off_motion','ow_color_off_door','ow_color_off_window',
      'ow_color_off_smoke','ow_color_off_co','ow_color_off_default',
      'ow_color_triggered_door','ow_color_zone_triggered','ow_color_zone_fault',
      'ow_color_zone_bypassed','ow_color_zone_armed','ow_color_zone_normal'
    ];
    colourLsKeys.forEach(k => localStorage.removeItem(k));
    applyConfig();
    renderZones();
    openSettings('zones');
    const st = document.getElementById('resetColoursStatus');
    if (st) { st.textContent = '✓ Reset'; setTimeout(() => st.textContent = '', 2000); }
  });
  document.getElementById("settingsSavePerfYamlLink")?.addEventListener("click", e => {
    e.preventDefault();
    // Update uiConfig with current localStorage overrides before saving to yaml
    const interval = localStorage.getItem('ow_snap_interval');
    const cooldown = localStorage.getItem('ow_cam_cooldown');
    if (interval) uiConfig.cam_snapshot_interval = parseFloat(interval);
    if (cooldown) uiConfig.cam_cooldown = parseFloat(cooldown);
    saveYaml("perfSaveStatus");
  });
}

function makeDraggable(panel, titlebar, storageKey) {
  if (!panel || !titlebar) return () => {};

  let drag = { active: false, ox: 0, oy: 0 };
  let pos  = { x: null, y: null };

  function applyPos(x, y) {
    // Clamp to viewport
    x = Math.max(0, Math.min(window.innerWidth  - 60, x));
    y = Math.max(0, Math.min(window.innerHeight - 60, y));
    pos.x = x; pos.y = y;
    panel.style.position = "fixed";
    panel.style.left     = x + "px";
    panel.style.top      = y + "px";
    panel.style.right    = "unset";
    panel.style.bottom   = "unset";
    if (storageKey) {
      localStorage.setItem(storageKey + "_x", x);
      localStorage.setItem(storageKey + "_y", y);
    }
  }

  function restorePos() {
    if (!storageKey) return;
    const sx = localStorage.getItem(storageKey + "_x");
    const sy = localStorage.getItem(storageKey + "_y");
    if (sx !== null && sy !== null) applyPos(Number(sx), Number(sy));
  }

  titlebar.style.cursor = "grab";

  titlebar.addEventListener("pointerdown", e => {
    if (e.target.closest("button, input, select, textarea")) return;
    drag.active = true;
    const rect = panel.getBoundingClientRect();
    drag.ox = e.clientX - rect.left;
    drag.oy = e.clientY - rect.top;
    titlebar.setPointerCapture(e.pointerId);
    titlebar.style.cursor = "grabbing";
    e.preventDefault();
  });

  titlebar.addEventListener("pointermove", e => {
    if (!drag.active) return;
    applyPos(e.clientX - drag.ox, e.clientY - drag.oy);
  });

  titlebar.addEventListener("pointerup", () => {
    drag.active = false;
    titlebar.style.cursor = "grab";
  });

  restorePos();
  return restorePos;
}

function openFloorConfigPanel(floorId) {
  const floor = floors.find(f => f.id === floorId);
  if (!floor) return;

  document.getElementById('owFloorConfigPanel')?.remove();

  const panel = document.createElement('div');
  panel.id = 'owFloorConfigPanel';
  panel.style.cssText = `
    position:fixed; top:120px; left:50%; transform:translateX(-50%);
    background:rgba(18,18,18,0.98); border:1px solid rgba(255,255,255,0.12);
    border-radius:14px; z-index:600; width:420px; max-width:94vw;
    box-shadow:0 16px 48px rgba(0,0,0,0.7); backdrop-filter:blur(16px);
    max-height:85vh; display:flex; flex-direction:column;
  `;

  // Make draggable
  let dragging = false, ox = 0, oy = 0;
  const titlebar = document.createElement('div');
  titlebar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;cursor:grab;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;user-select:none;';
  titlebar.onmousedown = e => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    dragging = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop;
    titlebar.style.cursor = 'grabbing';
  };
  document.addEventListener('mousemove', e => { if (!dragging) return; panel.style.left = (e.clientX - ox) + 'px'; panel.style.top = (e.clientY - oy) + 'px'; panel.style.transform = 'none'; });
  document.addEventListener('mouseup', () => { dragging = false; titlebar.style.cursor = 'grab'; });

  const body = document.createElement('div');
  body.style.cssText = 'padding:14px 16px;overflow-y:auto;flex:1;';

  function render() {
    const haFloors = _haRegistry.floors || [];
    const haAreas  = _haRegistry.areas  || [];
    const linkedHAFloor = haFloors.find(hf => hf.floor_id === floor.ha_floor_id);
    const floorAreas = floor.ha_floor_id ? haAreas.filter(a => a.floor_id === floor.ha_floor_id) : [];
    const linkedAreaIds = floor.ha_linked_area_ids || [];
    const autoAdd = floor.ha_auto_add_areas !== false;
    const floorZones = zones.filter(z => z.floor_id === floor.id);

    // Titlebar content
    titlebar.innerHTML = `
      <div>
        <div style="font-size:13px;font-weight:700;color:#fff;">Floor Configuration</div>
        <div style="font-size:11px;color:#666;margin-top:1px;" id="owFloorConfigFloorName">${escapeHtml(floor.name)}</div>
      </div>
      <button id="owFloorConfigClose" style="background:none;border:none;color:#555;cursor:pointer;font-size:18px;padding:0 4px;line-height:1;">✕</button>
    `;
    titlebar.querySelector('#owFloorConfigClose').onclick = () => panel.remove();

    // Body content
    body.innerHTML = `
      <div style="margin-bottom:12px;">
        <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;">Floor Name</label>
        <input id="owFloorNameInput" type="text" value="${escapeHtml(floor.name)}" style="width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#fff;border-radius:8px;padding:7px 10px;font-size:13px;outline:none;box-sizing:border-box;">
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;">Floorplan Image</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input id="owFloorFpInput" type="text" value="${escapeHtml(floor.floorplan||'')}" placeholder="img/floorplan.png"
            style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#ccc;border-radius:8px;padding:7px 10px;font-size:12px;outline:none;">
          <label style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:7px 10px;cursor:pointer;font-size:12px;color:#aaa;flex-shrink:0;">↑ Upload<input type="file" id="owFloorFpFile" accept="image/*" style="display:none;"></label>
        </div>
        ${floor.floorplan ? `<div style="font-size:10px;color:#555;margin-top:3px;">${floorZones.length} zone${floorZones.length!==1?'s':''} on this floor</div>` : ''}
      </div>

      <div style="height:1px;background:rgba(255,255,255,0.07);margin:14px 0;"></div>

      <div style="margin-bottom:10px;">
        <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;">HA Floor Link <span style="color:#555;font-weight:400;text-transform:none;">(optional)</span></label>
        <select id="owFloorHASelect" style="width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#ccc;border-radius:8px;padding:7px 10px;font-size:13px;outline:none;">
          <option value="">— Not linked —</option>
          ${haFloors.map(hf => `<option value="${escapeHtml(hf.floor_id)}" ${floor.ha_floor_id === hf.floor_id ? 'selected' : ''}>${escapeHtml(hf.name)}</option>`).join('')}
        </select>
        ${!_haRegistry.loaded ? '<div style="font-size:11px;color:#f90;margin-top:4px;">⚠ HA registry not loaded — open in HA add-on mode</div>' : ''}
      </div>

      ${floor.ha_floor_id ? `
        <div style="margin-bottom:12px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <label style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.05em;">HA Areas → OW Zones</label>
            <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#666;cursor:pointer;">
              <input type="checkbox" id="owFloorAutoAdd" ${autoAdd?'checked':''} style="accent-color:#0064d2;">
              Auto-add new areas
            </label>
          </div>
          <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px;overflow:hidden;">
            ${floorAreas.length ? floorAreas.map(area => {
              const isLinked = linkedAreaIds.includes(area.area_id);
              const existingZone = zones.find(z => z.ha_area_id === area.area_id);
              return `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);">
                <input type="checkbox" class="ow-area-chk" data-area-id="${escapeHtml(area.area_id)}" data-area-name="${escapeHtml(area.name)}" ${isLinked?'checked':''} style="accent-color:#0064d2;flex-shrink:0;">
                <span style="flex:1;font-size:12px;color:#ccc;">${escapeHtml(area.name)}</span>
                ${existingZone ? `<span style="font-size:10px;color:#4db8ff;background:rgba(0,100,255,0.1);padding:2px 6px;border-radius:4px;">${escapeHtml(existingZone.name)}</span>` : '<span style="font-size:10px;color:#444;">no zone yet</span>'}
              </label>`;
            }).join('') : '<div style="padding:12px;color:#555;font-size:12px;text-align:center;">No areas on this HA floor</div>'}
          </div>
        </div>
      ` : ''}

      <div style="display:flex;gap:8px;margin-top:14px;">
        <button id="owFloorRegistryRefresh" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#666;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;">↻ Refresh HA</button>
        <button id="owFloorDeleteBtn" style="background:rgba(255,59,48,0.1);border:1px solid rgba(255,59,48,0.25);color:#ff3b30;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;">Delete Floor</button>
        <button id="owFloorSaveBtn" style="margin-left:auto;background:rgba(0,100,210,0.2);border:1px solid rgba(0,100,210,0.4);color:#4db8ff;border-radius:8px;padding:7px 16px;cursor:pointer;font-size:12px;font-weight:600;">Save</button>
      </div>
    `;

    // Wire name input
    body.querySelector('#owFloorNameInput').oninput = e => {
      floor.name = e.target.value;
      titlebar.querySelector('#owFloorConfigFloorName').textContent = e.target.value;
    };

    // Wire floorplan path input
    body.querySelector('#owFloorFpInput').oninput = e => { floor.floorplan = e.target.value.trim() || null; };

    // Wire floorplan file upload
    body.querySelector('#owFloorFpFile').onchange = async e => {
      const file = e.target.files?.[0]; if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      const r = await fetch(apiPath('ow/upload-floorplan'), { method: 'POST', body: fd });
      if (r.ok) { const d = await r.json(); if (d.path) { floor.floorplan = d.path; body.querySelector('#owFloorFpInput').value = d.path; } }
    };

    // Wire HA floor select
    body.querySelector('#owFloorHASelect').onchange = async e => {
      floor.ha_floor_id = e.target.value || null;
      floor.ha_linked_area_ids = [];
      await saveFloor(floor);
      render();
    };

    // Wire auto-add checkbox
    body.querySelector('#owFloorAutoAdd')?.addEventListener('change', e => { floor.ha_auto_add_areas = e.target.checked; });

    // Wire area checkboxes
    body.querySelectorAll('.ow-area-chk').forEach(chk => {
      chk.addEventListener('change', async () => {
        const areaId = chk.dataset.areaId;
        const areaName = chk.dataset.areaName;
        if (!floor.ha_linked_area_ids) floor.ha_linked_area_ids = [];
        if (chk.checked) {
          if (!floor.ha_linked_area_ids.includes(areaId)) floor.ha_linked_area_ids.push(areaId);
          const existing = zones.find(z => z.ha_area_id === areaId);
          if (!existing) await createZoneFromHAArea(areaId, areaName, floor.id);
        } else {
          floor.ha_linked_area_ids = floor.ha_linked_area_ids.filter(id => id !== areaId);
        }
        await saveFloor(floor);
        render();
        renderZonesEditor();
      });
    });

    // Wire refresh
    body.querySelector('#owFloorRegistryRefresh').onclick = async () => {
      await fetch(apiPath('ow/ha-registry/refresh'), { method: 'POST' });
      await loadHARegistry();
      render();
    };

    // Wire delete
    body.querySelector('#owFloorDeleteBtn').onclick = async () => {
      if (!confirm(`Delete floor "${floor.name}"? Zones on this floor will become ungrouped.`)) return;
      await deleteFloor(floor.id);
      panel.remove();
      renderZonesEditor(); renderZones();
    };

    // Wire save
    body.querySelector('#owFloorSaveBtn').onclick = async () => {
      await saveFloor(floor);
      renderZonesEditor(); renderZones();
      showToast('Floor saved ✓', 'ok');
    };
  }

  render();
  panel.appendChild(titlebar);
  panel.appendChild(body);
  document.body.appendChild(panel);

  // Dismiss on outside click
  setTimeout(() => {
    document.addEventListener('pointerdown', function dismiss(e) {
      if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('pointerdown', dismiss); }
    });
  }, 100);
}

// Sync a zone's entity tabs from its linked HA area.
// This is authoritative for HA-linked zones: adds current HA area entities and removes stale ones.
async function syncZoneFromHAArea(zone, opts = {}) {
  if (!zone?.ha_area_id) { showToast('No HA area mapped to this zone', 'warn'); return; }
  if (opts.forceRefresh || !_haRegistry.loaded) await loadHARegistry(!!opts.forceRefresh);
  if (!_haRegistry.loaded) { showToast('HA registry not loaded', 'warn'); return; }
  const areaEntities = haEntitiesForArea(zone.ha_area_id);
  const byType = {
    sensors: new Set(areaEntities.filter(e => HA_AREA_FILTERS.sensors(e)).map(e => e.entity_id)),
    cameras: new Set(areaEntities.filter(e => HA_AREA_FILTERS.cameras(e)).map(e => e.entity_id)),
    lights:  new Set(areaEntities.filter(e => HA_AREA_FILTERS.lights(e)).map(e => e.entity_id)),
    sirens:  new Set(areaEntities.filter(e => HA_AREA_FILTERS.sirens(e)).map(e => e.entity_id)),
    doors:   new Set(areaEntities.filter(e => HA_AREA_FILTERS.doors(e)).map(e => e.entity_id)),
  };
  const allAreaEntityIds = new Set(areaEntities.map(e => e.entity_id));
  let added = 0, removed = 0;
  function reconcileArray(type) { const before = zone[type] || []; const wanted = byType[type] || new Set(); const next = before.filter(eid => wanted.has(eid)); removed += before.length - next.length; wanted.forEach(eid => { if (!next.includes(eid)) { next.push(eid); added++; } }); zone[type] = next; }
  ['sensors', 'cameras', 'lights', 'sirens'].forEach(reconcileArray);
  const beforeGhosts = zone.ha_excluded_entities || [];
  zone.ha_excluded_entities = beforeGhosts.filter(eid => allAreaEntityIds.has(eid));
  removed += beforeGhosts.length - zone.ha_excluded_entities.length;
  const staleDoorPins = doorPins.filter(p => doorPinZoneIds(p).includes(zone.id) && p.sensor_entity && !byType.doors.has(p.sensor_entity));
  for (const p of staleDoorPins) { doorPins = doorPins.filter(dp => dp.id !== p.id); await fetch(apiPath('ow/delete-door-pin'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id }) }).catch(() => null); removed++; }
  for (const e of areaEntities.filter(e => byType.doors.has(e.entity_id))) if (!doorPins.some(p => p.sensor_entity === e.entity_id && doorPinZoneIds(p).includes(zone.id))) { const newPin = { id: 'door_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), name: haStates[e.entity_id]?.attributes?.friendly_name || e.name || e.entity_id.split('.').pop().replace(/_/g,' '), sensor_entity: e.entity_id, control_entity: null, zone_id: zone.id, floor_id: zone.floor_id || null, x: null, y: null, rotation: 0 }; doorPins.push(newPin); await saveDoorPin(newPin); added++; }
  await saveZone(zone); subscribeHAEntities(); renderZones(); if (window.renderCameraStatusBar) window.renderCameraStatusBar(); if (window.camUpdate) window.camUpdate();
  showToast(`Synced HA area: ${added} added, ${removed} removed ✓`, (added || removed) ? 'ok' : 'info');
}

// Create an OW zone linked to a HA area with no map points
async function createZoneFromHAArea(areaId, areaName, floorId) {
  const id = 'zone_' + areaId.replace(/[^a-z0-9]/gi, '_') + '_' + Date.now();
  const zone = {
    id, name: areaName, colorHex: '#0096ff', color: hexToRgba('#0096ff', 0.25),
    enabled: true, hidden: false,
    floor_id: floorId, ha_area_id: areaId,
    points: [], sensors: [], cameras: [], lights: [], sirens: [], ha_excluded_entities: [],
  };
  zones.push(zone);
  // Add to zone index
  const idxRes = await fetch(ZONES_DIR + 'index.json?v=' + Date.now());
  let index = idxRes.ok ? await idxRes.json() : [];
  const filename = zoneFilename(id);
  if (!index.includes(filename)) index.push(filename);
  await fetch(apiPath('ow/save-zone'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'index.json', content: JSON.stringify(index, null, 2) }) });
  await saveZone(zone);
  showToast(`Zone "${areaName}" created from HA area ✓`, 'ok');
  renderZonesEditor();
  return zone;
}

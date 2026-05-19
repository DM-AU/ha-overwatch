/* ─── HA-Overwatch Camera Config Module ────────────────────────
 * Extracted from app.js as a classic browser script.
 *
 * Load order:
 *   1. modules/ow-utils.js
 *   2. modules/ow-door-pins.js
 *   3. modules/ow-camera-config.js
 *   4. app.js
 *
 * Compatibility design:
 * - Functions intentionally remain global (classic script function declarations).
 * - Function bodies reference globals declared in app.js (camLowResMap, uiConfig,
 *   apiPath, etc.) at call time after app.js has loaded.
 * - No behaviour change intended in this modularisation pass.
 */

function getCamLowRes(highResId) {
  const forceHigh = localStorage.getItem('ow_cam_always_high_res') === 'true';
  if (forceHigh) return highResId;
  return camLowResMap[highResId] || highResId;
}

async function saveCamLowResMap() {
  uiConfig.cam_low_res_map = JSON.stringify(camLowResMap);
  // Save to a dedicated file so we don't need to rebuild all of ui.yaml
  try {
    await fetch(apiPath("ow/save-config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "config/cam_low_res.json", content: JSON.stringify(camLowResMap, null, 2) })
    });
    // Sync to cameras.js internal map
    if (window.setCamLowResMap) window.setCamLowResMap(camLowResMap);
    if (window.OW) window.OW.uiConfig = uiConfig;
  } catch(e) { console.warn('Failed to save cam low res map', e); }
}

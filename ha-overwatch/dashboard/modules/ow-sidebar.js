/* ─── HA-Overwatch Sidebar Module ──────────────────────────────
 * Stable baseline: v1.551.36.05.
 * Extracted from app.js as a classic browser script.
 *
 * Load order:
 *   1. modules/ow-utils.js
 *   2. modules/ow-door-pins.js
 *   3. modules/ow-sidebar.js
 *   4. app.js
 *
 * Compatibility design:
 * - Functions intentionally remain global.
 * - Function bodies reference app.js globals at call time after app.js has loaded.
 * - No top-level mutable app state moved in this pass.
 */

function updateExpandBtn(collapsed) {
  const btn  = document.getElementById("expandBtn");
  const svg  = btn?.querySelector("svg path");
  if (!btn) return;

  const isLeft = uiConfig.sidebar_position === "left";

  if (isLeft) {
    btn.style.left  = "10px";
    btn.style.right = "unset";
    // Expand btn: chevron right → opens left sidebar
    if (svg) svg.setAttribute("d", "M9 6l6 6-6 6");
  } else {
    btn.style.right = "10px";
    btn.style.left  = "unset";
    // Expand btn: chevron left ← opens right sidebar
    if (svg) svg.setAttribute("d", "M15 6l-6 6 6 6");
  }

  if (collapsed) {
    btn.classList.add("visible");
  } else {
    btn.classList.remove("visible");
  }

  // Issue 4: also update the collapse button chevron direction
  const collapseBtn = document.getElementById("collapseBtn");
  const collapseSvg = collapseBtn?.querySelector("svg path");
  if (collapseSvg) {
    // Collapse btn points AWAY from screen edge:
    // right sidebar → chevron right (→) to push it off right edge
    // left  sidebar → chevron left  (←) to push it off left edge
    collapseSvg.setAttribute("d", isLeft ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6");
  }
}

function bindSidebarToggle() {
  const sidebar = document.getElementById("sidebarEl");
  const collapseBtn = document.getElementById("collapseBtn");
  const expandBtn = document.getElementById("expandBtn");

  function collapse() {
    if (!sidebar) return;
    sidebar.classList.add("collapsed");
    setSidebarCollapsedPreference(true);
    updateExpandBtn(true);
    // Close any open overlays
    setSearchOpen(false);
    const logPanel = document.getElementById("logPanel");
    if (logPanel) logPanel.classList.remove("open");
    const settingsPanel = document.getElementById("settingsPanel");
    if (settingsPanel) settingsPanel.remove();
    if (editorMode) { editorMode = false; renderZonesEditor(); renderZones(); }
    // Close camera dropdown if open
    const camDd = document.getElementById("camStatusDd");
    if (camDd && camDd.style.display !== "none") {
      camDd.style.display = "none";
      localStorage.setItem("cam_status_open", "false");
    }
  }

  function expand() {
    if (!sidebar) return;
    sidebar.classList.remove("collapsed");
    setSidebarCollapsedPreference(false);
    updateExpandBtn(false);
  }

  if (collapseBtn) collapseBtn.onclick = collapse;
  if (expandBtn) expandBtn.onclick = expand;

  // Status bar: NO sidebar interaction (item 2)
}

function bindCommonSidebarButtons() {
  const settingsBtn = document.getElementById("settingsBtn");
  const logBtn      = document.getElementById("logBtn");
  if (settingsBtn) settingsBtn.onclick = () => renderSettingsPanel();
  if (logBtn)      logBtn.onclick      = () => renderLogPanel(true);
}

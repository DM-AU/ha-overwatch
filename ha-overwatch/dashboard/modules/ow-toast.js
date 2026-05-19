/* ─── HA-Overwatch Toast Module ────────────────────────────────
 * Stable baseline: v1.551.36.07.
 * Extracted from app.js as a classic browser script.
 * `_saveToastTimer` remains declared in app.js.
 */

function showSaveToast(label) {
  if (_saveToastTimer) clearTimeout(_saveToastTimer);
  _saveToastTimer = setTimeout(() => {
    showToast(`${label || 'Changes'} saved ✓`, 'ok');
    _saveToastTimer = null;
  }, 600); // wait 600ms after last save before showing toast
}

function showToast(message, level = "warn") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.style.cssText = `
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      z-index: 9999; display: flex; flex-direction: column; gap: 8px;
      align-items: center; pointer-events: none;
    `;
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  const bg = level === "error" ? "rgba(255,59,48,0.92)" :
             level === "warn"  ? "rgba(255,149,0,0.92)" :
             level === "ok"    ? "rgba(50,215,75,0.92)" :
                                 "rgba(40,40,40,0.92)";
  toast.style.cssText = `
    background: ${bg}; color: #fff; border-radius: 10px;
    padding: 9px 16px; font-size: 13px; font-weight: 500;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4); pointer-events: none;
    max-width: 380px; text-align: center; line-height: 1.4;
    animation: toastIn 0.25s ease;
  `;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "toastOut 0.3s ease forwards";
    setTimeout(() => toast.remove(), 320);
  }, 4000);
}

// Inject toast keyframes once
(function injectToastCSS() {
  const s = document.createElement("style");
  s.textContent = `
    @keyframes toastIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
    @keyframes toastOut { from { opacity:1; transform:translateY(0); } to { opacity:0; transform:translateY(10px); } }
  `;
  document.head.appendChild(s);
})();

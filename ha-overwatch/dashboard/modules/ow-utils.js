/* ─── HA-Overwatch Utility Module ─────────────────────────────
 * Extracted from app.js as a classic browser script.
 *
 * Load order:
 *   1. modules/ow-utils.js
 *   2. feature modules
 *   3. app.js
 *
 * This module intentionally contains only helpers required by pre-app modules.
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

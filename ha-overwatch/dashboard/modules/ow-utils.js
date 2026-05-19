/* ─── HA-Overwatch Utility Module ─────────────────────────────
 * Stable baseline: v1.551.36.05.
 * Contains only helpers required before app.js loads.
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

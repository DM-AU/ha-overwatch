/* ─── HA-Overwatch Utility Module ─────────────────────────────
- Stable baseline: v0.05.02.
- Contains only helpers required before app.js loads.
*/

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

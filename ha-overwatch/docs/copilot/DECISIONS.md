# HA-Overwatch — Decision Log

> Purpose: capture design and workflow decisions that should survive chat resets, app crashes, and future contributors.

---

## D-001 — Full-file outputs only
**Status:** Active  
**Decision:** All code/config changes provided through Copilot should be returned as full-file replacements unless explicitly requested otherwise.  
**Why:** Partial snippets and patch instructions are error-prone, slow to apply, and have repeatedly caused friction during implementation.  
**Impact:** Copilot responses should prefer complete `server.js`, `app.js`, YAML, or other full-file outputs.

---

## D-002 — Ask one targeted question only when blocked
**Status:** Active  
**Decision:** Do not guess when a missing detail materially changes the solution. Ask one targeted question if required to proceed.  
**Why:** Assumption-heavy answers create rework and regressions.  
**Impact:** Default behaviour is direct execution; only pause when ambiguity would change the implementation.

---

## D-003 — Preserve operational responsiveness over clever rewrites
**Status:** Active  
**Decision:** Prefer stable, localised fixes over broad refactors unless the refactor is clearly necessary.  
**Why:** This dashboard is used live on wall devices; regressions cost more than imperfect code structure.  
**Impact:** Changes should minimise blast radius and explicitly call out anything that could affect trigger logic, camera display, or refresh behaviour.

---

## D-004 — Sidebar should default closed
**Status:** Active / implementation pending validation  
**Decision:** The sidebar should start closed after browser refresh unless the task explicitly changes this behaviour.  
**Why:** The dashboard is primarily an operational display, not an admin console.  
**Impact:** UI initialisation should not reopen the sidebar by default on panel refresh.

---

## D-005 — Dynamic entity lookup is preferred in editor fields
**Status:** Active  
**Decision:** Fields such as camera low-res selection and mapped HA area lookup should use dynamic Home Assistant entity/area lookups where practical.  
**Why:** Manual/static entry increases configuration friction and causes mismatch with real HA state.  
**Impact:** Zone editor/admin UI should favour live lookup/autocomplete behaviour.

---

## D-006 — Door-to-multiple-zone support should be simple by default
**Status:** Active / design direction agreed  
**Decision:** A door can belong to its normal zone and optionally be linked/tagged to additional zones.  
**Why:** Perimeter and transitional doors can legitimately affect more than one zone.  
**Impact:** Avoid complex primary-zone logic if not required. Default behaviour should remain simple and predictable.

---

## D-007 — Admin UX can be compact; runtime UX must stay obvious
**Status:** Active  
**Decision:** Small controls (e.g. cog/settings affordances) are acceptable in admin/editor views, but runtime trigger state and camera behaviour must remain visually obvious.  
**Why:** Admin mode is used less often on tablets; operational mode is the priority.  
**Impact:** Keep configuration UI compact, but never at the expense of main dashboard clarity.

---

## D-008 — Trigger logic must not regress when filtering bad entity rows
**Status:** Active / caution  
**Decision:** Hardening trigger-source validation must not break legitimate door/window or sensor-driven camera activation.  
**Why:** Recent changes intended to ignore bad synced entity rows caused or coincided with lost camera activation behaviour.  
**Impact:** Any future trigger filtering must be tested against real door-triggered zone/camera flows.

---

## D-009 — Canonical progress must live outside chat
**Status:** Active  
**Decision:** Current state, active bugs, and work history must be stored in repo docs and/or GitHub issues, not only in Copilot chat threads.  
**Why:** Long chats are unstable and can become unresponsive or crash.  
**Impact:** End each work session with a checkpoint summary that is copied into `ACTIVE-WORK.md` or an issue.

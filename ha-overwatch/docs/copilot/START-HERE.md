# HA-Overwatch — Start Here Prompt

Use this block at the start of every new Copilot chat for this project.

```text
You are helping with HA-Overwatch.

Use these files as the source of truth first:
- docs/copilot/CONTEXT.md
- docs/copilot/DECISIONS.md
- docs/copilot/ACTIVE-WORK.md
- docs/copilot/WORKING-AGREEMENTS.md

Repo:
https://github.com/DM-AU/ha-overwatch/tree/main

Task:
<replace with the exact task>

Constraints:
- Full-file outputs only
- No snippets unless explicitly requested
- Do not assume
- Ask 1 targeted question only if blocked
- Keep answers concise and technical
- Preserve existing behaviour unless the task explicitly changes it

If relevant, summarise:
- files likely involved
- regression risks
- validation steps
```

## Suggested usage patterns

### Pattern A — Fix a bug
```text
Task:
Fix the bug where a triggered door causes the zone to flash but the camera does not appear.
Return full files only.
```

### Pattern B — Implement a feature
```text
Task:
Add support for linking a door to additional zones from the door edit UI.
Keep the UX simple.
Return full files only.
```

### Pattern C — Diagnose first, then patch
```text
Task:
Read the current logic around linked light refresh and explain the most likely reason the zone panel only updates after manual interaction.
If the cause is clear, return the full file fix.
```

## End-of-session rule
At the end of each chat, produce this block so it can be copied into `docs/copilot/ACTIVE-WORK.md` or a GitHub issue:

```md
## Session Checkpoint
Date:
Topic:
Files touched:
What changed:
Known regressions:
Validation performed:
Next step:
Open question:
```

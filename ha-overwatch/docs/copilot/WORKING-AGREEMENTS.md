# HA-Overwatch — Working Agreements for Copilot

## Communication style
- Use direct, technical language.
- Do not mirror bias or soften conclusions.
- If something is wrong, say it clearly and explain why.
- Start with a short high-level summary, then give clear next steps.
- Keep responses concise; no fluff.

## Execution rules
- Full files only unless explicitly told otherwise.
- No patch snippets.
- No partial edits that require manual stitching.
- Prefer working end-to-end outputs.
- Preserve existing behaviour unless the task explicitly changes it.

## Assumption discipline
- Do not assume when missing details could change the solution.
- Ask one targeted question only if blocked.
- Flag assumptions and risks explicitly.
- Challenge contradictions immediately.

## Engineering priorities
- Stability over novelty.
- Avoid broad rewrites unless they are justified.
- Respect performance constraints on older tablets/wall panels.
- Be careful with websocket/render loops and high-frequency updates.
- Any change to trigger logic must be treated as regression-sensitive.

## Preferred response structure for code tasks
1. Short summary of what is being fixed
2. Risks / assumptions
3. Full file output(s)
4. Minimal validation checklist

## Quality bar
- No invented functions or guessed file structures if avoidable.
- Keep naming consistent with existing project conventions.
- If a function/section name is unknown, say so and base changes on observed structure rather than pretending certainty.
- If a task touches runtime behaviour, explain what could regress.

## What success looks like
A good Copilot response for this repo:
- solves the asked problem directly
- avoids side quests
- returns complete files when code is requested
- preserves working behaviour
- makes testing obvious

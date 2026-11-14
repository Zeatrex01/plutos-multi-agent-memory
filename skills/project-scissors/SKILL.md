---
name: project-scissors
description: "Use when a project has a SCOPE.md, at the start of a tool or game project when the owner asks to plan its scope, or when the owner asks to cut a bloated, drifting or never-ending project. Plans the architecture first (SCOPE.md and ADRs), guards scope and structure while SCOPE.md exists, and cuts bloat. Not for ordinary feature requests in a project without SCOPE.md; inside a game jam use the jam package's jam-cut."
---
# Project Scissors

Three modes. PLAN when the owner asks to plan a project's scope and SCOPE.md is missing or has no approved Architecture. GUARD only while the project has a SCOPE.md: without one, GUARD does not run and this skill never refuses, parks or blocks a request. CUT when the appetite date has passed, the project feels bloated or never ends, or the owner asks to cut.

Templates and background: `references/scope-template.md`, `references/adr-template.md`, `references/standing-rules.md`, `references/hook-example.md`, `references/eval-protocol.md`, `references/evidence-map.md`. In the Claude app, read `references/CLAUDE_HOST.md` for where files live. Inside PLUT_OS: the session brief shows the project's SCOPE.md line, and a project with an `IDEAS.md` keeps its "Later" list there.

## PLAN (before any code)
1. Ask 5 short questions: problem, core user story, appetite in days, in-scope (max 5), do-not-touch.
2. Draft the Architecture section, max 8 lines:
   - Modules: max 5, one line each = its single responsibility.
   - Data flow: what calls what, where state lives.
   - Boundaries: what each module must not know or do.
   - First vertical slice: one path through these modules that makes the core user story work end to end.
   - Not built yet: extension points deliberately skipped.
3. Write SCOPE.md from the template. Record each key decision as an ADR in docs/adr/. Get explicit OK.
4. Build the walking skeleton first: the thinnest version that connects every module end to end, with no features. Verify it runs. Only then build the first slice on top.

## GUARD (only when SCOPE.md exists)
No SCOPE.md in the project: skip GUARD entirely and do the requested work as asked.
1. Read SCOPE.md and docs/adr/ first.
2. Classify each request: IN-SCOPE / OUT-OF-SCOPE / NEW IDEA. For the last two: append to "Later", ask "swap with an in-scope item, or park it?", and do not implement.
3. Never edit Architecture or Do not touch items without approval. An approved structural change gets a new ADR.
4. Done = the Verify check passes. Report the command/steps, the result and the list of changed files.
5. Drift check at the end of each slice: compare the code's actual modules and calls to Architecture and the ADRs. Report any drift; fix the code or write a superseding ADR only with OK.

How code is changed (smallest change, the second-use rule for new structure, evidence before claims) is not repeated here: inside PLUT_OS it is the working agreement in the session brief; elsewhere it is `references/standing-rules.md`.

## CUT (bloated, drifting or overdue)
1. List every current feature and system. Mark each KEEP (needed for the core user story), CUT (remove or disable) or PARK (move to Later).
2. Rule of thumb: if the core user story works without it, it is not KEEP.
3. Show the list, get approval, then remove CUT items in small, separate changes and re-run Verify after each.
4. End with a decision: SHIP as-is, set a new appetite with a smaller scope, or ARCHIVE. Never extend silently.

## Notes
- One ACTIVE project at a time; others stay PARKED.
- Hard bans (Do not touch paths) also belong in a hook or deny rule; this skill is guidance only. See `references/hook-example.md`.
- Standing personal rules belong in user-level CLAUDE.md so they load every session. See `references/standing-rules.md`.
- Evidence levels for every rule are in `references/evidence-map.md`. The skill as a whole is unmeasured; test it with `references/eval-protocol.md`.

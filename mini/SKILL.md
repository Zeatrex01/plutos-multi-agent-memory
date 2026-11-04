---
name: plutos-mini
description: Use at the start and end of every session in a project that keeps PLUT_OS records (docs/handoff/BOARD.md, CONTINUITY.md, SCOPE.md) when the PLUT_OS server or its MCP tools are not available. Gives the session brief, records the session, updates the board, from the shell; no server.
---
# PLUT_OS mini

The project's memory without the PLUT_OS server. Same files, same formats as the full PLUT_OS; a shell and
Node 18 or later are enough. Never ask the owner to start a server for these.

- **Start:** `node <this skill>/scripts/plutos-mini.mjs brief` (Claude Code runs it by itself once `init` added the
  hook). Read it, follow its WORKING AGREEMENT and its Scope line (`project-scissors`), read the board before work.
- **While working:** `board start --ai <you> --title "<task>" --task "<one line>"` when you take a task;
  `board done --ai <you> --title "<same>" --result "<one line and where the output is>"` when it is finished,
  `board blocked --ai <you> --title "<same>" --result "<the reason>"` when it is not.
- **End:** `end --ai <you> --headline "<what>" --did "…" --decided "a; b" --next "…" --not-checked "…" --story "<one
  sentence for the owner, in their language>"`. Decisions go into the digest every later session reads.
- **New project:** `init` once: the handoff files, these skills copied into `.claude/skills/`, a SessionStart hook in
  `.claude/settings.local.json`.

Everything here is plain text in git: commit the handoff files with the work. A project that later installs the
full PLUT_OS keeps every record.

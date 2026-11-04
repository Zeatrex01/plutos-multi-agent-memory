# Running in Claude (claude.ai app, Cowork, Claude Code)

This module has no PLUTOS-only machinery; the same rules apply everywhere. Only where files live changes.

## Where the work lives

- `SCOPE.md` sits in the project's root folder. ADRs sit in `docs/adr/` in the same project. Find the project folder in this order:
  1. a folder the owner attached or linked in this chat;
  2. a folder on the owner's computer, reached through the device tools when this chat is linked to it (work there with the device shell);
  3. when the session is attached to a claude.ai Project, its docs: `project_read` first, `project_write` for records the owner will look for later. Write selectively.
  If none exists, draft SCOPE.md in the workspace and hand it over.
- Never put SCOPE.md content, ADRs or project decisions into user memory. Memory is about the owner, not the project.
- Read an existing SCOPE.md, ADRs, GDD or plan before writing. Update in place; do not duplicate.

## Approvals

- Architecture, structure changes, CUT lists and SHIP/ARCHIVE decisions need the owner's explicit OK in the conversation. A generic "go on" is not approval to remove features.
- When the owner is away, do the preparatory work, set out the decision and stop.

## Hooks and engines

- Hooks and deny rules (`references/hook-example.md` in the skill) only work in Claude Code on the owner's computer. In the Claude app, say that the Do not touch list is guidance only there.
- Unity, Blender and Godot run on the owner's computer. Verify steps that need them are marked unexecuted unless run through the device shell.

## Relation to other plutos modules

- `plutos-playbook` stages a game from idea to decision; project-scissors keeps each build stage scoped and structured. For games, the core user story is the playbook stage's gate (for example: playable start to end).
- `plutos-godot:godot-planner` covers Godot-specific session planning; use project-scissors for the scope contract and architecture, godot-planner for engine-specific sequencing.

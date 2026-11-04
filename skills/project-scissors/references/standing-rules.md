# Standing rules for user-level CLAUDE.md

Skills load only when their description matches. Rules that must hold in every session go in the user-level memory file, which Claude Code loads in every project (`~/.claude/CLAUDE.md`). Anthropic recommends keeping each CLAUDE.md under 200 lines and adding what you have had to correct twice. Keep this block short; the most important rules first.

```markdown
# Standing rules (all projects)
- Start every project as MVP + walking skeleton: connect all modules end to end with no features, then add one vertical slice at a time.
- Decide architecture before code: modules, data flow, boundaries. Write it in SCOPE.md, record key decisions as ADRs in docs/adr/, and get my OK.
- Never change architecture, folder structure or core systems without my explicit approval.
- New infrastructure (managers, frameworks, abstraction layers, dependencies) only when a second real use exists.
- Change only what the task requires; mention unrelated issues instead of fixing them.
- Unity: don't touch Scenes/, prefabs or .meta files unless the task names them.
- Use project-scissors for scope: new ideas go to "Later" in SCOPE.md, not into code.
```

Project-specific architecture does not go here; it goes in that project's SCOPE.md and docs/adr/.

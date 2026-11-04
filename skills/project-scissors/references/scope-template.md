# SCOPE.md template

Copy to the project root as `SCOPE.md`. Keep it to one page.

```
# SCOPE.md - <project>
Status: ACTIVE | PARKED | SHIPPED | ARCHIVED
Appetite: <N> days (start YYYY-MM-DD, hard stop YYYY-MM-DD)
Problem: <1-2 sentences: who uses this, what pain it removes>
Core user story (acceptance test): <one line; for games: playable start to end>
Verify with: <command / manual steps / screenshot to compare>
In scope (max 5):
  1.
Out of scope:
  -
Architecture (approved YYYY-MM-DD, change only with OK):
  Modules: <max 5, one line each = single responsibility>
  Data flow: <what calls what, where state lives>
  Boundaries: <what each module must not know or do>
  Walking skeleton: <done / not yet>
  First slice: <one end-to-end path>
  Not built yet: <extension points deliberately skipped>
Do not touch: <folders, scenes, prefabs, generated files>
Later (parking lot — new ideas go here, not into code):
  -
Done means:
  [ ] Acceptance test passes (evidence pasted below)
  [ ] No files changed outside the listed paths
  [ ] Used once on a real asset / played start to end
  [ ] Status set to SHIPPED or ARCHIVED (no silent extension)
```

## Worked example (tool)

```
# SCOPE.md - Art Hub
Status: ACTIVE
Appetite: 7 days (start 2026-11-04, hard stop 2026-11-11)
Problem: I lose track of which models are in the Unity project and which Blender source matches them.
Core user story: Pull a model from Unity, edit it in Blender, write it back with the same import settings, see it in history.
Verify with: Round-trip one prefab's mesh; GUID in .meta unchanged; scene references intact.
In scope: 1. Pull from Unity  2. Open in Blender  3. Write back with same settings  4. History list  5. New/changed list
Out of scope: Automatic LOD, team sharing, cloud sync
Architecture:
  Modules: UnityBridge (read/write assets, never .meta), BlenderBridge (open/export), History (log entries), UI (lists, buttons)
  Data flow: UI -> UnityBridge/BlenderBridge -> History
  Boundaries: only UnityBridge touches the Unity folder; nothing edits .meta
  Walking skeleton: not yet
  First slice: pull -> edit -> write back for one FBX
  Not built yet: AI checks, batch operations
Do not touch: Assets/Scenes/, *.meta
Later: AI review of changes (parked 2026-11-04)
```

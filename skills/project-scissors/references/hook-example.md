# Enforcing "Do not touch" with a Claude Code hook

A skill or CLAUDE.md is guidance; the model can decide a rule does not apply. Anthropic's guidance: if something must happen every time, make it a hook, a deny rule or a managed setting. This plugin ships no active hook. Add one per project on your own computer if a path must never be edited.

## Option A: deny rules (simplest)

In the project's `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Edit(Assets/Scenes/**)",
      "Write(Assets/Scenes/**)",
      "Edit(**/*.meta)",
      "Write(**/*.meta)"
    ]
  }
}
```

## Option B: PreToolUse hook (reads the list from SCOPE.md)

`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "python3 .claude/hooks/scope_guard.py" }]
      }
    ]
  }
}
```

`.claude/hooks/scope_guard.py`:

```python
import json, sys, fnmatch, pathlib, re

event = json.load(sys.stdin)
path = event.get("tool_input", {}).get("file_path", "")
scope = pathlib.Path("SCOPE.md")
if not path or not scope.exists():
    sys.exit(0)
m = re.search(r"^Do not touch:\s*(.+)$", scope.read_text(encoding="utf-8"), re.M)
patterns = [p.strip() for p in m.group(1).split(",")] if m else []
rel = path
if pathlib.Path(path).is_absolute():
    try:
        rel = str(pathlib.Path(path).resolve().relative_to(pathlib.Path.cwd().resolve()))
    except ValueError:
        sys.exit(0)  # outside the project: not this hook's concern
for p in patterns:
    prefix = p.rstrip("*")  # "Assets/Scenes/" or "Assets/Scenes/*"; empty for "*", which must not match by prefix
    if p and (fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel, p.rstrip("/") + "/*") or (prefix and rel.startswith(prefix))):
        print(f"Blocked by SCOPE.md 'Do not touch': {p}", file=sys.stderr)
        sys.exit(2)  # exit code 2 blocks the tool call and shows the message to Claude
sys.exit(0)
```

Write the Do not touch line as comma-separated patterns, for example `Do not touch: Assets/Scenes/, *.meta`. Test the hook once on a harmless file before relying on it. Check the current hooks documentation (code.claude.com/docs) if the event format changes.

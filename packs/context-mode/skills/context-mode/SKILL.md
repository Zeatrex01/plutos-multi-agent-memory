---
name: context-mode
description: Use the context-mode server to run commands whose output is large (test runs, builds, logs, long listings) so only a summary enters context. It may also shorten other tools' outputs; read the PLUT_OS brief by part with session_start part.
---

# Context Mode

The `context-mode` server is an upstream project with its own licence:
https://github.com/mksglu/context-mode. This pack ships no code of it, only the `.mcp.json` entry
that runs it with npx and this note.

## When

- A command whose output runs to many kilobytes: a full test run, a build, a log, a large listing
  or search. Run it through context-mode and keep the summary.
- Not for small outputs, and not for a file you are about to edit: an edit needs the exact text.

## Watch for

- context-mode, used as a client plugin, has been seen shortening other tools' outputs too: a
  6 KB PLUT_OS `session_start` reply was cut and the brief was never read.
- If a PLUT_OS reply looks cut, ask for it in parts: `session_start` with `{"part": 2}`, then 3,
  as the brief's last line names them. Do not act on a brief you did not read to its end.
- A summary is not the output: quote a failing line from the real output before you call
  something fixed or broken.

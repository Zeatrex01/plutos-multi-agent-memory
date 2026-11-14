---
name: codebase-memory
description: Use the codebase-memory-mcp server for function-level questions across many files (who calls this function, what changing it breaks) once plutos_code_lookup, which answers at file level, is not enough.
---

# Codebase Memory

The `codebase-memory-mcp` server is an upstream project with its own licence:
https://github.com/DeusData/codebase-memory-mcp. This pack ships no code of it, only the
`.mcp.json` entry that runs it with npx and this note.

## When

1. Start with `plutos_code_lookup` (and the graph report, when the project has one): it names the
   files for a question at no indexing cost.
2. Use codebase-memory when the question is about functions, not files: the callers or callees of a
   function, the files a signature change reaches, a call path between two places.
3. Do not use it for one file you can read, or for what a text search answers.

## How

- The server indexes the repository on first use; on a large one that takes a while, so ask once
  and reuse the answer.
- Its tool names are the server's own; read its tool list rather than guessing them.
- An index can lag behind edits made in this session: open the file before you change code on the
  word of a caller it reports.

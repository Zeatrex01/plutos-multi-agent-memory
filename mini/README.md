# PLUT_OS mini

The PLUT_OS project memory without the server or MCP: the session brief (the owner's working agreement, the
project's Scope line, the live board, the last sessions and settled decisions), the session record and the board,
from one Node script with no dependencies. It writes the same files as the full PLUT_OS, in the same formats.

```
node skills/plutos-mini/scripts/plutos-mini.mjs init <project>     # once per project
node skills/plutos-mini/scripts/plutos-mini.mjs brief <project>
node skills/plutos-mini/scripts/plutos-mini.mjs --help
```

Contents: `skills/plutos-mini` (the skill, the script, the working agreement) and `skills/project-scissors` (the
scope skill the brief's Scope line points at). Opens as a Claude Code plugin too. Built from the PLUT_OS repository
by `node tools/pack-mini.mjs`.

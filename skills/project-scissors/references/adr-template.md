# ADR template (Architecture Decision Record)

Format after Michael Nygard, "Documenting Architecture Decisions" (2011).
One file per decision: `docs/adr/NNNN-short-title.md`, numbered in order, max ~15 lines.

```
# NNNN - <decision title>
Date: YYYY-MM-DD
Status: Accepted | Superseded by NNNN
Context: <the forces and constraints that make this decision necessary>
Decision: <what we do, stated actively: "We will ...">
Consequences: <what gets easier, what gets harder, what we give up>
```

Rules:
- Write an ADR when a choice changes structure: a new module, a boundary, a data format, a dependency, an engine or tool choice.
- Never rewrite an accepted ADR. Write a new one and mark the old one "Superseded by NNNN".
- The AI reads docs/adr/ at the start of each session; ADRs are its memory of why the structure is the way it is.

Example:

```
# 0002 - Never write .meta files
Date: 2026-11-04
Status: Accepted
Context: Unity links scenes and prefabs to assets by the GUID stored in .meta. A new .meta breaks references.
Decision: We will only overwrite the asset file itself; .meta files are read-only for every module.
Consequences: Existing references stay intact. New assets must be imported by Unity first to get a .meta.
```

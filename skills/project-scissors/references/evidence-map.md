# Evidence map

Levels: MEASURED = controlled experiment, benchmark or systematic data (most are 2026 arXiv preprints, not yet peer reviewed; read effect sizes as direction, not fact). VENDOR = official documentation. PRACTICE = established method or practitioner observation, no controlled measurement. Benchmarks are mostly Python/web; Unity C# and Blender Python are not directly covered.

## The problem

| Finding | Level | Source |
|---|---|---|
| About half of test-passing agent PRs on SWE-bench Verified would not be merged by maintainers | MEASURED | METR, 2026-03-10: https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/ |
| Code quality erodes in 80-90% of long iterative agent trajectories as agents extend their own code | MEASURED | SlopCodeBench, arXiv:2603.24755 |
| Agents follow explicitly specified refactorings up to 70%, under 8% when not specified | MEASURED | CodeTaste, arXiv:2603.04177 |
| 35.8% of fully successful 3D scene edits also change something else in the scene | MEASURED | Code4Scene, arXiv:2609.36777 |
| Developers were 19% slower with AI on real tasks but believed they were 20% faster (early-2025 tools, large mature repos) | MEASURED | METR, 2025-07-10: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ |
| Agents overcomplicate code, bloat abstractions, leave dead code | PRACTICE | Karpathy, 2026-01-26: https://x.com/karpathy/status/2015883857489522876 |
| Scope, feature creep and cutting features are the most common problems in 200+ game post-mortems | MEASURED | Politowski et al., MSR 2020: https://assets.ptidej.net/Publications/Documents/MSR20.doc.pdf |

## The rules

| Rule | Level | Source |
|---|---|---|
| Write architecture before code (PLAN) | Problem MEASURED (CodeTaste, SlopCodeBench); fix PRACTICE | as above |
| Walking skeleton first | PRACTICE | Alistair Cockburn; "tracer bullets" in Hunt & Thomas, The Pragmatic Programmer |
| ADRs as decision memory | PRACTICE | Michael Nygard, 2011: https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions |
| Change only what the task requires | MEASURED: a preservation instruction cut excess edit distance 0.195 to 0.131 and added complexity by 26.6% | arXiv:2609.04061 |
| Plan + human approval | MEASURED, mixed: good plans help, a bad plan hurts more than none | arXiv:2604.12147; arXiv:2608.06811 |
| Verifiable done + changed-file list | VENDOR; tests alone not enough (METR merge gap) | https://code.claude.com/docs/en/best-practices |
| Structure gate (2nd real use) | PRACTICE | YAGNI |
| Fixed appetite, no silent extension | PRACTICE (Shape Up); supported by MEASURED planning fallacy (theses predicted 33.9 days, took 55.5) | https://basecamp.com/shapeup ; Buehler, Griffin & Ross 1994, JPSP 67(3) |
| One active project, parking lot | PRACTICE | no direct measurement found |
| Review against spec, skip style; don't fix every finding | MEASURED, conditional | arXiv:2607.21656; arXiv:2610.01471 |

## Rule files and skills

| Finding | Level | Source |
|---|---|---|
| Context files rarely raise success and add 20%+ cost; repo overviews don't help; instructions are followed | MEASURED | Gloaguen et al., arXiv:2602.11988 |
| A short AGENTS.md cut runtime and tokens without changing completion | MEASURED | Lulla et al., arXiv:2601.20404 |
| Curated skills +16.6 points on average; focused skills (max 3 modules) beat large bundles; self-generated skills did not help | MEASURED | SkillsBench, arXiv:2602.12670 |
| Skills can change token use from -78% to +451% without changing success | MEASURED | arXiv:2603.15401 |
| Instruction following drops as instruction count grows; earlier instructions followed better | MEASURED | IFScale, arXiv:2507.11538 |
| CLAUDE.md under 200 lines; must-happen rules as hooks | VENDOR | https://code.claude.com/docs/en/memory ; best-practices page |
| Build evaluations first; test against a no-skill baseline; SKILL.md under 500 lines | VENDOR | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices |
| LLM judges show position, length and self-preference bias | MEASURED | Zheng et al., arXiv:2306.05685 |

Not measured anywhere: this skill as a whole. Only its parts. Use eval-protocol.md.

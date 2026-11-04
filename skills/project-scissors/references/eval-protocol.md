# Evaluating a skill (this one or any other)

A skill is only worth its tokens if it changes outcomes. Measure with paired runs against a no-skill baseline (SkillsBench; Anthropic skill-creator uses the same with/without-skill design).

1. Task set, built once: 10-12 real, repeatable tasks from your own projects. At least half are traps: an out-of-scope feature request arrives mid-task, or a one-line fix sits next to tempting unrelated code.
2. Conditions: (A) no skill, (B) skill X, (C) an overlapping skill Y if one exists. Run each task in each condition at least 3 times, each in a fresh session (outputs are not deterministic).
3. Deterministic metrics first:
   - Acceptance test passed?
   - Files and lines changed (`git diff --stat`).
   - Any edit to a Do not touch path?
   - Out-of-scope request implemented, or parked in "Later"?
   - New modules, managers or abstractions added without approval?
   - Tokens and wall time.
4. LLM judge only if needed: "Which diff meets the spec with less excess?" Hide condition labels, ask twice with the order swapped, count only consistent verdicts, prefer a judge from a different model family (position, length and self-preference biases: Zheng et al., MT-Bench, 2023).
5. Decide:
   - B is no better than A: delete or shorten the skill; the model may already do this.
   - B and C are equivalent: keep the shorter one, remove the duplicate.
   - B hurts some task types: narrow the skill's description so it stops triggering there.
6. Re-run the set after every model update; tendencies change between versions.

Inventory cleanup: duplicates found on 2026-11-03 (same skill installed from several sources; a Turkish and an English twin of the puzzle feel audit) are the first candidates for this protocol.

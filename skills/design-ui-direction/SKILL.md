---
name: design-ui-direction
description: "Give a project's screens its own design language instead of AI defaults, and catch the common UI mistakes early: derive a direction and a small token system from the project, write docs/ai/DESIGN.md, build, run the start-of-project checks, and report scored P0-P3 findings. Use when building or changing a user interface, when a project with a UI has no DESIGN.md, or for 'this looks generic', 'review this UI'. Apps and games alike; a game package may add its own game checks."
---
# Design UI direction

Make good design first, then check it; slop markers are one check, not the goal. Evidence labels: **[M]** measured,
**[P]** documented practice, **[O]** opinion. Sources: [references/sources.md](references/sources.md).
Inside PLUT_OS the brief's Design line says whether `docs/ai/DESIGN.md` exists; the template is
`scaffold/design/DESIGN-template.md` in the PLUT_OS install.

## 1. Read the project before any pixel
- `docs/ai/DESIGN.md` exists: follow it. A choice it does not cover is added there with its reason.
- It does not: read what the project already says (README, the map, existing screens, the stack's token file).
  Note who uses it, for what, what content it shows, the device and setting. Unknown stays "unknown".
- Check accessibility in step 4, not while choosing the direction: reminders at that point tend to give safe,
  under-designed output [O].

## 2. Derive one direction, with reasons
- Purpose, tone, the main user decision on this screen, and one thing that makes it this project's [P]. Every line
  ties to step 1; "it looks modern" is not a reason.
- One direction, not a menu; show alternatives only when the owner asks for them.
- Models converge on the mean aesthetic, and banning one default moves them to the next (Inter → Space Grotesk;
  purple gradient → cream and terracotta) [M, vendor study; P]. Pick what this project's users and content need,
  not "the opposite of slop".

## 3. Decide the few things that prevent most mistakes, then build
Most early UI failures come from decisions nobody made [P]. In the first hour fix these, in DESIGN.md and the
stack's token file (start-checks C1-C6):
- tokens: 8-12 colour roles as foreground/background pairs, 6-8 type steps, one 4- or 8-based spacing scale,
  2-3 radii; nothing outside them;
- contrast of every text pair (4.5:1 body, 3:1 large text and UI parts) [M]; no state by colour alone [M];
- touch targets 44 pt / 48 dp [P]; one primary action per screen, a verb that names the result [P];
- loading, empty, error and success for every data view [P].
Build the screen from tokens only, every state included.

## 4. Measure, do not trust your own look
- Render it and look at the render: at the target widths (at least 375 and 1280), light and dark if both exist.
- Run [references/start-checks.md](references/start-checks.md) C7-C14: silent failures, feedback timing, labels,
  forms, keyboard, text scaling, console and overflow, the 10-minute walk. A game also runs its package's game
  checks when installed.
- A failed measurement is a P0 or P1 finding, whatever the screen looks like.

## 5. Critique: scored, prioritised, located
- Score with [references/rubric.md](references/rubric.md) (hierarchy, typography, colour, spacing, interaction and
  states, accessibility; 0-4 each, with evidence).
- Run [references/slop-markers.md](references/slop-markers.md): a marker is a question ("what reason from this
  project?"), not a verdict.
- Findings P0 (blocks use), P1 (harms the main task), P2 (quality), P3 (polish), each with its location, the reason
  and the smallest fix. One self-review finds about a third of the problems [M]: count an AI pass as one
  evaluator, and for clarity use people or separately prompted critics (C15). The critique reports; it does not fix.

## 6. Fix loop, only when asked to fix
One typed goal per round (layout, spacing, typography, styling or completeness), at most 3 rounds, re-render and
re-score each round, keep the best round, not the last [M]. A free "look and improve" loop made results worse round
after round in that study; carry what got worse as an avoid-list.

## 7. Hand back
Update DESIGN.md (tokens, components, "Not in this project" with reasons, a dated Decisions line) and report the
direction and its reasons, the scores, the findings, what was measured and what was not.

Never: a direction without a reason from the project; "fixed" without a re-render; a slop marker as proof of AI
authorship; an aesthetic score presented as measured.

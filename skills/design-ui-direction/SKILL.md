---
name: design-ui-direction
description: "Keep a project's screens clear at first glance and in its own design language, not AI defaults: write and follow docs/ai/DESIGN.md, check every screen on its render (one thing to look at, little text, the users' language, no competing contrast, accessibility), catch the common UI mistakes, and run an A/B design pick when the owner asks. Use when building or changing a user interface, when a project with a UI has no DESIGN.md, or for 'this looks generic', 'review this UI', 'A/B this screen'. Apps and games; a game package may add game checks."
---
# Design UI direction

Evidence labels: **[M]** measured, **[P]** documented practice, **[O]** opinion. Sources:
[references/sources.md](references/sources.md). Inside PLUT_OS the brief's Design line says whether
`docs/ai/DESIGN.md` exists; its template is `scaffold/design/DESIGN-template.md` in the PLUT_OS install.

**Apps and games differ here** (owner's blind picks, 2026-11-05: the skill's look won 2 of 2 game screens and 1 of 8
app screens; every rule that shaped an app's look missed the owner's eye somewhere).
- **App:** this skill does not shape the look. The look comes from the owner's picks in DESIGN.md; until there are
  some, design as you judge best for the users and **propose an A/B pick** (step 6) on the first main screen. Run only
  the failure checks of step 4 (they find defects, they never change the style). Skip steps 2, 3 and 5.
- **Game:** follow every step, plus the game package's checks.

## 1. Read the project and the owner's picks
- `docs/ai/DESIGN.md` exists: follow it, its "Owner picks" first. A choice it does not cover is added with its reason.
- It does not: read the README, the map and the existing screens; note who uses it, for what, on which device, and in
  which language. Write the page from the template. Unknown stays "unknown".
- All UI copy is in the users' language (the project's language, names and currency tell it), `lang` set to match
  [O, F2].

## 2. Direction and tokens (games)
- One direction with reasons from the project; no "the opposite of slop" [P]. Banning one default moves models to the
  next [M, vendor study].
- A small token system: 8-12 colour roles in pairs, 6-8 type steps, one spacing scale, 2-3 radii. In an app, keep it
  quiet: one accent, red only for warnings and destructive actions [P].

## 3. First glance: one thing to look at, little to read (games)
This weighs most; the owner judges by it [O], and busy, text-heavy screens lose on first impression [M].
- The first heading names the screen and its state in plain words ("Siparişin yolda, 14:20") [P, F1].
- One focal point, framed once; everything else quieter. One region set apart, the rest grouped by spacing; no card
  inside a card [P, F11].
- Text budget: at most about 110 visible words above the fold on a single-purpose screen [M basis, F3]; cut the
  first draft by about a third, dropping every line whose loss would not change the next action [M, F4]; no
  promotional adjectives and no helper line that repeats its control [M, F5].
- Little text means no explanatory prose, never less information or fewer features. The facts the user acts on are
  shown large (key numbers as big figures), and the features they may want next (navigation, filters, search,
  create) stay visible and clearly labelled [O: owner, 2026-11-05].
- Give the eye levels: the thing to act on first (a framed alert with its one action), then the key figures, then
  the full content (list or table). A flat single-column list where every row looks the same reads like a paper
  receipt and lost the owner's pick [O, F6].
- No eyebrow labels; summary figures go after the thing to act on, never as filler before it [O, F6].

## 4. Measure the render (apps and games)
Render at the target sizes (at least 375 and 1280 wide), light and dark if both exist, after loading has finished.
**Failure checks, every screen:** these find defects and must never be used to make a look quieter, plainer or busier.
- Copy in the users' language (F2); the first heading says what the screen is (F1).
- Accessibility (F14): text 4.5:1, visible labels (not placeholders), no pale disabled button without a reason; no
  state by colour alone, 44 pt / 48 dp targets, one primary action (start-checks C2-C5).
- States, forms, keyboard and failures: [references/start-checks.md](references/start-checks.md) C6-C14.
- Fresh eyes (F15): a separate agent sees only the screenshot and says what the screen is, what the most prominent
  control does, and what it saw first; a mismatch is reported to the owner, not "fixed" by restyling.
**Games** also run the first-glance checks in [references/first-glance-checks.md](references/first-glance-checks.md)
(F3, F7, F9) and the game package's checks.
A failed check is a finding (P0 blocks use, P1 harms the main task, P2 quality, P3 polish) with its location and the
smallest fix that keeps the look.

## 5. Critique and fix (games)
- Score with [references/rubric.md](references/rubric.md) (first glance counts double); run
  [references/slop-markers.md](references/slop-markers.md) as questions, not verdicts.
- Fix only when asked: one typed goal per round, at most 3 rounds, re-render each round, keep the best round [M].

## 6. A/B design pick (on request, and proposed on an app's first main screen)
When the owner asks, or when you propose it for a screen that sets the project's look, follow
[references/design-pick.md](references/design-pick.md): two real alternatives rendered, shown blind in a
`plutos_ask` card with images, the pick and the owner's note recorded under "Owner picks" in DESIGN.md. Picks outrank
this skill's defaults on look, never on accessibility.

## 7. Hand back
Update DESIGN.md (tokens, components, "Not in this project", Decisions) and report what was measured (word counts,
F7/F9/F14/F15 results) and what was not.

Never: English copy for users who speak another language; restyling an app to satisfy a rule instead of the owner's
picks; "fixed" without a re-render; an aesthetic score presented as measured.

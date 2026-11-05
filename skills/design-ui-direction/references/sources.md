# Sources (checked 2026-11-05)

Every source was opened on 2026-11-05. Ideas are restated in this package's words; no text was copied. What each
supports and its evidence level:

| Source | Supports | Level | Note |
|---|---|---|---|
| Anthropic, "Improving frontend design through Skills" (claude.com blog, 12 Nov 2025) | "distributional convergence"; defaults to Inter, purple on white, minimal motion; still converges (Space Grotesk) | P | Before/after screenshots only, no metrics |
| anthropics/skills `frontend-design` (Apache 2.0) | Direction before code: purpose, tone, constraints, differentiation (commit 0075614, Dec 2025). The current version (Sep 2026) asks for a short design plan checked for uniqueness before code and lists newer clusters (cream + terracotta, near-black + acid accent, broadsheet, SaaS-card kit) | P | Font and purple bans were dropped from the current text |
| pbakaus/impeccable (Apache 2.0) | `critique` as a scored review; `audit` findings P0-P3; `document` writes DESIGN.md; detector command | P | No published effect study. The accessibility over-caution note is in its CLAUDE.md, a developer observation |
| RubSE, arXiv 2608.24138 (University of Maryland, Microsoft) | Free screenshot self-repair degraded GPT-5.2 on Design2Code in 15 of 15 rounds (final −2.73); one typed rubric target per round beat it in 15 of 18 settings, mean +1.20 | M | Measures matching a target screenshot, not creating a design |
| Design Creativity Bench, arXiv 2610.11539 | Models meet the brief (above 90%) but are more repetitive than humans (creative range 0.581 vs 0.902) | M | All authors at Kombai Inc., a vendor of AI UI tools |
| Interrogating Design Homogenization in Web Vibe Coding, arXiv 2603.13036 (University of Washington, Microsoft Research) | Convergence toward a dominant aesthetic; the model as a mediator that queries assumptions and presents alternatives before finalising | P | Analysis and case studies, no user experiment |
| funboy322/avoid-ai-design (MIT) | Findings with priority, rule and line; "tasteful" second-order defaults read as AI too | P | P0-P2 scale; a small repository |

Not used (could not be confirmed or not evidence): a detector rule count for Impeccable; "Claude Design checks
output against the design system"; "over 40% of AI code has design flaws"; star counts and rule counts as
quality evidence.

## Start-of-project checks (research of 2026-11-05)

Full report: "Proje başı hızlı tasarım kontrolleri" (owner's reports folder). The figures the checks rest on:

| Source | Supports | Level |
|---|---|---|
| WebAIM Million 2026 | Low-contrast text on 83.9% of the top million home pages, missing form labels 51%, empty links 46.3%, empty buttons 30.6% | M |
| Baymard Institute (2023-2025 articles) | 31% of sites without inline validation; 98% without adaptive error messages; 34% clear card data after an error | M |
| Nielsen Norman Group (error messages 2023, empty states 2021, response times 1993) | Message content, empty states, 0.1 / 1 / 10 s limits | P |
| Nielsen and Molich; Nielsen (heuristic evaluation) | One evaluator finds about 35% of problems (19-51%), five about 75% | M |
| Nielsen and Landauer 1993; Faulkner 2003 | Five users find about 85% on average, a single random group of five as little as 55% | M |
| 2025-2026 studies of AI design tools and LLM code | 29% accessibility compliance for six AI design tools; keyboard access still failing after a follow-up prompt; AI reviewer overlap with experts from 21% upward, results conflict | M |
| GOV.UK Design System | One primary button per page; avoid disabled buttons | P |
| Apple HIG, Material 3 (via secondary sources); WCAG 2.2 | 44 pt / 48 dp targets; 24 px AA minimum | P |
| Figma 2019 (vendor) | Work with a design system finished 34% faster; quality not scored | M, vendor |

## First-glance checks F1-F15 (research of 2026-11-05)

Full report: "İlk bakış tasarım ilkeleri" (owner's reports folder, not in the repository). The figures the F checks rest on:

| Source | Supports | Level |
|---|---|---|
| Morkes and Nielsen 1997 (NN/g, 51 users) | Concise text +58%, scannable +47%, objective +27%, all three +124% usability | M, old |
| Weinreich et al. 2008 (data 2005, 25 users, 45,237 page views; NN/g "How little do users read") | Users read at most 28% of a page's words, about 20% in practice; about half only on pages of 111 words or fewer | M, old |
| Lindgaard et al. 2006; Tuch et al. 2012 (119 sites); Reinecke et al. CHI 2013 (548 raters, 450 sites) | Appeal forms in 17-50 ms; low complexity plus a familiar layout liked most; complexity explains much of appeal | M (appeal, not comprehension) |
| NN/g visual hierarchy, F-pattern (2006, 2017), common region, progressive disclosure | Most important element biggest; at most 2 large elements, 3 type sizes, 3 contrast levels; squint test; one region set apart | P |
| MIT 2023 (PNAS, 105 lawyers) | Plain language preferred even by experts (legal text) | M, other domain |
| Owner's blind picks, 2026-11-05 (`docs/evals/design-ui-direction-results-2026-11-05.md` in the PLUT_OS repository) | Apps: the skill's harder look lost 4 of 4 screens; games: it won 2 of 2 | O, one rater |

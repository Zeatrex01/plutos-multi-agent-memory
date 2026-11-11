# Design kickoff and A/B picks

The owner judges by eye, and blind picks were the only design evaluation that matched them (2026-11-05). The look of an
app comes from the owner's picks, made once per project in a kickoff, not page by page (owner, 2026-11-05: "projenin
kapsamına göre gereken sayfaların örnek taslaklarını bana test olarak sunarsın, ben seçerim, ortak tasarım
çıkartırsın").

## The kickoff (once, at the start of a project with a UI)
Run it when DESIGN.md has no "Owner picks" yet, after asking the owner once through `plutos_ask` whether to run it now.
0. **The essence of what exists** (a project that already has screens). Render today's screens, read their token
   files, and write a short "essence" note into DESIGN.md: what the product is, the tokens and patterns in use, what to
   keep (what works and is the project's own), what to change, what to drop (slop markers, inconsistencies between
   screens). The drafts below build on this note, so the kickoff proposes a new design grown from the project's own,
   not one from nowhere. Show today's screens next to the drafts when it helps the owner compare.
1. **Pages from the scope.** Read `SCOPE.md`, the project map and the README, and list the 3-6 page types the project
   needs (for example home, list, detail, form, settings; phone and desktop if both are targets). Name them in the
   question so the owner sees what is covered.
2. **Two drafts per page type.** Build A and B of each page with the same content, the same language (the users') and
   its main filled state. A and B differ in one or two deliberate ways, and the differences rotate across pages so the
   set separates the owner's preferences: for example colour and framing of the main information on one page,
   density and what is shown large on another, navigation and layout on a third. Note for yourself what each pair
   varies. Do not mark either as recommended.
3. **Render and file.** Render each draft after loading, at its main target size. Save as
   `docs/ai/design-picks/<page>/A.png` and `B.png`; which is which is random and kept in
   `docs/ai/design-picks/<page>/key.md`.
4. **Ask as one set.** One `plutos_ask` per page type, all sent together: question "Kickoff <n>/<total>: which <page>
   do you prefer?", options `["A", "B", "Neither"]`, images `[".../A.png", ".../B.png"]` (image i is labelled option
   i), `ttl_minutes: 1440`, context "Pick by eye; a note on why helps the common design." Keep waiting with each
   ticket. On EXPIRED or REJECTED record nothing for that page.
5. **Record every pick** under "Owner picks" in DESIGN.md: date, page, what A and B varied, the pick, the owner's
   note in their words, what it suggests.
6. **Derive the common design.** Read the picks together and write the shared design language into DESIGN.md:
   tokens (colours, type, spacing, radius), how the main information is framed, what is shown large, navigation,
   density, components, each line citing the picks it comes from. Where picks disagree, say so and prefer the pick
   whose page type is closest to the main screen. Then show it back: one more `plutos_ask` with a render of the main
   page in the common design, options `["Yes, use this", "Not yet"]`; on "Not yet" adjust from the note and ask again.

## After the kickoff
- Every new page follows the common design and the owner picks; no new test per page.
- A new A/B pick only when the owner asks, when a new kind of page appears that the kickoff did not cover, or when the
  owner says a page is wrong. A newer pick supersedes an older line it contradicts (mark the old line superseded).
- Picks outrank this skill's defaults on look, never accessibility (F14).

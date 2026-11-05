# A/B design pick (on request)

The owner judges by eye, and blind picks were the only design evaluation that matched them (2026-11-05). A pick is
never automatic: run it when the owner asks for one, or propose it (one line, through `plutos_ask`) for a screen that
sets the project's look: the first main screen, a new kind of screen, or a change the owner may not like. Never more
than one open pick per screen at a time; a new pick after "Neither" or a later redesign supersedes the older one.

1. **Two real alternatives.** Build two versions of the same screen, with the same content, the same language and the
   same states, that differ in one or two deliberate ways (for example layout and density, or palette and framing).
   Write down for yourself what each varies. Do not label either as "yours", "recommended", or "with the skill".
2. **Render both** at the main target size, in the main filled state, after loading has finished. Save them as
   `docs/ai/design-picks/<screen>/A.png` and `B.png`; which is which is random, kept in
   `docs/ai/design-picks/<screen>/key.md`, not shown in the question.
3. **Ask** with `plutos_ask`: question "Which <screen> do you prefer?", options `["A", "B", "Neither"]`, images
   `["docs/ai/design-picks/<screen>/A.png", "docs/ai/design-picks/<screen>/B.png"]` (image i is labelled option i),
   `ttl_minutes: 1440`, context "Pick by eye; a note on why helps the next screens." Keep waiting with the ticket. On
   EXPIRED or REJECTED record nothing, carry on with your own choice, and offer the pick again later.
4. **Record** under "Owner picks" in `docs/ai/DESIGN.md`: the date, the screen, what A and B varied, which was picked,
   the owner's note in their words, and the preference it suggests ("one soft framed card over a dark header"). On
   "Neither", record the note and build again from it.
5. **Use it.** Later screens follow the owner picks; a pick outranks this skill's defaults on look (palette, density,
   framing) but never removes accessibility (F14). When two picks disagree, the newer one wins and the older line is
   marked superseded.

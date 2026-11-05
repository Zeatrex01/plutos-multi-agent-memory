# Slop markers

Questions, not bans. Each marker passes when the project has a recorded reason for it (in `docs/ai/DESIGN.md`).
The list moves: when one default is banned, models move to the next "tasteful" one, and those become markers
too [P: avoid-ai-design README; Anthropic]. No study measures how often each appears [practitioner consensus].

| # | Marker | How to check |
|---|---|---|
| 1 | Inter, Roboto, Arial or the system font as the only face, or a second-order default (Space Grotesk, Geist, Instrument Serif, Fraunces) chosen without a reason | computed `font-family` |
| 2 | Purple or indigo to blue gradient, gradient-filled headline text | gradient and `background-clip: text` in styles |
| 3 | Centred hero over three equal rounded feature cards | page structure |
| 4 | The same radius and shadow on everything; cards inside cards | token use across components |
| 5 | Glassmorphism, glow or floating blobs with no function | `backdrop-filter`, large blurred shadows |
| 6 | An unmodified component-kit palette (shadcn and similar) | token values against the kit defaults |
| 7 | Emoji used as icons | emoji in buttons, headings, list markers |
| 8 | Generic copy ("Build the future", "Welcome back, John!"), placeholder or lorem text | read it; regex for placeholders |
| 9 | Faint grey text below WCAG AA | contrast |
| 10 | A font named in CSS but never loaded | network and computed style |
| 11 | Font, color or radius drifting from page to page | tokens per page |
| 12 | Mobile: five-tab bar plus a floating action button, stacks of white rounded cards | structure on 375 wide |
| 13 | The newer "tasteful" clusters: cream with terracotta, near-black with one acid accent, broadsheet serif layouts, eyebrow labels over every heading, numbered 01/02 steps | colors, type and structure |

A marker is never proof that an AI made the page; human sites use the same patterns.

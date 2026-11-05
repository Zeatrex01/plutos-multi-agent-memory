# Critique rubric

Score each dimension 0-4 (first glance counts double in a total) with the evidence that sets the score (a render, a computed value, a line).
0 broken · 1 works against the user · 2 works, generic or uneven · 3 clear and consistent · 4 clear, consistent and
plainly this project's. A score without evidence is "unknown", not 2.

| Dimension | Ask | Measure where possible |
|---|---|---|
| First glance (weighs most) | In 3 seconds: what is this screen, what does it want, what happens on the main action? One focal point, framed? Little text to read? | Words on the first screen; what a person (or you, from the render) notices first in 5 seconds; lines whose removal would not change the next action |
| Hierarchy | Is the main decision the first thing seen? One primary action per view? | Size and weight of the top three elements; first screen at 375 and 1280 |
| Typography | At most two families, each with a reason? A readable scale and line length? | Computed font-family, sizes, line-height; 45-75 characters per line for body text [P] |
| Color | Colors from tokens only? One accent with a meaning? Color never the only cue? | Distinct colors in computed styles against the tokens; contrast ratios |
| Spacing | One unit and scale? Related things closer than unrelated? | Margins and gaps against the scale |
| Interaction and states | Empty, loading, error, long text, many items designed? Focus visible? Feedback on every action? | Render each state; tab through the page |
| Accessibility | WCAG AA contrast; targets 44 pt / 48 dp; reduced motion respected; labels on controls | Contrast, target sizes, `prefers-reduced-motion`, axe if available |

Priorities for findings: P0 blocks use (unreadable, unreachable, broken), P1 harms the main task, P2 hurts
quality or consistency, P3 polish. avoid-ai-design uses P0-P2 and Impeccable's audit P0-P3; this skill uses P0-P3.

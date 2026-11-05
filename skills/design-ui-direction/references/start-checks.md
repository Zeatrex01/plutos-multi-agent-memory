# Start-of-project checks (core: every project)

Fifteen checks of a few minutes each that catch the most common UI mistakes, for web and mobile apps and for the
menus and settings of games. Format: check | how, with minutes | evidence label (measured / practice / opinion).
Run them on the first screen and again before each demo. Sources and figures: [sources.md](sources.md).

C1  Declare tokens before the first screen: 8-12 colour roles in fg/bg pairs, 6-8 type steps, one 4- or 8-based spacing scale, 2-3 radii; flag any value outside them | start from a mature kit, override colour/type/radius in DESIGN.md or CSS variables, add stylelint strict-value (15 min) | practice
C2  Every text/background token pair passes 4.5:1 (body) and 3:1 (large text, UI parts) | run each pair through a contrast checker once, then on every page with axe or Lighthouse (5 min) | measured
C3  No state or error is shown by colour alone | view each screen in grayscale (DevTools rendering emulation); every distinction survives through text, icon, shape or border (3 min) | measured
C4  Touch targets at least 44x44 pt (48 dp on Android), spaced apart; hit area counts, not the icon | set a min-target token, turn on axe target-size, tap through on a real phone with a thumb (5 min) | practice
C5  Exactly one primary action per screen, labelled with a verb that names the result | count primary-variant buttons per view; list all button labels in one sheet (5 min) | practice
C6  Every data view defines loading, empty, error and success states; "No records" never shows while data loads | open the app with an empty account and with the network offline; screenshot each state (5 min) | practice
C7  No silent failure: every primary action shows a result or a message when the request fails | block the API in DevTools and click every primary action (5 min) | opinion
C8  Feedback within 0.1 s; an indicator after 1 s; progress after 10 s; double submit creates one record | throttle to Slow 3G, double-click each submit (5 min) | practice
C9  Every input has a visible label (not a placeholder); every icon-only control has an accessible name | axe or WAVE scan; grep placeholder= without label and icon buttons without aria-label (3 min) | measured
C10 Forms: validate on blur, put a specific message (what is wrong, how to fix) next to the field, keep all other input after an error, no disabled submit without a reason | tab through an empty form (no early errors), then submit with one bad field (5 min) | measured
C11 Keyboard or controller reaches everything, with visible focus; no outline:none without a replacement | put the mouse aside and walk the main flow with Tab/Enter/Esc or the pad (5 min) | practice
C12 Text readable at default size on the smallest target device, and scales to 200% without clipping the longest (e.g. German) string | render the longest string at 200% in each container; scroll in one direction only (5 min) | practice
C13 Page renders with no console errors, failed requests, broken images or horizontal overflow at each target viewport | headless run at 360, 390, 768 and 1440 px (2 min automated) | measured
C14 Before each demo, run a 10-minute walk: empty account, offline, Slow 3G, keyboard only, grayscale, real phone | keep the six conditions as a fixed script; log findings on the board (10 min) | practice
C15 Judge clarity with people or separate critics, not one self-review: 3-5 people per round on a 5-second test plus first clicks for the 3 core tasks, repeated after fixes; an AI pass counts as one evaluator | show the screen 5 s, ask "what is this, what can you do here"; run 2-3 differently prompted AI critics and drop claims a screenshot does not confirm (15 min) | measured

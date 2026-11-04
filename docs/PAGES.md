# Dashboard pages: what each is for, what it shows, what it calls, how it behaves

One row per page in the sidebar, in its order. **Calls** are the dashboard routes the page's modules
fetch (`ui/modules/<module>.js`, read from the modules' source on 2026-11-04; the approval bar on every
page also polls `/api/approvals`, and the boot splash `/api/workspaces`, `/api/mcp/status`, `/api/hygiene`,
`/api/continuity` and `/api/activity`); the full route table is in
[architecture/06-frontend.md](architecture/06-frontend.md). **Measured** is from opening every page
in headless Chromium against the development dashboard (`npm run dev`, its own empty data folder, so
this is what a new user sees) on 2026-11-03: time until the page's requests settle, page errors and
failed requests. No page threw an error or had a failed request.

## Work

| Page (`#id`, module) | What it is for | What it shows | Calls | Measured |
|---|---|---|---|---|
| Home (`#overview`, `overview.js`, `orbit.js`) | The first look: what needs you and what to do next | The live orbit (one orbit per connected AI, with their names), what needs you, what your AIs are doing, the next step, what happened since you were last here | `/api/return-summary`, `/api/workspaces`, `/api/report`, `/api/hygiene`, `/api/activity`, `/api/mcp/status`, `/api/codeindex/scan` (the setup card's scan step) | 0.4 s; empty-state guidance in a new project |
| Board (`#board`, `board.js`, `watcher.js`, `hooks.js`) | Give work to your AIs and follow it to Done | The board's entries by status, the roster, the hygiene budget, the watcher and the Hooks panel (session brief, safety guard, push gate with its git pre-push half, claim check) | `/api/board` (main, `?board=agents`, and the assign/update writes), `/api/board/archive`, `/api/roster`, `/api/roster/remove`, `/api/hygiene`, `/api/ideas`, `/api/watcher`, `/api/snapshot`, `/api/hooks` | 0.4 s; the busiest page (26 buttons) |
| Shared Table (`#council`, `council.js`) | One job worked on by several departments separately, answers side by side | The council room: departments, their answers, your verdict | `/api/council/rooms`, `/api/council/room`, `/api/council/events`, `/api/council/file`, `/api/council/human` | 0.4 s; empty until a council job exists |

## Knowledge

| Page | What it is for | What it shows | Calls | Measured |
|---|---|---|---|---|
| Report (`#report`, `report.js`, `memory.js`) | What happened over a time window, and what the AIs recorded as known | Commits, sessions, board changes; the session memory with verified and claimed labels; each decision with its status word (valid, verified, reversed) from the registry | `/api/report` (with `?days=`), `/api/continuity`, `/api/state` | 0.4 s; the longest page (13K characters) |
| Research (`#research`, `research.js`) | Research done with sources: every page used is saved, every quote must appear in it | Research jobs, their sources and checked quotes | `/api/research/topics`, `/api/research/topic`, `/api/research/branch`, `/api/research/fetch`, `/api/research/source`, `/api/research/install` | 0.4 s; empty until a job runs |
| Code map (`#codeindex`, `codeindex.js`) | **Where things are**: the project's folders and files and what each defines | One box per folder with its files; folder list and details panel. Capped at 500 files by default | `/api/codeindex`, `/api/codeindex/scan` | 0.4 s |
| Documents (`#dochub`, `dochub.js`) | The project's documents and how they link | Documents, their links, the latest commits beside them | `/api/docs`, `/api/docs/open`, `/api/git/commits` | 0.4 s |
| Dependency graph (`#graphify`, `graphify.js`) | **What depends on what**: which source file uses which | The graph, built on demand; by default the 300 most connected files (150, 300, 600 or all, and one top folder) | `/api/graphify` (with `?mode=`), `/api/graphify/scan`, `/api/graphify/clean`, `/api/graphify/auto`, `/api/graphify/html` | 0.5 s for the page; the graph itself 1.8 s at 300 files of a 2,500-file project |

## Setup

| Page | What it is for | What it shows | Calls | Measured |
|---|---|---|---|---|
| Projects (`#hub-view`, `workspaces.js`, `workspace-tree.js`, `connect.js`) | Add a project, open it, connect your AI tools | One card for the open project with two steps (1 install the project kit, 2 connect an AI: Claude Code, Codex, Gemini CLI and Cursor in view, the other tools under More tools), then the list of your projects; a single empty card before the first one | `/api/workspaces`, `/api/workspaces/add`, `/api/workspaces/switch`, `/api/workspaces/close`, `/api/workspaces/remove`, `/api/fs/list` (the Add-project folder browser), `/api/connect`, `/api/context/automation`, `/api/project/install`, `/api/workspaces/repair/preview`, `/api/workspaces/repair`, `/api/workspaces/repair/restore` (Repair, when the launcher is missing), `/api/recommended-mcps` and `/api/install-recommended-mcp` (the extra tools your AI can set up, each a board task) | 0.4 s |
| Skills (`#skills`, `skills.js`) | See which skills your AI tools read in this project, and switch a pack on or off | One row per skill folder: what it is for, which AI tools read it (`.claude/skills`, `.agents/skills`), whether the project or a pack put it there, and the pack's own measurement line ("not measured" otherwise); the registered packs with On/Off per project and a field to register a pack folder | `/api/skills`, `/api/packs`, `/api/packs/add`, `/api/packs/on`, `/api/packs/off`, `/api/packs/forget` | added 2026-11-04; opened in headless Chromium with one pack switched on: 0 errors, 0 failed requests, the table and the Packs card rendered |
| Setup questions (`#setup`, `setup.js`) | Five optional questions; the answers drive the tool and coordination recommendation | The interview and its recommendation | `/api/interview`, `/api/recommendations` | 0.4 s |
| Settings (`#settings`, `settings.js`, `features.js`, `updates.js`) | Which pages you see, the look, where data lives, whether PLUT_OS is current, installing it as an app | Page toggles, theme, the live orbit and notices, storage; Updates (the last check, Check for updates, Update now for a git checkout that is behind, Download for a newer release of the portable app); Install as an app (the browser's install prompt, or where its Install option is) | `/api/settings/storage`, `/api/workspaces/repair/preview`, `/api/workspaces/repair`, `/api/workspaces/repair/restore` (the Repair button), `/api/update` (GET on open, no network; `?check=1` and POST only on the buttons) | 0.4 s; the Updates and app cards added 2026-11-04, opened in headless Chromium: 0 errors |
| Guide (`#docs`) | How PLUT_OS works and the words it uses | The built-in guide | none | 0.4 s |

## Notes

- Code map and Dependency graph are two different questions: the map answers *where*, the graph
  *what depends on what*. Both cap what they draw so a big project stays responsive.
- On every page the sidebar mark is the same live orbit, and a connect or a disconnect slides a notice in at the top right. Settings → Live orbit and notices turns the notices off or keeps them until closed, and hides the Home orbit, the live mark or the motion.
- Pages that are empty in a new project say why and what to do (`emptyState` in `ui/modules/page.js`).
- Removed on 2026-11-04 after the page check ([results/page-check-2026-11-04.md](handoff/results/page-check-2026-11-04.md)):
  the Activity page (its "left off" card is Home's; the rest repeated Home and Board), the Plugins page (an
  empty shelf with no control; the Skills page above took its place the same day) and the AI tools
  (MCP) page (every list forwarded elsewhere; its "Ask my AI to set it up" cards now sit on the Projects
  page's Connect panel as "Extra tools your AI can set up"). The Research page's Export MCP button went too:
  `node tools/make-research-mcp.mjs <folder> --zip` builds the standalone package.
- To measure again: start `npm run dev` and open each page with any browser automation; every page is
  reachable at `http://127.0.0.1:3041/#<id>`.

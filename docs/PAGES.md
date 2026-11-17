# Dashboard pages: what each is for, what it shows, what it calls

Four pages since 2026-11-14 (owner decision d-51e97352b22e: keep the dashboard, make it plain), a
fifth, Activity, since 2026-11-15 (owner: usage and work on a page of their own, not on Home), and Code
map and Costs again since 2026-11-17 (owner: the 2026-11-14 cut took features he uses, the graph build
button among them). One row
per page in the sidebar, in its order. **Calls** are the dashboard routes the page's modules fetch
(`ui/modules/<module>.js`); every page also polls `/api/approvals` (the count on the Home nav item),
`/api/activity` and `/api/mcp/status` (the system bar). The full module and route table is in
[architecture/06-frontend.md](architecture/06-frontend.md).

| Page (`#id`, module) | What it is for | What it shows | Calls |
|---|---|---|---|
| Home (`#overview`, `overview.js`, `approvals.js`) | The first look: what your AIs are waiting on you for | The questions waiting (`plutos_ask`), large, with their images and options, approve or reject with a note; then a short status: project, open board items, the last session's next step, hooks on of total, the AI link, the last 7 days in one line | `/api/approvals`, `/api/approvals/image`, `POST /api/approvals`, `/api/workspaces`, `/api/report`, `/api/hooks`, `/api/mcp/status`, `/api/usage?days=7` |
| Board (`#board`, `board.js`, `verification.js`, `watcher.js`, `hooks.js`) | Give work to your AIs and follow it to Done | The board's entries by status (Board, Agent board, Ideas), the roster rail, the assign form, the hygiene budget; below it the project snapshot, the board watchers and the Hooks panel (session brief, safety guard, push gate, claim check) | `/api/board` (main, `?board=agents`, and the writes), `/api/board/archive`, `/api/board/evidence`, `/api/roster`, `/api/roster/remove`, `/api/hygiene`, `/api/ideas`, `/api/watcher`, `/api/snapshot`, `/api/hooks` |
| Activity (`#activity`, `activity-page.js`) | What your AIs used and what got done | Usage, last 7 days: tool calls and sessions started and ended, per AI, the most used tools and the listed tools never called; Work: the last 5 sessions (Did, Not checked, Next) and the board's to-do, in-progress, blocked and done items | `/api/workspaces`, `/api/report`, `/api/usage?days=7` |
| Code map (`#codeindex`, `graphify.js`, `codeindex.js`) | See the project's code: which file depends on which, and its folders and files | The dependency graph with **Build the graph** (writes `graphify-out/` into the project), Delete graph, Open in a new tab and Keep current automatically, the graph drawn in a frame (vis-network, loaded only here) with its file and link counts; below it the folder map from the code index with Scan again, search, the folder list and a details panel | `/api/graphify`, `POST /api/graphify/scan`, `POST /api/graphify/clean`, `POST /api/graphify/auto`, `/api/graphify/html`, `/api/codeindex`, `POST /api/codeindex/scan` |
| Costs (`#costs`, `usage.js`, `codeburn.js`) | What this project's AI work used, and what AI work costs on this computer | This project's token ledger from Claude Code's records on this machine, by agent, model and session (work is output plus thinking, cache apart); then CodeBurn's machine-wide figures by range and day, run only from its button and only when CodeBurn is installed | `/api/token-usage`, `/api/spend`, `POST /api/spend/run` |
| Projects (`#hub-view`, `workspaces.js`, `workspace-tree.js`, `connect.js`, `fsbrowse.js`) | Add a project, open it, connect your AI tools | One card for the open project with two steps (install the project kit, connect an AI), the extra tools your AI can set up, then the list of your projects | `/api/workspaces`, `/api/workspaces/add`, `/api/workspaces/switch`, `/api/workspaces/close`, `/api/workspaces/remove`, `/api/fs/list`, `/api/connect`, `/api/context/automation`, `/api/project/install`, `/api/recommended-mcps`, `/api/install-recommended-mcp` |
| Settings (`#settings`, `settings.js`, `updates.js`, `repair.js`) | Language and look, whether PLUT_OS is current, where data lives | Language and light/dark; Updates (the last check, Check for updates, Update now or Download); storage paths and Repair Links | `/api/settings/storage`, `/api/update` (GET on open, no network; `?check=1` and POST only on the buttons), `/api/workspaces/repair/preview`, `/api/workspaces/repair`, `/api/workspaces/repair/restore` |

## Notes

- Removed on 2026-11-14, with their routes: the council viewer (Shared Table; the council runs from
  `tools/council.mjs`), Report and the Story Deck (`plutos report`, `status_report`), AI costs,
  Research (the research tools of your AI), Code map, Documents and Dependency graph
  (the AIs read the index and graph through MCP; `plutos audit` names drifted documents), Skills
  (`plutos skills`, `plutos pack`), Setup questions (AGENTS.md Rule 0) and Guide (`docs/GUIDE.md`).
  The boot splash, the live orbit, accent themes, the page switches, the "How this page works" folds and
  the floating question dock went too.
- Restored on 2026-11-17: AI costs as **Costs** (always in the menu now; before the cut it was off
  until switched on in Settings) and Code map with the Dependency graph on one page, **Code map**.
  The token ledger moved to `/api/token-usage`, because `/api/usage` is now the usage log Activity reads.
- Removed on 2026-11-04 after the page check ([results/page-check-2026-11-04.md](handoff/results/page-check-2026-11-04.md)):
  the Activity, Plugins and AI tools (MCP) pages.
- Pages that are empty in a new project say why and what to do (`emptyState` in `ui/modules/page.js`).
- To look again: start `npm run dev` and open each page; every page is reachable at
  `http://127.0.0.1:3041/#<id>`.

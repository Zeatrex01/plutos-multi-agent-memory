# PLUT_OS User Guide

What PLUT_OS is, how to install it, how to bring a project in, and how the humans
and AIs in that project work together through it. This is the canonical guide.

## 1. What PLUT_OS is

PLUT_OS is the memory and hand-off layer between one owner and several AIs: a board, a session record, checks against a false "done", a working agreement in every brief, and a dashboard over the same files.
It does three things:

1. **Preparation** — observes a folder and maps it locally without changing it. Installing
   the in-project kit and connecting a named AI are later, separate choices.
2. **Memory** — gives each session a bounded, shared briefing while separating decisions,
   source-backed current claims, stale/quarantined claims, and unverified notes.
3. **Visibility and coordination** — shows you (the boss) what every AI and subagent is
   doing through the same boards and result references they use.

It is deliberately **not a control system**: PLUT_OS never commands an AI. Everything is
plain files (markdown + JSON): in PLUT_OS's private Hub while merely observing, then in the
project repo only after explicit kit installation. Any connected AI — Claude,
Gemini/Antigravity, Cursor, Copilot — can participate. Git is the shared channel once the
project carries the kit.

**What you see first.** With no project open, PLUT_OS opens on **Projects**, where you add or
resume one. With a project open it opens on **Home**: the questions your AIs are waiting on you for
(with their images and options), then a short status: the project, how many board items are open,
the last session's next step, whether the hooks are on, and whether an AI is connected. The menu has
seven pages: **Home**, **Board** (tasks, plus the snapshot, watchers and hooks), **Activity** (usage
over the last 7 days per AI and tool, and the work: the last 5 sessions and the board's done and not
done items), **Code map** (**Build the graph** draws which file depends on which, and the folder map
shows the project's folders and files; it says which engine it recognised, and inside an engine project it
also links the files the engine links: in Godot, scripts and `.tscn`/`.tres` scenes by their `res://` paths
(preload, extends, class, scene); in Unity, scenes, prefabs and materials to the scripts and assets their
`guid:` lines name (uses); an Unreal project is recognised only, since its assets are binary. A click on a
script lists its functions and who calls each when the engine pack's code tools have built `.codegraph/`
(today Godot's `.gd`)), **Costs** (this project's token ledger for Claude Code and Codex), **Projects** (add a
project, install the kit, connect an AI, repair links) and **Settings** (language, light/dark,
updates, where the data lives). The address keeps the page (`#board`), so a reload stays on it and
Back returns to the last one.

The report, the story of the sessions, research, skill packs and the council are read by your AIs
through the MCP tools and by you in a terminal (`plutos report`, `plutos pack`,
`node tools/council.mjs`); the dashboard pages that showed them were removed on 2026-11-14 (owner
decision d-51e97352b22e: keep the dashboard, make it plain). The Code map and Costs pages that went
with them came back on 2026-11-17.

## 2. Installing PLUT_OS itself

Show it as a **local PC app**, not a website. Two ways to run the same program:

| Mode | How | When |
|---|---|---|
| **Portable (normal)** | Unzip `dist/`, double-click `PLUT_OS.exe` / `PLUT_OS` | Everyday use |
| **Terminal (optional)** | Console build, or `node dashboard.mjs` | Logs, `--open`, debug |

The UI is still HTML at `http://localhost:3040` (`127.0.0.1` only). That is a local
window, not a hosted product. Add Project browses **this machine's** folders; the
Coordinator MCP must run next to Cursor / Claude / Gemini. Hosting `dashboard.mjs` on
the public internet would fail the bind/CORS checks or expose disk APIs. A marketing
page that *links* to the download is fine.

### Updating

`UPDATE_PLUT_OS.bat` on Windows, or `node cli.mjs update` anywhere (`lib/update.mjs`):

- A checkout fast-forwards to its upstream branch. Local commits are never moved: a branch that is only
  ahead is reported, a diverged one is refused. Git refuses to overwrite a file you changed, so work in
  progress stops an update and is never lost to one.
- PLUT_OS as another repository's submodule runs the commit that superproject records. An update never
  moves the superproject's branch: it says how far that branch is behind its upstream (pull it there,
  then update again) and how to record a newer PLUT_OS there. It checks this folder out at the recorded
  commit, also after a pull that left the submodule behind. A commit here that no remote branch has
  stops it.
- `npm install` runs when `package.json` or `package-lock.json` changed.
- It lists the files git neither tracks nor ignores. `--clean` moves them to
  `<Hub>/update-leftovers/<time>/` instead of deleting them; `--check` only reports.
- Projects need nothing. Their `.plutos/plutos-launch.mjs` finds this install and hands over to its
  `lib/launch.mjs`, and opening a project replaces an older generated launcher.

Restart PLUT_OS after an update. A packaged build (`dist/`) updates by building again, or by
downloading the new version.

**In the dashboard: Settings → Updates.** Opening Settings shows the last check and when it ran; only
**Check for updates** uses the network. A git checkout compares itself with its upstream branch (`git
fetch`, nothing changes) and, when it is behind, offers **Update now**: the same fast-forward as the bat
and the CLI, refused the same way for local changes or a diverged branch, and refused too when HEAD or
the upstream moved after the check (check again). Then restart PLUT_OS to use the new code (on Windows
`STOP_PLUT_OS.bat`, then `START_PLUT_OS.bat`); the page does not reload by itself. As another
repository's submodule PLUT_OS only reports there; update it with `plutos update` in a terminal. The
portable app compares its version with the newest release on GitHub (pre-releases count, drafts do
not) and offers **Download**, which opens the release page; it cannot replace its own files.
Development mode never updates from the page.

### Installing as an app

The dashboard is an installable web app: in Chrome or Edge, the install icon in the address bar (or
the browser menu's Install option) gives PLUT_OS its own window and icon in the Start menu or the dock.
Firefox and Safari have their own Install option where they have one. The app is
the same local dashboard: PLUT_OS must be running (`START_PLUT_OS.bat`, the portable app, or `node
dashboard.mjs`). When it is not, the window shows "PLUT_OS is not running" with a Retry button instead
of a connection error. That page is the only thing the service worker (`ui/sw.js`) keeps; it never
caches or answers the app's data or files. The portable app keeps working as before; use whichever you
like.

### Portable app (how to ship it)

On a machine with Node 22+ (the **build** machine):

```bash
git clone https://github.com/Zeatrex01/plutos-multi-agent-memory.git
cd plutos-multi-agent-memory
npm install
npm run build:app    # Windows: windowless exe (no console). Logs: stable user-data/logs/
# npm run build      # same app, terminal stays — optional console mode
# npm run build:lite # no exe, about 5 MB: START_PLUT_OS.bat runs it with this machine's Node 22+
```

Or double-click `BUILD_PLUT_OS.bat`: it installs the build tools on the first run, asks which of
the three to build (app without a console, app with one, lite) and runs `build.mjs` in that
terminal window. Copy the whole `dist/` folder; on the PC that
uses it, double-click `PLUT_OS.exe` (Windows) or run `./PLUT_OS` (Linux/macOS).

Unlike `node dashboard.mjs`, the packaged app opens your browser itself once the port is bound,
reopens that window when launched again instead of starting a second copy, writes every launch to
`logs/plutos.log` under the per-user data directory, and with `--windowed` (Windows, `build:app`)
has no console window.

- **It targets the machine that built it.** The binary is a copy of the running Node executable,
  so a Linux build gives a Linux binary; build on Windows for a Windows app (the last line of the
  build names the file it made). On Windows it embeds the PLUT_OS icon from `assets/plutos.ico` and
  checks that the finished executable still has it.
- **It removes Node.js for the dashboard, not for the MCP bridge.** Your AI tool still starts
  `index.mjs` with Node, but its npm dependencies are bundled, so a copied `dist/` needs no
  checkout and no `npm install`.

### Terminal / source (optional)

```bash
git clone https://github.com/Zeatrex01/plutos-multi-agent-memory.git
cd plutos-multi-agent-memory
node dashboard.mjs        # zero extra npm deps until MCP
```

Open `http://localhost:3040`. Same UI, same bind.

- `PLUTOS_PORT=3050 node dashboard.mjs` — run on another port
- `npm install` once if you will run the MCP server (`index.mjs` needs the MCP SDK)
- `npm test` runs every suite listed in `tools/run-all-tests.mjs`

### Development mode (working on PLUT_OS itself)

`DEV_PLUT_OS.bat` on Windows, `npm run dev` elsewhere (or `PLUTOS_MODE=dev` / `--dev`) starts the
checkout in development mode (`lib/run-mode.mjs`):

| | Normal | Development |
|---|---|---|
| Data folder | `%LOCALAPPDATA%\PLUT_OS` (`~/.local/share/plut-os`) | the same with `-dev`; pointing it at the normal folder stops startup |
| Default port | 3040 | 3041 |
| Projects | all of yours | PLUT_OS's own checkout (opened at start) and folders in `<data>/sandbox/` only; anything else is refused, by the dashboard and by `cli.mjs` |
| Marker | — | a banner on every screen, `[DEV]` in the tab title, the startup line |

A built copy refuses development mode, and the DEV launcher never falls back to the EXE: it runs
the source being edited. Because the data folders are separate, starting the development copy no
longer registers it as the current install that every project's MCP launcher follows.

Coordinate the AIs that develop PLUT_OS from your normal, stable PLUT_OS, so a broken change
cannot take down the coordinator an AI is using. When an AI's project is PLUT_OS's source (by
content: `package.json` name `plut-os`), `session_start` adds a line saying so, naming the test
rule, the development launcher and the scope filter.

### This computer only

The dashboard binds `127.0.0.1` and answers the owner at this computer: a request from the
network never reaches it, and one that arrives through a proxy or tunnel on loopback (a
forwarding header gives it away) is refused as well. There is no password, no session and no
device list, so there is nothing to set up and nothing to leak. For access from away, use your
own VPN or SSH port forward to the machine; PLUT_OS bundles and needs none, and a tunnel that
rewrites requests as forwarded is refused by design.

### Removing PLUT_OS and backing up

PLUT_OS keeps two kinds of files. **In a project**, `plutos init` (the Project Kit) writes, each
only if absent: `AGENTS.md` (or `docs/handoff/PLUTOS_PROTOCOL.md` when the project keeps its own),
the pointers `CLAUDE.md`, `GEMINI.md` and `.cursor/rules/plutos.mdc` (`.claude/rules/plutos.md`
when the project keeps its own `CLAUDE.md`), `docs/handoff/` (`BOARD.md`, `AGENT_BOARD.md`,
`ROSTER.md`, `results/`, `PROJECT_INTERVIEW.md` with `--interview`; `CONTINUITY.md` and
`CONTEXT.json` appear on first use, `archive/` when they rotate), `docs/ai/` (the generated
`CODEINDEX.md` and its shards), `.plutos/` (`plutos-launch.mjs`, `local.json`, `plutos.config.json`;
later `drawers.json`, `approvals/`, `research/`, `council/`, `plutos-watcher.cjs`), `PLUT_OS.bat`,
`PLUT_OS.sh` and, in a git repository, the ignore lines under "Git and machine-local files" (§3).
Connecting a client adds that client's config file (§3), and the Hooks panel adds hook entries to
`.claude/settings.local.json`, `.codex/hooks.json` and the git `pre-push` hook (§7). **Per user**,
the data folder (the Hub, §3) holds the registered projects, `install.json`, the MCP heartbeat,
the approval seal key, capture jobs, repair backups and the sidecars of observed projects.

To remove PLUT_OS from a project: keep `docs/handoff/` (the record; it is committed, so git has it
too) and anything you want from `.plutos/research/` and `.plutos/approvals/`, then delete the files
above, the client entry named `plutos` in each client config, and the PLUT_OS hook entries. To
remove PLUT_OS itself: copy the data folder first if you want the sidecars of observed projects or
the repair backups, then delete the data folder and the PLUT_OS folder (`dist/` or the checkout).
Nothing else on the machine is written.

## 3. Bringing a project in: observe → install → connect

These are deliberately separate actions:

| Action | How | Writes into the target project? |
|---|---|---|
| Observe | Projects → Add Project → pick the folder | **No** |
| Install Project Kit | Connect panel → Install PLUT_OS Project Kit | Yes, explicitly |
| Connect one AI | Choose a named client in the Connect panel | Yes, only that client's config |
| CLI installer | `plutos init <project-path>` (`node cli.mjs init …`) — kit, launcher; `--client <id>` also wires that client | Yes — invoking an installer is explicit authorization |
| MCP installer | Your AI calls `init_roadmap` | Yes — this is an explicit setup tool |

### Observe mode: useful without PLUT_OS artifacts

Dashboard Add Project reads the source tree and stores its generated code index, local task
board, optional interview, and coordination state under the stable per-user Hub directory:

```
Windows: %LOCALAPPDATA%\PLUT_OS\workspaces\<path-hash>\
macOS:   ~/Library/Application Support/PLUT_OS/workspaces/<path-hash>/
Linux:   ${XDG_DATA_HOME:-~/.local/share}/plut-os/workspaces/<path-hash>/
```

The selected project receives no `AGENTS.md`, `docs/`, `.plutos/`, `.mcp.json`, editor
settings, launcher, or `.gitignore` change. You can inspect the code/doc map and manage local
tasks in this mode. Removing the workspace unregisters it; it still never deletes project
files.

### Explicit Project Kit

Install the kit only when you want the repo itself to carry shared AI coordination. The
dashboard action never overwrites an existing project file and migrates create-missing local
board/interview data from the Hub sidecar:

```
<project>/
├── AGENTS.md                        ← shared rules, unless the project already owns one
├── PLUT_OS.bat / PLUT_OS.sh         ← project launchers
├── .plutos/                         ← project launcher + machine-local binding
├── docs/ai/                         ← generated CODEINDEX catalog + shards
└── docs/handoff/
    ├── BOARD.md                     ← MAIN board — boss tier
    ├── AGENT_BOARD.md               ← AGENT board — worker tier
    ├── ROSTER.md                    ← registered agents
    ├── CONTINUITY.md                ← bounded session ledger + decisions (created on use)
    ├── CONTEXT.json                 ← claim provenance (created when claims are learned)
    └── results/                     ← reports and analyses
```

A project starts clean. The discipline (reuse before writing, surgical changes, evidence before
claims) rides in the working agreement of every session brief, measured against the skills it
replaced on 2026-10-29. `POST /api/project/install` installs the coordination files only.

The dashboard Project Kit action creates **no MCP client config**.

The CLI and `init_roadmap` are compatibility installer surfaces. They install the same core
kit and no client config: `plutos init --client <id>` wires that one client (the same as
`plutos connect <id>`), `init_roadmap` wires none, and the dashboard's Connect panel chooses
a client as a separate step.

### Connecting an AI is a second opt-in

`.mcp.json` is Claude Code's team-project convention; it is not a universal MCP file. The
Connect panel shows the exact scope and destination before writing anything:

| Route | What it does |
|---|---|
| **Set it up** | Merges the PLUT_OS entry into that named client's JSON, or safely creates/repairs the narrow supported Codex project config |
| **Copy prompt for the AI** | Gives that AI a precise merge instruction; useful when PLUT_OS deliberately refuses to edit a mixed config |
| **Copy config** | Shows the exact JSON/TOML for manual setup |

Current client adapters:

| Tool | File | Scope | Project binding |
|---|---|---|---|
| Claude Code (private) | `~/.claude.json` via Claude's official CLI | local/private to one project | absolute launcher + `PLUTOS_PROJECT_ROOT`; PLUT_OS does not edit this mixed state file |
| Claude Code (team-shared) | `.mcp.json` | project/shared | `${CLAUDE_PROJECT_DIR:-.}` + project launcher |
| Cursor | `.cursor/mcp.json` | project, machine-specific | absolute launcher + `PLUTOS_PROJECT_ROOT` (Cursor does not document a portable workspace token on its current MCP page) |
| VS Code (Copilot) | `.vscode/mcp.json` | project | documented `${workspaceFolder}` token; top-level key is `servers` |
| Gemini CLI | `.gemini/settings.json` | project | explicit `cwd` |
| Google Antigravity | `.agents/mcp_config.json` | workspace | explicit `cwd` |
| Kimi Code (CLI and VS Code extension) | `.kimi-code/mcp.json` | trusted project | explicit `cwd` |
| Codex CLI | `.codex/config.toml` | trusted project | relative launcher + `PLUTOS_CODEX_PROJECT_CONFIG=1` marker |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | machine | absolute |
| Zed | user `settings.json` (`context_servers`) | machine | absolute |
| Claude Desktop (chat) | `claude_desktop_config.json` | machine | absolute + `PLUTOS_PROJECT_ROOT` |

**Why binding matters.** A bare relative argument only works if a client starts the server
from the expected directory. Where a vendor documents a project variable or `cwd`, PLUT_OS
uses it. Otherwise the entry is visibly machine-specific and uses an absolute path. When PLUT_OS
writes a config like that (Cursor, Gemini CLI, Antigravity, Kimi Code), it adds that exact file to the
project's `.gitignore`. If git already tracks the file, PLUT_OS says so and leaves it tracked:
`git rm --cached <file>` untracks it, and also deletes it for teammates when they pull.

PLUT_OS will not broadly rewrite mixed app settings. In particular:

- Claude private/local setup is handed to Claude's official CLI; PLUT_OS does not edit
  `~/.claude.json`.
- A missing Codex project TOML can be created. A legacy PLUT_OS block can receive only the
  missing safety marker. Any other existing TOML is left for the prompt/manual route.
- A global `codex mcp add plutos ...` entry is unsafe because it follows every workspace and
  can remain pinned to another repository. The panel warns; PLUT_OS never deletes it silently.
- Global config folders are not created for software that does not appear installed.

Restart/reload the AI after setup; already-running clients generally do not re-read MCP config.
For Claude project scope, approve the repo-declared server when Claude asks.

Then ask the client to call `plutos_project_info`. It reports the exact bound root without
writing. The launcher derives the project from its own `.plutos/` location, and the MCP
server compares an independent client root when available. A mismatch — including a stale
global Codex registration — blocks project reads and writes instead of guessing.

### Claude Code as a plugin (no per-project wiring)

PLUT_OS is also a Claude Code plugin: its repository is a plugin marketplace named `plutos` holding
one plugin, `plutos` (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`). Installed
once, it gives Claude Code the PLUT_OS MCP server, the default hooks (session brief, session close,
subagent tool map) and PLUT_OS's skills (design-ui-direction, project-scissors) in every project,
and PLUT_OS writes no `.mcp.json` and no hook settings into any of them:

```
/plugin marketplace add Zeatrex01/plutos-multi-agent-memory
/plugin install plutos@plutos                                   (--scope user is the default)
```

Claude Code installs the plugin from the default branch of that repository, so it runs what is on
`main` there, which can be ahead of the last release. Claude Code copies the repository and installs
its npm packages, build tools included (`npm ci`, no way for a plugin to leave devDependencies out):
about 44 MB in its plugin cache, of which esbuild, postject and resedit, which only `npm run build`
uses, are about 17 MB.

- **Only in PLUT_OS projects.** A session opened in a project or any folder inside it (up to its git
  root) is that project's. In any other folder the plugin's server answers by itself with one tool,
  `plutos_project_info`, which says the folder is not a PLUT_OS project, and no instructions; it
  loads none of PLUT_OS and creates no data folder (measured: initialize answered in about 30 ms,
  about 50 MB of memory, against about 150 ms and 78 MB for the full server). Its hooks exit at once
  without output. The always-on cost in such a folder is that one tool (about 60 tokens) and the
  skills' descriptions (about 300 tokens).
- **One server, one brief.** A project wired before the plugin keeps its own entry and its own hooks.
  The plugin's server stands by (no tools, no instructions) only while that entry is one Claude Code
  will run: Claude's local or user scope, or a `.mcp.json` entry you approved in Claude (not declined)
  whose launcher finds a PLUT_OS install. A `.mcp.json` entry still waiting for approval, declined or
  broken leaves the plugin serving the project. Each plugin hook steps aside where the project runs
  PLUT_OS's own copy of it (written either way, `node … --brief` as one string included). A hook you
  switched off (`plutos hooks off brief`) stays off for the plugin too.
- **Handing a project over.** `plutos plugin [path]` says whether the plugin serves the project;
  `plutos plugin --tidy` takes out the project's own default hooks exactly as PLUT_OS wrote them
  (without recording them as off), lists the ones it leaves (one you changed, or one in the
  team-shared `.claude/settings.json`) and prints how to remove the project's own MCP entry. `plutos
  status` shows a `Plugin:` line.
- **No second entry by accident.** While the plugin is on for a project, every Claude Code wiring
  writes nothing and says why: `plutos connect claude-code` (or `claude-code-local`), the Connect
  panel, the recommended-tools entry for PLUT_OS and `plutos rebind`. `plutos connect … --force`, or
  confirming in the Connect panel, writes the entry anyway (for teammates without the plugin).
- **Opt-in hooks stay per project.** The guard, the push gate and the claim check are switched in
  the Hooks panel as before; so is the context capture, which calls the server named `plutos` and so
  needs the project's own entry (the plugin's server is `plugin:plutos:plutos`).
- **PLUT_OS mini is an alternative, not a companion.** The mini pack (`plutos-mini`, no server) also
  brings project-scissors; with both installed, Claude lists that skill twice. Use one of the two.
- **Updates** come with a new PLUT_OS version (`/plugin marketplace update plutos`). The plugin runs
  from Claude Code's own copy and reads the same data folder as your projects' launchers
  (`PLUTOS_HOME`, then the project's `.plutos/local.json`, then the default); your PLUT_OS install
  and its dashboard are unchanged.

Codex, Cursor, VS Code, Gemini CLI, Antigravity, Kimi Code, Windsurf, Zed and Claude Desktop are
connected per project as below; nothing about them changes.

### Per client: how each one is connected

`plutos connect <id>` and `plutos init --client <id>` write the same entry the Connect panel does
(`lib/connect.mjs`). What each of the six main tools gets:

- **Claude Code** — `claude-code-local` hands the entry to `claude mcp add` (private to this
  project, stored by Claude in `~/.claude.json`, which PLUT_OS never edits); `claude-code` writes the
  repository's `.mcp.json` with `${CLAUDE_PROJECT_DIR:-.}/.plutos/plutos-launch.mjs`, so teammates
  get the server too. The kit's `CLAUDE.md` imports `AGENTS.md`. Wiring Claude Code (`plutos connect
  claude-code`, `plutos connect claude-code-local`, or the Connect panel's write button) switches the session brief
  and the session close on, once per project; after that the hooks are yours to switch. The Board
  page's Hooks panel adds or removes the session brief, the guard, the push gate, the claim check and
  the session close in `.claude/settings.local.json` (§7, "Hooks").
- **Codex** — `codex` writes `.codex/config.toml` for this trusted project (a relative launcher and
  the `PLUTOS_CODEX_PROJECT_CONFIG=1` marker); a missing file is created, an existing one is left for
  the prompt or manual route. It has no start hook, so it calls `session_start` first (`AGENTS.md`);
  the claim check runs from `.codex/hooks.json` (`node lib/claim-check.mjs install --codex`).
- **Cursor** — `cursor` writes `.cursor/mcp.json` with an absolute launcher and
  `PLUTOS_PROJECT_ROOT`, gitignored; the kit's `.cursor/rules/plutos.mdc` points Cursor at the rules.
  Approve the server with `cursor-agent mcp enable plutos` or reload the window.
- **Gemini CLI** — `gemini-cli` writes `.gemini/settings.json` with an explicit `cwd`, gitignored;
  the kit's `GEMINI.md` imports `AGENTS.md`.
- **Antigravity** — `antigravity` writes `.agents/mcp_config.json` with an explicit `cwd`,
  gitignored. No hook is written for it (its format is not verified, §7, "Board watchers").
- **Kimi Code** — `kimi-code` (or `plutos connect kimi`) writes `.kimi-code/mcp.json` with an
  explicit `cwd`, gitignored. Moonshot AI's `kimi` CLI and its VS Code extension "Kimi Code" read
  the same project file, and load it only after you trust the folder (headless runs:
  `KIMI_CODE_TRUST_WORKSPACE=1`); `/mcp` shows the connection. It reads `AGENTS.md` itself and calls
  `session_start` first. Its hooks live only in the user's `~/.kimi-code/config.toml`, which
  PLUT_OS does not write. The archived Python "Kimi CLI" (`~/.kimi/`) is not supported: `kimi
  migrate` moves its MCP servers to Kimi Code (`docs/research/2026-11-17-kimi-clients.md`).

VS Code (Copilot), Windsurf, Zed and Claude Desktop are in the table above; the push gate's git
`pre-push` half (§7) meets a push from any of them.

### The `mcp` light in the system bar

| Light | Meaning |
|---|---|
| green `mcp` | an AI is connected now |
| grey `mcp idle` | configured and healthy; no AI currently has it open |
| red `mcp not connected` | no client is configured for this project |
| red `mcp needs npm install` | a source checkout is missing the MCP SDK; portable builds bundle it |

If tools are absent after a reload, first check `plutos_project_info`. In a source checkout,
verify `npm install`; after moving a portable build, launch PLUT_OS once so stable
`install.json` records its new location.

### Git and machine-local files

The team-shared Claude `.mcp.json` entry is portable: it uses
`${CLAUDE_PROJECT_DIR:-.}/.plutos/plutos-launch.mjs`. The machine-specific PLUT_OS binding is
in `.plutos/local.json`. Project Kit installation adds these ignore entries only when the
target is already a git repository:

```
.plutos/local.json
.plutos/plutos.config.json
docs/handoff/*.lock/
docs/handoff/*.tmp
```

The kit's list goes on (generated indexes, the memory index, the runtime state below); Repair adds
any line a project lacks. What under `.plutos/` is committed follows one rule: a file is **shared**
when another clone, machine or cloud session needs it to act the same way and nothing in it is bound
to this machine; it is **per machine** when it holds this machine's paths, keys or process ids, or
is a mirror or cache rebuilt from tracked files. Shared, so commit them: `plutos-launch.mjs`,
`drawers.json`, `packs.json`, `checks.json`, `claims-baseline.json`, `.plutos/research/` (but not its page
cache, `.plutos/research/_cache/`). Per machine, so git-ignored: `local.json`, `plutos.config.json`,
`memory.db`, `plutos-watcher.cjs`, `approvals/` (tickets sealed with this machine's key, dead in 30
minutes), `council/` (rooms run by this machine's CLI seats; the ruling is recorded with
`session_end`), `state.json` and `logs/` (the dashboard's mirror of `CONTINUITY.md`, rewritten on
every session), and `usage.jsonl` with its rotated `usage.1.jsonl` (the usage log, §7). `lib/kit-history.mjs` (`PLUTOS_STATE`) keeps the list and each reason; `plutos audit`
reports a shared file git does not hold.

If you explicitly enable **Automatic shared context (Claude Code)**, PLUT_OS also adds
`.claude/settings.local.json` to `.gitignore`. The Project Kit alone does not create that
private hook setting. A board watcher adds `.claude/settings.local.json` and
`.plutos/plutos-watcher.cjs`, and setting up Cursor, Gemini CLI or Antigravity adds that client's
config file: each names paths on this machine. A file git already tracks is reported, not untracked.

Observe mode never edits `.gitignore`. If a kitted plain folder later becomes a git repo, the
explicit **Repair selected project** action can add the entries: Settings previews the exact
project and files, and **Back up and apply** saves their prior contents first. Reopen the dialog
to find saved versions, or restore right after the repair; a stale preview must be refreshed, and
restore refuses to overwrite later edits. Backups stay in the private PLUT_OS data directory.
The same repair brings a project kitted by an older PLUT_OS up to date: an unedited `AGENTS.md`
from an older kit, and a `CLAUDE.md` or `GEMINI.md` that is the old "read AGENTS.md first"
pointer, are replaced; a file you edited is never in the preview. Dashboard startup never sweeps
or rewrites registered projects. Client configs with absolute paths (notably Cursor and
Antigravity) are machine-specific even though they live under the project folder.

### Third-party MCPs remain requests

PLUT_OS's own Coordinator already supplies the shared session/context layer and generated
Code map. Codebase Memory and Context Mode remain optional extensions, listed on the
Projects page's Connect panel under "Extra tools your AI can set up"; they become idempotent board
tasks only after the owner explicitly requests one, telling the AI to ask for global vs project
scope. Nothing third-party is installed silently.

### Skills and packs

An Agent Skill is a folder with a `SKILL.md` that tells an AI tool how to do one kind of task. Your
AI tools read them from two folders in the project: `.claude/skills` (Claude Code) and
`.agents/skills` (Codex and Gemini CLI). `plutos skills [path]` lists every skill folder it
finds there, which tools read it, whether the project or a pack put it there, and the pack's own
measurement line for it (or "not measured"; PLUT_OS makes no score up). To add a skill of your own,
put it at `.agents/skills/<name>/SKILL.md` (and the same folder under `.claude/skills` for Claude
Code). (The dashboard's Skills page that showed the same list was removed on 2026-11-14.)

A pack is a folder on this computer that brings several skills: `skills/<name>/SKILL.md` folders and
a `skills.json` (or `module.json`) with its id and name. Register it once with `plutos pack add <folder>`; nothing is copied yet. **On** (`plutos pack on <id>
[path]`) copies each skill folder into both `.claude/skills` and `.agents/skills` of the open project,
creating what is absent and refusing the whole switch if a folder of that name is already there from
somewhere else. **Off** removes only the files the pack placed and that you have not changed; an
edited or added file stays, and the message names it. The copied folders are ordinary project files:
they show as untracked in git until you commit or ignore them. `plutos pack list` and `plutos pack
forget <id>` manage the registry; forgetting a pack leaves what it placed until you switch it off.

PLUT_OS ships two packs of its own, registered by name without a path: `plutos pack add
codebase-memory` and `plutos pack add context-mode`, then `plutos pack on <id>`. Each adds one
upstream MCP server to the project's `.mcp.json` (run with npx; Claude Code asks once before it
starts it) and one short skill saying when to use it: Codebase Memory
(https://github.com/DeusData/codebase-memory-mcp) for function-level callers and the impact of a
change across many files, when `plutos_code_lookup` is not enough; Context Mode
(https://github.com/mksglu/context-mode) to keep large command outputs out of the AI's context. Context
Mode may also shorten other tools' replies, so its skill tells the AI to read the PLUT_OS brief in
parts. PLUT_OS copies no code of either project; their own licences apply.

Claude Code also loads skills from its plugins and from your own folders (`~/.claude/skills`,
`~/.agents/skills`, and the skills and plugins your claude.ai account syncs), so the same skill can
be on the machine twice. `plutos skills inventory [path] [--json]` lists every skill a client would
load, from PLUT_OS's own skills, the registered packs, the project, your user folders and Claude Code
plugins (installed and synced), each with its source, hashes, version and gates. It groups copies that
share a name and says which kind each group is: **identical**, **different versions** (naming the
copy that matches PLUT_OS's or a pack's current files and which differ; the newest by file time is
shown only as a weak hint) or **name clash** (different skills that share a name; the client may load
either). It also lists the same `SKILL.md` under two names, every skill no one has measured (PLUT_OS
shows a pack's own measured line and judges nothing else), and one line to act on per finding. It
only reads; exit 0.

To keep a copy of one of PLUT_OS's or a pack's skills somewhere else and know when it falls behind,
`plutos skills export <name> <dest-folder>` copies it to `<dest-folder>/<name>/` with a
`.plutos-source.json` record (where it came from, its hash, when). The inventory then marks that copy
**current**, **stale** (the source changed since), **locally edited** or **source gone**. Export
again with `--force` to refresh a copy you have not edited; one you have edited is refused, with the
files named, unless you add `--force-local` (your edited files are first kept in the data folder
under `skill-exports/replaced/`). Name a pack's skill as `<pack-id>:<name>` when two sources share it.

### Any project, any stack

Observe mode is zero-write for every stack. Project Kit installation is additive and uses
PLUT_OS-owned namespaces. A project with its own `AGENTS.md` keeps it byte-identical and gets
a compact `docs/handoff/PLUTOS_PROTOCOL.md` beside the boards; the kit's `CLAUDE.md` and `GEMINI.md`
import both, so Claude Code and Gemini CLI load the project's own rules as well as the protocol. Unknown stacks use the generic scanner. Launchers are emitted for Windows and
POSIX.

### If you move the PLUT_OS folder

Every dashboard launch writes its current application folder to stable per-user
`install.json`. New project launchers read that pointer first, so moving/replacing the
portable folder requires only launching PLUT_OS once and does not rewrite any project.
`.plutos/local.json` remains a legacy/custom-home fallback. Settings → **Repair selected
project** upgrades one older launcher explicitly; no other registered project is touched.

### Auditing an older project

A project set up with an earlier PLUT_OS keeps what that version wrote: a `SYSTEM.md` from the system
roles, a `.plutos/profile.json`, role boards in `docs/boards/`, skills the old library copied, a roadmap
page. Removing a feature removed the code, not those files. `node cli.mjs audit <project>` finds them and
everything else an old project needs looked at. It reads and changes nothing.

What it reads: the leftover catalogue (`lib/kit-history.mjs`, every path a past kit wrote that today's
does not, with the day it stopped and why); today's kit files (missing, an older copy the kit wrote and
nobody edited, or edited by you); the records `plutos check` reads, without its baseline, so debt an old
baseline accepted shows too; documents whose named files changed after the document's last commit; the
memory check, including an old CONTINUITY digest; and the setup (map, code index, launcher wiring,
connected clients).

The verdict comes first. **clean**: nothing high or medium. **mixed**: a current kit with leftovers or
findings beside it. **old**: no current kit, an `AGENTS.md` that is a past kit version, or more leftovers
and older copies than current kit files.

What fixes what, as the report's last part says: **Repair** (Projects → Repair) refreshes older kit
copies and the launcher wiring, with a preview and a backup. **`plutos audit --clean`**, in a terminal
you are at, moves the leftovers nobody edited into the Hub's `audit-leftovers/<project>/<time>/`,
keeping their paths, and prints how to copy them back; it deletes nothing, and refuses while git shows
an uncommitted change to one of them. A leftover nothing proves unedited (a skill folder, a shared
script) is yours to keep or move. **Ask an AI** lists one prompt per document whose prose must be
checked against the code. The rest is yours, each with the command that does it. `--json` gives the
whole report.

## 4. The recommendation engine

`lib/recommend.mjs` scans the project's actual files, read-only: stack (node/unity/python),
frameworks found in `package.json` (react, next, express, ...), whether tests exist, whether it's a
monorepo, whether it's a git repo. This needs **zero interview and zero AI**. That scan combines
with any interview answers into one **Recommendation**: whether board coordination matters (a team,
several AIs or a `package.json` workspaces monorepo) and why, with a note when a game engine is
recognised. Native shared context and code indexing are already present, so it creates no
third-party MCP tasks; optional MCP extensions remain selective actions on the Projects page's
Connect panel ("Extra tools your AI can set up"). The interview file's own Recommendation section
shows it. (The Setup questions page and `GET /api/recommendations` were removed on 2026-11-14.)

## 5. The Setup interview (project profile)

**The interview is optional.** Existing/already-configured projects skip it entirely — no file,
no questions (AGENTS.md Rule 0 only fires when the file exists). Choose it at Add Project
("Start with Setup interview") or via `node cli.mjs <path> --interview`.

`docs/handoff/PROJECT_INTERVIEW.md` holds 5 quick questions (project type, stage, goal,
main AI, team size). AGENTS.md Rule 0 tells every AI: if answers are blank, ask the user, write
the answers into the file, commit. (The dashboard's Setup questions page was removed on 2026-11-14.)

Once complete, the file's Recommendation section shows the
same recommendation as §4. Recommendations are suggestions — installation is always your click.

## 6. The command line (`plutos`)

`node cli.mjs <command> [path]` (or `plutos …` when it is on your PATH; `[path]` defaults to the
current folder). The commands, as `plutos help` lists them:

- `init [path] [--interview] [--client <id>]` installs the kit and the launcher and prints the
  files it wrote; `--client` also wires that AI tool (§3). `connect <client-id> [path]` writes one
  client's MCP config; with no id it lists the clients.
- `status` shows the readiness stage, the board, pending questions and connected clients in one
  screen; `approvals` lists the questions; `approve <ticket>` and `reject <ticket>` answer them
  without opening the dashboard. Both need an interactive terminal, the one you are sitting at: run
  from a script or by an AI with a shell they exit 1 with "needs an interactive terminal" and change
  nothing, so an AI cannot approve its own ticket (O14, 2026-11-04). The other way to answer is the
  dashboard's question card, your own browser action, which is unchanged. A question asked before
  2026-11-04 with a casting proposal still verifies and can be answered; approving it applies nothing.
- `check`, `report`, `changelog`, `idea`, `update` and `wait` are described where they belong:
  `check` below, `report` under "The Status Report" (§7), `changelog` and `idea` add one line to
  `CHANGELOG.md` or `IDEAS.md` without the file being read, `update` under "Updating" (§2) and
  `wait` under "Board watchers" (§7).
- `check --memory` and `memory list|find|open|verify|supersede|retire` are the memory report and the memory
  verbs, under "Memory: decisions and claims" and "Memory: find and the index" (§7).
- `check --accept` raises the claims baseline, which silences findings, so like `approve` it needs your
  interactive terminal: from a script or an AI it exits 1 and accepts nothing.
- `decide` (and the `plutos_decide` and `session_end` tools) first turn any legacy DECISION digest line
  without an id into a decision record, only when one is found, and say how many.
- `rebind <new path> [--from <old path>] [--dry-run]`: after a project folder moved, rewires each AI client
  whose config names the old absolute path, moves the hub entry and copies the shared `.plutos/` state the
  new folder lacks; for a client PLUT_OS does not write it prints the exact manual step. `--dry-run` lists
  the plan and writes nothing. `plutos_project_info` names this command in its fix when the open folder
  carries the kit (`lib/rebind.mjs`).
- `usage [path] [--days N] [--json]` reads the project's usage log (below, "Usage log — which AIs used
  which tools"): which AIs called which PLUT_OS tools and hooks, sessions started and ended, tools never
  called, sub-agent starts against tool calls, and days with commits but no session record. It only reads.
- `audit [path] [--json] [--clean]` reports what older PLUT_OS versions left in a project and what else
  needs a look, and `--clean` moves the leftovers into the Hub (§3, "Auditing an older project").
- `plugin [path] [--tidy]` says whether PLUT_OS's Claude Code plugin serves the project, and `--tidy` takes
  the project's own default hooks out where it does (§3, "Claude Code as a plugin").
- `skills [path]` lists the project's Agent Skills; `pack add <folder>`, `pack list`, `pack on <id>
  [path]`, `pack off <id> [path]` and `pack forget <id>` manage packs; `skills inventory [path]
  [--json]` lists every skill on the machine with its duplicates and exports, and `skills export
  <name> <dest-folder> [--force] [--force-local]` makes a tracked copy (§3, "Skills and packs").

`plutos check` reads the project's current documents, its board and its session record, and lists
what they claim that the repository does not show: a path that is not there, a `file:line` past
the end of its file, an `npm run` script that does not exist, and anything that would leak if the
repository were published (personal information, secrets, source maps). It uses no AI. The first
`plutos check --accept` records what it finds as the baseline; after that only a new finding makes
it exit 1, and `--all` lists the accepted ones as well. A cited report or archive under `docs/handoff/`
must exist like any other path; only the kit's optional files (`PROJECT_INTERVIEW.md`,
`PLUTOS_PROTOCOL.md`), the two a project gains at its first `session_end` (`CONTINUITY.md`,
`CONTEXT.json`) and the dated archive names are left alone.

In a PLUT_OS checkout `plutos check` is also the critique gate: a commit that changed a contract (an
MCP tool's name, description or schema, an HTTP route, a route or tool policy entry, an approval tier)
is reported as `contract-unreviewed` with its file and short sha until the session record names a
critique seat for it. What to do: run a critique seat (a read-only reviewer with the contract diff)
and say so with its count in `session_end`'s `did` ("A critique seat found 3 items") in the session
that makes the commit, or, for a commit already made, in a later `did` that names the seat, its count
and the commit's sha. An uncommitted contract change is only a note ("would be reported at the next
commit"); the finding comes with the commit, and `--accept` mutes that one commit, never the route or
the tool. The gate checks that a record exists, not that the review was good: a change committed and
recorded with a critique mention in the same session passes.

## 6a. Research studio

Use it when you need to learn something well enough to make with it — "what defines Swiss
style, so I can design our landing page in it".

1. **Ask your AI**, e.g. *"Research Swiss-style layout with the research tools, then brief
   me."* It calls `research_topic` (start) with a question, a goal and budgets (default
   30 pages, depth 3).
2. **It branches.** The question is split into 3-6 sub-questions (`research_branch`); a
   branch can have sub-branches up to the depth budget.
3. **It reads.** `research_fetch` pulls a public page into the topic and freezes its text;
   `research_read` pages through it. A page that builds itself with scripts (a Steam review
   listing, for one) comes back nearly empty; fetch it again with `render: true` to run it in
   headless Chromium first (needs `pip install playwright` and `playwright install chromium`).
   JSON answers from public APIs are read as text. `research_images` saves a page's images
   into the topic (for a Steam game, its store data URL gives the capsule and every screenshot),
   so the AI can look at them.
4. **It records.** `research_note` adds findings (citing fetched sources, with verbatim
   quotes), principles (do / avoid / note, resting on findings) and open questions.
5. **It closes branches** — answered only with a finding under it; a dead end needs a reason.
6. **Brief.** `research_topic` (brief) compiles the learning brief from the records and saves
   it to `.plutos/research/<topic>/brief.md`, the file to hand on.

What PLUT_OS refuses, whatever the AI says: a finding with no fetched source, a quote that is
not on the page, a principle with no finding under it, going past the page or depth budget.
`research_topic` lists what is still open (unanswered branches, uncited sources,
single-source claims) until the topic is ready. (The dashboard's Research page was removed on 2026-11-14.)

The same tools run without PLUT_OS as a standalone MCP server: `node tools/make-research-mcp.mjs <folder> --zip`
builds it from a terminal (the dashboard's Export MCP button left on 2026-11-04), and its README says how to
connect it to any client. In that package, `node cli.mjs <url>` prints one line and exits 1 when a fetch is refused.

**Web fetching** needs Python 3.10+ and `pip install "scrapling[fetchers]" markdownify`;
without it the tools still record and audit, and the page says what is missing. Pages are read
with an honest user agent, robots.txt is respected, and anything resolving to this machine or
the home network is refused, for a page rendered with `render: true` as well.

## 7. The council: how AIs and subagents coordinate

Model: **you are the boss.** Each main AI (Claude, Gemini, …) manages ONLY its own
subagents. PLUT_OS makes everyone visible to everyone — it never dispatches anyone.

- **BOARD.md (boss tier)** — you and main AIs. Assign work as `TODO` with an **Assignee**
  (a role or agent). Agents claim (`IN_PROGRESS`) and finish (`DONE` + result reference).
  Keep it short: tasks, status, result pointers.
- **AGENT_BOARD.md (worker tier)** — subagents post findings, intermediate notes, and
  cross-agent `❓ NOTE:` discussion here, keeping the main board clean.
- **results/** — actual documents agents produce. Boards carry the document's *path*,
  never its content; other agents follow the reference to get informed.
- **ROSTER.md** — whenever an AI spawns a subagent it registers it (name, owner, role,
  memory path). So Claude knows Gemini has a `research-scout`, and can leave a board
  suggestion "this is research-scout work" — Gemini reads it and dispatches its own agent.

### These files are yours to hand-edit

An update touches the entry it was asked to touch, and nothing else:

- **Whatever you write inside an entry stays.** Sub-checklists, a link to a results
  document, a paragraph of reasoning — an AI marking the task `DONE` keeps all of it, and
  puts its own fields above your prose rather than replacing it.
- **Your line endings survive.** A CRLF file stays CRLF. A status change is a two-line diff,
  not "every line modified".
- **No duplicate entries from a stray space.** Titles and agent names are matched trimmed, so
  `"Fix login "` updates `Fix login` instead of creating a second, identical-looking block.
- **The `(no active tasks)` placeholder disappears** once there is a task, rather than sitting
  under a list of them telling every reader the board is empty.

The one thing that is deliberately rewritten is the field values themselves: newlines inside
them get flattened to a single line, because a newline in a task title could otherwise forge a
whole entry attributed to another agent.
- **Memory ritual** — agents are ephemeral, memory is durable: each agent keeps
  `.agents/<name>/MEMORY.md` (distilled lessons, never transcripts), reads it on spawn,
  updates it before finishing.

The dashboard's **Board page** renders all three (main board, agent board, roster) as one
council view: four status lanes (To do / In progress / Done / Blocked), each with a caption
saying what the status means and an open-question count; cards fold their detail until
clicked and stay open across a refresh; a title prefixed `P1 -`/`P2 -`/... shows as a
priority badge and sorts to the top of its column. A repaint from the auto-refresh timer
never drops the card you had open, a column's scroll position, or half-typed input in the
assign form.

### Questions waiting and recorded verification

Home opens on **Waiting for you**: every `plutos_ask` question an agent is blocked on, with
its options, any images it attached, a reject button and an optional note back to the agent.
The Home item in the sidebar carries the count on every page. Below it, a short status list
names the project, the open board items (to do, in progress and blocked, counted in full), the
last session's Next, how many hooks are on, and whether an AI is connected.

Expand a Board card to record **unverified**, **passed** or **failed**, independently of
its workflow status. Passed requires an evidence URL or project-relative artifact path.
The badge says **Result check** (shown on finished cards, and on any card once a check is recorded): PLUT_OS stores the declaration and reference,
not a judgment that the evidence is true. Local text previews are limited to 256 KiB;
PNG/JPEG/WebP and PDF previews to 8 MiB. Hidden files and paths leaving the project are
refused. Reopening or changing a completed task invalidates an old pass unless evidence
is explicitly reasserted. A form opened on an older revision must be refreshed.

MCP `board_update` accepts `verification`, `evidence` and optional `expectedRevision`;
`board_read` supplies the current revision. Older clients can continue writing task status.

### Board watchers — keeping a seat working without opening it yourself

A watcher stops a connected AI from ending its turn while the board still has a task
assigned to it, so you do not have to notice a seat went idle and re-prompt it yourself.
It does **not** start anything — PLUT_OS still schedules nothing — it only keeps a seat that
is already running from stopping early.

Set it up from the Board page's **Board watchers** panel: tick the seats, press once.

- **Claude Code** — PLUT_OS writes the hook itself into `.claude/settings.local.json`, merged
  narrowly so unrelated hooks survive, and gitignored with its script so the machine-local paths
  never reach the repo. On `Stop`, the generated Node script asks `GET /api/board?project=...` for
  its installed project and checks the project identity that comes back; if a `TODO` is assigned
  to that seat it exits 2 with the task text, which the CLI feeds back as the next instruction.
  Every failure (recursion, an unreachable dashboard, malformed input) exits 0, so a watcher can
  never hold a session hostage.
- **Every other tool** (Antigravity, Codex, Cursor, Gemini CLI) — PLUT_OS does not write their
  hooks yet. Codex now documents a Stop hook in the same shape; the other formats are not
  verified, and PLUT_OS will not guess one into somebody's config. Ticking one of these writes a
  single board task naming the seats and pointing your main AI at the working Claude Code
  script (`.plutos/plutos-watcher.cjs`) as a reference to port.

Existing installations with an old script or hook show **Update watcher** in this panel.
Apply that update and restart the AI session so it loads the current hook. The command uses
`node` with a separate script argument, including when the project path contains spaces.

A watcher keeps a **working** seat working; it does not wake an **idle** one. Stop fires
when a turn ends, so an idle seat needs a loop in your own terminal, and `plutos wait` is what
that loop waits on. It reads the board file (no dashboard needed) until a `TODO` is assigned to
the seat, prints the same instruction the watcher gives, and exits 0; with `--timeout S` it exits
3 when nothing came. Waiting runs no model, so an idle seat costs no tokens. Use the seat name
the board's Assignee line writes (case does not matter). One terminal per AI, in the project:

```powershell
# Windows (PowerShell); node <PLUT_OS folder>\cli.mjs wait … works where plutos is not on PATH
while ($true) { $task = plutos wait --seat Codex; if ($LASTEXITCODE -eq 0) { codex exec $task } }
```

```bash
# macOS / Linux
while task=$(plutos wait --seat Gemini); do gemini -p "$task"; done
```

`claude -p "$task"` works the same way for a Claude seat. The AI claims the task
(`IN_PROGRESS`), so the next `wait` does not hand it out again, and the watcher hook keeps it on
any further work. The loop is yours to start and stop; PLUT_OS stays a coordination plane rather
than a scheduler.

### Hooks — checks that run without anyone remembering them

The Board page's **Hooks** panel switches five hooks per project, written into Claude Code's
`.claude/settings.local.json` on this machine (gitignored) and taking effect in the next session; it also
shows whether Codex runs the claim check from `.codex/hooks.json` (`node lib/claim-check.mjs install --codex`
writes it; Codex runs it once you trust it in `/hooks`). Wiring Claude Code to a project switches the
session brief, the session close and the subagent tool map on the first time (none sends a turn back or
blocks a command); `.plutos/local.json` records which ones it switched on (`hooksDefaulted`, a list of hook ids)
and any hook you switch off in the panel (`hooksOff`), so wiring again never switches one back on. A project
wired before the subagent hook existed gets that one hook once, at its next Claude Code session start
(the session brief hook) or `plutos update`; a hook you switched off stays off:

- **Session brief** (`SessionStart`) hands the brief to Claude as a session opens and after
  `/clear` or a compaction. The brief is paged: part 1 (at most about 3,500 characters, the same for
  the hook and `session_start`) carries a summary of the working agreement, what the project is, its
  readiness and scope, where the last session left off, new results files, settled decisions, open board items and the tool map; its last line names
  `session_start` with `{"part": 2}` for the full agreement and the rest. A side session that must not
  write anything calls `session_start` with `{"readOnly": true}`: nothing is written, and it leaves its
  findings in one `docs/handoff/results/YYYY-MM-DD-<topic>.md` file or in its final answer.
- **Subagent tool map** (`SubagentStart`, every agent type, Explore and Plan included) gives each
  subagent a short map of PLUT_OS's look-up tools (`plutos_context_for_task`, `plutos_code_lookup`, the
  research drawer) and one line per MCP server an active pack brings, since subagents load neither
  CLAUDE.md nor AGENTS.md. No model call; it prints nothing outside a PLUT_OS project. Switch it with
  `plutos hooks on|off subagent`.
- **Safety guard** (`PreToolUse`) refuses force pushes, `git reset --hard`, `git clean -f`,
  discarding the whole tree's changes, a recursive delete without a literal absolute path and a
  AI co-author trailer or AI session link in a commit message.
- **Push gate** (`PreToolUse`) refuses a `git push` of a tree the tests did not pass on. Only a
  test run through PLUT_OS's recorder records a pass:
  `node "<PLUT_OS folder>/lib/push-gate.mjs" run <test command>`. PLUT_OS's own `npm test` runs
  that way; in another project a plain `npm test` records nothing unless its test script does the
  same. Until a pass is recorded, every push of the project is refused: the panel says so, and the
  refusal names the exact command for this install. A project makes the gate hold its own checks
  too by declaring them in `.plutos/checks.json`, tracked in git (see **Declared checks** below);
  chaining them into the recorded command, quoted as one, also works:
  `node "<PLUT_OS folder>/lib/push-gate.mjs" run "npm test && python tools/arch_lint.py"`
  records a pass only when every part exits 0 (put the same line in the project's test script and
  a plain `npm test` does it).
- **Claim check** (`Stop`) holds Claude's final message against git and the disk: tests said to
  have passed on an older version than the work, a push that did not happen, a file named as
  created that does not exist, a focused or skipped test, assertions removed while the tests are
  said to pass, a fix that edits a test file with the code without saying what the test change
  is, tests said to pass with no passing stamp for this tree while the transcript shows no test
  command run (or the last one failed), work called done that no session record holds, and, in a
  project that declares checks, work called done or fixed while the last pass was on another tree
  or a declared check failed (it reads the push gate's record and runs no check). A false
  claim is sent back once
  with the reason; if the next stop keeps it, the
  stop goes through and the claim is recorded as failing, which the next briefs show for a week.
  It takes under a tenth of a second and no model tokens. Codex reads the same input, so
  `lib/claim-check.mjs` also serves as its Stop hook (`node lib/claim-check.mjs install --codex`).
- **Session close** (`SessionEnd`) records a session that ends without `session_end` from git: its
  commits and the files it left changed, with a note that nothing it learned or decided was
  recorded at the end. A decision the owner stated survives this only when it was recorded on the spot
  (`plutos_decide`, or `plutos decide "<text>"`; working agreement rule 9). No model call; when the shared-context capture on the Projects page's Connect panel is on, its fuller
  record is left to do it.

Each also has a command line: `node lib/push-gate.mjs install`, `node lib/claim-check.mjs install`.

**Declared checks.** A project names the checks that count as part of "done" in
`.plutos/checks.json`, a list the core runs without knowing what it measures:

```json
[{ "name": "arch-lint", "command": "python tools/arch_lint.py",
   "meaning": "a call by name in a string, or an untyped reference, was added" }]
```

The push gate's `run` runs the test command, then every check in order (each to the end, so one run
names every failure), and records a pass only when all of them exit 0. A failing check is named with
its `meaning` as it runs and again in the push refusal. A file that does not read as a list of
`{ name, command, meaning }` records no pass, so a check never stops running unnoticed. Each run's
results are kept in the git directory beside the pass stamp, never committed. With the claim check
on, "done" or "fixed" in such a project is sent back when the tests and checks have not passed on
the work as it stands, or a declared check failed on it; the Stop hook has 15 seconds, so it reads
that record and runs nothing. The file is shared project state: commit it, so every clone and every
AI holds the same checks. Its commands are code that runs with your rights, like `package.json`
scripts: a cloned repository's or a pulled commit's checks run on the next `run`. When the file is
new or changed since the last run, the run, the push refusal and the claim check print each check's
command, so read them before running the tests through the gate.

The push gate also goes in as a git `pre-push` hook (switching it on in the Hooks panel does both,
or `node lib/push-gate.mjs git-install`), so a push from Codex, Gemini CLI, Cursor or a terminal
meets the same check. `git push --no-verify` skips it, and a project's own `pre-push` hook is never
replaced.

A project that keeps its own `CLAUDE.md` gets no pointer file; the project kit puts the board
protocol in `.claude/rules/plutos.md` instead, which Claude Code loads in every session, and leaves
that `CLAUDE.md` as it is.

### Project snapshot — handing state to another AI, anywhere

For when you stopped mid-task, could not commit, or tried something experimental, and want a
different AI, maybe on another machine with no checkout of this repo, to pick it up. The session
brief *points* at files (`AGENTS.md`, board, code map), which only helps a reader with a current
checkout; a snapshot *carries* them.

Get one from the Board page's **Copy** button, `GET /api/snapshot` (downloads as markdown),
or ask an AI to call the `project_snapshot` MCP tool. It contains:

- The **uncommitted diff** (`git diff HEAD`) and untracked files — the exact thing a `git
  pull` cannot hand anyone, and the reason to take a snapshot in the first place.
- The branch, commit, and how far ahead of its upstream it is.
- The same brief `session_start` would return (decisions, claims, where things stand).
- The board, agent board, roster, continuity ledger and shared claims, **inlined in full**
  rather than named — a reader with no repo still has them.

Every section caps independently and says so when it truncates, so a capped snapshot never
reads as a complete one. It opens by saying plainly that it is **state, not instructions**,
and that where it disagrees with whatever repo the reader has open, the snapshot is newer.

### Session memory — how a new session starts informed

PLUT_OS cannot manage a model's context window (it isn't in the inference loop). What it can
do is decide **what a session reads** — and that is the whole lever. Two MCP tools bookend
every session:

- **`session_start`** returns one briefing, assembled per call from **git and the live working
  set**: what this project is (from `docs/ai/PROJECT_MAP.md`), the **decisions** earlier
  sessions recorded, where the last session left off, the **files git landed since** that
  session's recorded HEAD (generated indexes left out), board items assigned to you, and a
  result report **only if a live task names it**. It rechecks shared learned claims against
  their captured sources on every call. **The code map is inlined, not pointed at:** every
  `docs/ai/codeindex/*.md` shard goes in whole when the map fits a 12 KB budget (a few KB for
  most projects), because a session can read "go open the shard" and still not do it; above
  the cap, the brief names the shard paths. The brief also flags a roster participant who
  **arrived and never recorded a session ending** (past a 6-hour grace window), and says
  plainly when automatic Claude capture is off for the project, naming `session_end` instead.
- **`session_end`** records the session (did / next) into
  `docs/handoff/CONTINUITY.md`. Only the explicit `decided` field enters the settled decision
  digest. `learned` claims go to `docs/handoff/CONTEXT.json`, separate from case law. Do not
  paste a file list into `changed`; git already has it. DONE board entries past budget are
  archived mechanically.

`learned` accepts a plain string for compatibility, but that string is always shown as
**unverified**. Prefer an evidence-bearing claim when the fact is durable:

```json
{
  "claim": "Uploads are capped at 20 MB.",
  "sources": [
    { "path": "src/limits.js", "evidence": "MAX_UPLOAD_MB = 20" }
  ]
}
```

PLUT_OS verifies that the path stays inside the bound project, the exact excerpt exists, and
the source hash still matches. A markdown source also snapshots the project files it names.
The status is derived again whenever context is read:

- **Current / source-backed** — exact evidence matched at capture and all source snapshots
  still match.
- **Re-check** — the cited file was edited after capture, but the exact excerpt is still in it,
  byte for byte (and the stored excerpt still matches its captured hash). An unrelated edit
  elsewhere in the file no longer silences the claim; the brief lists it in its own section.
  Claims captured before excerpts were stored (2026-10-21) still quarantine on any edit.
- **Stale / quarantined** — a source is missing or changed, or a cited markdown document's
  referenced code moved. The next AI sees the warning, not a silently trusted fact.
- **Unverified** — no exact evidence, invalid/mismatched evidence, or a legacy plain note.

This is provenance plus freshness, not an oracle: an unchanged excerpt proves where the
claim came from and that its source did not move; it does not make every interpretation
infallible.

Sessions past the budget rotate to `docs/handoff/archive/SESSIONS-<YYYY-MM>.md`
automatically — the live ledger stays short and the decision digest persists. Because the
ledger and context registry are committed, memory is **shared across vendors**: Gemini can
inherit what Claude captured yesterday, with the same freshness label. `plutos report`
prints the ledger with the context assessment (the Report page and `GET /api/continuity` were removed on 2026-11-14). The protocol
half is in `AGENTS.md` under "A session": start from the brief, finish with `session_end`.

### Memory: decisions and claims

Since 2026-11-04 a decision recorded with `session_end` is a record in `docs/handoff/CONTEXT.json`
beside the claims, not only a line in the digest: it has an id (`d-` and twelve hex characters, minted
once, so it survives rewording), its text, optional sources with an exact excerpt, and `supersedes`
when it reverses an earlier decision. The digest line in `CONTINUITY.md` stays the human view and ends
with the id. Nothing stores a status; it is derived every time the registry is read:

- **reversed** — another decision supersedes it. The brief no longer lists it.
- **verified** — it cites at least one source and every excerpt captured with it is still in that file,
  word for word (an edit elsewhere in the file does not unsettle a decision).
- **valid** — every other decision: it cites no source, or an excerpt it cited is gone (the card says which).

A claim keeps its four states (current, re-check, quarantined, unverified) as described above. In
`session_end`, `decided` takes a string or `{ "decision": "…", "supersedes": "d-…" }`; the brief shows
each standing decision with its id, so the next session can name what it reverses.

The verbs, in the terminal (`node cli.mjs memory …`, or `plutos memory …`):

- `memory list [--type decision|claim] [--status reversed|verified|valid|review|stale|unverified]`
  lists the records, newest first; `memory open <id>` shows one card: text, type, status, sources with
  their excerpt, what it supersedes or is reversed by, dates.
- `memory verify <id>` re-snapshots the sources when every excerpt is still there verbatim; otherwise it
  names the one that is not and changes nothing.
- `memory supersede <old-id> "<new text>"` records a new decision that reverses the old one and adds its
  digest line; `memory retire <id> "<reason>"` moves a record to the month's archive with the reason.
- `plutos check --memory` is a report, not a gate (exit 0): broken anchors, duplicate ids, near-duplicate
  texts, supersede chains, claims unverified for 30 days, what the next session end would archive, the
  caps (80 claims, 200 decisions, 512 KB), hidden characters, and digest lines without a record.
  `--apply` runs the one-time migration that gives every older `DECISION:` line a record and its id; a
  second run changes nothing.

`verify`, `supersede`, `retire` and `--apply` rewrite shared memory, so they need an interactive terminal:
they are yours, not a command an AI runs from a shell. The registry refuses a zero-width or
bidirectional character on every write, archives a claim the 80-claim cap pushes out instead of dropping
it, and never ages a decision out.

### Memory: find and the index

`memory find "<query>" [path] [--budget 1..3] [--archived] [--json]` answers a question from the records
without opening them: at most three cards, each with the record's id, type, status, text (at most 500
characters), the query terms it matched and where its evidence is (`path:line`), then one line for what
the floor hid ("n more below the floor"). The query may be Turkish or English: the dotless ı, I and İ
are folded, diacritics are ignored, and a Turkish word is looked up in the same small dictionary
`plutos_context_for_task` uses (karar → decision, pano → board, itme kapısı → push gate), kept beside its
own form so a record written in Turkish still matches. A file path or a record id in the query is a fact
key: an exact hit on it outranks any wording.

The index is `.plutos/memory.db`, git-ignored (`.plutos/memory.db*`; a project set up before 2026-11-04
picks the pattern up at its next repair or install) and rebuilt in full whenever `CONTEXT.json`,
`CONTINUITY.md` or an archive file changes, so the files stay the truth. It holds every claim and
decision with its status, every session block (live and archived; the block's timestamp is its id) and,
cold, the records in `docs/handoff/archive/CONTEXT-*.jsonl`, which only `--archived` searches and which
come back labelled "archived: history, not current". It needs the Node build's `node:sqlite` with FTS5
(Node 22.13 or later); without it, or when the database cannot be opened, the same records are scanned in
JavaScript and the answer says `engine: scan`. Nothing is written for a project that has no record yet,
and the brief and the SessionStart hook never build it.

**The floor.** A query with no real match returns "No record matches above the floor": a card stands only
when it matches at least two distinct content words of the query, at least one of them informative (one
word, informative or not, when an exact id or path matched), and scores at least half of the best card for
that query. A word is informative when it stands in at most a tenth of the records (archived included;
the index keeps each word's count), so a question made only of the project's common words (board, session,
decision, panel) is refused even though those words match records, and the answer names the common words:
add a specific one, an id, a path or a name (`docker`, `lib/push-gate.mjs`, `d-…`). Nothing is injected
below the floor.

**Measured before kept** (`node tools/memory-probe-eval.mjs`): 86 questions written from this repository's own records, half in Turkish, over five
abilities (where X lives, what replaced Y, how to do Z, known gotchas, false premises that must be
refused), answered three ways: the brief plus a grep (the baseline), plain FTS5, and the index with
folding, the dictionary and the fact keys. The drop rules were fixed in advance by the research: drop the
index if it does not beat brief plus grep by 10 points of Recall@5, or refuses false premises less well.
On 2026-11-04 the index scored Recall@5 80.4% against 64.0% and refused 61.1% of the false premises
against 11.1%, so it stays. Half of the probes were written by the same author as the records, in one
repository: the record says so.

**One card per task.** `plutos_context_for_task` adds at most one record under a `Memory:` heading, only
above the floor, and drops it first when the answer's token budget is tight.

**Shown ids.** `session_end` writes `- **Shown:** d-…, …` into the session block: the record ids this MCP
process actually delivered through `session_start` and `plutos_context_for_task` (ids only, at most 400
characters). The SessionStart hook's brief runs in another process, so its ids are offered, not known to
have been read, and are not counted. `plutos check --memory` then lists each standing decision "unseen for
30 days", counted only from the first session block that carries the field (the summary says since when,
or "tracking starts at the next session_end"). Retiring a record from its usage (shown, then a pass or a
failure) needs a verified result per shown record, which nothing records yet: that is the next step, not
this one.

### Optional automatic capture (Claude Code)

The Connect panel offers **Automatic shared context (Claude Code)** only after Claude Code
is explicitly connected to that project. It is off by default and requires a confirmation.
Enabling it performs one narrow private write: it merges PLUT_OS handlers into
`.claude/settings.local.json` for Claude Code's `PreCompact` and `SessionEnd` lifecycle
events. Existing settings and unrelated hooks are preserved; invalid JSON is refused
byte-for-byte.

The hook only validates and enqueues a job, so SessionEnd is not held open for a model call.
The queue lives in the PLUT_OS Hub, outside the target project. A detached worker reads a
bounded tail of user/assistant text, removes tool results, system blocks and thinking, redacts
obvious credentials, and asks `claude -p`, with a small model at low effort, for a structured
handoff. It runs with
no tools and no session persistence. Raw transcript files are never copied into PLUT_OS or
the repo. A manual `session_end` wins; the final automatic capture skips it, and automatic
output is never allowed to create binding decisions. The dashboard shows queued, completed,
skipped, and failed capture state instead of failing silently.

This adapts the lifecycle-capture pattern of
[Avenox Beyin](https://github.com/avenoxai/avenoxbeyin), keeping PLUT_OS's neutral shared files
and adding the source and freshness gates. Claude documents the hook events and project settings
in its [hooks reference](https://code.claude.com/docs/en/hooks), and `claude -p` in its
[programmatic usage guide](https://code.claude.com/docs/en/headless). The extraction runs on the
Claude CLI account already on the machine, so it uses that subscription or API usage
([current plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan);
provider policy can change). Turning the switch off removes only PLUT_OS's two handlers;
restart or reload Claude Code after either change.

### AI costs — what this project's AI work used

`plutos_usage` gives your AI the open project's own ledger: the records Claude Code and Codex keep for this folder,
read on this computer, split by tool, agent, model and session (work is output plus thinking; cache reads
are shown apart). Nothing is installed or downloaded and nothing leaves the machine. The dashboard's
**Costs** page shows the same ledger (`GET /api/token-usage`; `?days=N` sets the window for both tools, 90 days by default: Claude Code transcripts by file date, Codex files by date folder; the page shows the window).
Codex sessions are read from `~/.codex/sessions` and attributed to the project by their working folder;
a tool's reasoning tokens are counted once, as thinking. Antigravity keeps no per-session token record on
disk, so it is not counted.

### Usage log — which AIs used which tools

Every PLUT_OS MCP tool call (drawer tools included) and every hook run (the session brief, a sub-agent
start, session close) adds one JSON line to the project's `.plutos/usage.jsonl`:
`{t, ai, kind: "tool"|"hook", name, ok, ms}`, plus `agent` (the sub-agent type) on a sub-agent start and
`readOnly` on a read-only `session_start`. A brief from `/clear` or a compact is recorded as `brief:clear` or
`brief:compact`.
Arguments, outputs, prompts and paths are never written. The file is per machine and git-ignored; at
2 MB it rotates to `.plutos/usage.1.jsonl`, so there are at most two files. Nothing is written outside a
PLUT_OS project, and a failed write never changes a tool's result or a hook's output (`lib/usage-log.mjs`).

`plutos usage [path] [--days N] [--json]` (default 7 days) and `GET /api/usage?days=N` read it
(`lib/usage-report.mjs`): per AI, tool calls and failures, sessions started (startup briefs, and
`session_start` calls that are not read-only and not within 15 minutes of that AI's brief) and ended (`session_end` calls), the session records in `CONTINUITY.md`, and sub-agent
starts; the ten tools used most; listed tools never called; and days with git commits but no session
record. The log cannot tell which agent made a call, so sub-agent use is a ratio, not an attribution.
Home shows one line: "Last 7 days: N AIs, N tool calls, N sessions". This is not `plutos_usage`, which
reports token use.

### The Status Report — the third map

PROJECT_MAP answers "what is this project", CODEINDEX answers "where does the code live"
(a small catalog at `docs/ai/CODEINDEX.md`, then one shard per folder under
`docs/ai/codeindex/` — open only the shard you need);
the **status report** answers **"where are we"** (`plutos report` in a terminal, `status_report`
for your AI; the dashboard's Report page was removed on 2026-11-14, and Home shows its open board
count and the last session's next step):

- **At a glance** — commits/lines/contributors in the chosen window (7/30/90 days), plus
  live board counts (in progress / TODO / blocked).
- **What happened** — the recorded sessions (from `session_end`), newest first.
- **Landed in the repo** — the actual commit list.
- **In flight / Next steps** — running and blocked board items, then next steps *with
  sources*: what each AI's latest session said comes next, then open board TODOs.
- **Watch-outs** — BLOCKED items and hygiene warnings.

Each section carries one of five evidence labels: *fact* (git, or computed from the files), *assumption* (what an AI wrote in its session record
or on the board), *proposal* (next steps), and in shared memory *unknown* (a note whose source changed).
*Inference* is the fifth, for an AI's own reasoning in its replies. `plutos report` prints
the same report in a terminal, and `plutos check --weight` lists what a session in the
project carries against each part's limit: the brief against the hook's 10,000 characters,
AGENTS.md against what Codex reads, the boards and `results/` against their budgets.

It is a generated view (git, CONTINUITY, boards, hygiene), assembled per request and never
stored, so it cannot go stale; a missing source is stated ("not a git repository", "no sessions
recorded yet"), not guessed. The `status_report` MCP tool gives your AI the same report with one
standing instruction: **present it in the user's own language** (the facts and structure stay).
Ask for a "status report", in your own language, and the AI calls it.

### Story lines — the same history, in plain language

Every `session_end` can include a `story`: one or two plain sentences a non-technical reader gets
("Payments work now: a customer can actually buy the product"), with no jargon and no file names
(the "Finish" step of `AGENTS.md` asks every agent for one). They stay in the session records. The
Story Deck page that turned them into slides (`/deck`) was removed on 2026-11-14.

### Document hygiene — the anti-rot layer

A coordination system dies two quiet deaths: boards that grow until nobody reads past the
middle, and maps of a codebase that moved on months ago. The Board page *measures* both, so
neglect is visible instead of silent:

- **Budgets** (in `lib/hygiene.mjs`, one place to tune): ≤ 8 lines per entry, ≤ 10 active
  entries per board, ≤ 20 KB per board file, and ≤ 30 commits behind for
  `docs/ai/PROJECT_MAP.md` / `CODEINDEX.md`. Numbers, not adjectives — an agent can check
  itself against a number.
- **Staleness is measured honestly:** not by file date but by how many commits landed since
  the map was last committed. A map 40 commits behind gets flagged; one that just moved with
  the code doesn't.
- **One-click Archive DONE:** finished entries move to
  `docs/handoff/archive/BOARD-<YYYY-MM>.md` (append-only, month-partitioned) and leave the
  live board. Purely mechanical — no AI in the loop, nothing lost, and the write is atomic so
  a concurrently-added entry is never swept away with it.
- **Markdown classes:** live files (boards, roster, CONTINUITY) stay bounded; generated
  indexes overwrite in place; `results/` and `archive/` may grow on disk. Git is the
  changelog. The brief names a report only when a live board entry cites it, and
  `session_start` archives DONE entries past budget so the live board cannot become a pile.

`GET /api/hygiene` returns the same report if you want it elsewhere; `POST /api/board/archive`
performs the cleanup.

### Doc drift — which documents stopped being true

Boards rot by growing. Documents stay short and authoritative-looking while they quietly stop
matching the code, so a stale document does not look stale: it looks like an answer.

The Board's hygiene panel and `plutos audit` measure it (the Documents page and its map were removed
on 2026-11-14). For every markdown file in the project root and under
`docs/`, PLUT_OS collects the paths that document *itself* names — a path in backticks, or a
markdown link that resolves to a real file — and checks which of them changed in the commits
since the document was last committed.

- **Drifted** — the changed files are named. Something this document describes has moved.
- **Matches the code** — every file it names is unchanged since it was written.
- **Names no files** — nothing to check against; a protocol or prose document is not accused
  of being stale just because the codebase moved.
- **Not committed yet** — git has no answer, and the report says so rather than reporting clean.

Counting commits alone would be useless (a README does not rot because a shader it never
mentions changed); measuring against the files a document names keeps the amber worth reading.
Two things are measured but not raised, because a warning that fires constantly goes unread:

- **Dated snapshots.** A document that is *supposed* to describe the past — an audit, a
  competitive scan — declares itself with `<!-- plutos:snapshot -->` in its first few lines.
  Its distance from the code is still shown, labelled as a dated record.
- **The grace window** (`BUDGETS.driftCommitsBehind`, 5 commits). A status file naming twenty
  modules would go amber the moment you commit anything. Inside the window the panel states
  the numbers plainly ("just behind"); past it, the document is raised as drifted.

## 8. The PLUT_OS Coordinator MCP — what it's for

The dashboard is the human's interface; the **MCP server (`index.mjs`) is the same
capabilities for AIs.** Connect it to an AI from Projects → Connect an AI (§3), which writes the
entry for the chosen tool (for Claude Code, the project's `.mcp.json`). Any MCP-capable AI in that
project then gets structured tools instead of hand-editing markdown.

PLUT_OS lists its core tools (the table below) in every session. Three drawers hold the rest and
are listed only while a project has them open: research (6 tools), code (2) and admin (3).
The tools marked *admin* below are in
the admin drawer, closed by default: a call to one says how to open it.

| Tool | Purpose |
|---|---|
| `plutos_project_info` | Safety diagnostic: the exact project this MCP process is bound to, and whether the binding is trusted |
| `board_read` / `board_update` | Read/upsert a board tier (`board: main\|agents`; a missing board means main, any other name is refused); statuses TODO/IN_PROGRESS/DONE/BLOCKED, `assignee`, `result` references |
| `plutos_modules` | Optional tool groups (drawers): `list`, `open` or `close` the research and admin drawers for this project. A closed drawer's tools are unlisted and cost no context; the choice is shared by every AI on the project (`.plutos/drawers.json`). Every drawer is closed until the project opens it |
| `plutos_code_lookup` | File-level look-up: where a file or symbol is declared, what its file uses and what uses it |
| `plutos_context_for_task` | Before a task: give it the task in a sentence (any language; a file or function name helps) and get the files to open first, ranked, each with its reason (named, declares a symbol you mentioned, matches the task's words, or uses / is used by one of those) and a confidence, plus at most one memory record under `Memory:` when one stands above the floor. Built from the code graph in memory, plus the declarations of files the code map does not parse (SQL, C++ .cc/.hh, Objective-C, Dart, Scala, Elixir, Zig, web components, shaders; one shared table, `lib/file-types.mjs`, says which); a word such as deploy, schema, scene or project settings also offers that concern's usual files (`vercel.json`, `migrations/`, `project.godot`). Writes only the git-ignored memory index. Read-only |
| `plutos_create_agent` | Create a new subagent: writes its definition (`.claude/agents/` for Claude Code, `.agents/<name>/AGENT.md` for any other AI) and registers it on the roster in one call |
| `session_start` / `session_end` | Read the bounded brief / record work, decisions, and evidence-bearing learned claims |
| `project_snapshot` (*admin*) | One self-contained markdown handover, including uncommitted and untracked work |
| `status_report` (*admin*) | The owner's status report — commits, recorded sessions, board state, next steps, watch-outs |
| `plutos_usage` (*admin*) | Token use of this project's Claude Code sessions (Claude Code only) |
| `plutos_capture_session` | Internal endpoint for the explicitly enabled capture hook; listed only where capture is on, validates and queues only |
| `init_roadmap` (*admin*) | Bootstrap the kit into the project |
| `plutos_ask` | Approval gate: stop and ask the owner before an irreversible or ambiguous step |

The MCP server also writes a heartbeat (`mcp_status.json` under stable per-user app data)
that the dashboard's top bar and Home status read — so you can see which AI clients are connected.

## 9. A typical day

1. You open the project's `PLUT_OS.bat` → dashboard shows boards, signals, HUD.
2. You add a task on the main board (or tell your AI): `TODO · rival analysis · Assignee: research`.
3. Gemini (researcher) sees it, registers/dispatches its `research-scout` subagent.
4. The scout works on the agent board, writes `results/rival-analysis.md`, marks DONE with
   the reference, updates its MEMORY.md, refreshes its roster entry.
5. Claude (boss-side) reads the result reference in its next session and builds on it —
   no re-research, no stepping on each other.
6. End of cycle: changelog updated, DONE entries moved off the boards, memories compacted
   (AGENTS.md rule 6).

#!/usr/bin/env node
// Builds the research studio as a standalone MCP server + CLI + Local Web UI + Zero-Touch Installer
// that runs without PLUT_OS: the same research_topic / research_branch / research_fetch /
// research_images / research_read / research_note tools, the same Scrapling bridge (plain and rendered fetch,
// robots.txt, public addresses only) and the same quote checks. lib/research stays the only
// source; this copies it and adds standalone entry points, so any improvement in PLUT_OS
// reaches the standalone package on the next build.
//
//   node tools/make-research-mcp.mjs [outDir] [--zip]      (default: dist-research-mcp/)
//
// A build clears outDir first, so no file of an older build survives, but only a folder an
// earlier build made (clearOut below); a missing or empty folder is used as it is, and any other
// path is refused with nothing deleted.
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wantZip = args.includes('--zip');
const outArg = args.find(a => !a.startsWith('-'));
const OUT = path.resolve(outArg || path.join(ROOT, 'dist-research-mcp'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = 'unknown';
// git's own complaint stays out of stderr, which the dashboard's export shows when a build fails.
try { commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a checkout */ }

// An earlier build's folder holds MARKER, which lists the top-level names that build wrote. It
// is cleared only while its top level holds nothing else but what npm install or a file browser
// adds: research records the standalone UI keeps in its own folder (.plutos) are on no list, so
// they stop the rebuild instead of being deleted.
const MARKER = '.research-mcp-build.json';
const DISPOSABLE = ['node_modules', 'package-lock.json', '.DS_Store', 'Thumbs.db', 'desktop.ini'];
function clearOut() {
    let entries;
    try {
        entries = fs.lstatSync(OUT).isDirectory() ? fs.readdirSync(OUT) : null;
    } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
    }
    if (entries?.length === 0) return;
    let built = null;
    try { built = JSON.parse(fs.readFileSync(path.join(OUT, MARKER), 'utf8')).files; } catch { /* not a build */ }
    const foreign = entries && Array.isArray(built) ? entries.filter(e => e !== MARKER && !built.includes(e) && !DISPOSABLE.includes(e)) : null;
    if (foreign?.length === 0) {
        fs.rmSync(OUT, { recursive: true, force: true });
        return;
    }
    const why = !entries ? 'is not a plain folder'
        : !foreign ? `was not made by this tool (it has no readable ${MARKER})`
            : `holds what no build wrote: ${foreign.join(', ')}`;
    console.error(`make-research-mcp: refused: ${OUT} ${why}. Nothing was deleted; clear it yourself or build into a new or empty folder.`);
    process.exit(1);
}
clearOut();
const copy = (from, to = from) => {
    fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to));
};
for (const f of ['store.mjs', 'fetch.mjs', 'mcp.mjs', 'routes.mjs', 'scrapling_bridge.py']) copy(`lib/research/${f}`);
copy('lib/atomic.mjs');
copy('lib/client-process.mjs');
copy('LICENSE');

// fetch.mjs finds the bridge from APP_ROOT; here the app root is the package folder.
fs.writeFileSync(path.join(OUT, 'lib', 'approot.mjs'), `import path from 'path';
import { fileURLToPath } from 'url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The data folder routes.mjs builds its export under; standalone, that is the package folder.
export const PLUTOS_HOME_DIR = process.env.PLUTOS_HOME ? path.resolve(process.env.PLUTOS_HOME) : APP_ROOT;
`);

// 1. MCP Server Entry Point (server.mjs)
fs.writeFileSync(path.join(OUT, 'server.mjs'), `#!/usr/bin/env node
// Standalone research MCP server, built from PLUT_OS lib/research (commit ${commit}).
// Records live under <RESEARCH_ROOT or the working directory>/.plutos/research.
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RESEARCH_TOOLS, researchMcpHandlers } from './lib/research/mcp.mjs';

const root = path.resolve(process.env.RESEARCH_ROOT || process.cwd());
const text = t => ({ content: [{ type: 'text', text: t }] });
const errorText = t => ({ content: [{ type: 'text', text: t }], isError: true });
const handlers = researchMcpHandlers(root, text, errorText);

const server = new Server({ name: 'research', version: '${pkg.version}' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: RESEARCH_TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async request => {
    const run = handlers[request.params.name];
    return run ? run(request.params.arguments) : errorText(\`ERROR: unknown tool \${request.params.name}\`);
});
await server.connect(new StdioServerTransport());
`);

// 2. CLI Entry Point (cli.mjs)
fs.writeFileSync(path.join(OUT, 'cli.mjs'), `#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { fetchPage, fetchImages, fetchRuntime } from './lib/research/fetch.mjs';

const args = process.argv.slice(2);
// A refused or failed fetch is one line on stderr and exit code 1, not a stack trace.
const fail = error => { console.error(\`research-fetch: \${error.message}\`); process.exit(1); };
if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: node cli.mjs <url> [--render] [--fresh] [--json] [--status]');
    console.log('       node cli.mjs <url> --images [folder] [--max N]   save the page\\'s images (Steam: use the store data URL)');
    process.exit(0);
}
const imagesAt = args.indexOf('--images');
if (imagesAt >= 0) {
    const url = args.find((a, i) => !a.startsWith('-') && i !== imagesAt + 1 && args[i - 1] !== '--max');
    const next = args[imagesAt + 1];
    const outDir = path.resolve(next && !next.startsWith('-') && next !== url ? next : 'research-images');
    const maxAt = args.indexOf('--max');
    const result = await fetchImages(url, { outDir, max: maxAt >= 0 ? Number(args[maxAt + 1]) : 12 }).catch(fail);
    console.log(JSON.stringify({ folder: outDir, ...result }, null, 2));
    process.exit(0);
}
if (args.includes('--status')) {
    console.log(JSON.stringify(fetchRuntime({ refresh: true }), null, 2));
    process.exit(0);
}
const url = args.find(a => !a.startsWith('-'));
const cacheDir = path.join(os.homedir(), '.cache', 'plutos-research-fetch');
const page = await fetchPage(url, { cacheDir, render: args.includes('--render'), fresh: args.includes('--fresh') }).catch(fail);
console.log(args.includes('--json') ? JSON.stringify(page, null, 2) : page.markdown);
`);

// 3. Standalone Web UI Server (ui-server.mjs) for viewing & managing topics outside PLUT_OS
fs.writeFileSync(path.join(OUT, 'ui-server.mjs'), `#!/usr/bin/env node
// Standalone Research Studio Web UI (runs without PLUT_OS on http://127.0.0.1:3045)
import http from 'http';
import path from 'path';
import { URL } from 'url';
import { researchRoutes } from './lib/research/routes.mjs';

const ROOT = path.resolve(process.env.RESEARCH_ROOT || process.cwd());
const PORT = Number(process.env.RESEARCH_PORT || 3045);

const sendJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
};

const routes = researchRoutes({ sendJson, getProjectRoot: () => ROOT });

const HTML = \`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Research Studio — Standalone UI</title>
<style>
  :root { --bg: #0f1117; --surface: #181b23; --sec: #1f2430; --border: #2c3344; --text: #e2e8f0; --muted: #94a3b8; --brand: #c8a96e; --done: #22c55e; --err: #ef4444; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 1.5rem; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 1rem; margin-bottom: 1rem; }
  h1 { margin: 0; font-size: 1.25rem; color: var(--brand); }
  button, input, select { background: var(--sec); border: 1px solid var(--border); color: var(--text); padding: .45rem .8rem; border-radius: 6px; font: inherit; font-size: .85rem; }
  button { cursor: pointer; }
  button:hover { border-color: var(--brand); }
  .btn-primary { background: var(--brand); color: #111; font-weight: 600; border-color: var(--brand); }
  .layout { display: grid; grid-template-columns: 280px 1fr; gap: 1rem; }
  .topic-btn { width: 100%; text-align: left; margin-bottom: .45rem; padding: .7rem; background: var(--surface); display: block; }
  .topic-btn.active { border-color: var(--brand); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.2rem; }
  .bar { display: flex; gap: .5rem; flex-wrap: wrap; background: var(--sec); padding: .65rem; border-radius: 8px; margin: .8rem 0; align-items: center; }
  .bar input[type="url"], .bar input[type="text"] { flex: 1; min-width: 220px; }
  .tabs { display: flex; gap: .4rem; margin: 1rem 0; border-bottom: 1px solid var(--border); padding-bottom: .5rem; }
  .tabs button.active { border-color: var(--brand); color: var(--brand); }
  .branch { background: var(--sec); border: 1px solid var(--border); border-radius: 8px; padding: .75rem; margin: .5rem 0; }
  .finding { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: .6rem; margin-top: .45rem; }
  blockquote { margin: .35rem 0; padding: .35rem .65rem; border-left: 3px solid var(--brand); color: var(--muted); background: var(--sec); }
  pre { background: var(--sec); padding: .85rem; border-radius: 6px; overflow: auto; max-height: 500px; white-space: pre-wrap; word-break: break-word; font-size: .82rem; }
</style>
</head>
<body>
<header>
  <div><h1>Research Studio</h1><small style="color:var(--muted)">Root: \${ROOT}</small></div>
  <div style="display:flex;gap:.5rem"><button onclick="toggleNew()">+ New topic</button><button onclick="load()">Refresh</button></div>
</header>
<div id="new-box" style="display:none" class="card">
  <h3>New research topic</h3>
  <div class="bar"><input id="nt-title" placeholder="Title (e.g. Steam review analysis)"><input id="nt-q" placeholder="Main question"><input id="nt-goal" placeholder="What it is for"><button class="btn-primary" onclick="createTopic()">Start</button></div>
</div>
<div class="layout">
  <aside id="topics"></aside>
  <main id="detail" class="card">Pick a topic or start a new one.</main>
</div>
<script>
let selected = null, tab = 'branches', current = null, reader = null;
async function api(p, body) {
  const r = await fetch(p, body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {});
  const d = await r.json();
  if (!d.success) throw new Error(d.message);
  return d;
}
function toggleNew() { const el = document.getElementById('new-box'); el.style.display = el.style.display === 'none' ? 'block' : 'none'; }
async function createTopic() {
  const title = document.getElementById('nt-title').value, question = document.getElementById('nt-q').value, goal = document.getElementById('nt-goal').value;
  const r = await api('/api/research/topic', { title, question, goal });
  selected = r.topic.id; toggleNew(); load();
}
async function addBranch() {
  const question = document.getElementById('nb-q').value;
  if (!question) return;
  await api('/api/research/branch', { topicId: selected, question }); load();
}
async function fetchUrl() {
  const url = document.getElementById('f-url').value, branchId = document.getElementById('f-br').value, render = document.getElementById('f-ren').checked;
  const btn = document.getElementById('f-btn'); btn.textContent = 'Fetching…'; btn.disabled = true;
  try { await api('/api/research/fetch', { topicId: selected, url, branchId, render }); tab = 'sources'; load(); }
  catch (e) { alert(e.message); btn.textContent = 'Fetch page'; btn.disabled = false; }
}
async function readSrc(id) {
  reader = await api('/api/research/source?topicId=' + encodeURIComponent(selected) + '&sourceId=' + encodeURIComponent(id));
  renderDetail();
}
function renderDetail() {
  if (!current) return;
  const { topic, status, brief } = current;
  let body = '';
  if (tab === 'branches') {
    body = '<div class="bar"><input id="nb-q" type="text" placeholder="Add a branch (e.g. gameplay complaints, UI)…"><button onclick="addBranch()">+ Add branch</button></div>' +
      topic.branches.map(b => '<div class="branch"><b>[' + b.status + '] ' + b.question + '</b>' +
        topic.findings.filter(f => f.branchId === b.id).map(f => '<div class="finding">' + f.claim +
          f.quotes.map(q => '<blockquote>“' + q.text + '”</blockquote>').join('') + '</div>').join('') + '</div>').join('');
  } else if (tab === 'sources') {
    body = (reader ? '<div class="branch"><b>' + (reader.source.title || reader.source.url) + '</b> <button onclick="reader=null;renderDetail()">Close</button><pre>' + reader.text.replace(/</g,'&lt;') + '</pre></div>' : '') +
      topic.sources.map((s, i) => '<div class="branch"><b>[' + (i+1) + '] ' + (s.title || s.url) + '</b> (' + s.chars + ' chr) <button onclick="readSrc(\\'' + s.id + '\\')">Read source</button></div>').join('');
  } else if (tab === 'brief') {
    body = '<pre>' + brief.replace(/</g,'&lt;') + '</pre>';
  }
  document.getElementById('detail').innerHTML = '<h2>' + topic.title + '</h2><p>' + topic.question + '</p>' +
    '<div class="bar"><input id="f-url" type="url" placeholder="URL (e.g. https://steamcommunity.com/app/413150/reviews/)">' +
    '<select id="f-br"><option value="">Branch (optional)</option>' + topic.branches.map(b => '<option value="' + b.id + '">' + b.question + '</option>').join('') + '</select>' +
    '<label><input type="checkbox" id="f-ren"> JS Render (Chromium)</label><button id="f-btn" class="btn-primary" onclick="fetchUrl()">Fetch page</button></div>' +
    '<div class="tabs"><button class="' + (tab==='branches'?'active':'') + '" onclick="tab=\\'branches\\';renderDetail()">Branches (' + topic.branches.length + ')</button>' +
    '<button class="' + (tab==='sources'?'active':'') + '" onclick="tab=\\'sources\\';renderDetail()">Sources & reader (' + topic.sources.length + ')</button>' +
    '<button class="' + (tab==='brief'?'active':'') + '" onclick="tab=\\'brief\\';renderDetail()">Brief (brief.md)</button></div>' + body;
}
async function load() {
  const d = await api('/api/research/topics');
  if (!selected && d.topics.length) selected = d.topics[0].id;
  document.getElementById('topics').innerHTML = d.topics.map(t => '<button class="topic-btn ' + (t.id===selected?'active':'') + '" onclick="selected=\\'' + t.id + '\\';reader=null;load()"><b>' + t.title + '</b><br><small style="color:var(--muted)">' + t.sources + ' kaynak · ' + t.findings + ' bulgu</small></button>').join('');
  if (selected) { current = await api('/api/research/topic?id=' + encodeURIComponent(selected)); renderDetail(); }
}
load();
</script>
</body></html>\`;

// The PLUT_OS dashboard's rule: the Host must be this machine's own address (no DNS rebinding)
// and an Origin, when a browser sends one, this page's (no POST from another site).
const LOCAL_HOSTS = [\`localhost:\${PORT}\`, \`127.0.0.1:\${PORT}\`];
const isLocalRequest = req => {
    const origin = (req.headers.origin || '').toLowerCase();
    return LOCAL_HOSTS.includes((req.headers.host || '').toLowerCase())
        && (!origin || LOCAL_HOSTS.some(host => origin === \`http://\${host}\`));
};

http.createServer((req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { success: false, message: 'Forbidden: cross-origin requests are not allowed.' });
    const url = new URL(req.url, \`http://127.0.0.1:\${PORT}\`);
    const handler = routes[\`\${req.method} \${url.pathname}\`];
    if (handler) return handler(req, res, url);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
}).listen(PORT, '127.0.0.1', () => {
    console.log(\`Research Studio UI running at http://127.0.0.1:\${PORT} (root: \${ROOT})\`);
});
`);

// 4. Zero-Touch Installer (setup.mjs + INSTALL.bat + VIEW_UI.bat)
fs.writeFileSync(path.join(OUT, 'setup.mjs'), `#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.mjs').replace(/\\\\/g, '/');
const withBrowser = process.argv.includes('--with-browser');

console.log('[1/3] npm install...');
spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: __dirname, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('[2/3] Installing Scrapling (Python)...');
const py = process.platform === 'win32' ? 'python' : 'python3';
spawnSync(py, ['-m', 'pip', 'install', '--upgrade', 'scrapling[fetchers]', 'markdownify', 'protego'], { cwd: __dirname, stdio: 'inherit' });
if (withBrowser) {
    spawnSync(py, ['-m', 'pip', 'install', 'playwright'], { cwd: __dirname, stdio: 'inherit' });
    spawnSync(py, ['-m', 'playwright', 'install', 'chromium'], { cwd: __dirname, stdio: 'inherit' });
}

console.log('[3/3] Registering the MCP server with your AI tools...');
const home = os.homedir();
const upsert = (file, label) => {
    try {
        if (!fs.existsSync(path.dirname(file))) return;
        const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
        data.mcpServers = data.mcpServers || {};
        data.mcpServers.research = { command: 'node', args: [serverPath] };
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\\n');
        console.log('  [OK] ' + label + ' -> ' + file);
    } catch {}
};
const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
spawnSync(claudeCmd, ['mcp', 'remove', 'research', '-s', 'user'], { windowsHide: true, shell: process.platform === 'win32' });
if (spawnSync(claudeCmd, ['mcp', 'add', '-s', 'user', 'research', '--', 'node', serverPath], { windowsHide: true, shell: process.platform === 'win32' }).status === 0) {
    console.log('  [OK] Claude Code CLI');
}
upsert(path.join(home, '.cursor', 'mcp.json'), 'Cursor');
upsert(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'), 'Claude Desktop');
upsert(path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), 'Antigravity');
// Codex and Gemini CLI register through their own commands, which merge into their config files.
const cli = (cmd, args, label) => {
    const r = spawnSync(process.platform === 'win32' ? cmd + '.cmd' : cmd, args, { windowsHide: true, shell: process.platform === 'win32' });
    if (r.status === 0) console.log('  [OK] ' + label);
};
cli('codex', ['mcp', 'add', 'research', '--', 'node', serverPath], 'Codex CLI');
cli('gemini', ['mcp', 'add', '-s', 'user', 'research', 'node', serverPath], 'Gemini CLI');
console.log('\\nDone. Web UI: node ui-server.mjs (or VIEW_UI.bat)');
`);

fs.writeFileSync(path.join(OUT, 'INSTALL.bat'), `@echo off\r\ncd /d "%~dp0"\r\nnode setup.mjs %*\r\npause\r\n`);
fs.writeFileSync(path.join(OUT, 'VIEW_UI.bat'), `@echo off\r\ncd /d "%~dp0"\r\nstart http://127.0.0.1:3045\r\nnode ui-server.mjs\r\n`);

// 5. AI Auto-Install Instructions: AGENTS.md for every AI tool, with the thin pointers Claude Code
// and Gemini CLI load (CLAUDE.md, GEMINI.md import it).
fs.writeFileSync(path.join(OUT, 'AGENTS.md'), `# AI Agent Auto-Install Instructions
If the user asks you to install or configure this package, DO NOT ask the user to edit JSON files.
Run \`node setup.mjs\` (or \`node setup.mjs --with-browser\` for Chromium JS rendering). It automatically installs dependencies and registers the \`research\` MCP server with Claude Code, Codex CLI, Gemini CLI, Cursor, Antigravity and Claude Desktop (each one it finds on this machine).
To launch the visual Research Web UI, run \`node ui-server.mjs\` (opens on http://127.0.0.1:3045).
`);
fs.writeFileSync(path.join(OUT, 'CLAUDE.md'), '@AGENTS.md\n');
fs.writeFileSync(path.join(OUT, 'GEMINI.md'), '@./AGENTS.md\n');

fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
    name: 'research-mcp',
    version: pkg.version,
    description: 'Source-backed web research & scraping as a standalone MCP server + Web UI + CLI.',
    type: 'module',
    bin: { 'research-mcp': 'server.mjs', 'research-fetch': 'cli.mjs', 'research-ui': 'ui-server.mjs' },
    scripts: {
        setup: 'node setup.mjs',
        'setup:full': 'node setup.mjs --with-browser',
        start: 'node server.mjs',
        ui: 'node ui-server.mjs'
    },
    engines: { node: '>=20' },
    license: 'UNLICENSED',
    private: true,
    dependencies: { '@modelcontextprotocol/sdk': pkg.dependencies['@modelcontextprotocol/sdk'] }
}, null, 2) + '\n');

fs.writeFileSync(path.join(OUT, 'README.md'), `# Research MCP & Standalone Studio (from PLUT_OS ${commit})

Targeted, source-backed web research & scraping (Scrapling + Playwright) for any MCP client, with a built-in Web UI and zero-touch installer.

## Zero-Touch Install
- **Windows:** Double-click \`INSTALL.bat\`
- **AI Agent / Terminal:** \`node setup.mjs\` (or \`node setup.mjs --with-browser\` for Chromium JS rendering)
- **Web UI:** Double-click \`VIEW_UI.bat\` or run \`node ui-server.mjs\` (http://127.0.0.1:3045)

## Connect
\`setup.mjs\` registers the server where each tool reads it; by hand, the entry is \`{ "command": "node", "args": ["<this folder>/server.mjs"] }\` under the name \`research\`.

| Client | Where | How |
| --- | --- | --- |
| Claude Code | user scope (~/.claude.json) | \`claude mcp add -s user research -- node <this folder>/server.mjs\` |
| Codex CLI | ~/.codex/config.toml | \`codex mcp add research -- node <this folder>/server.mjs\` |
| Gemini CLI | ~/.gemini/settings.json | \`gemini mcp add -s user research node <this folder>/server.mjs\` |
| Cursor | ~/.cursor/mcp.json | the entry above under \`mcpServers\` |
| Antigravity | ~/.gemini/antigravity/mcp_config.json | the entry above under \`mcpServers\` |

## Tools (MCP)
- \`research_topic\`: start a topic with a question and a page budget; status; the cited brief.
- \`research_branch\`: sub-questions; a branch closes as answered only with a cited finding.
- \`research_fetch\`: one public page as frozen text (\`render: true\` for script-filled pages such as Steam reviews; JSON is read as text).
- \`research_images\`: a page's images saved as files (for a Steam game, the store data URL \`store.steampowered.com/api/appdetails?appids=<id>\` gives the header, capsule and screenshots).
- \`research_read\`, \`research_note\`: read further; record findings whose quotes are checked against the page.

## CLI
- \`node cli.mjs <url> [--render] [--json]\`: one page as text.
- \`node cli.mjs <url> --images [folder] [--max N]\`: save its images.

Rules for every request: public addresses only, robots.txt per host, an honest user agent, no stealth.
`);

// Written after the build's own files, which it lists, so the next build knows what it may clear.
fs.writeFileSync(path.join(OUT, MARKER), JSON.stringify({
    note: 'Written by PLUT_OS tools/make-research-mcp.mjs. A rebuild deletes this folder only while its top level holds just these files (npm install output aside).',
    files: fs.readdirSync(OUT)
}, null, 2) + '\n');

if (wantZip) {
    const zipPath = `${OUT}.zip`;
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
    if (process.platform === 'win32') {
        spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path "${OUT}\\*" -DestinationPath "${zipPath}" -Force`], { windowsHide: true });
    } else {
        spawnSync('zip', ['-r', zipPath, '.'], { cwd: OUT });
    }
}

console.log(`Research MCP written to ${OUT} (from ${commit}). Next: cd into it and run node setup.mjs.`);

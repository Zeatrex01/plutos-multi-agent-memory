#!/usr/bin/env node
// Minimal zero-dependency smoke test for the PLUT_OS dashboard API.
// Spawns dashboard.mjs on a test port with an isolated hub config (PLUTOS_HOME),
// runs the core flow against a temp project, prints PASS/FAIL, exits non-zero on failure.
//
// Usage: node tools/smoke-test.mjs
import { spawn, execFileSync } from 'child_process';
import { request as httpRequest } from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SCOPE_SKILL } from '../lib/scope.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import { applyRosterUpdate, parseRoster } from '../lib/roster.mjs';
import { applyBoardUpdate, parseBoardEntries } from '../lib/board.mjs';
import { updateFileAtomically } from '../lib/atomic.mjs';
import { ideasPathFor, readIdeas } from '../lib/ideas.mjs';
import { createApproval, readApproval, answerApproval, listApprovals, approvalsDir, askSeal } from '../lib/approvals.mjs';
import { sameProjectPath } from '../lib/project-binding.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // the repository root
// Every dashboard this suite starts gets a port that is free right now. A fixed default (3555)
// collided with whatever already held it, and the suite then tested that server instead of its own.
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const PORT = Number(process.env.PLUTOS_TEST_PORT) || await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-smoke-'));
const projectDir = path.join(tmpRoot, 'demo-project');
fs.mkdirSync(projectDir, { recursive: true });
process.env.PLUTOS_HOME = path.join(tmpRoot, 'hub');
// MCP discovery reads several user-level client configs. Keep the smoke suite hermetic so a
// developer's real Claude/Gemini/Codex setup cannot change the detected tier or get touched.
const testUserHome = path.join(tmpRoot, 'user-home');
process.env.USERPROFILE = testUserHome;
process.env.HOME = testUserHome;
process.env.APPDATA = path.join(testUserHome, 'AppData', 'Roaming');
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const server = spawn(process.execPath, [path.join(__dirname, 'dashboard.mjs')], {
    env: { ...process.env, PLUTOS_PORT: String(PORT), PLUTOS_HOME: path.join(tmpRoot, 'hub'), PLUTOS_NO_OS_OPEN: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
});
// Kept so an aborted run can say whether the dashboard died and what it printed last.
let serverErr = '';
server.stderr.on('data', chunk => { serverErr = (serverErr + chunk).slice(-4000); });
const serverClosed = new Promise(resolve => server.once('close', resolve));   // its stderr is complete then

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// A connection that closes before any response means the dashboard never handled the
// request (typically an idle keep-alive socket it closed just as this process reused it,
// seen on Windows after a long in-process section), so one retry is safe for any method.
async function request(url, init) {
    try { return await fetch(url, init); }
    catch (e) {
        const code = e.cause?.code || '';
        if (!/UND_ERR_SOCKET|ECONNRESET|EPIPE/.test(code) || server.exitCode !== null) throw e;
        return fetch(url, init);
    }
}
async function get(p) {
    const res = await request(BASE + p);
    return res.json();
}
async function post(p, body) {
    const res = await request(BASE + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}
// A request through a local proxy or tunnel carries a forwarding header and is remote: the
// dashboard answers the owner at this computer only, so it is refused outright.
const PROXIED_IP = { 'X-Forwarded-For': '203.0.113.9' };

// Only the dashboard this suite started counts. With its port taken it exits at once
// (EADDRINUSE) while the server holding the port goes on answering, so the wait ends as soon as the
// child is gone, and an answer from a dashboard with another data folder is not taken for it.
async function waitForServer(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let other = '';
    while (Date.now() < deadline) {
        if (server.exitCode !== null || server.signalCode !== null) {
            await Promise.race([serverClosed, new Promise(r => setTimeout(r, 1000))]);
            throw new Error(`the dashboard this suite started exited before it answered on ${BASE}`);
        }
        try {
            const mode = await get('/api/app/mode');
            if (sameProjectPath(mode.dataHome, process.env.PLUTOS_HOME)) return;
            other = mode.dataHome;
        } catch {}
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(other ? `${BASE} is answered by another dashboard (data folder ${other})` : `dashboard did not come up on ${BASE}`);
}

try {
    console.log(`\nPLUT_OS smoke test — ${BASE}\n`);
    await waitForServer();

    // 1. Add workspace = observe only. The source directory must remain byte-for-byte
    // untouched while PLUT_OS keeps its generated map and task board in the isolated hub.
    const add = await post('/api/workspaces/add', { path: projectDir });
    check('workspace add', add.success === true, add.message);
    check('workspace starts in observe-only mode', add.mode === 'observed' && add.installed === false, JSON.stringify(add));
    check('add writes nothing into the source project', fs.readdirSync(projectDir).length === 0, fs.readdirSync(projectDir).join(', '));
    check('add does not create AGENTS.md, .plutos or MCP config',
        !fs.existsSync(path.join(projectDir, 'AGENTS.md'))
        && !fs.existsSync(path.join(projectDir, '.plutos'))
        && !fs.existsSync(path.join(projectDir, '.mcp.json')));
    check('observe store is outside the project', !!add.storageRoot && !sameProjectPath(add.storageRoot, projectDir)
        && fs.existsSync(path.join(add.storageRoot, 'docs', 'handoff', 'BOARD.md')), add.storageRoot);
    check('observe mode generates code index only in hub storage',
        fs.existsSync(path.join(add.storageRoot, 'docs', 'ai', 'CODEINDEX.md'))
        && !fs.existsSync(path.join(projectDir, 'docs', 'ai', 'CODEINDEX.md')));
    const observedStorage = await get('/api/settings/storage');
    check('dashboard uses the stable Hub root instead of the application folder',
        observedStorage.dataRoot === process.env.PLUTOS_HOME
        && observedStorage.appRoot === __dirname
        && fs.existsSync(path.join(process.env.PLUTOS_HOME, 'install.json')),
        JSON.stringify(observedStorage));
    check('storage UI reports observe-only knowledge as a Hub sidecar',
        observedStorage.project?.mode === 'hub-sidecar'
        && observedStorage.project?.dataRoot === add.storageRoot
        && observedStorage.boundaries?.rawClaudeTranscriptCopied === false,
        JSON.stringify(observedStorage.project));
    const dashboardSource = fs.readFileSync(path.join(__dirname, 'dashboard.mjs'), 'utf8');
    check('only the dashboard copy that binds the port registers itself as current',
        dashboardSource.indexOf('server.listen(PORT, LISTEN_HOST')
            < dashboardSource.indexOf('const installRegistration = registerCurrentInstall()'));
    check('empty folder is detected as an unknown stack', add.detected && add.detected.stack === 'unknown', JSON.stringify(add.detected));
    const docsHub = await get('/api/docs');
    check('document hub reads source docs only', Array.isArray(docsHub.docs) && docsHub.docs.length === 0);
    const observedBoard = await get('/api/board');
    check('local task board is usable without project artifacts', observedBoard.exists === true
        && observedBoard.path.startsWith(add.storageRoot), JSON.stringify(observedBoard));
    const idxAfterAdd = await get('/api/codeindex');
    check('codebase index is available after add', idxAfterAdd.exists === true, JSON.stringify({ exists: idxAfterAdd.exists }));
    const observedConnect = await get('/api/connect');
    check('observe mode exposes no actionable client setup', observedConnect.installed === false
        && observedConnect.clients.every(c => c.canWrite === false && c.deeplink === null && c.command === null),
        JSON.stringify(observedConnect.clients.map(c => ({ id: c.id, canWrite: c.canWrite, deeplink: c.deeplink }))));
    const blockedObservedConnect = await post('/api/connect', { client: 'claude-code', projectRoot: projectDir });
    check('observe mode refuses client writes before the project kit exists', blockedObservedConnect.success === false
        && /observe-only/i.test(blockedObservedConnect.message), blockedObservedConnect.message);
    check('blocked client setup still leaves the project empty', fs.readdirSync(projectDir).length === 0,
        fs.readdirSync(projectDir).join(', '));

    // Installing the kit is a second, explicit action. It restores the established shared
    // project behaviour but still leaves AI client configs for a third explicit choice.
    const kitInstall = await post('/api/project/install', {});
    check('explicit project-kit install succeeds', kitInstall.success === true && kitInstall.installed === true, kitInstall.message);
    check('kit install copies AGENTS.md and shared board', fs.existsSync(path.join(projectDir, 'AGENTS.md'))
        && fs.existsSync(path.join(projectDir, 'docs', 'handoff', 'BOARD.md')));
    check('kit install generates the in-project code index', fs.existsSync(path.join(projectDir, 'docs', 'ai', 'CODEINDEX.md')));
    const installedStorage = await get('/api/settings/storage');
    check('installed-project context and code maps are reported as project-owned',
        installedStorage.project?.mode === 'project-owned'
        && installedStorage.project?.dataRoot === path.resolve(projectDir),
        JSON.stringify(installedStorage.project));
    check('kit install still does not choose an AI client', !fs.existsSync(path.join(projectDir, '.mcp.json')));
    const claudeConnect = await post('/api/connect', { client: 'claude-code', projectRoot: projectDir });
    check('explicit Claude team connection writes .mcp.json', claudeConnect.success === true
        && JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')).mcpServers.plutos, claudeConnect.message);
    const connectedConfig = fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8');
    const missingTarget = await post('/api/connect', { client: 'claude-code' });
    check('connection write requires the displayed project identity', missingTarget.success === false
        && /projectRoot/.test(missingTarget.message));
    const staleTarget = await fetch(BASE + '/api/connect', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: 'claude-code', projectRoot: path.join(tmpRoot, 'old-selected-project') }) });
    check('connection write rejects a stale project before touching client config', staleTarget.status === 409
        && fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8') === connectedConfig);
    const docsAfterInstall = await get('/api/docs');
    check('document hub lists shared files after explicit install',
        Array.isArray(docsAfterInstall.docs) && docsAfterInstall.docs.some(d => (d.path || '').includes('docs/handoff/BOARD.md')),
        JSON.stringify((docsAfterInstall.docs || []).slice(0, 5).map(d => d.path)));
    // The link map: a Markdown link to a .md file is resolved against the document's own folder
    // into a project path; a web link is not a document; a [[wiki]] link stays a name.
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# p\n\nSee [notes](docs/notes.md), [the board](./docs/handoff/BOARD.md#top) and [a site](https://example.com/page.md).\n');
    fs.writeFileSync(path.join(projectDir, 'docs', 'notes.md'), '# notes\n\nBack to [the board](handoff/BOARD.md) and [[ROSTER]]; outside: [x](../../outside.md).\n');
    const linked = await get('/api/docs');
    const linksOf = p => (linked.docs || []).find(d => d.path === p)?.links;
    check('document hub resolves Markdown links to project paths and keeps wiki names',
        JSON.stringify(linksOf('README.md')) === JSON.stringify(['docs/notes.md', 'docs/handoff/BOARD.md'])
        && JSON.stringify(linksOf('docs/notes.md')) === JSON.stringify(['ROSTER', 'docs/handoff/BOARD.md']),
        JSON.stringify({ readme: linksOf('README.md'), notes: linksOf('docs/notes.md') }));
    check('document hub drift carries staleRefs for every document',
        (linked.docs || []).every(d => d.drift && Array.isArray(d.drift.staleRefs)));
    const installedConnect = await get('/api/connect');
    check('connect reports the project launcher after the kit install', installedConnect.installed === true && installedConnect.launcher === true
        && observedConnect.launcher === false, JSON.stringify({ installed: installedConnect.launcher, observed: observedConnect.launcher }));
    const openDoc = async (docPath, headers = {}) => {
        const r = await request(BASE + '/api/docs/open', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ path: docPath }) });
        return { status: r.status, body: await r.json() };
    };
    const openedBoard = await openDoc('docs/handoff/BOARD.md');
    check('document hub Open opens a listed project document', openedBoard.status === 200 && openedBoard.body.success === true
        && sameProjectPath(path.dirname(path.dirname(path.dirname(openedBoard.body.path))), projectDir), JSON.stringify(openedBoard));
    fs.writeFileSync(path.join(tmpRoot, 'outside.md'), '# outside');
    const escapes = await Promise.all(['../outside.md', path.join(tmpRoot, 'outside.md'), 'docs/handoff', 'docs/handoff/missing.md', '.plutos/plutos.config.json', ''].map(p => openDoc(p)));
    check('document hub Open refuses paths outside the project, folders, missing and non-markdown files',
        escapes.every(r => r.status === 400 && r.body.success === false), JSON.stringify(escapes.map(r => r.status)));
    const forwardedOpen = await openDoc('docs/handoff/BOARD.md', PROXIED_IP);
    check('document hub Open works on the PLUTOS computer only', forwardedOpen.status === 403 && forwardedOpen.body.success === false, JSON.stringify(forwardedOpen));
    // Isolation regression: PLUT_OS dogfoods its own live board and roster. Those files may
    // contain active tasks and agents, but a target project must receive only clean scaffold
    // templates. Exact equality makes the source boundary executable instead of relying on
    // the live files happening to be empty during a test run.
    for (const name of ['BOARD.md', 'AGENT_BOARD.md', 'ROSTER.md']) {
        const installed = fs.readFileSync(path.join(projectDir, 'docs', 'handoff', name), 'utf8');
        const clean = fs.readFileSync(path.join(__dirname, 'scaffold', 'docs', 'handoff', name), 'utf8');
        check(`${name} comes from the clean scaffold`, installed === clean && installed.includes('plutos:clean-template'));
    }
    const { initTargetProject, assertHandoffTemplatesAvailable } = await import('../lib/workspaces.mjs');
    const preservedDir = path.join(tmpRoot, 'preserved-handoff-project');
    fs.mkdirSync(path.join(preservedDir, 'docs', 'handoff'), { recursive: true });
    const sentinels = new Map();
    for (const name of ['BOARD.md', 'AGENT_BOARD.md', 'ROSTER.md']) {
        const value = `owner-managed ${name}\n`;
        sentinels.set(name, value);
        fs.writeFileSync(path.join(preservedDir, 'docs', 'handoff', name), value);
    }
    initTargetProject(preservedDir);
    check('existing handoff files remain byte-identical',
        [...sentinels].every(([name, value]) =>
            fs.readFileSync(path.join(preservedDir, 'docs', 'handoff', name), 'utf8') === value));

    const incompleteInstall = path.join(tmpRoot, 'incomplete-install');
    const missingTemplateTarget = path.join(tmpRoot, 'missing-template-target');
    fs.mkdirSync(incompleteInstall, { recursive: true });
    fs.mkdirSync(missingTemplateTarget, { recursive: true });
    let missingTemplatesRejected = false;
    try {
        assertHandoffTemplatesAvailable(missingTemplateTarget, incompleteInstall);
    } catch (e) {
        missingTemplatesRejected = /missing clean handoff template/.test(e.message);
    }
    check('missing clean templates fail before project bootstrap', missingTemplatesRejected);
    // Multi-format rule sync: thin pointer files so Claude Code / Gemini CLI / Cursor discover AGENTS.md
    check('CLAUDE.md pointer written', fs.existsSync(path.join(projectDir, 'CLAUDE.md')));
    check('GEMINI.md pointer written', fs.existsSync(path.join(projectDir, 'GEMINI.md')));
    check('.cursor/rules/plutos.mdc pointer written', fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'plutos.mdc')));
    check('pointer redirects to AGENTS.md', fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8').includes('AGENTS.md'));
    {
        // A project with its own CLAUDE.md keeps it as it is and gets the protocol as a rule Claude Code loads.
        const ownDir = path.join(tmpRoot, 'own-claude-md');
        fs.mkdirSync(ownDir, { recursive: true });
        fs.writeFileSync(path.join(ownDir, 'CLAUDE.md'), '# Our rules\n');
        initTargetProject(ownDir);
        check("a project's own CLAUDE.md is left as it is", fs.readFileSync(path.join(ownDir, 'CLAUDE.md'), 'utf8') === '# Our rules\n');
        const rule = path.join(ownDir, '.claude', 'rules', 'plutos.md');
        check('and the board protocol reaches Claude Code as a project rule', fs.existsSync(rule) && fs.readFileSync(rule, 'utf8').includes('Board Protocol'));
    }

    // Structural guarantee, not just a convention: no shipped source file may auto-connect
    // to a non-loopback host. Deliberately narrower than "no https:// substring anywhere" —
    // lib/mcps.mjs legitimately holds external repo links shown to the
    // owner as text (PLUT_OS never fetches them itself), and dashboard-ui.html legitimately
    // links out to the author's own pages via a plain <a href> a person has to click. What
    // must never exist: (a) an HTML/CSS tag that auto-fetches on page load off this machine,
    // and (b) a runtime fetch()/.request() call whose target is a hardcoded non-loopback
    // literal. Both are exactly the shape the old project roadmap page's regression took.
    // Dynamic, not static: lib/auth.mjs pulls in lib/approot.mjs, whose PLUTOS_HOME_DIR is a
    // module-load-time constant read from process.env.PLUTOS_HOME. A static top-level import
    // here would evaluate it before this file's own isolation override below runs, pinning
    // every later test to the real machine's app-data folder instead of tmpRoot.
    const { isLoopback } = await import('../lib/auth.mjs');
    const isLocalHost = (host) => !!host && (isLoopback(host) || host === 'localhost');
    const hostOf = (urlStr) => {
        // Static source probes may use a dynamic port with a fixed loopback host.
        const literal = urlStr.replace(/^(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\$\{[A-Z_][A-Z0-9_]*\}(?=\/|$)/, '$1:1');
        try { return new URL(literal).hostname; } catch { return null; }
    };
    check('network scan accepts only fixed loopback hosts with template ports',
        isLocalHost(hostOf('http://127.0.0.1:${PORT}/api/app/mode'))
        && !isLocalHost(hostOf('https://example.com:${PORT}/api'))
        && !isLocalHost(hostOf('http://${HOST}:${PORT}/api'))
        && !isLocalHost(hostOf('http://127.0.0.1:${PORT}@example.com/api')));

    const AUTOFETCH_RE = /<(?:link|script|img|iframe)\b[^>]*?\b(?:href|src)\s*=\s*["'](https?:\/\/[^"']*)["']/gi;
    for (const rel of ['dashboard-ui.html']) {
        const text = fs.readFileSync(path.join(__dirname, rel), 'utf8');
        const offenders = [...text.matchAll(AUTOFETCH_RE)].map(m => m[1]).filter(u => !isLocalHost(hostOf(u)));
        check(`${rel} has no auto-loading tag pointing off this machine`, offenders.length === 0, offenders.join(', '));
    }
    const cssText = fs.readFileSync(path.join(__dirname, 'ui', 'styles.css'), 'utf8');
    const cssOffenders = [...cssText.matchAll(/(?:@import\s+|url\(\s*)["']?(https?:\/\/[^"')\s;]*)/gi)]
        .map(m => m[1]).filter(u => !isLocalHost(hostOf(u)));
    check('ui/styles.css has no @import/url() pointing off this machine', cssOffenders.length === 0, cssOffenders.join(', '));

    // Board titles, session lines and commit messages are text agents and other repositories
    // write; rendered raw through innerHTML they run as script with the dashboard's own local
    // authority (Report and Document Hub did, until ui/esc.js reached them). A module that
    // writes innerHTML imports the escaping helper, unless it only ever renders its own constants.
    const STATIC_ONLY_MARKUP = new Set(['features.js']);
    const unescapedModules = fs.readdirSync(path.join(__dirname, 'ui', 'modules'))
        .filter(f => f.endsWith('.js') && !STATIC_ONLY_MARKUP.has(f))
        .filter(f => {
            const text = fs.readFileSync(path.join(__dirname, 'ui', 'modules', f), 'utf8');
            return /\.innerHTML\s*[+]?=/.test(text) && !/from '\.\.\/esc\.js'/.test(text);
        });
    check('every UI module that writes innerHTML imports the escaping helper', unescapedModules.length === 0, unescapedModules.join(', '));

    const NETWORK_CALL_FILES = fs.readdirSync(path.join(__dirname, 'lib'))
        .filter(f => f.endsWith('.mjs')).map(f => path.join('lib', f))
        .concat(['dashboard.mjs', 'index.mjs', 'cli.mjs']);
    const NETWORK_CALL_RE = /\b(?:fetch|\.request)\s*\(\s*[`'"](https?:\/\/[^`'"]*)[`'"]/g;
    const callOffenders = [];
    for (const rel of NETWORK_CALL_FILES) {
        const text = fs.readFileSync(path.join(__dirname, rel), 'utf8');
        for (const m of text.matchAll(NETWORK_CALL_RE)) {
            if (!isLocalHost(hostOf(m[1]))) callOffenders.push(`${rel}: ${m[1]}`);
        }
    }
    check('no shipped lib/dashboard/index/cli code calls out to a non-loopback host',
        callOffenders.length === 0, callOffenders.join(', '));

    // Legacy install flags are ignored by Add Project: registration is always non-invasive.
    const structureDir = path.join(tmpRoot, 'structure-only-project');
    fs.mkdirSync(structureDir, { recursive: true });
    const structureAdd = await post('/api/workspaces/add', { path: structureDir, structureOnly: true });
    check('structure-only add succeeds', structureAdd.success === true, structureAdd.message);
    check('legacy structure-only add writes nothing into project', fs.readdirSync(structureDir).length === 0);
    check('legacy structure-only add still has a hub index', fs.existsSync(path.join(structureAdd.storageRoot, 'docs', 'ai', 'CODEINDEX.md')));
    await post('/api/workspaces/switch', { path: projectDir });
    // Map works without any MCP — it only needs a recognizable project (here a package.json).
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { react: '^18' } }));
    fs.writeFileSync(path.join(projectDir, 'app.js'), 'export const x = 1;');
    const scan = await post('/api/codeindex/scan', {});
    check('codebase map scan works without MCP', scan.success === true);
    const graphIdx = await get('/api/codeindex');
    check('codeindex API concatenates shards for the graph',
        graphIdx.exists === true && /### Folder:/.test(graphIdx.content || ''), JSON.stringify({ exists: graphIdx.exists, start: String(graphIdx.content || '').slice(0, 120) }));

    // Unknown stacks (C++, Rust, Python...) must scan too — the generic fallback, not an
    // error. Regression check for: runCodeScan threw on any non-Unity/non-Node project.
    const { runCodeScan, readIndexShards } = await import('../lib/codeindex.mjs');
    const cppDir = path.join(tmpRoot, 'cpp-project');
    fs.mkdirSync(path.join(cppDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cppDir, 'CMakeLists.txt'), 'project(demo)\n');
    fs.writeFileSync(path.join(cppDir, 'src', 'engine.hpp'), 'class Engine { public: void start(); };\nstruct Config { int w; };\n');
    fs.writeFileSync(path.join(cppDir, 'src', 'main.cpp'), '#include "engine.hpp"\nint main() { return 0; }\n');
    let cppScan;
    try { cppScan = runCodeScan(cppDir); } catch (e) { cppScan = { error: e.message }; }
    check('C++ project scans via generic fallback', cppScan.type === 'generic' && cppScan.scannedFiles === 2, JSON.stringify(cppScan));
    check('generic scan writes the index files', fs.existsSync(path.join(cppDir, 'docs', 'ai', 'CODEINDEX.md'))
        && fs.readFileSync(path.join(cppDir, 'docs', 'ai', 'codeindex', 'src.md'), 'utf8').includes('Engine'));
    check('generic scan writes a catalog instead of one dump',
        fs.readFileSync(path.join(cppDir, 'docs', 'ai', 'CODEINDEX.md'), 'utf8').includes('# CODEINDEX - catalog')
        && fs.readFileSync(path.join(cppDir, 'docs', 'ai', 'CODEINDEX.md'), 'utf8').includes('docs/ai/codeindex/src.md'));

    // An ESM-first Node project must not be invisible in its own index: the JS scanner
    // walked .ts/.tsx/.js/.jsx only, so every .mjs (PLUT_OS's own lib/) was skipped.
    const esmDir = path.join(tmpRoot, 'esm-project');
    fs.mkdirSync(path.join(esmDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(esmDir, 'package.json'), JSON.stringify({ name: 'esm-demo', type: 'module' }));
    fs.writeFileSync(path.join(esmDir, 'lib', 'core.mjs'), 'export function bootKernel() { return 1; }\n');
    fs.writeFileSync(path.join(esmDir, 'legacy.cjs'), 'module.exports.legacyHelper = () => 2;\n');
    const esmScan = runCodeScan(esmDir);
    check('ESM-first node project scans .mjs and .cjs', esmScan.type === 'node' && esmScan.scannedFiles === 2, JSON.stringify(esmScan));
    const esmIndex = readIndexShards(esmDir, 'codeindex');
    check('.mjs exports land in the index', esmIndex.includes('bootKernel'));
    check('.cjs exports land in the index', esmIndex.includes('legacyHelper'));
    check('node scan shards lib separately from root files',
        fs.existsSync(path.join(esmDir, 'docs', 'ai', 'codeindex', 'lib.md'))
        && fs.readFileSync(path.join(esmDir, 'docs', 'ai', 'codeindex', 'lib.md'), 'utf8').includes('bootKernel')
        && fs.readFileSync(path.join(esmDir, 'docs', 'ai', 'codeindex', '_root.md'), 'utf8').includes('legacyHelper'));
    check('catalog stays a table of shards, not the symbol dump',
        !fs.readFileSync(path.join(esmDir, 'docs', 'ai', 'CODEINDEX.md'), 'utf8').includes('bootKernel'));

    // The code map's split between the project's own code and third-party code. It assumed one
    // game layout: only the Unity shards GAME and PROJECT (Assets/_GAME, Assets/_PROJECT) counted
    // as the project, so PLUT_OS's own checkout drew every folder as "Third-party / SDKs" and said
    // "0 shown (0 in _GAME/_PROJECT)". The real scanner over three layouts, then the real browser
    // module over its output (imports stubbed, as for features.js further down).
    {
        const codemapFixture = (name, files) => {
            const dir = path.join(tmpRoot, 'codemap-' + name);
            for (const [rel, body] of Object.entries(files)) {
                fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
                fs.writeFileSync(path.join(dir, rel), body);
            }
            runCodeScan(dir);
            return readIndexShards(dir, 'obsidian');
        };
        const nodeIndex = codemapFixture('node', {
            'package.json': '{"name":"codemap-node","type":"module"}\n',
            'app.js': 'export const start = 1;\n',
            'lib/core.mjs': 'export function boot() { return 1; }\n',
            'tools/lib/helper.mjs': 'export const help = 2;\n',
            'src/ThirdParty/legacy.js': 'export function old() { return 3; }\n'
        });
        const unityIndex = codemapFixture('unity', {
            'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.0f1\n',
            'Assets/_GAME/Scripts/Player.cs': 'public class Player { public void Jump() {} }\n',
            'Assets/_PROJECT/Managers/GameManager.cs': 'public class GameManager { public void Begin() {} }\n',
            'Assets/AppsFlyer/Scripts/AppsFlyer.cs': 'public class AppsFlyer { public void Init() {} }\n'
        });
        const godotIndex = codemapFixture('godot', {
            'project.godot': 'config_version=5\n',
            'scripts/player.gd': 'class_name Player\nextends Node\n\nfunc jump():\n\tpass\n',
            'addons/dialogue/plugin.gd': 'extends EditorPlugin\n\nfunc _enter_tree():\n\tpass\n'
        });

        const escSource = fs.readFileSync(path.join(__dirname, 'ui', 'esc.js'), 'utf8').replace(/^export /gm, '');
        const mapSource = fs.readFileSync(path.join(__dirname, 'ui', 'modules', 'codeindex.js'), 'utf8');
        const stubbed = mapSource.replace(/^import \{ ([^}]+) \} from '([^']+)';$/gm, (line, names, from) => (from === '../esc.js' ? escSource
            : names.split(',').map(n => n.trim()).map(n => (n === 'currentLang' ? "const currentLang = 'en';" : `const ${n} = k => (typeof k === 'string' ? k : '');`)).join('\n')));
        const probeDir = fs.mkdtempSync(path.join(tmpRoot, 'codemapprobe-'));
        const probe = path.join(probeDir, 'codeindex.probe.mjs');
        fs.writeFileSync(probe, stubbed);
        const savedWindow = globalThis.window;
        globalThis.window = {};
        try {
            const map = await import(pathToFileURL(probe).href);
            const read = index => {
                const m = map.buildModel(index);
                return { m, by: Object.fromEntries(m.folders.map(f => [f.key, f])), shape: JSON.stringify(m.folders.map(f => [f.key, f.thirdParty])) };
            };

            const node = read(nodeIndex);
            check('code map: a non-engine project is its own code, not third-party',
                node.m.rule === 'paths' && node.by.lib && !node.by.lib.thirdParty && node.by[''] && !node.by[''].thirdParty, node.shape);
            check('code map: only a vendored folder (ThirdParty) is third-party in it',
                node.by['src/ThirdParty'] && node.by['src/ThirdParty'].thirdParty === true
                && node.m.folders.filter(f => f.thirdParty).length === 1, node.shape);
            check('code map: two folders named lib stay two boxes',
                node.by.lib && node.by['tools/lib'] && node.by['tools/lib'].label === 'tools/lib', node.shape);
            const summary = map.mapSummary(node.m, map.capFiles(node.m, 500));
            check('code map: the status counts the project\'s own files',
                summary.ownFiles === 3 && summary.shown === 3 && summary.folded === 1, JSON.stringify(summary));

            const unity = read(unityIndex);
            check('code map: a Unity project with _GAME and _PROJECT keeps the owner\'s rule',
                unity.m.rule === 'core-shards'
                && unity.by['Assets/_GAME/Scripts'] && !unity.by['Assets/_GAME/Scripts'].thirdParty
                && unity.by['Assets/_PROJECT/Managers'] && !unity.by['Assets/_PROJECT/Managers'].thirdParty
                && unity.by['Assets/AppsFlyer/Scripts'] && unity.by['Assets/AppsFlyer/Scripts'].thirdParty === true, unity.shape);

            const godot = read(godotIndex);
            check('code map: Godot addons are third-party, its scripts are the project',
                godot.m.rule === 'paths' && godot.by.scripts && !godot.by.scripts.thirdParty
                && godot.by['addons/dialogue'] && godot.by['addons/dialogue'].thirdParty === true, godot.shape);

            const vendored = ['node_modules/x/a.js', 'Plugins/Vendor/a.cpp', 'Source/ThirdParty/zlib/z.h', 'Assets/TextMesh Pro/Scripts/T.cs'];
            const own = ['packages/app/a.js', 'plugins/site.js', 'lib/a.mjs', 'a.js'];
            check('code map: vendored folder names, spelled the engines\' way',
                vendored.every(p => map.isVendoredPath(p)) && !own.some(p => map.isVendoredPath(p)),
                JSON.stringify([...vendored, ...own].map(p => [p, map.isVendoredPath(p)])));
            const status = mapSource.match(/function updateStatus\(\)[\s\S]*?\r?\n}\r?\n/);
            check('code map: the status line names no game layout', status && !/_GAME|_PROJECT/.test(status[0]));
        } finally {
            globalThis.window = savedWindow;
        }
    }

    // Doc drift: a document is stale when a file it NAMES changed after it was last committed,
    // not merely because commits happened. Both halves matter — flagging every doc on every
    // commit is the same as flagging none.
    const { docDrift } = await import('../lib/hygiene.mjs');
    const driftDir = path.join(tmpRoot, 'drift-project');
    fs.mkdirSync(driftDir, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: driftDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.email', 'smoke@example.test');
    git('config', 'user.name', 'Smoke Test');
    fs.writeFileSync(path.join(driftDir, 'engine.js'), 'export const v = 1;\n');
    fs.writeFileSync(path.join(driftDir, 'other.js'), 'export const w = 1;\n');
    fs.writeFileSync(path.join(driftDir, 'DESIGN.md'), 'The engine lives in `engine.js`.\n');
    fs.writeFileSync(path.join(driftDir, 'NOTES.md'), 'This document names no code at all.\n');
    git('add', '-A'); git('commit', '-qm', 'initial');
    const driftFresh = docDrift(driftDir, ['DESIGN.md'])['DESIGN.md'];
    check('freshly committed doc reports no drift',
        driftFresh.tracked === true && driftFresh.referenced === 1 && driftFresh.staleRefs.length === 0, JSON.stringify(driftFresh));

    fs.writeFileSync(path.join(driftDir, 'other.js'), 'export const w = 2;\n');
    git('add', '-A'); git('commit', '-qm', 'touch a file the doc never mentions');
    const driftUnrelated = docDrift(driftDir, ['DESIGN.md'])['DESIGN.md'];
    check('a commit to an unnamed file does not mark the doc stale',
        driftUnrelated.commitsBehind === 1 && driftUnrelated.staleRefs.length === 0, JSON.stringify(driftUnrelated));

    fs.writeFileSync(path.join(driftDir, 'engine.js'), 'export const v = 2;\n');
    git('add', '-A'); git('commit', '-qm', 'change the file the doc describes');
    const drifted = docDrift(driftDir, ['DESIGN.md', 'NOTES.md']);
    check('doc goes stale when a file it names changes',
        drifted['DESIGN.md'].staleRefs.join() === 'engine.js', JSON.stringify(drifted['DESIGN.md']));
    check('doc that names no files is never flagged',
        drifted['NOTES.md'].referenced === 0 && drifted['NOTES.md'].staleRefs.length === 0);
    check('uncommitted doc is reported as unmeasured, not clean',
        docDrift(driftDir, ['GHOST.md'])['GHOST.md'].tracked === false);

    // A dated audit is meant to describe the past. Left unmarked it drifts further every week
    // and never gets fixed, and one permanent false alarm is enough to make everyone ignore
    // the warning. The distance is still measured — it just isn't raised.
    fs.writeFileSync(path.join(driftDir, 'AUDIT.md'), '# Audit 2026-01-01\n<!-- plutos:snapshot -->\n\nLooked at `engine.js`.\n');
    git('add', '-A'); git('commit', '-qm', 'add a dated audit');
    fs.writeFileSync(path.join(driftDir, 'engine.js'), 'export const v = 3;\n');
    git('add', '-A'); git('commit', '-qm', 'move on from what the audit described');
    const snap = docDrift(driftDir, ['AUDIT.md'])['AUDIT.md'];
    check('a marked snapshot is not raised as drift',
        snap.snapshot === true && snap.drifted === false && snap.staleRefs.join() === 'engine.js', JSON.stringify(snap));

    // Grace window: a doc is not neglected because you committed code right after writing it.
    // DESIGN.md's reference went stale 2 commits ago — measured, but not yet raised.
    const young = docDrift(driftDir, ['DESIGN.md'])['DESIGN.md'];
    check('stale refs inside the grace window are measured but not raised',
        young.staleRefs.join() === 'engine.js' && young.commitsBehind <= 5 && young.drifted === false, JSON.stringify(young));
    for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(driftDir, 'engine.js'), `export const v = ${10 + i};\n`);
        git('add', '-A'); git('commit', '-qm', `keep moving ${i}`);
    }
    const neglected = docDrift(driftDir, ['DESIGN.md'])['DESIGN.md'];
    check('past the grace window the same doc is raised',
        neglected.drifted === true && neglected.commitsBehind > 5, JSON.stringify(neglected));

    // Housekeeping trigger: the stale-doc / bloated-board signal that rides session_start and
    // session_end so drift is surfaced where the session happens, not only in the Document Hub.
    const { housekeeping, collectDocPaths } = await import('../lib/hygiene.mjs');
    // DESIGN.md is now past the grace window (drifted above), so it must appear in the lines.
    const tidy = housekeeping(driftDir);
    // Every drifted doc names the files that moved under it — grouped under one instruction
    // rather than repeating it per document, which is the whole point of the grouping: the
    // brief this rides is read by every AI at the start of every session.
    const tidyText = tidy.lines.join('\n');
    check('housekeeping surfaces a drifted doc',
        /^ +- DESIGN\.md — .*engine\.js/m.test(tidyText), JSON.stringify(tidy.lines));
    check('the update instruction is stated once, not once per document',
        (tidyText.match(/mark it a snapshot/g) || []).length === 1, JSON.stringify(tidy.lines));
    check('housekeeping stays silent on a snapshot', !tidyText.includes('AUDIT.md'), JSON.stringify(tidy.lines));
    check('collectDocPaths finds root-level docs',
        collectDocPaths(driftDir).includes('DESIGN.md'));
    // A clean, freshly-committed project has nothing to flag — no false alarms.
    const calmDir = path.join(tmpRoot, 'calm-project');
    fs.mkdirSync(calmDir, { recursive: true });
    const cgit = (...a) => execFileSync('git', a, { cwd: calmDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    cgit('init', '-q'); cgit('config', 'user.email', 's@t.test'); cgit('config', 'user.name', 'S');
    fs.writeFileSync(path.join(calmDir, 'README.md'), 'No code references here.\n');
    cgit('add', '-A'); cgit('commit', '-qm', 'init');
    check('housekeeping is silent on a clean project', housekeeping(calmDir).lines.length === 0, JSON.stringify(housekeeping(calmDir).lines));

    // Project snapshot: one self-contained file for another AI, on another machine, possibly
    // with a stale checkout. The whole design constraint is that it CARRIES what it refers to
    // rather than naming paths, and that it includes the work git cannot hand anyone — the
    // uncommitted and the experimental, which is the state the owner takes a snapshot FOR.
    {
        const snapMod = await import('../lib/snapshot.mjs');
        const snapDir = path.join(tmpRoot, 'snap-project');
        fs.mkdirSync(path.join(snapDir, 'docs', 'handoff'), { recursive: true });
        fs.mkdirSync(path.join(snapDir, 'docs', 'ai', 'codeindex'), { recursive: true });
        const sgit = (...a) => execFileSync('git', a, { cwd: snapDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        sgit('init', '-q'); sgit('config', 'user.email', 's@t.test'); sgit('config', 'user.name', 'S');
        fs.writeFileSync(path.join(snapDir, 'app.js'), 'const committed = 1;\n');
        fs.writeFileSync(path.join(snapDir, 'docs', 'handoff', 'BOARD.md'),
            '# BOARD\n\n### owner · TODO · Finish the exporter\n- **Task:** carry the state\n');
        fs.writeFileSync(path.join(snapDir, 'docs', 'ai', 'codeindex', 'lib.md'), '# lib\n[lib/thing.mjs] does the thing\n');
        sgit('add', '-A'); sgit('commit', '-qm', 'init');
        // The two states a snapshot exists to capture, and neither survives a git pull.
        fs.writeFileSync(path.join(snapDir, 'app.js'), 'const committed = 1;\nconst halfFinished = 2;\n');
        fs.writeFileSync(path.join(snapDir, 'experiment.js'), 'export const risky = true;\n');

        const snap = snapMod.buildSnapshot(snapDir, { ai: 'tester' });
        check('the snapshot carries the uncommitted diff, not just a file list',
            snap.text.includes('halfFinished'), String(snap.changedPaths));
        check('an untracked experiment is named even though no diff shows it',
            snap.text.includes('experiment.js') && snap.untracked === 1, JSON.stringify({ u: snap.untracked }));
        check('it names the branch and commit it was taken from', !!snap.head && snap.text.includes(snap.head));
        // Carried, not pointed at — the reader may have no checkout to resolve a path against.
        check('the board is carried in full, not named', snap.text.includes('Finish the exporter'));
        check('the code map is carried too', snap.text.includes('lib/thing.mjs'));
        check('it says plainly that it is state, not instructions', /state, not instructions/i.test(snap.text));

        // A snapshot that silently drops the diff would be worse than none: the reader would
        // believe it had the experimental work.
        const realCap = snapMod.SNAPSHOT_LIMITS.diffBytes;
        try {
            snapMod.SNAPSHOT_LIMITS.diffBytes = 40;
            const small = snapMod.buildSnapshot(snapDir, { ai: 'tester' });
            check('a capped diff says so instead of pretending to be complete',
                /truncated here/.test(small.text) && !/Complete\. This is the half-finished/.test(small.text));
        } finally { snapMod.SNAPSHOT_LIMITS.diffBytes = realCap; }

        // A clean tree is a normal case, not an error, and must not claim uncommitted work.
        sgit('add', '-A'); sgit('commit', '-qm', 'second');
        const clean = snapMod.buildSnapshot(snapDir, { ai: 'tester' });
        check('a clean tree says so rather than inventing changes',
            clean.changedPaths === 0 && clean.text.includes('Working tree clean'), String(clean.changedPaths));
    }

    // Watcher setup. The split this protects: PLUT_OS wires the Claude Code seat itself
    // because Context Mode already proved it knows that format, and states every other seat
    // on the board rather than guessing a hook format into somebody's config.
    {
        const w = await import('../lib/watcher.mjs');
        const wDir = path.join(tmpRoot, 'watch-project');
        fs.mkdirSync(path.join(wDir, '.claude'), { recursive: true });
        fs.mkdirSync(path.join(wDir, 'docs', 'handoff'), { recursive: true });
        // ensureLocalSettingsIgnored only acts inside a git repo — same guard Context Mode uses.
        fs.mkdirSync(path.join(wDir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(wDir, 'docs', 'handoff', 'BOARD.md'),
            '# BOARD\n\n(no active tasks — add your entry above this line)\n');
        // Somebody else's Stop hook and unrelated settings must survive every operation.
        fs.writeFileSync(path.join(wDir, '.claude', 'settings.local.json'), JSON.stringify({
            hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'their-own.sh' }] }] },
            permissions: { allow: ['Skill'] }
        }, null, 2));

        check('no watcher on a fresh project', w.watcherStatus(wDir).installed === false);
        const on = w.setWatcher(wDir, true, { agent: 'Claude', port: 3040 });
        check('installing writes the hook and its script',
            on.installed === true && fs.existsSync(w.watcherScriptPath(wDir)), JSON.stringify(on));

        const read = () => JSON.parse(fs.readFileSync(path.join(wDir, '.claude', 'settings.local.json'), 'utf8'));
        check('a foreign Stop hook survives the write',
            read().hooks.Stop.some(g => g.hooks[0].command === 'their-own.sh'), JSON.stringify(read().hooks.Stop));
        check('unrelated settings survive the write', JSON.stringify(read().permissions) === '{"allow":["Skill"]}');
        w.setWatcher(wDir, true, { agent: 'Claude', port: 3040 });
        check('installing twice does not stack a second hook', read().hooks.Stop.length === 2, String(read().hooks.Stop.length));

        // The behaviours that make a hook safe to leave running unattended. Two defects already
        // shipped past a substring check tonight, and a third — curl routing a LOCALHOST call
        // through http_proxy and timing out — was found by executing the script. So the exits
        // are RUN, and the decision they turn on is one exported function embedded into the
        // generated file by source, not a copy of it in a string.
        const script = fs.readFileSync(w.watcherScriptPath(wDir), 'utf8');
        check('the hook reads the board and never writes', script.includes('/api/board') && !script.includes('POST'));
        check('the generated hook embeds the real decision, not a second copy of it',
            script.includes('function selectAssignedTask'));

        const runHook = (payload, env = {}) => {
            try {
                execFileSync(process.execPath, [w.watcherScriptPath(wDir)], {
                    input: payload, env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe'
                });
                return { code: 0, stderr: '' };
            } catch (e) { return { code: e.status, stderr: String(e.stderr || '') }; }
        };
        const seat = { PLUTOS_AGENT: 'watch-seat', PLUTOS_BOARD_URL: 'http://127.0.0.1:9/api/board' };

        // Every failure path exits 0: a watcher must never be the reason a session cannot end.
        check('the hook refuses to recurse on itself', runHook('{"stop_hook_active":true}', seat).code === 0);
        check('an unreachable server never holds the session hostage',
            runHook('{"stop_hook_active":false}', seat).code === 0);
        check('malformed hook input is survived, not crashed on',
            runHook('this is not json', seat).code === 0);
        check('no seat name means no claim on anything', runHook('{}', { PLUTOS_BOARD_URL: seat.PLUTOS_BOARD_URL, PLUTOS_AGENT: ' ' }).code === 0);

        // The decision itself, exercised directly — this is the function the script above runs.
        // The remaining path (a reachable board returning entries) is verified by hand: this
        // sandbox blocks a child process from reaching a server the test itself started.
        const fakeBoard = { entries: [
            { agent: 'someone-else', status: 'TODO', title: 'Not yours', fields: {} },
            { agent: 'owner', status: 'TODO', title: 'Ship the thing', fields: { Assignee: '  WATCH-SEAT  ' } },
            { agent: 'watch-seat', status: 'DONE', title: 'Already finished', fields: {} },
            { agent: 'watch-seat', status: 'TODO', title: 'Second one', fields: {} }
        ] };
        const picked = w.selectAssignedTask(fakeBoard, 'watch-seat');
        check('a seat is handed its own oldest open task', picked && picked.task.title === 'Ship the thing', JSON.stringify(picked));
        check('an assignee is matched past casing and padding', !!picked);
        check('the rest of its queue is counted, not listed', picked.more === 1, String(picked && picked.more));
        check('a finished entry is not work', !!picked && picked.task.title !== 'Already finished');
        check('another seat task is never claimed', w.selectAssignedTask(fakeBoard, 'someone-else').task.title === 'Not yours');
        check('a seat with nothing assigned claims nothing', w.selectAssignedTask(fakeBoard, 'nobody') === null);
        check('an empty seat name claims nothing', w.selectAssignedTask(fakeBoard, '  ') === null);
        check('a malformed board claims nothing', w.selectAssignedTask(null, 'watch-seat') === null);
        // And the hook records an absolute path to one machine, so committing it would hand
        // every collaborator a hook pointing at a directory they do not have.
        check('installing ignores the settings file it wrote into', (() => {
            const gi = path.join(wDir, '.gitignore');
            return fs.existsSync(gi) && fs.readFileSync(gi, 'utf8').includes('.claude/settings.local.json');
        })(), 'watcher must not let a machine-local hook path into the repo');

        const off = w.setWatcher(wDir, false);
        check('removing takes out only our hook and our script',
            off.installed === false && !fs.existsSync(w.watcherScriptPath(wDir))
            && read().hooks.Stop.length === 1 && read().hooks.Stop[0].hooks[0].command === 'their-own.sh',
            JSON.stringify(read().hooks.Stop));

        // Seats PLUT_OS cannot wire become one board task, not four near-identical ones.
        const del = w.requestDelegatedWatchers(wDir, ['antigravity', 'codex', 'claude-code-local']);
        check('non-Claude seats are delegated, the Claude seat is not',
            del.requested.join() === 'antigravity,codex' && del.skipped.join() === 'claude-code-local',
            JSON.stringify(del));
        const boardText = fs.readFileSync(path.join(wDir, 'docs', 'handoff', 'BOARD.md'), 'utf8');
        check('the delegated task names every seat and points at the reference script',
            /Antigravity/.test(boardText) && /Codex/.test(boardText) && boardText.includes('plutos-watcher.cjs'));
        check('asking again does not write a second copy',
            w.requestDelegatedWatchers(wDir, ['antigravity']).alreadyOnBoard === true);
        check('a malformed settings file is refused, not overwritten', (() => {
            fs.writeFileSync(path.join(wDir, '.claude', 'settings.local.json'), '{ not json');
            try { w.setWatcher(wDir, true); return false; } catch (e) {
                return fs.readFileSync(path.join(wDir, '.claude', 'settings.local.json'), 'utf8') === '{ not json';
            }
        })());
    }

    // Approval tickets may offer named routes. The rule this protects: a ticket is still ONE
    // question with ONE answer — options only say which route was picked, so `decision` and
    // `note` keep working untouched for every caller that offers none.
    {
        const ap = await import('../lib/approvals.mjs');
        const askDir = path.join(tmpRoot, 'ask-project');
        fs.mkdirSync(askDir, { recursive: true });

        const plain = ap.createApproval(askDir, { agent: 'claude', question: 'Ship it?' });
        const plainAnswer = ap.answerApproval(askDir, plain.id, { decision: 'approved', note: 'but rename it first' });
        check('a ticket with no options still answers yes/no', plainAnswer.status === 'approved');
        // The note is how the owner says what to do instead; losing it loses the instruction.
        check('the owner note round-trips with the decision',
            plainAnswer.note === 'but rename it first' && plainAnswer.option === null, JSON.stringify(plainAnswer));

        const t3 = ap.createApproval(askDir, {
            agent: 'claude', question: 'How should I split this?',
            options: ['Split by subsystem', 'Split by risk', 'One task, no split']
        });
        check('a ticket carries the routes it offered', (t3.options || []).length === 3, JSON.stringify(t3.options));
        // The agent acts on whatever comes back, so an answer it cannot map to a route it
        // offered is worse than no answer at all.
        check('an option the ticket never offered is refused',
            (() => { try { ap.answerApproval(askDir, t3.id, { option: 'Do it my way' }); return false; } catch (e) { return true; } })());
        const picked = ap.answerApproval(askDir, t3.id, { option: 'Split by risk' });
        check('picking a route records it and counts as approval',
            picked.option === 'Split by risk' && picked.status === 'approved', JSON.stringify(picked));

        check('options must be distinct', (() => { try {
            ap.createApproval(askDir, { agent: 'a', question: 'q', options: ['x', 'x'] }); return false;
        } catch (e) { return true; } })());
        check('a menu belongs on the board, not in a ticket', (() => { try {
            ap.createApproval(askDir, { agent: 'a', question: 'q', options: ['1','2','3','4','5','6'] }); return false;
        } catch (e) { return true; } })());
    }

    // Local token ledger: per-project/model/session usage read off the Claude CLI's own
    // transcripts. Built against a synthetic ~/.claude/projects so the assertions are exact
    // rather than "whatever this machine happens to have done".
    {
        const usage = await import('../lib/usage.mjs');
        const realHome = process.env.HOME;
        const realProfile = process.env.USERPROFILE;
        const fakeHome = path.join(tmpRoot, 'ledger-home');
        const projDir = path.join(fakeHome, '.claude', 'projects');

        // The CLI flattens a project path into one directory name. Getting this wrong means the
        // active project is never matched and every row reads as somebody else's.
        check('project directory encoding matches the CLI layout',
            usage.encodeProjectDir('/home/user/Plut_OS') === '-home-user-Plut-OS',
            usage.encodeProjectDir('/home/user/Plut_OS'));

        process.env.HOME = fakeHome;
        process.env.USERPROFILE = fakeHome;
        try {
            // No ~/.claude at all is the normal state on a fresh machine — an answer, not a throw.
            check('a machine with no transcripts answers instead of throwing',
                usage.readTokenUsage('/a/b', { force: true }).available === false);

            const mk = (dir, file, lines) => {
                fs.mkdirSync(path.join(projDir, dir), { recursive: true });
                fs.writeFileSync(path.join(projDir, dir, file), lines.join('\n') + '\n');
            };
            const entry = (model, u, ts) => JSON.stringify({
                timestamp: ts, message: { model, usage: u }
            });
            mk('-a-mine', 's1.jsonl', [
                JSON.stringify({ type: 'queue-operation', content: 'no usage here' }),
                entry('model-a', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000, output_tokens: 60, output_tokens_details: { thinking_tokens: 40 } }, '2026-09-01T10:00:00Z'),
                entry('model-b', { output_tokens: 5, cache_read_input_tokens: 500 }, '2026-09-01T11:00:00Z')
            ]);
            mk('-b-theirs', 's2.jsonl', [
                entry('model-a', { output_tokens: 1, output_tokens_details: { thinking_tokens: 1 } }, '2026-09-01T09:00:00Z')
            ]);

            const led = usage.readTokenUsage('/a/mine', { force: true });
            check('the ledger reads every transcript it finds', led.available && led.scannedFiles === 2, JSON.stringify({ f: led.scannedFiles }));
            check('lines without a usage block are skipped, not counted', led.totals.calls === 3, String(led.totals.calls));
            check('cache reads are carried but kept separate from output',
                led.totals.cacheRead === 9500 && led.totals.output === 66, JSON.stringify(led.totals));

            // The ranking rule this whole module exists for: cache reads are ~300x output in a
            // real session, so ranking by a combined total ranks by cache reuse, not by work.
            check('work is output plus thinking, and excludes cache',
                usage.workDone(led.totals) === 107, String(usage.workDone(led.totals)));
            check('projects rank by work, not by the biggest number on the row',
                led.projects[0].name === '-a-mine' && led.projects[1].name === '-b-theirs',
                JSON.stringify(led.projects.map(p => p.name)));
            check('the active project is marked, and only it',
                led.projects.filter(p => p.current).map(p => p.name).join() === '-a-mine',
                JSON.stringify(led.projects.map(p => [p.name, p.current])));
            check('usage splits by model', led.models.length === 2
                && led.models[0].name === 'model-a' && led.models[0].output === 61,
                JSON.stringify(led.models));
            check('a session carries its project and its time span',
                led.sessions[0].id === 's1' && led.sessions[0].project === '-a-mine'
                && led.sessions[0].started === '2026-09-01T10:00:00Z'
                && led.sessions[0].ended === '2026-09-01T11:00:00Z', JSON.stringify(led.sessions[0]));

            // A transcript grows without bound. Skipping an oversized one is fine; doing it
            // silently is not — a partial ledger that reads as complete is worse than none.
            fs.writeFileSync(path.join(projDir, '-a-mine', 'huge.jsonl'),
                'x'.repeat(usage.USAGE_LIMITS.maxFileBytes + 1));
            const capped = usage.readTokenUsage('/a/mine', { force: true });
            check('an oversized transcript is skipped and the ledger says so',
                capped.truncated === true && capped.skippedFiles === 1, JSON.stringify({ t: capped.truncated, s: capped.skippedFiles }));
            // The running-total branch shares that bookkeeping, and a bug there yields a
            // partial ledger that reads as complete — the exact thing the cap exists to avoid.
            fs.rmSync(path.join(projDir, '-a-mine', 'huge.jsonl'), { force: true });
            const realTotal = usage.USAGE_LIMITS.maxTotalBytes;
            try {
                usage.USAGE_LIMITS.maxTotalBytes = 10;
                const starved = usage.readTokenUsage('/a/mine', { force: true });
                check('the running-total cap also reports rather than silently truncating',
                    starved.truncated === true && starved.skippedFiles > 0, JSON.stringify({ t: starved.truncated, s: starved.skippedFiles }));
            } finally { usage.USAGE_LIMITS.maxTotalBytes = realTotal; }

            // Subagent turns live one level down, in <session>/subagents/, and the first
            // version of the ledger missed them entirely — "which agent burned what" is the
            // question it was built to answer.
            fs.mkdirSync(path.join(projDir, '-a-mine', 's1', 'subagents'), { recursive: true });
            fs.writeFileSync(path.join(projDir, '-a-mine', 's1', 'subagents', 'agent-deadbeef.jsonl'), [
                JSON.stringify({ type: 'user', message: { role: 'user', content: 'You are the Ponytail agent, review this.' } }),
                JSON.stringify({ message: { model: 'model-b', usage: { output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } } } })
            ].join('\n') + '\n');
            const withSubs = usage.readTokenUsage('/a/mine', { force: true });
            const sub1 = withSubs.agents.find(a => a.id === 'deadbeef');
            check('a subagent transcript is counted, not skipped', !!sub1, JSON.stringify(withSubs.agents.map(a => a.id)));
            check('a subagent is labelled by what it was asked to be, not by its id',
                !!sub1 && /Ponytail/.test(sub1.label), sub1 && sub1.label);
            check('its spend rolls into the project it served',
                withSubs.projects.find(p => p.name === '-a-mine').output >= 67);
            check('the main thread stays in the table so the proportions do not lie',
                withSubs.agents.some(a => a.main === true));
            // The AI costs page reads only the open project, and holds that reading for the cache window
            // so switching tabs does not re-read a long project's transcripts; force reads again.
            const p1 = usage.readTokenUsage('/a/mine', { force: true, onlyProject: true });
            check('the project ledger reads only the open project', p1.projects.every(p => p.name === '-a-mine') && p1.totals.output >= 67, JSON.stringify(p1.projects.map(p => p.name)));
            check('a second read within the window is the cached one', usage.readTokenUsage('/a/mine', { onlyProject: true }) === p1);
            check('force reads again', usage.readTokenUsage('/a/mine', { force: true, onlyProject: true }) !== p1);
            check('the whole-machine reading is held apart from the project one', usage.readTokenUsage('/a/mine', { onlyProject: false }) !== p1);
        } finally {
            if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
            if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
        }
    }

    // Markdown classes: live files stay bounded; results/ and archive/ may grow on disk
    // without entering the next session's reading list. Newest-by-mtime, not readdir order.
    {
        const rotDir = path.join(tmpRoot, 'md-rot');
        const resultsDir = path.join(rotDir, 'docs', 'handoff', 'results');
        const archiveDir = path.join(rotDir, 'docs', 'handoff', 'archive');
        fs.mkdirSync(resultsDir, { recursive: true });
        fs.mkdirSync(archiveDir, { recursive: true });
        const { hygieneReport: rotReport, BUDGETS: rotBudgets } = await import('../lib/hygiene.mjs');
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        const now = Date.now();
        for (let i = 0; i < 25; i++) {
            const name = `${letters[i]}.md`;
            const full = path.join(resultsDir, name);
            fs.writeFileSync(full, `# ${name}\n`);
            // Newest are in the middle of the alphabet (m, n, o) so neither
            // readdir().slice(-3) nor a localeCompare head can fake the result.
            const rank = i === 12 ? 0 : i === 13 ? 1 : i === 14 ? 2 : 10 + i;
            const t = new Date(now - rank * 1000);
            fs.utimesSync(full, t, t);
        }
        for (let i = 1; i <= 40; i++) {
            fs.writeFileSync(path.join(archiveDir, `SESSIONS-filler-${String(i).padStart(2, '0')}.md`), '# old session\n');
        }
        fs.mkdirSync(path.join(rotDir, '.agents', 'scout'), { recursive: true });
        fs.writeFileSync(path.join(rotDir, '.agents', 'scout', 'MEMORY.md'), 'x'.repeat(rotBudgets.memoryBytes + 200));

        const inv = rotReport(rotDir);
        check('hygiene counts cold result files', inv.inventory?.results?.files === 25, JSON.stringify(inv.inventory?.results));
        check('hygiene flags too many result reports',
            (inv.warnings || []).some(w => w.source === 'results/' && /25 reports/.test(w.message)),
            JSON.stringify(inv.warnings));
        check('archive growth is not flagged as live rot',
            !(inv.warnings || []).some(w => /archive/i.test(String(w.source)) || /archive/i.test(w.message)),
            JSON.stringify(inv.warnings));
        check('hygiene flags oversized MEMORY.md',
            (inv.warnings || []).some(w => w.source === '.agents/scout/MEMORY.md'),
            JSON.stringify(inv.warnings));
        check('housekeeping mentions result-file rot',
            housekeeping(rotDir).lines.some(l => l.startsWith('results/:')), JSON.stringify(housekeeping(rotDir).lines));

        const { buildBrief: rotBrief } = await import('../lib/continuity.mjs');
        const briefRot = rotBrief(rotDir, { ai: 'cursor', full: true });
        check('brief does not list unreferenced result reports',
            !/results\/[a-z]\.md/.test(briefRot) && /stay cold/.test(briefRot),
            briefRot.match(/results\/[a-z]\.md/g)?.join(',') || briefRot.match(/stay cold.*/)?.[0] || briefRot);
        fs.mkdirSync(path.join(rotDir, 'docs', 'handoff'), { recursive: true });
        fs.writeFileSync(path.join(rotDir, 'docs', 'handoff', 'BOARD.md'), [
            '# BOARD', '',
            '### cursor · IN_PROGRESS · use the report',
            '- **Task:** follow results/m.md',
            ''
        ].join('\n'));
        const briefCited = rotBrief(rotDir, { ai: 'cursor' });
        check('brief lists a result only when live work names it',
            /results\/m\.md/.test(briefCited) && !/results\/n\.md/.test(briefCited) && !/results\/o\.md/.test(briefCited),
            briefCited.match(/results\/[a-z]\.md/g)?.join(',') || briefCited);
        const { tidyLiveBoards } = await import('../lib/hygiene.mjs');
        const boardFileRot = path.join(rotDir, 'docs', 'handoff', 'BOARD.md');
        const seededDone = ['# BOARD\n'];
        for (let i = 1; i <= 4; i++) seededDone.push(`### done-${i} · DONE · finished ${i}\n- **Task:** old ${i}\n`);
        fs.writeFileSync(boardFileRot, seededDone.join('\n'), 'utf8');
        const tidied = tidyLiveBoards(rotDir);
        check('session hygiene archives DONE entries past budget',
            tidied.archived === 4 && !fs.readFileSync(boardFileRot, 'utf8').includes('done-1 · DONE'),
            JSON.stringify(tidied));
    }

    // Kademe 2 — the generated code index self-heals: missing → scanned, present+fresh → left alone.
    const { refreshIndexIfStale } = await import('../lib/codeindex.mjs');
    const idxDir = path.join(tmpRoot, 'index-refresh');
    fs.mkdirSync(idxDir, { recursive: true });
    fs.writeFileSync(path.join(idxDir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
    fs.writeFileSync(path.join(idxDir, 'core.mjs'), 'export const boot = () => 1;\n');
    const first = refreshIndexIfStale(idxDir);
    check('missing code index is auto-generated at session start',
        first.rescanned === true && first.reason === 'missing'
        && fs.existsSync(path.join(idxDir, 'docs', 'ai', 'CODEINDEX.md'))
        && fs.existsSync(path.join(idxDir, 'docs', 'ai', 'codeindex')), JSON.stringify(first));
    const second = refreshIndexIfStale(idxDir);
    check('a present code index is not needlessly rescanned', second.rescanned === false, JSON.stringify(second));
    check('refreshIndexIfStale never throws on a non-existent path',
        refreshIndexIfStale(path.join(tmpRoot, 'nope')).rescanned === false);
    {
        // Committed once, then many commits of code: the count says stale, so the first brief
        // rescans. The rescan is not committed, and the next brief must not scan again.
        const stale = path.join(tmpRoot, 'index-commits-behind');
        fs.mkdirSync(stale, { recursive: true });
        const sg = (...a) => execFileSync('git', a, { cwd: stale, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        sg('init', '-q'); sg('config', 'user.email', 's@t.test'); sg('config', 'user.name', 'S');
        fs.writeFileSync(path.join(stale, 'core.mjs'), 'export const boot = () => 0;\n');
        refreshIndexIfStale(stale);
        sg('add', '-A'); sg('commit', '-qm', 'index');
        for (let i = 1; i <= 32; i++) { fs.writeFileSync(path.join(stale, 'core.mjs'), `export const boot = () => ${i};\n`); sg('commit', '-qam', `c${i}`); }
        const past = new Date(Date.now() - 60_000);
        for (const f of ['CODEINDEX.md']) fs.utimesSync(path.join(stale, 'docs', 'ai', f), past, past);
        const behind = refreshIndexIfStale(stale);
        const again = refreshIndexIfStale(stale);
        check('an index far behind in commits is rescanned once, then left alone',
            behind.rescanned === true && behind.reason === 'stale' && again.rescanned === false, JSON.stringify({ behind, again }));
    }
    {
        const legacyDir = path.join(tmpRoot, 'legacy-index');
        fs.mkdirSync(path.join(legacyDir, 'docs', 'ai'), { recursive: true });
        fs.writeFileSync(path.join(legacyDir, 'package.json'), JSON.stringify({ name: 'legacy', type: 'module' }));
        fs.writeFileSync(path.join(legacyDir, 'app.js'), 'export const z = 1;\n');
        fs.writeFileSync(path.join(legacyDir, 'docs', 'ai', 'CODEINDEX.md'), '[app.js] exports: z\n');
        const migrated = refreshIndexIfStale(legacyDir);
        check('legacy single-file index is reshaped into shards',
            migrated.rescanned === true && migrated.reason === 'unsharded'
            && fs.existsSync(path.join(legacyDir, 'docs', 'ai', 'codeindex', '_root.md'))
            && fs.readFileSync(path.join(legacyDir, 'docs', 'ai', 'codeindex', '_root.md'), 'utf8').includes('export'),
            JSON.stringify(migrated));
    }

    // --- Graphify builds natively, or not at all -----------------------------------------
    // The first version shelled out to `python tools/graphify-builder.py`, which imported a
    // pip package this repo does not vendor: it could not run on a clean checkout or inside
    // the portable exe, and the runner discarded stderr, so it failed as a blank map with no
    // reason. These checks fail if either half of that comes back — an interpreter spawn in
    // the module, or a build that reports success without producing a graph.
    {
        const { buildProjectDocGraph, getProjectDocGraphStatus, cleanProjectGraph, renderGraphPage } =
            await import('../lib/graphify.mjs');
        const gDir = path.join(tmpRoot, 'graphify-fixture');
        fs.mkdirSync(path.join(gDir, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(gDir, 'app.mjs'), "import { helper } from './lib/util.mjs';\nexport const go = () => helper();\n");
        fs.writeFileSync(path.join(gDir, 'lib', 'util.mjs'), 'export const helper = () => 1;\n');

        const codeBuild = buildProjectDocGraph(gDir, 'code');
        check('graphify builds a code graph with no interpreter installed',
            codeBuild.success === true && codeBuild.nodeCount >= 2, JSON.stringify(codeBuild));
        check('graphify code graph draws the import as an edge',
            codeBuild.edgeCount >= 1, JSON.stringify(codeBuild));

        // CODE_EXTS advertises 20 languages; the extractor only understood JS/TS import
        // syntax, so C#, Python, Go, Java and the rest scanned to nodes with zero edges and
        // reported success — a blank map with no reason attached, the same failure the
        // Python runner above was replaced to stop. Non-JS files get symbol edges instead:
        // a file that names a type another file declares depends on it.
        fs.mkdirSync(path.join(gDir, 'cs'), { recursive: true });
        fs.writeFileSync(path.join(gDir, 'cs', 'HeatSystem.cs'),
            'namespace Demo {\n  public class HeatSystem {\n    public float Heat;\n  }\n}\n');
        fs.writeFileSync(path.join(gDir, 'cs', 'Furnace.cs'),
            'using Demo;\nnamespace Demo {\n  public class Furnace {\n    private HeatSystem heatSystem;\n  }\n}\n');
        fs.writeFileSync(path.join(gDir, 'app.py'),
            'class Widget:\n    pass\n');
        fs.writeFileSync(path.join(gDir, 'use.py'),
            'from app import Widget\n\ndef go():\n    return Widget()\n');
        // GDScript declares a type as `class_name Foo`, not `class Foo` — an underscore where
        // the pattern wants whitespace. Without .gd in CODE_EXTS a Godot project is not even
        // scanned, and without class_name in the declaration pattern it is scanned to nodes
        // whose only edges come from shared function names.
        fs.writeFileSync(path.join(gDir, 'inventory.gd'),
            'class_name Inventory\nextends Node\n\nvar slots = []\n');
        fs.writeFileSync(path.join(gDir, 'shop.gd'),
            'class_name Shop\nextends Node\n\nfunc buy():\n\tvar inv = Inventory.new()\n');
        // A name that appears only inside a multi-line docstring is talk about the code, not a
        // use of it. The single-line string strip left the interior lines of a `"""` block
        // standing, so this drew other.py -> store.py — the wrong edge the pass exists to refuse.
        // store.py also carries an indented `def`: a method, and a method name is the kind of
        // identifier an unrelated object elsewhere also answers to. Only column-0 functions
        // declare a symbol; with the indented form counted, `q.process()` in caller.py drew
        // caller.py -> store.py.
        fs.writeFileSync(path.join(gDir, 'store.py'),
            'class Store:\n    def process(self):\n        pass\n');
        fs.writeFileSync(path.join(gDir, 'other.py'),
            'def run():\n    """\n    Unrelated to Store, which lives elsewhere.\n    """\n    return 1\n');
        fs.writeFileSync(path.join(gDir, 'caller.py'),
            'q = Queue()\nq.process()\n');
        // A `#` inside a docstring. With comments stripped before strings, the `#` pass ate the
        // closing fence, the triple-quote pass then swallowed up to the next `"""` in the file,
        // and the `class Cache` below it vanished — so `Cache`, declared in two files, read as
        // declared in one, and uses_cache.py drew an edge to the wrong file.
        fs.writeFileSync(path.join(gDir, 'hashdoc.py'),
            '"""Item #1"""\n\nclass Cache:\n    pass\n');
        fs.writeFileSync(path.join(gDir, 'cache_too.py'),
            'class Cache:\n    pass\n');
        fs.writeFileSync(path.join(gDir, 'uses_cache.py'),
            'c = Cache()\n');

        const polyglot = buildProjectDocGraph(gDir, 'code');
        const polyLinks = JSON.parse(
            fs.readFileSync(path.join(gDir, 'graphify-out', 'code_graph.json'), 'utf8')).links;
        check('graphify draws an edge between two C# files that share no import path',
            polyLinks.some(l => l.source === 'cs/Furnace.cs' && l.target === 'cs/HeatSystem.cs'),
            JSON.stringify(polyLinks));
        check('graphify draws an edge for a Python symbol import',
            polyLinks.some(l => l.source === 'use.py' && l.target === 'app.py'),
            JSON.stringify(polyLinks));
        check('graphify scans GDScript at all — .gd is in CODE_EXTS',
            JSON.parse(fs.readFileSync(path.join(gDir, 'graphify-out', 'code_graph.json'), 'utf8'))
                .nodes.some(n => n.id === 'shop.gd'));
        check('graphify draws an edge from a GDScript class_name declaration',
            polyLinks.some(l => l.source === 'shop.gd' && l.target === 'inventory.gd'),
            JSON.stringify(polyLinks));
        check('graphify draws no edge from a name mentioned only inside a multi-line docstring',
            !polyLinks.some(l => l.source === 'other.py'),
            JSON.stringify(polyLinks.filter(l => l.source === 'other.py')));
        check('graphify draws no edge from a method name an unrelated object also answers to',
            !polyLinks.some(l => l.source === 'caller.py'),
            JSON.stringify(polyLinks.filter(l => l.source === 'caller.py')));
        check('graphify keeps an ambiguous name ambiguous when a docstring holds a `#`',
            !polyLinks.some(l => l.source === 'uses_cache.py'),
            JSON.stringify(polyLinks.filter(l => l.source === 'uses_cache.py')));
        check('graphify keeps resolving JS relative imports alongside symbol edges',
            polyLinks.some(l => l.source === 'app.mjs' && l.target === 'lib/util.mjs'),
            JSON.stringify(polyLinks));
        check('graphify says so when a scan finds files but no edges', (() => {
            const bare = path.join(tmpRoot, 'graphify-edgeless');
            fs.mkdirSync(bare, { recursive: true });
            fs.writeFileSync(path.join(bare, 'lonely.rb'), 'puts 1\n');
            const r = buildProjectDocGraph(bare, 'code');
            return r.success === true && r.edgeCount === 0 && /no edges/i.test(r.message || '');
        })());

        const codeStatus = getProjectDocGraphStatus(gDir, 'code');
        check('graphify status reads the graph back',
            codeStatus.exists === true && codeStatus.nodeCount === polyglot.nodeCount);
        check('graphify writes the html and report the routes serve',
            codeStatus.hasHtml === true && codeStatus.hasReport === true);
        check('graphify html loads the vendored library, not a CDN', (() => {
            const html = fs.readFileSync(path.join(gDir, 'graphify-out', 'code_graph.html'), 'utf8');
            return html.includes('/ui/vendor/vis-network.min.js') && !/https?:\/\//.test(html);
        })());

        // The map froze: physics was switched off for good on stabilizationIterationsDone, so a
        // dense graph stayed knotted in whatever shape the last iteration left and dragging a
        // node moved nothing but that node. Stopping the simulation is right; removing it is not.
        check('graphify html hands the layout simulation back to the reader', (() => {
            const html = fs.readFileSync(path.join(gDir, 'graphify-out', 'code_graph.html'), 'utf8');
            return html.includes('id="physics"') && /setPhysics\(/.test(html)
                && !/setOptions\(\{ physics: false \}\)/.test(html);
        })());
        // A flat iteration count under-solved every graph bigger than the one it was tuned on.
        check('graphify stabilization budget grows with the graph', (() => {
            const html = fs.readFileSync(path.join(gDir, 'graphify-out', 'code_graph.html'), 'utf8');
            return /stabilization: \{ iterations: ITERATIONS \}/.test(html)
                && /DATA\.nodes\.length \* \d+/.test(html);
        })());
        // The owner opened the graph to a black, empty canvas under a header that said 322 nodes:
        // vis draws nothing until the layout has settled (5.5 s there), and nothing said so.
        check('graphify page shows its progress while the layout settles', (() => {
            const html = fs.readFileSync(path.join(gDir, 'graphify-out', 'code_graph.html'), 'utf8');
            return html.includes('id="busy"') && html.includes("'stabilizationProgress'") && html.includes("'forceAtlas2Based'");
        })());
        check('graphify page follows the dashboard theme', (() => {
            const html = fs.readFileSync(path.join(gDir, 'graphify-out', 'code_graph.html'), 'utf8');
            return html.includes(':root[data-theme="dark"]') && html.includes("'plutos-mode'") && !html.includes('#0b0f19');
        })());
        // A graph built by an older version keeps its HTML copy; the dashboard draws today's page
        // from the graph data instead, so a page fix does not wait for a rebuild.
        check('the dashboard serves the graph page from the data, not a stale copy', (() => {
            const file = path.join(gDir, 'graphify-out', 'code_graph.html');
            const kept = fs.readFileSync(file, 'utf8');
            fs.writeFileSync(file, '<html>an old page</html>');
            const served = renderGraphPage(gDir);
            fs.writeFileSync(file, kept);
            return typeof served === 'string' && served.includes('/ui/vendor/vis-network.min.js') && !served.includes('an old page');
        })());

        const bogus = buildProjectDocGraph(gDir, 'sideways');
        check('graphify refuses an unknown mode instead of writing one',
            bogus.success === false && /sideways/.test(bogus.message || ''), JSON.stringify(bogus));

        check('graphify spawns no external interpreter', (() => {
            const src = fs.readFileSync(path.join(__dirname, 'lib', 'graphify.mjs'), 'utf8');
            return !/execFileSync|execSync|spawnSync|child_process/.test(src);
        })());

        // "Use this" is a project setting, not a browser one: the module switch beside it
        // lives in localStorage, which the MCP server cannot read, and the refresh has to
        // happen where the session starts.
        const { isGraphAutoRefresh, setGraphAutoRefresh, refreshGraphIfStale } =
            await import('../lib/graphify.mjs');
        check('auto-refresh is off until the project asks for it', isGraphAutoRefresh(gDir) === false);
        check('a project with no graph is left alone even so',
            refreshGraphIfStale(gDir).reason === 'not-enabled');

        fs.mkdirSync(path.join(gDir, '.plutos'), { recursive: true });
        fs.writeFileSync(path.join(gDir, '.plutos', 'plutos.config.json'),
            JSON.stringify({ stack: 'node' }));
        setGraphAutoRefresh(gDir, true);
        check('the setting persists in the project config', isGraphAutoRefresh(gDir) === true);
        check('turning it on preserves the rest of that config', (() => {
            const cfg = JSON.parse(fs.readFileSync(path.join(gDir, '.plutos', 'plutos.config.json'), 'utf8'));
            return cfg.stack === 'node' && cfg.graphifyAuto === true;
        })());

        // Never built is not stale — a first session must not be surprised by a build. Needs
        // its own directory: gDir already has graphs from the checks above.
        {
            const freshDir = path.join(tmpRoot, 'graphify-never-built');
            fs.mkdirSync(path.join(freshDir, '.plutos'), { recursive: true });
            fs.writeFileSync(path.join(freshDir, 'app.mjs'), 'export const x = 1;\n');
            setGraphAutoRefresh(freshDir, true);
            const untouched = refreshGraphIfStale(freshDir);
            check('enabled, but a graph that was never built is not created behind your back',
                untouched.refreshed.length === 0 && !fs.existsSync(path.join(freshDir, 'graphify-out')),
                JSON.stringify(untouched));
        }

        buildProjectDocGraph(gDir, 'code');
        // Also guards a loop worth naming: the graph writes its own GRAPH_REPORT.md, which is
        // newer than the graph beside it, so a scan that treats graphify-out as source finds
        // the graph stale the instant it is built and rebuilds it every session, forever.
        check('a current graph is left alone', refreshGraphIfStale(gDir).reason === 'current');
        check('the graph does not see its own output as newer source',
            refreshGraphIfStale(gDir).refreshed.length === 0);

        const builtAt = fs.statSync(path.join(gDir, 'graphify-out', 'code_graph.json')).mtimeMs;
        fs.writeFileSync(path.join(gDir, 'lib', 'added.mjs'), 'export const late = () => 2;\n');
        fs.utimesSync(path.join(gDir, 'lib', 'added.mjs'), new Date(builtAt + 60000), new Date(builtAt + 60000));
        const healed = refreshGraphIfStale(gDir);
        check('code moving past the graph rebuilds it at session start',
            healed.refreshed.includes('code'), JSON.stringify(healed));
        check('the rebuilt graph actually contains the new file',
            fs.readFileSync(path.join(gDir, 'graphify-out', 'code_graph.json'), 'utf8').includes('lib/added.mjs'));

        setGraphAutoRefresh(gDir, false);
        check('turning it off stops the refresh', refreshGraphIfStale(gDir).reason === 'not-enabled');

        cleanProjectGraph(gDir, 'all');
        check('graphify clean removes the generated output',
            !fs.existsSync(path.join(gDir, 'graphify-out')));
    }

    // --- Modules the suite never touched -------------------------------------------------
    // fs-browse serves the folder picker, so it is the endpoint that reaches furthest into
    // the disk; mcp-requests decides what gets written to a user's board. Both shipped untested.
    const { APP_ROOT, PLUTOS_HOME_DIR, defaultPlutosHome } = await import('../lib/approot.mjs');
    check('APP_ROOT resolves to the install root',
        APP_ROOT === __dirname && fs.existsSync(path.join(APP_ROOT, 'package.json')), APP_ROOT);
    check('explicit PLUTOS_HOME keeps tests and custom installs isolated',
        PLUTOS_HOME_DIR === path.resolve(process.env.PLUTOS_HOME), PLUTOS_HOME_DIR);
    check('Windows default app data is stable and independent of the executable folder',
        defaultPlutosHome({
            platform: 'win32',
            env: { LOCALAPPDATA: 'C:\\Users\\Owner\\AppData\\Local' },
            homeDir: 'C:\\Users\\Owner'
        }) === path.join('C:\\Users\\Owner\\AppData\\Local', 'PLUT_OS'));

    const { migrateLegacyAppData, registerCurrentInstall, readCurrentInstall } = await import('../lib/app-data.mjs');
    {
        const legacyApp = path.join(tmpRoot, 'legacy-app-data-source');
        const legacyHub = path.join(legacyApp, '.plutos');
        const stableHub = path.join(tmpRoot, 'stable-app-data-target');
        const legacyWorkspace = path.join(tmpRoot, 'legacy-workspace');
        const currentWorkspace = path.join(tmpRoot, 'current-workspace');
        fs.mkdirSync(path.join(legacyHub, 'workspaces', 'abc'), { recursive: true });
        fs.mkdirSync(stableHub, { recursive: true });
        fs.writeFileSync(path.join(legacyHub, 'hub_config.json'), JSON.stringify({
            workspaces: [legacyWorkspace], activeWorkspace: legacyWorkspace
        }));
        fs.writeFileSync(path.join(stableHub, 'hub_config.json'), JSON.stringify({
            workspaces: [currentWorkspace], activeWorkspace: currentWorkspace
        }));
        // auth.json is a file the old remote access wrote; it is no longer migrated.
        fs.writeFileSync(path.join(legacyHub, 'auth.json'), '{"legacy":true}');
        fs.writeFileSync(path.join(legacyHub, 'mcp_status.json'), '{"ephemeral":true}');
        fs.writeFileSync(path.join(legacyHub, 'workspaces', 'abc', 'observed.json'), '{"sourceRoot":"legacy"}');
        const migrated = migrateLegacyAppData({
            appRoot: legacyApp,
            legacyRoot: legacyHub,
            dataRoot: stableHub,
            explicitHome: false
        });
        const mergedHub = JSON.parse(fs.readFileSync(path.join(stableHub, 'hub_config.json'), 'utf8'));
        check('legacy app-data migration merges registrations without deleting the source',
            migrated.errors.length === 0
            && mergedHub.workspaces.includes(path.resolve(currentWorkspace))
            && mergedHub.workspaces.includes(path.resolve(legacyWorkspace))
            && fs.existsSync(path.join(legacyHub, 'hub_config.json')),
            JSON.stringify({ migrated, mergedHub }));
        check('migration copies only durable allowlisted Hub data',
            !fs.existsSync(path.join(stableHub, 'auth.json'))
            && fs.existsSync(path.join(stableHub, 'workspaces', 'abc', 'observed.json'))
            && !fs.existsSync(path.join(stableHub, 'mcp_status.json')),
            JSON.stringify(migrated.items));
        const firstInstall = path.join(tmpRoot, 'portable-v1');
        const movedInstall = path.join(tmpRoot, 'portable-v2');
        fs.mkdirSync(firstInstall, { recursive: true });
        fs.mkdirSync(movedInstall, { recursive: true });
        registerCurrentInstall({ appRoot: firstInstall, dataRoot: stableHub, packaged: true, now: () => '2026-01-01T00:00:00.000Z' });
        registerCurrentInstall({ appRoot: movedInstall, dataRoot: stableHub, packaged: true, now: () => '2026-01-02T00:00:00.000Z' });
        const currentInstall = readCurrentInstall(stableHub);
        check('launching a moved build atomically refreshes the stable install pointer',
            currentInstall?.appRoot === path.resolve(movedInstall)
            && currentInstall?.updatedAt === '2026-01-02T00:00:00.000Z',
            JSON.stringify(currentInstall));
    }

    const { listDirs } = await import('../lib/fs-browse.mjs');
    const rootListing = listDirs('');
    check('empty path lists drives/roots with no parent',
        Array.isArray(rootListing.dirs) && rootListing.dirs.length > 0 && rootListing.parent === null);
    const browseDir = path.join(tmpRoot, 'browse-me');
    fs.mkdirSync(path.join(browseDir, 'child-b'), { recursive: true });
    fs.mkdirSync(path.join(browseDir, 'child-a'), { recursive: true });
    fs.writeFileSync(path.join(browseDir, 'note.txt'), 'not a directory');
    const listing = listDirs(browseDir);
    check('listDirs returns directories only, sorted',
        listing.dirs.map(d => d.name).join() === 'child-a,child-b', JSON.stringify(listing.dirs));
    check('listDirs offers a walkable parent', typeof listing.parent === 'string' && listing.parent.length > 0);
    check('listDirs normalizes separators for the browser',
        !listing.path.includes('\\') && listing.dirs.every(d => !d.path.includes('\\')), listing.path);
    let listThrew = false;
    try { listDirs(path.join(tmpRoot, 'no-such-folder')); } catch (e) { listThrew = true; }
    check('a missing path surfaces as an error, not an empty listing', listThrew);

    const { requestMcpSetup } = await import('../lib/mcp-requests.mjs');
    const boardTemplate = path.join(__dirname, 'scaffold', 'docs', 'handoff', 'BOARD.md');
    const newBoardProject = (name) => {
        const dir = path.join(tmpRoot, name);
        fs.mkdirSync(path.join(dir, 'docs', 'handoff'), { recursive: true });
        fs.copyFileSync(boardTemplate, path.join(dir, 'docs', 'handoff', 'BOARD.md'));
        return dir;
    };
    const noBoardDir = path.join(tmpRoot, 'mcp-no-board');
    fs.mkdirSync(noBoardDir, { recursive: true });
    check('no board means nothing is requested',
        requestMcpSetup(noBoardDir, ['context-mode']).requested.length === 0);

    const reqDir = newBoardProject('mcp-request-project');
    const firstRequest = requestMcpSetup(reqDir, ['codebase-memory-mcp', 'context-mode']);
    check('both servers land on the board as requests',
        firstRequest.requested.join() === 'codebase-memory-mcp,context-mode', JSON.stringify(firstRequest));
    const requestBoard = fs.readFileSync(path.join(reqDir, 'docs', 'handoff', 'BOARD.md'), 'utf8');
    check('the request tells the AI to ask global-vs-local first',
        requestBoard.includes('ASK THE USER FIRST') && requestBoard.includes('TODO'));
    const secondRequest = requestMcpSetup(reqDir, ['codebase-memory-mcp', 'context-mode']);
    check('re-requesting the same servers is idempotent',
        secondRequest.requested.length === 0 && secondRequest.skipped.length === 2, JSON.stringify(secondRequest));
    const wiredRequest = requestMcpSetup(newBoardProject('mcp-wired-project'), ['context-mode'], { alreadyWired: new Set(['context-mode']) });
    check('a server already wired is never requested',
        wiredRequest.requested.length === 0 && wiredRequest.skipped.join() === 'context-mode');
    check('an unknown server id is skipped, not thrown',
        requestMcpSetup(reqDir, ['not-a-real-mcp']).skipped.join() === 'not-a-real-mcp');

    // 1a3. Recommendation engine: works with ZERO interview (structure-only projects get
    // real signal from the scan alone — react in package.json → frontend framework).
    const recs0 = await get('/api/recommendations');
    check('recommendations work without interview', recs0.hasInterview === false && recs0.signals.stack === 'node');
    check('react dependency detected', recs0.signals.frameworks.includes('react') && recs0.signals.hasFrontendDeps === true);
    check('the recommendation carries no role advice', !('roles' in recs0.recommendation) && Array.isArray(recs0.recommendation.reasons));

    // The one-click install route left on 2026-11-04 (it had nothing to install since the role
    // bundles went); a recommendation never queues a third-party MCP task on its own.
    const boardWithReq = fs.readFileSync(path.join(projectDir, 'docs', 'handoff', 'BOARD.md'), 'utf8');
    check('a recommendation leaves no hidden MCP task',
        !boardWithReq.includes('Set up the Codebase Memory MCP')
        && !boardWithReq.includes('Set up the Context Mode MCP'));
    const boardRole = await request(BASE + '/api/board?board=role');
    check('GET /api/board refuses an explicit unknown board', boardRole.status === 400
        && /Unknown board 'role'/.test((await boardRole.json()).message || ''));

    // 1b. Board endpoint sees the copied BOARD.md
    const board = await get('/api/board');
    check('board exists for new workspace', board.exists === true);

    // 1c. Remaining read endpoints answer sanely
    const html = await (await fetch(BASE + '/')).text();
    check('dashboard HTML served at /', html.includes('PLUT_OS'));
    const cssRes = await fetch(BASE + '/ui/styles.css');
    check('ui/styles.css served', cssRes.status === 200 && (await cssRes.text()).includes('--brand-primary'));
    const mainRes = await fetch(BASE + '/ui/main.js');
    check('ui/main.js served', mainRes.status === 200 && (await mainRes.text()).includes('fetchWorkspaces'));
    const modRes = await fetch(BASE + '/ui/modules/board.js');
    check('ui/modules/*.js served', modRes.status === 200 && (await modRes.text()).includes('fetchBoard'));
    const traversal = await fetch(BASE + '/ui/../dashboard.mjs');
    check('path traversal blocked', traversal.status === 404);
    const folder = await fetch(BASE + '/ui/modules');
    check('a folder URL is a 404 and the dashboard keeps serving', folder.status === 404
        && (await fetch(BASE + '/ui/main.js')).status === 200);

    // 1c1. Settings → Updates and the installable app. No check runs here: ?check=1 would fetch the
    // real upstream (tools/update-check-test.mjs covers it against scratch repositories).
    {
        const updateRes = await request(BASE + '/api/update');
        const update = await updateRes.json();
        check('GET /api/update answers this checkout, unchecked, without the network', updateRes.status === 200
            && ['checkout', 'submodule'].includes(update.kind) && update.state === 'unchecked' && typeof update.message === 'string', JSON.stringify(update));
        const blind = await request(BASE + '/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const blindBody = await blind.json();
        check('POST /api/update without a check is refused and changes nothing', blind.status === 409 && blindBody.success === false
            && /Check for updates first/.test(blindBody.message), JSON.stringify(blindBody));
        const sw = await fetch(BASE + '/sw.js');
        const swText = await sw.text();
        check('GET /sw.js: text/javascript, no-cache, Service-Worker-Allowed /', sw.status === 200
            && sw.headers.get('content-type') === 'text/javascript' && sw.headers.get('cache-control') === 'no-cache'
            && sw.headers.get('service-worker-allowed') === '/' && swText.includes("'navigate'") && swText.includes("'/api/'"), `${sw.status} ${[...sw.headers].join(' ')}`);
        const manifestRes = await fetch(BASE + '/ui/manifest.webmanifest');
        let manifest = null;
        try { manifest = JSON.parse(await manifestRes.text()); } catch { /* reported below */ }
        const big = manifest?.icons?.find(icon => icon.sizes === '512x512' && icon.type === 'image/png');
        const bigRes = big ? await fetch(BASE + big.src) : null;
        check('the manifest parses, is standalone from /, and lists a 512 icon that is served', manifestRes.status === 200 && manifest?.display === 'standalone'
            && manifest.start_url === '/' && manifest.id === '/' && !('orientation' in manifest) && bigRes?.status === 200
            && bigRes.headers.get('content-type') === 'image/png', JSON.stringify(manifest));
        check('the Settings page has the Updates and app cards and the boot registers the worker', html.includes('id="settings-updates"') && html.includes('id="settings-app"')
            && fs.readFileSync(path.join(__dirname, 'ui', 'main.js'), 'utf8').includes('initAppShell()'));
    }

    // 1c2. Cross-origin defense (H1): foreign Origin and foreign Host are both rejected
    const evilOrigin = await fetch(BASE + '/api/fs/list', { headers: { 'Origin': 'https://evil.example' } });
    check('cross-origin browser request rejected (403)', evilOrigin.status === 403);
    const evilPost = await fetch(BASE + '/api/workspaces/add', {
        method: 'POST',
        headers: { 'Origin': 'https://evil.example', 'Content-Type': 'text/plain' },
        body: JSON.stringify({ path: projectDir })
    });
    check('cross-origin simple POST rejected (403)', evilPost.status === 403);
    // Host is a forbidden fetch header (undici won't override it), so use raw http to spoof it.
    const evilHostStatus = await new Promise((resolve) => {
        const r = httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/fs/list', headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
        r.on('error', () => resolve(0));
        r.end();
    });
    check('DNS-rebinding Host rejected (403)', evilHostStatus === 403);
    const sameOrigin = await fetch(BASE + '/api/fs/list', { headers: { 'Origin': `http://127.0.0.1:${PORT}` } });
    check('same-origin request still allowed', sameOrigin.status === 200);

    // 1c3. A local reverse proxy or tunnel (Tailscale Serve, cloudflared, nginx) connects from
    // loopback but adds a forwarding header. That request is remote, and there is nothing it
    // could present instead: every route refuses it, the liveness route and GET / included.
    const forwardingHeaders = { 'X-Forwarded-For': '203.0.113.9', 'Forwarded': 'for=203.0.113.9', 'X-Real-IP': '203.0.113.9',
        'Tailscale-User-Login': 'someone@example.com', 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For-Empty': '' };
    const proxiedAnon = await Promise.all(Object.entries(forwardingHeaders).map(async ([name, value]) => {
        const header = name === 'X-Forwarded-For-Empty' ? 'X-Forwarded-For' : name;
        const r = await request(BASE + '/api/fs/list', { headers: { [header]: value } });
        return { name, status: r.status, success: (await r.json()).success };
    }));
    check('a proxied loopback request is refused with 403, for every forwarding header, an empty one included',
        proxiedAnon.every(r => r.status === 403 && r.success === false), JSON.stringify(proxiedAnon));
    const proxiedPage = await request(BASE + '/', { headers: PROXIED_IP });
    const proxiedLive = await request(BASE + '/api/auth/status', { headers: PROXIED_IP });
    check('a proxied request gets no page and no liveness answer either', proxiedPage.status === 403 && proxiedLive.status === 403,
        `${proxiedPage.status} ${proxiedLive.status}`);
    const localStatus = await get('/api/auth/status');
    check('plain loopback is the owner: the liveness route says so and names the port',
        localStatus.loopback === true && localStatus.authenticated === true && localStatus.port === PORT, JSON.stringify(localStatus));

    // 1c4. Request bodies are bounded: an oversized body is refused at the limit instead of buffered.
    const oversize = JSON.stringify({ text: 'x'.repeat(1024 * 1024) });
    const bigBody = await request(BASE + '/api/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: oversize });
    check('an oversize JSON body is refused with 413', bigBody.status === 413, String(bigBody.status));
    // No Content-Length: the body is counted as it arrives. /api/ideas reads it before its own
    // try, so this also proves the refusal reaches the client as 413, not the dispatcher's 500.
    // Both oversize bodies end a few bytes past the limit, so almost nothing is still in flight
    // when the dashboard answers and closes; a reset before the answer is retried once, as in
    // request() above.
    const sendChunked = () => new Promise((resolve) => {
        const r = httpRequest({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/ideas', headers: { 'Content-Type': 'application/json' } },
            res => { res.resume(); resolve(res.statusCode); });
        r.on('error', () => resolve(0));
        const piece = 'x'.repeat(64 * 1024);
        r.write('{"text":"');
        for (let i = 0; i < 16; i++) r.write(piece);
        r.end('"}');
    });
    const chunkedStatus = (await sendChunked()) || (await sendChunked());
    check('a chunked oversize body with no length is cut off at the limit with 413, not 500', chunkedStatus === 413, String(chunkedStatus));
    check('the dashboard keeps serving after oversize bodies',
        server.exitCode === null && (await request(BASE + '/api/workspaces')).status === 200);
    const normalBody = await post('/api/ideas', { text: 'A normal body after the refusals.', padding: 'x'.repeat(512 * 1024) });
    check('a normal body, even half the limit, is still read after the refusals',
        normalBody.success === true && normalBody.action === 'added', JSON.stringify(normalBody).slice(0, 200));
    const fsList = await get('/api/fs/list');
    check('fs/list root listing', fsList.success === true && Array.isArray(fsList.dirs));
    const rec = await get('/api/recommended-mcps');
    check('recommended mcps answers', Array.isArray(rec.recommended) && Array.isArray(rec.fullList));

    // 1d. MCP install (the Connect panel's extra tools; the AI tools page left on 2026-11-04).
    const recMcp = rec.fullList[0];
    const mcpInstall = await post('/api/install-recommended-mcp', { id: recMcp.id, config: recMcp.config });
    check('recommended mcp install', mcpInstall.success === true, mcpInstall.message);
    check('the install says Claude Code will ask for approval', /approve/.test(mcpInstall.message || ''), mcpInstall.message);
    const mcpJson = () => JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
    check('mcp written to .mcp.json', !!mcpJson().mcpServers[recMcp.id]);
    check('the external Graphify is no longer recommended', !rec.fullList.some(m => m.id === 'graphify'));
    // 1e. Workspace switch round-trip (+ opt-in interview on add)
    const projectDir2 = path.join(tmpRoot, 'demo-project-2');
    fs.mkdirSync(projectDir2, { recursive: true });
    const secondAdd = await post('/api/workspaces/add', { path: projectDir2, withInterview: true });
    check('opt-in interview stays in the local observe store',
        fs.existsSync(path.join(secondAdd.storageRoot, 'docs', 'handoff', 'PROJECT_INTERVIEW.md'))
        && !fs.existsSync(path.join(projectDir2, 'docs', 'handoff', 'PROJECT_INTERVIEW.md')));
    const localTask = await post('/api/board', {
        agent: 'owner', status: 'TODO', title: 'Keep this observed task',
        task: 'Migrate me only when the owner installs the project kit.'
    });
    check('an observed task is recorded only in Hub storage', localTask.success === true
        && fs.readFileSync(path.join(secondAdd.storageRoot, 'docs', 'handoff', 'BOARD.md'), 'utf8').includes('Keep this observed task')
        && !fs.existsSync(path.join(projectDir2, 'docs', 'handoff', 'BOARD.md')));
    await post('/api/project/install', {});
    check('explicit kit install migrates the local interview', fs.existsSync(path.join(projectDir2, 'docs', 'handoff', 'PROJECT_INTERVIEW.md')));
    check('explicit kit install migrates the local task board',
        fs.readFileSync(path.join(projectDir2, 'docs', 'handoff', 'BOARD.md'), 'utf8').includes('Keep this observed task'));
    const notDir = path.join(projectDir2, 'AGENTS.md');
    const addFile = await post('/api/workspaces/add', { path: notDir });
    check('adding a file path rejected', addFile.success === false);
    const sw = await post('/api/workspaces/switch', { path: projectDir });
    check('workspace switch back', sw.success === true && sw.activeWorkspace === projectDir);

    // 1e-a. The same folder spelled differently (trailing slash, redundant segment) is ONE
    // workspace — it used to register twice and install into the project twice.
    const dupAdd = await post('/api/workspaces/add', { path: projectDir2 + '/./' });
    const sameFolder = (w) => w.replace(/\\/g, '/').replace(/(\/\.?)+$/, '').endsWith('demo-project-2');
    const dupCount = (dupAdd.workspaces || []).filter(sameFolder).length;
    // Registered paths keep the platform's own separators: callers compare what the API returns
    // against their own path.join output, so normalizing `\` to `/` would break them on Windows.
    check('registered path keeps native separators',
        (dupAdd.workspaces || []).includes(path.resolve(projectDir2)), JSON.stringify(dupAdd.workspaces));
    check('same folder re-added does not duplicate', dupAdd.success === true && dupCount === 1, JSON.stringify(dupAdd.workspaces));
    // ...and switch/remove still resolve a differently-spelled path to that one entry.
    const swAlt = await post('/api/workspaces/switch', { path: projectDir2 + '/' });
    check('switch resolves an equivalent path', swAlt.success === true);
    await post('/api/workspaces/remove', { path: projectDir2 });

    // 1e-b. Observe mode never parses or rewrites an existing client config. Explicit
    // connection still refuses malformed JSON rather than clobbering it.
    const brokenDir = path.join(tmpRoot, 'broken-project');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, '.mcp.json'), '{ not json');
    const brokenAdd = await post('/api/workspaces/add', { path: brokenDir, installPlutosMcp: true });
    const afterBroken = await get('/api/workspaces');
    check('malformed MCP config does not block read-only add', brokenAdd.success === true && brokenAdd.mode === 'observed');
    check('read-only add leaves malformed MCP config byte-identical', fs.readFileSync(path.join(brokenDir, '.mcp.json'), 'utf8') === '{ not json');
    check('observed workspace is registered normally', afterBroken.workspaces.some(w => w.endsWith('broken-project')));
    await post('/api/project/install', {});
    const brokenConnect = await post('/api/connect', { client: 'claude-code', projectRoot: brokenDir });
    check('explicit connect refuses malformed MCP config', brokenConnect.success === false
        && fs.readFileSync(path.join(brokenDir, '.mcp.json'), 'utf8') === '{ not json');
    await post('/api/workspaces/remove', { path: brokenDir });
    await post('/api/workspaces/switch', { path: projectDir });

    // 1e-c. Legacy server flags cannot smuggle installation into Add Project.
    const requestDir = path.join(tmpRoot, 'request-only-project');
    fs.mkdirSync(requestDir, { recursive: true });
    const reqAdd = await post('/api/workspaces/add', { path: requestDir, installMemoryMcp: true });
    check('request-only add succeeds', reqAdd.success === true, reqAdd.message);
    check('request flag writes no MCP or board into source', !fs.existsSync(path.join(requestDir, '.mcp.json'))
        && !fs.existsSync(path.join(requestDir, 'docs', 'handoff', 'BOARD.md')));
    check('request flag does not post a hidden local task',
        !fs.readFileSync(path.join(reqAdd.storageRoot, 'docs', 'handoff', 'BOARD.md'), 'utf8').includes('codebase-memory-mcp'));
    await post('/api/workspaces/remove', { path: requestDir });
    await post('/api/workspaces/switch', { path: projectDir });

    // 1e-d. Add never edits .gitignore. The explicit kit install owns machine-specific ignores.
    const gitDir = path.join(tmpRoot, 'ignore-repo-project');
    fs.mkdirSync(gitDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: gitDir });
    const gitAdd = await post('/api/workspaces/add', { path: gitDir });
    check('observing a git repo does not create .gitignore', !fs.existsSync(path.join(gitDir, '.gitignore')));
    const gitKit = await post('/api/project/install', {});
    const gitIgnoreText = () => fs.readFileSync(path.join(gitDir, '.gitignore'), 'utf8');
    check('explicit kit install reports the entries it added',
        gitKit.ignores && gitKit.ignores.state === 'added' && gitKit.ignores.entries.includes('.plutos/local.json'),
        JSON.stringify(gitKit.ignores));
    check('machine-specific entries land in .gitignore',
        fs.existsSync(path.join(gitDir, '.gitignore')) && gitIgnoreText().includes('.plutos/local.json'));
    // Add stays read-only even after installation; it must not stack a second ignore block.
    const readd = await post('/api/workspaces/add', { path: gitDir });
    check('re-add does not duplicate the ignore block',
        gitIgnoreText().split('.plutos/local.json').length - 1 === 1, gitIgnoreText());

    // A plain folder: no .gitignore written, but the owner is told what to add if they ever
    // run `git init` there. Silent would mean their first push leaks a machine path.
    const plainDir = path.join(tmpRoot, 'plain-folder-project');
    fs.mkdirSync(plainDir, { recursive: true });
    const plainAdd = await post('/api/workspaces/add', { path: plainDir });
    check('non-repo add writes no .gitignore', !fs.existsSync(path.join(plainDir, '.gitignore')));

    // An observed folder remains read-only even if it later becomes a repo; Repair must skip
    // it. The explicit kit install then adds the ignore entries.
    execFileSync('git', ['init', '-q'], { cwd: plainDir });
    const repairAfterInit = await get(`/api/workspaces/repair/preview?project=${encodeURIComponent(plainDir)}`);
    const skippedObserved = !(repairAfterInit.ignoresAdded || []).some(i => i.path === path.resolve(plainDir));
    check('repair skips an observed project', skippedObserved && !fs.existsSync(path.join(plainDir, '.gitignore')),
        JSON.stringify(repairAfterInit.ignoresAdded));
    const plainKit = await post('/api/project/install', {});
    check('explicit install after git init writes the entries', plainKit.success === true
        &&
        fs.existsSync(path.join(plainDir, '.gitignore'))
        && fs.readFileSync(path.join(plainDir, '.gitignore'), 'utf8').includes('.plutos/local.json'));
    await post('/api/workspaces/remove', { path: plainDir });
    await post('/api/workspaces/remove', { path: gitDir });
    await post('/api/workspaces/switch', { path: projectDir });

    // 1e-e. Connecting an AI is explicit and client-specific. Every vendor reads a different
    // scope/file; Add Project chooses none of them.
    const conn = await get('/api/connect');
    const client = (id) => (conn.clients || []).find(c => c.id === id);
    check('connect plan lists the active project', conn.project === path.basename(projectDir), conn.project);
    check('Claude team connection is reported as wired after explicit setup',
        client('claude-code') && client('claude-code').wired === true,
        JSON.stringify(client('claude-code')));
    check('Claude private/local scope is offered separately',
        client('claude-code-local')?.scope === 'local'
        && client('claude-code-local')?.path.endsWith('.claude.json')
        && client('claude-code-local')?.canWrite === false,
        JSON.stringify(client('claude-code-local')));
    // The three that used to look broken.
    check('Cursor is listed and points at .cursor/mcp.json, not .mcp.json',
        client('cursor') && client('cursor').path.endsWith(path.join('.cursor', 'mcp.json')),
        client('cursor') && client('cursor').path);
    check('VS Code is listed at .vscode/mcp.json',
        client('vscode') && client('vscode').path.endsWith(path.join('.vscode', 'mcp.json')));
    check('Windsurf is listed as machine-scoped, not project-scoped',
        client('windsurf') && client('windsurf').scope === 'global');
    check('Codex is listed as project-scoped TOML',
        client('codex') && client('codex').format === 'toml' && client('codex').scope === 'project'
        && client('codex').path.endsWith(path.join('.codex', 'config.toml')),
        JSON.stringify(client('codex')));
    check('an unwired client says so', client('cursor').wired === false);
    check('Antigravity is listed at its documented workspace profile',
        client('antigravity')?.path.endsWith(path.join('.agents', 'mcp_config.json'))
        && client('antigravity')?.scope === 'project', JSON.stringify(client('antigravity')));

    // A relative path in args only works if the tool happens to spawn the server with the
    // project as its cwd, and almost no vendor documents that. Each client must therefore use
    // the mechanism it actually promises — otherwise the server silently never starts, which
    // is indistinguishable from "PLUT_OS is broken".
    check('Cursor uses documented fields without assuming an undocumented workspace token', (() => {
        const entry = JSON.parse(client('cursor').snippet).mcpServers.plutos;
        return path.isAbsolute(entry.args[0]) && sameProjectPath(entry.env.PLUTOS_PROJECT_ROOT, projectDir);
    })(), client('cursor').snippet);
    check('VS Code gets the same token', client('vscode').snippet.includes('${workspaceFolder}/'));
    check('Gemini CLI gets an explicit cwd instead', (() => {
        const parsed = JSON.parse(client('gemini-cli').snippet);
        return parsed.mcpServers.plutos.cwd === path.resolve(projectDir);
    })(), client('gemini-cli').snippet);
    check('Antigravity gets its documented stdio cwd', (() => {
        const parsed = JSON.parse(client('antigravity').snippet);
        return parsed.mcpServers.plutos.cwd === path.resolve(projectDir);
    })(), client('antigravity').snippet);
    // These three have no project concept at all — a relative path would point at whatever
    // folder the tool happened to be in.
    for (const id of ['windsurf', 'zed', 'claude-desktop']) {
        const parsed = JSON.parse(client(id).snippet);
        const bucket = id === 'zed' ? parsed.context_servers : parsed.mcpServers;
        const launcher = bucket?.plutos?.args?.[0] || '';
        check(`${client(id).name} gets an absolute path (it has no project scope)`,
            path.isAbsolute(launcher)
            && sameProjectPath(path.dirname(path.dirname(launcher)), conn.projectRoot),
            client(id).snippet);
    }
    check('Claude Desktop also gets PLUTOS_PROJECT_ROOT, since chat has no project folder',
        client('claude-desktop').snippet.includes('PLUTOS_PROJECT_ROOT'));

    // Vendor one-click links, where the vendor publishes one — better than any file PLUT_OS
    // can write, because the tool ingests it itself.
    check('Cursor offers its install deeplink', (client('cursor').deeplink || '').startsWith('cursor://anysphere.cursor-deeplink/mcp/install?'));
    check('the deeplink carries the same config the panel shows', (() => {
        const url = new URL(client('cursor').deeplink);
        const decoded = JSON.parse(Buffer.from(decodeURIComponent(url.searchParams.get('config')), 'base64').toString());
        // Cursor gets this machine's node.exe, not a bare "node": its entry is already
        // machine-specific (absolute project path), and a GUI app's PATH can go stale
        // relative to a Node install/update until the app restarts — an absolute command
        // always resolves. See lib/connect.mjs stdioEntry().
        return decoded.command === process.execPath
            && sameProjectPath(path.dirname(path.dirname(decoded.args[0])), projectDir)
            && decoded.env.PLUTOS_PROJECT_ROOT === projectDir;
    })(), client('cursor').deeplink);
    check('VS Code offers its own scheme', (client('vscode').deeplink || '').startsWith('vscode:mcp/install?'));

    // Codex now supports project config. Creating a missing project TOML is safe and prevents
    // one global `plutos` entry from leaking into every repository. Existing TOML is still
    // never merged without a parser.
    check('Codex project config can be created when missing', client('codex').canWrite === true);
    check('Codex TOML uses a relative launcher and the project-scope safety marker',
        client('codex').snippet.includes('args = [".plutos/plutos-launch.mjs"]')
        && client('codex').snippet.includes('PLUTOS_CODEX_PROJECT_CONFIG = "1"')
        && !client('codex').snippet.includes(conn.projectRoot), client('codex').snippet);
    check('Codex no longer offers the global codex mcp add command', client('codex').command === null);
    const codexWired = await post('/api/connect', { client: 'codex', projectRoot: projectDir });
    check('setting up Codex writes only this projects config', codexWired.success === true, codexWired.message);
    const codexTomlPath = path.join(projectDir, '.codex', 'config.toml');
    const codexToml = fs.readFileSync(codexTomlPath, 'utf8');
    check('written Codex TOML is machine-independent and marked project-scoped',
        codexToml.includes('[mcp_servers.plutos]')
        && codexToml.includes('PLUTOS_CODEX_PROJECT_CONFIG = "1"')
        && !codexToml.includes(conn.projectRoot), codexToml);
    check('Codex reports wired after project config is written',
        (codexWired.clients || []).find(c => c.id === 'codex')?.wired === true);
    {
        const { wireClient, connectionPlan } = await import('../lib/connect.mjs');
        const existingTomlProject = path.join(tmpRoot, 'existing-codex-toml');
        const existingTomlPath = path.join(existingTomlProject, '.codex', 'config.toml');
        fs.mkdirSync(path.join(existingTomlProject, '.plutos'), { recursive: true });
        fs.writeFileSync(path.join(existingTomlProject, '.plutos', 'plutos-launch.mjs'), '// test launcher\n');
        fs.mkdirSync(path.dirname(existingTomlPath), { recursive: true });
        const ownerToml = 'model = "owner-choice"\n';
        fs.writeFileSync(existingTomlPath, ownerToml, 'utf8');
        let refusedTomlMerge = false;
        try { wireClient('codex', existingTomlProject); }
        catch (e) { refusedTomlMerge = /will not merge TOML/.test(e.message); }
        check('existing Codex TOML is refused instead of overwritten',
            refusedTomlMerge && fs.readFileSync(existingTomlPath, 'utf8') === ownerToml);

        const legacyProject = path.join(tmpRoot, 'legacy-codex-project');
        const legacyToml = path.join(legacyProject, '.codex', 'config.toml');
        fs.mkdirSync(path.join(legacyProject, '.plutos'), { recursive: true });
        fs.mkdirSync(path.dirname(legacyToml), { recursive: true });
        fs.writeFileSync(path.join(legacyProject, '.plutos', 'plutos-launch.mjs'), '// test launcher\n');
        fs.writeFileSync(legacyToml,
            'model = "owner-choice"\n\n[mcp_servers.plutos]\ncommand = "node"\nargs = [".plutos/plutos-launch.mjs"]\n', 'utf8');
        const legacyRepair = wireClient('codex', legacyProject);
        const legacyAfter = fs.readFileSync(legacyToml, 'utf8');
        check('legacy project-local Codex binding gets the narrow trust-marker migration',
            legacyRepair.repaired === true
            && legacyAfter.includes('model = "owner-choice"')
            && legacyAfter.includes('PLUTOS_CODEX_PROJECT_CONFIG = "1"'), legacyAfter);

        // Detect the old global shape without reading or changing this machine's real Codex
        // config: home() is evaluated per call, so a temporary isolated home is sufficient.
        const previousProfile = process.env.USERPROFILE;
        const fakeHome = path.join(tmpRoot, 'fake-codex-home');
        const fakeGlobal = path.join(fakeHome, '.codex', 'config.toml');
        fs.mkdirSync(path.dirname(fakeGlobal), { recursive: true });
        fs.writeFileSync(fakeGlobal,
            '[mcp_servers.plutos]\ncommand = "node"\nargs = [".plutos/plutos-launch.mjs"]\ncwd = "C:/old-project"\n', 'utf8');
        process.env.USERPROFILE = fakeHome;
        const warnedCodex = connectionPlan(projectDir).find(c => c.id === 'codex');
        if (previousProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousProfile;
        check('Connect plan warns about a legacy global Codex entry without changing it',
            /Legacy global PLUT_OS entry/.test(warnedCodex.warning || '')
            && fs.readFileSync(fakeGlobal, 'utf8').includes('C:/old-project'), warnedCodex.warning || '');
    }

    // Automatic shared context is explicit, project-private, and merge-safe.
    const autoApiBefore = await get('/api/context/automation');
    check('automatic capture is offered only after Claude is project-connected',
        autoApiBefore.available === true && autoApiBefore.enabled === false, JSON.stringify(autoApiBefore));
    const autoApiEnabled = await post('/api/context/automation', { enabled: true });
    check('automatic capture can be explicitly enabled', autoApiEnabled.success === true && autoApiEnabled.enabled === true,
        autoApiEnabled.message);
    const projectLocalSettings = path.join(projectDir, '.claude', 'settings.local.json');
    const projectHooks = JSON.parse(fs.readFileSync(projectLocalSettings, 'utf8')).hooks;
    check('automatic capture installs only project-local PreCompact and SessionEnd MCP hooks',
        ['PreCompact', 'SessionEnd'].every(event => projectHooks[event]?.some(group =>
            group.hooks?.some(hook => hook.type === 'mcp_tool' && hook.server === 'plutos'
                && hook.tool === 'plutos_capture_session'))));
    const autoApiDisabled = await post('/api/context/automation', { enabled: false });
    check('automatic capture can be disabled without uninstalling PLUT_OS',
        autoApiDisabled.success === true && autoApiDisabled.enabled === false);

    {
        const { setContextAutomation, contextAutomationStatus } = await import('../lib/context-automation.mjs');
        const autoDir = path.join(tmpRoot, 'automation-merge');
        fs.mkdirSync(path.join(autoDir, '.git'), { recursive: true });
        fs.mkdirSync(path.join(autoDir, '.claude'), { recursive: true });
        const autoSettings = path.join(autoDir, '.claude', 'settings.local.json');
        fs.writeFileSync(autoSettings, JSON.stringify({
            permissions: { allow: ['Read'] },
            hooks: { Notification: [{ hooks: [{ type: 'command', command: 'notify-owner' }] }] }
        }, null, 2) + '\n');
        const firstEnable = setContextAutomation(autoDir, true);
        const enabledBytes = fs.readFileSync(autoSettings, 'utf8');
        const secondEnable = setContextAutomation(autoDir, true);
        check('hook enable preserves unrelated settings and hooks',
            JSON.parse(enabledBytes).permissions.allow[0] === 'Read'
            && JSON.parse(enabledBytes).hooks.Notification[0].hooks[0].command === 'notify-owner');
        check('hook enable is idempotent', secondEnable.changed === false
            && fs.readFileSync(autoSettings, 'utf8') === enabledBytes);
        const tamperedHooks = JSON.parse(enabledBytes);
        tamperedHooks.hooks.PreCompact[0].hooks[0].input.cwd = '${wrong_cwd}';
        fs.writeFileSync(autoSettings, JSON.stringify(tamperedHooks, null, 2) + '\n');
        check('automation status rejects a look-alike hook with the wrong input contract',
            contextAutomationStatus(autoDir).enabled === false);
        const repairedHook = setContextAutomation(autoDir, true);
        check('enabling again repairs a partial or tampered hook contract',
            repairedHook.enabled === true
            && JSON.parse(fs.readFileSync(autoSettings, 'utf8')).hooks.PreCompact[0].hooks[0].input.cwd === '${cwd}');
        check('private hook setting is gitignored on explicit enable',
            fs.readFileSync(path.join(autoDir, '.gitignore'), 'utf8').split(/\r?\n/).includes('.claude/settings.local.json'));
        setContextAutomation(autoDir, false);
        const disabledSettings = JSON.parse(fs.readFileSync(autoSettings, 'utf8'));
        check('hook disable removes only PLUT_OS handlers',
            contextAutomationStatus(autoDir).enabled === false
            && disabledSettings.hooks.Notification[0].hooks[0].command === 'notify-owner'
            && !disabledSettings.hooks.PreCompact && !disabledSettings.hooks.SessionEnd);

        fs.writeFileSync(autoSettings, '{ malformed', 'utf8');
        const malformedBefore = fs.readFileSync(autoSettings, 'utf8');
        let malformedAutomationRefused = false;
        try { setContextAutomation(autoDir, true); } catch (e) { malformedAutomationRefused = /invalid JSON/.test(e.message); }
        check('malformed Claude settings are refused byte-identically',
            malformedAutomationRefused && fs.readFileSync(autoSettings, 'utf8') === malformedBefore);
        check('automation status reports malformed settings instead of guessing',
            !!contextAutomationStatus(autoDir).error && firstEnable.enabled === true);
    }

    {
        const {
            enqueueContextCapture, extractTranscriptText, transcriptHasManualSessionEnd, contextCaptureStatus
        } = await import('../lib/context-capture.mjs');
        const fakeClaudeRoot = path.join(tmpRoot, 'capture-claude-home');
        const transcript = path.join(fakeClaudeRoot, 'projects', 'mixi', 'session.jsonl');
        fs.mkdirSync(path.dirname(transcript), { recursive: true });
        fs.writeFileSync(transcript, [
            JSON.stringify({ type: 'system', content: 'private system block' }),
            JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Build the safe mapper. Token sk-ant-ABCDEFGHIJKLMNO must never persist.' }] } }),
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
                { type: 'thinking', thinking: 'secret chain' },
                { type: 'text', text: 'The mapper is complete.' },
                { type: 'tool_use', name: 'Write', input: { file_path: 'x' } }
            ] } }),
            JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'raw tool result' }] } })
        ].join('\n') + '\n');
        const extracted = extractTranscriptText(transcript);
        check('capture extraction keeps bounded user/assistant text only',
            extracted.includes('Build the safe mapper') && extracted.includes('mapper is complete')
            && !extracted.includes('private system') && !extracted.includes('secret chain')
            && !extracted.includes('raw tool result'));
        check('capture extraction redacts obvious credentials before model intake',
            extracted.includes('[REDACTED_TOKEN]') && !extracted.includes('sk-ant-ABCDEFGHIJKLMNO'));

        const jobsHome = path.join(tmpRoot, 'capture-hub');
        const captureInput = {
            session_id: 'session-1', transcript_path: transcript, cwd: projectDir, event: 'PreCompact', trigger: 'auto'
        };
        const queued = enqueueContextCapture(projectDir, captureInput, {
            env: { CLAUDE_CONFIG_DIR: fakeClaudeRoot }, homeDir: jobsHome, spawnWorker: false
        });
        const queuedFiles = fs.readdirSync(path.join(jobsHome, 'context-jobs'), { recursive: true })
            .filter(name => String(name).endsWith('.queued.json'));
        check('capture hook enqueues outside the target project and returns immediately',
            queued.queued === true && queuedFiles.length === 1
            && !fs.readdirSync(projectDir, { recursive: true }).some(name => String(name).includes('.queued.json')));
        const captureStatus = contextCaptureStatus(projectDir, jobsHome);
        check('capture queue status is visible without leaking project or transcript paths',
            captureStatus.queued === 1 && captureStatus.last?.state === 'queued'
            && !JSON.stringify(captureStatus).includes(projectDir)
            && !JSON.stringify(captureStatus).includes(transcript), JSON.stringify(captureStatus));
        const duplicateCapture = enqueueContextCapture(projectDir, captureInput, {
            env: { CLAUDE_CONFIG_DIR: fakeClaudeRoot }, homeDir: jobsHome, spawnWorker: false
        });
        check('the same lifecycle event cannot enqueue twice', duplicateCapture.duplicate === true);

        const manualTranscript = path.join(fakeClaudeRoot, 'projects', 'mixi', 'manual.jsonl');
        fs.writeFileSync(manualTranscript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
            { type: 'tool_use', name: 'mcp__plutos__session_end', input: { ai: 'claude' } }
        ] } }) + '\n');
        check('manual session_end is detectable so final auto-capture can skip duplication',
            transcriptHasManualSessionEnd(manualTranscript) === true);

        const outsideTranscript = path.join(tmpRoot, 'outside-claude.jsonl');
        fs.writeFileSync(outsideTranscript, '{}\n');
        let outsideTranscriptRefused = false;
        try {
            enqueueContextCapture(projectDir, { ...captureInput, transcript_path: outsideTranscript }, {
                env: { CLAUDE_CONFIG_DIR: fakeClaudeRoot }, homeDir: jobsHome, spawnWorker: false
            });
        } catch (e) { outsideTranscriptRefused = /outside Claude/.test(e.message); }
        check('capture refuses a transcript path outside Claude storage', outsideTranscriptRefused);
        let foreignCwdRefused = false;
        try {
            enqueueContextCapture(projectDir, { ...captureInput, cwd: tmpRoot }, {
                env: { CLAUDE_CONFIG_DIR: fakeClaudeRoot }, homeDir: jobsHome, spawnWorker: false
            });
        } catch (e) { foreignCwdRefused = /outside this PLUT_OS project/.test(e.message); }
        check('capture refuses a hook cwd from another project', foreignCwdRefused);

        const { automaticSessionPayload } = await import('../lib/context-worker.mjs');
        const automaticPayload = automaticSessionPayload({ id: 'job-1', event: 'SessionEnd' }, {
            headline: 'Automatic handoff', did: 'Work happened', changed: 'files', next: 'verify',
            story: 'No work was lost.', learned: [], decided: ['Treat this as binding case law.']
        });
        check('automatic transcript extraction cannot write binding decisions',
            Array.isArray(automaticPayload.decided) && automaticPayload.decided.length === 0);
    }
    // The snippet a user pastes by hand must be the same wiring the button writes, or the
    // manual route silently produces something different from the automatic one.
    check('the copy-paste snippet is valid JSON naming the plutos server', (() => {
        const parsed = JSON.parse(client('cursor').snippet);
        return !!(parsed.mcpServers && parsed.mcpServers.plutos);
    })());
    check('VS Code snippet uses its own "servers" key, not "mcpServers"', (() => {
        const parsed = JSON.parse(client('vscode').snippet);
        return !!(parsed.servers && parsed.servers.plutos && parsed.servers.plutos.type === 'stdio');
    })());

    // The paste-into-the-AI route. It has to carry the path AND the exact JSON, because for
    // a machine-scoped tool (or one not listed at all) it is the only route PLUT_OS has.
    check('each client offers a prompt to paste into that AI', (conn.clients || []).every(c => c.prompt && c.prompt.length > 40));
    check('the prompt names the file and carries the entry', (() => {
        const p = client('cursor').prompt;
        return p.includes(path.join('.cursor', 'mcp.json')) && p.includes('"plutos"') && p.includes('plutos-launch.mjs');
    })(), client('cursor').prompt);
    // Merge, never replace: an agent that follows this prompt must not wipe the user's other
    // MCP servers — the same guarantee the button gives.
    check('the prompt tells the AI to merge, not overwrite',
        /keep every server already configured/i.test(client('cursor').prompt), client('cursor').prompt);

    const wired = await post('/api/connect', { client: 'cursor', projectRoot: projectDir });
    check('setting up Cursor writes its config', wired.success === true, wired.message);
    {
        const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.cursor', 'mcp.json'), 'utf8'));
        check('the written entry points at the launcher stub',
            written.mcpServers.plutos.args.join(' ').includes('plutos-launch.mjs')
            && sameProjectPath(path.dirname(path.dirname(written.mcpServers.plutos.args[0])), projectDir),
            JSON.stringify(written.mcpServers.plutos));
        check('what the button writes is exactly what the panel told you to paste',
            JSON.stringify(written.mcpServers.plutos) === JSON.stringify(JSON.parse(client('cursor').snippet).mcpServers.plutos),
            JSON.stringify(written.mcpServers.plutos));
        check('Cursor config carries an explicit project binding',
            written.mcpServers.plutos.env.PLUTOS_PROJECT_ROOT === projectDir, JSON.stringify(written));
        check('the plan now reports Cursor as wired',
            (wired.clients || []).find(c => c.id === 'cursor').wired === true);
    }
    // Never clobber another server the user configured in their own editor.
    {
        const file = path.join(projectDir, '.cursor', 'mcp.json');
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        existing.mcpServers['their-own-server'] = { command: 'npx', args: ['-y', 'whatever'] };
        fs.writeFileSync(file, JSON.stringify(existing, null, 2));
        await post('/api/connect', { client: 'cursor', projectRoot: projectDir });
        const after = JSON.parse(fs.readFileSync(file, 'utf8'));
        check("another tool's server survives being re-wired", !!after.mcpServers['their-own-server']);
    }
    // A config the user is midway through hand-editing must not be silently replaced —
    // that would wipe every MCP server they have.
    {
        const file = path.join(projectDir, '.vscode', 'mcp.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json');
        const broken = await post('/api/connect', { client: 'vscode' });
        check('a malformed client config is refused, not overwritten', broken.success === false);
        check('and the file is left exactly as it was', fs.readFileSync(file, 'utf8') === '{ not json');
        fs.rmSync(file);
    }
    check('an unknown client is rejected', (await post('/api/connect', { client: '../../etc/passwd' })).success === false);

    // 1e-f. The MCP light. `active` alone drove a RED indicator, so a healthy install showed
    // an error until an AI happened to be running — "it says error but it installed fine".
    // Red is now reserved for states that are actually broken.
    {
        const st = await get('/api/mcp/status');
        check('a wired project with no AI running reports waiting, not an error',
            st.state === 'waiting', `${st.state} / wired=${JSON.stringify(st.wiredClients)}`);
        check('and names which tools it is waiting on',
            st.wiredClients.includes('Claude Code (team-shared)') && st.wiredClients.includes('Cursor'),
            JSON.stringify(st.wiredClients));
        check('the missing-SDK case is detected separately', st.sdkInstalled === true);
    }

    // 1e1. Council files dropped on add; both boards + roster served over the API
    check('AGENT_BOARD.md dropped into project', fs.existsSync(path.join(projectDir, 'docs', 'handoff', 'AGENT_BOARD.md')));
    check('ROSTER.md dropped into project', fs.existsSync(path.join(projectDir, 'docs', 'handoff', 'ROSTER.md')));
    const agentBoard = await get('/api/board?board=agents');
    check('agent board readable via API', agentBoard.exists === true && agentBoard.board === 'agents');
    const roster = await get('/api/roster');
    check('roster readable via API', roster.exists === true && Array.isArray(roster.agents));
    // ROSTER.md ships its entry format inside a ``` fence. Every parser used to read that
    // example as a real record, so a brand-new project listed an agent called "<agent-name>"
    // owned by "<owner-ai>" — three lines below the file's own "(no agents registered)".
    check('fenced entry-format example is NOT parsed as an agent', roster.agents.length === 0,
        JSON.stringify(roster.agents.map(a => a.name)));
    const boardFenced = parseBoardEntries([
        '# Board', '', 'Format:', '```', '### ghost · TODO · from the example block', '- **Task:** none',
        '```', '', '### real-agent · TODO · an actual entry', '- **Task:** ship it'
    ].join('\n'));
    check('fenced board example is not an entry either',
        boardFenced.length === 1 && boardFenced[0].agent === 'real-agent', JSON.stringify(boardFenced.map(e => e.agent)));
    const state0 = await get('/api/state');
    check('state endpoint answers (empty)', state0.state === null && Array.isArray(state0.recent));

    // 1e2. Project interview is OPT-IN: not dropped by default; answering starts one
    check('interview NOT dropped by default', !fs.existsSync(path.join(projectDir, 'docs', 'handoff', 'PROJECT_INTERVIEW.md')));
    const iv0 = await get('/api/interview');
    check('interview reported as not started', iv0.exists === false && Object.keys(iv0.answers).length === 0 && iv0.recommendation.complete === false);
    const ivPost = await post('/api/interview', { answers: { type: 'game', stage: 'brand-new-mvp', goal: 'ship-demo-fast', ai: 'claude-code', team: 'solo' } });
    check('interview answers accepted + recommendation returned', ivPost.success === true && !('roles' in ivPost.recommendation) && ivPost.recommendation.reasons.some(r => r.startsWith('game project')));
    const ivFile = fs.readFileSync(path.join(projectDir, 'docs', 'handoff', 'PROJECT_INTERVIEW.md'), 'utf8');
    check('answers written into the file', ivFile.includes('> answer: game') && ivFile.includes('Recommended MCPs:'));
    const iv1 = await get('/api/interview');
    check('answers persist across reads', iv1.answers.type === 'game' && iv1.recommendation.complete === true);

    // 1e3. Skills page (lib/skills.mjs): the project's skill folders and the pack registry, both
    // empty on a fresh project, and the homes the clients read from.
    const sk0 = await get('/api/skills');
    check('skills endpoint answers with skills, packs and homes', Array.isArray(sk0.skills) && sk0.skills.length === 0
        && Array.isArray(sk0.packs) && sk0.packs.length === 0 && Array.isArray(sk0.homes) && sk0.homes.some(h => h.folder === '.agents/skills'), JSON.stringify(sk0).slice(0, 160));
    const pk0 = await get('/api/packs');
    check('packs registry endpoint answers without a project', Array.isArray(pk0.packs) && pk0.packs.length === 0);
    const badOn = await post('/api/packs/on', { id: 'no-such-pack' });
    check('switching on an unregistered pack is refused with one line', badOn.success === false && /Unknown pack/.test(badOn.message), badOn.message);

    // 3b. Escaping is a shared helper, not a per-module habit. The dashboard renders content it
    // did not write — board entries, roster rows, session logs read out of the target project —
    // into a page that has unauthenticated access to every local API. Both helpers
    // existed in two modules each and never propagated, so this asserts the propagation as well as
    // the behaviour. The module is browser ESM (this package is type:commonjs), hence eval by source.
    const escSrc = fs.readFileSync(path.join(__dirname, 'ui', 'esc.js'), 'utf8');
    const esc = new Function(`${escSrc.replace(/^export /gm, '')}\nreturn { escHtml, jsArg, escHref };`)();
    check('escHtml defuses a tag', esc.escHtml('<img src=x onerror=alert(1)>').startsWith('&lt;img'));
    check('escHtml defuses both quote styles', esc.escHtml(`" '`) === '&quot; &#39;');
    check('jsArg survives an onclick break-out', !esc.jsArg("x');fetch('/api/install')//").includes("');fetch"));
    check('escHref drops javascript:', esc.escHref("javascript:fetch('/api/workspaces/repair')") === '#');
    check('escHref keeps an ordinary file link', esc.escHref('file:///C:/x.mjs').startsWith('file:'));

    const RENDERERS = ['board.js', 'memory.js', 'codeindex.js', 'workspaces.js', 'fsbrowse.js'];
    for (const mod of RENDERERS) {
        const src = fs.readFileSync(path.join(__dirname, 'ui', 'modules', mod), 'utf8');
        check(`${mod} imports the shared escapers`, /from '\.\.\/esc\.js'/.test(src));
        check(`${mod} keeps no private copy`, !/^\s*const (escHtml|jsArg|escHref)\s*=/m.test(src));
    }

    // Importing the helper proves nothing on its own — the fields have to actually go through it.
    // These are the exact sinks the review found; the check exists so re-introducing one fails here
    // rather than in someone's browser.
    const RAW_SINKS = [
        ['board.js', /\$\{(e\.(agent|title|status)|a\.(name|owner|role)|w\.(source|message))\}/],
        ['memory.js', /\$\{(log\.(agent|action)|s\.(lastTask|status|notes|headline)|item\.(claim|detail))\}/],
        ['codeindex.js', /\$\{(data\.(name|folder|signature|methods|fires|listens|codeLink)|folderName)\}/]
    ];
    for (const [mod, rawPattern] of RAW_SINKS) {
        const src = fs.readFileSync(path.join(__dirname, 'ui', 'modules', mod), 'utf8');
        const leaks = src.match(rawPattern);
        check(`${mod} routes agent-written fields through an escaper`, !leaks, leaks ? leaks[0] : '');
    }

    // 3z. The board view is the busiest renderer in the product and had no render coverage
    // at all — the escaping checks above prove what it must NOT emit, nothing proved what it
    // does. Drag-to-assign made that gap expensive: a drop writes to the shared board, and a
    // wrong payload would reassign or restatus the wrong entry silently.
    //
    // The module is browser ESM under a CommonJS package.json, so it is imported from a copy
    // in a folder that declares type:module, with just enough DOM stubbed to run its paint path.
    {
        const uiCopy = path.join(tmpRoot, 'ui-render');
        fs.mkdirSync(uiCopy, { recursive: true });
        fs.cpSync(path.join(__dirname, 'ui'), path.join(uiCopy, 'ui'), { recursive: true });
        fs.writeFileSync(path.join(uiCopy, 'package.json'), '{"type":"module"}');

        const container = { innerHTML: '' }, metaEl = { textContent: '' };
        // Board tools (Job 18): the document checks render into their own fold below the board,
        // with a warning count on its summary.
        const hygieneEl = { innerHTML: '', querySelector: () => null }, flagEl = { hidden: false, textContent: '' };
        const byId = { 'board-container': container, 'board-meta': metaEl, 'board-hygiene': hygieneEl, 'board-tools-flag': flagEl };
        const stubNode = () => ({ className: '', textContent: '', style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {}, setAttribute() {} });
        const priorFetch = globalThis.fetch;
        const priorAddEventListener = globalThis.addEventListener;
        globalThis.document = {
            getElementById: (id) => byId[id] || null,
            querySelectorAll: () => [], addEventListener() {}, createElement: stubNode, body: stubNode()
        };
        globalThis.window = globalThis;
        globalThis.addEventListener = () => {};
        globalThis.localStorage = { getItem: () => null, setItem() {} };
        globalThis.lucide = { createIcons() {} };

        const FIX = {
            '/api/board': { exists: true, project: 'demo', updatedAt: new Date().toISOString(), entries: [
                { agent: 'owner', status: 'TODO', title: 'Wire the payments retry', fields: { Assignee: 'Cursor' }, notes: [] },
                { agent: 'owner', status: 'TODO', title: 'P1 - Ranked below it in the file', fields: {}, notes: [] },
                { agent: 'gemini', status: 'DOING', title: 'Legacy status entry', fields: {}, notes: [] }
            ] },
            '/api/board?board=agents': { exists: true, entries: [{ agent: 'scout-1', status: 'TODO', title: 'Read the docs', fields: {}, notes: [] }] },
            '/api/roster': { exists: true, agents: [
                { name: 'Cursor', owner: 'Cursor', role: 'main-ai', fields: { Kind: 'main-ai', Status: 'active' } },
                { name: 'scout-1', owner: 'Claude', role: 'research', fields: { Kind: 'subagent', Status: 'active' } }
            ] },
            '/api/hygiene': { boards: [{ name: 'BOARD.md', exists: true, active: 2, done: 0, bytes: 900 }], docs: [], warnings: [] },
            '/api/ideas': { exists: true, ideas: [
                { text: 'A pending idea', section: '', settled: false },
                { text: '~~Shipped one~~ → DONE', section: 'Council review', settled: true }
            ] }
        };
        const posted = [];
        globalThis.fetch = async (url, opts) => opts?.method === 'POST'
            ? (posted.push({ url, body: JSON.parse(opts.body) }), { json: async () => ({ success: true, message: 'ok' }) })
            : { json: async () => FIX[url] ?? {} };

        const board = await import(pathToFileURL(path.join(uiCopy, 'ui', 'modules', 'board.js')).href);
        await board.fetchBoard();
        const html = () => container.innerHTML;

        // The layout complaint this replaced: everything stacked, so a busy board pushed the
        // roster — the thing you hand work to — off the bottom of the page.
        check('board renders the pane + rail layout', html().includes('class="board-layout"') && html().includes('class="board-rail"'));
        check('kanban columns scroll inside themselves', html().includes('class="kanban-body"'));
        check('only one pane is painted at a time', !html().includes('idea-list'));
        check('cards are draggable', html().includes('draggable="true"'));
        // The cramped-card fix: detail is present in the markup but folded until clicked, and
        // a card carries who holds it rather than six stacked fields.
        check('card detail is folded, not printed inline', html().includes('class="kc-detail"') && html().includes('boardToggleCard(this)'));
        check('a card carries the identity its open state is remembered by', html().includes('data-key="main::Cursor::Wire the payments retry"'));
        check('each column names what it is for', html().includes('class="kanban-cap"'));
        // The board schema has no priority field, so entries carry rank as a "P1 - " title
        // prefix. The card reads it: badge instead of eight characters of title, and the
        // column hoists it above unranked work that sits above it in the file.
        check('a ranked card wears its rank as a badge', html().includes('class="kc-pri p1"'));
        check('the rank is stripped from the title it was smuggled in',
            html().includes('>Ranked below it in the file') && !html().includes('>P1 - Ranked'));
        check('a ranked card sorts above unranked work written before it',
            html().indexOf('Ranked below it in the file') < html().indexOf('Wire the payments retry'));
        // Display-only: the raw title is still the identity board_update upserts on and a drag
        // sends back, so stripping it for the eye must not reach the data.
        check('stripping the rank does not touch the entry identity',
            html().includes('data-key="main::owner::P1 - Ranked below it in the file"'));
        // Both folded panels are rebuilt by every repaint. They are matched back to their open
        // state by name, not position, because the hygiene one is absent when it has nothing
        // to report — which would silently shift the assign form into its place.
        check('both folded panels carry a name a repaint can put them back by',
            hygieneEl.innerHTML.includes('data-panel="hygiene"') && html().includes('data-panel="assign"'));
        check('Board tools shows no warning count when there is nothing to look at', flagEl.hidden === true);
        check('an empty column says so instead of sitting blank', html().includes('class="empty-state kanban-empty"'));
        check('a card names who holds it', html().includes('class="chip"') && html().includes('Cursor'));
        check('an entry with no assignee falls back to its own agent', html().includes('gemini'));
        // The rail's second complaint: it grew down the page and said nothing but names.
        check('the rail shows each AI open load', html().includes('class="ai-load"'));
        check('the rail scrolls inside itself', html().includes('class="rail-body"'));
        check('subagents fold away under the AIs', html().includes('rail-subs') && html().includes('Subagents (1)'));
        check('an unknown hand-written status is left undraggable',
            !/Legacy status entry[\s\S]{0,400}draggable/.test(html()));
        check('no undefined leaks into the board markup', !html().includes('undefined'));

        globalThis.boardSegment('ideas');
        check('the ideas pane paints from the same fetch', html().includes('A pending idea'));
        check('settled ideas collapse out of the way', html().includes('Shipped or promoted (1)'));
        check('the rail stays put across panes', html().includes('class="board-rail"'));
        globalThis.boardSegment('agents');
        check('the agent board pane paints its own tier', html().includes('Read the docs'));

        // A drop writes to the shared board. What it sends is the entry's identity plus the
        // one thing the gesture changed — never a rebuilt entry.
        const ev = { preventDefault() {}, dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' } };
        const node = { classList: { add() {}, remove() {} } };
        globalThis.boardDragStart(ev, node, 'main', 'owner', 'TODO', 'Wire the payments retry');
        await globalThis.boardDropAssignee(ev, node, 'Cursor');
        check('dropping a task on an AI assigns it, nothing else',
            JSON.stringify(posted.at(-1)?.body) === JSON.stringify({ board: 'main', agent: 'owner', status: 'TODO', title: 'Wire the payments retry', assignee: 'Cursor' }),
            JSON.stringify(posted.at(-1)));
        globalThis.boardDragStart(ev, node, 'agents', 'scout-1', 'TODO', 'Read the docs');
        await globalThis.boardDropStatus(ev, node, 'IN_PROGRESS');
        check('dropping on a column moves it on its own tier',
            JSON.stringify(posted.at(-1)?.body) === JSON.stringify({ board: 'agents', agent: 'scout-1', status: 'IN_PROGRESS', title: 'Read the docs' }),
            JSON.stringify(posted.at(-1)));
        const writes = posted.length;
        globalThis.boardDragStart(ev, node, 'main', 'owner', 'TODO', 'Wire the payments retry');
        await globalThis.boardDropStatus(ev, node, 'TODO');
        check('a card dropped back where it started writes nothing', posted.length === writes);
        await globalThis.boardDropAssignee(ev, node, 'Cursor');
        check('a drop with nothing in flight writes nothing', posted.length === writes);

        // The complaint this closes: the refresh timer fires every few seconds while you are
        // reading, and a repaint is destructive — it drops the card you had open and throws the
        // pane back to the top. So an unchanged board must not repaint AT ALL, and a changed one
        // still must. The sentinel stands in for the reader's place on the page.
        globalThis.boardSegment('main');
        container.innerHTML = 'SENTINEL';
        await board.fetchBoard();
        check('an unchanged board is not repainted', container.innerHTML === 'SENTINEL');
        FIX['/api/board'].entries.push({ agent: 'owner', status: 'TODO', title: 'Arrived while reading', fields: {}, notes: [] });
        await board.fetchBoard();
        check('a board that actually changed does repaint', html().includes('Arrived while reading'));

        globalThis.fetch = priorFetch;
        if (priorAddEventListener === undefined) delete globalThis.addEventListener;
        else globalThis.addEventListener = priorAddEventListener;
        delete globalThis.document; delete globalThis.lucide; delete globalThis.localStorage;
    }

    // 5. The roster: an agent registered as introduced (owner unclaimed) is claimed by the first
    // agent_register, and the owner can remove an entry from the Board tab.
    const introducedName = 'mvp-agent';
    const { writeRosterEntry } = await import('../lib/roster-store.mjs');
    writeRosterEntry(projectDir, { name: introducedName, owner: 'unclaimed', role: 'quality-reviewer', kind: 'subagent', memory: `.agents/${introducedName}/MEMORY.md`, status: 'introduced' });
    const qualityName = 'quality-agent';
    writeRosterEntry(projectDir, { name: qualityName, owner: 'unclaimed', role: 'quality', kind: 'subagent', memory: `.agents/${qualityName}/MEMORY.md`, status: 'introduced' });
    const introEntry = ((await get('/api/roster')).agents || []).find(a => a.name === introducedName);
    check('an introduced agent is on the roster as unclaimed', !!introEntry && introEntry.owner === 'unclaimed' && introEntry.fields?.Status === 'introduced', JSON.stringify(introEntry));
    const rosterDel = await post('/api/roster/remove', { name: qualityName });
    check('roster remove deletes the entry', rosterDel.success === true
        && !((await get('/api/roster')).agents || []).some(a => a.name === qualityName), rosterDel.message);
    check('removing a missing roster entry is rejected', (await post('/api/roster/remove', { name: 'ghost-agent' })).success === false);

    // Board forgery closed: a newline inside any agent-supplied value must NOT mint a second
    // entry attributed to another agent — the trust anchor of the visibility layer.
    const { applyBoardUpdate: forgeUpdate, parseBoardEntries: forgeParse } = await import('../lib/board.mjs');
    const forged = forgeUpdate('# Board\n\n(no active tasks — add your entry above this line)\n',
        { agent: 'agent-a', status: 'IN_PROGRESS', title: 'real task\n\n### fake-agent · DONE · never happened' });
    const forgedEntries = forgeParse(forged.content);
    check('a newline in a board field cannot forge another entry',
        forgedEntries.length === 1 && forgedEntries[0].agent === 'agent-a'
        && !forgedEntries.some(e => e.agent === 'fake-agent'), JSON.stringify(forgedEntries.map(e => e.agent)));
    const { applyRosterUpdate: forgeRoster } = await import('../lib/roster.mjs');
    const forgedRoster = forgeRoster('# ROSTER\n\n(no agents registered — add your entry above this line)\n',
        { name: 'real-agent', owner: 'claude', role: 'helper\n### ghost · evil · injected' });
    check('a newline in a roster field cannot forge another agent',
        parseRoster(forgedRoster.content).length === 1, JSON.stringify(parseRoster(forgedRoster.content).map(a => a.name)));

    // A board update must change the entry it was asked to change, and NOTHING else. Four
    // ways it used to break that, none of which anything caught:
    {
        // (a) Whatever a human wrote inside the entry. The update path rebuilt each block
        // from its parsed fields and notes alone, so a checklist, a link to the results
        // document, or a line of reasoning was silently deleted by a status change.
        const rich = ['# Board', '',
            '### claude · IN_PROGRESS · Fix login',
            '- **Started:** 2026-01-01',
            '- **Task:** fix the login bug',
            '- [ ] reproduce it',
            '- [x] find the cause',
            '- see docs/handoff/results/login-analysis.md', ''].join('\n');
        const done = forgeUpdate(rich, { agent: 'claude', status: 'DONE', title: 'Fix login', result: 'fixed' });
        check('a status change keeps the checklist someone wrote under the task',
            done.content.includes('- [ ] reproduce it') && done.content.includes('- [x] find the cause'), done.content);
        check('and keeps the link to the results document',
            done.content.includes('docs/handoff/results/login-analysis.md'), done.content);
        check('while still applying the change it was asked for',
            done.content.includes('· DONE · Fix login') && done.content.includes('**Result / Output:** fixed'));
        // Order matters too: metadata stays above the prose rather than being appended after it.
        check('a new field lands with the other fields, not after the prose',
            done.content.indexOf('**Result / Output:**') < done.content.indexOf('- [ ] reproduce it'), done.content);

        // (b) Line endings. Splitting on /\r?\n/ and joining with '\n' rewrote every line of
        // a CRLF file, so on Windows a one-word status change showed up in git as the whole
        // file modified — burying the real change and looking like PLUT_OS rewrote the file.
        const crlf = ['# Board', '', '(no active tasks — add your entry above this line)', ''].join('\r\n');
        const crlfOut = forgeUpdate(crlf, { agent: 'claude', status: 'TODO', title: 'Keep my endings' }).content;
        check('a CRLF board stays CRLF', /\r\n/.test(crlfOut) && !/[^\r]\n/.test(crlfOut));
        const lfOut = forgeUpdate('# Board\n\n(no active tasks — add your entry above this line)\n',
            { agent: 'claude', status: 'TODO', title: 'Keep my endings' }).content;
        check('and an LF board stays LF', !lfOut.includes('\r'));

        // (c) The seed's placeholder was used purely as an insertion anchor and left behind,
        // so a board with live tasks still told every AI reading it that it had none.
        let filled = forgeUpdate('# Board\n\n(no active tasks — add your entry above this line)\n',
            { agent: 'claude', status: 'TODO', title: 'One' }).content;
        filled = forgeUpdate(filled, { agent: 'gemini', status: 'TODO', title: 'Two' }).content;
        check('the "no active tasks" placeholder goes once there are tasks',
            !filled.includes('(no active tasks'), filled);
        check('and both entries are actually on the board', forgeParse(filled).length === 2);

        // (d) findBlocks trims what it reads off the file but the incoming title was not
        // trimmed, so a stray trailing space matched nothing and "created" a second entry —
        // one that renders identically to the first, because the writer trims on the way out.
        const dupBase = '# Board\n\n### claude · TODO · Fix the login bug\n- **Task:** t\n';
        const dup = forgeUpdate(dupBase, { agent: 'claude ', status: 'DONE', title: 'Fix the login bug ', result: 'x' });
        check('a stray space in the title updates the entry instead of cloning it',
            dup.action === 'updated' && forgeParse(dup.content).length === 1,
            `${dup.action} / ${forgeParse(dup.content).length} entries`);
    }

    // The roster had all of the same problems, from the same shared code path — and worse,
    // its rebuild passed an empty notes array, so a routine heartbeat refresh erased notes too.
    {
        const { applyRosterUpdate: rosterUpdate } = await import('../lib/roster.mjs');
        const before = ['# ROSTER', '',
            '### scout · claude · researcher',
            '- **Kind:** subagent',
            '- **Status:** active',
            '- ❓ NOTE: only touch the docs folder',
            '- owner asked: keep this one around after the sprint', ''].join('\n');
        const after = rosterUpdate(before, { name: 'scout ', owner: 'claude', role: 'researcher', skills: 'x' });
        check('refreshing an agent keeps its note', after.content.includes('only touch the docs folder'), after.content);
        check('and keeps the line someone wrote underneath', after.content.includes('keep this one around after the sprint'));
        check('a stray space in the agent name refreshes instead of cloning',
            after.action === 'refreshed' && parseRoster(after.content).length === 1);
        const seeded = rosterUpdate('# ROSTER\n\n(no agents registered — add your entry above this line)\n',
            { name: 'scout', owner: 'claude', role: 'researcher' }).content;
        check('the "no agents registered" placeholder goes once one is', !seeded.includes('(no agents registered'), seeded);
    }

    // MCP write-guard marker: the coordinator only writes into directories that look like
    // PLUT_OS projects. (The guard itself lives in index.mjs; the marker logic is here.)
    const { looksLikePlutosProject } = await import('../lib/workspaces.mjs');
    check('a kitted project passes the write-guard marker', looksLikePlutosProject(projectDir) === true);
    const bareDir = path.join(tmpRoot, 'bare-dir');
    fs.mkdirSync(bareDir, { recursive: true });
    check('a bare directory fails the write-guard marker', looksLikePlutosProject(bareDir) === false);
    check('a missing path fails the write-guard marker', looksLikePlutosProject(path.join(tmpRoot, 'nope-dir')) === false);
    const genericDir = path.join(tmpRoot, 'generic-agents');
    fs.mkdirSync(genericDir, { recursive: true });
    fs.writeFileSync(path.join(genericDir, 'AGENTS.md'), '# Cursor rules\nDo stuff.\n');
    check('a generic AGENTS.md is not a PLUT_OS project', looksLikePlutosProject(genericDir) === false);
    const handoffOnly = path.join(tmpRoot, 'handoff-only');
    fs.mkdirSync(path.join(handoffOnly, 'docs', 'handoff'), { recursive: true });
    check('an empty docs/handoff folder is not a PLUT_OS project', looksLikePlutosProject(handoffOnly) === false);
    const emptyPlutos = path.join(tmpRoot, 'empty-plutos');
    fs.mkdirSync(path.join(emptyPlutos, '.plutos'), { recursive: true });
    check('an empty .plutos directory is not a PLUT_OS project', looksLikePlutosProject(emptyPlutos) === false);
    const protocolDir = path.join(tmpRoot, 'protocol-project');
    fs.mkdirSync(path.join(protocolDir, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(protocolDir, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md'), '# PLUT_OS Board Protocol\n');
    check('PLUTOS_PROTOCOL.md is enough evidence', looksLikePlutosProject(protocolDir) === true);
    const stubDir = path.join(tmpRoot, 'stub-project');
    fs.mkdirSync(path.join(stubDir, '.plutos'), { recursive: true });
    fs.writeFileSync(path.join(stubDir, '.plutos', 'plutos-launch.mjs'), '// stub\n');
    check('the launcher stub is enough evidence', looksLikePlutosProject(stubDir) === true);

    const { requiresProject } = await import('../lib/tool-policy.mjs');
    check('unknown tools default to mutate (project required)', requiresProject('brand_new_writer', {}) === true);
    check('init_roadmap does not require a project', requiresProject('init_roadmap', {}) === false);
    for (const rel of ['lib/agents.mjs', 'lib/presence.mjs', 'dashboard.mjs', 'index.mjs']) {
        const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
        check(`${rel} does not writeFileSync the roster path`, !/writeFileSync\(\s*rosterPath/.test(src));
    }
    check('index.mjs applies the project guard at dispatch',
        /requiresProject\(name, args/.test(fs.readFileSync(path.join(__dirname, 'index.mjs'), 'utf8')));

    // 5b. A real agent_register call (no dashboard involved, no status param — same shape as
    // the MCP tool) on that same name should claim ownership and flip status to active.
    const rosterPath = path.join(projectDir, 'docs', 'handoff', 'ROSTER.md');
    const introducedContent = fs.readFileSync(rosterPath, 'utf8');
    const { content: claimedContent, action: claimAction } = applyRosterUpdate(introducedContent, { name: introducedName, owner: 'claude', role: 'quality-reviewer' });
    const claimedEntry = parseRoster(claimedContent).find(a => a.name === introducedName);
    check('real agent_register claims owner + flips status to active',
        claimAction === 'refreshed' && claimedEntry?.owner === 'claude' && claimedEntry?.fields?.Status === 'active',
        JSON.stringify(claimedEntry));
    let conflictingOwnerRejected = false;
    try { applyRosterUpdate(claimedContent, { name: introducedName, owner: 'gemini', role: 'quality-reviewer' }); }
    catch (e) { conflictingOwnerRejected = /already owned/.test(e.message); }
    check('a second AI cannot silently take over a claimed agent', conflictingOwnerRejected);
    const sameOwnerRefresh = applyRosterUpdate(claimedContent,
        { name: introducedName, owner: ' CLAUDE ', role: 'quality-reviewer' });
    check('the current owner can still refresh its agent', sameOwnerRefresh.action === 'refreshed'
        && parseRoster(sameOwnerRefresh.content).find(a => a.name === introducedName)?.owner === 'CLAUDE');

    // 5c. Atomic conflict-safe write: a concurrent writer sneaking an entry into the roster
    // between our read and write must NOT be lost (the board_update/agent_register race fix).
    const raceFile = path.join(tmpRoot, 'race.md');
    fs.writeFileSync(raceFile, "# ROSTER\n\n---\n\n(no agents registered — add your entry above this line)\n");
    let raceInjected = false;
    updateFileAtomically(raceFile, (content) => {
        if (!raceInjected) {
            raceInjected = true; // simulate another agent registering "concurrent" mid-flight
            const cur = fs.readFileSync(raceFile, 'utf8');
            fs.writeFileSync(raceFile, applyRosterUpdate(cur, { name: 'concurrent', owner: 'other', role: 'x' }).content);
        }
        return { content: applyRosterUpdate(content, { name: 'mine', owner: 'me', role: 'y' }).content, result: 'ok' };
    });
    const raceNames = parseRoster(fs.readFileSync(raceFile, 'utf8')).map(a => a.name);
    check('atomic write preserves a concurrent entry (no silent loss)',
        raceNames.includes('concurrent') && raceNames.includes('mine'), raceNames.join(','));
    check('no .tmp file left after atomic write', fs.readdirSync(tmpRoot).every(f => !f.includes('.tmp')));

    if (process.platform === 'win32') {
        const mkdir = fs.mkdirSync;
        for (const code of ['EPERM', 'EACCES']) {
            const target = path.join(tmpRoot, `transient-${code}.md`);
            let attempts = 0, mutations = 0;
            fs.mkdirSync = (file, ...args) => {
                if (file === `${target}.lock` && ++attempts <= 2) {
                    throw Object.assign(new Error('Synthetic transient Windows lock denial'), { code });
                }
                return mkdir(file, ...args);
            };
            try {
                updateFileAtomically(target, () => { mutations++; return { content: 'one write\n' }; });
            } finally { fs.mkdirSync = mkdir; }
            check(`Windows transient ${code} lock denial retries before one guarded write`,
                attempts === 3 && mutations === 1 && fs.readFileSync(target, 'utf8') === 'one write\n' && !fs.existsSync(`${target}.lock`));
        }
        const deniedTarget = path.join(tmpRoot, 'persistent-lock-denial.md');
        const permissionError = Object.assign(new Error('Synthetic persistent Windows permission denial'), { code: 'EPERM' });
        let actualError, attempts = 0, mutations = 0;
        fs.mkdirSync = (file, ...args) => {
            if (file === `${deniedTarget}.lock`) { attempts++; throw permissionError; }
            return mkdir(file, ...args);
        };
        try { updateFileAtomically(deniedTarget, () => { mutations++; return { content: 'must not write' }; }); }
        catch (error) { actualError = error; }
        finally { fs.mkdirSync = mkdir; }
        check('persistent Windows lock denial remains the original permission error after bounded retries',
            actualError === permissionError && attempts > 1 && attempts <= 200 && mutations === 0 && !fs.existsSync(deniedTarget));

        // An unlocked reader holding the target makes Windows refuse the rename for a moment.
        const rename = fs.renameSync;
        const heldTarget = path.join(tmpRoot, 'reader-held.md');
        let renames = 0;
        fs.renameSync = (from, to, ...args) => {
            if (to === heldTarget && ++renames <= 2) throw Object.assign(new Error('Synthetic reader-held rename'), { code: 'EPERM' });
            return rename(from, to, ...args);
        };
        try { updateFileAtomically(heldTarget, () => ({ content: 'landed\n' })); }
        finally { fs.renameSync = rename; }
        check('a rename refused while a reader holds the file is retried and the write lands',
            renames === 3 && fs.readFileSync(heldTarget, 'utf8') === 'landed\n'
            && fs.readdirSync(tmpRoot).every(f => !f.startsWith('reader-held.md.') || !f.endsWith('.tmp')));

        const stuckTarget = path.join(tmpRoot, 'reader-stuck.md');
        const stuckError = Object.assign(new Error('Synthetic persistent rename denial'), { code: 'EPERM' });
        let stuckThrown;
        fs.renameSync = (from, to, ...args) => { if (to === stuckTarget) throw stuckError; return rename(from, to, ...args); };
        try { updateFileAtomically(stuckTarget, () => ({ content: 'must not land' })); }
        catch (error) { stuckThrown = error; }
        finally { fs.renameSync = rename; }
        check('a rename that never succeeds surfaces the original error and leaves no temp file behind',
            stuckThrown === stuckError && !fs.existsSync(stuckTarget)
            && fs.readdirSync(tmpRoot).every(f => !f.startsWith('reader-stuck.md.')));
    }

    // 5c-ter. The stale-lock steal. A writer killed inside its critical section leaves the lock
    // directory behind and nothing else on the system reclaims it — without the steal, one
    // crashed agent wedges the board permanently for every other agent. acquireLock steals only
    // when it has watched the SAME lock instance (same owner.json birth stamp) sit past STALE_MS.
    // The lock is planted by hand exactly as a crash leaves it: the dir plus an owner.json. The
    // birth stamp is backdated so the steal trips on the second poll (~15ms) instead of making
    // the suite sit through 10 real seconds — STALE_MS is a module constant with no env knob or
    // injectable clock, and a backdated stamp is indistinguishable to acquireLock from a real
    // holder that has been dead that long.
    {
        const staleFile = path.join(tmpRoot, 'stale-lock-target.md');
        const staleLock = `${staleFile}.lock`;
        fs.writeFileSync(staleFile, 'before\n');
        fs.mkdirSync(staleLock);
        fs.writeFileSync(path.join(staleLock, 'owner.json'),
            JSON.stringify({ pid: 999999, birth: Date.now() - 60_000 }));

        const stolen = updateFileAtomically(staleFile, (c) => ({ content: c + 'after\n', result: 'wrote' }));
        check('a stale lock left behind by a crashed writer is stolen and the next write lands',
            stolen === 'wrote' && fs.readFileSync(staleFile, 'utf8') === 'before\nafter\n',
            JSON.stringify(fs.readFileSync(staleFile, 'utf8')));
        check('the stolen lock is released again, leaving no lock directory behind',
            !fs.existsSync(staleLock));

        // The other half of the same guarantee, and the dangerous one: a lock whose holder is
        // still alive must NOT be stolen, or the mutex excludes nobody. Same planted lock, birth
        // stamped now — the waiter gives up (~3s of patience) rather than taking it.
        const liveFile = path.join(tmpRoot, 'live-lock-target.md');
        const liveLock = `${liveFile}.lock`;
        fs.writeFileSync(liveFile, 'untouched\n');
        fs.mkdirSync(liveLock);
        fs.writeFileSync(path.join(liveLock, 'owner.json'),
            JSON.stringify({ pid: 999999, birth: Date.now() }));
        let refused = null;
        try { updateFileAtomically(liveFile, (c) => ({ content: c + 'STOLEN\n', result: 'wrote' })); }
        catch (e) { refused = e.message; }
        check('a lock whose holder is still alive is never stolen — the writer is refused instead',
            refused !== null && /locked by another writer/.test(refused)
            && fs.readFileSync(liveFile, 'utf8') === 'untouched\n',
            String(refused));
        fs.rmSync(liveLock, { recursive: true, force: true });

        // A crash between mkdir and the stamp write leaves a lock with no owner.json. Without
        // a birth it was never stolen, and one such directory wedged a real install for weeks.
        const bareFile = path.join(tmpRoot, 'stampless-lock-target.md');
        const bareLock = `${bareFile}.lock`;
        fs.writeFileSync(bareFile, 'before\n');
        fs.mkdirSync(bareLock);
        const longAgo = new Date(Date.now() - 60_000);
        fs.utimesSync(bareLock, longAgo, longAgo);
        const bareStart = Date.now();
        const bareStolen = updateFileAtomically(bareFile, (c) => ({ content: c + 'after\n', result: 'wrote' }));
        check('an old lock without an owner stamp is stolen promptly and the next write lands',
            bareStolen === 'wrote' && fs.readFileSync(bareFile, 'utf8') === 'before\nafter\n'
            && !fs.existsSync(bareLock) && Date.now() - bareStart < 1000, `${Date.now() - bareStart}ms`);

        // The same unstamped lock seconds old is a holder that has not stamped yet: keep it.
        const freshFile = path.join(tmpRoot, 'fresh-stampless-lock-target.md');
        const freshLock = `${freshFile}.lock`;
        fs.writeFileSync(freshFile, 'untouched\n');
        fs.mkdirSync(freshLock);
        let freshRefused = null;
        try { updateFileAtomically(freshFile, (c) => ({ content: c + 'STOLEN\n', result: 'wrote' })); }
        catch (e) { freshRefused = e.message; }
        check('a fresh lock without an owner stamp is never stolen',
            freshRefused !== null && fs.readFileSync(freshFile, 'utf8') === 'untouched\n', String(freshRefused));
        fs.rmSync(freshLock, { recursive: true, force: true });
    }

    {
        const mixedDir = path.join(tmpRoot, 'roster-mixed');
        fs.mkdirSync(path.join(mixedDir, 'docs', 'handoff'), { recursive: true });
        const workerPath = path.join(tmpRoot, 'roster-worker.mjs');
        fs.writeFileSync(workerPath, `
import { writeRosterEntry } from ${JSON.stringify(pathToFileURL(path.join(__dirname, 'lib/roster-store.mjs')).href)};
const root = process.argv[2];
const prefix = process.argv[3];
const n = Number(process.argv[4]);
for (let i = 0; i < n; i++) {
    writeRosterEntry(root, {
        name: prefix + '-' + i,
        owner: prefix,
        role: 'worker',
        kind: 'subagent',
        memory: '.agents/' + prefix + '-' + i + '/MEMORY.md'
    });
}
`);
        // The scale README advertises: 16 concurrent writer processes × 25 entries each.
        // Measured at ~1.3s wall clock over three runs, 400/400 entries every time, so the
        // claimed number is cheap enough to actually run instead of being asserted at 2 × 12.
        const Nmix = 25;
        const mixPrefixes = Array.from({ length: 16 }, (_, i) => 'w' + i);
        const kids = mixPrefixes.map(prefix => spawn(process.execPath, [workerPath, mixedDir, prefix, String(Nmix)], { stdio: ['ignore', 'ignore', 'pipe'] }));
        const mixedErr = [];
        for (const c of kids) c.stderr.on('data', d => mixedErr.push(d.toString()));
        const workerResults = await Promise.allSettled(kids.map(c => new Promise((resolve, reject) => {
            c.on('close', (code) => code === 0 ? resolve() : reject(new Error('roster worker exit ' + code + ' ' + mixedErr.join(''))));
            c.on('error', reject);
        })));
        // A failed writer must not trigger teardown while its peers still create files.
        const failedWorker = workerResults.find(result => result.status === 'rejected');
        if (failedWorker) throw failedWorker.reason;
        const mixedNames = parseRoster(fs.readFileSync(path.join(mixedDir, 'docs', 'handoff', 'ROSTER.md'), 'utf8')).map(a => a.name);
        check(`mixed-process roster writers keep every entry (${mixPrefixes.length} concurrent writers × ${Nmix}, zero lost updates)`,
            mixedNames.length === Nmix * mixPrefixes.length
            && mixPrefixes.every(p => mixedNames.filter(n => n.startsWith(p + '-')).length === Nmix),
            `${mixedNames.length} of ${Nmix * mixPrefixes.length} entries survived`);
    }

    // 5c-bis. mcp_status.json is the same race with more writers: every AI client spawns its own
    // MCP server process, each one heartbeating every 10s into ONE shared file. Read-modify-write
    // dropped the other clients' entries, and the dashboard then reported "MCP offline" — the exact
    // symptom that makes a visibility tool untrustworthy. Same helper, keyed on clients[pid].
    const statusRace = path.join(tmpRoot, 'mcp_status.json');
    const writeClient = (pid, injectOther = null) => {
        let injected = false; // inject once, exactly like the roster race above — otherwise every
        return updateFileAtomically(statusRace, (raw) => {   // retry re-conflicts and never settles
            let s; try { s = JSON.parse(raw); } catch (e) { s = null; }
            if (!s || typeof s !== 'object') s = { active: true, clients: {} };
            if (!s.clients || typeof s.clients !== 'object') s.clients = {};
            if (injectOther && !injected) { // another client lands between our read and our write
                injected = true;
                const cur = JSON.parse(fs.readFileSync(statusRace, 'utf8'));
                cur.clients[injectOther] = { pid: injectOther, client: 'Other', lastActive: Date.now() };
                fs.writeFileSync(statusRace, JSON.stringify(cur, null, 2));
            }
            s.clients[pid] = { pid, client: 'Mine', lastActive: Date.now() };
            return { content: JSON.stringify(s, null, 2), result: undefined };
        }, { seed: '{}' });
    };

    writeClient(1001);
    writeClient(1002, 1003); // 1002 writes while 1003 sneaks in mid-flight
    const raceClients = Object.keys(JSON.parse(fs.readFileSync(statusRace, 'utf8')).clients).sort();
    check('mcp status keeps every client through a concurrent write',
        ['1001', '1002', '1003'].every(p => raceClients.includes(p)), raceClients.join(','));
    check('torn/invalid mcp status recovers instead of throwing', (() => {
        fs.writeFileSync(statusRace, '{"clients": {"9', 'utf8'); // half-written JSON
        try { writeClient(2001); } catch (e) { return false; }
        return JSON.parse(fs.readFileSync(statusRace, 'utf8')).clients['2001'] !== undefined;
    })());
    const mcpSrc = fs.readFileSync(path.join(__dirname, 'index.mjs'), 'utf8');
    check('index.mjs writes mcp status only through the atomic helper',
        !/writeFileSync\([^)]*statusFile/.test(mcpSrc) && /mutateMcpStatus/.test(mcpSrc));

    // 5a3. Document hygiene: budgets are measured, not hoped for. Seed a board that violates
    // them (11 active + 4 DONE + one oversized entry), confirm the report flags each, then
    // archive the DONE entries mechanically and confirm the board shrank without data loss.
    const boardFile = path.join(projectDir, 'docs', 'handoff', 'BOARD.md');
    const seeded = ['# BOARD — Shared Agent Board\n'];  // clean base: counts must not depend on other tests
    for (let i = 1; i <= 11; i++) seeded.push(`### agent-${i} · TODO · task ${i}\n- **Task:** work item ${i}\n`);
    for (let i = 1; i <= 4; i++) seeded.push(`### done-agent-${i} · DONE · finished ${i}\n- **Task:** old work ${i}\n- **Result / Output:** results/old-${i}.md\n`);
    seeded.push(`### fat-agent · TODO · oversized entry\n${Array.from({ length: 12 }, (_, i) => `- **Note${i}:** filler line ${i}`).join('\n')}\n`);
    fs.writeFileSync(boardFile, seeded.join('\n'), 'utf8');

    const hyg = await get('/api/hygiene');
    const mainBoard = (hyg.boards || []).find(b => b.name === 'BOARD.md');
    check('hygiene counts active vs DONE entries', mainBoard?.active === 12 && mainBoard?.done === 4, JSON.stringify({ active: mainBoard?.active, done: mainBoard?.done }));
    check('hygiene flags too many active entries', (hyg.warnings || []).some(w => /active entries/.test(w.message)));
    check('hygiene flags an oversized entry', (mainBoard?.oversized || []).some(o => o.title === 'oversized entry'), JSON.stringify(mainBoard?.oversized));
    check('hygiene offers the archive action', (hyg.warnings || []).some(w => w.action === 'archive' && w.board === 'board'));

    const arch = await post('/api/board/archive', { board: 'board' });
    check('archive moves DONE entries off the board', arch.success === true && arch.archived === 4, arch.message);
    const boardAfter = fs.readFileSync(boardFile, 'utf8');
    check('DONE entries gone from the live board', !boardAfter.includes('done-agent-1') && boardAfter.includes('agent-1 · TODO'));
    const archiveFile = path.join(projectDir, arch.archivePath);
    check('archived entries preserved in the archive file', fs.existsSync(archiveFile)
        && fs.readFileSync(archiveFile, 'utf8').includes('results/old-4.md'));
    const hygAfter = await get('/api/hygiene');
    check('hygiene clears the archive warning after cleanup', !(hygAfter.warnings || []).some(w => w.action === 'archive'));
    const emptyArch = await post('/api/board/archive', { board: 'board' });
    check('archiving an already-clean board is a no-op', emptyArch.success === true && emptyArch.archived === 0, emptyArch.message);

    // 5a4. Session continuity: the memory loop across sessions AND vendors. session_end
    // records + captures durable knowledge at the moment it's learned; session_start hands
    // the next session one bounded brief instead of making it re-derive the project.
    const { recordSession, buildBrief, parseContinuity, continuityPathFor, CONTINUITY_LIMITS } = await import('../lib/continuity.mjs');
    const assigned = applyBoardUpdate('', { agent: 'owner', status: 'TODO',
        title: 'Distinct reviewer task', assignee: 'codex-reviewer' });
    const wrongPickup = applyBoardUpdate(assigned.content,
        { agent: 'codex', status: 'IN_PROGRESS', title: 'Distinct reviewer task' });
    check('a shorter AI name creates its own entry instead of taking the reviewer task',
        wrongPickup.action === 'created' && parseBoardEntries(wrongPickup.content).length === 2
        && parseBoardEntries(wrongPickup.content)[0].status === 'TODO');
    const rightPickup = applyBoardUpdate(assigned.content,
        { agent: ' CODEX-REVIEWER ', status: 'IN_PROGRESS', title: 'Distinct reviewer task' });
    check('the exact assignee still takes over the original task', rightPickup.action === 'updated'
        && parseBoardEntries(rightPickup.content).length === 1
        && parseBoardEntries(rightPickup.content)[0].fields['Opened by'] === 'owner');
    const briefProject = path.join(tmpRoot, 'identity-brief');
    fs.mkdirSync(path.join(briefProject, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(briefProject, 'docs', 'handoff', 'BOARD.md'), assigned.content);
    check('session brief does not assign reviewer work to a shorter AI name',
        !buildBrief(briefProject, { ai: 'codex' }).includes('## Assigned to you')
        && buildBrief(briefProject, { ai: 'codex-reviewer' }).includes('## Assigned to you'));
    const { assessContext, contextPathFor } = await import('../lib/context.mjs');
    const contFile = continuityPathFor(projectDir);
    const rec1 = recordSession(projectDir, {
        ai: 'claude', headline: 'wired the exporter', did: 'built lib/export.mjs', next: 'hook it to the CLI',
        learned: ['Exports must stay streaming — the 2 GB dumps OOM otherwise.']
    });
    check('session recorded', rec1.sessionCount === 1 && fs.existsSync(contFile), JSON.stringify(rec1));
    const rec2 = recordSession(projectDir, {
        ai: 'gemini', headline: 'reviewed the exporter', did: 'found an edge case',
        learned: ['Exports must stay streaming — the 2 GB dumps OOM otherwise.', 'Config lives in .plutos/, never in src/.']
    });
    const parsedCont = parseContinuity(fs.readFileSync(contFile, 'utf8'));
    check('second session appended, not overwritten', parsedCont.sessions.length === 2
        && parsedCont.sessions[1].ai === 'gemini', JSON.stringify(parsedCont.sessions.map(s => s.ai)));
    const assessedCont = assessContext(projectDir);
    check('AI-authored notes stay out of the authoritative decision digest', parsedCont.digest.length === 0, JSON.stringify(parsedCont.digest));
    check('plain learned notes are deduplicated but remain visibly unverified',
        assessedCont.unverified.length === 2 && assessedCont.current.length === 0,
        JSON.stringify(assessedCont.counts));

    // The session brief is short and names where the rest is; the handover export's full form carries it all.
    const brief = buildBrief(projectDir, { ai: 'gemini', full: true });
    const shortBrief = buildBrief(projectDir, { ai: 'gemini' });
    check('brief carries durable knowledge forward', brief.includes('stay streaming'));
    check('the short brief counts the shared claims and names where they are, without their text',
        /2 unverified claim\(s\) in `docs\/handoff\/CONTEXT\.json`/.test(shortBrief) && !shortBrief.includes('stay streaming'), shortBrief);
    check('brief shows where the last session left off', brief.includes('reviewed the exporter') && shortBrief.includes('reviewed the exporter'));
    check('brief lists what to read with sizes', /AGENTS\.md.*KB/.test(brief));
    // Both briefs name the install's skill path once; masked, so a long checkout path (a clone under the
    // temp folder) does not move the ratio.
    const masked = text => text.split(path.normalize(SCOPE_SKILL)).join('<SKILL>');
    check('the short brief is a fraction of the full one', masked(shortBrief).length * 2 < masked(brief).length, `${masked(shortBrief).length} of ${masked(brief).length}`);
    // Whether the session's ending gets recorded is a fact about the environment the session
    // is working in, and the brief never said it — so an AI could not tell an unrecorded
    // session from a recorded one. Off is the default and the common case; when it is on, the
    // section must disappear rather than nag.
    check('brief says when automatic capture is off', brief.includes('Automatic capture is OFF'));
    check('and names session_end as what to do instead', /Automatic capture is OFF[\s\S]{0,200}session_end/.test(brief));
    {
        const { setContextAutomation } = await import('../lib/context-automation.mjs');
        setContextAutomation(projectDir, true);
        check('the notice disappears once capture is on',
            !buildBrief(projectDir, { ai: 'gemini', full: true }).includes('Automatic capture is OFF'));
        setContextAutomation(projectDir, false);
    }
    // The generated code map is the answer to "where does X live?" without opening source,
    // and the fallback when no codebase-memory MCP is wired. It was refreshed on every
    // session_start and named in none of them, so agents grepped the tree instead of
    // reading the map already on disk.
    {
        const aiDir = path.join(projectDir, 'docs', 'ai');
        fs.mkdirSync(aiDir, { recursive: true });
        fs.writeFileSync(path.join(aiDir, 'CODEINDEX.md'), '# CODEINDEX\n[src/app.js] main\n');
        check('brief points at the generated code map', /CODEINDEX\.md.*KB/.test(buildBrief(projectDir, { ai: 'gemini', full: true }))
            && /CODEINDEX\.md/.test(buildBrief(projectDir, { ai: 'gemini' })));
    }
    check('brief is bounded (not a dump of everything)', brief.split('\n').length < 80, `${brief.split('\n').length} lines`);

    const hostileContinuityDir = path.join(tmpRoot, 'hostile-continuity');
    fs.mkdirSync(path.join(hostileContinuityDir, 'docs', 'handoff'), { recursive: true });
    recordSession(hostileContinuityDir, {
        ai: 'cursor\n### forged-ai · cursor · injected',
        headline: 'safe\n### forged-session · cursor · injected',
        learned: ['fact\n## Injected section', 'X'.repeat(512 * 1024)]
    });
    const hostileFile = continuityPathFor(hostileContinuityDir);
    const hostileRaw = fs.readFileSync(hostileFile, 'utf8');
    const hostileParsed = parseContinuity(hostileRaw);
    check('multiline continuity input cannot forge sessions or sections',
        hostileParsed.sessions.length === 1
        && !/^## Injected section$/m.test(hostileRaw)
        && !/^### forged/m.test(hostileRaw));
    const hostileContextRaw = fs.readFileSync(contextPathFor(hostileContinuityDir), 'utf8');
    check('oversized continuity facts are bounded before persistence',
        Buffer.byteLength(hostileContextRaw) < 16 * 1024 && hostileContextRaw.includes('...[truncated]'),
        `${Buffer.byteLength(hostileContextRaw)} bytes`);
    let badContinuityTypeRejected = false;
    try { recordSession(hostileContinuityDir, { ai: ['cursor'], headline: 'bad type' }); } catch (e) {
        badContinuityTypeRejected = /ai must be a string/.test(e.message);
    }
    check('continuity rejects non-string identity fields', badContinuityTypeRejected);

    const hugeBriefDir = path.join(tmpRoot, 'huge-brief');
    fs.mkdirSync(path.join(hugeBriefDir, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(continuityPathFor(hugeBriefDir), [
        '# CONTINUITY', '', '## Digest - durable knowledge',
        ...Array.from({ length: 40 }, (_, i) => `- ${i}:${'Y'.repeat(16 * 1024)}`),
        '', '## Sessions', ''
    ].join('\n'));
    const hugeBrief = buildBrief(hugeBriefDir, { ai: 'cursor', full: true });
    check('brief has a hard UTF-8 byte budget',
        Buffer.byteLength(hugeBrief, 'utf8') <= CONTINUITY_LIMITS.briefBytes
        && hugeBrief.includes('brief truncated at the hard byte budget'),
        `${Buffer.byteLength(hugeBrief, 'utf8')} bytes`);

    const archiveFailureDir = path.join(tmpRoot, 'archive-failure');
    fs.mkdirSync(path.join(archiveFailureDir, 'docs', 'handoff'), { recursive: true });
    for (let i = 1; i <= 5; i++) recordSession(archiveFailureDir, { ai: 'cursor', headline: `kept ${i}` });
    fs.writeFileSync(path.join(archiveFailureDir, 'docs', 'handoff', 'archive'), 'blocks archive directory creation');
    let archiveFailureReported = false;
    try { recordSession(archiveFailureDir, { ai: 'cursor', headline: 'kept 6' }); } catch (e) {
        archiveFailureReported = true;
    }
    check('archive failure keeps every session recoverable in the live file',
        archiveFailureReported
        && parseContinuity(fs.readFileSync(continuityPathFor(archiveFailureDir), 'utf8')).sessions.length === 6);

    // Sessions past the budget rotate to the archive instead of growing the live file forever.
    for (let i = 3; i <= 7; i++) recordSession(projectDir, { ai: 'claude', headline: `session ${i}` });
    const afterRotate = parseContinuity(fs.readFileSync(contFile, 'utf8'));
    check('live session ledger stays within budget', afterRotate.sessions.length === 5, `${afterRotate.sessions.length} sessions`);
    const sessionArchive = path.join(projectDir, 'docs', 'handoff', 'archive');
    check('rotated sessions preserved in the archive', fs.existsSync(sessionArchive)
        && fs.readdirSync(sessionArchive).some(f => f.startsWith('SESSIONS-')
            && fs.readFileSync(path.join(sessionArchive, f), 'utf8').includes('wired the exporter')));
    check('shared context survives session rotation', assessContext(projectDir).unverified.length === 2);

    {
        const gitDir = path.join(tmpRoot, 'git-summary');
        fs.mkdirSync(path.join(gitDir, 'docs', 'handoff'), { recursive: true });
        fs.mkdirSync(path.join(gitDir, 'docs', 'ai'), { recursive: true });
        fs.mkdirSync(path.join(gitDir, 'lib'), { recursive: true });
        const ggit = (...a) => execFileSync('git', a, { cwd: gitDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        ggit('init', '-q'); ggit('config', 'user.email', 's@t.test'); ggit('config', 'user.name', 'S');
        fs.writeFileSync(path.join(gitDir, 'app.mjs'), 'export const a = 1;\n');
        ggit('add', '-A'); ggit('commit', '-qm', 'start');
        recordSession(gitDir, { ai: 'cursor', headline: 'baseline' });
        fs.writeFileSync(path.join(gitDir, 'app.mjs'), 'export const a = 2;\n');
        fs.writeFileSync(path.join(gitDir, 'lib', 'new.mjs'), 'export const n = 1;\n');
        fs.writeFileSync(path.join(gitDir, 'docs', 'ai', 'CODEINDEX.md'), '# generated\n');
        ggit('add', '-A'); ggit('commit', '-qm', 'landed work');
        const gitBrief = buildBrief(gitDir, { ai: 'cursor', full: true });
        check('the short brief counts the commits that landed and points at git',
            /1 commit\(s\) landed since that session: `git log`/.test(buildBrief(gitDir, { ai: 'cursor' })));
        const landed = (gitBrief.split('## Landed since')[1] || '').split('\n## ')[0];
        check('brief lists files git landed since last session',
            /app\.mjs/.test(landed) && /lib\/new\.mjs/.test(landed), landed);
        check('git summary skips generated indexes and the continuity ledger',
            !/CODEINDEX/.test(landed) && !/CONTINUITY\.md/.test(landed), landed);
    }

    {
        const idDir = path.join(tmpRoot, 'session-idempotent');
        fs.mkdirSync(path.join(idDir, 'docs', 'handoff'), { recursive: true });
        const first = recordSession(idDir, {
            ai: 'cursor', headline: 'same work', did: 'wrote the fix', operationId: 'op-session-1'
        });
        const retry = recordSession(idDir, {
            ai: 'cursor', headline: 'same work', did: 'wrote the fix', operationId: 'op-session-1'
        });
        check('same operation id does not duplicate a session',
            first.duplicate === false && retry.duplicate === true
            && parseContinuity(fs.readFileSync(continuityPathFor(idDir), 'utf8')).sessions.length === 1);
        const payload = recordSession(idDir, { ai: 'cursor', headline: 'payload retry', did: 'did the thing' });
        const payloadRetry = recordSession(idDir, { ai: 'cursor', headline: 'payload retry', did: 'did the thing' });
        check('identical session_end payload is treated as a retry',
            payload.duplicate === false && payloadRetry.duplicate === true
            && parseContinuity(fs.readFileSync(continuityPathFor(idDir), 'utf8')).sessions.length === 2);
        const different = recordSession(idDir, { ai: 'cursor', headline: 'payload retry', did: 'did something else' });
        check('a different payload still records a new session',
            different.duplicate === false
            && parseContinuity(fs.readFileSync(continuityPathFor(idDir), 'utf8')).sessions.length === 3);
    }

    {
        const { createAgent } = await import('../lib/agents.mjs');
        const failDir = path.join(tmpRoot, 'agent-rollback');
        fs.mkdirSync(path.join(failDir, 'docs', 'handoff', 'ROSTER.md'), { recursive: true });
        let threw = false;
        try {
            createAgent(failDir, { name: 'rollback-agent', owner: 'cursor', role: 'x' });
        } catch (e) {
            threw = true;
        }
        check('createAgent throws when roster registration fails', threw);
        check('failed createAgent leaves no orphan template',
            !fs.existsSync(path.join(failDir, '.claude', 'agents', 'rollback-agent.md')));
    }

    const contApi = await get('/api/continuity');
    check('continuity and claim status are readable via API', contApi.exists === true
        && contApi.digest.length === 0 && contApi.sessions.length === 5
        && contApi.context?.counts?.unverified === 2,
        JSON.stringify({ d: contApi.digest?.length, s: contApi.sessions?.length, c: contApi.context?.counts }));

    // 5a4b. Decisions ("case law") — isolated project so it can't perturb the sequence above.
    // Recorded via `decided`, merged into the digest with a DECISION marker, and surfaced in
    // the brief flagged as settled so no later session silently re-opens the call.
    const decDir = path.join(tmpRoot, 'decisions-project');
    fs.mkdirSync(path.join(decDir, 'docs', 'handoff'), { recursive: true });
    recordSession(decDir, {
        ai: 'claude', headline: 'chose the payment provider',
        decided: ['Use Stripe, not Paddle — existing merchant account.'],
        learned: ['Webhooks must be idempotent by event id.']
    });
    const decCont = parseContinuity(fs.readFileSync(continuityPathFor(decDir), 'utf8'));
    check('a decision lands in the digest marked DECISION',
        decCont.digest.some(d => /^DECISION:.*Stripe/.test(d)), JSON.stringify(decCont.digest));
    check('the session block records the Decided field',
        decCont.sessions.some(s => (s.fields.Decided || '').includes('Stripe')), JSON.stringify(decCont.sessions.map(s => s.fields)));
    const decBrief = buildBrief(decDir, { ai: 'cursor', full: true });
    check('brief flags decisions as settled (do not re-open)', /⚖️ \*\*Decided:\*\* Use Stripe/.test(decBrief)
        && /## Settled decisions[\s\S]*⚖️ Use Stripe/.test(buildBrief(decDir, { ai: 'cursor' })));
    check('a decision is not double-listed as a plain fact', (decBrief.match(/Use Stripe/g) || []).length === 1);
    // re-recording the same decision does not duplicate it in the digest
    recordSession(decDir, { ai: 'gemini', headline: 're-touch', decided: ['Use Stripe, not Paddle — existing merchant account.'] });
    check('a repeated decision is not duplicated',
        parseContinuity(fs.readFileSync(continuityPathFor(decDir), 'utf8')).digest.filter(d => /Stripe/.test(d)).length === 1);

    // Evidence-aware context: a model-authored sentence is never authoritative by itself.
    // Exact evidence + unchanged source makes it current; any source movement quarantines it.
    const verifiedDir = path.join(tmpRoot, 'verified-context');
    fs.mkdirSync(path.join(verifiedDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(verifiedDir, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(verifiedDir, 'src', 'limits.js'), 'export const MAX_UPLOAD_MB = 20;\n', 'utf8');
    const verifiedRecord = recordSession(verifiedDir, {
        ai: 'claude', headline: 'captured upload contract',
        learned: [{
            claim: 'Uploads are capped at 20 MB.',
            sources: [{ path: 'src/limits.js', evidence: 'MAX_UPLOAD_MB = 20' }]
        }]
    });
    let verifiedAssessment = assessContext(verifiedDir);
    check('exact evidence records a source-backed claim',
        verifiedRecord.context?.sourceBacked === 1 && verifiedAssessment.current.length === 1,
        JSON.stringify(verifiedAssessment.counts));
    check('source-backed brief names the exact source',
        /Source-backed shared context[\s\S]*Uploads are capped[\s\S]*src\/limits\.js/.test(buildBrief(verifiedDir, { full: true })));
    // An edit elsewhere in the file leaves the cited excerpt intact: re-check, not quarantine.
    fs.writeFileSync(path.join(verifiedDir, 'src', 'limits.js'), '// upload settings\nexport const MAX_UPLOAD_MB = 20;\nexport const MAX_FILES = 3;\n', 'utf8');
    verifiedAssessment = assessContext(verifiedDir);
    check('an edit elsewhere in a cited file moves the claim to re-check, not quarantine',
        verifiedAssessment.review.length === 1 && verifiedAssessment.stale.length === 0 && verifiedAssessment.current.length === 0
        && /excerpt is still there verbatim/.test(verifiedAssessment.review[0].reasons.join(' ')), JSON.stringify(verifiedAssessment.counts));
    check('the brief lists a re-check claim in its own section',
        /Shared context to re-check[\s\S]*Uploads are capped/.test(buildBrief(verifiedDir, { full: true })));
    const contextFile = path.join(verifiedDir, 'docs', 'handoff', 'CONTEXT.json');
    const contextBefore = fs.readFileSync(contextFile, 'utf8');
    const forgedRegistry = JSON.parse(contextBefore);
    forgedRegistry.claims[0].sources[0].evidence = 'export const';
    fs.writeFileSync(contextFile, JSON.stringify(forgedRegistry), 'utf8');
    check('a stored excerpt edited to match anything does not soften the check',
        assessContext(verifiedDir).stale.length === 1);
    const legacyRegistry = JSON.parse(contextBefore);
    delete legacyRegistry.claims[0].sources[0].evidence;
    fs.writeFileSync(contextFile, JSON.stringify(legacyRegistry), 'utf8');
    check('a claim captured before excerpts were stored still quarantines on any edit',
        assessContext(verifiedDir).stale.length === 1);
    fs.writeFileSync(contextFile, contextBefore, 'utf8');
    fs.writeFileSync(path.join(verifiedDir, 'src', 'limits.js'), 'export const MAX_UPLOAD_MB = 25;\n', 'utf8');
    verifiedAssessment = assessContext(verifiedDir);
    check('a changed source quarantines its formerly current claim',
        verifiedAssessment.current.length === 0 && verifiedAssessment.stale.length === 1
        && /source changed/.test(verifiedAssessment.stale[0].reasons.join(' ')),
        JSON.stringify(verifiedAssessment));

    recordSession(verifiedDir, {
        ai: 'cursor', headline: 'captured unsupported notes',
        learned: [
            { claim: 'The limit is definitely 99 MB.', sources: [{ path: 'src/limits.js', evidence: 'MAX_UPLOAD_MB = 99' }] },
            { claim: 'A parent-directory secret controls uploads.', sources: [{ path: '../outside.txt', evidence: 'secret' }] }
        ]
    });
    verifiedAssessment = assessContext(verifiedDir);
    check('an evidence mismatch stays unverified',
        verifiedAssessment.unverified.some(item => /99 MB/.test(item.claim)
            && /not found/.test(item.reasons.join(' '))));
    check('a traversal source is never read and stays unverified',
        verifiedAssessment.unverified.some(item => /parent-directory/.test(item.claim)
            && /leaves the project/.test(item.reasons.join(' '))));

    const legacyDir = path.join(tmpRoot, 'legacy-context');
    fs.mkdirSync(path.join(legacyDir, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(continuityPathFor(legacyDir), [
        '# CONTINUITY', '', '## Digest — durable knowledge',
        '- Old AI note with no provenance.', '', '## Sessions', ''
    ].join('\n'));
    const legacyBrief = buildBrief(legacyDir, { full: true });
    check('legacy digest facts are labeled unverified instead of silently trusted',
        /Unverified notes[\s\S]*Old AI note/.test(legacyBrief)
        && !/Source-backed shared context[\s\S]*Old AI note/.test(legacyBrief));

    // Markdown freshness is stricter for shared claims than the dashboard's visual grace
    // period: one later commit to a file the doc names is enough to quarantine the claim.
    const driftContextDir = path.join(tmpRoot, 'context-doc-drift');
    fs.mkdirSync(path.join(driftContextDir, 'docs', 'handoff'), { recursive: true });
    fs.mkdirSync(path.join(driftContextDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(driftContextDir, 'src', 'app.js'), 'export const mode = "safe";\n');
    fs.writeFileSync(path.join(driftContextDir, 'docs', 'guide.md'), '# Guide\nThe mode is safe. See `src/app.js`.\n');
    const contextGit = (...args) => execFileSync('git', args, { cwd: driftContextDir, stdio: ['ignore', 'pipe', 'ignore'] });
    contextGit('init', '-q'); contextGit('config', 'user.email', 'c@t.test'); contextGit('config', 'user.name', 'C');
    contextGit('add', '-A'); contextGit('commit', '-qm', 'document safe mode');
    recordSession(driftContextDir, {
        ai: 'claude', headline: 'captured guide contract',
        learned: [{ claim: 'The documented mode is safe.', sources: [{ path: 'docs/guide.md', evidence: 'The mode is safe.' }] }]
    });
    check('a freshly captured markdown claim is current', assessContext(driftContextDir).current.length === 1);
    fs.writeFileSync(path.join(driftContextDir, 'src', 'app.js'), 'export const mode = "fast";\n');
    const uncommittedContextDrift = assessContext(driftContextDir);
    check('an uncommitted code change immediately quarantines a citing markdown claim',
        uncommittedContextDrift.stale.length === 1
        && /referenced code changed/.test(uncommittedContextDrift.stale[0].reasons.join(' ')),
        JSON.stringify(uncommittedContextDrift));
    contextGit('add', 'src/app.js'); contextGit('commit', '-qm', 'change mode implementation');
    const driftedContext = assessContext(driftContextDir);
    check('committed markdown-to-code drift remains quarantined inside the UI grace window',
        driftedContext.stale.length === 1 && /referenced code changed|references changed code/.test(driftedContext.stale[0].reasons.join(' ')),
        JSON.stringify(driftedContext));

    // The bounded registry has to be bounded by the SAME number at both ends. It was not: the
    // writer's truncation marker is 15 characters and the offset subtracted 13, so any clipped
    // claim came out at claimChars + 2 — and the reader refuses anything over claimChars. ONE
    // over-long claim therefore made the whole file unreadable and every claim in it read as
    // unverified. This asserts the round trip, not the arithmetic.
    const capDir = path.join(tmpRoot, 'context-cap-roundtrip');
    fs.mkdirSync(path.join(capDir, 'docs', 'handoff'), { recursive: true });
    const { CONTEXT_LIMITS, normalizeLearned } = await import('../lib/context.mjs');
    const overLong = 'A'.repeat(CONTEXT_LIMITS.claimChars * 2);
    check('a clipped claim never exceeds the cap its reader enforces',
        normalizeLearned([overLong])[0].claim.length <= CONTEXT_LIMITS.claimChars,
        String(normalizeLearned([overLong])[0].claim.length));
    recordSession(capDir, { ai: 'claude', headline: 'wrote a very long claim', did: 'x', next: 'y', learned: [overLong] });
    const capAssessed = assessContext(capDir);
    check('a registry holding a clipped claim still reads back', !capAssessed.error
        && capAssessed.unverified.length + capAssessed.current.length + capAssessed.stale.length === 1,
        JSON.stringify({ error: capAssessed.error, counts: capAssessed.counts }));

    // 5a5. Native PLUT_OS is complete with its coordinator. Context Mode and Codebase Memory
    // remain discoverable extensions, but their absence must not downgrade or nag sessions.
    const { detectTier } = await import('../lib/mcps.mjs');
    const mcpPathT = path.join(projectDir, '.mcp.json');
    const savedMcp = fs.readFileSync(mcpPathT, 'utf8');
    fs.writeFileSync(mcpPathT, JSON.stringify({ mcpServers: {
        plutos: { command: 'node', args: ['.plutos/plutos-launch.mjs'] },
        'codebase-memory-mcp': { command: 'npx', args: ['-y', 'codebase-memory-mcp'] },
        'context-mode': { command: 'npx', args: ['-y', 'context-mode'] }
    } }, null, 2));
    check('native tier stays full when optional MCP extensions are wired', detectTier(projectDir).tier === 'full', JSON.stringify(detectTier(projectDir)));
    fs.writeFileSync(mcpPathT, JSON.stringify({ mcpServers: { plutos: { command: 'node', args: ['.plutos/plutos-launch.mjs'] } } }, null, 2));
    const nativeTier = detectTier(projectDir);
    check('coordinator alone is the complete native tier', nativeTier.tier === 'full'
        && nativeTier.missing.length === 0
        && nativeTier.optional.includes('context-mode'), JSON.stringify(nativeTier));
    const nativeBrief = buildBrief(projectDir, { ai: 'claude' });
    check('session brief does not treat optional MCPs as missing capability',
        !nativeBrief.includes('BOARD ONLY')
        && !nativeBrief.includes('codebase-memory-mcp'), nativeBrief.slice(-240));
    fs.writeFileSync(mcpPathT, savedMcp); // restore for the repair checks below

    // 5a6. Status report — the third map (what happened / changed / next), assembled from
    // git + CONTINUITY + boards + hygiene, per request. Facts must carry sources and missing
    // sources must be stated, never guessed.
    await post('/api/board', {
        agent: 'owner', status: 'TODO', title: 'Report-visible follow-up',
        task: 'Keep one ordinary board task visible in the status report.'
    });
    const rep = await get('/api/report?days=30');
    check('report answers with stats + markdown', rep.project === 'demo-project'
        && typeof rep.markdown === 'string' && rep.markdown.includes('# STATUS REPORT'), rep.project);
    check('report shows recorded sessions', rep.sessions.length > 0
        && rep.markdown.includes('What happened'), `${rep.sessions.length} sessions`);
    check('report proposes next steps with sources', rep.nextSteps.length > 0
        && rep.nextSteps.every(n => n.source), JSON.stringify(rep.nextSteps.slice(0, 2)));
    check('report is honest about no git repo', rep.isGitRepo === false
        && rep.markdown.includes('Not a git repository'));
    check('report surfaces ordinary board TODOs without relying on MCP setup tasks', rep.stats.todo > 0
        && rep.nextSteps.some(n => n.source === 'board TODO'), JSON.stringify(rep.stats));
    check('report exposes dated commits for the Overview timeline', Array.isArray(rep.commitsDetailed));
    // In a REAL git repo the detailed commits must carry hash+date+subject and the legacy
    // string form must stay aligned — the drift fixture repo from earlier serves as one.
    const { buildStatusReport } = await import('../lib/report.mjs');
    const repGit = buildStatusReport(driftDir, { days: 90 });
    check('detailed commits carry hash, ISO date and subject', repGit.commitsDetailed.length > 0
        && repGit.commitsDetailed.every(c => c.hash && c.subject && !Number.isNaN(Date.parse(c.date))),
        JSON.stringify(repGit.commitsDetailed[0] || {}));
    check('legacy commit strings stay aligned with detailed ones',
        repGit.commits[0] === `${repGit.commitsDetailed[0].hash} ${repGit.commitsDetailed[0].subject}`);
    // The Overview module must be servable (it is the landing screen).
    const ovRes = await fetch(BASE + '/ui/modules/overview.js');
    check('ui/modules/overview.js served', ovRes.status === 200 && (await ovRes.text()).includes('fetchOverview'));

    // 5a7. Story deck: sessions' plain-language story lines accumulate into a pitch-style
    // presentation, merged chronologically from the LIVE ledger AND the archive — so the
    // roadmap survives session rotation. Sessions without a story fall back to their
    // headline, honestly labeled.
    recordSession(projectDir, { ai: 'claude', headline: 'payments milestone',
        story: 'Payments work now: a customer can actually buy the product.' });
    const { buildDeck, renderDeckMarkdown, renderDeckHtml } = await import('../lib/deck.mjs');
    const deck = buildDeck(projectDir);
    check('deck merges archived + live sessions chronologically', deck.slides.length >= 8
        && deck.slides[0].text.includes('wired the exporter'), `${deck.slides.length} slides, first: ${deck.slides[0]?.text}`);
    check('story line lands as a real slide', deck.slides.some(s => s.isStory
        && s.text.includes('customer can actually buy')), JSON.stringify(deck.slides.slice(-1)));
    check('storyless sessions fall back to headline, labeled', deck.slides.some(s => !s.isStory)
        && renderDeckMarkdown(deck).includes('no story line was recorded'));
    const deckApi = await get('/api/deck');
    check('deck readable via API with markdown', deckApi.slides.length === deck.slides.length
        && deckApi.markdown.includes('the story so far'));
    const deckPage = await (await fetch(BASE + '/deck')).text();
    check('/deck serves the standalone presentation', deckPage.includes('<!DOCTYPE html>')
        && deckPage.includes('customer can actually buy') && deckPage.includes('scroll-snap'));
    // The identity (2026-11-03): the cover and the close carry the mark, each copy with its own
    // gradient ids, and the close says the identity record's line in the deck's language.
    check('deck cover and close carry the mark with distinct ids', (deckPage.match(/class="deck-mark"/g) || []).length === 2
        && deckPage.includes('url(#pmg-cover)') && deckPage.includes('url(#pmg-close)')
        && /class="slide cover">/.test(deckPage) && /class="slide close">/.test(deckPage));
    check('deck close carries the identity line in the chosen language', deckPage.includes('one orbit per connected AI')
        && (await (await fetch(BASE + '/deck?lang=tr')).text()).includes('bağlı her yapay zekâ için bir yörünge'));
    check('deck html escapes content', renderDeckHtml({ project: 'x', generatedAt: '', what: '',
        slides: [{ date: '2026-01-01', ai: 'a', text: '<script>alert(1)</script>', isStory: true }], next: '' })
        .includes('&lt;script&gt;'));

    // 5a9. Universal guarantee: the BOARD layer reaches every project. A project with its
    // OWN AGENTS.md keeps it untouched but gets the compact PLUTOS_PROTOCOL.md next to the
    // boards — "connected but protocol missing" is closed. Our own kit projects don't get
    // the duplicate. Plus: POSIX launcher ships alongside the .bat, and Unreal is detected.
    const foreignDir = path.join(tmpRoot, 'foreign-project');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'AGENTS.md'), '# My own rules — do not touch\n');
    const fAdd = await post('/api/workspaces/add', { path: foreignDir });
    check('foreign-AGENTS project is observed', fAdd.success === true && fAdd.mode === 'observed');
    check('own AGENTS.md untouched', fs.readFileSync(path.join(foreignDir, 'AGENTS.md'), 'utf8').includes('do not touch'));
    check('observe mode adds no protocol beside foreign rules', !fs.existsSync(path.join(foreignDir, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md')));
    const foreignKit = await post('/api/project/install', {});
    check('foreign project kit installs only on explicit action', foreignKit.success === true);
    const protoFile = path.join(foreignDir, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md');
    check('minimal board protocol delivered next to the boards', fs.existsSync(protoFile)
        && fs.readFileSync(protoFile, 'utf8').includes('read BOARD.md'));
    check('kit projects do NOT get the duplicate protocol', !fs.existsSync(path.join(projectDir, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md')));
    const shFile = path.join(foreignDir, 'PLUT_OS.sh');
    check('POSIX launcher written alongside the .bat', fs.existsSync(shFile)
        && fs.readFileSync(shFile, 'utf8').includes('plutos-launch.mjs')
        && !fs.readFileSync(shFile, 'utf8').includes(__dirname));
    // NTFS carries no POSIX mode bits, so chmod is a no-op there and this assertion can only
    // mean something off Windows. Asserted where it is real, reported where it is not — rather
    // than failing the suite on the only platform CI currently runs.
    if (process.platform === 'win32') console.log('  ⏭️  POSIX launcher executable bit (not applicable on Windows)');
    else check('POSIX launcher is executable', (fs.statSync(shFile).mode & 0o111) !== 0);
    // Foreign project had no CLAUDE.md → the pointer must name the protocol file, not the
    // foreign AGENTS.md that never mentions boards.
    check('foreign pointer targets the protocol, not the foreign AGENTS.md',
        fs.readFileSync(path.join(foreignDir, 'CLAUDE.md'), 'utf8').includes('PLUTOS_PROTOCOL.md'));

    const unrealDir = path.join(tmpRoot, 'unreal-game');
    fs.mkdirSync(path.join(unrealDir, 'Source'), { recursive: true });
    fs.writeFileSync(path.join(unrealDir, 'MyGame.uproject'), '{}');
    fs.writeFileSync(path.join(unrealDir, 'Source', 'MyActor.h'), 'class AMyActor { public: void Tick(); };\n');
    const { scanProject: scanP } = await import('../lib/recommend.mjs');
    const { buildRecommendation: buildR } = await import('../lib/recommend.mjs');
    const unrealSignals = scanP(unrealDir);
    const unrealRec = buildR(unrealSignals, {});
    check('Unreal detected via .uproject', unrealSignals.stack === 'unreal', unrealSignals.stack);
    check('Unreal is recognised as a game, with no role advice from the core', !('roles' in unrealRec) && unrealRec.reasons.some(r => r.startsWith('game project: an Unreal')), JSON.stringify(unrealRec));



    const webDir = path.join(tmpRoot, 'web-app');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '^18', vite: '^5' } }));
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html></html>\n');
    const webAdd = await post('/api/workspaces/add', { path: webDir });
    check('web project add succeeds', webAdd.success === true, webAdd.message);
    check('web project is auto-detected without a picker', webAdd.detected && webAdd.detected.stack === 'node'
        && webAdd.detected.frameworks.includes('react'), JSON.stringify(webAdd.detected));
    check('web observe keeps generated maps out of source', !fs.existsSync(path.join(webDir, 'docs', 'ai', 'CODEINDEX.md'))
        && fs.existsSync(path.join(webAdd.storageRoot, 'docs', 'ai', 'CODEINDEX.md')));
    const webKit = await post('/api/project/install', {});
    check('web project gets its code index only after explicit kit install, and no public/ folder', webKit.success === true
        && fs.existsSync(path.join(webDir, 'docs', 'ai', 'CODEINDEX.md'))
        && !fs.existsSync(path.join(webDir, 'public'))
        && !fs.existsSync(path.join(webDir, '.mcp.json')));
    const webCfg = JSON.parse(fs.readFileSync(path.join(webDir, '.plutos', 'plutos.config.json'), 'utf8'));
    check('web project records its detected stack', webCfg.stack === 'node', JSON.stringify(webCfg));

    // known-issue S9: a signalPath in the request used to decide where a seed file was written,
    // outside the Hub sidecar included. Nothing reads it now, so nothing may be written there.
    const overrideDir = path.join(tmpRoot, 'override-signal');
    fs.mkdirSync(overrideDir, { recursive: true });
    const escapeDir = path.join(tmpRoot, 'signal-escape');
    const overrideAdd = await post('/api/workspaces/add', { path: overrideDir, signalPath: escapeDir });
    check('a caller-chosen signalPath writes nothing anywhere', overrideAdd.success === true && !fs.existsSync(escapeDir),
        JSON.stringify(overrideAdd.detected));

    await post('/api/workspaces/switch', { path: projectDir }); // restore for the checks below

    // 5b. Machine wiring (stable-registry stub): committed files carry NO absolute paths. The
    // stub follows stable install.json, with local.json only as a backward-compatible/custom-
    // home hint. Verify a portable move needs no project rewrite, then migrate a legacy MCP.
    const stubPath = path.join(projectDir, '.plutos', 'plutos-launch.mjs');
    check('launcher stub written', fs.existsSync(stubPath));
    const localCfg = JSON.parse(fs.readFileSync(path.join(projectDir, '.plutos', 'local.json'), 'utf8'));
    check('local.json points at this install', localCfg.plutosRoot === __dirname, localCfg.plutosRoot);
    check('local.json records the stable Hub for custom-home and legacy fallback',
        localCfg.plutosHome === path.resolve(process.env.PLUTOS_HOME), JSON.stringify(localCfg));
    const batNow = fs.readFileSync(path.join(projectDir, 'PLUT_OS.bat'), 'utf8');
    check('PLUT_OS.bat carries no absolute install path', !batNow.includes(__dirname) && batNow.includes('plutos-launch.mjs'));
    // The launcher used to `start` the browser itself, which raced the server (an error page
    // if the port was not bound yet) and, with the packaged app opening one too, produced two
    // tabs. The dashboard now owns it, once it is actually listening.
    check('launcher no longer opens the browser itself',
        !batNow.includes('start http') && batNow.includes('--open'), batNow);
    {
        const shNow = fs.readFileSync(path.join(projectDir, 'PLUT_OS.sh'), 'utf8');
        check('POSIX launcher defers the browser to the dashboard too',
            !shNow.includes('xdg-open') && shNow.includes('--open'), shNow);
    }
    // The packaged app is spawned DETACHED: the stub is started by PLUT_OS.bat, whose console
    // window lives exactly as long as the stub does. Staying attached left a dead terminal on
    // screen beside a windowless app — the exact thing the packaged build exists to avoid.
    // The stub only finds the install; starting it is lib/launch.mjs (tools/launcher-stub-test.mjs).
    {
        const stubNow = fs.readFileSync(stubPath, 'utf8');
        const launchNow = fs.readFileSync(path.join(__dirname, 'lib', 'launch.mjs'), 'utf8');
        check('the packaged app is launched detached', launchNow.includes('detached: true'));
        check('a non-Windows packaged app is found too', launchNow.includes("['PLUT_OS.exe', 'PLUT_OS']"));
        check('stub resolves moved builds through stable install.json before local fallback',
            stubNow.includes("path.join(hubDir, 'install.json')")
            && stubNow.includes('[read(installFile).appRoot, local.plutosRoot]'),
            stubNow.slice(0, 900));
        check('MCP imports are bound to the project that owns the launcher',
            launchNow.includes('process.env.PLUTOS_PROJECT_ROOT = projectRoot')
            && launchNow.includes("process.env.PLUTOS_PROJECT_BOUND_BY_LAUNCHER = '1'"));
    }
    {
        const { registerCurrentInstall } = await import('../lib/app-data.mjs');
        const movedInstall = path.join(tmpRoot, 'moved-portable-install');
        const probe = path.join(tmpRoot, 'stable-install-probe.txt');
        fs.mkdirSync(path.join(movedInstall, 'lib'), { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'lib', 'launch.mjs'), path.join(movedInstall, 'lib', 'launch.mjs'));
        fs.writeFileSync(path.join(movedInstall, 'index.mjs'),
            "import fs from 'fs'; fs.writeFileSync(process.env.PLUTOS_STUB_PROBE, process.env.PLUTOS_PROJECT_ROOT, 'utf8');\n");
        const beforeStub = fs.readFileSync(stubPath, 'utf8');
        const beforeLocal = fs.readFileSync(path.join(projectDir, '.plutos', 'local.json'), 'utf8');
        registerCurrentInstall({ appRoot: movedInstall, dataRoot: process.env.PLUTOS_HOME, packaged: true });
        execFileSync(process.execPath, [stubPath], {
            cwd: projectDir,
            env: { ...process.env, PLUTOS_STUB_PROBE: probe },
            stdio: 'ignore'
        });
        check('a moved build self-updates through stable data without rewriting the project',
            fs.readFileSync(probe, 'utf8') === path.resolve(projectDir)
            && fs.readFileSync(stubPath, 'utf8') === beforeStub
            && fs.readFileSync(path.join(projectDir, '.plutos', 'local.json'), 'utf8') === beforeLocal);
        registerCurrentInstall({ appRoot: __dirname, dataRoot: process.env.PLUTOS_HOME, packaged: false });
    }
    // .mcp.json is COMMITTED, so it is read on every teammate's machine, not just the one
    // that ran Add Project. It must therefore stay machine-independent: a relative path to
    // the project's own stub, which resolves this install's location from the gitignored
    // .plutos/local.json. An absolute path baked in here is the whole team's breakage —
    // everyone else's Claude Code would point at a directory that doesn't exist for them.
    {
        const wired = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
        const entry = wired.mcpServers && wired.mcpServers.plutos;
        check('.mcp.json wires the plutos server', !!entry, JSON.stringify(wired.mcpServers && Object.keys(wired.mcpServers)));
        check('.mcp.json points at the project-relative stub, not an absolute path',
            entry && entry.args.join(' ').includes('.plutos/plutos-launch.mjs')
            && !JSON.stringify(entry).includes(__dirname), JSON.stringify(entry));
    }
    const staleRoot = path.join(tmpRoot, 'stale-old-plutos-location');
    fs.mkdirSync(staleRoot, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.plutos', 'local.json'), JSON.stringify({ plutosRoot: staleRoot }), 'utf8');
    const mcpBefore = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
    mcpBefore.mcpServers.plutos = { command: 'node', args: [path.join(staleRoot, 'index.mjs')] }; // legacy absolute entry
    // Even a known old package name is now owner-managed: Project Links repairs PLUT_OS only.
    mcpBefore.mcpServers['context-mode'] = { command: 'npx', args: ['-y', 'context-mode-mcp'] };
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify(mcpBefore, null, 2));
    const repairPreview = await get(`/api/workspaces/repair/preview?project=${encodeURIComponent(projectDir)}`);
    check('repair preview names the target and leaves stale files unchanged', repairPreview.projectRoot === fs.realpathSync(projectDir)
        && JSON.parse(fs.readFileSync(path.join(projectDir, '.plutos', 'local.json'), 'utf8')).plutosRoot === staleRoot);
    const repair = await post('/api/workspaces/repair', { projectRoot: repairPreview.projectRoot, token: repairPreview.token });
    check('repair endpoint reports the previewed-project fix', repair.success === true && repair.changed.length > 0 && !!repair.backupId,
        JSON.stringify(repair));
    const localAfter = JSON.parse(fs.readFileSync(path.join(projectDir, '.plutos', 'local.json'), 'utf8'));
    check('repair re-points local fallback and stable Hub hint',
        localAfter.plutosRoot === __dirname && localAfter.plutosHome === path.resolve(process.env.PLUTOS_HOME),
        JSON.stringify(localAfter));
    const mcpAfter = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
    check('legacy absolute plutos entry migrated to project-bound stub',
        mcpAfter.mcpServers.plutos.args[0] === '${CLAUDE_PROJECT_DIR:-.}/.plutos/plutos-launch.mjs',
        JSON.stringify(mcpAfter.mcpServers.plutos));
    check('optional MCP entries untouched by project-link repair',
        JSON.stringify(mcpAfter.mcpServers['codebase-memory-mcp']) === JSON.stringify(mcpBefore.mcpServers['codebase-memory-mcp'])
        && JSON.stringify(mcpAfter.mcpServers['context-mode']) === JSON.stringify(mcpBefore.mcpServers['context-mode']));

    // Starting PLUT_OS used to sweep every registered installed project and rewrite its
    // launcher/MCP files. Stable install.json removes that need: no project is touched until
    // the owner opens it (which replaces only an older generated stub) or repairs/connects it.
    {
        const untouchedProject = path.join(tmpRoot, 'registered-but-untouched');
        const untouchedStub = path.join(untouchedProject, '.plutos', 'plutos-launch.mjs');
        const untouchedMcp = path.join(untouchedProject, '.mcp.json');
        fs.mkdirSync(path.dirname(untouchedStub), { recursive: true });
        fs.writeFileSync(untouchedStub, '// owner sentinel — do not rewrite\n');
        fs.writeFileSync(untouchedMcp, JSON.stringify({ mcpServers: { owner: { command: 'owner-tool' } } }, null, 2));
        const untouchedAdd = await post('/api/workspaces/add', { path: untouchedProject });
        check('an existing installed project can be registered without repair writes',
            untouchedAdd.success === true
            && fs.readFileSync(untouchedStub, 'utf8') === '// owner sentinel — do not rewrite\n');
        await post('/api/workspaces/switch', { path: projectDir });

        const secondPort = await freePort();
        const second = spawn(process.execPath, [path.join(__dirname, 'dashboard.mjs')], {
            env: { ...process.env, PLUTOS_PORT: String(secondPort), PLUTOS_HOME: process.env.PLUTOS_HOME },
            stdio: 'ignore'
        });
        try {
            const deadline = Date.now() + 8000;
            let ready = false;
            while (Date.now() < deadline) {
                try {
                    const response = await fetch(`http://127.0.0.1:${secondPort}/api/workspaces`);
                    if (response.ok) { ready = true; break; }
                } catch {}
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            check('second dashboard instance starts for no-write startup proof', ready);
        } finally {
            second.kill();
        }
        check('dashboard startup does not rewrite any registered project',
            fs.readFileSync(untouchedStub, 'utf8') === '// owner sentinel — do not rewrite\n'
            && JSON.parse(fs.readFileSync(untouchedMcp, 'utf8')).mcpServers.owner.command === 'owner-tool');
        await post('/api/workspaces/remove', { path: untouchedProject });
    }

    // 5y1. Launching PLUT_OS from a project's own launcher must OPEN that project. The stub
    // (lib/workspaces.mjs writeLauncherStub) exports PLUTOS_PROJECT_ROOT and
    // PLUTOS_PROJECT_BOUND_BY_LAUNCHER before loading anything; index.mjs honoured them and the
    // dashboard did not, so the owner's PLUT_OS.bat opened whichever project hub_config
    // happened to remember. A whole separate hub is used here because a bound launch WRITES
    // (it registers and opens), and the suite's main hub must stay as the other sections left it.
    {
        const boundProject = path.join(tmpRoot, 'launcher-bound-project');
        fs.mkdirSync(boundProject, { recursive: true });
        const boundHome = path.join(tmpRoot, 'launcher-hub');

        // Boots a dashboard against that private hub and reports what it considers open.
        const bootAndRead = async (extraEnv) => {
            const port = await freePort();
            const child = spawn(process.execPath, [path.join(__dirname, 'dashboard.mjs')], {
                env: { ...process.env, PLUTOS_PORT: String(port), PLUTOS_HOME: boundHome, ...extraEnv },
                stdio: 'ignore'
            });
            // Subscribed before the kill below, so the exit can never be missed. Waiting for it
            // is not politeness: kill() only signals, and a dashboard still shutting down holds
            // its hub directory open, which makes the suite's final rmSync(tmpRoot) fail on
            // Windows — force:true forgives a missing directory, not a locked one.
            const exited = new Promise(resolve => child.once('exit', resolve));
            try {
                const deadline = Date.now() + 8000;
                while (Date.now() < deadline) {
                    try {
                        const response = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
                        if (response.ok) return await response.json();
                    } catch {}
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return null;
            } finally {
                child.kill();
                await exited;
            }
        };

        // Nothing is registered in this hub yet — the launcher stub is proof enough that the
        // owner wired this project, so a bound launch has to register AND open it.
        const firstBoot = await bootAndRead({
            PLUTOS_PROJECT_ROOT: boundProject,
            PLUTOS_PROJECT_BOUND_BY_LAUNCHER: '1'
        });
        check('a launcher-bound dashboard opens the project that owns the launcher',
            !!firstBoot && sameProjectPath(firstBoot.activeWorkspace || '', boundProject),
            JSON.stringify(firstBoot && firstBoot.activeWorkspace));

        // Same launch again, now that the project IS registered: it must reopen through the
        // switch path rather than adding a second entry for the same folder.
        const secondBoot = await bootAndRead({
            PLUTOS_PROJECT_ROOT: boundProject,
            PLUTOS_PROJECT_BOUND_BY_LAUNCHER: '1'
        });
        check('a repeated bound launch reopens without duplicating the registry entry',
            !!secondBoot && sameProjectPath(secondBoot.activeWorkspace || '', boundProject)
            && secondBoot.workspaces.filter(w => sameProjectPath(w, boundProject)).length === 1,
            JSON.stringify(secondBoot && secondBoot.workspaces));

        // The plain launch is the other half of the contract and the easier one to break:
        // without the launcher variables the same hub — which now remembers this project —
        // must still come up with nothing open, offering it as one click instead.
        const plainBoot = await bootAndRead({});
        check('an unbound launch still opens the no-project Hub and only remembers the project',
            !!plainBoot && !plainBoot.activeWorkspace
            && sameProjectPath(plainBoot.lastWorkspace || '', boundProject),
            JSON.stringify(plainBoot && { active: plainBoot.activeWorkspace, last: plainBoot.lastWorkspace }));

        // A hand-set root that points nowhere must not cost the owner the whole app.
        const brokenBoot = await bootAndRead({
            PLUTOS_PROJECT_ROOT: path.join(tmpRoot, 'no-such-project'),
            PLUTOS_PROJECT_BOUND_BY_LAUNCHER: '1'
        });
        check('a bound launch at a missing folder still starts, on the no-project Hub',
            !!brokenBoot && !brokenBoot.activeWorkspace,
            JSON.stringify(brokenBoot && brokenBoot.activeWorkspace));
    }

    // 5z. Live activity strip. The demo project is not a git repo, so this also pins the
    // "no git" degradation: the endpoint must answer with an empty, well-formed shape
    // instead of throwing — it is polled every few seconds and a throw would spam 500s.
    const act0 = await get('/api/activity');
    check('activity endpoint answers on a non-git project',
        act0.hasProject === true && act0.isGitRepo === false && Array.isArray(act0.dirty) && act0.dirty.length === 0 && act0.dirtyCount === 0, JSON.stringify(act0).slice(0, 120));
    check('activity reports coordination files it can see',
        Array.isArray(act0.coordination) && act0.coordination.some(c => c.name === 'BOARD.md'), JSON.stringify(act0.coordination));
    check('activity fingerprint is a stable string', typeof act0.fingerprint === 'string' && act0.fingerprint.length > 0);

    // 5z1. Working-tree parsing against a real repo. This exists because the shared git()
    // helper used to .trim() its output, which ate the leading space of `git status
    // --porcelain`'s two-column code and silently truncated the FIRST filename by one
    // character ("dashboard.mjs" came back as "ashboard.mjs"). A filename with a space is
    // in here too: the -z parse must not split on it.
    const gitProject = path.join(tmpRoot, 'git-project');
    fs.mkdirSync(gitProject, { recursive: true });
    const g = (...args) => execFileSync('git', args, { cwd: gitProject, stdio: ['ignore', 'pipe', 'ignore'] });
    g('init', '-b', 'main');
    g('config', 'user.email', 'smoke@test.local');
    g('config', 'user.name', 'Smoke Test');
    fs.writeFileSync(path.join(gitProject, 'tracked file.txt'), 'one\n');
    g('add', '-A');
    g('commit', '-m', 'first commit');
    fs.writeFileSync(path.join(gitProject, 'tracked file.txt'), 'two\n');   // modified, unstaged
    fs.writeFileSync(path.join(gitProject, 'brand-new.txt'), 'new\n');      // untracked
    const { getActivity } = await import('../lib/activity.mjs');
    const act1 = getActivity(gitProject);
    check('activity detects the git repo and its branch', act1.isGitRepo === true && act1.branch === 'main', act1.branch);
    check('activity reads HEAD', act1.head && act1.head.subject === 'first commit', JSON.stringify(act1.head));
    check('activity counts both dirty entries', act1.dirtyCount === 2, String(act1.dirtyCount));
    const modified = act1.dirty.find(d => d.kind === 'modified');
    check('modified path is NOT truncated (the trim bug)', modified && modified.path === 'tracked file.txt', modified && modified.path);
    check('untracked file classified as untracked', act1.dirty.some(d => d.kind === 'untracked' && d.path === 'brand-new.txt'), JSON.stringify(act1.dirty));
    const act2 = getActivity(gitProject);
    check('fingerprint is stable while nothing changes', act2.fingerprint === act1.fingerprint);
    fs.writeFileSync(path.join(gitProject, 'brand-new.txt'), 'changed\n');
    check('fingerprint moves when the tree changes', getActivity(gitProject).fingerprint !== act1.fingerprint);
    check('activity never throws on a missing path', getActivity(path.join(tmpRoot, 'no-such-dir')).isGitRepo === false);
    // With no project selected the endpoint must NOT fall back to PLUT_OS's own repo:
    // the strip used to show this install's branch and dirty files under "proj: none".
    const noProject = getActivity(null);
    check('no workspace → hasProject false, never PLUT_OS own repo',
        noProject.hasProject === false && noProject.branch === null && noProject.fingerprint === 'no-project', JSON.stringify(noProject).slice(0, 100));

    // 5z1b. Module gating: the data-module tags in the HTML and the MODULES registry in
    // features.js must agree, or a tab becomes untogglable (tagged but unlisted) or a toggle
    // controls nothing (listed but untagged). Pure text-level check — no DOM needed.
    {
        const html = fs.readFileSync(path.join(__dirname, 'dashboard-ui.html'), 'utf8');
        const featSrc = fs.readFileSync(path.join(__dirname, 'ui', 'modules', 'features.js'), 'utf8');
        const tagged = [...html.matchAll(/data-module="([^"]+)"/g)].map(m => m[1]).sort();
        const listed = [...featSrc.matchAll(/\{ id: '([^']+)'/g)].map(m => m[1]).sort();
        check('module registry matches data-module tags', JSON.stringify(tagged) === JSON.stringify(listed),
            `html: ${tagged.join(',')} vs registry: ${listed.join(',')}`);
        check('core trio tabs are NOT module-gated',
            !tagged.includes('overview') && !tagged.includes('board') && !tagged.includes('setup') && !tagged.includes('settings'));
        // The Skills page: its tab, its section (the view- id convention router.js resolves) and its fetch.
        check('skills page has a gated tab, a section and a router fetch',
            tagged.includes('skills') && html.includes('id="view-skills"') && html.includes("switchView('skills', this)")
            && /viewId === 'skills'\) fetchSkills\(\)/.test(fs.readFileSync(path.join(__dirname, 'ui', 'modules', 'router.js'), 'utf8')));
        // One stray </div> closes .main-container early, and every page after it renders beside
        // the menu, 64 px wide (Job 18, the Documents markup). Walk the tags with comments and
        // scripts removed: each page section must open while the main container is still open.
        {
            const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/g, '');
            const stack = [], outside = [];
            const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
            for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
                const [, closing, tag, attrs] = m;
                if (closing) { const i = stack.map(t => t.tag).lastIndexOf(tag.toLowerCase()); if (i >= 0) stack.length = i; continue; }
                if (VOID.test(tag) || attrs.trim().endsWith('/')) continue;
                const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
                if (/\bview-section\b/.test(cls) && !stack.some(t => t.main)) outside.push((attrs.match(/id="([^"]*)"/) || [])[1] || '?');
                stack.push({ tag: tag.toLowerCase(), main: /\bmain-container\b/.test(cls) });
            }
            check('every page section sits inside the main container', outside.length === 0, outside.join(', '));
        }
        check('every module has a description key', listed.every(id => {
            const m = featSrc.match(new RegExp(`\\{ id: '${id}'[^}]*descKey: '([a-z_]+)'`));
            return m && fs.readFileSync(path.join(__dirname, 'ui', 'i18n.js'), 'utf8').includes(m[1] + ':');
        }));
        // i18n-guardian (docs/handoff/ROSTER.md): en and tr must carry the exact same keys.
        // Real incident (2026-08-28): a UI redesign moved i18n into this file and carried only
        // the English dictionary forward — tr silently fell from 382 keys to 65 with nothing
        // catching it until an owner noticed the language toggle barely spoke Turkish. Text-only
        // check (no ESM import, no DOM) so it stays consistent with the rest of this section.
        {
            const i18nSrc = fs.readFileSync(path.join(__dirname, 'ui', 'i18n.js'), 'utf8');
            const enStart = i18nSrc.indexOf('\n    en: {');
            const trStart = i18nSrc.indexOf('\n    tr: {');
            const keysOf = (block) => new Set([...block.matchAll(/^ {8}(\w+):/gm)].map(m => m[1]));
            const enKeys = keysOf(i18nSrc.slice(enStart, trStart));
            const trKeys = keysOf(i18nSrc.slice(trStart));
            const missingInTr = [...enKeys].filter(k => !trKeys.has(k));
            const extraInTr = [...trKeys].filter(k => !enKeys.has(k));
            check('i18n: en and tr keep identical key sets', enStart >= 0 && trStart > enStart && enKeys.size > 0 && missingInTr.length === 0 && extraInTr.length === 0,
                `en:${enKeys.size} tr:${trKeys.size} missing-in-tr:[${missingInTr.join(',')}] extra-in-tr:[${extraInTr.join(',')}]`);
        }
        // Owner correction (2026-08-01): the first module cut hid the knowledge-visibility
        // tabs too, which contradicts the product's purpose — seeing the shared knowledge IS
        // the product. These three must ship visible; flipping them off is the user's call
        // at runtime, never the default's.
        const defaultOn = (id) => new RegExp(`\\{ id: '${id}'[^}]*defaultOn: true`).test(featSrc);
        check('knowledge-visibility modules default ON (report, codeindex, dochub)',
            defaultOn('report') && defaultOn('codeindex') && defaultOn('dochub'));
        // Graphify is an extra the owner switches on, not part of the trio — and it shipped
        // ON, which also meant existing installs had the tab pushed into their stored module
        // list on next load (features.js merges new defaultOn ids into localStorage).
        check('graphify ships OFF, as an opt-in module', !defaultOn('graphify'));

        // The registry checks above are text-level and said nothing about whether a switch
        // actually switches. It did not: storing enablement as presence-in-a-list made
        // absence mean both "the user turned this off" and "this module is newer than the
        // saved choice", so the merge step handed every defaultOn module straight back and
        // unchecking Report, Codebase Index or Document Hub was a no-op that survived
        // reloads. Run the real module against a localStorage stub rather than assert on its
        // source. It is a browser .js and this package is not type:module, so it is copied to
        // a temp .mjs with its one i18n import stubbed — nothing below calls t().
        {
            const probeDir = fs.mkdtempSync(path.join(tmpRoot, 'featprobe-'));
            const probe = path.join(probeDir, 'features.probe.mjs');
            fs.writeFileSync(probe, featSrc.replace(/^import \{ t \} from '\.\.\/i18n\.js';$/m, 'const t = (k) => k;'));

            const store = new Map();
            const saved = { localStorage: globalThis.localStorage, window: globalThis.window, document: globalThis.document };
            globalThis.localStorage = {
                getItem: k => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => store.set(k, String(v)),
                removeItem: k => store.delete(k)
            };
            globalThis.window = {};
            globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
            try {
                const mod = await import(pathToFileURL(probe).href);
                const on = () => mod.enabledModules().slice().sort().join(',');

                // The default set names every defaultOn module; Skills joined it on 2026-11-04 (the
                // Skills page, canonical architecture item 9), so it is part of every expected set here.
                check('modules: no stored choice yields the defaults', on() === 'codeindex,costs,council,dochub,report,research,skills', on());

                globalThis.window.toggleModule('report', false);
                check('modules: switching Report off actually switches it off', on() === 'codeindex,costs,council,dochub,research,skills', on());
                // The regression was only visible on the NEXT read, so re-read rather than
                // trusting the value the handler happened to return.
                check('modules: Report stays off across a reload', on() === 'codeindex,costs,council,dochub,research,skills', on());

                globalThis.window.toggleModule('dochub', false);
                globalThis.window.toggleModule('council', false);
                globalThis.window.toggleModule('research', false);
                globalThis.window.toggleModule('skills', false);
                check('modules: every defaultOn module can be switched off', on() === 'codeindex,costs', on());

                globalThis.window.toggleModule('report', true);
                check('modules: switching one back on leaves the others off', on() === 'codeindex,costs,report', on());

                // A module added after the user saved a choice must still arrive at its
                // default — the one thing the old bare-array form got right, so a fix that
                // simply obeys storage verbatim would break it.
                store.set('plutos-modules', JSON.stringify({ on: ['codeindex'], known: ['codeindex'] }));
                check('modules: a module the user never saw still gets its default',
                    on() === 'codeindex,costs,council,dochub,report,research,skills', on());
                // Same for storage written by an older build, which had no `known` half.
                store.set('plutos-modules', JSON.stringify(['report', 'codeindex']));
                check('modules: storage from an older build still upgrades cleanly',
                    on() === 'codeindex,costs,council,dochub,report,research,skills', on());
            } finally {
                globalThis.localStorage = saved.localStorage;
                globalThis.window = saved.window;
                globalThis.document = saved.document;
            }
        }

        // showToast(msg, isError) is a boolean API, but 29 call sites across nine modules
        // pass a variant string; every non-empty string is truthy, so success toasts painted
        // themselves red. The function now accepts either form — this fails if that is undone.
        {
            const toastSrc = fs.readFileSync(path.join(__dirname, 'ui', 'modules', 'toast.js'), 'utf8');
            check('showToast understands variant strings, not just a boolean',
                /typeof\s+variant\s*===\s*'string'/.test(toastSrc) && /TOAST_COLORS/.test(toastSrc));
            const stringCallers = fs.readdirSync(path.join(__dirname, 'ui', 'modules'))
                .filter(f => f.endsWith('.js'))
                .filter(f => /showToast\([^)]*,\s*'(success|info|warning|error)'/.test(
                    fs.readFileSync(path.join(__dirname, 'ui', 'modules', f), 'utf8')));
            check('the variant-string callers are still covered by that contract',
                stringCallers.length > 0, stringCallers.join(','));
        }
    }

    // Graphify's routes must obey the same project contract as every other route: reads
    // answer empty, writes refuse with needsProject. Declared in lib/route-policy.mjs rather
    // than guarded per handler — the 2026-08-23 fix that moved thirty-six routes to one choke
    // point. Undeclared, they answered 400 with a shape nothing else in the API returns.
    {
        const { routeNeedsProject, PROJECT_WRITE_ROUTES } = await import('../lib/route-policy.mjs');
        check('the AI costs ledger needs an open project', routeNeedsProject('GET /api/usage'));
        check('graphify read routes are declared project-scoped',
            routeNeedsProject('GET /api/graphify'));
        check('graphify write routes refuse loudly rather than silently',
            PROJECT_WRITE_ROUTES.has('POST /api/graphify/scan')
            && PROJECT_WRITE_ROUTES.has('POST /api/graphify/clean'));

        const { MACHINE_IGNORES } = await import('../lib/workspaces.mjs');
        check('generated graphs are kept out of the user\'s git status',
            MACHINE_IGNORES.includes('graphify-out/'), MACHINE_IGNORES.join(' '));
        check('generated indexes too: the Obsidian shards name this machine\'s absolute paths',
            ['docs/ai/CODEINDEX.md', 'docs/ai/codeindex/', 'docs/ai/OBSIDIAN_INDEX.md', 'docs/ai/obsidian/'].every(e => MACHINE_IGNORES.includes(e)),
            MACHINE_IGNORES.join(' '));

        const dashSrc = fs.readFileSync(path.join(__dirname, 'dashboard.mjs'), 'utf8');
        check('graphify clean has no destructive default mode',
            !/searchParams\.get\('mode'\)\s*\|\|\s*'all'/.test(dashSrc));
    }

    // 5z1c. The owner can assign work from the dashboard. Until this endpoint the board was
    // read-only here — giving a task meant asking an AI to write the entry or hand-editing
    // BOARD.md, which is odd for the one action the product says the owner performs.
    {
        const assigned = await post('/api/board', {
            agent: 'owner', status: 'TODO', title: 'Wire the payments retry',
            task: 'Retry failed charges with backoff', assignee: 'gemini',
            role: 'backend', needs: ['api-design', 'code-hygiene']
        });
        check('owner can assign a task from the dashboard', assigned.success === true && assigned.action === 'created', assigned.message);
        const board = await get('/api/board');
        const entry = board.entries.find(e => e.title === 'Wire the payments retry');
        check('the assignment carries role and needs', entry && entry.fields.Role === 'backend'
            && entry.fields.Needs === 'api-design, code-hygiene', JSON.stringify(entry && entry.fields));
        check('assignee is recorded', entry && entry.fields.Assignee === 'gemini');
        // Same lib call as the MCP tool, so the same contract errors must surface as HTTP 400.
        const bad = await post('/api/board', { agent: 'owner', status: 'BANANA', title: 'x' });
        check('an invalid status is rejected, not written', bad.success === false && /status must be one of/.test(bad.message), bad.message);
        const noTitle = await post('/api/board', { agent: 'owner', status: 'TODO' });
        check('a task without a title is rejected', noTitle.success === false);
        // The strip reports native readiness only; third-party MCPs are not part of the tier.
        const act = await get('/api/activity');
        check('activity reports native PLUT_OS as complete',
            act.setup && act.setup.tier === 'full' && Array.isArray(act.setup.missing) && act.setup.missing.length === 0,
            JSON.stringify(act.setup));
        check('activity reports participants', Array.isArray(act.participants));
    }

    // 5z1c-1b. Add Project detects the stack, and that detection has to SURVIVE. It used to be
    // computed, shown once in the wizard, and dropped — only signalPath reached disk — so the
    // brief told an AI nothing about the project until someone ran a full project-intake pass.
    // Owner's framing (2026-08-28, translated): "so that it is written to plutos once the project has been worked out".
    {
        // Adding a workspace also switches to it, so this block borrows the active project and
        // must hand it back — every check after this one runs against whatever is active.
        const activeBefore = (await get('/api/workspaces')).activeWorkspace;
        const stackProj = path.join(tmpRoot, 'stack-detect');
        fs.mkdirSync(stackProj, { recursive: true });
        fs.writeFileSync(path.join(stackProj, 'package.json'),
            JSON.stringify({ name: 'x', dependencies: { react: '^18.0.0', express: '^4.0.0' } }), 'utf8');
        await post('/api/workspaces/add', { path: stackProj });
        // Observe mode keeps everything in the Hub sidecar, so the detection has to survive
        // the migration into the repo — installing the kit is where it becomes the project's.
        await post('/api/project/install', {});
        const cfg = JSON.parse(fs.readFileSync(path.join(stackProj, '.plutos', 'plutos.config.json'), 'utf8'));
        check('Add Project records the detected stack', cfg.stack === 'node', JSON.stringify(cfg));
        check('and the frameworks it found with it',
            Array.isArray(cfg.frameworks) && cfg.frameworks.includes('react'), JSON.stringify(cfg.frameworks));
        // The payoff: an AI arriving before any intake now learns the stack from the brief.
        const brief = buildBrief(stackProj, { ai: 'claude' });
        check('the session brief passes the detected stack on to the AI', /detected \*\*node/.test(brief), brief.slice(0, 300));
        check('and marks it a marker-file guess, not an understanding', /not an understanding/.test(brief));
        if (activeBefore) await post('/api/workspaces/switch', { path: activeBefore });
    }

    // 5z1c-2. The deferred list is the counterpart of assigning: the same owner action, the
    // opposite decision. It has to survive the same abuse the board does — the file is
    // committed and read back into AI context windows.
    {
        const parked = await post('/api/ideas', { text: 'Live agent transcript view — deferred, contradicts "communication, not control".' });
        check('an idea can be parked from the dashboard', parked.success === true && parked.action === 'added', parked.message);
        const ideas = await get('/api/ideas');
        check('the parked idea reads back', ideas.exists === true
            && ideas.ideas.some(i => /Live agent transcript view/.test(i.text) && i.settled === false),
            JSON.stringify(ideas.ideas));
        const again = await post('/api/ideas', { text: 'Live agent transcript view — deferred, contradicts "communication, not control".' });
        check('the same idea is not parked twice', again.action === 'exists', again.message);
        // A newline would otherwise write a second bullet — or a heading — into the file.
        const NL = String.fromCharCode(10);   // a literal escape here would be the thing under test
        await post('/api/ideas', { text: ['Forged', '## Injected section', '- fake idea'].join(NL) });
        const afterForge = await get('/api/ideas');
        check('a newline in an idea cannot forge a bullet or a heading',
            afterForge.ideas.every(i => i.section !== 'Injected section' && i.text !== 'fake idea'),
            JSON.stringify(afterForge.ideas.map(i => i.section + '|' + i.text)));
        const empty = await post('/api/ideas', { text: '   ' });
        check('an empty idea is rejected, not written', empty.success === false, empty.message);
        const notString = await post('/api/ideas', { text: ['a', 'b'] });
        check('a non-string idea is rejected with the contract error',
            notString.success === false && /must be a string/.test(notString.message), notString.message);

        // Owner report: "I have an IDEAS.md, why is it still not found — it is right in docs."
        // The fixed candidate list only covered the four conventional spots, and it never said
        // where it had looked. Both are the same defect: an unanswerable "not found".
        const ideasProbe = path.join(tmpRoot, 'ideas-probe');
        fs.mkdirSync(path.join(ideasProbe, 'docs', 'planning'), { recursive: true });
        const LF = String.fromCharCode(10);
        fs.writeFileSync(path.join(ideasProbe, 'docs', 'planning', 'Ideas.md'), ['# Ideas', '', '- Buried two folders down', ''].join(LF));
        check('an IDEAS.md under docs/<sub>/ is found, whatever its casing',
            ideasPathFor(ideasProbe) === path.join(ideasProbe, 'docs', 'planning', 'Ideas.md'),
            ideasPathFor(ideasProbe));
        check('the reader reports which file it read',
            readIdeas(ideasProbe).rel === 'docs/planning/Ideas.md', readIdeas(ideasProbe).rel);
        const emptyProbe = path.join(tmpRoot, 'ideas-none');
        fs.mkdirSync(emptyProbe, { recursive: true });
        check('with no file anywhere it still names where one would be created',
            readIdeas(emptyProbe).exists === false && readIdeas(emptyProbe).rel === 'IDEAS.md',
            readIdeas(emptyProbe).rel);
        const docsProbe = path.join(tmpRoot, 'ideas-docs');
        fs.mkdirSync(path.join(docsProbe, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(docsProbe, 'docs', 'IDEAS.md'), ['# Ideas', '', '- In docs', ''].join(LF));
        check('docs/IDEAS.md is preferred over creating a new root file',
            readIdeas(docsProbe).rel === 'docs/IDEAS.md', readIdeas(docsProbe).rel);
    }

    // 5z1d. The story deck is the one output written for the OWNER to read, so its chrome
    // follows the requested language while everything else in the product stays English.
    // The slide text itself is the AI's recorded sentence and is never machine-translated.
    {
        const { renderDeckHtml, renderDeckMarkdown, buildDeck } = await import('../lib/deck.mjs');
        const deck = buildDeck(projectDir);
        check('deck chrome is English by default', /the story so far/.test(renderDeckMarkdown(deck)));
        check('deck chrome follows the requested language', /buraya kadarki hikâye/.test(renderDeckMarkdown(deck, 'tr')));
        const trHtml = renderDeckHtml(deck, 'tr');
        check('deck page declares the language it rendered in', /<html lang="tr"/.test(trHtml));
        check('an unknown language falls back to English, never blanks',
            /<html lang="en"/.test(renderDeckHtml(deck, 'zz')) && /THE STORY SO FAR/.test(renderDeckHtml(deck, 'zz')));
        const served = await get('/deck?lang=tr').catch(() => null);
        check('GET /deck honours ?lang', typeof served === 'string' ? /lang="tr"/.test(served) : true);
    }

    // 5z1e. Readiness stages. A verdict on a project nobody has read is a guess wearing a
    // verdict's clothes — the intake step existed, but nothing said that review and
    // comparison DEPEND on it. Stages are derived from evidence on disk, never a stored flag.
    {
        const { projectReadiness, readinessBrief } = await import('../lib/readiness.mjs');
        const stageDir = path.join(tmpRoot, 'stages');
        fs.mkdirSync(path.join(stageDir, 'docs', 'handoff'), { recursive: true });
        const r0 = projectReadiness(stageDir);
        check('a project nobody has read is unmapped', r0.stage === 'unmapped', r0.stage);
        check('and says review is not grounded yet', r0.blocked.some(b => /review|critique/i.test(b)), JSON.stringify(r0.blocked));
        check('with the one honest next step', /PROJECT_MAP\.md/.test(r0.next.action), r0.next && r0.next.action);

        fs.mkdirSync(path.join(stageDir, 'docs', 'ai'), { recursive: true });
        fs.writeFileSync(path.join(stageDir, 'docs', 'ai', 'PROJECT_MAP.md'), '## What this is\n' + 'x'.repeat(300));
        check('a written map moves it to mapped', projectReadiness(stageDir).stage === 'mapped');
        // A placeholder file is not understanding — an empty map must not unlock anything.
        fs.writeFileSync(path.join(stageDir, 'docs', 'ai', 'PROJECT_MAP.md'), '# PROJECT_MAP\n');
        check('an empty map does not count as mapped', projectReadiness(stageDir).stage === 'unmapped');

        fs.writeFileSync(path.join(stageDir, 'docs', 'ai', 'PROJECT_MAP.md'), '## What this is\n' + 'x'.repeat(300));
        fs.writeFileSync(path.join(stageDir, 'docs', 'handoff', 'CONTINUITY.md'),
            '# C\n\n## Digest\n\n## Sessions\n\n### 2026-08-01 · claude · a\n- **Did:** x\n\n### 2026-08-02 · gemini · b\n- **Did:** y\n');
        const r3 = projectReadiness(stageDir);
        check('map + recorded history reaches informed', r3.stage === 'informed', r3.stage);
        check('an informed project blocks nothing', r3.blocked.length === 0 && r3.next === null);
        check('the brief goes silent once informed', readinessBrief(stageDir).length === 0);
        check('but speaks while the project is unread', readinessBrief(path.join(tmpRoot, 'nope')).length > 0);
        const act = await get('/api/activity');
        check('the owner sees the same stage the AIs get', act.readiness && typeof act.readiness.stage === 'string', JSON.stringify(act.readiness));
    }

    // 5z2. Version shown in the system bar must match package.json — it read "v1.0" long
    // after the package said 0.1.0-beta, which is exactly the kind of drift nobody notices.
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    const uiHtml = fs.readFileSync(path.join(__dirname, 'dashboard-ui.html'), 'utf8');
    // Two places print it — the system bar and the boot splash's kernel line. Counting both
    // is the point: the boot screen sat at "v1.0" long after the package said 0.1.0-beta,
    // and a check that only proves ONE of them is current would have passed anyway.
    const versionMentions = uiHtml.split(`>v${pkgVersion}<`).length - 1;
    check('system bar AND boot splash both show package.json version', versionMentions >= 2,
        `found ${versionMentions} mention(s) of v${pkgVersion}`);
    check('no stale hardcoded version left in the UI', !/>v1\.0</.test(uiHtml));
    // The subtitle's exact wording is a design choice the owner has already changed once
    // ("Local PC app" -> "AI Operating System"); pinning the string here just breaks the
    // suite the next time it is reworded. What must not regress is the positioning claim,
    // and that is asserted where it actually lives — the README and GUIDE checks below.
    check('boot splash carries a subtitle', /boot-sub">[^<]+</.test(uiHtml));
    {
        const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
        check('README says the dashboard binds to 127.0.0.1', /127\.0\.0\.1/.test(readme));
        check('README does not tell you to pick a setup tier', !/choose a setup tier/i.test(readme));
        check('README does not claim MCP has no protocol tests', !/no automated protocol-level test/i.test(readme));
        check('README says it is not a hosted website', /not a website/i.test(readme) && /localhost/i.test(readme));
        check('README presents the portable exe as the normal app', /PLUT_OS\.exe/.test(readme) && /build:app/.test(readme));
        const guide = fs.readFileSync(path.join(__dirname, 'docs', 'GUIDE.md'), 'utf8');
        check('GUIDE leads with portable PC app, terminal optional', /local PC app/i.test(guide) && /build:app/.test(guide) && /Terminal \(optional\)/.test(guide));
    }

    // The mark (favicon, boot splash) is one design in two places, and the sidebar draws the live
    // version of it: a mismatch would mean an update to one silently drifted from the others.
    {
        const favicon = decodeURIComponent(uiHtml.match(/rel="icon" href="([^"]+)"/)[1]);
        const boot = (uiHtml.match(/<svg class="boot-mark"[\s\S]*?<\/svg>/) || [''])[0];
        const geometry = m => m.includes('rotate(-24 50 50)') && m.includes('rotate(24 50 50)') && /<circle cx="50" cy="50" r="21"/.test(m);
        check('the favicon and the boot mark draw the same planet and two orbits', geometry(favicon) && geometry(boot), favicon.slice(0, 120));
        check('the sidebar mark is the live orbit', /<canvas class="brand-logo brand-orbit" data-orbit="mini"/.test(uiHtml));
        check('the Home hero is the live orbit', /data-orbit="hero"/.test(uiHtml));
    }

    // 5z2. The local protections, as pure functions (lib/auth.mjs): these carry the security
    // decisions the dispatcher makes, so they are tested as the dashboard calls them, not
    // through a re-implementation. The dashboard binds 127.0.0.1 only; these close what the
    // socket leaves open.
    {
        const authMod = await import('../lib/auth.mjs');
        check('loopback recognizes 127.0.0.1 and ::1', authMod.isLoopback('127.0.0.1') && authMod.isLoopback('::1'));
        check('loopback recognizes the IPv4-mapped IPv6 form', authMod.isLoopback('::ffff:127.0.0.1'),
            'Node reports dual-stack IPv4 clients this way — misclassifying it would refuse the one user the dashboard serves');
        check('a LAN address is not loopback', !authMod.isLoopback('192.168.1.42'));
        check('no address is not loopback', !authMod.isLoopback(null) && !authMod.isLoopback(''));

        check('the Host allowlist is localhost/127.0.0.1 and nothing else',
            JSON.stringify(authMod.allowedHosts(3040)) === JSON.stringify(['localhost:3040', '127.0.0.1:3040']), JSON.stringify(authMod.allowedHosts(3040)));
        const req = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });
        check('Host must name this server, case-insensitively, port included',
            authMod.isLocalRequest(req({ host: 'LocalHost:3040' }), 3040) && authMod.isLocalRequest(req({ host: '127.0.0.1:3040' }), 3040)
            && !authMod.isLocalRequest(req({ host: 'attacker.example' }), 3040) && !authMod.isLocalRequest(req({ host: '127.0.0.1:3041' }), 3040)
            && !authMod.isLocalRequest(req({}), 3040));
        check('Origin, when sent, must be this server too; curl sends none and stays allowed',
            authMod.isLocalRequest(req({ host: '127.0.0.1:3040', origin: 'http://127.0.0.1:3040' }), 3040)
            && !authMod.isLocalRequest(req({ host: '127.0.0.1:3040', origin: 'https://evil.example' }), 3040));
        check('the owner is a loopback socket with no forwarding header',
            authMod.isLocalOwner(req({ host: '127.0.0.1:3040' })) && authMod.isLocalOwner(req({ host: '127.0.0.1:3040' }, '::ffff:127.0.0.1'))
            && !authMod.isLocalOwner(req({ host: '127.0.0.1:3040' }, '192.168.1.42')));
        const forwarded = authMod.FORWARDING_HEADERS.map(h => [h, authMod.isLocalOwner(req({ host: '127.0.0.1:3040', [h]: '203.0.113.9' })),
            authMod.isLocalOwner(req({ host: '127.0.0.1:3040', [h]: '' }))]);
        check('every forwarding header makes a loopback request remote, even when empty',
            forwarded.length === 5 && forwarded.every(([, full, empty]) => !full && !empty), JSON.stringify(forwarded));
    }

    // 5.9 Approval tickets — the plutos_ask queue the owner answers from the dashboard.
    console.log('— approval gate —');
    {
        const asked = createApproval(projectDir, { agent: 'Antigravity', question: 'Drop the legacy table?', context: 'irreversible' });
        check('question lands as pending', asked.status === 'pending' && /^ask-[0-9a-z]+-[0-9a-z]{6}$/.test(asked.id), asked.id);

        const listed = await get('/api/approvals');
        check('dashboard lists the pending question',
            (listed.pending || []).some(q => q.id === asked.id && q.agent === 'Antigravity'), JSON.stringify(listed).slice(0, 200));

        const ok = await post('/api/approvals', { id: asked.id, decision: 'approved', note: 'go, but back it up' });
        check('owner approves through the dashboard', ok.success === true && ok.status === 'approved', ok.message);
        const answered = readApproval(projectDir, asked.id);
        check('answer reaches the agent with the note',
            answered.status === 'approved' && answered.note === 'go, but back it up', JSON.stringify(answered));
        check('answered question leaves the pending list',
            !(await get('/api/approvals')).pending.some(q => q.id === asked.id));

        // Two clicks on the same card — the second must lose, not overwrite the first answer.
        const again = await post('/api/approvals', { id: asked.id, decision: 'rejected' });
        check('a second answer is refused, not silently applied',
            again.success === false && /already approved/i.test(again.message || ''), again.message);
        check('first answer survived the second click', readApproval(projectDir, asked.id).status === 'approved');

        // Tiers over HTTP: a proxy or tunnel in front arrives on loopback too, so a forwarding
        // header makes the request remote, and the dispatcher refuses it before any tier rule runs
        // (the rule itself is exercised in approval-tiers-test). No new ticket carries an action
        // since 2026-11-04, so the T2 ticket is minted in the shape of before the cut (a
        // profile_full casting): those still exist in projects and must settle.
        const legacyTicket = (overrides = {}) => {
            const now = Date.now();
            const ticket = { id: `ask-${now.toString(36)}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`, agent: 'Codex',
                question: 'Full profile?', context: null, options: null,
                action: { kind: 'profile_full', projectRoot: projectDir, packageId: 'profile:full', version: 'a'.repeat(64), target: 'full', proposal: { kernel: 'Claude Code', casts: [] } },
                status: 'pending', note: null, option: null, tier: 'T2', createdAt: now, expiresAt: now + 30 * 60_000, answeredAt: null, answeredVia: null, ...overrides };
            ticket.askSeal = askSeal(ticket);
            fs.writeFileSync(path.join(approvalsDir(projectDir), `${ticket.id}.json`), JSON.stringify(ticket, null, 2));
            return ticket;
        };
        let actionRefused = '';
        try { createApproval(projectDir, { agent: 'Codex', question: 'Full profile?', action: { kind: 'profile_full' } }); } catch (e) { actionRefused = e.message; }
        check('a new ticket cannot carry an action', /Invalid approval action/.test(actionRefused), actionRefused);
        const install = legacyTicket();
        const listedRemote = await fetch(BASE + '/api/approvals', { headers: PROXIED_IP });
        const refusedRemote = await fetch(BASE + '/api/approvals', { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...PROXIED_IP }, body: JSON.stringify({ id: install.id, decision: 'approved' }) });
        check('a forwarded request neither lists nor answers a ticket (403), and the ticket stays pending',
            listedRemote.status === 403 && refusedRemote.status === 403 && readApproval(projectDir, install.id).status === 'pending',
            `${listedRemote.status} ${refusedRemote.status}`);
        const listedLocal = await get('/api/approvals');
        check('at the computer the T2 ticket is approvable and the answer is recorded as local',
            listedLocal.via === 'local' && listedLocal.pending.find(q => q.id === install.id)?.approvableHere === true, JSON.stringify(listedLocal).slice(0, 200));
        const settled = legacyTicket();
        const settledLocal = await post('/api/approvals', { id: settled.id, decision: 'approved' });
        check('a ticket from before the cut is approved at the computer without error and applies nothing',
            settledLocal.success === true && settledLocal.status === 'approved' && readApproval(projectDir, settled.id).status === 'approved'
            && !readApproval(projectDir, settled.id).actionResult, JSON.stringify(settledLocal));

        // An id is used to build a path. Anything but the shape we mint is refused.
        let traversed = null;
        try { answerApproval(projectDir, '../../../../evil', { decision: 'approved' }); }
        catch (e) { traversed = e.message; }
        check('traversal id refused before touching the filesystem', /Invalid ticket id/.test(traversed || ''), traversed);

        // Expiry decays on read — the agent must be told to stop rather than waiting forever.
        const shortLived = createApproval(projectDir, { agent: 'Cursor', question: 'expire me', ttlMinutes: 1 });
        // The clock moves, not the file: expiresAt is sealed, so editing it reads as tampering.
        const clockNow = Date.now;
        Date.now = () => clockNow() + 2 * 60_000;
        let lateAnswer = null;
        try {
            check('a lapsed question reads as expired', readApproval(projectDir, shortLived.id).status === 'expired');
            check('expired questions are not offered to the owner',
                !listApprovals(projectDir).some(q => q.id === shortLived.id));
            try { answerApproval(projectDir, shortLived.id, { decision: 'approved' }); }
            catch (e) { lateAnswer = e.message; }
        } finally { Date.now = clockNow; }
        check('answering an expired question is refused', /expired/i.test(lateAnswer || ''), lateAnswer);
        const backdated = createApproval(projectDir, { agent: 'Cursor', question: 'backdate me' });
        const backdatedFile = path.join(approvalsDir(projectDir), `${backdated.id}.json`);
        fs.writeFileSync(backdatedFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(backdatedFile, 'utf8')), expiresAt: Date.now() + 10 * 24 * 3600_000 }), 'utf8');
        check('a deadline edited on disk reads as tampered, not as more time', readApproval(projectDir, backdated.id).status === 'tampered');

        check('a question with no agent is refused', (() => {
            try { createApproval(projectDir, { question: 'who is asking?' }); return false; } catch (e) { return /agent is required/.test(e.message); }
        })());
    }

    // 5.95 MCP heartbeat is read from the hub dir, not the dashboard's own folder. Under
    // PLUTOS_HOME (as here, and in any relocated install) those are different directories, and
    // reading the wrong one reported every connected AI as offline.
    console.log('— mcp heartbeat path —');
    {
        const hubDir = path.join(tmpRoot, 'hub');
        fs.mkdirSync(hubDir, { recursive: true });
        const currentProject = (await get('/api/workspaces')).activeWorkspace;
        fs.writeFileSync(path.join(hubDir, 'mcp_status.json'), JSON.stringify({
            active: true, lastHeartbeat: Date.now(),
            clients: { [process.pid]: { client: 'Antigravity', pid: process.pid, project: currentProject, lastActive: Date.now(), lastAction: 'heartbeat' } }
        }), 'utf8');
        const statusFile = path.join(hubDir, 'mcp_status.json');
        const bytesBefore = fs.readFileSync(statusFile, 'utf8');
        const st = await get('/api/mcp/status');
        check('dashboard reads the heartbeat written under PLUTOS_HOME',
            !!(st.clients && st.clients[process.pid]), JSON.stringify(st).slice(0, 200));
        // A poll is a read: with every client live it must not take the lock and rewrite the file.
        check('polling the status with only live clients leaves the file untouched',
            fs.readFileSync(statusFile, 'utf8') === bytesBefore);

        // A client whose heartbeat stopped is removed and its disconnect logged by the poll,
        // because no MCP process may be left alive to record it.
        const stale = Date.now() - 60_000;
        fs.writeFileSync(statusFile, JSON.stringify({ active: true, lastHeartbeat: stale,
            clients: { 999999: { client: 'Gone AI', pid: 999999, project: currentProject, lastActive: stale } } }), 'utf8');
        await get('/api/mcp/status');
        const afterStale = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        check('a stale client is pruned from the file and its disconnect is logged',
            !afterStale.clients[999999] && afterStale.log.some(e => e.event === 'disconnect' && e.pid === 999999),
            JSON.stringify(afterStale).slice(0, 200));
    }

    // 5.96 Closing the open project. removeWorkspace was the only code path that ever cleared
    // activeWorkspace, so the only way back to the no-project screen — a state the dashboard
    // fully supports and lands on at every launch — was to delete the project from the hub,
    // which is a different intention and loses the entry. Close must clear what is open and
    // change nothing else.
    {
        const before = await get('/api/workspaces');
        check('a project is open before closing it', !!before.activeWorkspace, before.activeWorkspace);

        const closed = await post('/api/workspaces/close', {});
        check('closing clears the open project', closed.success === true && !closed.activeWorkspace,
            JSON.stringify(closed));

        const after = await get('/api/workspaces');
        check('closing does not unregister the project',
            (after.workspaces || []).includes(projectDir), JSON.stringify(after.workspaces));
        check('the closed project is still the one-click way back',
            after.lastWorkspace === projectDir, after.lastWorkspace);
        check('and nothing reads as open afterwards', !after.activeWorkspace, after.activeWorkspace);

        // Re-open it for the remove case below, which is about a project that IS open.
        await post('/api/workspaces/switch', { path: projectDir });
    }

    // 6. Remove workspace (hub registration only)
    const rem = await post('/api/workspaces/remove', { path: projectDir });
    check('workspace remove', rem.success === true && !(rem.workspaces || []).includes(projectDir), rem.message);
    check('project files untouched after remove', fs.existsSync(path.join(projectDir, 'AGENTS.md')));

    // 7. With no project selected, the dashboard must not fall back to its own install dir.
    // Removing one workspace only promotes the next one, so empty the hub first — "no project"
    // is a real state (fresh install, or the last project removed), not a hypothetical.
    console.log('— no project selected —');
    {
        for (const w of (await get('/api/workspaces')).workspaces || []) {
            await post('/api/workspaces/remove', { path: w });
        }
        const hub = await get('/api/workspaces');
        check('hub is empty and nothing is active',
            (hub.workspaces || []).length === 0 && !hub.activeWorkspace, JSON.stringify(hub).slice(0, 160));

        const board = await get('/api/board');
        check('board reports no project instead of PLUT_OS own board',
            board.needsProject === true && board.project === null && (board.entries || []).length === 0,
            JSON.stringify(board).slice(0, 200));

        const ideas = await get('/api/ideas');
        check('ideas reports no project', ideas.needsProject === true && (ideas.ideas || []).length === 0);

        const plutosBoard = path.join(__dirname, 'docs', 'handoff', 'BOARD.md');
        const before = fs.existsSync(plutosBoard) ? fs.readFileSync(plutosBoard, 'utf8') : null;
        const write = await post('/api/board', { agent: 'Stray', status: 'TODO', title: 'must never be written' });
        check('writing with no project is refused', write.success === false && write.needsProject === true, write.message);
        const after = fs.existsSync(plutosBoard) ? fs.readFileSync(plutosBoard, 'utf8') : null;
        check("PLUT_OS's own board was not written into", before === after);

        const idea = await post('/api/ideas', { text: 'must never be parked here' });
        check('parking an idea with no project is refused', idea.success === false && idea.needsProject === true);
    }
} catch (e) {
    failed++;
    console.error(`  ❌ smoke test aborted: ${e.message}${e.cause ? ` (cause: ${e.cause.code || ''} ${e.cause.message || e.cause})` : ''}`);
    console.error(`     dashboard ${server.exitCode === null ? 'still running' : `exited with ${server.exitCode}`}${serverErr ? `; last stderr:\n${serverErr}` : ''}`);
} finally {
    server.kill();
    // A child process (run with the test HOME) can still be writing
    // after the server is killed. Cleanup of a temp folder must not turn a
    // passed suite red: retry, then report what was left behind.
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
    catch (e) { console.log(`  (temp folder left behind: ${tmpRoot} — ${e.code || e.message})`); }
}

console.log(`\n${failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

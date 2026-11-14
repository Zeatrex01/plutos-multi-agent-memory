// The usage log (lib/usage-log.mjs, owner d-604591d0021d): one whitelisted line per tool call and
// hook run, local only, never content, never a changed result. Hermetic: everything runs in a temp
// folder with its own PLUTOS_HOME and HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-usage-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'user-home');
fs.mkdirSync(process.env.HOME, { recursive: true });
const { recordUsage, usageLine, USAGE_FILE, USAGE_ROTATED, USAGE_IGNORE, MAX_BYTES } = await import('../lib/usage-log.mjs');
const { readUsageEvents } = await import('../lib/usage-report.mjs');
// The report's reader is the one reader of the log: what the writer writes, it must read.
const readUsage = (root, { since = 0 } = {}) => readUsageEvents(root, { since: new Date(since).getTime() }).events;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function kitProject(dir, { git = false } = {}) {
    fs.mkdirSync(path.join(dir, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS.md — PLUT_OS Shared Communication Rules\n');
    fs.writeFileSync(path.join(dir, 'docs', 'handoff', 'BOARD.md'), '# BOARD\n');
    if (git) execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    return dir;
}
const lines = (root) => { try { return fs.readFileSync(path.join(root, USAGE_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const ALLOWED = new Set(['t', 'ai', 'kind', 'name', 'ok', 'ms', 'agent', 'readOnly']);
const onlyAllowed = (e) => Object.keys(e).every(k => ALLOWED.has(k));
// A child env with no parent client markers, so `ai` comes from what the test sets.
function childEnv(extra = {}) {
    const env = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_LOG_LEVEL', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR', 'CODEX_HOME', 'GEMINI_CLI',
        'PLUTOS_PROJECT_ROOT', 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER', 'PLUTOS_CODEX_PROJECT_CONFIG', 'VSCODE_PID', 'TERM_PROGRAM', 'CURSOR_TRACE_ID']) delete env[k];
    return { ...env, ...extra };
}

console.log('usage line: whitelisted fields only');
{
    const raw = JSON.parse(usageLine({ kind: 'tool', name: 'board_read', ok: true, ms: 12.6, ai: 'claude-code',
        args: { secret: 'x' }, output: 'text', path: '/tmp/x', agent: 'Explore' }, { env: {} }));
    check('only t, ai, kind, name, ok, ms on a tool line', onlyAllowed(raw) && !('agent' in raw) && Object.keys(raw).length === 6, JSON.stringify(raw));
    check('client name canonical, ms rounded, ok boolean', raw.ai === 'Claude Code' && raw.ms === 13 && raw.ok === true);
    check('t is ISO', !Number.isNaN(Date.parse(raw.t)) && raw.t.endsWith('Z'));
    const hook = JSON.parse(usageLine({ kind: 'hook', name: 'subagent', ok: 'yes', agent: 'Explore' }, { env: {} }));
    check('a hook line may carry agent; a non-boolean ok is false', hook.agent === 'Explore' && hook.ok === false && hook.ai === 'unknown');
    const ro = JSON.parse(usageLine({ kind: 'tool', name: 'session_start', readOnly: true }, { env: {} }));
    check('a read-only session_start carries readOnly, nothing else does', ro.readOnly === true
        && !('readOnly' in JSON.parse(usageLine({ kind: 'tool', name: 'board_read', readOnly: true }, { env: {} }))));
    check('unknown kind or empty name is not an event', usageLine({ kind: 'other', name: 'x' }) === null && usageLine({ kind: 'tool', name: ' ' }) === null && usageLine(null) === null);
}

console.log('recordUsage / readUsage');
{
    const outside = path.join(tmp, 'not-a-project');
    fs.mkdirSync(outside);
    check('nothing written outside a PLUT_OS project', recordUsage(outside, { kind: 'tool', name: 'x', ok: true, ms: 1 }) === false
        && !fs.existsSync(path.join(outside, '.plutos')));
    check('bad root never throws', recordUsage(undefined, { kind: 'tool', name: 'x' }) === false && recordUsage('', null) === false);

    const proj = kitProject(path.join(tmp, 'p1'), { git: true });
    check('written inside a project', recordUsage(proj, { kind: 'tool', name: 'board_read', ok: true, ms: 3, ai: 'Codex' }) === true);
    const ignore = fs.readFileSync(path.join(proj, USAGE_IGNORE), 'utf8');
    check('first write keeps both files out of git, next to them', ignore.includes('usage.jsonl') && ignore.includes('usage.1.jsonl')
        && !fs.existsSync(path.join(proj, '.gitignore')), ignore);
    const tracked = [USAGE_FILE, USAGE_ROTATED].map(f => spawnSync('git', ['-C', proj, 'check-ignore', '-q', f]).status);
    check('git ignores the log and its rotation', tracked.every(st => st === 0), String(tracked));

    // A project in a subfolder of a repository: .git only in the parent.
    const outer = path.join(tmp, 'outer');
    execFileSync('git', ['init', '-q', outer], { stdio: 'ignore' });
    const nested = kitProject(path.join(outer, 'app'));
    recordUsage(nested, { kind: 'tool', name: 'board_read', ok: true, ms: 1 });
    const status = execFileSync('git', ['-C', outer, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    check('a project nested in a repository keeps the log out of git', fs.existsSync(path.join(nested, USAGE_FILE))
        && !status.includes('usage.jsonl') && spawnSync('git', ['-C', outer, 'check-ignore', '-q', 'app/' + USAGE_FILE]).status === 0, status);
    const ignored = path.join(tmp, 'ignored');
    execFileSync('git', ['init', '-q', ignored], { stdio: 'ignore' });
    fs.writeFileSync(path.join(ignored, '.gitignore'), '.plutos/\n');
    kitProject(ignored);
    recordUsage(ignored, { kind: 'tool', name: 'board_read', ok: true, ms: 1 });
    check('a project that already ignores .plutos/ gets no ignore file', !fs.existsSync(path.join(ignored, USAGE_IGNORE)));
    recordUsage(proj, { kind: 'hook', name: 'brief', ok: false, ms: 9 });
    const all = readUsage(proj);
    check('readUsage returns both, oldest first', all.length === 2 && all[0].name === 'board_read' && all[1].name === 'brief');
    check('readUsage since filters', readUsage(proj, { since: Date.now() + 60_000 }).length === 0 && readUsage(proj, { since: 0 }).length === 2);
    fs.appendFileSync(path.join(proj, USAGE_FILE), 'not json\n{"t":"nope"}\n');
    check('unreadable lines are skipped', readUsage(proj).length === 2);

    for (let i = 0; i < 5; i++) recordUsage(proj, { kind: 'tool', name: `t${i}`, ok: true, ms: 1 }, { maxBytes: 200 });
    const size = fs.statSync(path.join(proj, USAGE_FILE)).size;
    check('rotates past the cap to usage.1.jsonl', fs.existsSync(path.join(proj, USAGE_ROTATED)) && size < 400, `size ${size}`);
    check('readUsage reads the rotated file too', readUsage(proj).some(e => e.name === 't4'));

    // Two servers on one project: the second saw the full file before the first rotated it.
    // Simulated by holding the rotation lock (another process mid-rotation) and by a second call
    // after a rotation; neither may rename the fresh file over the rotated history.
    const rp = kitProject(path.join(tmp, 'rot'));
    const big = 'x'.repeat(250) + '\n';
    fs.mkdirSync(path.join(rp, '.plutos'), { recursive: true });
    fs.writeFileSync(path.join(rp, USAGE_FILE), big);
    fs.mkdirSync(path.join(rp, '.plutos', 'usage.rotate.lock'));
    recordUsage(rp, { kind: 'tool', name: 'during', ok: true, ms: 1 }, { maxBytes: 200 });
    check('a rotation held by another process is not repeated', !fs.existsSync(path.join(rp, USAGE_ROTATED))
        && fs.readFileSync(path.join(rp, USAGE_FILE), 'utf8').includes('during'));
    fs.rmdirSync(path.join(rp, '.plutos', 'usage.rotate.lock'));
    recordUsage(rp, { kind: 'tool', name: 'first', ok: true, ms: 1 }, { maxBytes: 200 });
    const history = fs.readFileSync(path.join(rp, USAGE_ROTATED), 'utf8');
    recordUsage(rp, { kind: 'tool', name: 'second', ok: true, ms: 1 }, { maxBytes: 200 });
    check('the rotated history survives the next writer', fs.readFileSync(path.join(rp, USAGE_ROTATED), 'utf8') === history
        && history.includes('during') && !fs.existsSync(path.join(rp, '.plutos', 'usage.rotate.lock')));
    const stale = path.join(rp, '.plutos', 'usage.rotate.lock');
    fs.mkdirSync(stale);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(path.join(rp, USAGE_FILE), big);
    recordUsage(rp, { kind: 'tool', name: 'x', ok: true, ms: 1 }, { maxBytes: 200 });
    recordUsage(rp, { kind: 'tool', name: 'y', ok: true, ms: 1 }, { maxBytes: 200 });
    check('a stale rotation lock is cleared and the next write rotates', !fs.existsSync(stale)
        && fs.statSync(path.join(rp, USAGE_FILE)).size < 200);

    // A rotation that keeps failing (Windows EPERM/EBUSY; here the target is a non-empty folder).
    const ep = kitProject(path.join(tmp, 'eperm'));
    fs.mkdirSync(path.join(ep, USAGE_ROTATED), { recursive: true });
    fs.writeFileSync(path.join(ep, USAGE_ROTATED, 'keep'), 'x');
    fs.writeFileSync(path.join(ep, USAGE_FILE), big);
    const grew = recordUsage(ep, { kind: 'tool', name: 'a', ok: true, ms: 1 }, { maxBytes: 200 });
    fs.appendFileSync(path.join(ep, USAGE_FILE), big);
    const sizeBefore = fs.statSync(path.join(ep, USAGE_FILE)).size;
    const capped = recordUsage(ep, { kind: 'tool', name: 'b', ok: true, ms: 1 }, { maxBytes: 200 });
    check('a failing rotation appends up to twice the cap, then stops', grew === true && capped === false
        && fs.statSync(path.join(ep, USAGE_FILE)).size === sizeBefore, `${grew} ${capped}`);
    check('the default cap is 2 MB', MAX_BYTES === 2 * 1024 * 1024);

    const broken = kitProject(path.join(tmp, 'p2'));
    fs.writeFileSync(path.join(broken, '.plutos'), 'a file where the folder should be');
    let threw = false, r;
    try { r = recordUsage(broken, { kind: 'tool', name: 'x', ok: true, ms: 1 }); } catch { threw = true; }
    check('a failed write returns false and never throws', !threw && r === false);
    check('readUsage of a missing log is empty', readUsage(path.join(tmp, 'nowhere')).length === 0);
}

console.log('MCP server: every tool call recorded, results untouched');
function mcp(projectRoot, env = {}, clientName = 'codex-mcp-client') {
    const srv = spawn(process.execPath, [path.join(repo, 'index.mjs')], { env: childEnv({ PLUTOS_PROJECT_ROOT: projectRoot, ...env }), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', id = 1;
    const pending = new Map();
    srv.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
        }
    });
    const rpc = (method, params) => new Promise(resolve => {
        const n = id++;
        const t = setTimeout(() => { pending.delete(n); resolve({ __timeout: true }); }, 10000);
        pending.set(n, m => { clearTimeout(t); resolve(m); });
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
    const init = async () => {
        const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: '1' } });
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        return r;
    };
    return { rpc, init, call: (name, args) => rpc('tools/call', { name, arguments: args }), kill: () => srv.kill() };
}
{
    const proj = kitProject(path.join(tmp, 'p3'));
    const c = mcp(proj);
    try {
        await c.init();
        const info = await c.call('plutos_project_info', { secret: 'do-not-log' });
        const text = info.result?.content?.[0]?.text || '';
        check('tool answers as before', !info.error && text.includes('"projectRoot"'), JSON.stringify(info).slice(0, 160));
        const bad = await c.call('no_such_tool', {});
        check('unknown tool still errors', !!bad.error);
        const closed = await c.call('status_report', {});
        check('a closed-drawer tool still answers', !!closed.result);
        const log = lines(proj);
        const first = log.find(e => e.name === 'plutos_project_info');
        check('a tool call is one tool line with ok and ms', first && first.kind === 'tool' && first.ok === true && typeof first.ms === 'number', JSON.stringify(log));
        check('the client is named from the handshake', first?.ai === 'Codex', first?.ai);
        check('no arguments, outputs or paths in the log', log.every(onlyAllowed) && !fs.readFileSync(path.join(proj, USAGE_FILE), 'utf8').includes('do-not-log')
            && !fs.readFileSync(path.join(proj, USAGE_FILE), 'utf8').includes(proj));
        check('an unknown tool name is not recorded', !log.some(e => e.name === 'no_such_tool'));
        const drawerLine = log.find(e => e.name === 'status_report');
        check('drawer tools are recorded, an error as ok:false', drawerLine && drawerLine.ok === (closed.result?.isError ? false : true), JSON.stringify(drawerLine));

        await c.call('session_start', { readOnly: true });
        const roLine = lines(proj).find(e => e.name === 'session_start');
        check('a read-only session_start is marked readOnly', roLine?.readOnly === true, JSON.stringify(roLine));

        // A recording failure must not change the result: the log path is a folder now.
        fs.rmSync(path.join(proj, USAGE_FILE));
        fs.mkdirSync(path.join(proj, USAGE_FILE));
        const again = await c.call('plutos_project_info', {});
        check('a failed recording leaves the tool result unchanged', !again.error && (again.result?.content?.[0]?.text || '') === text);
    } finally { c.kill(); }
}

{
    // A client with no canonical name keeps its handshake name instead of merging into one row.
    const proj = kitProject(path.join(tmp, 'p6'));
    const c = mcp(proj, { VSCODE_PID: '1' }, 'goose');
    try {
        await c.init();
        await c.call('plutos_project_info', {});
        const e = lines(proj).find(x => x.name === 'plutos_project_info');
        check('an unknown client is named from its handshake, not the environment', e?.ai === 'goose', e?.ai);
    } finally { c.kill(); }
}

console.log('hooks: brief, subagent, session-close');
{
    const proj = kitProject(path.join(tmp, 'p4'));
    const brief = spawnSync(process.execPath, [path.join(repo, 'index.mjs'), '--brief'],
        { env: childEnv({ PLUTOS_PROJECT_ROOT: proj, CLAUDECODE: '1' }), encoding: 'utf8', timeout: 30000 });
    check('brief still prints', brief.status === 0 && brief.stdout.length > 0, brief.stderr.slice(0, 200));
    const b = lines(proj).find(e => e.name === 'brief');
    check('brief run is one hook line', b && b.kind === 'hook' && b.ok === true && b.ai === 'Claude Code', JSON.stringify(lines(proj)));

    for (const source of ['clear', 'compact', 'startup']) {
        spawnSync(process.execPath, [path.join(repo, 'index.mjs'), '--brief'],
            { env: childEnv({ PLUTOS_PROJECT_ROOT: proj, CLAUDECODE: '1' }), input: JSON.stringify({ source, session_id: 'secret-session' }), encoding: 'utf8', timeout: 30000 });
    }
    const briefs = lines(proj).filter(e => e.kind === 'hook' && /^brief/.test(e.name)).map(e => e.name);
    check('the brief records its source: startup is "brief", clear and compact are named', JSON.stringify(briefs)
        === JSON.stringify(['brief', 'brief:clear', 'brief:compact', 'brief']), JSON.stringify(briefs));
    check('the hook event itself is not logged', !fs.readFileSync(path.join(proj, USAGE_FILE), 'utf8').includes('secret-session'));

    const sub = spawnSync(process.execPath, [path.join(repo, 'lib', 'subagent-hook.mjs')],
        { env: childEnv({ CLAUDE_PROJECT_DIR: proj, CLAUDECODE: '1' }), input: JSON.stringify({ agent_type: 'Explore', prompt: 'secret prompt', cwd: proj }), encoding: 'utf8', timeout: 10000 });
    let parsed = null;
    try { parsed = JSON.parse(sub.stdout); } catch {}
    check('subagent hook output unchanged', parsed?.hookSpecificOutput?.hookEventName === 'SubagentStart', sub.stdout.slice(0, 120));
    const s = lines(proj).find(e => e.name === 'subagent');
    check('subagent start is one hook line with its type', s && s.kind === 'hook' && s.agent === 'Explore' && s.ok === true, JSON.stringify(s));
    check('the sub-agent prompt is not logged', !fs.readFileSync(path.join(proj, USAGE_FILE), 'utf8').includes('secret prompt'));

    // The map is written before the usage line: a project whose log cannot be written still gets it.
    const noLog = kitProject(path.join(tmp, 'p5'));
    fs.writeFileSync(path.join(noLog, '.plutos'), 'a file where the folder should be');
    const sub2 = spawnSync(process.execPath, [path.join(repo, 'lib', 'subagent-hook.mjs')],
        { env: childEnv({ CLAUDE_PROJECT_DIR: noLog }), input: '{}', encoding: 'utf8', timeout: 10000 });
    check('subagent map is written even when recording fails', sub2.status === 0 && sub2.stdout.includes('SubagentStart'), sub2.stdout.slice(0, 80));
    // A slow first write (a cold machine's git) must not hold the map past the hook's 800 ms kill:
    // here git takes 1.5 s, and the answer still comes out.
    if (process.platform !== 'win32') {
        const slow = kitProject(path.join(tmp, 'p-slow'));
        const bin = path.join(tmp, 'slow-bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 1.5\nexit 1\n', { mode: 0o755 });
        const sub3 = spawnSync(process.execPath, [path.join(repo, 'lib', 'subagent-hook.mjs')],
            { env: childEnv({ CLAUDE_PROJECT_DIR: slow, PATH: `${bin}${path.delimiter}${process.env.PATH}` }), input: '{}', encoding: 'utf8', timeout: 10000 });
        check('subagent map is written before a slow usage write', sub3.stdout.includes('SubagentStart'), sub3.stdout.slice(0, 80));
    }

    const close = spawnSync(process.execPath, [path.join(repo, 'lib', 'session-close.mjs')],
        { env: childEnv({ CLAUDE_PROJECT_DIR: proj }), input: '{}', encoding: 'utf8', timeout: 10000 });
    check('session close exits 0', close.status === 0, close.stderr);
    const sc = lines(proj).find(e => e.name === 'session-close');
    check('session close is one hook line', sc && sc.kind === 'hook' && sc.ok === true, JSON.stringify(sc));

    const outside = path.join(tmp, 'plain');
    fs.mkdirSync(outside);
    spawnSync(process.execPath, [path.join(repo, 'lib', 'subagent-hook.mjs')], { env: childEnv({ CLAUDE_PROJECT_DIR: outside }), input: '{}', timeout: 10000 });
    spawnSync(process.execPath, [path.join(repo, 'lib', 'session-close.mjs')], { env: childEnv({ CLAUDE_PROJECT_DIR: outside }), input: '{}', timeout: 10000 });
    check('hooks write nothing outside a project', !fs.existsSync(path.join(outside, '.plutos')));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

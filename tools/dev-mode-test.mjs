// Development mode: PLUT_OS working on itself, apart from the PLUT_OS the owner uses. Its own
// data folder and port, a project list of PLUT_OS itself and its sandbox only, no route or CLI
// into a real project, and an AI working on PLUT_OS told so in its brief.
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isDevMode, devProjectAllowed, devSandboxDir, isPlutosSource, selfBriefLine, DEV_PORT } from '../lib/run-mode.mjs';
import { defaultPlutosHome, devHomeConflict } from '../lib/home-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-dev-mode-'));
const cleanEnv = () => {
    const env = { ...process.env, HOME: path.join(temp, 'user-home'), USERPROFILE: path.join(temp, 'user-home'), XDG_DATA_HOME: path.join(temp, 'xdg'), LOCALAPPDATA: path.join(temp, 'localappdata')};
    for (const k of ['PLUTOS_MODE', 'PLUTOS_HOME', 'PLUTOS_PORT', 'PLUTOS_PROJECT_ROOT', 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER', 'PLUTOS_PACKAGED', 'CLAUDE_PROJECT_DIR', 'CODEX_HOME']) delete env[k];
    return env;
};
const gitStatus = () => { try { return execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }); } catch (e) { return 'no git'; } };
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const portFree = port => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

try {
    // --- the switch and the data folder ---------------------------------------------------
    check('development mode is PLUTOS_MODE=dev or --dev, nothing else',
        isDevMode({ PLUTOS_MODE: 'dev' }, []) && isDevMode({}, ['node', 'dashboard.mjs', '--dev']) && !isDevMode({}, ['node', 'dashboard.mjs']) && !isDevMode({ PLUTOS_MODE: 'prod' }, []));
    const cases = [
        ['win32', { LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local' }, '/home/o', 'PLUT_OS'],
        ['darwin', {}, '/Users/o', 'PLUT_OS'],
        ['linux', {}, '/home/o', 'plut-os']
    ];
    check('the development data folder is a -dev sibling on every platform, the normal one unchanged', cases.every(([platform, env, homeDir, name]) => {
        const prod = defaultPlutosHome({ env, platform, homeDir, dev: false });
        const dev = defaultPlutosHome({ env, platform, homeDir, dev: true });
        return path.basename(prod) === name && path.basename(dev) === `${name}-dev` && path.dirname(prod) === path.dirname(dev);
    }));
    const env = { HOME: '/home/o', XDG_DATA_HOME: '/home/o/.local/share' };
    const prodHome = defaultPlutosHome({ env: { ...env }, dev: false });
    check('development mode refuses the normal data folder',
        /refuses the normal PLUT_OS data folder/.test(devHomeConflict(prodHome, { ...env, PLUTOS_MODE: 'dev' }))
        && devHomeConflict(path.join(temp, 'other'), { ...env, PLUTOS_MODE: 'dev' }) === ''
        && devHomeConflict(prodHome, env) === '');

    const refused = spawnSync(process.execPath, ['-e', "import('./lib/approot.mjs').then(() => console.log('LOADED'))"], {
        cwd: root, encoding: 'utf8', env: { ...cleanEnv(), PLUTOS_MODE: 'dev', PLUTOS_HOME: defaultPlutosHome({ env: cleanEnv(), dev: false }) }
    });
    check('a development process pointed at the normal data folder stops before loading anything',
        refused.status !== 0 && !refused.stdout.includes('LOADED') && /refuses the normal PLUT_OS data folder/.test(refused.stderr), refused.stderr.slice(-300));

    // --- which projects development mode may touch ----------------------------------------
    const devHome = path.join(temp, 'dev-hub');
    const sandbox = devSandboxDir(devHome);
    fs.mkdirSync(path.join(sandbox, 'sample'), { recursive: true });
    fs.mkdirSync(path.join(devHome, 'sandbox-evil'), { recursive: true });
    const realProject = path.join(temp, 'real-project');
    fs.mkdirSync(realProject, { recursive: true });
    const allowed = p => devProjectAllowed(p, { home: devHome, appRoot: root });
    check('PLUT_OS itself and a sandbox folder are allowed', allowed(root) && allowed(path.join(sandbox, 'sample')));
    check('a real project, the sandbox root and a look-alike sibling folder are not',
        !allowed(realProject) && !allowed(sandbox) && !allowed(path.join(devHome, 'sandbox-evil')));
    let linked = false;
    try { fs.symlinkSync(realProject, path.join(sandbox, 'link-out'), 'junction'); linked = true; } catch (e) { /* no symlink rights */ }
    check('a link inside the sandbox that points at a real project is not allowed', !linked || !allowed(path.join(sandbox, 'link-out')));

    // --- knowing that the project is PLUT_OS itself ---------------------------------------
    const lookalike = path.join(temp, 'plutos-checkout');
    fs.mkdirSync(path.join(lookalike, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(lookalike, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(lookalike, 'package.json'), JSON.stringify({ name: 'plut-os' }));
    fs.writeFileSync(path.join(lookalike, 'index.mjs'), '');
    fs.writeFileSync(path.join(lookalike, 'lib', 'drawers.mjs'), '');
    fs.writeFileSync(path.join(lookalike, 'AGENTS.md'), '# AGENTS.md — PLUT_OS Shared Communication Rules\n<!-- plutos:kit -->\n');
    fs.writeFileSync(path.join(lookalike, 'docs', 'handoff', 'BOARD.md'), '# BOARD\n');
    check('PLUT_OS source is recognised by content, wherever it lives', isPlutosSource(root) && isPlutosSource(lookalike) && !isPlutosSource(realProject));
    check('the brief line is empty for an ordinary project', selfBriefLine(realProject) === '');
    const bare = selfBriefLine(lookalike);
    check('without MVP.md (the main repository) the brief line names no scope filter it cannot point at',
        /PLUT_OS ITSELF/.test(bare) && /npm test/.test(bare) && /DEV_PLUT_OS\.bat/.test(bare) && !/MVP\.md/.test(bare), bare);
    fs.writeFileSync(path.join(lookalike, 'MVP.md'), '# MVP\n');
    const line = selfBriefLine(lookalike);
    check('with MVP.md the brief line names PLUT_OS, the test rule, the development launcher and the scope filter',
        /PLUT_OS ITSELF/.test(line) && /npm test/.test(line) && /DEV_PLUT_OS\.bat/.test(line) && /five-goal filter/.test(line) && /MVP\.md lines 3-19/.test(line), line);

    // --- the dashboard in development mode -------------------------------------------------
    // A registry carried over from somewhere else must not bring a real project with it.
    fs.mkdirSync(devHome, { recursive: true });
    fs.writeFileSync(path.join(devHome, 'hub_config.json'), JSON.stringify({ workspaces: [realProject], activeWorkspace: realProject }));
    const before = gitStatus();
    const port = await freePort();
    const dash = spawn(process.execPath, [path.join(root, 'dashboard.mjs')], {
        cwd: temp, env: { ...cleanEnv(), PLUTOS_MODE: 'dev', PLUTOS_HOME: devHome, PLUTOS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    dash.stdout.on('data', d => { out += d; });
    dash.stderr.on('data', d => { out += d; });
    try {
        for (let i = 0; i < 150 && !/Interface: http/.test(out); i++) await new Promise(r => setTimeout(r, 100));
        const base = `http://127.0.0.1:${port}`;
        check('the dashboard says it runs in development mode, with its data folder', /DEVELOPMENT MODE/.test(out) && out.includes(devHome), out.slice(-400));
        const mode = await (await fetch(`${base}/api/app/mode`)).json();
        check('/api/app/mode reports development mode and the sandbox', mode.devMode === true && path.resolve(mode.sandbox) === path.resolve(sandbox) && path.resolve(mode.dataHome) === path.resolve(devHome));
        const ws = await (await fetch(`${base}/api/workspaces`)).json();
        check('development mode opens on PLUT_OS itself and lists nothing else',
            ws.workspaces.length === 1 && path.resolve(ws.workspaces[0]) === root && path.resolve(ws.activeWorkspace) === root, JSON.stringify(ws.workspaces));
        const add = async p => (await fetch(`${base}/api/workspaces/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })).json();
        const outside = await add(realProject);
        check('adding a real project is refused and says why', outside.success === false && /does not touch real projects/.test(outside.message || outside.error || ''), JSON.stringify(outside));
        check('the refused project is left untouched', fs.readdirSync(realProject).length === 0);
        const inSandbox = await add(path.join(sandbox, 'sample'));
        check('a sandbox project can be added', inSandbox.success === true, JSON.stringify(inSandbox).slice(0, 200));
    } finally {
        dash.kill();
        await new Promise(r => dash.once('exit', r));
    }
    check('running the development dashboard on PLUT_OS wrote nothing into the checkout', gitStatus() === before, gitStatus());

    if (await portFree(DEV_PORT)) {
        const quick = spawn(process.execPath, [path.join(root, 'dashboard.mjs')], { cwd: temp, env: { ...cleanEnv(), PLUTOS_MODE: 'dev', PLUTOS_HOME: path.join(temp, 'dev-hub-2') }, stdio: ['ignore', 'pipe', 'pipe'] });
        let qout = '';
        quick.stdout.on('data', d => { qout += d; });
        for (let i = 0; i < 150 && !/Interface: http/.test(qout); i++) await new Promise(r => setTimeout(r, 100));
        quick.kill();
        await new Promise(r => quick.once('exit', r));
        check(`development mode defaults to port ${DEV_PORT}`, qout.includes(`Interface: http://localhost:${DEV_PORT}`), qout.slice(-300));
    } else {
        console.log(`  skip default port check: ${DEV_PORT} is busy on this machine`);
    }

    const packaged = spawnSync(process.execPath, [path.join(root, 'dashboard.mjs')], { cwd: temp, encoding: 'utf8', timeout: 15000,
        env: { ...cleanEnv(), PLUTOS_MODE: 'dev', PLUTOS_HOME: path.join(temp, 'dev-hub-3'), PLUTOS_PACKAGED: '1', PLUTOS_PORT: String(await freePort()) } });
    check('a built copy refuses development mode', packaged.status === 1 && /runs the PLUT_OS source being edited/.test(packaged.stderr), (packaged.stderr || '').slice(-300));

    // --- the CLI in development mode ---------------------------------------------------------
    const cli = spawnSync(process.execPath, [path.join(root, 'cli.mjs'), realProject], { cwd: temp, encoding: 'utf8', env: { ...cleanEnv(), PLUTOS_MODE: 'dev', PLUTOS_HOME: path.join(temp, 'dev-hub-4') } });
    check('the CLI refuses to install into a real project in development mode', cli.status === 1 && /does not touch real projects/.test(cli.stderr) && fs.readdirSync(realProject).length === 0, cli.stderr.slice(-300));

    // --- the brief over the MCP protocol ----------------------------------------------------------
    const brief = async (project) => {
        const srv = spawn(process.execPath, [path.join(root, 'index.mjs')], { cwd: project, env: { ...cleanEnv(), PLUTOS_HOME: path.join(temp, 'mcp-hub'), PLUTOS_PROJECT_ROOT: project }, stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        const replies = new Map();
        srv.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.id) replies.set(m.id, m); } catch (e) { /* not JSON-RPC */ } } });
        const rpc = async (id, method, params) => { srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let i = 0; i < 150 && !replies.has(id); i++) await new Promise(r => setTimeout(r, 100)); return replies.get(id); };
        await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dev-mode-test', version: '1' } });
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const r = await rpc(2, 'tools/call', { name: 'session_start', arguments: { ai: 'DevModeTest' } });
        srv.kill();
        return (r?.result?.content || []).map(c => c.text).join('');
    };
    const ordinary = path.join(temp, 'ordinary');
    fs.mkdirSync(path.join(ordinary, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(ordinary, 'AGENTS.md'), '# AGENTS.md — PLUT_OS Shared Communication Rules\n<!-- plutos:kit -->\n');
    fs.writeFileSync(path.join(ordinary, 'docs', 'handoff', 'BOARD.md'), '# BOARD\n');
    const selfBrief = await brief(lookalike);
    const otherBrief = await brief(ordinary);
    check('an AI working on PLUT_OS is told so in session_start', /PLUT_OS ITSELF/.test(selfBrief), selfBrief.slice(-300));
    check('an AI on any other project is not', otherBrief.length > 0 && !/PLUT_OS ITSELF/.test(otherBrief));
} finally {
    // A server killed a moment ago can still be writing (Linux: ENOTEMPTY) or holding a folder
    // open (Windows: EBUSY). Give it time to exit; a temp folder left behind is not a failure.
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.log(`  (temp folder left behind: ${e.code || e.message})`); }
}
console.log(`Development mode: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

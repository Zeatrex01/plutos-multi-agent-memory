// Isolated generated-hook checks. No real Hub or AI client configuration is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-watcher-test-'));
// watcher imports roadmap/workspaces, which initialize Hub state at module load.
process.env.PLUTOS_HOME = path.join(temp, 'hub');
// The git checks below must not read the real user's configuration.
process.env.HOME = process.env.USERPROFILE = path.join(temp, 'user');
process.env.APPDATA = path.join(temp, 'user', 'AppData');
const watcher = await import('../lib/watcher.mjs');
let passed = 0;
function check(name, test) {
    assert.ok(test, name);
    passed++;
    console.log(`PASS ${name}`);
}

const projectA = path.join(temp, "project A & owner's $cash");
const projectB = path.join(temp, 'project B');
fs.mkdirSync(path.join(projectA, '.claude'), { recursive: true });
fs.mkdirSync(projectB);
fs.writeFileSync(path.join(projectA, 'package.json'), '{"type":"module"}\n');
const rootA = fs.realpathSync(projectA);
const rootB = fs.realpathSync(projectB);
const task = { agent: 'owner', status: 'TODO', title: 'Only project A work', fields: { Assignee: 'Claude' } };
let response = { projectRoot: rootA, entries: [task] };
let status = 200;
const requests = [];
const server = http.createServer((req, res) => {
    requests.push(new URL(req.url, 'http://localhost'));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const settingsFile = watcher.claudeSettingsPath(projectA);
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const ownHandler = () => readSettings().hooks.Stop.flatMap(group => group.hooks)
    .find(handler => handler.command === 'node');

function run(payload = { cwd: rootA }, extraEnv = {}) {
    const handler = ownHandler();
    return new Promise((resolve, reject) => {
        const child = spawn(handler.command, handler.args, {
            cwd: projectA,
            env: { ...process.env, PLUTOS_AGENT: 'Claude', PLUTOS_BOARD_URL: '', ...extraEnv },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', data => { stderr += data; });
        child.stdout.resume();
        child.on('error', reject);
        child.on('close', code => resolve({ code, stderr }));
        child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
}

try {
    check('fresh project has no watcher', !watcher.watcherStatus(projectA).installed);
    const legacy = path.join(projectA, '.plutos', 'plutos-watcher.sh');
    fs.mkdirSync(path.dirname(legacy));
    fs.writeFileSync(legacy, '#!/usr/bin/env node\n// old unbound watcher\n');
    const foreign = { type: 'command', command: 'foreign-plutos-watcher-helper.sh', timeout: 7 };
    const foreignGroup = { matcher: 'keep', hooks: [foreign], custom: 'preserved' };
    const emptyGroup = { matcher: 'empty', hooks: [] };
    fs.writeFileSync(settingsFile, JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: {
            Stop: [{ ...foreignGroup, hooks: [foreign, { type: 'command', command: legacy }] }, emptyGroup],
            SessionEnd: [{ hooks: [{ type: 'command', command: 'other-event.sh' }] }]
        }
    }));
    const old = watcher.watcherStatus(projectA);
    check('unbound legacy watcher requires upgrade', old.needsUpgrade && !old.installed);
    const enabled = watcher.setWatcher(projectA, true, { agent: 'Claude', port });
    check('re-enable upgrades to a healthy Node hook', enabled.installed && !enabled.needsUpgrade);
    check('legacy script is removed during upgrade', !fs.existsSync(legacy));
    check('generated script has an explicit CommonJS extension', watcher.watcherScriptPath(projectA).endsWith('.cjs'));
    assert.deepEqual(ownHandler(), { type: 'command', command: 'node', args: [watcher.watcherScriptPath(rootA)] });
    check('installed handler passes the script as one Node argument', true);
    assert.deepEqual(readSettings().hooks.Stop[0], foreignGroup);
    assert.deepEqual(readSettings().hooks.Stop[1], emptyGroup);
    check('upgrade preserves foreign handlers and group metadata', true);
    const foreignSettings = readSettings();
    check('upgrade preserves unrelated settings and events', foreignSettings.permissions.allow[0] === 'Read'
        && foreignSettings.hooks.SessionEnd[0].hooks[0].command === 'other-event.sh');
    const repeated = watcher.setWatcher(projectA, true, { agent: 'Claude', port });
    check('repeated install does not duplicate or report changes', readSettings().hooks.Stop.length === 3 && !repeated.changed);
    const retargeted = watcher.setWatcher(projectA, true, { agent: 'Alternate', port });
    check('agent-only script update reports its change', retargeted.changed
        && fs.readFileSync(watcher.watcherScriptPath(projectA), 'utf8').includes('"agent": "Alternate"'));
    watcher.setWatcher(projectA, true, { agent: 'Claude', port });

    let result = await run();
    check('actual installed command runs from a module project with spaces and metacharacters', result.code === 2);
    check('same-project TODO is delivered', result.stderr.includes(task.title));
    check('request names the installed canonical source project', requests.at(-1).pathname === '/api/board'
        && requests.at(-1).searchParams.get('project') === rootA);
    const alias = path.join(temp, 'project A alias');
    fs.symlinkSync(rootA, alias, process.platform === 'win32' ? 'junction' : 'dir');
    response = { projectRoot: alias, entries: [task] };
    check('canonical aliases identify the same project and hook cwd', (await run({ cwd: alias })).code === 2);
    check('status through an alias recognizes the canonical installation', watcher.watcherStatus(alias).installed);
    watcher.setWatcher(alias, true, { agent: 'Claude', port });
    check('installing through an alias still records the canonical source', ownHandler().args[0] === watcher.watcherScriptPath(rootA));
    response = { projectRoot: rootA, entries: [task] };
    result = await run({ cwd: rootA }, { PLUTOS_BOARD_URL: `http://127.0.0.1:${port}/api/board?project=${encodeURIComponent(rootB)}` });
    check('URL override cannot change the installed project query', result.code === 2
        && requests.at(-1).searchParams.get('project') === rootA);

    response = { projectRoot: rootB, entries: [{ ...task, title: 'Foreign project B task' }] };
    result = await run();
    check('foreign board identity is refused without leaking its task', result.code === 0 && result.stderr === '');
    response = { entries: [task] };
    check('legacy response without project identity fails closed', (await run()).code === 0);
    response = { projectRoot: '.', entries: [task] };
    check('relative response identity fails closed', (await run()).code === 0);
    response = { projectRoot: path.join(temp, 'missing'), entries: [task] };
    check('missing response root fails closed', (await run()).code === 0);
    response = { projectRoot: rootA, entries: [task] };
    status = 404;
    check('unregistered project HTTP failure cannot deliver work', (await run()).code === 0);
    status = 200;

    let count = requests.length;
    check('foreign hook cwd fails closed', (await run({ cwd: rootB })).code === 0);
    check('foreign hook cwd is rejected before contacting the dashboard', requests.length === count);
    check('relative hook cwd is refused', (await run({ cwd: '.' })).code === 0);
    check('recursive Stop hook exits before contacting the dashboard', (await run({ cwd: rootA, stop_hook_active: true })).code === 0
        && requests.length === count);
    check('malformed input fails closed', (await run('invalid json')).code === 0 && requests.length === count);
    check('non-object payload fails closed', (await run('[]')).code === 0 && requests.length === count);
    check('missing cwd still requires a verified response identity', (await run({})).code === 2);
    response = { projectRoot: rootA, entries: {} };
    check('malformed entries cannot crash the generated hook', (await run()).code === 0);
    response = { projectRoot: rootA, entries: [{ ...task, status: 'DONE' }] };
    check('completed task does not block stopping', (await run()).code === 0);
    response = { projectRoot: rootA, entries: [{ ...task, fields: { Assignee: 'Gemini' } }] };
    check('another seat cannot keep this watcher running', (await run()).code === 0);
    response = { projectRoot: rootA, entries: [task] };
    check('unreachable dashboard cannot keep a session running', (await run({ cwd: rootA }, {
        PLUTOS_BOARD_URL: 'http://127.0.0.1:9/api/board'
    })).code === 0);

    const script = watcher.watcherScriptPath(projectA);
    const before = fs.readFileSync(script, 'utf8');
    const validSettings = fs.readFileSync(settingsFile, 'utf8');
    const needsUpgrade = () => {
        const state = watcher.watcherStatus(projectA);
        return !state.installed && state.needsUpgrade;
    };
    fs.writeFileSync(script, "fetch('http://127.0.0.1:3040/api/board');\n");
    check('existing unbound cjs body requires upgrade', needsUpgrade());
    fs.writeFileSync(script, before.replace('if (watcherProjectKey(board?.projectRoot) !== PROJECT_KEY) process.exit(0);', ''));
    check('modified behavior cannot pass by retaining generated defaults', needsUpgrade());
    fs.writeFileSync(script, watcher.watcherScript('Claude', port, rootB));
    check('otherwise current script bound to another root requires upgrade', needsUpgrade());
    const inspectionMarker = path.join(temp, 'status-must-not-execute');
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(inspectionMarker)}, 'unsafe');\n`);
    check('status never executes an installed script', needsUpgrade() && !fs.existsSync(inspectionMarker));
    fs.writeFileSync(script, 'x'.repeat(64 * 1024 + 1));
    check('oversized generated script is rejected by bounded inspection', needsUpgrade());
    fs.writeFileSync(script, before);
    check('complete current generated script is healthy after restoration', watcher.watcherStatus(projectA).installed);
    for (const extra of [ownHandler(), { type: 'command', command: legacy }]) {
        const duplicateSettings = JSON.parse(validSettings);
        duplicateSettings.hooks.Stop.push({ matcher: '', hooks: [extra] });
        fs.writeFileSync(settingsFile, JSON.stringify(duplicateSettings));
        check(extra.command === 'node' ? 'duplicate current hooks require upgrade' : 'coexisting legacy hook requires upgrade', needsUpgrade());
    }
    const repaired = watcher.setWatcher(projectA, true, { agent: 'Claude', port });
    check('re-enable repairs stale duplicates without losing foreign handlers', repaired.installed && !repaired.needsUpgrade
        && readSettings().hooks.Stop.length === 3 && readSettings().hooks.Stop[0].hooks[0].command === foreign.command);
    for (const invalid of ['{not json', '{"hooks":{"Stop":{}}}']) {
        fs.writeFileSync(settingsFile, invalid);
        assert.throws(() => watcher.setWatcher(projectA, true, { agent: 'Changed', port }));
        assert.equal(fs.readFileSync(settingsFile, 'utf8'), invalid);
        assert.equal(fs.readFileSync(script, 'utf8'), before);
    }
    check('invalid settings leave both settings and generated script untouched', true);
    fs.writeFileSync(settingsFile, validSettings);
    const disabled = watcher.setWatcher(projectA, false);
    assert.deepEqual(readSettings().hooks.Stop, [foreignGroup, emptyGroup]);
    check('disable removes only the watcher and keeps mixed foreign hooks', !disabled.installed && !fs.existsSync(script));

    // Both files name this machine's paths. In a git project each is ignored by its exact path,
    // and a copy git already tracks is reported but stays tracked: untracking is the owner's call.
    const projectC = path.join(temp, 'project C');
    fs.mkdirSync(projectC);
    const git = (...args) => execFileSync('git', args, { cwd: projectC, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    const ignoreLines = () => fs.readFileSync(path.join(projectC, '.gitignore'), 'utf8').split(/\r?\n/);
    const first = watcher.setWatcher(projectC, true, { agent: 'Claude', port });
    check('a git project ignores the hook and the script by their exact paths', first.ignored && first.warning === null
        && watcher.WATCHER_FILES.every(entry => ignoreLines().filter(line => line === entry).length === 1));
    const again = watcher.setWatcher(projectC, true, { agent: 'Claude', port });
    check('a repeat install adds no second ignore line and reports no change', !again.ignored && !again.changed
        && ignoreLines().filter(line => line === '.plutos/plutos-watcher.cjs').length === 1);
    git('add', '-f', '.plutos/plutos-watcher.cjs');
    const tracked = watcher.setWatcher(projectC, true, { agent: 'Claude', port });
    check('a script git already tracks is reported and left tracked', !tracked.changed
        && /git rm --cached \.plutos\/plutos-watcher\.cjs/.test(tracked.warning || '')
        && git('ls-files', '.plutos/plutos-watcher.cjs').trim() === '.plutos/plutos-watcher.cjs');
    console.log(`\n${passed} passed, 0 failed`);
} finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
}

// Windows launcher regression: current source beats stale dist; fallback and failures remain visible.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-launcher-'));
process.env.PLUTOS_HOME = path.join(temp, 'hub');
delete process.env.PLUTOS_PROJECT_ROOT;
delete process.env.PLUTOS_PROJECT_BOUND_BY_LAUNCHER;
const originalExec = cp.execFileSync;
const originalSpawn = cp.spawn;
const calls = [];
let launcher;

function launch(folder, args = '', env = {}) {
    const child = cp.spawn(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `""${path.join(folder, 'START_PLUT_OS.bat')}" ${args}"`], {
            cwd: temp, env: { ...process.env, ...env }, windowsHide: true,
            windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe']
        });
    child.output = '';
    child.stdout.on('data', chunk => { child.output += chunk; });
    child.stderr.on('data', chunk => { child.output += chunk; });
    child.finished = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve(code));
    });
    return child;
}

// 30 s, not 10: a cold Windows runner has been seen to take longer than 10 s to show the
// first BAT output, failing a docs-only commit whose code had passed the day before.
async function waitFor(check) {
    for (let i = 0; i < 300; i++) {
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Startup timed out: ${launcher?.output || ''}`);
}

function stopOwned(child) {
    if (!child || child.exitCode !== null) return;
    cp.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

try {
    // Observe options at the real child-process boundary; swallowed Git failures cannot hide a regression.
    cp.execFileSync = (command, args, options) => {
        if (command === 'git') calls.push({ options, stack: new Error().stack });
        return originalExec(command, args, options);
    };
    syncBuiltinESMExports();
    const project = path.join(temp, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'README.md'), '# Test project\n');
    const { getActivity } = await import('../lib/activity.mjs');
    const { recordContextClaims, normalizeLearned } = await import('../lib/context.mjs');
    const { uncommittedState } = await import('../lib/snapshot.mjs');
    const { buildBrief } = await import('../lib/continuity.mjs');
    const { buildStatusReport } = await import('../lib/report.mjs');
    const { commitsSinceDocChanged } = await import('../lib/hygiene.mjs');
    getActivity(project);
    recordContextClaims(project, normalizeLearned(['Launcher test claim']));
    uncommittedState(project);
    buildBrief(project);
    buildStatusReport(project);
    commitsSinceDocChanged(project, 'README.md');
    for (const module of ['activity', 'context', 'snapshot', 'continuity', 'report', 'hygiene']) {
        assert(calls.some(call => call.stack.includes(`/lib/${module}.mjs`)), `${module}: Git path was exercised`);
    }
    assert(calls.every(call => call.options?.windowsHide === true), 'Background Git must hide console windows');
    cp.execFileSync = originalExec;
    cp.spawn = (command, args, options) => {
        assert.equal(options.windowsHide, true, 'Browser command must hide its console');
        return { on() {}, unref() {} };
    };
    syncBuiltinESMExports();
    const { openBrowser } = await import('../lib/open-browser.mjs');
    assert.equal(openBrowser('http://127.0.0.1:3040'), true);
    cp.spawn = originalSpawn;
    syncBuiltinESMExports();
    console.log(`PASS: ${calls.length} background Git calls and browser launch hide their consoles`);

    if (process.platform === 'win32') {
        const probe = net.createServer();
        await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
        const port = probe.address().port;
        await new Promise(resolve => probe.close(resolve));
        launcher = launch(root, '--no-open', { PLUTOS_PORT: String(port) });
        await waitFor(async () => {
            if (launcher.exitCode !== null) throw new Error(launcher.output);
            try { return (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) })).ok; }
            catch { return false; }
        });
        const registry = await waitFor(() => {
            const file = path.join(temp, 'hub', 'install.json');
            return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8'));
        });
        assert.equal(path.resolve(registry.appRoot), root, 'BAT must run current source, even when dist exists');
        assert.match(launcher.output, /starting from source/);
        assert(!fs.existsSync(path.join(temp, 'hub', 'logs', 'plutos.log')), 'Packaged app was not launched');
        stopOwned(launcher);
        await launcher.finished;
        launcher = null;
        console.log('PASS: actual BAT starts source from an unrelated working directory with isolated Hub/status');

        // A Node executable stands in for a portable app, so fallback arguments can be checked without a build.
        const portable = path.join(temp, 'portable app');
        fs.mkdirSync(path.join(portable, 'dist'), { recursive: true });
        fs.copyFileSync(path.join(root, 'START_PLUT_OS.bat'), path.join(portable, 'START_PLUT_OS.bat'));
        fs.copyFileSync(process.execPath, path.join(portable, 'dist', 'PLUT_OS.exe'));
        const script = path.join(portable, 'probe.cjs');
        fs.writeFileSync(script, 'console.log("PORTABLE_OK", process.argv[2]);');
        launcher = launch(portable, `"${script}" forwarded`);
        assert.equal(await launcher.finished, 0, launcher.output);
        assert.match(launcher.output, /PORTABLE_OK forwarded/);
        launcher = null;
        fs.writeFileSync(path.join(portable, 'dashboard.mjs'), 'throw new Error("Missing dependencies must use the portable fallback");');
        launcher = launch(portable, `"${script}" forwarded`);
        assert.equal(await launcher.finished, 0, launcher.output);
        assert.match(launcher.output, /npm ci/);
        assert.match(launcher.output, /PORTABLE_OK forwarded/);
        launcher = null;
        fs.unlinkSync(path.join(portable, 'dist', 'PLUT_OS.exe'));
        launcher = launch(portable);
        assert.equal(await launcher.finished, 1);
        assert.match(launcher.output, /Node.js 22\+|could not start/);
        launcher = null;
        console.log('PASS: portable fallback forwards arguments with missing source/dependencies; missing runtime reports failure');
    }
} finally {
    cp.execFileSync = originalExec;
    cp.spawn = originalSpawn;
    syncBuiltinESMExports();
    stopOwned(launcher);
    if (launcher) await launcher.finished;
    // Only this run's mkdtemp directory is removed.
    fs.rmSync(temp, { recursive: true, force: true });
}

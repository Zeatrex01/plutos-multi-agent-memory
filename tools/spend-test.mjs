// Spend refresh tests use fake CLI output and owned synthetic processes, never CodeBurn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-spend-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
const original = {
    execFile: childProcess.execFile, execFileSync: childProcess.execFileSync, spawn: childProcess.spawn,
    setTimeout, clearTimeout, now: Date.now, kill: process.kill
};
const jobs = [], kills = [], deadlines = new Set();
let now = Date.parse('2026-09-08T08:00:00.000Z');
let throwsOnStart = false;
let passed = 0, failed = 0;
const fixture = JSON.stringify({ history: { daily: [{ date: '2026-09-08', cost: 12.5, calls: 7 }] }, currency: { symbol: '$' } });
const pause = ms => new Promise(resolve => original.setTimeout(resolve, ms));
const listeners = () => ['exit', 'SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
const baselineListeners = listeners();

function stubCli() {
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms, ...args) => {
        if (ms !== 25000) return original.setTimeout(fn, ms, ...args);
        const timer = { fn, unref() {} };
        deadlines.add(timer);
        return timer;
    };
    globalThis.clearTimeout = timer => deadlines.has(timer) ? deadlines.delete(timer) : original.clearTimeout(timer);
    childProcess.execFileSync = () => { throw new Error('Synchronous CLI execution is forbidden'); };
    childProcess.execFile = (file, args, options, callback) => {
        if (throwsOnStart) throw new Error('Synthetic spawn failure');
        assert.equal(options.windowsHide, true);
        assert.equal(options.timeout, undefined, 'wrapper must not be killed before its descendants');
        const child = new EventEmitter();
        child.pid = 900000 + jobs.length;
        child.kill = () => { kills.push({ pid: child.pid, fallback: true }); };
        jobs.push({ file, args, options, callback, child });
        return child;
    };
    childProcess.spawn = (file, args, options) => {
        kills.push({ file, args, options });
        const killer = new EventEmitter();
        killer.unref = () => {};
        setImmediate(() => killer.emit('exit', 0));
        return killer;
    };
    process.kill = (pid, signal) => {
        if (pid <= -900000) { kills.push({ pid, signal }); return true; }
        return original.kill.call(process, pid, signal);
    };
}
function restore() {
    childProcess.execFile = original.execFile;
    childProcess.execFileSync = original.execFileSync;
    childProcess.spawn = original.spawn;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    Date.now = original.now;
    process.kill = original.kill;
}
async function test(name, run) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
}
async function fresh(name) { return import(new URL(`../lib/spend.mjs?spend-test=${name}`, import.meta.url)); }

try {
    stubCli();
    const { getProjectSpend: readOnly, runProjectSpend: getProjectSpend } = await fresh('cache');
    await test('reading never starts CodeBurn: only a run does', async () => {
        const read = readOnly('A');
        assert.equal(read.pending, false);
        assert.equal(read.standby, true);
        assert.equal(jobs.length, 0, 'opening the page must not run an outside tool');
    });
    await test('a slow CLI leaves the synchronous API and event loop responsive', async () => {
        const initial = getProjectSpend('A');
        assert.equal(initial.pending, true);
        assert.equal(initial.standby, true);
        assert.equal(initial.updatedAt, null);
        assert.equal(typeof initial.then, 'undefined');
        await pause(10);
        assert.equal(getProjectSpend('A').pending, true);
        assert.equal(jobs.length, 1);
    });
    await test('concurrent callers share one refresh and then reuse its successful cache', () => {
        for (let i = 0; i < 20; i++) getProjectSpend(`project-${i}`, 'all');
        assert.equal(jobs.length, 1);
        jobs[0].callback(null, fixture);
        const spend = getProjectSpend('B', 'all');
        assert.equal(spend.project, 'B');
        assert.equal(spend.rangeCost, 12.5);
        assert.equal(spend.rangeCalls, 7);
        assert.equal(spend.pending, false);
        assert.equal(spend.standby, false);
        assert.equal(spend.error, null);
        assert.equal(spend.updatedAt, new Date(now).toISOString());
        now += 59999;
        getProjectSpend('B');
        assert.equal(jobs.length, 1);
        assert.deepEqual(listeners(), baselineListeners);
    });
    await test('refresh failure retains the last good data and backs off for sixty seconds', () => {
        const lastGood = getProjectSpend('A');
        now += 2;
        const updating = getProjectSpend('A');
        assert.equal(updating.pending, true);
        assert.equal(updating.stale, true);
        assert.equal(updating.rangeCost, 12.5);
        assert.equal(updating.updatedAt, lastGood.updatedAt);
        jobs.at(-1).callback(new Error('Synthetic failure'));
        const failed = getProjectSpend('A');
        assert.equal(failed.pending, false);
        assert.equal(failed.stale, true);
        assert.equal(failed.rangeCost, 12.5);
        assert.equal(failed.updatedAt, lastGood.updatedAt);
        assert(failed.error);
        for (let i = 0; i < 20; i++) getProjectSpend('A');
        assert.equal(jobs.length, 2);
        now += 60001;
        getProjectSpend('A');
        assert.equal(jobs.length, 3);
        jobs.at(-1).callback(null, fixture);
        assert.equal(getProjectSpend('A').error, null);
    });
    await test('invalid output is an error with backoff, preserving the last successful timestamp', () => {
        const prior = getProjectSpend('A');
        now += 60001;
        getProjectSpend('A');
        jobs.at(-1).callback(null, 'not-json');
        const result = getProjectSpend('A');
        assert(result.error);
        assert.equal(result.rangeCost, prior.rangeCost);
        assert.equal(result.updatedAt, prior.updatedAt);
        const count = jobs.length;
        getProjectSpend('A');
        assert.equal(jobs.length, count);
    });
    await test('an initial failure stays explicitly unavailable and does not retry per request', async () => {
        const api = await fresh('failure');
        api.runProjectSpend();
        jobs.at(-1).callback(new Error('Synthetic failure'));
        const count = jobs.length;
        const result = api.runProjectSpend();
        assert.equal(result.standby, true);
        assert.equal(result.updatedAt, null);
        assert(result.error);
        assert.equal(jobs.length, count);
    });
    await test('a synchronous spawn error also releases single-flight state and backs off', async () => {
        const api = await fresh('spawn');
        throwsOnStart = true;
        try {
            const result = api.runProjectSpend();
            assert.equal(result.pending, false);
            assert(result.error);
            assert.equal(api.runProjectSpend().error, result.error);
            assert.deepEqual(listeners(), baselineListeners);
        } finally { throwsOnStart = false; }
    });
    await test('timeout settles without a CLI callback and kills the owned process tree', async () => {
        const api = await fresh('timeout');
        api.runProjectSpend();
        const job = jobs.at(-1);
        [...deadlines].at(-1).fn();
        const result = api.runProjectSpend();
        assert.equal(result.pending, false);
        assert.match(result.error, /timed out/);
        assert.equal(deadlines.size, 0);
        if (process.platform === 'win32') {
            assert.deepEqual(kills.at(-1).args, ['/PID', String(job.child.pid), '/T', '/F']);
            assert.equal(kills.at(-1).options.windowsHide, true);
            assert.equal(kills.at(-1).options.timeout, 5000);
        } else assert.deepEqual(kills.at(-1), { pid: -job.child.pid, signal: 'SIGKILL' });
        job.callback(null, fixture);
        assert.equal(api.runProjectSpend().updatedAt, null, 'late results cannot overwrite a timed-out operation');
        assert.deepEqual(listeners(), baselineListeners);
    });
    restore();

    // Exercise real Windows tree cleanup without npx, provider access, or private transcripts.
    if (process.platform === 'win32') {
        for (const mode of ['timeout', 'exit']) {
            await test(`real Windows ${mode} cleanup stops a synthetic wrapper and grandchild`, async () => {
                const dir = path.join(tmp, mode);
                fs.mkdirSync(dir);
                const wrapperPidFile = path.join(dir, 'wrapper.pid');
                const leafPidFile = path.join(dir, 'leaf.pid');
                const leaf = `require('fs').writeFileSync(${JSON.stringify(leafPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
                const wrapper = `require('fs').writeFileSync(${JSON.stringify(wrapperPidFile)}, String(process.pid));
                    require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {windowsHide:true, stdio:'ignore'});
                    setInterval(() => {}, 1000);`;
                const source = `import cp from 'node:child_process';
                    const exec = cp.execFile; cp.execFile = (file,args,options,callback) => exec(process.execPath, ['-e', ${JSON.stringify(wrapper)}], options, callback);
                    const timer = globalThis.setTimeout;
                    globalThis.setTimeout = (fn,ms,...args) => timer(fn, ms === 25000 ? 3000 : ms, ...args);
                    const api = await import(${JSON.stringify(new URL('../lib/spend.mjs', import.meta.url).href)});
                    api.runProjectSpend();
                    process.stdin.on('data', () => process.exit(0));`;
                const worker = original.spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
                let errors = '';
                worker.stderr.on('data', data => { errors += data; });
                const pids = [];
                const alive = pid => { try { original.kill(pid, 0); return true; } catch { return false; } };
                try {
                    for (let i = 0; i < 50 && !fs.existsSync(leafPidFile); i++) await pause(40);
                    assert(fs.existsSync(leafPidFile), errors || 'Synthetic descendant did not start');
                    pids.push(Number(fs.readFileSync(wrapperPidFile, 'utf8')), Number(fs.readFileSync(leafPidFile, 'utf8')));
                    assert(pids.every(alive));
                    if (mode === 'exit') worker.stdin.write('exit\n');
                    for (let i = 0; i < 120 && pids.some(alive); i++) await pause(50);
                    assert(pids.every(pid => !alive(pid)), `Owned processes remain alive: ${pids.filter(alive).join(', ')}`);
                } finally {
                    for (const pid of pids.filter(alive)) {
                        await new Promise(resolve => original.execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()));
                    }
                    if (worker.exitCode === null && worker.signalCode === null) {
                        await new Promise(resolve => { worker.once('exit', resolve); worker.kill(); });
                    }
                }
            });
        }
    }
} finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nSpend refresh: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

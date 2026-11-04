// Exercise the real BAT with a stale Explorer PATH and occupied ports.
// Fixture dashboards exit themselves; no existing application process is stopped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32') {
    console.log('SKIP: Windows BAT startup');
    process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-windows-startup-'));
const fixture = path.join(temp, 'source checkout');
const sdk = path.join(fixture, 'node_modules', '@modelcontextprotocol', 'sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.writeFileSync(path.join(sdk, 'package.json'), '{}');
fs.copyFileSync(path.join(root, 'START_PLUT_OS.bat'), path.join(fixture, 'START_PLUT_OS.bat'));
fs.copyFileSync(path.join(root, 'DEV_PLUT_OS.bat'), path.join(fixture, 'DEV_PLUT_OS.bat'));
fs.writeFileSync(path.join(fixture, 'dashboard.mjs'),
    // The self-exit clock starts once the dashboard has loaded, so a slow cold start cannot
    // end the fixture before the test has even seen it come up.
    `console.log('NODE_EXEC', process.execPath); await import(${JSON.stringify(pathToFileURL(path.join(root, 'dashboard.mjs')).href)}); setTimeout(() => process.exit(0), 8000);`);
const env = { ...process.env, PLUTOS_HOME: path.join(temp, 'hub')};
for (const key of ['PLUTOS_PORT', 'PLUTOS_PROJECT_ROOT', 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER', 'PLUTOS_PACKAGED', 'CLAUDE_PROJECT_DIR']) delete env[key];
const children = [];

function launch(overrides = {}, args = '--no-open', bat = 'START_PLUT_OS.bat') {
    const child = spawn(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `""${path.join(fixture, bat)}" ${args}"`], {
            cwd: temp, env: { ...env, ...overrides }, windowsHide: true,
            windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe']
        });
    child.output = '';
    child.stdout.on('data', data => { child.output += data; });
    child.stderr.on('data', data => { child.output += data; });
    child.finished = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve(code));
    });
    children.push(child);
    return child;
}

// 30 s for the first ready line: cold Windows runners vary well past the old 10 s.
async function ready(child) {
    for (let i = 0; i < 300; i++) {
        const match = child.output.match(/Interface: http:\/\/localhost:(\d+)/);
        if (match) {
            const response = await fetch(`http://127.0.0.1:${match[1]}/api/app/mode`, { signal: AbortSignal.timeout(1000) });
            assert.equal(response.status, 200);
            const mode = await response.json();
            assert.equal(path.resolve(mode.appRoot), root);
            assert.equal(path.resolve(mode.dataHome), env.PLUTOS_HOME);
            return Number(match[1]);
        }
        assert.equal(child.exitCode, null, child.output);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(child.output || 'BAT startup timed out');
}

let blocker;
try {
    // Bind only if free. An existing service on 3040 is never stopped or modified.
    blocker = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    const ownedDefaultPort = await new Promise((resolve, reject) => {
        blocker.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
        blocker.listen(3040, '127.0.0.1', () => resolve(true));
    });
    const stalePath = { PATH: path.join(process.env.SystemRoot, 'System32') };
    const auto = launch(stalePath);
    const selected = await ready(auto);
    assert(selected > 3040 && selected <= 3050, auto.output);
    assert.match(auto.output, /NODE_EXEC .*node\.exe/i);
    console.log('PASS: BAT finds installed Node with stale PATH and starts source beside a busy default port');

    const reopen = launch(stalePath);
    assert.equal(await reopen.finished, 0, reopen.output);
    assert.match(reopen.output, /already running/);
    assert(!reopen.output.includes('PLUT_OS is running'), reopen.output);
    console.log('PASS: repeated source launch reuses the matching instance');
    assert.equal(await auto.finished, 0, auto.output);
    if (ownedDefaultPort) await new Promise(resolve => blocker.close(resolve));
    blocker = null;

    blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const explicit = launch({ PLUTOS_PORT: String(blocker.address().port) });
    assert.equal(await explicit.finished, 1, explicit.output);
    assert.match(explicit.output, /already in use/);
    assert(!explicit.output.includes('Trying port'), explicit.output);
    console.log('PASS: explicit port is respected and failure stays visible');
    await new Promise(resolve => blocker.close(resolve));
    blocker = null;

    // The DEV launcher ignores a PLUTOS_HOME left in the shell (env above sets one) and uses its
    // own data folder; PLUTOS_DEV_HOME is the test seam for where that folder is.
    const devHome = path.join(temp, 'dev-hub');
    const dev = launch({ ...stalePath, PLUTOS_DEV_HOME: devHome }, '--no-open', 'DEV_PLUT_OS.bat');
    let devPort = 0;
    for (let i = 0; i < 300 && !devPort; i++) {
        const match = dev.output.match(/Interface: http:\/\/localhost:(\d+)/);
        if (match) devPort = Number(match[1]);
        else { assert.equal(dev.exitCode, null, dev.output); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert(devPort, dev.output || 'DEV startup timed out');
    const devMode = await (await fetch(`http://127.0.0.1:${devPort}/api/app/mode`, { signal: AbortSignal.timeout(1000) })).json();
    assert.equal(devMode.devMode, true);
    assert.equal(path.resolve(devMode.dataHome), devHome);
    assert(devPort >= 3041 && devPort <= 3051, dev.output);
    assert.match(dev.output, /DEVELOPMENT MODE/);
    assert.equal(await dev.finished, 0, dev.output);
    console.log('PASS: DEV launcher starts development mode on its own data folder and port');

    fs.unlinkSync(path.join(fixture, 'dashboard.mjs'));
    fs.copyFileSync(process.execPath, path.join(fixture, 'PLUT_OS.exe'));
    const probe = path.join(fixture, 'probe.cjs');
    fs.writeFileSync(probe, 'console.log("PORTABLE_OK", process.argv[2]);');
    const portable = launch(stalePath, `"${probe}" forwarded`);
    assert.equal(await portable.finished, 0, portable.output);
    assert.match(portable.output, /PORTABLE_OK forwarded/);
    console.log('PASS: portable EXE beside BAT receives quoted arguments');

    const devWithoutSource = launch({ PLUTOS_DEV_HOME: path.join(temp, 'dev-hub') }, `"${probe}" forwarded`, 'DEV_PLUT_OS.bat');
    assert.equal(await devWithoutSource.finished, 1, devWithoutSource.output);
    assert.match(devWithoutSource.output, /runs only from the PLUT_OS source folder/);
    assert(!devWithoutSource.output.includes('PORTABLE_OK'), devWithoutSource.output);
    console.log('PASS: DEV launcher without source refuses instead of starting the EXE');

    fs.mkdirSync(path.join(fixture, 'dist'));
    fs.renameSync(path.join(fixture, 'PLUT_OS.exe'), path.join(fixture, 'dist', 'PLUT_OS.exe'));
    fs.writeFileSync(path.join(fixture, 'dashboard.mjs'), 'throw new Error("Missing SDK must fall back to EXE");');
    fs.unlinkSync(path.join(sdk, 'package.json'));
    const missingSdk = launch({}, `"${probe}" forwarded`);
    assert.equal(await missingSdk.finished, 0, missingSdk.output);
    assert.match(missingSdk.output, /npm ci/);
    assert.match(missingSdk.output, /PORTABLE_OK forwarded/);
    console.log('PASS: missing source dependencies use dist EXE');

    const devMissingSdk = launch({ PLUTOS_DEV_HOME: path.join(temp, 'dev-hub') }, `"${probe}" forwarded`, 'DEV_PLUT_OS.bat');
    assert.equal(await devMissingSdk.finished, 1, devMissingSdk.output);
    assert.match(devMissingSdk.output, /Development mode runs from source/);
    assert(!devMissingSdk.output.includes('PORTABLE_OK'), devMissingSdk.output);
    console.log('PASS: DEV launcher with missing source dependencies refuses the EXE fallback');

    fs.unlinkSync(path.join(fixture, 'dist', 'PLUT_OS.exe'));
    const missingRuntime = launch({ ...stalePath, ProgramFiles: temp, ProgramW6432: temp,
        'ProgramFiles(x86)': temp, LOCALAPPDATA: temp, NVM_SYMLINK: temp });
    assert.equal(await missingRuntime.finished, 1);
    assert.match(missingRuntime.output, /Node.js 22\+ was not found/);
    assert.match(missingRuntime.output, /could not start/);
    console.log('PASS: missing Node and EXE report a visible failure');
} finally {
    // All fixture dashboards have a self-exit timer, including failure paths.
    await Promise.allSettled(children.map(child => child.finished));
    if (blocker?.listening) await new Promise(resolve => blocker.close(resolve));
    // The launched EXE can still be releasing its file when the suite ends; a plain remove then
    // fails with EBUSY after every check passed. Retry briefly, and a leftover temp folder is a log
    // line, not a red CI (the same teardown the other suites use).
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.log(`  (temp folder left behind: ${e.code || e.message})`); }
}

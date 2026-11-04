#!/usr/bin/env node
// The project launcher (.plutos/plutos-launch.mjs) holds only what finding PLUT_OS takes and hands
// over to the install's lib/launch.mjs, so a change in PLUT_OS reaches every project; an older
// generated stub is replaced when its project is opened, and a file without the mark is not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-stub-')));
process.env.PLUTOS_HOME = path.join(scratch, 'hub');
delete process.env.PLUTOS_PROJECT_ROOT;
delete process.env.PLUTOS_PROJECT_BOUND_BY_LAUNCHER;
const { launcherStub, healLauncherStub, addWorkspace, switchWorkspace } = await import('../lib/workspaces.mjs');
const { PROJECT_ROOT_ENV, LAUNCHER_BOUND_ENV } = await import('../lib/project-binding.mjs');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

// A fake install: the real lib/launch.mjs, and an index.mjs, dashboard.mjs or lite PLUT_OS.cjs that
// records what it saw. The .cjs is CommonJS, so it finds its URL the way the lite bundle's banner does.
function fakeInstall(name, { launch = true, entry = 'index.mjs' } = {}) {
    const dir = path.join(scratch, name);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    if (launch) fs.copyFileSync(path.join(root, 'lib', 'launch.mjs'), path.join(dir, 'lib', 'launch.mjs'));
    const head = entry.endsWith('.cjs')
        ? "const fs = require('fs');\nconst url = require('url').pathToFileURL(__filename).href;\n"
        : "import fs from 'fs';\nconst url = import.meta.url;\n";
    fs.writeFileSync(path.join(dir, entry), head + "fs.writeFileSync(process.env.PROBE, JSON.stringify({ install: url.split('/').slice(-2, -1)[0], file: url.split('/').pop(), root: process.env.PLUTOS_PROJECT_ROOT, bound: process.env.PLUTOS_PROJECT_BOUND_BY_LAUNCHER, home: process.env.PLUTOS_HOME, argv: process.argv.slice(2) }));\n");
    return dir;
}
function project(name, stub = launcherStub()) {
    const dir = path.join(scratch, name);
    fs.mkdirSync(path.join(dir, '.plutos'), { recursive: true });
    if (stub !== null) fs.writeFileSync(path.join(dir, '.plutos', 'plutos-launch.mjs'), stub);
    return dir;
}
const run = (dir, local, args = [], home = path.join(scratch, 'hub-' + path.basename(dir))) => {
    fs.writeFileSync(path.join(dir, '.plutos', 'local.json'), JSON.stringify(local));
    const probe = path.join(scratch, `probe-${path.basename(dir)}-${args.join('')}.json`);
    const env = { ...process.env, PROBE: probe, PLUTOS_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home };
    const r = spawnSync(process.execPath, [path.join(dir, '.plutos', 'plutos-launch.mjs'), ...args], { cwd: scratch, env, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, seen: fs.existsSync(probe) ? JSON.parse(fs.readFileSync(probe, 'utf8')) : null, home };
};

try {
    check('the stub is the finding part only: under 40 lines, and it hands over to lib/launch.mjs', () => {
        const stub = launcherStub();
        assert.ok(stub.split('\n').length < 40, `${stub.split('\n').length} lines`);
        assert.match(stub, /path\.join\(plutosRoot, 'lib', 'launch\.mjs'\)/);
        assert.doesNotMatch(stub, /spawn|dashboard\.mjs|index\.mjs/, 'starting PLUT_OS belongs to lib/launch.mjs');
    });
    check('lib/launch.mjs sets the variables lib/project-binding.mjs reads, and imports only built-ins', () => {
        const text = fs.readFileSync(path.join(root, 'lib', 'launch.mjs'), 'utf8');
        assert.ok(text.includes(`process.env.${PROJECT_ROOT_ENV} = projectRoot`) && text.includes(`process.env.${LAUNCHER_BOUND_ENV} = '1'`));
        assert.deepEqual([...text.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]).filter(s => !s.startsWith('node:')), []);
    });
    check('the MCP launch binds the project, the Hub and the arguments, and finds the install through local.json', () => {
        const install = fakeInstall('install-a');
        const dir = project('project-a');
        const r = run(dir, { plutosRoot: install }, ['--brief']);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.seen, { install: 'install-a', file: 'index.mjs', root: dir, bound: '1', home: r.home, argv: ['--brief'] });
    });
    check('the install registry wins over local.json, so a moved build needs no project rewrite', () => {
        const moved = fakeInstall('install-moved');
        const dir = project('project-moved');
        const home = path.join(scratch, 'hub-moved');
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ appRoot: moved }));
        const stale = fakeInstall('install-stale');
        const before = fs.readFileSync(path.join(dir, '.plutos', 'plutos-launch.mjs'), 'utf8');
        const r = run(dir, { plutosRoot: stale }, [], home);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual([r.seen.install, r.seen.root], ['install-moved', dir]);
        assert.equal(fs.readFileSync(path.join(dir, '.plutos', 'plutos-launch.mjs'), 'utf8'), before);
    });
    check('--dashboard runs a checkout\'s dashboard.mjs in the same process', () => {
        const install = fakeInstall('install-dash', { entry: 'dashboard.mjs' });
        const dir = project('project-dash');
        const r = run(dir, { plutosRoot: install }, ['--dashboard', '--open']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.seen.file, 'dashboard.mjs');
        assert.deepEqual(r.seen.argv, ['--dashboard', '--open']);
    });
    check('--dashboard runs a lite install\'s PLUT_OS.cjs in the same process', () => {
        const install = fakeInstall('install-lite', { entry: 'PLUT_OS.cjs' });
        const dir = project('project-lite');
        const r = run(dir, { plutosRoot: install }, ['--dashboard', '--open']);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.seen, { install: 'install-lite', file: 'PLUT_OS.cjs', root: dir, bound: '1', home: r.home, argv: ['--dashboard', '--open'] });
    });
    check('an install older than lib/launch.mjs is refused with what to do', () => {
        const old = fakeInstall('install-old', { launch: false });
        const dir = project('project-old');
        const r = run(dir, { plutosRoot: old });
        assert.equal(r.status, 1);
        assert.equal(r.seen, null);
        assert.match(r.stderr, /No usable PLUT_OS install is registered\. Launch PLUT_OS once/);
    });
    check('healing replaces an older generated stub and leaves the owner\'s file, the current stub and a link alone', () => {
        const old = project('heal-old', '// Generated by PLUT_OS — do not edit. Resolves this machine\'s PLUT_OS install from\nconsole.log("old");\n');
        assert.equal(healLauncherStub(old), true);
        assert.equal(fs.readFileSync(path.join(old, '.plutos', 'plutos-launch.mjs'), 'utf8'), launcherStub());
        assert.equal(healLauncherStub(old), false, 'a current stub is not written again');
        const owners = project('heal-owner', '// owner sentinel — do not rewrite\n');
        assert.equal(healLauncherStub(owners), false);
        assert.equal(fs.readFileSync(path.join(owners, '.plutos', 'plutos-launch.mjs'), 'utf8'), '// owner sentinel — do not rewrite\n');
        assert.equal(healLauncherStub(project('heal-none', null)), false, 'no stub, nothing written');
        assert.ok(!fs.existsSync(path.join(scratch, 'heal-none', '.plutos', 'plutos-launch.mjs')));
        if (process.platform !== 'win32') {
            const linked = project('heal-link', null);
            fs.writeFileSync(path.join(scratch, 'elsewhere.mjs'), '// Generated by PLUT_OS — elsewhere\n');
            fs.symlinkSync(path.join(scratch, 'elsewhere.mjs'), path.join(linked, '.plutos', 'plutos-launch.mjs'));
            assert.equal(healLauncherStub(linked), false);
            assert.equal(fs.readFileSync(path.join(scratch, 'elsewhere.mjs'), 'utf8'), '// Generated by PLUT_OS — elsewhere\n');
        }
    });
    check('adding a project only observes it; opening it heals its stub', () => {
        const stale = '// Generated by PLUT_OS — do not edit. Resolves this machine\'s PLUT_OS install from\n';
        const dir = project('opened', stale);
        addWorkspace(dir);
        assert.equal(fs.readFileSync(path.join(dir, '.plutos', 'plutos-launch.mjs'), 'utf8'), stale, 'Add is register and observe');
        switchWorkspace(dir);
        assert.equal(fs.readFileSync(path.join(dir, '.plutos', 'plutos-launch.mjs'), 'utf8'), launcherStub());
    });
    console.log(`launcher-stub: ${checks} checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

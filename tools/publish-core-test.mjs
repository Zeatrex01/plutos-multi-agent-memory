#!/usr/bin/env node
// tools/publish-core.mjs: the core reaches the main repository, the working records and the
// owner's documents do not, the target's own files are left alone, files the source dropped are
// removed, a dry run writes nothing, and a personal path or a dirty target refuses the publish
// before anything is written. The planted path is assembled at run time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'publish-core.mjs');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-publish-'));
const repo = (name, files) => {
    const dir = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
    }
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    return { dir, git };
};
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

try {
    const source = repo('source', {
        'lib/a.mjs': 'export const a = 2;\n',
        'docs/GUIDE.md': 'guide v2\n',
        'MVP.md': 'the owner\'s plan\n',
        'docs/handoff/BOARD.md': 'live board with work in it\n',
        'docs/handoff/results/r.md': 'a result\n',
        '.github/workflows/ci.yml': 'working copy CI\n',
    });
    const target = repo('target', {
        'lib/a.mjs': 'export const a = 1;\n',
        'old.mjs': 'dropped in the source\n',
        'docs/handoff/BOARD.md': 'clean template\n',
        '.github/workflows/ci.yml': 'main CI\n',
    });

    check('a dry run lists the plan and writes nothing', () => {
        const r = run(target.dir, '--source', source.dir, '--dry-run', '--json');
        assert.equal(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.deepEqual(out.changed.sort(), ['docs/GUIDE.md', 'lib/a.mjs']);
        assert.deepEqual(out.removed, ['old.mjs']);
        assert.equal(read(target.dir, 'lib/a.mjs'), 'export const a = 1;\n');
    });

    check('publishing copies the core, removes what the source dropped, keeps private files and the target\'s own', () => {
        const r = run(target.dir, '--source', source.dir);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(read(target.dir, 'lib/a.mjs'), 'export const a = 2;\n');
        assert.equal(read(target.dir, 'docs/GUIDE.md'), 'guide v2\n');
        assert.ok(!fs.existsSync(path.join(target.dir, 'old.mjs')));
        assert.ok(!fs.existsSync(path.join(target.dir, 'MVP.md')));
        assert.ok(!fs.existsSync(path.join(target.dir, 'docs/handoff/results/r.md')));
        assert.equal(read(target.dir, 'docs/handoff/BOARD.md'), 'clean template\n');
        assert.equal(read(target.dir, '.github/workflows/ci.yml'), 'main CI\n');
    });

    check('a dirty target is refused', () => {
        const r = run(target.dir, '--source', source.dir);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /uncommitted changes/);
    });

    check('a personal path in a file to copy refuses the publish before anything is written', () => {
        target.git('add', '-A');
        target.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'publish');
        fs.writeFileSync(path.join(source.dir, 'lib/a.mjs'), `const where = '${['', 'home', 'alice', 'x'].join('/')}';\n`);
        source.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'leak');
        const r = run(target.dir, '--source', source.dir);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /personal lib\/a\.mjs:1/);
        assert.equal(read(target.dir, 'lib/a.mjs'), 'export const a = 2;\n');
    });

    check('the target must not be the source, and usage is checked', () => {
        assert.equal(run(source.dir, '--source', source.dir).status, 1);
        assert.equal(run().status, 2);
        assert.equal(run(path.join(tmp, 'nowhere')).status, 2);
    });
    check('a new, empty target gets its own files from tools/public-repo/, an existing one keeps its own', () => {
        const seeded = repo('seeded-source', {
            'lib/a.mjs': 'export const a = 3;\n',
            'tools/public-repo/docs/handoff/BOARD.md': 'seed board\n',
            'tools/public-repo/.github/workflows/ci.yml': 'seed CI\n',
        });
        const empty = path.join(tmp, 'empty-target');
        fs.mkdirSync(empty);
        execFileSync('git', ['-C', empty, 'init', '-q']);
        const r = run(empty, '--source', seeded.dir, '--json');
        assert.equal(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.deepEqual(out.seeded.sort(), ['.github/workflows/ci.yml', 'docs/handoff/BOARD.md']);
        assert.equal(read(empty, 'docs/handoff/BOARD.md'), 'seed board\n');
        assert.ok(!fs.existsSync(path.join(empty, 'tools', 'public-repo')), 'the seed folder itself is not published');
        const again = JSON.parse(run(target.dir, '--source', seeded.dir, '--json', '--dry-run').stdout);
        assert.deepEqual(again.seeded, [], 'a target that has its own files is never seeded');
    });
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`publish-core: ${checks} checks passed`);

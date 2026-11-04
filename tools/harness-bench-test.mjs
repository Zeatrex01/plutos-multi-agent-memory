#!/usr/bin/env node
// The harness bench tool (tools/harness-bench.mjs) on this repository's HEAD with one task and one
// trial: setup, check on an untouched clone (pass=0), check on a clone with the known-good change
// (pass=1), summarize with its false-done exit code, and the --out guard. T2 only: its check runs
// in a second; the other tasks pack or run suites.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { outputDir } from './harness-bench.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'harness-bench.mjs');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-harness-bench-test-'));
const runs = path.join(out, 'runs'), wt = path.join(out, 'wt');
const bench = (...a) => spawnSync(process.execPath, [tool, ...a], { cwd: root, encoding: 'utf8', timeout: 300_000 });
const TASK = 'T2-scope-noappetite';
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
try {
    check('--help prints the usage and exits 0', () => {
        const r = bench('--help');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /setup <phase> <commit>/);
        assert.match(r.stdout, /metrics\.jsonl/);
    });
    check('an --out inside the repository or outside the temp folder is refused', () => {
        assert.throws(() => outputDir(path.join(root, 'bench-out')), /--out must lie/);
        // A folder outside the temp folder: the drive root, since a checkout may itself sit under the temp folder.
        assert.throws(() => outputDir(path.join(path.parse(root).root, 'plutos-bench-elsewhere')), /--out must lie/);
        const r = bench('setup', 'base', 'HEAD', '--out', path.join(root, 'bench-out'));
        assert.equal(r.status, 2);
        assert.match(r.stderr, /--out must lie/);
        assert.ok(!fs.existsSync(path.join(root, 'bench-out')));
    });
    check('setup makes one clone per task x trial, with the brief, the prompt and the post-brief head', () => {
        const r = bench('setup', 'base', 'HEAD', '--trials', '1', '--tasks', TASK, '--out', out);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const id = `base-${TASK}-1`, dir = path.join(wt, id);
        assert.match(r.stdout, new RegExp(`^${id} .* brief \\d+ words`, 'm'));
        assert.ok(fs.existsSync(path.join(dir, 'lib', 'scope.mjs')));
        assert.ok(fs.readFileSync(path.join(runs, `${id}.brief.txt`), 'utf8').length > 100);
        const prompt = fs.readFileSync(path.join(runs, `${id}.prompt.txt`), 'utf8');
        assert.ok(prompt.includes('no appetite set') && prompt.includes(path.join(runs, `${id}.brief.txt`)) && prompt.includes(dir));
        assert.match(fs.readFileSync(path.join(runs, 'base.heads'), 'utf8'), new RegExp(`^${id} [0-9a-f]{40}$`, 'm'));
        const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout.trim();
        assert.match(git('remote', 'get-url', '--push', 'origin'), /no-push-in-bench$/);
        assert.equal(git('ls-files', 'node_modules'), '', 'the node_modules link is never committed');
        assert.equal(git('status', '--short'), '', 'the post-brief state is committed');
    });
    check('check on an untouched clone reports pass=0 with the FAIL line, saves the patch and removes the clone', () => {
        const r = bench('check', 'base', '--out', out);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const id = `base-${TASK}-1`;
        assert.match(r.stdout, new RegExp(`^${id} pass=0 files=\\[\\] FAIL missing 'no appetite set'`, 'm'));
        assert.match(fs.readFileSync(path.join(runs, 'base.checks'), 'utf8'), new RegExp(`^${id} pass=0 `, 'm'));
        assert.ok(fs.existsSync(path.join(runs, 'patches', `${id}.patch`)));
        assert.ok(!fs.existsSync(path.join(wt, id)));
    });
    check('check on a clone with the known-good change reports pass=1 and names the file', () => {
        assert.equal(bench('setup', 'after', 'HEAD', '--trials', '1', '--tasks', TASK, '--out', out).status, 0);
        const id = `after-${TASK}-1`, file = path.join(wt, id, 'lib', 'scope.mjs');
        const anchor = "    if (!scope.architecture) parts.push('no approved Architecture: PLAN first');";
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(src.includes(anchor), 'the known-good change needs its anchor line in lib/scope.mjs');
        fs.writeFileSync(file, src.replace(anchor, `    else parts.push('no appetite set');\n${anchor}`));
        const r = bench('check', 'after', '--out', out);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        assert.match(r.stdout, new RegExp(`^${id} pass=1 files=\\[lib/scope\\.mjs\\]$`, 'm'));
        assert.ok(!fs.existsSync(path.join(wt, id)));
    });
    check('summarize prints the table and exits 1 on a trial that said done and failed its check', () => {
        const line = (id, done) => JSON.stringify({ id, tokens: 70000, toolCalls: 9, seconds: 150, ...(done === undefined ? {} : { done }) });
        fs.writeFileSync(path.join(runs, 'metrics.jsonl'), `${line(`base-${TASK}-1`, true)}\n${line(`after-${TASK}-1`, true)}\n`);
        let r = bench('summarize', '--out', out);
        assert.equal(r.status, 1, r.stderr + r.stdout);
        assert.match(r.stdout, /^brief words: after \d+, base \d+$/m);
        assert.match(r.stdout, /^\| Task \| Phase \| Pass \| Median tokens/m);
        assert.match(r.stdout, new RegExp(`^\\| ${TASK} \\| after \\| 1/1 \\| 70000 \\| 9 \\| 150 \\| 1 \\|$`, 'm'));
        assert.match(r.stdout, new RegExp(`^\\| ${TASK} \\| base \\| 0/1 \\|`, 'm'));
        assert.match(r.stdout, new RegExp(`^false done .*: base-${TASK}-1$`, 'm'));
        fs.writeFileSync(path.join(runs, 'metrics.jsonl'), `${line(`base-${TASK}-1`)}\n`);
        r = bench('summarize', '--out', out);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        assert.match(r.stdout, /done-claims not recorded/);
    });
} finally {
    fs.rmSync(out, { recursive: true, force: true });
}
console.log(`harness-bench: ${passed} checks passed`);

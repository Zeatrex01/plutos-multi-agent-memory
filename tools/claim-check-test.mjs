#!/usr/bin/env node
// The claim check holds a final message's claims against git and the disk, sends a false "done"
// back once, and records it as failing when the session stops with it again. Real repositories
// in a scratch folder; the hook is driven through its stdin like Claude Code and Codex.
// The planted test-gaming lines are built at run time, so this file does not trip the check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkClaims, claimLog, stopHook } from '../lib/claim-check.mjs';
import { recordPass, workingTree } from '../lib/push-gate.mjs';
import { housekeeping } from '../lib/hygiene.mjs';

const script = fileURLToPath(new URL('../lib/claim-check.mjs', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-claim-check-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
Object.assign(process.env, env);
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const write = (cwd, file, text) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), text); };
const commit = (cwd, file, text) => { write(cwd, file, text); sh(cwd, 'add', '-A'); sh(cwd, 'commit', '-q', '-m', file); };
const tested = cwd => recordPass(cwd, workingTree(cwd));
const keys = (cwd, message) => checkClaims(cwd, message).map(f => f.key.split(':')[0]);
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

try {
    const origin = path.join(scratch, 'origin.git');
    sh(scratch, 'init', '-q', '--bare', origin);
    const repo = path.join(scratch, 'repo');
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'lib/a.mjs', 'export const a = 1;\n');
    commit(repo, 'tools/a-test.mjs', "check('a', a === 1);\ncheck('b', true);\n");
    sh(repo, 'remote', 'add', 'origin', origin);
    sh(repo, 'push', '-q', '-u', 'origin', 'main');

    check('a message with nothing checkable passes, and so does a folder outside git', () => {
        assert.deepEqual(checkClaims(repo, 'I looked at the board and summarised it.'), []);
        assert.deepEqual(checkClaims(scratch, 'All 60 suites passed.'), []);
    });
    check('"the tests passed" holds when the work is the tree they passed on', () => {
        tested(repo);
        assert.deepEqual(keys(repo, 'All 60 suites passed.'), []);
    });
    check('"the tests passed" after a change since the passing run is sent back, naming the file', () => {
        write(repo, 'lib/a.mjs', 'export const a = 2;\n');
        const [finding] = checkClaims(repo, 'Done: all 60 suites passed.');
        assert.match(finding?.detail || '', /changed after the last passing run: lib\/a\.mjs/);
    });
    check('the claim is read in Turkish too, and a negated or asked claim claims nothing', () => {
        assert.deepEqual(keys(repo, '60 paketin hepsi geçti.'), ['tests']);
        assert.deepEqual(keys(repo, 'Testler geçti.'), ['tests']);
        assert.deepEqual(keys(repo, 'The tests have not passed on this version.'), []);
        assert.deepEqual(keys(repo, 'Did the tests pass?'), []);
        assert.deepEqual(keys(repo, 'Testler henüz geçmedi.'), []);
    });
    check('a project that keeps no passing record is not judged on test claims', () => {
        const other = path.join(scratch, 'unrecorded');
        fs.mkdirSync(other);
        sh(other, 'init', '-q', '-b', 'main');
        commit(other, 'x.txt', 'x');
        write(other, 'x.txt', 'y');
        assert.deepEqual(keys(other, 'All tests passed.'), []);
    });
    check('"pushed" while HEAD is ahead of its upstream is sent back; once pushed it holds', () => {
        sh(repo, 'checkout', '-q', '--', '.');
        commit(repo, 'lib/b.mjs', 'export const b = 1;\n');
        assert.deepEqual(keys(repo, 'Committed and pushed it.'), ['push']);
        assert.deepEqual(keys(repo, 'Gönderdim.'), ['push']);
        assert.deepEqual(keys(repo, 'Not pushed yet: one job per push.'), []);
        sh(repo, 'push', '-q');
        assert.deepEqual(keys(repo, 'Committed and pushed it.'), []);
    });
    check('a path named as created must exist; another repository\'s path and a deleted one are left alone', () => {
        assert.deepEqual(keys(repo, 'Created `lib/missing.mjs` for the parser.'), ['path']);
        assert.deepEqual(keys(repo, 'Created `lib/b.mjs` for the parser.'), []);
        assert.deepEqual(keys(repo, 'Added `modules/other/x.md` in the other repository.'), []);
        commit(repo, 'lib/gone.mjs', 'x');
        sh(repo, 'rm', '-q', 'lib/gone.mjs'); sh(repo, 'commit', '-q', '-m', 'gone');
        assert.deepEqual(keys(repo, 'I added `lib/gone.mjs` earlier and removed it.'), []);
        sh(repo, 'push', '-q');
    });
    check('a focused or skipped test in the unpushed work is sent back, claim or not', () => {
        const focused = ['it', 'only'].join('.') + "('x', () => {});\n";
        write(repo, 'tools/a-test.mjs', "check('a', a === 1);\ncheck('b', true);\n" + focused);
        assert.deepEqual(keys(repo, 'Here is the plan for tomorrow.'), ['focused']);
        sh(repo, 'checkout', '-q', '--', '.');
    });
    check('assertions removed while the message says the tests passed are sent back', () => {
        write(repo, 'tools/a-test.mjs', "check('a', a === 1);\n");
        tested(repo);
        assert.deepEqual(keys(repo, 'All tests passed.'), ['assertions']);
        assert.deepEqual(keys(repo, 'I trimmed a test; the full suite was not run.'), []);
        sh(repo, 'checkout', '-q', '--', '.');
    });
    check('a fix that edits a test file with the code must name the test change; a test-only edit passes', () => {
        write(repo, 'lib/a.mjs', 'export const a = 2;\n');
        write(repo, 'tools/a-test.mjs', "check('a', a === 2);\ncheck('b', true);\n");
        const [finding] = checkClaims(repo, 'Fixed the parser.');
        assert.equal(finding?.key, 'testfix:');
        assert.match(finding.detail, /since @\{u\} changes tools\/a-test\.mjs with the code/);
        assert.deepEqual(keys(repo, 'Düzelttim.'), ['testfix']);
        assert.deepEqual(keys(repo, 'Not fixed yet; the parser still fails.'), []);
        assert.deepEqual(keys(repo, 'Fixed the parser; `tools/a-test.mjs` now expects 2.'), []);
        assert.deepEqual(keys(repo, 'Fixed the parser and updated the a test to expect 2.'), []);
        sh(repo, 'checkout', '-q', '--', 'lib/a.mjs');
        assert.deepEqual(keys(repo, 'Fixed the parser.'), [], 'a test-only edit adds a test');
        sh(repo, 'checkout', '-q', '--', '.');
    });
    check('"the tests passed" with no stamp for this tree needs a passing test command in the transcript', () => {
        const row = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra });
        const call = (id, command) => row('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
        const result = (id, text, is_error = false) => row('user', [{ type: 'tool_result', tool_use_id: id, content: text, is_error }]);
        const transcript = (name, rows) => { const file = path.join(scratch, `${name}.jsonl`); fs.writeFileSync(file, rows.join('\n') + '\n'); return file; };
        const noRun = transcript('no-run', [call('t1', 'ls lib'), result('t1', 'a.mjs'),
            row('assistant', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }], { isSidechain: true })]);
        const passRun = transcript('pass-run', [call('t1', 'npm test'), result('t1', '60 suites passed in 40 s')]);
        const failRun = transcript('fail-run', [call('t1', 'npm test'), result('t1', '60 suites passed'), call('t2', 'node tools/run-all-tests.mjs'), result('t2', 'Exit code 1\n1 of 60 suites failed', true)]);
        const failLine = transcript('fail-line', [call('t1', 'pytest -q'), result('t1', '3 passed, 1 failed')]);
        const noTools = transcript('no-tools', [row('assistant', [{ type: 'text', text: 'All tests passed.' }])]);
        const at = (file, message = 'All 60 suites passed.') => checkClaims(repo, message, { transcriptPath: file, session: 's9' }).map(f => f.key);
        tested(repo);
        assert.deepEqual(at(noRun), [], 'a passing stamp for this tree is proof enough');
        write(repo, 'lib/a.mjs', 'export const a = 3;\n');
        assert.deepEqual(at(noRun).filter(k => k.startsWith('notests')), ['notests:s9']);
        assert.match(checkClaims(repo, 'Testler geçti.', { transcriptPath: noRun }).find(f => f.key.startsWith('notests')).detail, /no test command ran in this session/);
        assert.deepEqual(at(passRun).filter(k => k.startsWith('notests')), []);
        assert.deepEqual(at(failRun).filter(k => k.startsWith('notests')), ['notests:s9']);
        assert.match(checkClaims(repo, 'Tests passed.', { transcriptPath: failRun }).find(f => f.key.startsWith('notests')).detail, /last test command in this session failed/);
        assert.deepEqual(at(failLine).filter(k => k.startsWith('notests')), ['notests:s9']);
        assert.deepEqual(at(noTools).filter(k => k.startsWith('notests')), [], 'a transcript with no tool call is not judged');
        assert.deepEqual(at(path.join(scratch, 'missing.jsonl')).filter(k => k.startsWith('notests')), [], 'no transcript, no verdict');
        assert.deepEqual(at(noRun, 'The tests were not run.'), []);
        sh(repo, 'checkout', '-q', '--', '.');
    });
    check('the hook sends a finding back once, then lets the stop go and records it as failing', () => {
        commit(repo, 'lib/c.mjs', 'export const c = 1;\n');
        const event = { session_id: 's1', cwd: repo, last_assistant_message: 'Done and pushed.' };
        const first = stopHook({ ...event, stop_hook_active: false });
        assert.equal(first.decision, 'block');
        assert.match(first.reason, /ahead of its upstream/);
        assert.deepEqual(stopHook({ ...event, stop_hook_active: true }), {});
        assert.deepEqual(stopHook({ ...event, stop_hook_active: false }), {}, 'one return per problem per session');
        assert.deepEqual(claimLog(repo).map(e => e.phase), ['blocked', 'failed']);
        assert.equal(stopHook({ ...event, session_id: 's2' }).decision, 'block', 'another session is sent back again');
        assert.match(housekeeping(repo).lines.join('\n'), /claim check: 1 session stop\(s\) in the last 7 days.*ahead of its upstream/);
    });
    check('the record lives in the git directory, so it is never committed', () => {
        assert.equal(sh(repo, 'status', '--porcelain', '--untracked-files=all').includes('claim-check'), false);
    });
    check('as a hook it answers on stdout, and reads the transcript when the message field is absent', () => {
        const transcript = path.join(scratch, 'transcript.jsonl');
        fs.writeFileSync(transcript, [
            JSON.stringify({ message: { role: 'user', content: 'push it' } }),
            JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Pushed to origin.' }] } }),
        ].join('\n') + '\n');
        const run = input => JSON.parse(spawnSync(process.execPath, [script], { input: JSON.stringify(input), env, encoding: 'utf8' }).stdout);
        assert.equal(run({ session_id: 's3', cwd: repo, transcript_path: transcript }).decision, 'block');
        assert.deepEqual(run({ session_id: 's4', cwd: repo, last_assistant_message: 'Read the board.' }), {});
        assert.deepEqual(JSON.parse(spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' }).stdout), {});
    });
    console.log(`${checks} claim-check checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

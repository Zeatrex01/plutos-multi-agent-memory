#!/usr/bin/env node
// The session close (lib/session-close.mjs): a session that ends with unrecorded work in git is
// recorded from git by the SessionEnd hook, a recorded or idle one is left alone, and the claim
// check sends back a "done" whose session is not recorded, once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-session-close-')));
Object.assign(process.env, { GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid', PLUTOS_HOME: path.join(scratch, 'hub') });
const { transcriptStart, unrecordedWork, closeSession } = await import('../lib/session-close.mjs');
const { stopHook } = await import('../lib/claim-check.mjs');
const { parseContinuity, recordSession } = await import('../lib/continuity.mjs');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`  ok  ${name}`); };

function project(name) {
    const dir = path.join(scratch, name);
    fs.mkdirSync(path.join(dir, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'handoff', 'CONTINUITY.md'), '# CONTINUITY — session memory\n\n## Digest — settled decisions\n\n## Sessions\n\n(no sessions recorded yet)\n');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'kit', '--date', '2020-01-01T00:00:00Z');
    execFileSync('git', ['commit', '-q', '--amend', '--no-edit', '--date', '2020-01-01T00:00:00Z'], { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
    return dir;
}
function transcript(name, started) {
    const file = path.join(scratch, `${name}.jsonl`);
    fs.writeFileSync(file, [JSON.stringify({ type: 'summary', summary: 'x' }), JSON.stringify({ type: 'user', timestamp: started.toISOString(), message: { role: 'user', content: 'go' } })].join('\n') + '\n');
    return file;
}
const work = (dir, file) => { fs.writeFileSync(path.join(dir, file), file); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', `add ${file}`); };
const sessions = dir => parseContinuity(fs.readFileSync(path.join(dir, 'docs', 'handoff', 'CONTINUITY.md'), 'utf8')).sessions;

try {
    const started = new Date(Date.now() - 60_000);
    await check('a session starts at the first timestamp in its transcript', () => {
        assert.equal(transcriptStart(transcript('t', started)).toISOString(), started.toISOString());
        assert.equal(transcriptStart(path.join(scratch, 'missing.jsonl')), null);
    });
    await check('an idle session, a recorded one and a folder without records are left alone', async () => {
        const idle = project('idle');
        assert.equal(unrecordedWork(idle, transcript('idle', started)), null);
        const recorded = project('recorded');
        work(recorded, 'a.txt');
        recordSession(recorded, { ai: 'Claude Code', headline: 'Did a' });
        assert.equal(unrecordedWork(recorded, transcript('recorded', started)), null);
        const bare = path.join(scratch, 'bare');
        fs.mkdirSync(bare); git(bare, 'init', '-q'); fs.writeFileSync(path.join(bare, 'x'), 'x');
        assert.equal(await closeSession({ cwd: bare, transcript_path: transcript('bare', started) }, { env: {} }), null);
    });
    await check('the SessionEnd hook records unrecorded work from git and says what was not recorded', async () => {
        const dir = project('unrecorded');
        work(dir, 'one.txt'); work(dir, 'two.txt');
        fs.writeFileSync(path.join(dir, 'wip.txt'), 'left');
        const found = unrecordedWork(dir, transcript('unrecorded', started));
        assert.deepEqual(found.commits.map(c => c.replace(/^\w+ /, '')), ['add two.txt', 'add one.txt']);
        assert.equal(found.changed, 1);
        const r = spawnSync(process.execPath, [path.join(root, 'lib', 'session-close.mjs')], {
            input: JSON.stringify({ cwd: dir, transcript_path: transcript('unrecorded', started), reason: 'clear', hook_event_name: 'SessionEnd' }),
            encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
        assert.equal(r.status, 0, r.stderr);
        const last = sessions(dir).at(-1);
        assert.match(last.headline, /Ended without session_end/);
        assert.match(last.fields.Did, /Commits: \w+ add two\.txt; \w+ add one\.txt\. 1 uncommitted file\(s\) left at the end\./);
        assert.match(last.fields['Not checked'], /ended \(clear\) without calling session_end/);
        assert.equal(unrecordedWork(dir, transcript('unrecorded', started)), null, 'recorded now');
    });
    await check('a transcript holding a session_end call, or the model capture switched on, leaves it alone', async () => {
        const dir = project('captured');
        work(dir, 'b.txt');
        const ended = transcript('ended', started);
        fs.appendFileSync(ended, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__plutos__session_end', input: { headline: 'x' } }] } }) + '\n');
        assert.equal(unrecordedWork(dir, ended), null);
        const { setContextAutomation } = await import('../lib/context-automation.mjs');
        setContextAutomation(dir, true);
        assert.ok(unrecordedWork(dir, transcript('captured', started)), 'the work is unrecorded');
        assert.equal(await closeSession({ cwd: dir, transcript_path: transcript('captured', started) }, { env: {} }), null, 'the capture records it');
        assert.equal(sessions(dir).length, 0);
    });
    await check('the claim check sends back a "done" whose session is not recorded, once', () => {
        const dir = project('done');
        work(dir, 'feature.txt');
        const input = { cwd: dir, session_id: 's1', transcript_path: transcript('done', started), last_assistant_message: 'The feature is done.' };
        const first = stopHook(input);
        assert.equal(first.decision, 'block');
        assert.match(first.reason, /made 1 commit\(s\) and is not recorded\. Call session_end/);
        assert.deepEqual(stopHook({ ...input, stop_hook_active: true }), {}, 'sent back once');
        assert.deepEqual(stopHook({ ...input, session_id: 's2', last_assistant_message: 'Not done yet; the test still fails.' }), {}, 'no claim, no check');
        recordSession(dir, { ai: 'Claude Code', headline: 'Feature' });
        assert.deepEqual(stopHook({ ...input, session_id: 's3' }), {}, 'recorded, so done is fine');
    });
    console.log(`session-close: ${checks} checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

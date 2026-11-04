#!/usr/bin/env node
// tools/prune-branches.mjs on a scratch origin: only the kept branches stay, every deleted branch's
// last commit stays reachable from the pushed archive tag, and nothing happens without a kept branch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planPrune, prune } from './prune-branches.mjs';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-prune-')));
const env = { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
Object.assign(process.env, env);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file) => { fs.writeFileSync(path.join(cwd, file), file); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', file); return git(cwd, 'rev-parse', 'HEAD'); };
const home = process.cwd();
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

try {
    const origin = path.join(scratch, 'origin.git');
    git(scratch, 'init', '-q', '--bare', origin);
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'remote', 'add', 'origin', origin);
    commit(work, 'a');
    git(work, 'branch', 'merged');
    commit(work, 'b');
    git(work, 'branch', 'develop');
    git(work, 'checkout', '-q', '-b', 'idea');
    const idea = commit(work, 'c');
    git(work, 'branch', 'idea-twin');
    git(work, 'checkout', '-q', 'main');
    git(work, 'push', '-q', 'origin', 'main', 'develop', 'merged', 'idea', 'idea-twin');
    process.chdir(work);

    check('the plan keeps main and develop, and says which kept branch holds a merged one', () => {
        const { kept, doomed } = planPrune(['main', 'master', 'develop']);
        assert.deepEqual(kept.map(b => b.name).sort(), ['develop', 'main']);
        assert.deepEqual(doomed.map(b => `${b.name}:${b.heldBy}`).sort(), ['idea-twin:null', 'idea:null', 'merged:develop']);
        assert.deepEqual(git(origin, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads').split('\n').length, 5, 'a plan deletes nothing');
    });
    check('--yes pushes the archive tag, then leaves only the kept branches', () => {
        const { tag } = prune({ keep: ['main', 'master', 'develop'], date: '2026-01-02' });
        assert.equal(tag, 'archive/branches-2026-01-02');
        assert.deepEqual(git(origin, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads').split('\n').sort(), ['develop', 'main']);
        assert.equal(git(origin, 'tag', '-l', 'archive/*'), tag);
    });
    check('an unmerged branch comes back from the tag, which names every deleted branch', () => {
        const archive = git(origin, 'rev-parse', 'archive/branches-2026-01-02^{commit}');
        assert.equal(git(origin, 'cat-file', '-p', archive).split('\n').filter(l => l.startsWith('parent ')).length, 1, 'twins share one parent');
        git(origin, 'merge-base', '--is-ancestor', idea, archive);
        const message = git(origin, 'log', '-1', '--format=%B', archive);
        for (const name of ['merged', 'idea', 'idea-twin']) assert.match(message, new RegExp(`^${name} [0-9a-f]{40} `, 'm'));
    });
    check('without one of the kept branches on origin it refuses and deletes nothing', () => {
        assert.throws(() => planPrune(['trunk']), /nothing would hold the history/);
        assert.deepEqual(git(origin, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads').split('\n').sort(), ['develop', 'main']);
    });
    console.log(`prune-branches: ${checks} checks passed`);
} finally {
    process.chdir(home);
    fs.rmSync(scratch, { recursive: true, force: true });
}
